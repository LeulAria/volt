/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifyIntent } from '../../common/harness/intent.js';
import { formatPrimerFiles, preflightPlan, primerCandidate, rankPrimerFiles, selectPrimerFiles } from '../../common/harness/preflight.js';
import { browserToolVerdict } from '../../common/hostTools.js';
import { applyFileEdits, groupFileEdits, parseFileEdits, safeEditPath } from '../../common/tools/fileEdits.js';
import { describeStep, parseRunSteps } from '../../common/tools/browserRun.js';

suite('Volt turn primer and one-call fixes', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const plan = (text: string) => preflightPlan(text, classifyIntent(text, 'agent', { hasWorkspace: true }));

	test('the primer gathers what the request implies', () => {
		const overflow = plan('On a phone-sized screen (375px wide) this app\'s page scrolls sideways. Fix the layout so nothing overflows at 375px wide without changing how the desktop layout looks, and verify it in a browser at both sizes.');
		assert.deepStrictEqual(overflow && { browser: overflow.browser, files: overflow.files, widths: overflow.widths, a11y: overflow.a11y }, { browser: true, files: true, widths: [375, 1280], a11y: false });
		const a11y = plan('Audit the sign-in card of this app for accessibility problems and fix what you find. Keep sign-up and log-in working, and verify in a browser.');
		assert.strictEqual(a11y?.a11y, true);
		assert.strictEqual(a11y?.browser, true);
		const draft = plan('Before we touch the real app, I want a quick throwaway prototype of a pricing section with a monthly/yearly toggle. Build it as a standalone draft page, check in a browser that the toggle works, then remove the draft.');
		assert.deepStrictEqual(draft && { draft: draft.draft, browser: draft.browser, files: draft.files }, { draft: true, browser: false, files: false });
		// Not UI work, or a question: nothing to prepare.
		assert.strictEqual(plan('Rename parseConfig to loadConfig in src/config.ts'), undefined);
		assert.strictEqual(plan('thanks'), undefined);
	});

	test('project files: whole small projects, ranked excerpts of big ones', () => {
		const entries = [
			{ path: 'package.json', size: 160 },
			{ path: 'server.js', size: 4000 },
			{ path: 'public/app.js', size: 3000 },
			{ path: 'public/styles.css', size: 1800 },
			{ path: 'test/server.test.js', size: 900 },
			{ path: 'package-lock.json', size: 30000 },
			{ path: 'logo.png', size: 4000 },
		].filter(primerCandidate);
		assert.deepStrictEqual(entries.map(entry => entry.path), ['package.json', 'server.js', 'public/app.js', 'public/styles.css', 'test/server.test.js']);
		const contents = new Map(entries.map(entry => [entry.path, entry.path === 'public/app.js' ? 'document.querySelector("#add-todo").onclick = addTodo;' : `// ${entry.path}`]));
		const ranked = rankPrimerFiles(entries, 'clicking the Add button does not add the todo', contents, true);
		assert.strictEqual(ranked[0].path, 'public/app.js');
		assert.strictEqual(ranked[ranked.length - 1].path, 'test/server.test.js');
		const all = selectPrimerFiles(ranked, contents);
		assert.strictEqual(all.included.length, 5);
		assert.match(formatPrimerFiles(all)!, /^\[Volt\] Project files, read just now \(the whole project\)/);
		// Over budget: the best-ranked files, cut, and the rest listed by name.
		const big = new Map(entries.map(entry => [entry.path, 'x\n'.repeat(4000)]));
		const some = selectPrimerFiles(rankPrimerFiles(entries, 'add todo', big, true), big, 10_000, 6_000);
		assert.ok(some.included.length >= 1 && some.included.length < 5);
		assert.ok(some.included.some(file => file.truncated));
		assert.match(formatPrimerFiles(some)!, /Other files: /);
	});

	test('edits: parsed with aliases, validated, applied all or none', () => {
		const { edits, errors } = parseFileEdits([
			{ path: 'public/app.js', old_string: '#add-todo', new_string: '#add' },
			{ file: 'public/app.js', search: 'a', replace: 'b', replace_all: true },
			{ path: 'notes/new.md', content: 'hello' },
		]);
		assert.deepStrictEqual(errors, []);
		assert.strictEqual(groupFileEdits(edits).get('public/app.js')?.length, 2);
		assert.deepStrictEqual(parseFileEdits([{ path: 'x.js', old: 'a' }]).errors, ['edit 1 (x.js): needs `new` (use "" to delete the text)']);
		assert.match(parseFileEdits([]).errors[0], /non-empty/);
		assert.deepStrictEqual(applyFileEdits('const a = 1;\nconst b = 2;\n', [{ path: 'f', old: 'b = 2', new: 'b = 3' }], 'f'), { text: 'const a = 1;\nconst b = 3;\n', replacements: 1 });
		assert.match((applyFileEdits('x x', [{ path: 'f', old: 'x', new: 'y' }], 'f') as { error: string }).error, /appears 2 times/);
		assert.match((applyFileEdits('const total = items.length;', [{ path: 'f', old: 'const total = items.size;', new: '' }], 'f') as { error: string }).error, /not found \(closest: line 1: const total = items.length;\)/);
		assert.deepStrictEqual(applyFileEdits('a\r\nb\r\n', [{ path: 'f', old: 'a\nb', new: 'c\nd' }], 'f'), { text: 'c\r\nd\r\n', replacements: 1 });
		assert.deepStrictEqual(applyFileEdits(undefined, [{ path: 'f', content: 'new' }], 'f'), { text: 'new', replacements: 1 });
		assert.strictEqual(safeEditPath('../etc/passwd'), undefined);
		assert.strictEqual(safeEditPath('./src//app.js'), 'src/app.js');
	});

	test('browser_run steps: mock, emulate and audit', () => {
		const { steps, errors } = parseRunSteps([
			{ action: 'mock', routes: [{ url: '/api/stats', status: 500 }], reload: true },
			{ mock: { url: '/api/stats', json: [], delay_ms: 3000 } },
			{ mock: [{ url: '/api/a', abort: true }] },
			{ unmock: true },
			{ action: 'emulate', network: 'offline', reload: true },
			{ emulate: { reset: true } },
			{ action: 'audit', checks: ['a11y'], scope: '#auth' },
			{ audit: { widths: [375, 1280] } },
		]);
		assert.deepStrictEqual(errors, []);
		assert.deepStrictEqual(steps.map(describeStep), [
			'mock /api/stats → 500, then reload',
			'mock /api/stats → 200 after 3000 ms',
			'mock /api/a → network error',
			'clear mocks',
			'emulate network=offline, then reload',
			'emulate reset',
			'audit a11y in #auth',
			'audit layout at 375/1280px',
		]);
		assert.deepStrictEqual(parseRunSteps([{ action: 'mock' }]).errors, ['step 1: mock needs `routes` (e.g. [{"url":"/api/stats","status":500}]) or clear: true']);
		assert.match(parseRunSteps([{ action: 'emulate', network: 'warp' }]).errors[0], /network must be/);
		// Read-only modes: mocking a non-local page acts on it.
		assert.strictEqual(browserToolVerdict('browser_run', { steps: [{ action: 'mock', routes: [{ url: '/x', status: 500 }] }] }, 'ask', 'https://example.com/').kind, 'ask');
		assert.strictEqual(browserToolVerdict('browser_run', { steps: [{ action: 'audit' }] }, 'ask', 'https://example.com/').kind, 'allow');
	});
});
