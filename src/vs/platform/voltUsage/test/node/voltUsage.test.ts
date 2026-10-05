/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { claudeWindows, codexGroup, cursorRateModel, cursorWindows } from '../../node/usageAccounts.js';
import { parseRateTable, rateKey, UsagePricing } from '../../node/usagePricing.js';
import { billOncePerResponse, parseClaudeLine, parseTranscript } from '../../node/usageTranscripts.js';

suite('Volt usage', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const claudeLine = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
		type: 'assistant',
		timestamp: '2026-10-03T09:18:34.961Z',
		sessionId: 's1',
		requestId: `req_${id}`,
		message: { id: `msg_${id}`, model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50, ...extra } },
	});

	test('Claude lines carry a dedupe key and split input three ways', () => {
		const record = parseClaudeLine(claudeLine('a'))!;
		assert.deepStrictEqual([record.uncached, record.cacheWrite, record.cached, record.output, record.dedupeKey], [2, 100, 1000, 50, 'msg_a:req_a']);
		assert.strictEqual(parseClaudeLine(claudeLine('b', { speed: 'fast' }))!.speed, 'fast');
		assert.strictEqual(parseClaudeLine('{"type":"user"}'), undefined);
	});

	test('a Claude response written as several lines is billed once, at its final output', () => {
		// Claude Code's /stats adds every line (here 3 x 1000 cache reads); billing counts the response once.
		const lines = [
			claudeLine('a', { output_tokens: 8 }),
			claudeLine('a', { output_tokens: 8 }),
			claudeLine('a', { output_tokens: 353 }),
			claudeLine('b', { output_tokens: 12 }),
		].map(line => parseClaudeLine(line)!);
		const billed = billOncePerResponse(lines);
		assert.deepStrictEqual(billed.map(r => [r.dedupeKey, r.cached, r.output]), [['msg_a:req_a', 1000, 353], ['msg_b:req_b', 1000, 12]]);
	});

	test('Codex rollouts use deltas, drop repeats, and keep the newest rate limits', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'volt-usage-'));
		try {
			const token = (ts: string, input: number, used: number) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, cached_input_tokens: 40, output_tokens: 5 } }, rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 4102444800 } } } });
			const lines = [
				JSON.stringify({ timestamp: '2026-10-03T09:00:00.000Z', type: 'session_meta', payload: { id: 'c1' } }),
				JSON.stringify({ timestamp: '2026-10-03T09:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-6-astra' } }),
				JSON.stringify({ timestamp: '2026-10-03T09:00:02.000Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } } }),
				token('2026-10-03T09:00:05.000Z', 100, 1),
				token('2026-10-03T09:00:06.000Z', 100, 1),
				token('2026-10-03T09:01:00.000Z', 300, 3),
			];
			const path = join(dir, 'rollout.jsonl');
			await writeFile(path, lines.join('\n'));
			const parsed = await parseTranscript({ path, provider: 'codex', mtimeMs: 0, size: 0 });
			assert.deepStrictEqual(parsed.records.map(r => [r.model, r.uncached, r.cached, r.output, r.speed]), [['gpt-6-astra', 60, 40, 5, 'fast'], ['gpt-6-astra', 260, 40, 5, 'fast']]);
			assert.strictEqual(codexGroup(parsed.rateLimits!.raw, 0).windows[0].usedPercent, 3);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('prices come from the table, fast mode multiplies, bare names stay unpriced', () => {
		const table = parseRateTable({
			'claude-opus-5-5': { input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 5e-6, provider_specific_entry: { fast: 2 } },
			'azure/gpt-6-sol': { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 },
			'half-priced': { input_cost_per_token: 1e-6 },
		});
		assert.ok(table.has('gpt-6-sol'));
		assert.ok(!table.has('half-priced'));
		assert.strictEqual(rateKey('claude-fable-5-1[1m]'), 'claude-fable-5-1');
		const pricing = new UsagePricing(join(tmpdir(), 'unused.json'));
		const base = { provider: 'claude' as const, timestampMs: 0, model: 'claude-opus-5-5', sessionId: '', uncached: 1_000_000, cached: 0, cacheWrite: 0, output: 0, speed: 'standard' as const };
		assert.strictEqual(pricing.price(base).cost, 4);
		const fast = pricing.price({ ...base, speed: 'fast' });
		assert.deepStrictEqual([fast.cost, fast.premium, fast.categories?.input], [8, 4, 8]);
		assert.strictEqual(pricing.price({ ...base, model: 'opus' }).unpriced, true);
		// A reported cost keeps its total and is split like the list rates (here all input).
		const reported = pricing.price({ ...base, uncached: 500_000, output: 100_000, reportedCostUsd: 3 });
		assert.strictEqual(reported.cost, 3);
		// List: $2.00 input + $2.00 output; Cursor charged $3, so each part scales by 0.75.
		assert.deepStrictEqual([reported.categories?.input, reported.categories?.output], [1.5, 1.5]);
	});

	test('Claude limits read the limits list, scoped weeklies included', () => {
		const windows = claudeWindows({
			limits: [
				{ kind: 'session', group: 'session', percent: 75, resets_at: '2026-10-04T00:09:59Z' },
				{ kind: 'weekly_all', group: 'weekly', percent: 72, resets_at: '2026-10-07T13:00:00Z' },
				{ kind: 'weekly_scoped', group: 'weekly', percent: 11, scope: { model: { display_name: 'Fable' } } },
			],
		});
		assert.deepStrictEqual(windows.map(w => [w.label, w.scope, w.usedPercent]), [['Current session', undefined, 75], ['Current week', 'All models', 72], ['Current week', 'Fable', 11]]);
		assert.deepStrictEqual(claudeWindows({ five_hour: { utilization: 10 } }).map(w => w.label), ['Current session']);
	});

	test('Cursor windows and rate models', () => {
		assert.deepStrictEqual(cursorWindows({ billingCycleStart: '1000', billingCycleEnd: '2000', planUsage: { totalPercentUsed: 51.7, autoPercentUsed: 47.3, apiPercentUsed: 100 } }).map(w => [w.label, w.usedPercent, w.resetsAt]), [['Cursor Models', 47.3, 2000], ['Other Models', 100, 2000]]);
		assert.strictEqual(cursorRateModel('cursor-grok-4.6-high-fast'), 'xai/grok-4.6');
		assert.strictEqual(cursorRateModel('claude-fable-5-1-thinking-high'), 'claude-fable-5-1');
	});
});
