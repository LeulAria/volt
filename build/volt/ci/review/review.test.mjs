/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { GitHub } from '../github.mjs';
import { ChatClient, parseJsonReply, resolveProvider } from './llm.mjs';
import { placeComments, planBatches, selectComments } from './plan.mjs';
import { annotatePatch, loadGuidance } from './prompt.mjs';
import { decodeState, encodeState, inlineBody, sanitize, summaryMarker } from './render.mjs';
import { root as reviewRoot, run } from './review.mjs';

const noSleep = async () => { };
const quiet = () => { };

const patchA = ['@@ -1,3 +1,4 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = b / 0;', ' export { a };'].join('\n');
const patchB = ['@@ -0,0 +1,2 @@', '+export function f(x) {', '+  return x.y;'].join('\n');

/** @param {any} data */
function json(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * A fake GitHub API: routes by method and path, records every write.
 * @param {Record<string, any>} state
 */
function fakeGitHub(state) {
	/** @type {{ method: string, path: string, body: any }[]} */
	const writes = [];
	/** @type {typeof fetch} */
	const fetchImpl = async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? 'GET';
		const route = `${method} ${url.pathname}`;
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		if (method !== 'GET') {
			writes.push({ method, path: url.pathname, body });
		}
		if (route === 'GET /repos/o/r/pulls/7') {
			return json(state.pr);
		}
		if (route === 'GET /repos/o/r/pulls/7/files') {
			return json(state.files);
		}
		if (route === 'GET /repos/o/r/issues/7/comments') {
			return json(state.issueComments ?? []);
		}
		if (route === 'GET /repos/o/r/pulls/7/comments') {
			return json(state.reviewComments ?? []);
		}
		if (route.startsWith('GET /repos/o/r/compare/')) {
			return json(state.compare);
		}
		if (route === 'POST /repos/o/r/pulls/7/reviews') {
			return state.rejectReview ? json({ message: 'Validation Failed' }, 422) : json({ id: 1 });
		}
		if (method === 'POST' || method === 'PATCH') {
			return json({ id: 2 });
		}
		return json({ message: `no route ${route}` }, 404);
	};
	return { github: new GitHub({ token: 't', repository: 'o/r', fetch: fetchImpl, sleep: noSleep }), writes };
}

/**
 * A fake chat completions endpoint answering with the given replies in order.
 * @param {(body: any) => Response} answer
 */
function fakeModel(answer) {
	/** @type {any[]} */
	const requests = [];
	/** @type {typeof fetch} */
	const fetchImpl = async (_input, init) => {
		const body = JSON.parse(String(init?.body));
		requests.push(body);
		return answer(body);
	};
	return { fetchImpl, requests };
}

/** @param {any} reply */
const completion = reply => json({ choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) }, finish_reason: 'stop' }] });

/** @param {any} payload */
function eventFile(payload) {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'volt-review-')), 'event.json');
	fs.writeFileSync(file, JSON.stringify(payload));
	return file;
}

const basePr = { number: 7, state: 'open', draft: false, title: 'fix(agent): divide safely', body: 'Fixes a crash.', user: { type: 'User' }, labels: [], head: { sha: 'bbbbbbb2222' } };
const prFiles = [
	{ filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: patchA },
	{ filename: 'src/b.ts', status: 'added', additions: 2, deletions: 0, patch: patchB },
	{ filename: 'package-lock.json', status: 'modified', additions: 40, deletions: 3, patch: '@@ -1 +1 @@\n-x\n+y' },
];
const env = (/** @type {Record<string, string>} */ extra = {}) => ({ GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: eventFile({ pull_request: { number: 7 } }), GEMINI_API_KEY: 'k', ...extra });

test('the review reads guidance from the repository root', () => {
	assert.ok(fs.existsSync(path.join(reviewRoot, '.github', 'review-guidelines.md')));
});

