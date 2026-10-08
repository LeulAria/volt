/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { describeHostToolActivity } from '../../browser/blocks/agentHostToolActivity.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentSegment, appendProviderNotice, applyExploreInputToActivity, applyExploreResultToActivity, applyFileTargetToActivity, classifyToolActivity, collectBlocks, createToolBlock, describeExploreActivity, IAgentActivityItem, isExploreItemClickable, isExploreTool, isFileChangeTool, isShellTool, parseExploreResultFiles, parseFileTarget, firstCommandName, isPlanTool, parsePlanToolInput, splitActivityLabel, splitMarkdownToBlocks, workCountsForSegments } from '../../browser/blocks/agentBlocks.js';

suite('Agent explore tool cards', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('treats Find and Read File as explore tools', () => {
		assert.strictEqual(isExploreTool('Find'), true);
		assert.strictEqual(isExploreTool('Read File'), true);
		assert.strictEqual(isExploreTool('read_file'), true);
		assert.strictEqual(isExploreTool('Grep'), true);
		assert.strictEqual(isExploreTool('Glob'), true);
		assert.strictEqual(isExploreTool('WebFetch'), true);
		assert.strictEqual(isExploreTool('List MCP Resources'), true);
	});

	test('counts work from segments for the status line', () => {
		const counts = workCountsForSegments([
			{ kind: 'activity', item: { kind: 'read', label: 'Read', detail: 'a.ts' } },
			{ kind: 'activity', item: { kind: 'search', label: 'Searched' } },
			{ kind: 'block', block: createToolBlock({ id: 'edit', callId: '3', name: 'Edit', title: 'Edit' }) },
		]);
		assert.strictEqual(counts.reads, 1);
		assert.strictEqual(counts.searches, 1);
	});

	test('classifies mystery tools from activity kind', () => {
		assert.strictEqual(isExploreTool('mystery', undefined, 'read'), true);
		assert.strictEqual(isExploreTool('Read File', undefined, 'edit'), false);
		assert.strictEqual(isFileChangeTool('mystery', undefined, 'edit'), true);
		assert.strictEqual(isFileChangeTool('Edit', undefined, 'read'), false);
		assert.strictEqual(isShellTool('bash', undefined, undefined, 'execute'), true);
		assert.strictEqual(isShellTool('bash', undefined, undefined, 'read'), false);
		assert.strictEqual(classifyToolActivity('mystery', undefined, 'search'), 'search');
	});

	test('treats edit tools as file changes', () => {
		assert.strictEqual(isExploreTool('Edit'), false);
		assert.strictEqual(isExploreTool('StrReplace'), false);
		assert.strictEqual(isExploreTool('Write'), false);
		assert.strictEqual(isFileChangeTool('Edit'), true);
		assert.strictEqual(isFileChangeTool('StrReplace'), true);
		assert.strictEqual(isFileChangeTool('Write'), true);
		assert.strictEqual(isFileChangeTool('Read File'), false);
	});

	test('collectBlocks hides explore pills from the response body', () => {
		const blocks = collectBlocks([
			{
				kind: 'block',
				block: createToolBlock({ id: 'find', callId: '1', name: 'Find', title: 'Find' }),
			},
			{
				kind: 'block',
				block: createToolBlock({ id: 'read', callId: '2', name: 'Read', title: 'Read File' }),
			},
			{
				kind: 'block',
				block: createToolBlock({ id: 'edit', callId: '3', name: 'Edit', title: 'Edit' }),
			},
		]);
		assert.deepStrictEqual(blocks.map(block => block.id), ['edit']);
	});
});

