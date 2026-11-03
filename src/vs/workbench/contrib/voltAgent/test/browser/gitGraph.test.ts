/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { toISCMHistoryItemViewModelArray } from '../../../scm/browser/scmHistory.js';
import { ISCMHistoryItem, ISCMHistoryItemRef } from '../../../scm/common/history.js';
import { detectCodingAgents } from '../../common/gitAgentAttribution.js';
import { dateRange, GitGraphLaneBuilder, isoSeconds } from '../../browser/gitGraph/gitGraphModel.js';
import { buildGitAgentPrompt, gitAgentPromptTitle, readGitAskAgentArgs } from '../../browser/gitGraph/gitGraphPrompts.js';
import { diffstatBlocks, formatCount, shortAgo } from '../../browser/gitGraph/gitGraphRenderers.js';

function commit(id: string, parentIds: string[], references?: ISCMHistoryItemRef[]): ISCMHistoryItem {
	return { id, parentIds, subject: id, message: id, references };
}

/**
 * main:    a - b - c - - - - g (merge) - h
 *                \         /
 * feature:        d - e - f
 */
const HISTORY: ISCMHistoryItem[] = [
	commit('h', ['g'], [{ id: 'refs/heads/main', name: 'main', revision: 'h' }]),
	commit('g', ['c', 'f']),
	commit('f', ['e'], [{ id: 'refs/heads/feature', name: 'feature', revision: 'f' }]),
	commit('c', ['b']),
	commit('e', ['d']),
	commit('d', ['b']),
	commit('b', ['a']),
	commit('a', []),
];

