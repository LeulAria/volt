/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt AI Review (.github/workflows/volt-pr-review.yml): reviews a pull request with a model on a
// free tier (Gemini through Google AI Studio by default) and posts a summary comment plus inline
// comments, the way CodeRabbit does.
//
// It never runs the PR's code: it reads the diff through the API, sends it to the model and posts
// what comes back, after checking every comment against the diff. The model gets no tools, so a
// prompt hidden in a PR can at worst produce a misleading comment.
//
// Each run after the first reviews only the commits pushed since the last one (the summary
// comment remembers the head it reviewed), unless the history was rewritten or `/review full` asks
// for everything.
//
// Run it locally without posting anything:
//   GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=LeulAria/volt PR_NUMBER=123 GEMINI_API_KEY=... \
//     AI_REVIEW_DRY_RUN=1 node build/volt/ci/review/review.mjs

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitHub } from '../github.mjs';
import { ChatClient, ModelError, resolveProvider } from './llm.mjs';
import { placeComments, planBatches, selectComments } from './plan.mjs';
import { batchMessages, loadGuidance, reviewSchema, summaryMessages, summarySchema } from './prompt.mjs';
import { commentMarker, decodeState, inlineBody, summaryBody, summaryMarker } from './render.mjs';

export const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');

/**
 * @typedef {import('./plan.mjs').ModelComment} ModelComment
 * @typedef {import('./prompt.mjs').PullFile} PullFile
 * @typedef {{ number: number, full: boolean, automatic: boolean, commentId?: number }} Trigger
 */

/**
 * What started this run, from the workflow event.
 * @param {Record<string, string | undefined>} env
 * @returns {Trigger | undefined}
 */
export function readTrigger(env) {
	const event = env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH) ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
	if (env.GITHUB_EVENT_NAME === 'issue_comment') {
		const body = String(event.comment?.body ?? '').trim();
		const command = /^\/review(?:\s+(full))?\s*$/i.exec(body);
		if (!event.issue?.pull_request || !command) {
			return undefined;
		}
		return { number: event.issue.number, full: Boolean(command[1]), automatic: false, commentId: event.comment.id };
	}
	if (env.GITHUB_EVENT_NAME === 'pull_request_target' || env.GITHUB_EVENT_NAME === 'pull_request') {
		return { number: event.pull_request.number, full: false, automatic: true };
	}
	const number = Number(env.PR_NUMBER);
	return number > 0 ? { number, full: env.REVIEW_FULL === 'true', automatic: false } : undefined;
}

/**
 * @param {{ env: Record<string, string | undefined>, github: GitHub, chat?: ChatClient, log?: (message: string) => void }} context
 * @returns {Promise<{ status: string, posted?: number }>}
 */
