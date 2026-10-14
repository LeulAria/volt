/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { noticesFromAcpUpdate } from '../../../common/acpNotices.js';
import { formatCountdown, isUsageLimitStop, limitRecoveryView, nextLimitViewChange, parseUsageLimitReset, readResetTime } from '../../../common/orchestration/limitRecovery.js';
import { extractRoot, isRootLive, parseRootSnapshot } from '../../../common/orchestration/orchestratorCodec.js';
import { OrchSim, prompt } from './orchestratorSim.js';

const HOUR = 3_600_000;

suite('Volt usage-limit recovery: reset times', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// Mon Oct 5 2026, 17:00 UTC = 21:00 in Dubai.
	const now = Date.UTC(2026, 9, 5, 17, 0);

	test('reads Claude\'s sentence, in the time zone it names', () => {
		assert.strictEqual(parseUsageLimitReset('You\'ve hit your session limit · resets 12:40am (Asia/Dubai)', now), Date.UTC(2026, 9, 5, 20, 40));
		assert.strictEqual(parseUsageLimitReset('You\'ve hit your monthly spend limit · your session limit resets 3:20am (Asia/Dubai)', now), Date.UTC(2026, 9, 5, 23, 20));
		// Later today in Dubai stays today.
		assert.strictEqual(parseUsageLimitReset('resets 11pm (Asia/Dubai)', now), Date.UTC(2026, 9, 5, 19, 0));
	});

	test('a time that already passed today means tomorrow; a date means that day', () => {
		assert.strictEqual(parseUsageLimitReset('Usage limit reached · resets 3:20 AM', now, 'UTC'), Date.UTC(2026, 9, 6, 3, 20));
		assert.strictEqual(parseUsageLimitReset('resets at 15:00', now, 'UTC'), Date.UTC(2026, 9, 6, 15, 0));
		assert.strictEqual(parseUsageLimitReset('Limit reached. Resets Oct 7, 3pm (Asia/Dubai)', now), Date.UTC(2026, 9, 7, 11, 0));
		assert.strictEqual(parseUsageLimitReset('resets Jan 2 at 9:00am (UTC)', now), Date.UTC(2027, 0, 2, 9, 0));
	});

	test('honors daylight saving in the named zone', () => {
		// Sat Mar 7 2026 noon UTC; New York springs forward at 2am on Mar 8.
		const before = Date.UTC(2026, 2, 7, 12, 0);
		assert.strictEqual(parseUsageLimitReset('resets 1:30am (America/New_York)', before), Date.UTC(2026, 2, 8, 6, 30));
		assert.strictEqual(parseUsageLimitReset('resets 9am (America/New_York)', before + 24 * HOUR), Date.UTC(2026, 2, 8, 13, 0));
	});

	test('relative waits, and text that is not a reset time', () => {
		assert.strictEqual(parseUsageLimitReset('Rate limited. Try again in 2h 30m.', now), now + 2.5 * HOUR);
		assert.strictEqual(parseUsageLimitReset('Usage limit reached. Resets in 45 minutes', now), now + 45 * 60_000);
		assert.strictEqual(parseUsageLimitReset('You\'ve hit your usage limit', now), undefined);
		assert.strictEqual(parseUsageLimitReset('resets 5 times', now), undefined);
		assert.strictEqual(parseUsageLimitReset('resets 13pm', now), undefined);
		assert.strictEqual(parseUsageLimitReset(undefined, now), undefined);
	});

	test('reads epoch seconds, milliseconds and ISO dates', () => {
		assert.strictEqual(readResetTime(1_791_190_200), 1_791_190_200_000);
		assert.strictEqual(readResetTime(1_791_190_200_000), 1_791_190_200_000);
		assert.strictEqual(readResetTime('2026-10-06T00:00:00Z'), Date.UTC(2026, 9, 6));
		assert.strictEqual(readResetTime('soon'), undefined);
	});

	test('Claude\'s rate-limit data carries its reset onto the notice', () => {
		const resetsAt = Math.floor(now / 1000) + 3600;
		const [notice] = noticesFromAcpUpdate({ sessionUpdate: 'agent_message_chunk', _meta: { '_claude/rateLimit': { status: 'rejected', resetsAt } } });
		assert.strictEqual(notice.severity, 'error');
		assert.strictEqual(notice.resetAt, resetsAt * 1000);
		const [warning] = noticesFromAcpUpdate({ sessionUpdate: 'agent_message_chunk', _meta: { '_claude/rateLimit': { status: 'allowed_warning', resetsAt } } });
		assert.strictEqual(warning.resetAt, undefined, 'a warning is not a stop');
	});

	test('only an error-level limit notice, or a limit error, stops the run', () => {
		assert.ok(isUsageLimitStop({ type: 'error', message: 'You\'ve hit your session limit · resets 12:40am (Asia/Dubai)' }));
		assert.ok(isUsageLimitStop({ type: 'notice', severity: 'error', title: 'Usage limit reached · resets 3:20 AM' }));
		assert.ok(!isUsageLimitStop({ type: 'notice', severity: 'warning', title: 'Usage limit warning · resets 3:20 AM' }));
		assert.ok(!isUsageLimitStop({ type: 'error', message: 'Connection reset by peer' }));
	});
});