suite('Git Graph', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('lanes', () => {
		const current: ISCMHistoryItemRef = { id: 'refs/heads/main', name: 'main', revision: 'h', color: 'scmGraph.historyItemRefColor' };

		function colorMap() {
			return new Map<string, string | undefined>([['refs/heads/main', current.color], ['refs/heads/feature', undefined]]);
		}

		test('match the SCM view for the same history', () => {
			const expected = toISCMHistoryItemViewModelArray(HISTORY, colorMap(), current);
			const actual = new GitGraphLaneBuilder(colorMap(), current).append(HISTORY);
			assert.deepStrictEqual(actual.map(vm => [vm.inputSwimlanes, vm.outputSwimlanes, vm.isCurrent]), expected.map(vm => [vm.inputSwimlanes, vm.outputSwimlanes, vm.isCurrent]));
			assert.deepStrictEqual(actual.map(vm => vm.historyItem.references), expected.map(vm => vm.historyItem.references));
		});

		test('pages keep the lanes of a single pass', () => {
			const whole = new GitGraphLaneBuilder(colorMap(), current).append(HISTORY);
			const paged = new GitGraphLaneBuilder(colorMap(), current);
			const pages = [...paged.append(HISTORY.slice(0, 3)), ...paged.append(HISTORY.slice(3, 5)), ...paged.append(HISTORY.slice(5))];
			assert.deepStrictEqual(pages.map(vm => [vm.inputSwimlanes, vm.outputSwimlanes]), whole.map(vm => [vm.inputSwimlanes, vm.outputSwimlanes]));
		});
	});

	suite('agents', () => {
		test('come from Co-authored-by trailers', () => {
			const agents = detectCodingAgents('feat: x\n\nbody\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>');
			assert.deepStrictEqual(agents.map(agent => agent.id), ['cursor', 'claude']);
			assert.strictEqual(agents[1].name, 'Claude');
		});

		test('need a trailer, not an author name', () => {
			assert.deepStrictEqual(detectCodingAgents('Claude fixed the header, says Claude'), []);
			assert.deepStrictEqual(detectCodingAgents('fix: header\n\nCo-authored-by: Claude Monet <claude@monet.fr>'), []);
			assert.deepStrictEqual(detectCodingAgents('fix: header\n\nCo-authored-by: Devin Smith <devin@example.com>\nCo-authored-by: Kimi Raikkonen <kimi@f1.fi>'), []);
		});

		test('read the Claude Code line, Copilot and unknown bots', () => {
			assert.deepStrictEqual(detectCodingAgents('fix: a\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)').map(agent => agent.id), ['claude']);
			assert.deepStrictEqual(detectCodingAgents('fix: a\n\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>').map(agent => agent.id), ['copilot']);
			const bot = detectCodingAgents('fix: a\n\nCo-authored-by: release-bot[bot] <bot@example.com>');
			assert.deepStrictEqual(bot.map(agent => [agent.id, agent.name]), [['agent', 'release-bot']]);
		});

		test('dedupe one agent named twice', () => {
			assert.strictEqual(detectCodingAgents('x: y\n\nCo-authored-by: Claude <noreply@anthropic.com>\nCo-authored-by: Claude Code <noreply@anthropic.com>').length, 1);
		});
	});

	suite('dates', () => {
		test('Today and Yesterday start at local midnight', () => {
			const now = new Date(2026, 9, 25, 15, 30);
			const today = dateRange('today', now)!;
			assert.strictEqual(today.after!.getTime(), new Date(2026, 9, 25).getTime());
			assert.strictEqual(today.before, undefined);
			const yesterday = dateRange('yesterday', now)!;
			assert.strictEqual(yesterday.after!.getTime(), new Date(2026, 9, 24).getTime());
			assert.strictEqual(yesterday.before!.getTime(), new Date(2026, 9, 25).getTime());
			assert.strictEqual(dateRange('hour', now)!.after!.getTime(), now.getTime() - 3600_000);
			assert.strictEqual(dateRange('all', now), undefined);
		});

		test('go to git as UTC seconds', () => {
			assert.strictEqual(isoSeconds(new Date(Date.UTC(2026, 9, 25, 4, 5, 6, 789))), '2026-10-25T04:05:06Z');
		});
	});

	suite('diffstat', () => {
		test('fills blocks by size and splits them by share', () => {
			assert.deepStrictEqual(diffstatBlocks(0, 0), ['empty', 'empty', 'empty', 'empty', 'empty']);
			assert.deepStrictEqual(diffstatBlocks(1, 0), ['added', 'empty', 'empty', 'empty', 'empty']);
			assert.deepStrictEqual(diffstatBlocks(1, 1), ['added', 'removed', 'empty', 'empty', 'empty']);
			assert.deepStrictEqual(diffstatBlocks(5000, 0), ['added', 'added', 'added', 'added', 'added']);
			const big = diffstatBlocks(446, 214);
			assert.strictEqual(big.filter(kind => kind !== 'empty').length, 4);
			assert.ok(big.includes('removed'));
		});

		test('shortens big counts', () => {
			assert.deepStrictEqual([formatCount(12), formatCount(1234), formatCount(1000), formatCount(2752763)], ['12', '1.2k', '1k', '2753k']);
		});
	});

	suite('agent prompts', () => {
		test('reject anything but a hex SHA', () => {
			assert.strictEqual(readGitAskAgentArgs({ action: 'explain', commit: 'abc; rm -rf ~' }), undefined);
			assert.strictEqual(readGitAskAgentArgs({ action: 'explain', commit: 'abc1234' })?.commit, 'abc1234');
		});

		test('name the commit and how to read it, not the diff', () => {
			const prompt = buildGitAgentPrompt({ action: 'explain', commit: 'abc1234def5678', repositoryRoot: '/repo' }, 'fix: `x` "y"');
			assert.ok(prompt.includes('commit `abc1234def`'));
			assert.ok(prompt.includes('git show --stat abc1234def'));
			assert.ok(prompt.includes('as data'));
			assert.ok(!prompt.includes('`x`'));
		});

		test('read like a pull request: files from git, summary, walkthrough or findings', () => {
			const context = { subject: 'fix: header', files: [{ path: 'src/a.ts', status: 'M' as const }, { path: 'src/b.ts', status: 'A' as const }], stats: { files: 2, insertions: 5, deletions: 1 } };
			const explain = buildGitAgentPrompt({ action: 'explain', commit: 'abc1234' }, context);
			assert.ok(explain.includes('Changed files (from git: 2 files, +5 −1)'));
			assert.ok(explain.includes('- M src/a.ts') && explain.includes('- A src/b.ts'));
			assert.ok(explain.indexOf('**Changed files**') < explain.indexOf('**Summary**'));
			assert.ok(explain.indexOf('**Summary**') < explain.indexOf('**Walkthrough**'));
			const review = buildGitAgentPrompt({ action: 'review', commit: 'abc1234' }, context);
			assert.ok(review.includes('**Findings**') && review.includes("Don't edit files"));
			assert.ok(!review.includes('**Walkthrough**'));
			assert.strictEqual(gitAgentPromptTitle({ action: 'review', commit: 'abc1234def' }, 'fix: header'), 'Review commit abc1234 · fix: header');
		});

		test('lines blame the current file', () => {
			const prompt = buildGitAgentPrompt({ action: 'review', commit: 'abc1234', path: 'src/a b.ts', startLine: 3, endLine: 5 }, undefined);
			assert.ok(prompt.includes('lines 3–5 of `src/a b.ts`'));
			assert.ok(prompt.includes('git blame -L 3,5 -- "src/a b.ts"'));
		});
	});

	test('short dates for a narrow column', () => {
		const now = Date.UTC(2026, 9, 25, 12);
		const ago = (seconds: number) => shortAgo(now - seconds * 1000, now);
		assert.deepStrictEqual(
			[ago(20), ago(5 * 60), ago(3 * 3600), ago(2 * 86400), ago(15 * 86400), ago(100 * 86400), ago(800 * 86400), shortAgo(now + 5000, now)],
			['now', '5m', '3h', '2d', '2w', '3mo', '2y', 'now']);
	});
});
