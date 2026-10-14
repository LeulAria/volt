/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltUsageBucket, IVoltUsageLimitGroup, IVoltUsageMachineReport, IVoltUsageSnapshot } from '../../common/voltUsage.js';
import { claudeHomes, claudeKeychainService, claudeResetCredits, codexCreditsExpireAt, codexHomes, ResetCreditError } from '../../node/usageAccounts.js';
import { fetchMachineReport, IStoredMachine, mergeLimits, mergeUsage, parsePairingUrl, redeemOnMachine } from '../../node/usageMachines.js';
import { applyModelPrices, validModelPrice } from '../../node/usagePricing.js';
import { grokWindows, openCodeGoWindows } from '../../node/usageSubscriptions.js';

suite('Volt usage accounts and machines', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const NOW = Date.parse('2026-10-06T12:00:00Z');

	test('Claude banked resets count usable grants and pick the next one', () => {
		const block = {
			eligible: true,
			next_grant_id: 'g2',
			grants: [
				{ id: 'g1', resets_left: 1, usable_now: true, ends_at: '2026-10-22T16:00:00+00:00' },
				{ id: 'g2', resets_left: 2, usable_now: true, ends_at: '2026-10-10T16:00:00+00:00' },
				{ id: 'spent', resets_left: 0, usable_now: false, ends_at: '2026-10-22T16:00:00+00:00' },
				{ id: 'paused', resets_left: 3, usable_now: true, paused: true },
				{ id: 'expired', resets_left: 3, usable_now: true, ends_at: '2026-10-01T00:00:00Z' },
			],
		};
		assert.deepStrictEqual(claudeResetCredits(block, NOW), { count: 3, nextGrantId: 'g2', expiresAt: Date.parse('2026-10-10T16:00:00+00:00') });
		// The real answer for an account that already spent its launch reset.
		assert.deepStrictEqual(claudeResetCredits({ eligible: true, grants: [{ id: 'opus55-launch-promax-20260921', resets_left: 0, usable_now: false }], next_grant_id: null }, NOW), { count: 0 });
		assert.strictEqual(claudeResetCredits({ eligible: false, ineligible_reason: 'surface', grants: [] }, NOW), undefined);
	});

	test('Claude and Codex homes: defaults first, extras once, ~ expanded', () => {
		assert.deepStrictEqual(claudeHomes('/u', ['~/.claude-work', '/u/.claude', ' ~/.claude-work ']).map(h => [h.configDir, h.isDefault]), [['/u/.claude', true], ['/u/.claude-work', false]]);
		assert.strictEqual(claudeKeychainService({ configDir: '/u/.claude', isDefault: true }), 'Claude Code-credentials');
		assert.match(claudeKeychainService({ configDir: '/u/.claude-work', isDefault: false }), /^Claude Code-credentials-[0-9a-f]{8}$/);
		assert.deepStrictEqual(codexHomes('/u', {}, ['~/.codex-2', '/u/.codex']), ['/u/.codex', '/u/.codex-2']);
		assert.deepStrictEqual(codexHomes('/u', { CODEX_HOME: '/x' }, []), ['/x']);
	});

	test('Codex reset credits expire at the soonest available one', () => {
		assert.strictEqual(codexCreditsExpireAt({ availableCount: 2, credits: [{ status: 'available', expiresAt: 2000 }, { status: 'available', expiresAt: 1000 }, { status: 'used', expiresAt: 10 }] }), 1_000_000);
		assert.strictEqual(codexCreditsExpireAt({ availableCount: 0 }), undefined);
	});

	test('OpenCode Go and Grok windows', () => {
		const go = openCodeGoWindows({ usage: { rolling: { percent: 12, resetsAt: '2026-10-06T15:00:00Z' }, weekly: { percent: 40, resetsAt: '2026-10-10T00:00:00Z' }, monthly: { percent: 101, resetsAt: '2026-11-01T00:00:00Z' } } });
		assert.deepStrictEqual(go.map(w => [w.label, w.usedPercent]), [['Current session', 12], ['Weekly', 40], ['Monthly', 100]]);
		assert.deepStrictEqual(grokWindows({ config: { creditUsagePercent: 33.5, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: '2026-11-01T00:00:00Z' } } }).map(w => [w.label, w.usedPercent, w.resetsAt]), [['Monthly', 33.5, Date.parse('2026-11-01T00:00:00Z')]]);
		// No percentage yet means nothing metered, not no limit.
		assert.strictEqual(grokWindows({ config: {} })[0].usedPercent, 0);
	});

	test('pairing addresses', () => {
		assert.deepStrictEqual(parsePairingUrl('http://192.168.1.20:7791/#token=abc'), { url: 'http://192.168.1.20:7791', token: 'abc' });
		assert.deepStrictEqual(parsePairingUrl(' http://studio.local:7791/?token=x '), { url: 'http://studio.local:7791', token: 'x' });
		assert.strictEqual(parsePairingUrl('http://192.168.1.20:7791/'), undefined);
		assert.strictEqual(parsePairingUrl('file:///x#token=a'), undefined);
	});

	const group = (provider: IVoltUsageLimitGroup['provider'], account: string | undefined, used: number, checkedAt: number, extra: Partial<IVoltUsageLimitGroup> = {}): IVoltUsageLimitGroup =>
		({ provider, ...(account ? { account: { id: account } } : {}), windows: [{ id: 'session', label: 'Current session', usedPercent: used }], checkedAt, ...extra });

	test('limits: one reading per account, freshest with numbers, machines listed', () => {
		const merged = mergeLimits([
			{ holder: 'local', machineName: 'laptop', groups: [group('claude', 'claude:a', 10, 100), group('codex', 'codex:b', 50, 100)] },
			{ holder: 'm1', machineName: 'studio', groups: [group('claude', 'claude:a', 30, 200), group('claude', 'claude:c', 70, 200), group('codex', 'codex:b', 0, 300, { error: 'signed out', windows: [] })] },
		]);
		assert.deepStrictEqual(merged.groups.map(g => [g.account?.id, g.windows[0]?.usedPercent, g.machines]), [
			['claude:a', 30, ['laptop', 'studio']],
			['codex:b', 50, ['laptop', 'studio']],
			['claude:c', 70, ['studio']],
		]);
		assert.deepStrictEqual(merged.holders.get('claude|claude:a'), ['local', 'm1']);
		assert.deepStrictEqual(merged.holders.get('claude|claude:c'), ['m1']);
		// One machine: no machine names, and readings without an account stay apart.
		const alone = mergeLimits([{ holder: 'local', machineName: 'laptop', groups: [group('grok', undefined, 1, 1), group('grok', undefined, 2, 1)] }]);
		assert.deepStrictEqual(alone.groups.map(g => [g.windows[0].usedPercent, g.machines]), [[1, undefined], [2, undefined]]);
	});

	const bucket = (provider: IVoltUsageBucket['provider'], model: string, costUsd: number, extra: Partial<IVoltUsageBucket> = {}): IVoltUsageBucket => ({
		provider, model, hour: 0, uncached: 1_000_000, cached: 2_000_000, cacheWrite: 0, output: 500_000, costUsd, savingsUsd: 0, unpriced: false,
		inputCostUsd: 0, cacheReadCostUsd: 0, cacheWriteCostUsd: 0, outputCostUsd: 0, fastCostUsd: 0, ultrafastCostUsd: 0, speedPremiumUsd: 0, ...extra,
	});
	const snapshot = (buckets: IVoltUsageBucket[], sessions: number): IVoltUsageSnapshot => ({
		generatedAt: 1, sinceMs: 0, buckets,
		activity: buckets.map((b, i) => ({ provider: b.provider, hour: 0, sessions: [i] })),
		sessionCount: sessions, notes: [], pricingSource: 'test',
	});

	test('usage: machines add up, a shared Cursor account counts once, sessions stay unique', () => {
		const local = { machineName: 'laptop', usage: snapshot([bucket('claude', 'opus', 1), bucket('cursor', 'composer', 2)], 2), cursorAccount: 'cursor:u1' };
		const studio = { machineName: 'studio', usage: snapshot([bucket('codex', 'gpt', 3), bucket('cursor', 'composer', 2)], 2), cursorAccount: 'cursor:u1' };
		const merged = mergeUsage(local, [studio], []);
		assert.deepStrictEqual(merged.buckets.map(b => b.provider), ['claude', 'cursor', 'codex']);
		assert.deepStrictEqual(merged.activity.flatMap(a => a.sessions), [0, 1, 2]);
		assert.strictEqual(merged.sessionCount, 4);
		const other = mergeUsage(local, [{ ...studio, cursorAccount: 'cursor:u2' }], []);
		assert.strictEqual(other.buckets.filter(b => b.provider === 'cursor').length, 2);
	});

	test('custom prices replace automatic ones, cache rates default to input', () => {
		const [priced, untouched] = applyModelPrices([bucket('claude', 'my-model[1m]', 0, { unpriced: true }), bucket('claude', 'other', 9)], { 'My-Model': { input: 2, output: 10, cacheRead: 0.5 } });
		// 1M input at $2, 2M cache reads at $0.50, 0.5M output at $10.
		assert.deepStrictEqual([priced.costUsd, priced.inputCostUsd, priced.cacheReadCostUsd, priced.outputCostUsd, priced.savingsUsd, priced.unpriced], [8, 2, 1, 5, 3, false]);
		assert.strictEqual(untouched.costUsd, 9);
		const fast = applyModelPrices([bucket('claude', 'm', 10, { fastCostUsd: 5, speedPremiumUsd: 2 })], { m: { input: 1, output: 0 } })[0];
		// No cache rates: cache reads bill at the input rate. The fast share keeps its half.
		assert.deepStrictEqual([fast.costUsd, fast.fastCostUsd, fast.speedPremiumUsd], [3, 1.5, 0.6]);
		assert.deepStrictEqual(validModelPrice({ input: 1, output: 2, cacheRead: -1 }), { input: 1, output: 2 });
		assert.strictEqual(validModelPrice({ input: 1 }), undefined);
	});

	suite('over HTTP', () => {
		let server: Server;
		let machine: IStoredMachine;
		const report: IVoltUsageMachineReport = { machineName: 'studio', usage: snapshot([], 0), limits: [group('claude', 'claude:a', 5, 1)] };
		let redeemAnswer: { status: number; body: unknown } = { status: 200, body: { outcome: 'reset' } };

		setup(async () => {
			server = createServer((req, res) => {
				if (req.headers.authorization !== 'Bearer secret') {
					res.writeHead(401).end();
					return;
				}
				res.writeHead(req.method === 'POST' ? redeemAnswer.status : 200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(req.method === 'POST' ? redeemAnswer.body : report));
			});
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			machine = { id: 'm1', name: 'studio', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'secret' };
		});

		teardown(() => new Promise<void>(resolve => server.close(() => resolve())));

		test('reads a machine, and reports a refused token or no answer', async () => {
			const ok = await fetchMachineReport(machine, false);
			assert.strictEqual(ok.status.state, 'ok');
			assert.strictEqual(ok.report?.limits[0].account?.id, 'claude:a');
			assert.strictEqual((await fetchMachineReport({ ...machine, token: 'wrong' }, false)).status.state, 'unauthorized');
			assert.strictEqual((await fetchMachineReport({ ...machine, url: 'http://127.0.0.1:9' }, false, 2_000)).status.state, 'offline');
		});

		test('redeems on the machine that holds the login', async () => {
			assert.strictEqual(await redeemOnMachine(machine, 'claude', 'claude:a'), 'reset');
			redeemAnswer = { status: 500, body: { error: 'Claude resets are cooling down. Try again later.', settled: true } };
			await assert.rejects(redeemOnMachine(machine, 'claude', 'claude:a'), (error: unknown) => error instanceof ResetCreditError && error.settled && /cooling down/.test(error.message));
		});
	});
});
