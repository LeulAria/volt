/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pull request checks (.github/workflows/volt-pr.yml), run from the base branch in a
// pull_request_target workflow: they read the PR through the API and never run its code.
//   node build/volt/ci/pr.mjs validate   the title is a conventional commit, the description is filled in
//   node build/volt/ci/pr.mjs size       sets one size:* label from the changed lines
//   node build/volt/ci/pr.mjs labels     creates or updates the labels in .github/labels.json
// Inputs come from the environment: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubFromEnv } from './github.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

export const titleTypes = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'revert', 'style'];
const titlePattern = new RegExp(`^(${titleTypes.join('|')})(\\([a-z0-9][a-z0-9./_-]*\\))?!?: \\S`);
const maxTitleLength = 100;

/**
 * The title becomes the squash commit's subject and the changelog line, so it follows Conventional Commits.
 * @param {string} title
 * @returns {string[]} problems, empty when the title is fine
 */
export function checkTitle(title) {
	const problems = [];
	const trimmed = title.trim();
	if (/^Revert ".+"$/.test(trimmed)) {
		return []; // GitHub's own revert button
	}
	if (!titlePattern.test(trimmed)) {
		problems.push(`The title must start with a type: \`type(scope): summary\`, where type is one of ${titleTypes.map(t => `\`${t}\``).join(', ')} and the scope is optional, lowercase. For example \`fix(agent): keep the composer focused after a send\`.`);
	}
	if (trimmed.length > maxTitleLength) {
		problems.push(`The title is ${trimmed.length} characters; keep it to ${maxTitleLength}, it becomes the commit subject.`);
	}
	if (/\.$/.test(trimmed)) {
		problems.push('Drop the period at the end of the title.');
	}
	const subject = trimmed.replace(/^[^:]*:\s*/, '');
	if (/^(wip|draft)\b/i.test(subject) || /\[(wip|draft)\]/i.test(trimmed)) {
		problems.push('Mark the PR as a draft instead of writing WIP in the title.');
	}
	return problems;
}

/**
 * The description without the template: HTML comments, headings and checklist lines.
 * @param {string} body
 */
export function descriptionText(body) {
	return (body ?? '')
		.replace(/<!--[\s\S]*?(-->|$)/g, '')
		.split(/\r?\n/)
		.filter(line => !/^\s*#{1,6}\s/.test(line) && !/^\s*[-*]\s+\[[ xX]\]/.test(line))
		.join('\n')
		.trim();
}

/**
 * @param {string} body
 * @returns {string[]}
 */
export function checkBody(body) {
	if (descriptionText(body).length < 20) {
		return ['Fill in the description: what the change does and why, and how a reviewer can test it (the template\'s "What and why" and "How to test").'];
	}
	return [];
}

/** Files that do not count toward the size: tests, lockfiles, generated and vendored files. */
const sizeExcluded = [
	/(^|\/)(test|tests|__tests__|fixtures|test-fixtures)\//,
	/\.(test|spec|integrationTest)\.[cm]?[jt]sx?$/,
	/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock)$/,
	/\.(snap|map|min\.js|min\.css)$/,
	/(^|\/)vendor\//,
	/^(ThirdPartyNotices\.txt|cglicenses\.json|cgmanifest\.json)$/,
];

/** @type {[number, string][]} */
const sizeSteps = [[10, 'size:XS'], [30, 'size:S'], [100, 'size:M'], [500, 'size:L'], [1000, 'size:XL']];

/**
 * @param {{ filename: string, additions: number, deletions: number }[]} files
 * @returns {{ label: string, lines: number, counted: number, excluded: number }}
 */
export function sizeOf(files) {
	let lines = 0;
	let counted = 0;
	let excluded = 0;
	for (const file of files) {
		if (sizeExcluded.some(re => re.test(file.filename))) {
			excluded++;
			continue;
		}
		counted++;
		lines += file.additions + file.deletions;
	}
	// A PR of only tests or lockfiles is sized by what it has.
	if (!counted) {
		lines = files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
	}
	const label = sizeSteps.find(([limit]) => lines < limit)?.[1] ?? 'size:XXL';
	return { label, lines, counted, excluded };
}