export async function run(context) {
	const { env, github } = context;
	const log = context.log ?? (message => console.log(message));
	const dryRun = env.AI_REVIEW_DRY_RUN === '1';
	const trigger = readTrigger(env);
	if (!trigger) {
		log('Nothing to review: not a pull request event or a /review command.');
		return { status: 'ignored' };
	}
	const write = async (/** @type {string} */ method, /** @type {string} */ apiPath, /** @type {unknown} */ body) => {
		if (dryRun) {
			log(`[dry run] ${method} ${apiPath}\n${typeof body === 'object' ? JSON.stringify(body, null, 2) : body}`);
			return { status: 200, data: { id: 0 } };
		}
		return github.request(method, apiPath, body);
	};
	if (trigger.commentId) {
		await write('POST', github.repoPath(`/issues/comments/${trigger.commentId}/reactions`), { content: 'eyes' });
	}

	const { data: pr } = await github.request('GET', github.repoPath(`/pulls/${trigger.number}`));
	if (pr.state !== 'open') {
		log(`#${pr.number} is ${pr.state}.`);
		return { status: 'closed' };
	}
	if (trigger.automatic && (pr.draft || pr.user?.type === 'Bot')) {
		log(`#${pr.number} is ${pr.draft ? 'a draft' : 'from a bot'}; comment /review to review it anyway.`);
		return { status: 'skipped' };
	}
	if (pr.labels?.some((/** @type {{ name: string }} */ l) => l.name === 'skip-ai-review')) {
		log(`#${pr.number} has the skip-ai-review label.`);
		return { status: 'skipped' };
	}

	const provider = resolveProvider(env);
	if (!provider) {
		const help = 'The AI review needs a free API key. Create one at https://aistudio.google.com/apikey and add it as the repository secret `GEMINI_API_KEY` (Settings, Secrets and variables, Actions). Any OpenAI-compatible provider also works: `OPENROUTER_API_KEY`, or `AI_REVIEW_API_KEY` with the variable `AI_REVIEW_BASE_URL`.';
		log(`::notice title=AI review not configured::${help}`);
		writeStepSummary(env, `### AI review not configured\n\n${help}`);
		if (!trigger.automatic) {
			await write('POST', github.repoPath(`/issues/${pr.number}/comments`), { body: help });
		}
		return { status: 'unconfigured' };
	}
	const chat = context.chat ?? new ChatClient(provider, { log });

	// The summary comment from earlier runs: where the last review stopped.
	const issueComments = await github.paginate(github.repoPath(`/issues/${pr.number}/comments`));
	const summaryComment = issueComments.find(c => typeof c.body === 'string' && c.body.startsWith(summaryMarker) && c.user?.type === 'Bot');
	const previous = summaryComment ? decodeState(summaryComment.body) : undefined;
	const head = pr.head.sha;
	if (trigger.automatic && previous?.sha === head) {
		log(`${head.slice(0, 7)} was already reviewed.`);
		return { status: 'up-to-date' };
	}

	const prFiles = /** @type {PullFile[]} */ (await github.paginate(github.repoPath(`/pulls/${pr.number}/files`), 3000));
	const prPatches = new Map(prFiles.filter(f => f.patch).map(f => [f.filename, /** @type {string} */ (f.patch)]));

	// Incremental when the last reviewed commit is still in the history and nobody asked for everything.
	/** @type {PullFile[]} */
	let rangeFiles = prFiles;
	let range = `${code(head)} (the whole pull request)`;
	let incremental = false;
	if (previous && previous.sha !== head && !trigger.full) {
		const compare = await github.request('GET', github.repoPath(`/compare/${previous.sha}...${head}`), undefined, { allow: [404] });
		if (compare.status === 200 && compare.data.status === 'ahead' && Array.isArray(compare.data.files)) {
			// A file the new commits changed back to the base is no longer part of the PR.
			const inPr = new Set(prFiles.map(f => f.filename));
			rangeFiles = compare.data.files.filter((/** @type {PullFile} */ f) => inPr.has(f.filename));
			range = `${code(previous.sha)}..${code(head)} (${compare.data.total_commits} new commit${compare.data.total_commits === 1 ? '' : 's'})`;
			incremental = true;
		}
	}

	const limits = {
		batchChars: Number(env.AI_REVIEW_BATCH_CHARS) || 240_000,
		maxBatches: Number(env.AI_REVIEW_MAX_BATCHES) || 4,
		maxInline: Number(env.AI_REVIEW_MAX_COMMENTS) || 15,
	};
	const plan = planBatches(rangeFiles, limits);
	const reviewed = plan.batches.flat();
	if (!reviewed.length) {
		log('No reviewable files in this range.');
	}
	const guidance = loadGuidance(env.AI_REVIEW_ROOT ?? root, reviewed.map(f => f.filename));

	/** @type {ModelComment[]} */
	const comments = [];
	/** @type {string[]} */
	const summaries = [];
	/** @type {Record<string, string>} */
	const fileSummaries = {};
	/** @type {string[]} */
	const errors = [];
	for (let i = 0; i < plan.batches.length; i++) {
		const files = plan.batches[i];
		log(`Batch ${i + 1}/${plan.batches.length}: ${files.length} files`);
		try {
			const reply = await chat.json(batchMessages({
				number: pr.number, title: pr.title, body: pr.body ?? '', guidance, files, patches: plan.patches,
				scope: incremental ? 'only the commits pushed since the last review' : 'the whole pull request',
				batch: i + 1, batches: plan.batches.length, totalFiles: reviewed.length,
			}), reviewSchema);
			if (typeof reply?.summary === 'string') {
				summaries.push(reply.summary);
			}
			const names = new Set(files.map(f => f.filename));
			for (const file of Array.isArray(reply?.files) ? reply.files : []) {
				if (typeof file?.path === 'string' && typeof file.summary === 'string' && names.has(file.path)) {
					fileSummaries[file.path] = file.summary.slice(0, 300);
				}
			}
			comments.push(...(Array.isArray(reply?.comments) ? reply.comments : []));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`batch ${i + 1}: ${message}`);
			log(`::warning title=AI review::Batch ${i + 1} failed: ${message}`);
			for (const file of files) {
				plan.skipped.push({ filename: file.filename, reason: 'the model did not answer' });
			}
			if (error instanceof ModelError && error.fatal) {
				break;
			}
		}
	}
	if (plan.batches.length && !summaries.length) {
		// Nothing came back at all: report it, keep the last state so the next run tries again.
		writeStepSummary(env, `### AI review failed\n\n${errors.join('\n')}`);
		if (!trigger.automatic) {
			await write('POST', github.repoPath(`/issues/${pr.number}/comments`), { body: `The AI review could not run: ${errors.join('; ').slice(0, 1000)}` });
		}
		log(`::warning title=AI review::No batch was reviewed: ${errors.join('; ')}`);
		return { status: 'failed' };
	}

	let summary = summaries[0] ?? (reviewed.length ? '' : 'Only files the review skips changed here (see Not reviewed).');
	if (summaries.length > 1) {
		try {
			const reply = await chat.json(summaryMessages({ number: pr.number, title: pr.title, summaries }), summarySchema, { maxTokens: 1024 });
			summary = typeof reply?.summary === 'string' ? reply.summary : summaries.join(' ');
		} catch {
			summary = summaries.join(' ');
		}
	}
	const model = chat.lastModel ?? provider.models[0];

	// Place the comments on the diff, drop repeats of earlier runs, keep the most important inline.
	const placed = placeComments(comments, prPatches);
	const existing = (await github.paginate(github.repoPath(`/pulls/${pr.number}/comments`)))
		.filter(c => typeof c.body === 'string' && c.body.includes(commentMarker))
		.map(c => ({ path: c.path, line: c.line ?? c.original_line ?? null, title: /\*\*([^*]+)\*\*\s*$/m.exec(c.body.split('\n')[0])?.[1] ?? '' }));
	const selected = selectComments(placed.inline, existing, limits.maxInline);
	const counts = { critical: 0, major: 0, minor: 0, nit: 0 };
	for (const c of [...selected.inline, ...selected.overflow, ...selected.nits, ...placed.outside]) {
		counts[c.severity]++;
	}

	let posted = 0;
	/** @type {ModelComment[]} */
	const unplaced = [...placed.outside];
	if (selected.inline.length) {
		const reviewComments = selected.inline.map(c => toReviewComment(c, model));
		const body = `Volt AI Review: ${selected.inline.length} finding${selected.inline.length === 1 ? '' : 's'} in ${incremental ? 'the new commits' : 'this pull request'}. The summary is in the conversation.`;
		try {
			await write('POST', github.repoPath(`/pulls/${pr.number}/reviews`), { commit_id: head, event: 'COMMENT', body, comments: reviewComments });
			posted = reviewComments.length;
		} catch (error) {
			// One bad comment rejects the whole review: post them one by one and keep what GitHub takes.
			log(`The review was rejected (${error instanceof Error ? error.message : error}); posting comments one by one.`);
			for (let i = 0; i < reviewComments.length; i++) {
				try {
					await write('POST', github.repoPath(`/pulls/${pr.number}/comments`), { commit_id: head, ...reviewComments[i] });
					posted++;
				} catch {
					unplaced.push(selected.inline[i]);
				}
			}
		}
	}

	const files = incremental && previous ? { ...previous.files, ...fileSummaries } : fileSummaries;
	for (const file of prFiles) {
		if (file.status === 'removed') {
			delete files[file.filename];
		}
	}
	for (const name of Object.keys(files)) {
		if (!prFiles.some(f => f.filename === name)) {
			delete files[name];
		}
	}
	const overall = incremental && previous?.summary ? previous.summary : summary;
	const body = summaryBody({
		summary: overall,
		latest: incremental ? summary : undefined,
		files,
		range: `${range} · ${reviewed.length} file${reviewed.length === 1 ? '' : 's'}`,
		model,
		counts,
		inlineCount: posted,
		nits: selected.nits,
		outside: unplaced,
		overflow: selected.overflow,
		skipped: plan.skipped,
		errors,
		state: { sha: head, files, summary: overall, v: 1 },
	});
	if (summaryComment) {
		await write('PATCH', github.repoPath(`/issues/comments/${summaryComment.id}`), { body });
	} else {
		await write('POST', github.repoPath(`/issues/${pr.number}/comments`), { body });
	}
	writeStepSummary(env, body.replace(/<!--[\s\S]*?-->/g, ''));
	log(`Reviewed ${reviewed.length} files with ${model}: ${posted} inline comments, ${selected.nits.length} nitpicks, ${unplaced.length} outside the diff.`);
	return { status: 'reviewed', posted };
}

/**
 * @param {ModelComment} comment
 * @param {string} model
 */
function toReviewComment(comment, model) {
	/** @type {Record<string, unknown>} */
	const out = { path: comment.path, line: comment.line, side: comment.side ?? 'RIGHT', body: inlineBody(comment, model) };
	if (comment.start_line !== undefined) {
		out.start_line = comment.start_line;
		out.start_side = comment.side ?? 'RIGHT';
	}
	return out;
}

/** @param {string} sha */
function code(sha) {
	return `\`${sha.slice(0, 7)}\``;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} markdown
 */
function writeStepSummary(env, markdown) {
	if (env.GITHUB_STEP_SUMMARY) {
		fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const github = new GitHub({ token: process.env.GITHUB_TOKEN ?? '', repository: process.env.GITHUB_REPOSITORY ?? '', apiUrl: process.env.GITHUB_API_URL });
	run({ env: process.env, github }).catch(error => {
		console.error(error);
		process.exit(1);
	});
}