test('a first review posts inline comments on valid lines and a summary with state', async () => {
	const { github, writes } = fakeGitHub({ pr: basePr, files: prFiles });
	const model = fakeModel(() => completion({
		summary: 'Changes b and adds f.',
		files: [{ path: 'src/a.ts', summary: 'b is 3 now' }, { path: 'src/b.ts', summary: 'adds f' }, { path: 'nope.ts', summary: 'ignored' }],
		comments: [
			{ path: 'src/a.ts', line: 3, severity: 'critical', category: 'bug', title: 'Division by zero', body: 'c is Infinity. Ping @someone.' },
			{ path: 'src/b.ts', line: 40, severity: 'major', category: 'bug', title: 'Far away', body: 'Not in the diff.' },
			{ path: 'src/b.ts', line: 3, severity: 'minor', category: 'reliability', title: 'x may be undefined', body: 'f(undefined) throws.' },
			{ path: 'src/a.ts', line: 2, severity: 'nit', category: 'maintainability', title: 'Name', body: 'Rename b.' },
		],
	}));
	const provider = /** @type {import('./llm.mjs').Provider} */ (resolveProvider({ GEMINI_API_KEY: 'k' }));
	const chat = new ChatClient(provider, { fetch: model.fetchImpl, sleep: noSleep, log: quiet });
	const result = await run({ env: env(), github, chat, log: quiet });

	assert.equal(result.status, 'reviewed');
	assert.equal(model.requests.length, 1);
	assert.equal(model.requests[0].model, 'gemini-3.8-flash');
	assert.match(model.requests[0].messages[1].content, /R3 \+const c = b \/ 0;/);
	assert.doesNotMatch(model.requests[0].messages[1].content, /package-lock/);
	assert.match(model.requests[0].messages[0].content, /Review guidelines/);

	const review = writes.find(w => w.path === '/repos/o/r/pulls/7/reviews');
	assert.ok(review);
	assert.equal(review.body.commit_id, 'bbbbbbb2222');
	// The line-3 comment on b.ts snaps to line 2, the far one goes to the summary, the nit stays out of the diff.
	assert.deepEqual(review.body.comments.map((/** @type {any} */ c) => [c.path, c.line]), [['src/a.ts', 3], ['src/b.ts', 2]]);
	assert.match(review.body.comments[0].body, /&#64;someone/);

	const summary = writes.find(w => w.path === '/repos/o/r/issues/7/comments');
	assert.ok(summary);
	assert.ok(summary.body.body.startsWith(summaryMarker));
	assert.match(summary.body.body, /Findings outside the diff \(1\)/);
	assert.match(summary.body.body, /Nitpicks \(1\)/);
	assert.match(summary.body.body, /`package-lock.json`: lockfile/);
	assert.doesNotMatch(summary.body.body, /nope\.ts/);
	const state = decodeState(summary.body.body);
	assert.equal(state?.sha, 'bbbbbbb2222');
	assert.deepEqual(Object.keys(state?.files ?? {}).sort(), ['src/a.ts', 'src/b.ts']);
});

test('a later push reviews only the new commits, skips repeats and edits the summary', async () => {
	const previousState = { sha: 'aaaaaaa1111', files: { 'src/a.ts': 'old summary' }, summary: 'The first pass.', v: 1 };
	const { github, writes } = fakeGitHub({
		pr: basePr,
		files: prFiles,
		issueComments: [{ id: 55, user: { type: 'Bot' }, body: `${summaryMarker}\nold\n${encodeState(previousState)}` }],
		reviewComments: [{ path: 'src/b.ts', line: 2, body: ':orange_circle: **Major** · Bug · **x may be undefined**\n\n...\n<!-- volt-ai-review:comment -->' }],
		compare: { status: 'ahead', total_commits: 1, files: [prFiles[1], { filename: 'reverted.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' }] },
	});
	const model = fakeModel(() => completion({
		summary: 'Adds f.',
		files: [{ path: 'src/b.ts', summary: 'adds f' }],
		comments: [{ path: 'src/b.ts', line: 2, severity: 'major', category: 'bug', title: 'x may be undefined', body: 'Again.' }],
	}));
	const provider = /** @type {import('./llm.mjs').Provider} */ (resolveProvider({ GEMINI_API_KEY: 'k' }));
	const result = await run({ env: env(), github, chat: new ChatClient(provider, { fetch: model.fetchImpl, sleep: noSleep, log: quiet }), log: quiet });

	assert.equal(result.status, 'reviewed');
	assert.match(model.requests[0].messages[1].content, /path="src\/b.ts"/);
	assert.doesNotMatch(model.requests[0].messages[1].content, /src\/a.ts|reverted.ts/);
	assert.equal(writes.find(w => w.path === '/repos/o/r/pulls/7/reviews'), undefined, 'the repeat is not posted again');
	const edit = writes.find(w => w.method === 'PATCH');
	assert.equal(edit?.path, '/repos/o/r/issues/comments/55');
	assert.match(edit?.body.body, /The first pass\./);
	assert.match(edit?.body.body, /\*\*Latest push:\*\* Adds f\./);
	assert.match(edit?.body.body, /`aaaaaaa`\.\.`bbbbbbb` \(1 new commit\)/);
	assert.deepEqual(decodeState(edit?.body.body)?.files, { 'src/a.ts': 'old summary', 'src/b.ts': 'adds f' });
});

test('an already reviewed head, a draft and the skip label do nothing', async () => {
	const reviewed = fakeGitHub({ pr: basePr, files: prFiles, issueComments: [{ id: 1, user: { type: 'Bot' }, body: `${summaryMarker}\n${encodeState({ sha: 'bbbbbbb2222', files: {}, summary: '', v: 1 })}` }] });
	assert.equal((await run({ env: env(), github: reviewed.github, log: quiet })).status, 'up-to-date');
	const draft = fakeGitHub({ pr: { ...basePr, draft: true }, files: prFiles });
	assert.equal((await run({ env: env(), github: draft.github, log: quiet })).status, 'skipped');
	const labeled = fakeGitHub({ pr: { ...basePr, labels: [{ name: 'skip-ai-review' }] }, files: prFiles });
	assert.equal((await run({ env: env(), github: labeled.github, log: quiet })).status, 'skipped');
	assert.deepEqual([...reviewed.writes, ...draft.writes, ...labeled.writes], []);
});

test('without a key an automatic run posts nothing and /review explains the setup', async () => {
	const automatic = fakeGitHub({ pr: basePr, files: prFiles });
	assert.equal((await run({ env: { ...env(), GEMINI_API_KEY: '' }, github: automatic.github, log: quiet })).status, 'unconfigured');
	assert.deepEqual(automatic.writes, []);

	const command = fakeGitHub({ pr: basePr, files: prFiles });
	const commandEnv = { GITHUB_EVENT_NAME: 'issue_comment', GITHUB_EVENT_PATH: eventFile({ issue: { number: 7, pull_request: {} }, comment: { id: 9, body: '/review full' } }) };
	assert.equal((await run({ env: commandEnv, github: command.github, log: quiet })).status, 'unconfigured');
	assert.deepEqual(command.writes.map(w => w.path), ['/repos/o/r/issues/comments/9/reactions', '/repos/o/r/issues/7/comments']);
	assert.match(command.writes[1].body.body, /aistudio\.google\.com/);
});

test('a missing model falls through to the next one, a rejected format is downgraded', async () => {
	const { github } = fakeGitHub({ pr: basePr, files: prFiles });
	const model = fakeModel(body => {
		if (body.model === 'gemini-3.8-flash') {
			return json({ error: { message: 'model not found' } }, 404);
		}
		if (body.response_format?.type === 'json_schema') {
			return json({ error: { message: 'Invalid response_format' } }, 400);
		}
		return completion('```json\n{"summary": "ok", "files": [], "comments": []}\n```');
	});
	const provider = /** @type {import('./llm.mjs').Provider} */ (resolveProvider({ GEMINI_API_KEY: 'k' }));
	const chat = new ChatClient(provider, { fetch: model.fetchImpl, sleep: noSleep, log: quiet });
	assert.equal((await run({ env: env(), github, chat, log: quiet })).status, 'reviewed');
	assert.equal(chat.lastModel, 'gemini-2.5-flash');
	assert.equal(chat.format, 'json_object');
});

test('a rejected key stops the run and keeps the last state', async () => {
	const { github, writes } = fakeGitHub({ pr: basePr, files: prFiles });
	const model = fakeModel(() => json({ error: { message: 'API key not valid' } }, 401));
	const provider = /** @type {import('./llm.mjs').Provider} */ (resolveProvider({ GEMINI_API_KEY: 'k' }));
	const result = await run({ env: env(), github, chat: new ChatClient(provider, { fetch: model.fetchImpl, sleep: noSleep, log: quiet }), log: quiet });
	assert.equal(result.status, 'failed');
	assert.equal(model.requests.length, 1);
	assert.deepEqual(writes, []);
});

test('when GitHub rejects the review, comments are posted one by one', async () => {
	const { github, writes } = fakeGitHub({ pr: basePr, files: prFiles, rejectReview: true });
	const model = fakeModel(() => completion({ summary: 's', files: [], comments: [{ path: 'src/a.ts', line: 3, severity: 'major', category: 'bug', title: 'T', body: 'B' }] }));
	const provider = /** @type {import('./llm.mjs').Provider} */ (resolveProvider({ GEMINI_API_KEY: 'k' }));
	const result = await run({ env: env(), github, chat: new ChatClient(provider, { fetch: model.fetchImpl, sleep: noSleep, log: quiet }), log: quiet });
	assert.equal(result.posted, 1);
	assert.ok(writes.some(w => w.path === '/repos/o/r/pulls/7/comments' && w.body.line === 3 && w.body.commit_id === 'bbbbbbb2222'));
});

test('resolveProvider picks the configured key', () => {
	assert.equal(resolveProvider({}), undefined);
	assert.equal(resolveProvider({ OPENROUTER_API_KEY: 'k' })?.models[0], 'openrouter/free');
	assert.deepEqual(resolveProvider({ GEMINI_API_KEY: 'k', AI_REVIEW_MODEL: 'a, b' })?.models, ['a', 'b']);
	assert.equal(resolveProvider({ AI_REVIEW_API_KEY: 'k', AI_REVIEW_BASE_URL: 'https://x.dev/v1/', GEMINI_API_KEY: 'g' })?.baseUrl, 'https://x.dev/v1');
});

test('parseJsonReply tolerates fences and prose', () => {
	assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
	assert.deepEqual(parseJsonReply('Here you go: {"a": {"b": 2}} done'), { a: { b: 2 } });
	assert.throws(() => parseJsonReply('no json'));
});

test('planBatches skips generated files and splits by size within the budget', () => {
	const big = (/** @type {string} */ name) => ({ filename: name, status: 'modified', additions: 1, deletions: 0, patch: `@@ -1 +1,2 @@\n x\n+${'y'.repeat(400)}` });
	const files = [
		big('src/one.ts'), big('src/two.ts'), big('src/three.ts'),
		{ filename: 'build/lib/x.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+a' },
		{ filename: 'build/lib/x.js', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+a' },
		{ filename: 'icon.png', status: 'added', additions: 0, deletions: 0 },
		{ filename: 'old.ts', status: 'removed', additions: 0, deletions: 3, patch: '@@ -1 +0,0 @@\n-a' },
	];
	const plan = planBatches(files, { batchChars: 900, maxBatches: 2 });
	assert.deepEqual(plan.batches.map(b => b.map(f => f.filename)), [['src/one.ts', 'src/three.ts'], ['src/two.ts', 'build/lib/x.ts']]);
	assert.deepEqual(plan.skipped.map(s => [s.filename, s.reason]).sort(), [
		['build/lib/x.js', 'compiled from the .ts next to it'],
		['icon.png', 'binary or media'],
		['old.ts', 'deleted'],
	]);
	const tight = planBatches(files, { batchChars: 500, maxBatches: 1 });
	assert.ok(tight.skipped.some(s => s.reason === 'over this run\'s review budget'));
});

test('placeComments keeps multi-line suggestions inside one hunk', () => {
	const patch = ['@@ -1,2 +1,3 @@', ' a', '+b', '+c', '@@ -10,1 +11,1 @@', '-x', '+y'].join('\n');
	const patches = new Map([['f.ts', patch]]);
	const base = { path: 'f.ts', severity: 'minor', category: 'bug', title: 't', body: 'b' };
	const { inline, outside } = placeComments([
		{ ...base, line: 3, start_line: 2, suggestion: 'B\nC' },
		{ ...base, line: 11, start_line: 3, suggestion: 'no' },
		{ ...base, line: 10, side: 'LEFT' },
		{ ...base, line: 99 },
		{ ...base, path: 'other.ts', line: 1 },
	], patches);
	assert.deepEqual(inline.map(c => [c.line, c.start_line, c.side, c.suggestion]), [[3, 2, 'RIGHT', 'B\nC'], [11, undefined, 'RIGHT', undefined], [10, undefined, 'LEFT', undefined]]);
	assert.equal(outside.length, 2);
});

test('selectComments drops repeats, orders by severity and caps inline', () => {
	const c = (/** @type {string} */ severity, /** @type {number} */ line, title = `t${line}`) => ({ path: 'f.ts', line, severity: /** @type {any} */ (severity), category: 'bug', title, body: 'b' });
	const result = selectComments([c('minor', 1), c('critical', 5), c('nit', 7), c('major', 9), c('major', 20, 'Same problem here')], [{ path: 'f.ts', line: 21, title: 'Same problem here' }], 2);
	assert.deepEqual(result.inline.map(x => x.line), [5, 9]);
	assert.deepEqual(result.overflow.map(x => x.line), [1]);
	assert.deepEqual(result.nits.map(x => x.line), [7]);
});

test('rendering is safe for untrusted model text', () => {
	assert.equal(sanitize('hi @user <!-- volt-ai-review:summary --> <img src=x onerror=1> <b>ok</b>'), 'hi &#64;user   <b>ok</b>');
	const body = inlineBody({ path: 'f.ts', line: 1, severity: 'major', category: 'bug', title: 'T', body: 'B', suggestion: 'const s = "```";' }, 'm');
	assert.match(body, /^````suggestion\nconst s = "```";\n````$/m);
	const state = { sha: 'abc', files: { 'a--b.ts': 'x -- y' }, summary: 'end -->', v: 1 };
	const encoded = encodeState(state);
	assert.equal(encoded.indexOf('-->'), encoded.length - 3);
	assert.deepEqual(decodeState(`text\n${encoded}`), state);
});

test('annotatePatch numbers lines for the model', () => {
	assert.equal(annotatePatch(patchA), ['@@', 'R1  const a = 1;', 'L2 -const b = 2;', 'R2 +const b = 3;', 'R3 +const c = b / 0;', 'R4  export { a };'].join('\n'));
});

test('loadGuidance picks the rules for the touched paths', () => {
	const root = path.join(import.meta.dirname, '..', '..', '..', '..');
	const docs = loadGuidance(root, ['apps/docs/src/x.tsx']);
	assert.match(docs, /review-guidelines\.md/);
	assert.doesNotMatch(docs, /volt-lists/);
	const ui = loadGuidance(root, ['src/vs/workbench/contrib/voltAgent/browser/x.ts']);
	assert.match(ui, /volt-lists/);
	assert.match(ui, /## Coding Guidelines/);
	assert.doesNotMatch(ui, /## Project Overview/);
});