suite('Adaptive answer blocks', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps a ranking list as the markdown the model wrote', () => {
		const blocks = splitMarkdownToBlocks([
			'The 10 most populated countries:',
			'',
			'1. India — 1,476,625,576',
			'2. China — 1,412,914,089',
			'3. United States — 349,035,494',
		].join('\n'), 's0');
		assert.deepStrictEqual(blocks.map(block => block.type), ['markdown']);
	});

	test('keeps mermaid fences as mermaid blocks', () => {
		const blocks = splitMarkdownToBlocks('```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```', 's0');
		assert.strictEqual(blocks[0].type, 'mermaid');
	});

	test('a fence a line introduces as a file is that file', () => {
		const pathOf = (markdown: string) => {
			const code = splitMarkdownToBlocks(markdown, 's0').find(block => block.type === 'code');
			return code?.type === 'code' ? code.path : 'no code block';
		};
		assert.strictEqual(pathOf('**Task 1 — Grok 4.7 created src/array.js:**\n\n```js\nexport function sum() {}\n```'), 'src/array.js');
		assert.strictEqual(pathOf('Here is `index.html`:\n\n```html\n<h1>Hi</h1>\n```'), 'index.html');
		assert.strictEqual(pathOf('I updated config.json:\n\n```json\n{}\n```'), 'config.json');
		assert.strictEqual(pathOf('```src/app.ts\nlet a = 1;\n```'), 'src/app.ts');
		assert.strictEqual(pathOf('Run it with Node.js:\n\n```sh\nnode app.js\n```'), undefined, 'a product name is not a file');
		assert.strictEqual(pathOf('For example, e.g:\n\n```js\n1\n```'), undefined);
		assert.strictEqual(pathOf('See src/app.ts for details.\n\n```js\n1\n```'), undefined, 'the path must introduce the fence');
		assert.strictEqual(pathOf('```12:20:src/app.ts\nlet a = 1;\n```'), undefined, 'citations keep their own header');
	});
});

suite('Agent file activity labels', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('does not treat Read File as a file named File', () => {
		assert.deepStrictEqual(splitActivityLabel('Read', 'Read File'), { label: 'Read File' });
	});

	test('parses target_file and file_path from tool input', () => {
		assert.deepStrictEqual(parseFileTarget('{"target_file":"src/app.ts","offset":10}'), {
			path: 'src/app.ts',
			startLine: 10,
			endLine: undefined,
		});
		assert.deepStrictEqual(parseFileTarget('{"file_path":"/tmp/index.html"}')?.path, '/tmp/index.html');
	});

	test('uses the file name as the clickable detail', () => {
		const split = splitActivityLabel('Read', 'Read File', { path: 'src/package.json', startLine: 4, endLine: 20 });
		assert.deepStrictEqual(split, { label: 'Read', detail: 'package.json L4-20' });
	});

	test('applies a streamed path onto a Read File activity', () => {
		const item: IAgentActivityItem = { kind: 'read', label: 'Read File' };
		assert.strictEqual(applyFileTargetToActivity(item, parseFileTarget('{"path":"src/vs/workbench/contrib/voltAgent/browser/editor/agentEditor.ts"}')), true);
		assert.strictEqual(item.label, 'Read');
		assert.strictEqual(item.detail, 'agentEditor.ts');
		assert.ok(item.path?.endsWith('agentEditor.ts'));
	});
});

