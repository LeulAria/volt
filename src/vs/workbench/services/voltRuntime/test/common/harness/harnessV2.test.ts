/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { chooseEffort } from '../../../common/deepseek/effort.js';
import { mergeUsage } from '../../../common/deepseek/llmAdapter.js';
import { buildAnthropicRequest } from '../../../common/harness/anthropicRequest.js';
import { FileLedger } from '../../../common/harness/fileLedger.js';
import { instructionsIndex, parseFrontmatter, ruleFromFile, rulesForPath } from '../../../common/harness/instructions.js';
import { applyCompaction, compactionBoundary } from '../../../common/harness/nativeCompaction.js';
import { INativeLoopMessage } from '../../../common/harness/nativeLoop.js';
import { nativeToModelMessages, sanitizeCallId, toAnthropicMessages } from '../../../common/harness/providerMessages.js';
import { batchDependencies, pathKey } from '../../../common/harness/resources.js';
import { runToolBatch } from '../../../common/harness/toolRuntime.js';
import { claudeModelMeta, claudeThinkingParams } from '../../../common/models/claudeModels.js';
import { ProviderError, providerErrorFromResponse } from '../../../common/providerError.js';
import { mcpResultContent, mcpToolName, parseMcpConfig } from '../../../common/harness/mcpConfig.js';
import { applyExactEdits, diffHunk } from '../../../common/tools/editText.js';
import { IToolCall, IVoltTool } from '../../../common/tools/tool.js';

