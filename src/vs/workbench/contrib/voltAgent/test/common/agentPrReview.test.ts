/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildFixPrompt,
	buildReviewPrompt,
	changedLinesByFile,
	IPrReviewRecord,
	IRawReviewFinding,
	IReviewFinding,
	mergeReviewFindings,
	newReviewFindings,
	openFindingsSorted,
	parseReviewOutput,
	REVIEW_DIFF_MAX_CHARS,
	reviewNeedsStart,
	sameFinding,
	shouldAutoReview,
} from '../../common/agentPrReview.js';

suite('agentPrReview', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const open = { isOpen: true, isMine: true, headSha: 'aaa111' };

	function record(headSha: string, state: IPrReviewRecord['state'] = 'done'): IPrReviewRecord {
		return { key: 'k', headSha, state, startedAt: 0, findings: [] };
	}

	function raw(overrides: Partial<IRawReviewFinding> = {}): IRawReviewFinding {
		return { file: 'src/math.ts', line: 10, severity: 'high', title: 'Off-by-one in range', explanation: 'The loop skips the last item.', ...overrides };
	}

	test('auto review is off by default and never for closed pull requests', () => {
		assert.strictEqual(shouldAutoReview('off', open, undefined), false);
		assert.strictEqual(shouldAutoReview('all', { ...open, isOpen: false }, undefined), false);
		assert.strictEqual(shouldAutoReview('all', { ...open, headSha: undefined }, undefined), false);
	});

	test('mine reviews only the pull requests the user opened', () => {
		assert.strictEqual(shouldAutoReview('mine', { ...open, isMine: false }, undefined), false);
		assert.strictEqual(shouldAutoReview('mine', open, undefined), true);
		assert.strictEqual(shouldAutoReview('all', { ...open, isMine: false }, undefined), true);
	});

	test('a head is reviewed once; a new push is reviewed again', () => {
		assert.strictEqual(shouldAutoReview('all', open, record('aaa111')), false);
		assert.strictEqual(shouldAutoReview('all', { ...open, headSha: 'bbb222' }, record('aaa111')), true);
	});

	test('a failed or missing review on the same head is started again', () => {
		assert.strictEqual(reviewNeedsStart(undefined, 'aaa111'), true);
		assert.strictEqual(reviewNeedsStart(record('aaa111', 'failed'), 'aaa111'), true);
		assert.strictEqual(reviewNeedsStart(record('aaa111', 'done'), 'aaa111'), false);
		assert.strictEqual(reviewNeedsStart(record('aaa111', 'running'), 'bbb222'), true);
	});

	test('parses a fenced JSON block, bare JSON and the findings file', () => {
		const findings = [{ file: './src/math.ts', line: 10.4, severity: 'high', title: 'Off-by-one', explanation: 'skips last' }];
		assert.deepStrictEqual(parseReviewOutput(`Done.\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``), [{ file: 'src/math.ts', line: 10, severity: 'high', title: 'Off-by-one', explanation: 'skips last' }]);
		assert.deepStrictEqual(parseReviewOutput(JSON.stringify({ findings: [] })), []);
		assert.deepStrictEqual(parseReviewOutput(`Word counts are short.\n${JSON.stringify({ findings: [{ file: 'a.ts', line: 2, title: 'Short', severity: 'low' }] })}\nDone.`)?.map(finding => finding.title), ['Short']);
		assert.strictEqual(parseReviewOutput('I found nothing wrong.'), undefined);
	});

	test('drops findings without a file, line or title and treats unknown severities as medium', () => {
		const parsed = parseReviewOutput(JSON.stringify({
			findings: [
				{ file: 'a.ts', line: 3, severity: 'critical', title: 'Bad' },
				{ file: '', line: 3, severity: 'high', title: 'No file' },
				{ file: 'a.ts', line: 0, severity: 'high', title: 'Line zero' },
				{ file: 'a.ts', line: 4, severity: 'low' },
				null,
			],
		}));
		assert.deepStrictEqual(parsed?.map(finding => [finding.title, finding.severity, finding.explanation]), [['Bad', 'medium', '']]);
	});

	test('same finding: same file and title, lines within the window', () => {
		assert.strictEqual(sameFinding(raw(), raw({ line: 14 })), true);
		assert.strictEqual(sameFinding(raw(), raw({ line: 40 })), false);
		assert.strictEqual(sameFinding(raw(), raw({ file: 'other.ts' })), false);
		assert.strictEqual(sameFinding(raw(), raw({ title: 'off-by-one in RANGE' })), true);
	});

	test('a re-review keeps earlier findings, marks new ones and resolves the ones that went away', () => {
		const first = mergeReviewFindings([], [raw(), raw({ file: 'b.ts', title: 'Null deref', line: 3 })], 'aaa111');
		assert.deepStrictEqual(first.map(finding => finding.firstSeenSha), ['aaa111', 'aaa111']);

		const second = mergeReviewFindings(first, [raw({ line: 12 }), raw({ file: 'c.ts', title: 'Race', line: 9 })], 'bbb222');
		const byTitle = (title: string) => second.find(finding => finding.title === title)!;
		assert.strictEqual(byTitle('Off-by-one in range').id, first[0].id, 'the same finding keeps its id');
		assert.strictEqual(byTitle('Off-by-one in range').firstSeenSha, 'aaa111');
		assert.strictEqual(byTitle('Off-by-one in range').headSha, 'bbb222');
		assert.strictEqual(byTitle('Null deref').state, 'resolved');
		assert.strictEqual(byTitle('Race').firstSeenSha, 'bbb222');
		assert.deepStrictEqual(newReviewFindings(second, 'bbb222').map(finding => finding.title), ['Race']);
	});

	test('a dismissed finding stays dismissed across re-reviews', () => {
		const dismissed: IReviewFinding[] = [{ ...raw(), id: 'f-1', state: 'dismissed', firstSeenSha: 'aaa111', headSha: 'aaa111' }];
		const next = mergeReviewFindings(dismissed, [raw()], 'bbb222');
		assert.strictEqual(next[0].state, 'dismissed');
		assert.strictEqual(next[0].id, 'f-1');
		assert.deepStrictEqual(openFindingsSorted(next), []);
	});

	test('open findings sort by severity, then file and line', () => {
		const findings = mergeReviewFindings([], [
			raw({ severity: 'low', title: 'L', file: 'a.ts', line: 1 }),
			raw({ severity: 'high', title: 'H2', file: 'b.ts', line: 1 }),
			raw({ severity: 'high', title: 'H1', file: 'a.ts', line: 5 }),
			raw({ severity: 'medium', title: 'M', file: 'a.ts', line: 2 }),
		], 'aaa111');
		assert.deepStrictEqual(openFindingsSorted(findings).map(finding => finding.title), ['H1', 'H2', 'M', 'L']);
	});

	test('changed lines come from the hunks of the new file', () => {
		const patch = [
			'diff --git a/src/math.ts b/src/math.ts',
			'--- a/src/math.ts',
			'+++ b/src/math.ts',
			'@@ -1,3 +1,4 @@',
			' const a = 1;',
			'-const b = 2;',
			'+const b = 3;',
			'+const c = 4;',
			' export {};',
		].join('\n');
		assert.deepStrictEqual([...changedLinesByFile(patch).get('src/math.ts')!], [2, 3]);
	});

	test('the review prompt names the findings file and the repository rules, and cuts a huge diff', () => {
		const prompt = buildReviewPrompt({ title: 'Add range', base: 'main', head: 'feature', diff: 'x'.repeat(REVIEW_DIFF_MAX_CHARS + 10), rules: 'Flag missing tests.' });
		assert.ok(prompt.includes('```json block'));
		assert.ok(prompt.includes('Do not run commands'));
		assert.ok(prompt.includes('Flag missing tests.'));
		assert.ok(prompt.includes('diff cut at'));
		assert.ok(!buildReviewPrompt({ title: 't', base: 'main', head: 'h', diff: 'small' }).includes('repository asks'));
	});

	test('the fix prompt names the location and the suggestion', () => {
		const prompt = buildFixPrompt(raw({ suggestion: 'use <= length' }));
		assert.ok(prompt.includes('src/math.ts:10'));
		assert.ok(prompt.includes('use <= length'));
	});
});
