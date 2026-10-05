/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describeExploreActivity, IAgentActivityItem, applyExploreInputToActivity } from '../../browser/blocks/agentBlocks.js';
import { describeHostToolActivity, sameHostToolArgs } from '../../browser/blocks/agentHostToolActivity.js';
import { buildThreadParts, mergeFileBlocks, turnFileChanges } from '../../browser/chrome/agentTimeline.js';
import { isAgentTransportError } from '../../../../services/voltRuntime/browser/agents/acpProvider.js';
import { isVoltHostTool, PULL_REQUEST_TOOL_NAMES } from '../../../../services/voltRuntime/common/hostTools.js';
import { PULL_REQUEST_TOOLS } from '../../browser/pullRequests/agentPullRequestService.js';

suite('Agent host tool activity', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('words browser actions like Cursor', () => {
		const cursorInput = JSON.stringify({ providerIdentifier: 'volt', toolName: 'browser_click', args: { element: 'Top-left cell', ref: 'e2' } });
		assert.deepStrictEqual(describeHostToolActivity('MCP: tool', 'volt: browser_click', cursorInput), { tool: 'browser_click', label: 'Clicked', detail: 'Top-left cell' });
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__browser_navigate', undefined, JSON.stringify({ url: 'http://127.0.0.1:8766/' })), { tool: 'browser_navigate', label: 'Navigated to', detail: 'http://127.0.0.1:8766/' });
		assert.strictEqual(describeHostToolActivity('mcp__volt__browser_resize', undefined, JSON.stringify({ width: 390, height: 844 }))?.detail, '390×844');
		assert.strictEqual(describeHostToolActivity('mcp__volt__browser_screenshot', undefined, '{}')?.label, 'Took screenshot');
		assert.strictEqual(describeHostToolActivity('Read File', 'Read foo.ts', '{}'), undefined);
	});

	test('pull request tools are Volt tools (approved without asking) with readable rows', () => {
		assert.deepStrictEqual(PULL_REQUEST_TOOLS.map(tool => tool.name), [...PULL_REQUEST_TOOL_NAMES], 'the service registers exactly the names Volt recognizes');
		assert.ok(isVoltHostTool('mcp__volt__watch_pull_request'));
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__link_pull_request', undefined, '{"number":3}'), { tool: 'link_pull_request', label: 'Linked pull request', detail: '#3' });
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__watch_pull_request', undefined, '{"url":"https://github.com/a/b/pull/9"}'), { tool: 'watch_pull_request', label: 'Watching pull request', detail: 'https://github.com/a/b/pull/9' });
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__list_thread_pull_requests', undefined, '{}'), { tool: 'list_thread_pull_requests', label: 'Listed pull requests' });
	});

	test('hides the question tools', () => {
		assert.strictEqual(describeHostToolActivity('mcp__volt__ask_question', undefined, '{}')?.hidden, true);
		assert.strictEqual(describeHostToolActivity('MCP: tool', 'volt: await_answers', '{}')?.hidden, true);
	});

	test('a bare "MCP: tool" row becomes a browser row once Cursor names it', () => {
		const described = describeExploreActivity('MCP: tool', 'MCP: tool', '{}');
		const item: IAgentActivityItem = { kind: 'note', label: described.label, toolName: 'MCP: tool', toolTitle: 'MCP: tool' };
		applyExploreInputToActivity(item, 'MCP: tool', 'MCP: tool', JSON.stringify({ providerIdentifier: 'volt', toolName: 'browser_click', args: { element: 'Restart button', ref: 'e11' } }));
		assert.strictEqual(item.kind, 'browser');
		assert.strictEqual(item.browserTool, 'browser_click');
		assert.strictEqual(item.label, 'Clicked');
		assert.strictEqual(item.detail, 'Restart button');
		assert.deepStrictEqual(item.hostArgs, { element: 'Restart button', ref: 'e11' });
	});

	test('screenshots stay in the browser-action group and hidden rows are skipped', () => {
		const parts = buildThreadParts([
			{ kind: 'activity', item: { kind: 'browser', label: 'Navigated to', detail: 'http://x/', browserTool: 'browser_navigate' } },
			{ kind: 'activity', item: { kind: 'note', label: 'Asked questions', hidden: true } },
			{ kind: 'activity', item: { kind: 'browser', label: 'Took screenshot', browserTool: 'browser_screenshot', image: 'data:image/png;base64,AA==' } },
		]);
		assert.strictEqual(parts.length, 1);
		assert.strictEqual(parts[0].kind, 'group');
		assert.deepStrictEqual(parts[0].kind === 'group' ? parts[0].items.map(item => item.label) : [], ['Navigated to', 'Took screenshot']);
	});

	test('matches a host result to the agent\'s echo of its arguments', () => {
		assert.strictEqual(sameHostToolArgs({ ref: 'e2', element: 'A' }, { element: 'A', ref: 'e2' }), true);
		assert.strictEqual(sameHostToolArgs({ ref: 'e2' }, { ref: 'e3' }), false);
	});

	test('several edits to one file show that file once with summed stats', () => {
		const edit = (id: string, additions: number, deletions: number) => ({ type: 'file' as const, id, status: 'complete' as const, path: '/r/xo/index.html', verb: 'Edited' as const, additions, deletions, expanded: false });
		const merged = mergeFileBlocks([edit('a', 2, 2), edit('b', 15, 2), { ...edit('c', 5, 0), path: '/r/xo/app.js' }]);
		assert.deepStrictEqual(merged.map(file => [file.path, file.additions, file.deletions]), [['/r/xo/index.html', 17, 4], ['/r/xo/app.js', 5, 0]]);
		const parts = buildThreadParts([{ kind: 'block', block: edit('a', 2, 2) }, { kind: 'block', block: edit('b', 1, 1) }]);
		assert.strictEqual(parts.length, 1);
		assert.strictEqual(parts[0].kind === 'block' && parts[0].block.type === 'file' ? parts[0].block.additions : -1, 3);
		assert.deepStrictEqual(turnFileChanges([{ kind: 'block', block: edit('a', 700, 1) }, { kind: 'block', block: edit('b', 20, 7) }]).map(file => [file.path, file.additions, file.deletions]), [['/r/xo/index.html', 720, 8]]);
	});

	test('recognizes the CLI losing its backend connection', () => {
		assert.strictEqual(isAgentTransportError('RetriableError: Connection stalled'), true);
		assert.strictEqual(isAgentTransportError('RetriableError: [unavailable] PING timed out'), true);
		assert.strictEqual(isAgentTransportError('RetriableError: [aborted] read ECONNRESET'), true);
		assert.strictEqual(isAgentTransportError('You have hit your usage limit'), false);
	});
});
