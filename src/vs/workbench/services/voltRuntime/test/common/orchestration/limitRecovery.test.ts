/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	epochMs, formatCountdown, isLimitStopText, LIMIT_MAX_PROBES, LIMIT_PROBE_BACKOFF_MS, LIMIT_RESET_GRACE_MS, limitAutoResumes, limitBadgeLabel, limitBannerView, limitDueAt,
	limitFromError, limitFromNotice, limitFromReply, mergeLimitSignals, nextBannerTick, parseLimitReset,
} from '../../../common/orchestration/limitRecovery.js';
import { noticesFromAcpUpdate } from '../../../common/acpNotices.js';

/** 2026-10-08 12:00:00 UTC. */
const NOON_UTC = Date.UTC(2026, 9, 8, 12, 0, 0);

suite('Volt limit recovery: detection and reset times', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('provider stop sentences are limits; warnings, overload and prose are not', () => {
		for (const text of [
			'You\'ve hit your limit · resets 3pm (Asia/Dubai)',
			'You’ve hit your session limit · resets 12:40am',
			'You\'ve reached your weekly limit',
			'You\'ve hit your usage limit. Upgrade to Pro or try again in 4 days 21 hours 7 minutes.',
			'Claude AI usage limit reached|1760000000',
			'429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit',
			'Quota exceeded for quota metric \'Generate Content API requests\'. RESOURCE_EXHAUSTED',
			'You\'re out of extra usage',
			'The Claude account has no available quota.',
			'Claude is temporarily rate limited.',
		]) {
			assert.ok(isLimitStopText(text), text);
		}
		for (const text of [
			'You\'ve used 90% of your weekly limit · resets Oct 9',
			'You\'re close to your session limit',
			'Usage limit warning · resets 4pm',
			'The model provider is temporarily overloaded',
			'Error: ENOENT: no such file',
			undefined,
		]) {
			assert.ok(!isLimitStopText(text), String(text));
		}
	});

	test('reset times: relative, clock with zone, dated, epoch suffix, ISO; stale ones are dropped', () => {
		assert.strictEqual(parseLimitReset('try again in 2h 30m', NOON_UTC), NOON_UTC + 2.5 * 3_600_000);
		assert.strictEqual(parseLimitReset('or try again in 4 days 21 hours 7 minutes.', NOON_UTC), NOON_UTC + 4 * 86_400_000 + 21 * 3_600_000 + 7 * 60_000);
		assert.strictEqual(parseLimitReset('Please retry in 23.5s', NOON_UTC), NOON_UTC + 23_500);
		// 3pm in Dubai (UTC+4) is 11:00 UTC: already past at noon UTC, so tomorrow's.
		assert.strictEqual(parseLimitReset('You\'ve hit your limit · resets 3pm (Asia/Dubai)', NOON_UTC), Date.UTC(2026, 9, 9, 11, 0));
		assert.strictEqual(parseLimitReset('resets 3:40pm (UTC)', NOON_UTC), Date.UTC(2026, 9, 8, 15, 40));
		assert.strictEqual(parseLimitReset('try again at 15:05', NOON_UTC, 'UTC'), Date.UTC(2026, 9, 8, 15, 5));
		assert.strictEqual(parseLimitReset('resets Oct 10, 9am', NOON_UTC, 'UTC'), Date.UTC(2026, 9, 10, 9, 0));
		assert.strictEqual(parseLimitReset('Claude AI usage limit reached|1792000000', NOON_UTC), 1_792_000_000_000);
		assert.strictEqual(parseLimitReset('Claude AI usage limit reached|1700000000', NOON_UTC), undefined, 'an epoch in the past is no reset');
		assert.strictEqual(parseLimitReset('resets at 2026-10-08T15:40:00Z', NOON_UTC), Date.UTC(2026, 9, 8, 15, 40));
		assert.strictEqual(parseLimitReset('resets 5', NOON_UTC), undefined, 'a bare number is not a time');
		assert.strictEqual(parseLimitReset('You\'ve hit your limit', NOON_UTC), undefined);
		assert.strictEqual(epochMs(1_791_000_000), 1_791_000_000_000);
		assert.strictEqual(epochMs('1791000000000'), 1_791_000_000_000);
		assert.strictEqual(epochMs('soon'), undefined);
	});

	test('errors, notices and limit-only replies become signals; the structured reset wins over the sentence', () => {
		assert.deepStrictEqual(limitFromError('Internal error', NOON_UTC), undefined);
		assert.deepStrictEqual(limitFromError('Claude AI usage limit reached|1792000000', NOON_UTC), { message: 'Claude AI usage limit reached', resetAt: 1_792_000_000_000 });
		const reset = NOON_UTC + 120_000;
		assert.deepStrictEqual(limitFromNotice({ severity: 'error', title: 'Usage limit reached · resets 12:02 PM', resetAt: reset }, NOON_UTC), { message: 'Usage limit reached · resets 12:02 PM', resetAt: reset });
		assert.strictEqual(limitFromNotice({ severity: 'warning', title: 'Usage limit reached' }, NOON_UTC), undefined, 'only an error notice stops the run');
		assert.deepStrictEqual(limitFromReply('You\'ve hit your limit · resets 3:40pm (UTC)', NOON_UTC), { message: 'You\'ve hit your limit · resets 3:40pm (UTC)', resetAt: Date.UTC(2026, 9, 8, 15, 40) });
		assert.strictEqual(limitFromReply('Rate limits matter. You\'ve hit your stride, so here is the plan...', NOON_UTC), undefined);
		assert.strictEqual(limitFromReply(`You've hit your limit. ${'x'.repeat(500)}`, NOON_UTC), undefined, 'a long reply is prose');
		const merged = mergeLimitSignals({ message: 'Usage limit reached', resetAt: reset }, { message: 'You\'ve hit your limit · resets 12:02pm' });
		assert.deepStrictEqual(merged, { message: 'You\'ve hit your limit · resets 12:02pm', resetAt: reset });
	});

	test('Claude\'s rate-limit payload carries the exact reset into the notice', () => {
		const notices = noticesFromAcpUpdate({ sessionUpdate: 'usage_update', _meta: { '_claude/rateLimit': { status: 'rejected', resetsAt: 1_791_000_000 } } }, { timeZone: 'UTC', locale: 'en-US' });
		assert.strictEqual(notices.length, 1);
		assert.strictEqual(notices[0].severity, 'error');
		assert.strictEqual(notices[0].resetAt, 1_791_000_000_000);
		const warning = noticesFromAcpUpdate({ sessionUpdate: 'usage_update', _meta: { '_claude/rateLimit': { status: 'allowed_warning', resetsAt: 1_791_000_000 } } });
		assert.strictEqual(warning[0].resetAt, undefined, 'a warning does not park anything');
	});
});

