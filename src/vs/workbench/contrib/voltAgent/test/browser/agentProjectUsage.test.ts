/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IAgentHistoryService, IAgentSessionMeta, IAgentSessionTranscript, IAgentSessionTruncation, IAgentSessionTurn } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { AgentProjectUsageService, IProjectUsageRecord, mergeProjectUsage, parseProjectUsage, projectUsageRoot, projectUsageTotals, sessionUsageRoot, tallyTurns } from '../../browser/usage/agentProjectUsage.js';

const OPUS = { input: 4e-6, output: 2e-5, cacheRead: 2e-7, cacheWrite: 5e-6 };
const rates = (id: string) => id === 'claude-opus-5' ? OPUS : undefined;
const MODEL = { ref: 'claude:opus', id: 'claude-opus-5', label: 'Opus 5' };

function turn(id: string, reply?: Record<string, unknown>): IAgentSessionTurn {
	return {
		id,
		user: { type: 'user', turn: id, at: 1, text: `prompt ${id}`, message: { kind: 'user', id, text: `prompt ${id}` } },
		...(reply ? { assistant: { type: 'agent', turn: id, at: 2, final: true, status: 'done', text: '', message: { kind: 'agent', id, segments: [], ...reply } } } : {}),
	};
}

function record(root: string, live: Partial<IProjectUsageRecord['live']>, extra?: Partial<IProjectUsageRecord>): IProjectUsageRecord {
	return {
		root,
		createdAt: 100,
		countedAt: 1,
		live: { turns: 0, tokens: 0, costUsd: 0, unpricedTurns: 0, activeMs: 0, ...live },
		writtenAt: 1,
		...extra,
	};
}