suite('Volt usage-limit recovery: orchestrator', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function limited(resetIn = HOUR) {
		const sim = new OrchSim();
		const turn = sim.submit('a', 'build it');
		sim.start('a');
		const queued = sim.submit('a', 'then this');
		const active = sim.state.threads.a.active!;
		const resetAt = sim.now + resetIn;
		sim.run({ type: 'run.settled', threadId: 'a', runId: active.runId, turnId: active.id, outcome: 'failed', error: 'You\'ve hit your session limit', limit: { resetAt } });
		return { sim, turnId: turn.turnId, queuedId: queued.turnId, resetAt };
	}

	test('a turn stopped by the limit records it and pauses the queue', () => {
		const { sim, turnId, resetAt } = limited();
		const limit = sim.thread('a').limit;
		assert.strictEqual(sim.thread('a').pause, 'failed');
		assert.strictEqual(limit?.turnId, turnId);
		assert.strictEqual(limit?.resetAt, resetAt);
		assert.strictEqual(limit?.message, 'You\'ve hit your session limit');
		assert.strictEqual(limit?.autoResume, undefined);
	});

	test('a reset time at or before the stop is dropped', () => {
		const { sim } = limited(-HOUR);
		assert.ok(sim.thread('a').limit);
		assert.strictEqual(sim.thread('a').limit?.resetAt, undefined);
		const refused = sim.run({ type: 'limit.configure', threadId: 'a', turnId: sim.thread('a').limit!.turnId, autoResume: true });
		assert.match(refused.rejected ?? '', /did not say when/);
	});

	test('resume and snooze toggle independently and only for the current limit', () => {
		const { sim, turnId } = limited();
		sim.run({ type: 'limit.configure', threadId: 'a', turnId, autoResume: true });
		sim.run({ type: 'limit.configure', threadId: 'a', turnId, snooze: true });
		assert.deepStrictEqual([sim.thread('a').limit?.autoResume, sim.thread('a').limit?.snooze], [true, true]);
		sim.run({ type: 'limit.configure', threadId: 'a', turnId, autoResume: false });
		assert.deepStrictEqual([sim.thread('a').limit?.autoResume, sim.thread('a').limit?.snooze], [undefined, true], 'cancelling the resume keeps the snooze');
		const stale = sim.run({ type: 'limit.configure', threadId: 'a', turnId: 'another-turn', autoResume: true });
		assert.match(stale.rejected ?? '', /changed/);
	});

	test('snoozing after the reset is refused', () => {
		const { sim, turnId, resetAt } = limited();
		sim.now = resetAt + 1;
		const refused = sim.run({ type: 'limit.configure', threadId: 'a', turnId, snooze: true });
		assert.match(refused.rejected ?? '', /passed/);
	});

	test('the resume runs ahead of the queued prompt, and any new turn clears the limit', () => {
		const { sim, turnId, queuedId } = limited();
		sim.run({ type: 'limit.configure', threadId: 'a', turnId, autoResume: true });
		const resume = sim.submit('a', 'Continue where you left off.', 'auto', false, `limit-resume:a:${turnId}`);
		assert.strictEqual(resume.decision.outcome, 'started');
		assert.strictEqual(sim.thread('a').limit, undefined);
		assert.strictEqual(sim.thread('a').pause, undefined);
		assert.deepStrictEqual(sim.thread('a').queue.map(item => item.id), [queuedId]);
		assert.strictEqual(sim.submit('a', 'Continue where you left off.', 'auto', false, `limit-resume:a:${turnId}`).decision.outcome, 'duplicate', 'the same resume is not sent twice');
		sim.complete('a');
		assert.strictEqual(sim.thread('a').active?.id, queuedId, 'the queue drains after the resume');
	});

	test('a message the user sends clears the limit too', () => {
		const { sim } = limited();
		sim.run({ type: 'queue.resume', threadId: 'a' });
		assert.strictEqual(sim.thread('a').limit, undefined);
	});

	test('the limit survives a restart, and a pending resume keeps its chat loaded', () => {
		const { sim, turnId } = limited();
		sim.run({ type: 'limit.configure', threadId: 'a', turnId, autoResume: true, snooze: true });
		sim.run({ type: 'recover' });
		const rootId = sim.thread('a').rootId;
		const snapshot = parseRootSnapshot(JSON.parse(JSON.stringify(extractRoot(sim.state, rootId, [], sim.now))));
		const thread = snapshot?.threads.find(item => item.id === 'a');
		assert.deepStrictEqual({ ...thread?.limit }, { ...sim.thread('a').limit });
		assert.ok(isRootLive(sim.state, rootId));
	});

	test('a turn that failed for another reason records no limit', () => {
		const sim = new OrchSim();
		sim.submit('a', 'one', 'auto', false, 't1');
		sim.start('a');
		sim.settle('a', 'failed', undefined, 'boom');
		assert.strictEqual(sim.thread('a').limit, undefined);
		assert.ok(prompt('x'));
	});
});

