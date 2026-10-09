/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startRelayServer } from '../src/server.mjs';
import { signBody, verifySignature } from '../src/signature.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'volt-relay-test-'));

async function start(dir = path.join(tmp, `r${Math.random().toString(36).slice(2)}`), extra = {}) {
	const server = await startRelayServer({ dataDir: dir, port: 0, host: '127.0.0.1', enrollKey: 'enroll-secret', ...extra });
	const base = `http://127.0.0.1:${server.port}`;
	const call = async (method, route, body, token, headers = {}) => {
		const response = await fetch(`${base}${route}`, {
			method,
			headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers },
			body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
		});
		const text = await response.text();
		return { status: response.status, body: text ? JSON.parse(text) : undefined };
	};
	return { server, base, call, dir };
}

async function pairClient(relay, name = 'Volt test') {
	const pairing = await relay.server.relay.createPairing('client', name);
	const paired = await relay.call('POST', '/api/pair', { code: pairing.code.toLowerCase().replace('-', ' '), name });
	assert.equal(paired.status, 200, JSON.stringify(paired.body));
	return paired.body.token;
}

describe('signatures', () => {
	const body = Buffer.from('{"action":"opened"}');
	test('github round trip and mismatch', () => {
		const config = { kind: 'github', secret: 's3cret' };
		const value = signBody(config, body);
		assert.match(value, /^sha256=[0-9a-f]{64}$/);
		assert.deepEqual(verifySignature(config, { 'x-hub-signature-256': value }, body), { ok: true, verified: true });
		assert.equal(verifySignature(config, { 'x-hub-signature-256': value.replace(/.$/, '0') }, body).ok, value.endsWith('0'));
		assert.equal(verifySignature(config, {}, body).ok, false);
		assert.equal(verifySignature({ kind: 'github', secret: 'other' }, { 'x-hub-signature-256': value }, body).ok, false);
	});
	test('generic accepts the digest without its prefix, base64, and a timestamp window', () => {
		const hex = signBody({ kind: 'generic', secret: 'k' }, body);
		assert.equal(verifySignature({ kind: 'generic', secret: 'k' }, { 'x-volt-signature': hex.replace('sha256=', '') }, body).ok, true);
		const b64 = { kind: 'generic', secret: 'k', header: 'x-sig', prefix: '', encoding: 'base64' };
		assert.equal(verifySignature(b64, { 'x-sig': signBody(b64, body) }, body).ok, true);
		const stamped = { kind: 'generic', secret: 'k', timestampHeader: 'x-ts', toleranceSec: 60 };
		const now = 1_800_000_000_000;
		const ts = String(now / 1000);
		const signature = signBody(stamped, body, ts);
		assert.equal(verifySignature(stamped, { 'x-volt-signature': signature, 'x-ts': ts }, body, now + 30_000).ok, true);
		assert.match(verifySignature(stamped, { 'x-volt-signature': signature, 'x-ts': ts }, body, now + 120_000).reason, /too old/);
	});
	test('none passes unverified; a missing secret fails closed', () => {
		assert.deepEqual(verifySignature({ kind: 'none' }, {}, body), { ok: true, verified: false });
		assert.equal(verifySignature({ kind: 'github' }, { 'x-hub-signature-256': 'sha256=00' }, body).ok, false);
	});
});

