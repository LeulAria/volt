/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { bm25, idf, IRankedFile, packRetrieval, parsePorcelainZ, planRetrieval, rankEvidence, snippetsFor, stemTerm } from '../../../common/search/contextRetrieval.js';

suite('Volt context retrieval', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('planRetrieval', () => {

		test('prose: two or more content words become BM25 terms; one vague word retrieves nothing', () => {
			assert.strictEqual(planRetrieval('fix the layout please'), undefined);
			assert.strictEqual(planRetrieval('can you make it work'), undefined);
			assert.strictEqual(planRetrieval(''), undefined);
			const plan = planRetrieval('The terminals tab loses its scroll position when dragging');
			assert.ok(plan);
			assert.deepStrictEqual(plan.identifiers, []);
			assert.deepStrictEqual(plan.terms, ['terminal', 'position', 'scroll', 'lose', 'drag']);
		});

		test('BM25: rare words weigh more, repeats saturate', () => {
			assert.ok(idf(2, 10_000) > idf(500, 10_000));
			assert.ok(bm25(10, 5, 10_000) < 10 * bm25(1, 5, 10_000));
			assert.strictEqual(stemTerm('terminals'), 'terminal');
			assert.strictEqual(stemTerm('class'), 'class');
			assert.strictEqual(stemTerm('dragging'), 'drag');
			assert.strictEqual(stemTerm('rolling'), 'roll');
			assert.strictEqual(stemTerm('stuffed'), 'stuff');
		});

		test('identifiers by shape, most specific first, no common words', () => {
			const plan = planRetrieval('Why does parseConfig return undefined when UserSessionStore is empty? Also check MAX_RETRY_COUNT and useState');
			assert.ok(plan);
			assert.deepStrictEqual(new Set(plan.identifiers), new Set(['parseConfig', 'UserSessionStore', 'MAX_RETRY_COUNT']));
			assert.strictEqual(plan.identifiers[0], 'UserSessionStore', 'more humps: more specific');
		});

		test('conventional commit prefixes and prose parentheses are not calls', () => {
			assert.ok(!planRetrieval('feat(agent): one Terminals tab per chat')?.identifiers.includes('feat'));
			assert.strictEqual(planRetrieval('fix (the bug) in it'), undefined);
			assert.deepStrictEqual(planRetrieval('fix(parser): parseConfig drops comments')?.identifiers, ['parseConfig']);
		});

		test('code spans and calls count even for single words', () => {
			const plan = planRetrieval('rename `render` and call flush() after it');
			assert.ok(plan);
			assert.ok(plan.identifiers.includes('render'));
			assert.ok(plan.identifiers.includes('flush'));
		});

		test('paths, locations and the folders in them', () => {
			const plan = planRetrieval('src/vs/platform/voltCodeIndex/node/rootIndex.ts:1140:5 throws, see also ./package.json and Dockerfile');
			assert.ok(plan);
			assert.deepStrictEqual(plan.paths, ['src/vs/platform/voltCodeIndex/node/rootIndex.ts', 'package.json', 'Dockerfile']);
			assert.deepStrictEqual(plan.locations, [{ path: 'src/vs/platform/voltCodeIndex/node/rootIndex.ts', line: 1140 }]);
			assert.ok(!plan.identifiers.includes('voltCodeIndex'), 'folders of a path are not looked up as symbols');
			assert.ok(!plan.identifiers.includes('rootIndex'), 'the file name is already a path');
		});

		test('Windows paths: backslashes, drive letters and stack-trace locations', () => {
			const plan = planRetrieval('fails at src\\vs\\base\\a.ts:12 and C:\\Users\\me\\repo\\lib\\b.py');
			assert.ok(plan);
			assert.deepStrictEqual(plan.paths, ['src/vs/base/a.ts', 'Users/me/repo/lib/b.py']);
			assert.deepStrictEqual(plan.locations, [{ path: 'src/vs/base/a.ts', line: 12 }]);
		});

		test('quoted text and error lines become literal phrases', () => {
			const plan = planRetrieval('The log says "connection reset by peer" and then:\nTypeError: cannot read properties of undefined');
			assert.ok(plan);
			assert.deepStrictEqual(plan.phrases, ['connection reset by peer', 'cannot read properties of undefined']);
		});

		test('test intent', () => {
			assert.strictEqual(planRetrieval('fix the failing test for parseConfig')?.wantsTests, true);
			assert.strictEqual(planRetrieval('fix parseConfig')?.wantsTests, false);
		});
	});

	suite('rankEvidence', () => {

		test('declarations outrank uses, and terms that meet in one file outrank both', () => {
			const ranked = rankEvidence([
				{ path: 'src/uses.ts', kind: 'match', term: 'parseConfig', line: 3, spread: 12 },
				{ path: 'src/config.ts', kind: 'declaration', term: 'parseConfig', line: 10 },
				{ path: 'src/both.ts', kind: 'declaration', term: 'Store', line: 1 },
				{ path: 'src/both.ts', kind: 'match', term: 'parseConfig', line: 40, spread: 12 },
			], { wantsTests: false });
			assert.deepStrictEqual(ranked.map(file => file.path), ['src/both.ts', 'src/config.ts', 'src/uses.ts']);
		});

		test('a term found everywhere counts less than one found in two files', () => {
			const ranked = rankEvidence([
				{ path: 'a.ts', kind: 'match', term: 'common', spread: 200 },
				{ path: 'b.ts', kind: 'match', term: 'rare', spread: 2 },
			], { wantsTests: false });
			assert.strictEqual(ranked[0].path, 'b.ts');
		});

		test('tests rank down unless asked for; generated files down; changed files up', () => {
			const evidence = [
				{ path: 'src/a.test.ts', kind: 'declaration' as const, term: 'X' },
				{ path: 'src/a.ts', kind: 'declaration' as const, term: 'X' },
			];
			assert.strictEqual(rankEvidence(evidence, { wantsTests: false })[0].path, 'src/a.ts');
			assert.strictEqual(rankEvidence(evidence, { wantsTests: true })[0].path, 'src/a.test.ts');
			const generated = rankEvidence([
				{ path: 'dist/a.js', kind: 'declaration', term: 'X' },
				{ path: 'src/b.ts', kind: 'match', term: 'X', spread: 1 },
			], { wantsTests: false });
			assert.strictEqual(generated[0].path, 'src/b.ts');
			const changed = rankEvidence([
				{ path: 'src/a.ts', kind: 'declaration', term: 'X' },
				{ path: 'src/b.ts', kind: 'declaration', term: 'X' },
			], { wantsTests: false, changed: new Set(['src/b.ts']) });
			assert.strictEqual(changed[0].path, 'src/b.ts');
		});

		test('duplicate evidence is counted once', () => {
			const once = rankEvidence([{ path: 'a.ts', kind: 'declaration', term: 'X', line: 1 }], { wantsTests: false });
			const twice = rankEvidence([{ path: 'a.ts', kind: 'declaration', term: 'X', line: 1 }, { path: 'a.ts', kind: 'declaration', term: 'X', line: 1 }], { wantsTests: false });
			assert.strictEqual(once[0].score, twice[0].score);
		});
	});

	suite('snippets and packing', () => {

		const file = (path: string, lines: number[]): IRankedFile => ({ path, score: 1, evidence: lines.map(line => ({ path, kind: 'declaration' as const, term: 'X', line })) });
		const source = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);

		test('windows merge where they touch and stop at the line cap', () => {
			const snippets = snippetsFor(file('a.ts', [10, 14, 60]), source, 3, 24);
			assert.deepStrictEqual(snippets.map(snippet => [snippet.start, snippet.end]), [[7, 17], [57, 63]]);
			const capped = snippetsFor(file('a.ts', [10, 30, 50, 70]), source, 3, 10);
			assert.strictEqual(capped.reduce((sum, snippet) => sum + snippet.lines.length, 0) <= 10, true);
		});

		test('windows stay inside the file', () => {
			assert.deepStrictEqual(snippetsFor(file('a.ts', [1, 100]), source, 3).map(snippet => [snippet.start, snippet.end]), [[1, 4], [97, 100]]);
			assert.deepStrictEqual(snippetsFor(file('a.ts', [500]), source, 3), [], 'a line past the end (stale evidence) shows nothing');
		});

		test('the budget keeps the best files with code, then headlines, then stops', () => {
			const inputs = ['a.ts', 'b.ts', 'c.ts'].map(path => ({ file: file(path, [10]), snippets: snippetsFor(file(path, [10]), source, 3) }));
			const roomy = packRetrieval(inputs, 10_000);
			assert.ok(roomy);
			assert.deepStrictEqual(roomy.withCode, ['a.ts', 'b.ts', 'c.ts']);
			assert.ok(roomy.text.startsWith('<volt_context'));
			assert.ok(roomy.text.includes('   10| line 10'));
			const tight = packRetrieval(inputs, 150);
			assert.ok(tight);
			assert.ok(tight.tokens <= 150);
			assert.ok(tight.files.length >= 1 && tight.withCode.length < 3, 'later files fall back to their headline');
			assert.strictEqual(packRetrieval(inputs, 10), undefined, 'nothing fits: no block at all');
		});

		test('a block cut short by its deadline says so', () => {
			const packed = packRetrieval([{ file: file('a.ts', []), snippets: [] }], 1_000, { partial: true });
			assert.ok(packed?.text.includes('cut short'));
		});
	});

	test('git status -z: changed, untracked, renamed and quoted-free paths with spaces', () => {
		const output = [' M src/a.ts', '?? docs/My Notes.md', 'R  src/new.ts', 'src/old.ts', 'A  b.ts', ''].join('\0');
		assert.deepStrictEqual([...parsePorcelainZ(output)], ['src/a.ts', 'docs/My Notes.md', 'src/new.ts', 'b.ts']);
		assert.deepStrictEqual([...parsePorcelainZ('')], []);
	});
});
