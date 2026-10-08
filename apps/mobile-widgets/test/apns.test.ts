/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { activityContentState, chatView } from '../src/agentState.ts';
import { isTokenRegistration, liveActivityPush, type ILiveActivityTokenRegistration } from '../src/apns.ts';
import { providerToken, isDeadToken } from '../server/apnsClient.ts';
import { LiveActivityPushRelay } from '../server/liveActivityRelay.ts';
import type { IApnsRequest } from '../src/apns.ts';
import { meta, NOW, running, thread } from './fixtures.ts';

const TOKEN = 'ab'.repeat(32);
const state = activityContentState(chatView('a', { thread: running('a', 60_000) }, NOW)!, 0);

test('update pushes: liveactivity topic, routine priority 5, stale date, no alert', () => {
	const request = liveActivityPush('dev.volt.mobile', { event: 'update', state, timestamp: NOW / 1000, staleAt: NOW / 1000 + 600 });
	assert.equal(request.headers['apns-push-type'], 'liveactivity');
	assert.equal(request.headers['apns-topic'], 'dev.volt.mobile.push-type.liveactivity');
	assert.equal(request.headers['apns-priority'], '5');
	assert.deepEqual(request.payload.aps, { timestamp: NOW / 1000, event: 'update', 'content-state': state, 'stale-date': NOW / 1000 + 600 });
});

test('alerts, input and end are urgent; end carries the dismissal date; start carries attributes', () => {
	const alerting = liveActivityPush('b', { event: 'update', state: { ...state, phase: 'input' }, timestamp: 1, alert: { title: 'Approval needed', body: 'Run npm i' } });
	assert.equal(alerting.headers['apns-priority'], '10');
	assert.deepEqual(alerting.payload.aps.alert, { title: 'Approval needed', body: 'Run npm i', sound: 'default' });

	const end = liveActivityPush('b', { event: 'end', state, timestamp: 100, dismissAt: 1000, staleAt: 50 });
	assert.equal(end.payload.aps['dismissal-date'], 1000);
	assert.equal(end.payload.aps['stale-date'], undefined);
	assert.equal(end.headers['apns-priority'], '10');

	const start = liveActivityPush('b', { event: 'start', state, timestamp: 1, attributes: { chatId: 'a', provider: 'claude' } });
	assert.equal(start.payload.aps['attributes-type'], 'VoltActivityAttributes');
	assert.deepEqual(start.payload.aps.attributes, { chatId: 'a', provider: 'claude' });
	assert.equal(start.payload.aps['input-push-token'], 1);
	assert.deepEqual(start.payload.aps.alert, { title: state.title, body: state.step, sound: 'default' });
	assert.throws(() => liveActivityPush('b', { event: 'start', state, timestamp: 1 }));
});

test('token registrations are validated', () => {
	const ok: ILiveActivityTokenRegistration = { deviceId: 'd', bundleId: 'dev.volt.mobile', environment: 'sandbox', kind: 'activity', token: TOKEN, activityId: 'x', chatId: 'a', registeredAt: 1 };
	assert.equal(isTokenRegistration(ok), true);
	assert.equal(isTokenRegistration({ ...ok, activityId: undefined }), false);
	assert.equal(isTokenRegistration({ ...ok, kind: 'pushToStart', activityId: undefined, chatId: undefined }), true);
	assert.equal(isTokenRegistration({ ...ok, token: 'not hex' }), false);
	assert.equal(isTokenRegistration({ ...ok, environment: 'dev' }), false);
});

test('the provider token is a valid ES256 JWT', () => {
	const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
	const jwt = providerToken({ teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: pem }, 1_800_000_000);
	const [header, claims, signature] = jwt.split('.');
	assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'ES256', kid: 'KEY1234567' });
	assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), { iss: 'TEAM123456', iat: 1_800_000_000 });
	assert.equal(verify('sha256', Buffer.from(`${header}.${claims}`), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
	assert.equal(isDeadToken({ status: 410 }), true);
	assert.equal(isDeadToken({ status: 400, reason: 'BadDeviceToken' }), true);
	assert.equal(isDeadToken({ status: 429, reason: 'TooManyRequests' }), false);
});

test('relay: push-to-start once, then update and end through the activity token; foreground devices are skipped', async () => {
	const sent: { token: string; request: IApnsRequest }[] = [];
	let now = NOW;
	const relay = new LiveActivityPushRelay({ now: () => now, send: async (token, _env, request) => { sent.push({ token, request }); return { status: 200 }; } });
	const base = { deviceId: 'phone', bundleId: 'dev.volt.mobile', environment: 'sandbox' as const, registeredAt: 1 };
	relay.register({ ...base, kind: 'pushToStart', token: 'cd'.repeat(32) }, 'conn-1');

	const views = [chatView('a', { thread: running('a', 30_000) }, now)!];
	relay.setForeground(new Set(['conn-1']));
	assert.deepEqual(await relay.update(views), []);
	relay.setForeground(new Set());

	let deliveries = await relay.update(views);
	assert.deepEqual(deliveries.map(d => [d.kind, d.chatId]), [['start', 'a']]);
	assert.equal(sent[0].token, 'cd'.repeat(32));
	// The start is not repeated while the phone hasn't reported the new activity's token.
	assert.deepEqual(await relay.update(views), []);

	relay.register({ ...base, kind: 'activity', token: TOKEN, activityId: 'act-1', chatId: 'a' });
	now += 5_000;
	deliveries = await relay.update([chatView('a', { thread: running('a', 35_000) }, now)!]);
	assert.deepEqual(deliveries.map(d => [d.kind, d.status]), [['update', 200]]);
	assert.equal(sent.at(-1)?.token, TOKEN);

	now += 5_000;
	const done = chatView('a', { meta: meta('a', { status: 'done' }), thread: thread('a', { last: { turnId: 't', kind: 'prompt', outcome: 'done', at: now } }) }, now)!;
	deliveries = await relay.update([done]);
	assert.deepEqual(deliveries.map(d => d.kind), ['end']);
	assert.equal(sent.at(-1)?.request.payload.aps.event, 'end');
	assert.deepEqual(relay.snapshot(), [{ deviceId: 'phone', pushToStart: true, activities: [] }]);
});

test('relay drops tokens APNs says are dead', async () => {
	const relay = new LiveActivityPushRelay({ now: () => NOW, send: async () => ({ status: 410, reason: 'Unregistered' }) });
	relay.register({ deviceId: 'p', bundleId: 'b', environment: 'production', kind: 'activity', token: TOKEN, activityId: 'x', chatId: 'a', registeredAt: 1 });
	await relay.update([chatView('a', { thread: running('a', 1000) }, NOW)!]);
	assert.deepEqual(relay.snapshot()[0].activities, []);
	assert.throws(() => relay.register({ deviceId: 'p' }));
});