suite('Volt limit recovery: scheduling and banner', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a known reset resumes after a grace; an unknown one probes with a growing back-off; slots hold it back', () => {
		assert.strictEqual(limitDueAt({ at: NOON_UTC, resetAt: NOON_UTC + 60_000, probes: 0 }), NOON_UTC + 60_000 + LIMIT_RESET_GRACE_MS);
		assert.strictEqual(limitDueAt({ at: NOON_UTC, probes: 0 }), NOON_UTC + LIMIT_PROBE_BACKOFF_MS[0]);
		assert.strictEqual(limitDueAt({ at: NOON_UTC, probes: 3 }), NOON_UTC + LIMIT_PROBE_BACKOFF_MS[3]);
		assert.strictEqual(limitDueAt({ at: NOON_UTC, probes: 99 }), NOON_UTC + LIMIT_PROBE_BACKOFF_MS.at(-1)!, 'the back-off is capped');
		assert.strictEqual(limitDueAt({ at: NOON_UTC, resetAt: NOON_UTC, probes: 0, notBefore: NOON_UTC + 90_000 }), NOON_UTC + 90_000);
	});

	test('the setting is the default; a chat\'s own choice wins; probing stops after many tries', () => {
		assert.strictEqual(limitAutoResumes({ at: 0, probes: 0 }, true), true);
		assert.strictEqual(limitAutoResumes({ at: 0, probes: 0 }, false), false);
		assert.strictEqual(limitAutoResumes({ at: 0, probes: 0, auto: false }, true), false);
		assert.strictEqual(limitAutoResumes({ at: 0, probes: 0, auto: true }, false), true);
		assert.strictEqual(limitAutoResumes({ at: 0, probes: LIMIT_MAX_PROBES, auto: true }, true), false);
	});

	test('the banner reads like the provider: resumes at, countdown, checking again, auto-resume off', () => {
		const now = NOON_UTC;
		const resetAt = now + 72 * 60_000 - LIMIT_RESET_GRACE_MS;
		const auto = limitBannerView({ at: now, resetAt, probes: 0 }, now, true, 'en-US');
		assert.strictEqual(auto.title, 'Usage limit reached');
		assert.match(auto.detail, /^resumes at .+ \(in 1h 12m\)$/);
		assert.strictEqual(auto.toggleLabel, 'Cancel');
		const off = limitBannerView({ at: now, resetAt, probes: 0, auto: false }, now, false, 'en-US');
		assert.match(off.detail, /^resets at .+ · auto-resume off$/);
		assert.strictEqual(off.toggleLabel, 'Resume at reset');
		const probing = limitBannerView({ at: now, probes: 1 }, now, true, 'en-US');
		assert.match(probing.detail, /^checking again at .+ \(in 2m\)$/);
		assert.strictEqual(limitBannerView({ at: now - 600_000, resetAt: now - 300_000, probes: 0 }, now, true).detail, 'resuming now…');
		assert.strictEqual(limitBadgeLabel({ at: now, probes: 0 }, now, true), 'Resumes in 1m');
		assert.strictEqual(limitBadgeLabel({ at: now, probes: 0 }, now, false), 'Limit reached');
	});

	test('countdowns and their ticks', () => {
		assert.strictEqual(formatCountdown(30_000), 'under a minute');
		assert.strictEqual(formatCountdown(45 * 60_000), '45m');
		assert.strictEqual(formatCountdown(72 * 60_000), '1h 12m');
		assert.strictEqual(formatCountdown(51 * 3_600_000), '2d 3h');
		assert.strictEqual(nextBannerTick(NOON_UTC + 90_000, NOON_UTC), NOON_UTC + 30_000 + 50);
		assert.strictEqual(nextBannerTick(NOON_UTC + 10_000, NOON_UTC), NOON_UTC + 10_000 + 50);
		assert.strictEqual(nextBannerTick(NOON_UTC, NOON_UTC), undefined);
	});
});
