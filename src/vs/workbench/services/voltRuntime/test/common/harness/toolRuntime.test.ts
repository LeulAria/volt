/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { FileTracker } from '../../../common/harness/fileTracker.js';
import { runToolBatch } from '../../../common/harness/toolRuntime.js';
import { ToolPipeline } from '../../../common/harness/waterfall.js';
import { IToolContext, IVoltTool } from '../../../common/tools/tool.js';

suite('Volt tool runtime', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const ctx: IToolContext = { signal: new AbortController().signal };

	test('unknown tools fail in place', async () => {
		const results = await runToolBatch(new Map(), [{ id: '1', name: 'nope', args: {} }], ctx);
		assert.strictEqual(results[0].isError, true);
		assert.ok(/Unknown tool/.test(results[0].text));
	});

	test('denied tools do not execute', async () => {
		let ran = false;
		const tools = new Map<string, IVoltTool>([['shell', stub('shell', 'execute', false, async () => { ran = true; return { callId: '', name: 'shell', kind: 'execute', text: 'ran' }; })]]);
		const results = await runToolBatch(tools, [{ id: '1', name: 'shell', args: { command: 'rm -rf /' } }], ctx, async () => ({ allow: false, reason: 'blocked' }));
		assert.strictEqual(ran, false);
		assert.strictEqual(results[0].isError, true);
		assert.strictEqual(results[0].text, 'blocked');
	});

	test('waterfall pre-hook can deny and rewrite arguments', async () => {
		let seen: unknown;
		const tools = new Map<string, IVoltTool>([['read_file', stub('read_file', 'read', true, async args => {
			seen = args;
			return { callId: '', name: 'read_file', kind: 'read', text: 'ok' };
		})]]);
		const denied = await runToolBatch(tools, [{ id: '1', name: 'read_file', args: { path: 'a.ts' } }], ctx, {
			pipeline: new ToolPipeline().use({
				pre: () => ({ kind: 'deny', reason: 'nope' }),
			}),
		});
		assert.strictEqual(denied[0].isError, true);
		assert.strictEqual(denied[0].text, 'nope');
		assert.strictEqual(seen, undefined);

		const rewritten = await runToolBatch(tools, [{ id: '2', name: 'read_file', args: { path: 'a.ts' } }], ctx, {
			pipeline: new ToolPipeline().use({
				pre: () => ({ kind: 'allow', args: { path: 'b.ts' } }),
			}),
		});
		assert.deepStrictEqual(seen, { path: 'b.ts' });
		assert.strictEqual(rewritten[0].isError, undefined);
	});

	test('waterfall post-hook can attach additional context', async () => {
		const tools = new Map<string, IVoltTool>([['read_file', stub('read_file', 'read', true, async () => ({ callId: '', name: 'read_file', kind: 'read', text: 'src' }))]]);
		const results = await runToolBatch(tools, [{ id: '1', name: 'read_file', args: { path: 'a.ts' } }], ctx, {
			pipeline: new ToolPipeline().use({
				post: () => ({ kind: 'enrich', contexts: ['also read the tests'] }),
			}),
		});
		assert.deepStrictEqual(results[0].contexts, ['also read the tests']);
	});

	test('transient failures are retried once by the around waterfall', async () => {
		let attempts = 0;
		const tools = new Map<string, IVoltTool>([['web_fetch', stub('web_fetch', 'fetch', true, async () => {
			attempts++;
			if (attempts === 1) {
				return { callId: '', name: 'web_fetch', kind: 'fetch', text: 'ETIMEDOUT after 30000ms', isError: true };
			}
			return { callId: '', name: 'web_fetch', kind: 'fetch', text: 'ok' };
		})]]);
		const results = await runToolBatch(tools, [{ id: '1', name: 'web_fetch', args: { url: 'https://example.com' } }], ctx);
		assert.strictEqual(attempts, 2);
		assert.strictEqual(results[0].text, 'ok');
	});

	test('stale-edit hook denies a write after an external change', async () => {
		const tracker = new FileTracker();
		tracker.touch('a.ts', 'external');
		let ran = false;
		const tools = new Map<string, IVoltTool>([['edit_file', stub('edit_file', 'edit', false, async () => {
			ran = true;
			return { callId: '', name: 'edit_file', kind: 'edit', text: 'wrote' };
		})]]);
		const results = await runToolBatch(tools, [{ id: '1', name: 'edit_file', args: { path: 'a.ts' } }], ctx, { fileTracker: tracker });
		assert.strictEqual(ran, false);
		assert.strictEqual(results[0].isError, true);
		assert.ok(/changed on disk/.test(results[0].text));
	});

	test('keeps call order when mixing parallel and serial tools', async () => {
		const order: string[] = [];
		const tools = new Map<string, IVoltTool>([
			['read_file', stub('read_file', 'read', true, async () => {
				await delay(20);
				order.push('read');
				return { callId: '', name: 'read_file', kind: 'read', text: 'a' };
			})],
			['edit_file', stub('edit_file', 'edit', false, async () => {
				order.push('edit');
				return { callId: '', name: 'edit_file', kind: 'edit', text: 'b' };
			})],
		]);
		const results = await runToolBatch(tools, [
			{ id: '1', name: 'read_file', args: {} },
			{ id: '2', name: 'edit_file', args: {} },
		], ctx);
		assert.deepStrictEqual(results.map(result => result.name), ['read_file', 'edit_file']);
		assert.ok(order.includes('read') && order.includes('edit'));
	});
});

function stub(name: string, kind: IVoltTool['kind'], parallelSafe: boolean, execute: IVoltTool['execute']): IVoltTool {
	return {
		name,
		group: kind === 'edit' ? 'edit' : kind === 'execute' ? 'shell' : 'read',
		kind,
		description: name,
		schema: {},
		parallelSafe,
		snippet: name,
		execute,
	};
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