suite('Volt usage-limit recovery: banner', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const now = Date.UTC(2026, 9, 5, 17, 0);
	const base = { turnId: 't', at: now - 1_000 };

	test('offers resume and snooze while the reset is ahead', () => {
		const view = limitRecoveryView({ ...base, resetAt: now + 2 * HOUR + 10 * 60_000 }, now);
		assert.strictEqual(view.title, 'Usage limit reached');
		assert.ok(view.canSchedule);
		assert.match(view.description, /^Resets .+ · in 2h 10m$/);
		assert.deepStrictEqual([view.resumeLabel, view.snoozeLabel], ['Resume at reset', 'Snooze until reset']);
	});

	test('reflects the choices, and a snooze ended from the sidebar', () => {
		const resetAt = now + HOUR;
		const limit = { ...base, resetAt, autoResume: true, snooze: true };
		const view = limitRecoveryView(limit, now, { snoozed: true, snoozedUntil: resetAt });
		assert.deepStrictEqual([view.autoResume, view.snoozed, view.resumeLabel, view.snoozeLabel], [true, true, 'Cancel auto-resume', 'Unsnooze']);
		assert.strictEqual(limitRecoveryView(limit, now, { snoozed: false }).snoozed, false);
	});

	test('without a reset time it says so and offers nothing', () => {
		const view = limitRecoveryView(base, now);
		assert.strictEqual(view.canSchedule, false);
		assert.strictEqual(view.description, 'Reset time unavailable; retry manually');
		assert.strictEqual(nextLimitViewChange(base, now), undefined);
	});

	test('after the reset it offers to resume now', () => {
		const view = limitRecoveryView({ ...base, resetAt: now - 1 }, now);
		assert.ok(view.resetPassed);
		assert.strictEqual(view.resumeLabel, 'Resume now');
	});

	test('countdowns', () => {
		assert.strictEqual(formatCountdown(30_000), 'under a minute');
		assert.strictEqual(formatCountdown(45 * 60_000), '45m');
		assert.strictEqual(formatCountdown(3 * HOUR), '3h');
		assert.strictEqual(formatCountdown(26 * HOUR), '1d 2h');
	});
});