suite('Agent explore activity details', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('formats Find glob searches like Cursor', () => {
		const described = describeExploreActivity('Find', 'Find', '{"pattern":"**/*.{ts,tsx,css}","path":".alnsp"}');
		assert.strictEqual(described.label, 'Searched files');
		assert.strictEqual(described.detail, '**/*.{ts,tsx,css} in .alnsp');
		assert.strictEqual(described.clickable, false);
	});

	test('formats grep pattern and directory', () => {
		const described = describeExploreActivity('grep', 'grep', '{"pattern":"contextUsage","path":"t3code"}');
		assert.strictEqual(described.label, 'Grepped');
		assert.strictEqual(described.detail, 'contextUsage in t3code');
		assert.strictEqual(described.clickable, false);
	});

	test('formats read with offset and limit', () => {
		const described = describeExploreActivity('Read File', 'Read File', '{"path":"src/agentEditor.ts","offset":300,"limit":150}');
		assert.strictEqual(described.label, 'Read');
		assert.strictEqual(described.detail, 'agentEditor.ts L300-449');
		assert.strictEqual(described.path, 'src/agentEditor.ts');
		assert.strictEqual(described.startLine, 300);
		assert.strictEqual(described.endLine, 449);
		assert.strictEqual(described.clickable, true);
	});

	test('applies streamed rawInput onto a generic grep row', () => {
		const item: IAgentActivityItem = { kind: 'search', label: 'grep', toolName: 'grep', toolTitle: 'grep' };
		assert.strictEqual(applyExploreInputToActivity(item, 'grep', 'grep', '{"pattern":"token.?usage","path":".alnsp"}'), true);
		assert.strictEqual(item.label, 'Grepped');
		assert.strictEqual(item.detail, 'token.?usage in .alnsp');
		assert.strictEqual(isExploreItemClickable(item), false);
	});

	test('read rows stay clickable after a later input update', () => {
		const item: IAgentActivityItem = { kind: 'read', label: 'Read File', toolName: 'Read File', toolTitle: 'Read File' };
		applyExploreInputToActivity(item, 'Read File', 'Read File', '{"target_file":"browserDock.ts","offset":430,"limit":80}');
		assert.strictEqual(item.detail, 'browserDock.ts L430-509');
		assert.strictEqual(isExploreItemClickable(item), true);
	});

	test('keeps grep hit files from tool input', () => {
		const described = describeExploreActivity('grep', 'grep', JSON.stringify({
			pattern: 'DiffEditorWidget',
			path: 'src',
			files: [
				'src/vs/workbench/contrib/chat/browser/codeBlockPart.ts',
				'src/vs/workbench/contrib/chat/browser/chatWidget.ts',
			],
		}));
		assert.strictEqual(described.label, 'Grepped');
		assert.strictEqual(described.detail, 'DiffEditorWidget in src');
		assert.deepStrictEqual(described.files, [
			'src/vs/workbench/contrib/chat/browser/codeBlockPart.ts',
			'src/vs/workbench/contrib/chat/browser/chatWidget.ts',
		]);
	});

	test('parses grep result paths from text and locations', () => {
		assert.deepStrictEqual(parseExploreResultFiles([
			'src/vs/workbench/contrib/chat/browser/codeBlockPart.ts:520:export class CodeCompareBlockPart',
			{ path: 'src/vs/workbench/contrib/chat/browser/chatWidget.ts' },
		]), [
			'src/vs/workbench/contrib/chat/browser/codeBlockPart.ts',
			'src/vs/workbench/contrib/chat/browser/chatWidget.ts',
		]);
	});

	test('fills a Read File row from the tool result path', () => {
		const item: IAgentActivityItem = { kind: 'read', label: 'Read File', toolName: 'Read File', toolTitle: 'Read File' };
		applyExploreResultToActivity(item, [{ path: 'src/codeBlockPart.ts' }]);
		assert.strictEqual(item.label, 'Read');
		assert.strictEqual(item.detail, 'codeBlockPart.ts');
		assert.strictEqual(item.path, 'src/codeBlockPart.ts');
		assert.strictEqual(isExploreItemClickable(item), true);
	});

	test('read contents are not additional explored files', () => {
		const item: IAgentActivityItem = { kind: 'read', label: 'Read', path: '/repo/web/index.html', files: ['/repo/web/index.html'] };
		applyExploreResultToActivity(item, [{ type: 'content', content: { type: 'text', text: '<title>Pulse Notes</title>\n<link href="/styles.css">\n</head>\n/this/is/source/content.js' } }]);
		assert.deepStrictEqual(item.files, ['/repo/web/index.html']);
		assert.strictEqual(item.path, '/repo/web/index.html');
	});

	test('read results retain explicit locations and file lists without parsing their contents', () => {
		const item: IAgentActivityItem = { kind: 'read', label: 'Read File' };
		applyExploreResultToActivity(item, {
			path: '/repo/My File.ts',
			locations: [{ path: '/repo/other.ts', line: 3 }],
			files: ['/repo/third.ts'],
			content: 'import "./unread.ts";\nhttps://example.com/docs',
		});
		assert.deepStrictEqual(item.files, ['/repo/My File.ts', '/repo/other.ts', '/repo/third.ts']);
		assert.strictEqual(item.path, '/repo/My File.ts');
	});

	test('keeps grep hits when a later input update has no files', () => {
		const item: IAgentActivityItem = { kind: 'search', label: 'grep', toolName: 'grep', toolTitle: 'grep' };
		applyExploreInputToActivity(item, 'grep', 'grep', JSON.stringify({
			pattern: 'DiffEditorWidget',
			path: 'src',
			files: ['src/vs/workbench/contrib/chat/browser/codeBlockPart.ts'],
		}));
		applyExploreInputToActivity(item, 'grep', 'grep', JSON.stringify({
			pattern: 'DiffEditorWidget',
			path: 'src',
		}));
		assert.strictEqual(item.label, 'Grepped');
		assert.deepStrictEqual(item.files, ['src/vs/workbench/contrib/chat/browser/codeBlockPart.ts']);
	});

	test('a later limit sentence replaces the shorter status', () => {
		const segments: AgentSegment[] = [];
		appendProviderNotice(segments, { severity: 'error', title: 'Usage limit reached' });
		appendProviderNotice(segments, {
			severity: 'error',
			title: 'You\'ve hit your monthly spend limit · your session limit resets 3:20am (Asia/Dubai)',
			description: 'Continuing automatically at 3:20am',
		});
		assert.strictEqual(segments.length, 1);
		const notice = segments[0];
		if (notice?.kind !== 'notice') {
			assert.fail('expected a notice');
		}
		assert.strictEqual(notice.title, 'You\'ve hit your monthly spend limit · your session limit resets 3:20am (Asia/Dubai)');
		assert.strictEqual(notice.description, 'Continuing automatically at 3:20am');
	});

	test('adds grep result paths without losing the pattern', () => {
		const item: IAgentActivityItem = { kind: 'search', label: 'grep', toolName: 'grep', toolTitle: 'grep' };
		applyExploreInputToActivity(item, 'grep', 'grep', '{"pattern":"CodeEditorWidget","path":"chat"}');
		applyExploreResultToActivity(item, ['src/vs/workbench/contrib/chat/browser/chatWidget.ts:12:class ChatWidget'], item.input);
		assert.strictEqual(item.label, 'Grepped');
		assert.strictEqual(item.detail, 'CodeEditorWidget in chat');
		assert.deepStrictEqual(item.files, ['src/vs/workbench/contrib/chat/browser/chatWidget.ts']);
	});
	test('the running program is named whole, even from a quoted path', () => {
		assert.strictEqual(firstCommandName('"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --screenshot=a.png x.html'), 'Google Chrome');
		assert.strictEqual(firstCommandName('/usr/bin/python3 - << PY'), 'python3');
		assert.strictEqual(firstCommandName('PORT=4310 ./scripts/start.sh'), 'scripts/start.sh');
		assert.strictEqual(firstCommandName('npm test'), 'npm');
	});
	test('cursor-agent\'s plan tool is a plan, not an edit to a file called "Create Plan"', () => {
		const input = JSON.stringify({ _toolName: 'createPlan', name: 'Persist todos', plan: '# Persist todos\n\n1. Add a store' });
		assert.strictEqual(isPlanTool('Edit File', 'Create Plan'), true);
		assert.strictEqual(isPlanTool('edit', 'Edit `src/a.ts`', input), true);
		assert.strictEqual(isPlanTool('edit', 'Edit `src/plan.ts`', '{"path":"src/plan.ts"}'), false);
		assert.deepStrictEqual(parsePlanToolInput(input), { name: 'Persist todos', plan: '# Persist todos\n\n1. Add a store' });
	});
	test('Volt\'s propose_plan is a plan, also when Cursor wraps the MCP call', () => {
		const args = { title: 'Export CSV', plan: '1. Add a button', open_questions: ['Include headers?'] };
		assert.strictEqual(isPlanTool('mcp__volt__propose_plan', undefined, JSON.stringify(args)), true);
		assert.strictEqual(isPlanTool('MCP: volt', 'propose_plan'), true);
		assert.strictEqual(isPlanTool('MCP: volt', undefined, JSON.stringify({ providerIdentifier: 'volt', toolName: 'propose_plan', args })), true);
		assert.strictEqual(isPlanTool('ask_question', undefined, JSON.stringify(args)), false);
		assert.deepStrictEqual(parsePlanToolInput(JSON.stringify(args)), { name: 'Export CSV', plan: '1. Add a button', openQuestions: ['Include headers?'] });
		assert.deepStrictEqual(parsePlanToolInput(JSON.stringify({ providerIdentifier: 'volt', toolName: 'propose_plan', args })), { name: 'Export CSV', plan: '1. Add a button', openQuestions: ['Include headers?'] });
	});
});

suite('Agent host tool rows', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('design and debugging host tools read like the browser actions', () => {
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__browser_compare_image', undefined, '{"reference_path":"design/home.png"}'), { tool: 'browser_compare_image', label: 'Compared with design', detail: 'design/home.png' });
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__browser_network', undefined, '{}'), { tool: 'browser_network', label: 'Read network' });
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__image_inspect', undefined, '{"path":"/tmp/shot.png"}'), { tool: 'image_inspect', label: 'Inspected image', detail: '/tmp/shot.png' });
	});
});
