/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { FileTracker } from '../../../common/harness/fileTracker.js';
import { PathLocks, runToolBatch } from '../../../common/harness/toolRuntime.js';
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

	test('a read after an edit in the same batch sees the edit', async () => {
		let content = 'before';
		let reads = 0;
		const tools = new Map<string, IVoltTool>([
			['read_file', stub('read_file', 'read', true, async () => {
				reads++;
				return { callId: '', name: 'read_file', kind: 'read', text: content };
			})],
			['edit_file', stub('edit_file', 'edit', false, async () => {
				content = 'after';
				return { callId: '', name: 'edit_file', kind: 'edit', text: 'edited' };
			})],
		]);
		const results = await runToolBatch(tools, [
			{ id: '1', name: 'read_file', args: { path: 'a.ts' } },
			{ id: '2', name: 'read_file', args: { path: 'a.ts' } },
			{ id: '3', name: 'edit_file', args: { path: 'a.ts' } },
			{ id: '4', name: 'read_file', args: { path: 'a.ts' } },
		], ctx);
		assert.deepStrictEqual(results.map(result => result.text), ['before', 'before', 'edited', 'after']);
		assert.strictEqual(reads, 2, 'identical reads before the edit still share one execution');
	});

	suite('file locks across batches', () => {
		const at: IToolContext = { ...ctx, cwd: '/work' };
		const logged = (log: string[], wait: (tag: string) => Promise<void>) => new Map<string, IVoltTool>([['edit_file', stub('edit_file', 'edit', false, async args => {
			const tag = (args as { tag: string }).tag;
			log.push(`start ${tag}`);
			await wait(tag);
			log.push(`end ${tag}`);
			return { callId: '', name: 'edit_file', kind: 'edit', text: 'ok' };
		})]]);

		test('an agent and its subagent never edit one file at the same time', async () => {
			const locks = new PathLocks();
			const log: string[] = [];
			const tools = logged(log, () => delay(15));
			await Promise.all([
				runToolBatch(tools, [{ id: '1', name: 'edit_file', args: { path: 'src/a.ts', tag: 'agent' } }], at, { locks }),
				runToolBatch(tools, [{ id: '2', name: 'edit_file', args: { path: './src/../src/a.ts', tag: 'subagent' } }], at, { locks }),
			]);
			assert.deepStrictEqual(log, ['start agent', 'end agent', 'start subagent', 'end subagent']);
			assert.strictEqual(locks.size, 0, 'nothing stays locked');
		});

		test('different files are still edited in parallel', async () => {
			const locks = new PathLocks();
			const log: string[] = [];
			const tools = logged(log, () => delay(15));
			await Promise.all([
				runToolBatch(tools, [{ id: '1', name: 'edit_file', args: { path: 'a.ts', tag: 'a' } }], at, { locks }),
				runToolBatch(tools, [{ id: '2', name: 'edit_file', args: { path: 'b.ts', tag: 'b' } }], at, { locks }),
			]);
			assert.deepStrictEqual(log.slice(0, 2), ['start a', 'start b']);
		});

		test('a timed-out edit that ignores its abort keeps the file locked until it really stops', async () => {
			const locks = new PathLocks();
			const log: string[] = [];
			let finish!: () => void;
			const stuck = new Promise<void>(resolve => finish = resolve);
			const tools = logged(log, tag => tag === 'stuck' ? stuck : Promise.resolve());
			tools.set('edit_file', { ...tools.get('edit_file')!, timeoutMs: 10 });
			const first = await runToolBatch(tools, [{ id: '1', name: 'edit_file', args: { path: 'a.ts', tag: 'stuck' } }], at, { locks });
			assert.ok(first[0].isError && /timed out/.test(first[0].text));
			const next = runToolBatch(tools, [{ id: '2', name: 'edit_file', args: { path: 'a.ts', tag: 'next' } }], at, { locks });
			await delay(30);
			assert.deepStrictEqual(log, ['start stuck'], 'the next edit waits for the stuck one');
			finish();
			await next;
			assert.deepStrictEqual(log, ['start stuck', 'end stuck', 'start next', 'end next']);
		});
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