suite('Volt harness v2', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('Claude models', () => {
		test('current models use adaptive thinking and never budget_tokens', () => {
			for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5-1']) {
				const meta = claudeModelMeta(id);
				assert.strictEqual(meta.thinking, 'adaptive', id);
				const params = claudeThinkingParams(meta, 'high', 64_000);
				assert.deepStrictEqual(params.thinking, { type: 'adaptive', display: 'summarized' }, id);
				assert.deepStrictEqual(params.output_config, { effort: 'high' });
			}
		});

		test('older models keep budget thinking; Opus 5.5 cannot disable thinking', () => {
			assert.strictEqual(claudeModelMeta('claude-haiku-4-5').thinking, 'budget');
			assert.strictEqual(claudeModelMeta('claude-sonnet-4-20250514').thinking, 'budget');
			assert.strictEqual(claudeModelMeta('claude-3-5-haiku-20241022').thinking, 'none');
			const opus55 = claudeModelMeta('claude-opus-5-5');
			assert.notDeepStrictEqual(claudeThinkingParams(opus55, 'off', 64_000).thinking, { type: 'disabled' });
		});

		test('an unsupported effort level falls back to the nearest lower one', () => {
			const meta = claudeModelMeta('claude-opus-4-6');
			assert.deepStrictEqual(claudeThinkingParams(meta, 'xhigh', 64_000).output_config, { effort: 'high' });
		});

		test('the Models API limits win over the table', () => {
			const meta = claudeModelMeta('claude-opus-5', { max_input_tokens: 500_000, max_tokens: 32_000 });
			assert.strictEqual(meta.contextWindow, 500_000);
			assert.strictEqual(meta.maxOutputTokens, 32_000);
		});
	});

	suite('Anthropic request', () => {
		test('system and the conversation tail carry cache breakpoints', () => {
			const request = buildAnthropicRequest({
				modelId: 'claude-opus-5',
				meta: claudeModelMeta('claude-opus-5'),
				messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
				maxTokens: 64_000,
				effort: 'low',
				firstParty: true,
			});
			const system = request.body.system as { cache_control?: unknown }[];
			assert.ok(system.at(-1)?.cache_control);
			const messages = request.body.messages as { content: { cache_control?: unknown }[] }[];
			assert.ok(messages.at(-1)?.content.at(-1)?.cache_control);
			assert.ok(messages[0].content.at(-1)?.cache_control);
			assert.strictEqual(JSON.stringify(request.body).includes('budget_tokens'), false);
		});
	});

	suite('model switching', () => {
		const withThinking: INativeLoopMessage[] = [
			{ role: 'user', content: 'q' },
			{
				role: 'assistant', content: 'a', toolCalls: [{ id: 'call.1/x', name: 'read_file', args: { path: 'a' } }],
				parts: [
					{ type: 'reasoning', block: { provider: 'anthropic', model: 'claude-opus-5', text: 't', opaque: { type: 'thinking', thinking: 't', signature: 's' } } },
					{ type: 'text', text: 'a' },
					{ type: 'tool_call', callId: 'call.1/x' },
				],
			},
			{ role: 'tool', content: 'r', callId: 'call.1/x', name: 'read_file' },
		];

		test('thinking is replayed only to the model that produced it', () => {
			const same = toAnthropicMessages(nativeToModelMessages(withThinking), { model: 'claude-opus-5' });
			const other = toAnthropicMessages(nativeToModelMessages(withThinking), { model: 'claude-sonnet-5' });
			const types = (messages: typeof same) => (messages[1].content as { type: string }[]).map(block => block.type);
			assert.deepStrictEqual(types(same), ['thinking', 'text', 'tool_use']);
			assert.deepStrictEqual(types(other), ['text', 'tool_use']);
		});

		test('call ids are rewritten the same way on both sides of a pair', () => {
			const out = toAnthropicMessages(nativeToModelMessages(withThinking), { model: 'x' });
			const use = (out[1].content as { type: string; id?: string }[]).find(block => block.type === 'tool_use');
			const result = (out[2].content as { tool_use_id: string }[])[0];
			assert.strictEqual(use?.id, 'call_1_x');
			assert.strictEqual(result.tool_use_id, 'call_1_x');
			assert.ok(sanitizeCallId('x'.repeat(80), 'openai').length <= 40);
		});

		test('a call left without a result gets one, and an orphan result is dropped', () => {
			const repaired = nativeToModelMessages([
				{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 't', args: {} }] },
				{ role: 'user', content: 'next' },
				{ role: 'tool', content: 'stray', callId: 'zzz' },
			]);
			assert.deepStrictEqual(repaired.map(message => message.role), ['assistant', 'tool', 'user']);
			assert.ok(repaired[1].isError);
		});
	});

	suite('scheduling', () => {
		const tool = (name: string, group: IVoltTool['group'], parallelSafe: boolean, log: string[]): IVoltTool => ({
			name, group, kind: group === 'edit' ? 'edit' : 'read', description: name, schema: {}, parallelSafe, snippet: name,
			execute: async args => {
				await new Promise(resolve => setTimeout(resolve, name === 'read_file' ? 15 : 1));
				log.push(`${name}:${(args as { path?: string }).path}`);
				return { callId: '', name, kind: 'read', text: 'ok' };
			},
		});

		test('an edit then a read of the same file run in order; other files run in parallel', async () => {
			const log: string[] = [];
			const tools = new Map([['edit_file', tool('edit_file', 'edit', false, log)], ['read_file', tool('read_file', 'read', true, log)]]);
			const calls: IToolCall[] = [
				{ id: '1', name: 'edit_file', args: { path: 'a.ts' } },
				{ id: '2', name: 'read_file', args: { path: './a.ts' } },
				{ id: '3', name: 'read_file', args: { path: 'b.ts' } },
			];
			assert.deepStrictEqual(batchDependencies(calls, tools, '/w'), [[], [0], []]);
			await runToolBatch(tools, calls, { cwd: '/w', signal: new AbortController().signal });
			assert.ok(log.indexOf('edit_file:a.ts') < log.indexOf('read_file:./a.ts'));
		});

		test('path keys resolve relative, dotted, and absolute spellings to one key', () => {
			assert.strictEqual(pathKey('./src/../src/A.ts', '/w'), pathKey('/w/src/a.ts', undefined));
		});

		test('a timeout aborts the tool body', async () => {
			let aborted = false;
			const slow: IVoltTool = {
				name: 'slow', group: 'read', kind: 'read', description: '', schema: {}, parallelSafe: true, snippet: '', timeoutMs: 20,
				execute: (_args, ctx) => new Promise(resolve => ctx.signal.addEventListener('abort', () => {
					aborted = true;
					resolve({ callId: '', name: 'slow', kind: 'read', text: 'late' });
				})),
			};
			const [result] = await runToolBatch(new Map([['slow', slow]]), [{ id: '1', name: 'slow', args: {} }], { signal: new AbortController().signal });
			assert.ok(aborted);
			assert.ok(result.isError && /timed out/.test(result.text));
		});

		test('non-idempotent tools are not retried after a transient failure', async () => {
			let runs = 0;
			const shell: IVoltTool = {
				name: 'shell', group: 'shell', kind: 'execute', description: '', schema: {}, parallelSafe: false, snippet: '',
				execute: async () => {
					runs++;
					return { callId: '', name: 'shell', kind: 'execute', text: 'ECONNRESET', isError: true };
				},
			};
			await runToolBatch(new Map([['shell', shell]]), [{ id: '1', name: 'shell', args: {} }], { signal: new AbortController().signal });
			assert.strictEqual(runs, 1);
		});
	});

	suite('edits', () => {
		test('whitespace-only replacement, replace_all, and diff hunks', () => {
			const collapsed = applyExactEdits('a();\n\n\nb();\n', [{ oldString: '\n\n\n', newString: '\n' }]);
			assert.ok(!('error' in collapsed) && collapsed.text === 'a();\nb();\n');
			const all = applyExactEdits('x x x', [{ oldString: 'x', newString: 'y', replaceAll: true }]);
			assert.ok(!('error' in all) && all.text === 'y y y' && all.replacements === 3);
			const dollars = applyExactEdits('price', [{ oldString: 'price', newString: '$& $1' }]);
			assert.ok(!('error' in dollars) && dollars.text === '$& $1');
			const hunk = diffHunk('1\n2\n3\n4\n5\n', '1\n2\nthree\n4\n5\n');
			assert.ok(hunk.text.includes('-3') && hunk.text.includes('+three'));
			assert.strictEqual(hunk.added, 1);
		});

		test('a missed old_string shows the closest text with line numbers', () => {
			const result = applyExactEdits('function alpha() {\n\treturn 1;\n}\n', [{ oldString: 'function omega() {\n\treturn 2;', newString: 'x' }]);
			assert.ok('error' in result && /Closest text in the file/.test(result.error) && /lines 1-2/.test(result.error), JSON.stringify(result));
		});
	});

	suite('context', () => {
		test('compaction keeps a whole tail from a user turn and drops reasoning', () => {
			const messages: INativeLoopMessage[] = [];
			for (let i = 0; i < 20; i++) {
				messages.push({ role: 'user', content: `ask ${i} ${'x'.repeat(400)}` });
				messages.push({ role: 'assistant', content: `answer ${i}`, parts: [{ type: 'reasoning', block: { provider: 'anthropic', model: 'm', text: 't' } }, { type: 'text', text: `answer ${i}` }] });
			}
			const boundary = compactionBoundary(messages, 400);
			assert.ok(boundary > 0 && messages[boundary].role === 'user');
			const next = applyCompaction(messages, boundary, 'SUMMARY');
			assert.ok(next[0].content.includes('SUMMARY'));
			assert.ok(next.every(message => !message.parts?.some(part => part.type === 'reasoning')));
		});

		test('the ledger answers a repeated read with a pointer only while it is recent', () => {
			const ledger = new FileLedger();
			ledger.nextStep();
			ledger.recordRead('k', 'a.ts', 'v1', 1, 100);
			ledger.nextStep();
			assert.strictEqual(ledger.coveredRead('k', 'v1', 10, 50), 1);
			assert.strictEqual(ledger.coveredRead('k', 'v2', 10, 50), undefined);
			ledger.invalidateReferences();
			assert.strictEqual(ledger.coveredRead('k', 'v1', 10, 50), undefined);
		});

		test('usage merges input from one event with output from another', () => {
			const merged = mergeUsage(mergeUsage(undefined, { type: 'usage', input: 100, output: 1, cache: 5000 }), { type: 'usage', input: 0, output: 300 });
			assert.deepStrictEqual(merged, { input: 100, output: 300, cache: 5000 });
		});
	});

	suite('effort', () => {
		test('small talk is fast, broad work is deep, and "think hard" is max', () => {
			assert.strictEqual(chooseEffort('thanks!', { mode: 'agent' }), 'low');
			assert.strictEqual(chooseEffort('what does parseArgs do?', { mode: 'agent' }), 'low');
			assert.strictEqual(chooseEffort('refactor the auth flow across the entire codebase to use sessions', { mode: 'agent' }), 'high');
			assert.strictEqual(chooseEffort('think hard about why this race condition happens', { mode: 'agent' }), 'max');
			assert.strictEqual(chooseEffort('continue', { mode: 'agent', previous: 'high' }), 'high');
			assert.strictEqual(chooseEffort('hi', { mode: 'plan' }), 'high');
		});
	});

	suite('skills and rules', () => {
		test('frontmatter, glob rules, and the loadable index', () => {
			const parsed = parseFrontmatter('---\nname: deploy\ndescription: "How to deploy"\nglobs:\n  - src/**/*.ts\nalwaysApply: false\n---\nBody');
			assert.deepStrictEqual(parsed.fields, { name: 'deploy', description: 'How to deploy', globs: ['src/**/*.ts'], alwaysApply: false });
			const rule = ruleFromFile('---\nglobs: *.tsx\n---\nUse hooks.', 'react.mdc', 'x');
			assert.ok(rule && !rule.always);
			assert.ok(rulesForPath([rule!], 'src/app/Page.tsx')?.includes('Use hooks.'));
			assert.strictEqual(rulesForPath([rule!], 'src/app/page.css'), undefined);
			const plain = ruleFromFile('Always use tabs.', 'style.md', 'y');
			assert.ok(plain?.always);
			const index = instructionsIndex([{ name: 'deploy', description: 'How to deploy', body: 'b', source: 's' }], []);
			assert.ok(index?.includes('- deploy: How to deploy'));
		});
	});

	suite('MCP config', () => {
		test('reads Claude, Cursor, and VS Code config shapes', () => {
			const claude = parseMcpConfig('{"mcpServers":{"fs":{"command":"npx","args":["-y","server","${workspaceFolder}"]}}}', { workspaceFolder: '/w' });
			assert.deepStrictEqual(claude, [{ name: 'fs', kind: 'stdio', command: 'npx', args: ['-y', 'server', '/w'], env: {} }]);
			const vscode = parseMcpConfig('{\n // comment\n "servers": { "gh": { "type": "http", "url": "https://x/mcp", }, "off": { "command": "a", "disabled": true } } }', {});
			assert.deepStrictEqual(vscode, [{ name: 'gh', kind: 'http', url: 'https://x/mcp', headers: {} }]);
			assert.strictEqual(mcpToolName('my server', 'do.thing'), 'mcp__my_server__do_thing');
			assert.deepStrictEqual(mcpResultContent({ content: [{ type: 'text', text: 'hi' }], isError: true }), { text: 'hi', isError: true });
		});
	});

	suite('provider errors', () => {
		test('status, type, and retry-after decide retry and overflow', () => {
			const limited = providerErrorFromResponse(429, '{"error":{"type":"rate_limit_error","message":"slow down"}}', '3');
			assert.ok(limited.retryable && limited.retryAfterMs === 3000);
			const overflow = providerErrorFromResponse(400, '{"error":{"type":"invalid_request_error","message":"prompt is too long"}}');
			assert.ok(overflow.overflow && !overflow.retryable);
			assert.ok(!new ProviderError('400: bad', 400).retryable);
		});
	});
});