suite('Agent project usage', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('tallies tokens, cost and agent time like the Session Usage panel', () => {
		const tally = tallyTurns([
			turn('t1', { model: MODEL, spend: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }, durationMs: 4000 }),
			turn('t2', { model: MODEL, spend: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.5, startedAt: 10, endedAt: 2010 }),
			turn('t3', { model: { ref: 'other:x', id: 'x', label: 'X' }, spend: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } }),
			turn('t4'),
		], { rates });

		assert.strictEqual(tally.turns, 4);
		assert.strictEqual(tally.tokens, 1720);
		assert.ok(Math.abs(tally.costUsd - (1000 * 4e-6 + 500 * 2e-5 + 0.5)) < 1e-12);
		assert.strictEqual(tally.unpricedTurns, 1, 'a model with no list price and no reported cost');
		assert.strictEqual(tally.activeMs, 6000, 'durationMs, else the run\'s start and end');
	});

	test('files chats under the project folder, however the path was written', () => {
		const root = projectUsageRoot(URI.file('/work/app'));
		assert.strictEqual(sessionUsageRoot({ workspaceFolder: '/work/app/' }), root);
		assert.strictEqual(sessionUsageRoot({ workspaceFolder: '/work/app' }), root);
		assert.strictEqual(sessionUsageRoot({ workspaceFolder: undefined }), undefined);
	});

	test('totals count dropped turns and subagents, and chats only once each', () => {
		const root = 'file:///work/app';
		const records = new Map<string, IProjectUsageRecord>([
			['a', record(root, { turns: 2, tokens: 100, costUsd: 1, activeMs: 1000 }, { retired: { turns: 1, tokens: 50, costUsd: 0.25, unpricedTurns: 0, activeMs: 500 }, createdAt: 50 })],
			['gone', record(root, { turns: 1, tokens: 10, costUsd: 0.125, activeMs: 10 })],
			['sub', record(root, { turns: 3, tokens: 30, costUsd: 0.5, activeMs: 30 }, { subagent: true, createdAt: 10 })],
			['empty', record(root, {})],
			['other', record('file:///work/other', { turns: 5, tokens: 999 })],
		]);
		const totals = projectUsageTotals(records, root, id => id !== 'gone');

		assert.deepStrictEqual(totals, { turns: 7, tokens: 190, costUsd: 1.875, unpricedTurns: 0, activeMs: 1540, chats: 2, deletedChats: 1, since: 50 });
	});

	test('storage round trip keeps valid records, and the newer copy of a chat wins', () => {
		const ours = new Map([['a', record('r', { turns: 1 }, { writtenAt: 5 })], ['b', record('r', { turns: 1 }, { writtenAt: 5 })]]);
		const stored = parseProjectUsage(JSON.stringify({ version: 1, sessions: { a: record('r', { turns: 9 }, { writtenAt: 9 }), b: record('r', { turns: 2 }, { writtenAt: 1 }), bad: { root: 'r' } } }));

		assert.deepStrictEqual([...stored.keys()], ['a', 'b']);
		assert.strictEqual(mergeProjectUsage(ours, stored), true);
		assert.strictEqual(ours.get('a')!.live.turns, 9);
		assert.strictEqual(ours.get('b')!.live.turns, 1);
		assert.strictEqual(mergeProjectUsage(ours, stored), false);
		assert.strictEqual(parseProjectUsage('not json').size, 0);
	});

	suite('service', () => {

		const ROOT = URI.file('/work/app');

		function setup(store: DisposableStore) {
			const metas = new Map<string, IAgentSessionMeta>();
			const transcripts = new Map<string, IAgentSessionTranscript>();
			const onDidChange = store.add(new Emitter<void>());
			const onDidTruncate = store.add(new Emitter<IAgentSessionTruncation>());
			const history = {
				whenReady: Promise.resolve(),
				onDidChange: onDidChange.event,
				onDidTruncate: onDidTruncate.event,
				list: () => [...metas.values()],
				get: (id: string) => metas.get(id),
				readTranscript: async (id: string) => transcripts.get(id),
			} as unknown as IAgentHistoryService;
			const put = (id: string, turns: IAgentSessionTurn[], extra?: Partial<IAgentSessionMeta> & Pick<IAgentSessionTranscript, 'forkOf'>) => {
				const updatedAt = (metas.get(id)?.updatedAt ?? 0) + 1;
				metas.set(id, { id, title: id, createdAt: 1, updatedAt, workspaceId: 'w', workspaceLabel: 'app', workspaceFolder: ROOT.fsPath, turnCount: turns.length, preview: '', status: 'done', ...extra });
				transcripts.set(id, { header: { type: 'header', version: 1, id, createdAt: 1, workspace: { id: 'w', label: 'app', folders: [ROOT.fsPath] } }, turns, ...(extra?.forkOf ? { forkOf: extra.forkOf } : {}) });
			};
			const storage = store.add(new InMemoryStorageService());
			const runtime = { listCatalog: () => [] } as unknown as IAgentRuntimeService;
			const instantiation = { invokeFunction: (fn: (accessor: { getIfExists(): undefined }) => unknown) => fn({ getIfExists: () => undefined }) } as unknown as IInstantiationService;
			const service = store.add(new AgentProjectUsageService(history, storage, runtime, instantiation, new NullLogService()));
			return { service, metas, put, onDidTruncate, storage };
		}

		const spent = (tokens: number, costUsd: number) => ({ model: MODEL, spend: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd, durationMs: 1000 });

		test('a deleted chat stays in its project', async () => {
			const store = disposables.add(new DisposableStore());
			const { service, metas, put } = setup(store);
			put('a', [turn('1', spent(100, 1)), turn('2', spent(50, 0.5))]);
			put('b', [turn('3', spent(10, 0.1))]);
			await service.refresh();

			metas.delete('b');
			await service.refresh();
			const totals = service.totals(ROOT);

			assert.strictEqual(totals.chats, 2);
			assert.strictEqual(totals.deletedChats, 1);
			assert.strictEqual(totals.tokens, 160);
			assert.ok(Math.abs(totals.costUsd - 1.6) < 1e-12);
			assert.strictEqual(totals.activeMs, 3000);
		});

		test('dropped turns stay counted after edit and resend', async () => {
			const store = disposables.add(new DisposableStore());
			const { service, put, onDidTruncate } = setup(store);
			const first = turn('1', spent(100, 1));
			const second = turn('2', spent(50, 0.5));
			put('a', [first, second]);
			await service.refresh();

			put('a', [first]);
			onDidTruncate.fire({ sessionId: 'a', index: 1, turns: [second] });
			put('a', [first, turn('3', spent(20, 0.2))]);
			await service.refresh();

			const totals = service.totals(ROOT);
			assert.strictEqual(totals.tokens, 170);
			assert.strictEqual(totals.turns, 3);
		});

		test('a fork does not count the turns it copied', async () => {
			const store = disposables.add(new DisposableStore());
			const { service, put } = setup(store);
			const copied = turn('1', spent(100, 1));
			put('source', [copied]);
			put('fork', [copied, turn('2', spent(5, 0.05))], { forkOf: { id: 'source', title: 'source', turns: 1 } });
			await service.refresh();

			assert.strictEqual(service.totals(ROOT).tokens, 105);
		});

		test('totals survive a restart', async () => {
			const store = disposables.add(new DisposableStore());
			const { service, put, storage } = setup(store);
			put('a', [turn('1', spent(100, 1))]);
			await service.refresh();

			const reloaded = parseProjectUsage(storage.get('volt.projects.usage.v1', StorageScope.APPLICATION));
			assert.strictEqual(projectUsageTotals(reloaded, projectUsageRoot(ROOT), () => false).tokens, 100);
		});
	});
});
