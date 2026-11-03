/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describeExploreActivity, IAgentActivityItem, applyExploreInputToActivity } from '../../browser/blocks/agentBlocks.js';
import { describeHostToolActivity, friendlyToolTitle, sameHostToolArgs } from '../../browser/blocks/agentHostToolActivity.js';
import { buildThreadParts, mergeFileBlocks, turnFileChanges } from '../../browser/chrome/agentTimeline.js';
import { isAgentTransportError } from '../../../../services/voltRuntime/browser/agents/acpProvider.js';
import { COMMIT_PLAN_TOOL_NAMES, isVoltHostTool, PULL_REQUEST_TOOL_NAMES, splitMcpToolName, voltHostToolName } from '../../../../services/voltRuntime/common/hostTools.js';
import { COMMIT_PLAN_TOOLS } from '../../browser/pullRequests/agentCommitPlanService.js';
import { bareTaskToolName } from '../../../../services/voltRuntime/common/orchestration/agentTasks.js';
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

	test('commit review tools are Volt tools with readable rows', () => {
		assert.deepStrictEqual(COMMIT_PLAN_TOOLS.map(tool => tool.name), [...COMMIT_PLAN_TOOL_NAMES], 'the service registers exactly the names Volt recognizes');
		assert.ok(isVoltHostTool('mcp__volt__propose_commits'));
		assert.ok(isVoltHostTool('mcp__volt__rename_branch'));
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__propose_commits', undefined, JSON.stringify({ commits: [{ message: 'a', files: ['x'] }, { message: 'b', files: ['y'] }] })), { tool: 'propose_commits', label: 'Proposed commits', detail: '2 commits' });
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__rename_branch', undefined, '{"name":"feat/commit-review"}'), { tool: 'rename_branch', label: 'Renamed branch', detail: 'feat/commit-review' });
		// Codex titles the row with the call itself.
		const codexTitle = JSON.stringify({ server: 'volt', tool: 'propose_commits', arguments: { commits: [{ message: 'a', files: ['x'] }] } });
		assert.deepStrictEqual(describeHostToolActivity(undefined, codexTitle, undefined), { tool: 'propose_commits', label: 'Proposed commits', detail: '1 commit' });
	});

	test('orchestration tools read as what the agent did to other chats', () => {
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__thread_send', undefined, JSON.stringify({ thread_id: 'agent-0123456789ab', message: 'Rebase on main', wait: true })), { tool: 'thread_send', label: 'Asked chat', detail: 'Rebase on main' });
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__thread_send', undefined, JSON.stringify({ thread_id: 'x', message: 'Stop', mode: 'restart' })), { tool: 'thread_send', label: 'Interrupted chat with', detail: 'Stop' });
		assert.deepStrictEqual(describeHostToolActivity('MCP: tool', 'volt: thread_launch', JSON.stringify({ providerIdentifier: 'volt', toolName: 'thread_launch', args: { title: 'Stack layer 2', models: ['a', 'b', 'c'] } })), { tool: 'thread_launch', label: 'Launched 3 chats', detail: 'Stack layer 2' });
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__thread_wait', undefined, JSON.stringify({ thread_ids: ['a', 'b'] })), { tool: 'thread_wait', label: 'Waited for 2 chats', detail: undefined });
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__thread_read', undefined, JSON.stringify({ thread_id: 'volt://session/agent-0123456789ab' })), { tool: 'thread_read', label: 'Read chat', detail: '…6789ab' });
		assert.strictEqual(describeHostToolActivity('mcp__volt__thread_fork', undefined, '{}')?.label, 'Forked this chat');
		assert.strictEqual(describeHostToolActivity('mcp__volt__thread_update', undefined, '{"action":"archive"}')?.label, 'Archived chat');
		assert.strictEqual(describeHostToolActivity('mcp__volt__queue_cancel', undefined, '{"all":true}')?.label, 'Cleared queue');
		assert.ok(isVoltHostTool('mcp__volt__queue_send_now'));
	});

	test('a page rendered under its earlier name reads the same as html_render', () => {
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__render_html', undefined, '{"title":"Release dashboard"}'), { tool: 'html_render', label: 'Rendered page', detail: 'Release dashboard' });
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__html_render', undefined, '{"title":"Release dashboard"}'), { tool: 'html_render', label: 'Rendered page', detail: 'Release dashboard' });
		assert.strictEqual(describeHostToolActivity('volt-html_preview: html_preview', undefined, '{"width":390}')?.detail, '390px');
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

	test('memory tool calls read as recall and save rows with the note name', () => {
		assert.deepStrictEqual(describeHostToolActivity('memory_read', undefined, '{"name":"pnpm and small diffs"}'), { tool: 'memory_read', label: 'Recalled memory', detail: 'pnpm and small diffs' });
		assert.deepStrictEqual(describeHostToolActivity('memory_write', undefined, '{"name":"Prefers small diffs"}'), { tool: 'memory_write', label: 'Saved memory', detail: 'Prefers small diffs' });
		assert.deepStrictEqual(describeHostToolActivity('memory_list', undefined, '{}'), { tool: 'memory_list', label: 'Checked memories' });
	});

	test('never shows a raw MCP tool name', () => {
		assert.strictEqual(friendlyToolTitle('mcp__volt__terminal_start'), 'Started terminal');
		assert.strictEqual(friendlyToolTitle('mcp__aws-docs__search_docs'), 'Search docs');
		assert.strictEqual(friendlyToolTitle('Read file'), undefined);
		assert.deepStrictEqual(describeExploreActivity('mcp__volt__terminal_start', 'mcp__volt__terminal_start', '{"command":"npm run dev"}'), { label: 'Started terminal', detail: 'npm run dev' });
		assert.strictEqual(describeExploreActivity('mcp__volt__wait_tasks', 'mcp__volt__wait_tasks', '{"task_ids":["t-1"]}').label, 'Waited for tasks');
		assert.strictEqual(friendlyToolTitle('mcp__volt__task_status'), 'Checked task');
	});

	test('every agent\'s spelling of a tool name reads as words', () => {
		// Grok and Codex name MCP tools `server__tool`; Cursor `server: tool`; others plain snake_case.
		assert.strictEqual(friendlyToolTitle('volt__wait_tasks'), 'Waited for tasks');
		assert.strictEqual(describeExploreActivity('volt__wait_tasks', 'volt__wait_tasks', '{}').label, 'Waited for tasks');
		assert.strictEqual(friendlyToolTitle('volt: delegate_task'), 'Delegated task');
		assert.strictEqual(friendlyToolTitle('volt-thread_read: thread_read'), 'Thread read');
		assert.strictEqual(friendlyToolTitle('mcp__volt__ask_question'), 'Asked questions');
		assert.strictEqual(friendlyToolTitle('volt__terminal_start'), 'Started terminal');
		assert.strictEqual(friendlyToolTitle('context7__get-library-docs'), 'Get library docs');
		assert.strictEqual(friendlyToolTitle('github: create_issue'), 'Create issue');
		assert.strictEqual(friendlyToolTitle('list_dir'), 'List dir');
		assert.strictEqual(friendlyToolTitle('wait_tasks'), 'Waited for tasks');
		// Already words, a path, or Cursor's placeholder: left alone.
		for (const words of ['Read file', 'Edited app.ts', 'src/my_file.ts', 'MCP: tool', 'TodoWrite', 'Search: auth middleware']) {
			assert.strictEqual(friendlyToolTitle(words), undefined, words);
		}
		assert.deepStrictEqual(splitMcpToolName('mcp__aws-docs__search_docs'), { server: 'aws-docs', tool: 'search_docs' });
		assert.deepStrictEqual(splitMcpToolName('MCP: browser_click'), { tool: 'browser_click' });
		assert.strictEqual(voltHostToolName('volt__browser_click'), 'browser_click', 'Volt\'s own tools are recognized in this spelling too');
		assert.strictEqual(bareTaskToolName('volt__delegate_task'), 'delegate_task');
	});
});