describe('relay', () => {
	let relay;
	let token;
	before(async () => {
		relay = await start();
		token = await pairClient(relay);
	});
	after(async () => relay.server.close());

	test('pairing codes are one-time; bad tokens are refused', async () => {
		const pairing = await relay.server.relay.createPairing('client');
		assert.equal((await relay.call('POST', '/api/pair', { code: pairing.code })).status, 200);
		assert.equal((await relay.call('POST', '/api/pair', { code: pairing.code })).status, 403);
		assert.equal((await relay.call('GET', '/api/me', undefined, 'nope')).status, 401);
		assert.equal((await relay.call('POST', '/api/pair', { enrollKey: 'wrong', kind: 'runner' })).status, 403);
		assert.equal((await relay.call('GET', '/api/me', undefined, token)).body.device.kind, 'client');
	});

	test('webhooks: held durably, deduped, signature-checked, claimed, acked, redelivered', async () => {
		const hook = await relay.call('PUT', '/api/hooks/hk-test', { name: 'PRs', signature: { kind: 'github', secret: 'gh' } }, token);
		assert.equal(hook.status, 200);
		assert.match(hook.body.url, /\/h\/[\w-]{20,}$/);
		const hookPath = new URL(hook.body.url).pathname;
		// The relay keeps only a hash of the URL token.
		assert.ok(!fs.readFileSync(path.join(relay.dir, 'state.json'), 'utf8').includes(hookPath.split('/').pop()));

		const payload = JSON.stringify({ action: 'opened', pull_request: { title: 'Fix login' } });
		const headers = { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'gh-1', 'x-hub-signature-256': signBody({ kind: 'github', secret: 'gh' }, Buffer.from(payload)) };
		const first = await relay.call('POST', hookPath, payload, undefined, headers);
		assert.equal(first.status, 202);
		const again = await relay.call('POST', hookPath, payload, undefined, headers);
		assert.equal(again.status, 200);
		assert.equal(again.body.duplicate, true);
		assert.equal(again.body.id, first.body.id);
		const forged = await relay.call('POST', hookPath, payload, undefined, { ...headers, 'x-github-delivery': 'gh-2', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) });
		assert.equal(forged.status, 401);
		assert.equal((await relay.call('POST', '/h/not-a-token', payload)).status, 404);

		const held = await relay.call('GET', '/api/deliveries?status=held', undefined, token);
		assert.deepEqual(held.body.deliveries.map(d => d.id), [first.body.id]);
		const all = await relay.call('GET', '/api/deliveries?hook=hk-test', undefined, token);
		assert.deepEqual(all.body.deliveries.map(d => d.status).sort(), ['failed', 'held']);

		const claimed = await relay.call('POST', `/api/deliveries/${first.body.id}/claim`, {}, token);
		assert.equal(claimed.body.status, 'delivered');
		assert.equal(JSON.parse(claimed.body.body).pull_request.title, 'Fix login');
		assert.equal(claimed.body.event, 'pull_request');
		assert.match(claimed.body.headers['x-hub-signature-256'], /redacted/);
		// A lease that runs out puts it back.
		relay.server.relay.state.deliveries.find(d => d.id === first.body.id).leaseUntil = Date.now() - 1;
		relay.server.relay.sweep();
		assert.equal((await relay.call('GET', `/api/deliveries/${first.body.id}`, undefined, token)).body.status, 'held');
		await relay.call('POST', `/api/deliveries/${first.body.id}/claim`, {}, token);
		const acked = await relay.call('POST', `/api/deliveries/${first.body.id}/ack`, { status: 'ran', threadId: 'agent-1' }, token);
		assert.equal(acked.body.status, 'ran');
		// Claiming a handled one tells the client it is done (at-least-once retries stay harmless).
		assert.equal((await relay.call('POST', `/api/deliveries/${first.body.id}/claim`, {}, token)).body.alreadyHandled, true);

		const copy = await relay.call('POST', `/api/deliveries/${first.body.id}/redeliver`, {}, token);
		assert.equal(copy.body.status, 'held');
		assert.equal(copy.body.redeliveryOf, first.body.id);
		assert.notEqual(copy.body.id, first.body.id);

		// Another client cannot see or claim them.
		const other = await pairClient(relay, 'Other');
		assert.equal((await relay.call('GET', '/api/deliveries', undefined, other)).body.deliveries.length, 0);
		assert.equal((await relay.call('POST', `/api/deliveries/${copy.body.id}/claim`, {}, other)).status, 404);

		// Rotating changes the URL; the old one stops working.
		const rotated = await relay.call('PUT', '/api/hooks/hk-test', { rotate: true }, token);
		assert.notEqual(rotated.body.url, hook.body.url);
		assert.equal((await relay.call('POST', hookPath, payload, undefined, headers)).status, 404);
	});

	test('held deliveries survive a relay restart, and old cursors resync', async () => {
		const dir = path.join(tmp, 'restart');
		let instance = await start(dir);
		const client = await pairClient(instance);
		const hook = await instance.call('PUT', '/api/hooks/hk-r', { signature: { kind: 'none' } }, client);
		const sent = await instance.call('POST', new URL(hook.body.url).pathname, '{"n":1}', undefined, { 'content-type': 'application/json' });
		assert.equal(sent.status, 202);
		const seq = (await instance.call('GET', '/api/events/poll?after=0&timeout=0', undefined, client)).body.seq;
		await instance.server.close();
		instance = await start(dir);
		const held = await instance.call('GET', '/api/deliveries?status=held', undefined, client);
		assert.equal(held.body.deliveries.length, 1);
		const poll = await instance.call('GET', `/api/events/poll?after=${seq - 1}&timeout=0`, undefined, client);
		assert.equal(poll.body.events[0].type, 'resync');
		await instance.server.close();
	});

	test('events: long poll returns new events', async () => {
		const start = (await relay.call('GET', '/api/events/poll?after=0&timeout=0', undefined, token)).body.seq;
		const waiting = relay.call('GET', `/api/events/poll?after=${start}&timeout=5`, undefined, token);
		await new Promise(resolve => setTimeout(resolve, 100));
		await relay.call('POST', '/api/heartbeat', { load: { cpus: 8, load1: 1 }, caps: {} }, token);
		const result = await waiting;
		assert.ok(result.body.events.some(event => event.type === 'machine'));
	});

	test('tasks: routing to the aimed runner, fallback, progress, completion, lost runners', async () => {
		const runnerA = (await relay.call('POST', '/api/pair', { enrollKey: 'enroll-secret', kind: 'runner', name: 'A', machineId: 'machine-a' })).body.token;
		const runnerB = (await relay.call('POST', '/api/pair', { enrollKey: 'enroll-secret', kind: 'runner', name: 'B', machineId: 'machine-b' })).body.token;
		const caps = { agents: { claude: { installed: true, credentials: true } } };
		await relay.call('POST', '/api/heartbeat', { load: { cpus: 4, cpu: 0.1 }, caps }, runnerA);
		await relay.call('POST', '/api/heartbeat', { load: { cpus: 4, cpu: 0.9 }, caps }, runnerB);
		const machines = (await relay.call('GET', '/api/machines', undefined, token)).body.machines;
		const a = machines.find(machine => machine.name === 'A');
		assert.equal(a.online, true);
		assert.equal(a.caps.agents.claude.credentials, true);

		const blob = await relay.call('PUT', '/api/blobs?kind=source-bundle', Buffer.from('bundle-bytes'), token, { 'content-type': 'application/octet-stream' });
		assert.equal(blob.body.size, 12);
		const created = await relay.call('POST', '/api/tasks', { title: 'Do it', prompt: 'Add a file', agent: 'claude', source: { bundleBlob: blob.body.id, baseCommit: 'abc' }, target: { machineId: a.id } }, token);
		assert.equal(created.body.status, 'queued');
		assert.equal((await relay.call('GET', '/api/machines', undefined, token)).body.machines.find(m => m.id === a.id).reserved, 1);
		// B may not take A's task, nor a task for an agent it lacks.
		assert.equal((await relay.call('POST', '/api/runner/claim?wait=0', { agents: { claude: true } }, runnerB)).body.task, null);
		assert.equal((await relay.call('POST', '/api/runner/claim?wait=0', { agents: { claude: false } }, runnerA)).body.task, null);
		const claimed = (await relay.call('POST', '/api/runner/claim?wait=0', { agents: { claude: true } }, runnerA)).body.task;
		assert.equal(claimed.id, created.body.id);
		const download = await fetch(`${relay.base}/api/blobs/${blob.body.id}`, { headers: { authorization: `Bearer ${runnerA}` } });
		assert.equal(await download.text(), 'bundle-bytes');

		const progress = await relay.call('POST', `/api/runner/tasks/${claimed.id}/events`, { events: [{ t: 'status', status: 'running', progress: 'Running' }, { t: 'message', text: 'Working on it' }, { t: 'usage', costUsd: 0.01 }] }, runnerA);
		assert.equal(progress.body.cancel, false);
		assert.equal((await relay.call('POST', `/api/runner/tasks/${claimed.id}/events`, { events: [] }, runnerB)).status, 409);
		const log = await relay.call('GET', `/api/tasks/${claimed.id}/log?after=1`, undefined, token);
		assert.deepEqual(log.body.lines.map(line => line.t), ['message', 'usage']);
		const running = (await relay.call('GET', `/api/tasks/${claimed.id}`, undefined, token)).body;
		assert.equal(running.status, 'running');
		assert.equal(running.lastMessage, 'Working on it');
		assert.equal(running.usage.costUsd, 0.01);

		await relay.call('POST', `/api/tasks/${claimed.id}/cancel`, {}, token);
		const beat = await relay.call('POST', '/api/heartbeat', { load: {}, caps }, runnerA);
		assert.deepEqual(beat.body.cancel, [claimed.id]);
		const done = await relay.call('POST', `/api/runner/tasks/${claimed.id}/complete`, { status: 'succeeded', result: { branch: 'volt/cloud-x', baseCommit: 'abc', headCommit: 'def', stats: { files: 1, insertions: 2, deletions: 0 } } }, runnerA);
		assert.equal(done.body.status, 'succeeded');
		assert.equal(done.body.result.stats.files, 1);

		// A task aimed at a runner that went quiet falls back to any capable runner.
		const second = (await relay.call('POST', '/api/tasks', { prompt: 'Two', source: { repoUrl: 'https://example.com/x.git' }, target: { machineId: a.id, fallbackAfterSec: 0 } }, token)).body;
		const stolen = (await relay.call('POST', '/api/runner/claim?wait=0', { agents: { claude: true } }, runnerB)).body.task;
		assert.equal(stolen.id, second.id);
		// The runner disappears mid-task: the sweep fails it.
		const task = relay.server.relay.state.tasks.find(candidate => candidate.id === second.id);
		task.status = 'running';
		task.updatedAt = Date.now() - 10 * 60_000;
		relay.server.relay.state.machines.find(machine => machine.name === 'B').at = Date.now() - 10 * 60_000;
		relay.server.relay.sweep();
		assert.equal(task.status, 'failed');
		assert.match(task.error, /stopped responding/);
	});

	test('auto tasks go to the least loaded runner that can take them', async () => {
		const caps = { agents: { claude: { installed: true, credentials: true } }, maxParallel: 2 };
		const idle = (await relay.call('POST', '/api/pair', { enrollKey: 'enroll-secret', kind: 'runner', name: 'Idle', machineId: 'machine-idle' })).body.token;
		const busy = (await relay.call('POST', '/api/pair', { enrollKey: 'enroll-secret', kind: 'runner', name: 'Busy', machineId: 'machine-busy' })).body.token;
		await relay.call('POST', '/api/heartbeat', { load: { cpus: 2, cpu: 0.02, container: true, load1: 9 }, caps }, idle);
		await relay.call('POST', '/api/heartbeat', { load: { cpus: 2, cpu: 0.97, container: true, load1: 9 }, caps }, busy);
		// The other runners from earlier tests are saturated too, so the idle one is the only choice.
		for (const name of ['A', 'B', 'C']) {
			const machine = relay.server.relay.state.machines.find(candidate => candidate.name === name);
			if (machine) {
				machine.load = { ...machine.load, cpus: 2, cpu: 1, container: true };
			}
		}
		const created = (await relay.call('POST', '/api/tasks', { prompt: 'Auto', source: { repoUrl: 'https://example.com/auto.git' }, target: { autoPicked: true } }, token)).body;
		assert.equal((await relay.call('POST', '/api/runner/claim?wait=0', { agents: { claude: true } }, busy)).body.task, null);
		const claimed = (await relay.call('POST', '/api/runner/claim?wait=0', { agents: { claude: true } }, idle)).body.task;
		assert.equal(claimed.id, created.id);
		assert.equal(claimed.assignedName, 'Idle');
	});

	test('the machine list carries each machine\'s score, its placement per agent and the Auto pick', async () => {
		const machines = (await relay.call('GET', '/api/machines', undefined, token)).body.machines;
		const idle = machines.find(machine => machine.name === 'Idle');
		const busy = machines.find(machine => machine.name === 'Busy');
		assert.ok(idle.score < busy.score, 'the idle runner scores better');
		assert.deepEqual(idle.placement.claude, { eligible: true, reason: null });
		assert.equal(busy.placement.codex.eligible, false);
		assert.match(busy.placement.codex.reason, /codex is not installed/);
		assert.equal(idle.autoPick.claude, true);
		assert.equal(busy.autoPick.claude, false);
	});

	test('a waiting claim wakes when a task arrives', async () => {
		const runner = (await relay.call('POST', '/api/pair', { enrollKey: 'enroll-secret', kind: 'runner', name: 'C', machineId: 'machine-c' })).body.token;
		const waiting = relay.call('POST', '/api/runner/claim?wait=5', { agents: { claude: true } }, runner);
		await new Promise(resolve => setTimeout(resolve, 100));
		const created = (await relay.call('POST', '/api/tasks', { prompt: 'Wake', source: { repoUrl: 'https://example.com/y.git' } }, token)).body;
		assert.equal((await waiting).body.task.id, created.id);
	});
});