/** @returns {{ name: string, color: string, description: string }[]} */
function managedLabels() {
	return JSON.parse(fs.readFileSync(path.join(root, '.github', 'labels.json'), 'utf8'));
}

/**
 * @param {import('./github.mjs').GitHub} github
 * @param {{ name: string, color: string, description: string }} label
 */
async function ensureLabel(github, label) {
	const existing = await github.request('GET', github.repoPath(`/labels/${encodeURIComponent(label.name)}`), undefined, { allow: [404] });
	if (existing.status === 404) {
		await github.request('POST', github.repoPath('/labels'), label, { allow: [422] }); // 422: created meanwhile
	} else if (existing.data.color !== label.color || (existing.data.description ?? '') !== label.description) {
		await github.request('PATCH', github.repoPath(`/labels/${encodeURIComponent(label.name)}`), { new_name: label.name, color: label.color, description: label.description });
	}
}

/** @param {string} markdown */
function summary(markdown) {
	if (process.env.GITHUB_STEP_SUMMARY) {
		fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
	}
}

async function validate() {
	const github = githubFromEnv();
	const number = Number(process.env.PR_NUMBER);
	const { data: pr } = await github.request('GET', github.repoPath(`/pulls/${number}`));
	const bot = pr.user?.type === 'Bot';
	const problems = [...checkTitle(pr.title), ...(bot ? [] : checkBody(pr.body ?? ''))];
	if (problems.length) {
		for (const problem of problems) {
			console.log(`::error title=Pull request::${problem}`);
		}
		summary(`### Pull request\n\n${problems.map(p => `- ${p}`).join('\n')}\n\nEdit the PR and this check runs again.`);
		process.exitCode = 1;
	} else {
		console.log(`"${pr.title}" is a conventional commit title${bot ? '' : ' and the description is filled in'}.`);
		summary('### Pull request\n\nTitle and description look good.');
	}
}

async function size() {
	const github = githubFromEnv();
	const number = Number(process.env.PR_NUMBER);
	const files = await github.paginate(github.repoPath(`/pulls/${number}/files`), 3000);
	const result = sizeOf(files);
	const labels = managedLabels();
	const sizeLabels = labels.filter(label => label.name.startsWith('size:'));
	const next = /** @type {{ name: string, color: string, description: string }} */ (sizeLabels.find(label => label.name === result.label));
	await ensureLabel(github, next);
	const current = await github.paginate(github.repoPath(`/issues/${number}/labels`));
	for (const label of current) {
		if (label.name.startsWith('size:') && label.name !== next.name) {
			await github.request('DELETE', github.repoPath(`/issues/${number}/labels/${encodeURIComponent(label.name)}`), undefined, { allow: [404] });
		}
	}
	if (!current.some(label => label.name === next.name)) {
		await github.request('POST', github.repoPath(`/issues/${number}/labels`), { labels: [next.name] });
	}
	console.log(`PR #${number}: ${result.lines} changed lines in ${result.counted} files (${result.excluded} tests, lockfiles or generated files not counted) -> ${next.name}`);
	summary(`### Size\n\n${result.lines} changed lines in ${result.counted} files (${result.excluded} not counted): \`${next.name}\``);
}

async function syncLabels() {
	const github = githubFromEnv();
	for (const label of managedLabels()) {
		await ensureLabel(github, label);
		console.log(`ok ${label.name}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const commands = { validate, size, labels: syncLabels };
	const command = /** @type {keyof typeof commands} */ (process.argv[2]);
	if (!commands[command]) {
		console.error('Usage: node build/volt/ci/pr.mjs validate|size|labels');
		process.exit(2);
	}
	commands[command]().catch(error => {
		console.error(error);
		process.exit(1);
	});
}
