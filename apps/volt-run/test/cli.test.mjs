/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The CLI end to end, against the fake agent server in a fake install (test/fixtures/fakeServer.mjs).

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { targetId } from '../src/release.mjs';
import { isAlive } from '../src/server.mjs';
import { cli, cliRun, exists, fakeInstall, packRelease, readJson, serve, sha256, tempDir } from './helpers.mjs';

async function setup(t) {
	const root = await tempDir(t);
	const app = await fakeInstall(path.join(root, 'install'));
	const profile = path.join(root, 'profile');
	const runtimeFile = path.join(profile, 'agentServer', 'runtime.json');
	const env = { VOLT_RUN_CACHE: path.join(root, 'cache') };
	t.after(async () => {
		// Never leave a fake server behind, whatever the test did.
		const info = await readJson(runtimeFile).catch(() => undefined);
		if (info && isAlive(info.pid)) {
			process.kill(info.pid, 'SIGKILL');
		}
	});
	return { root, app, profile, runtimeFile, env, args: ['--app', app, '--profile', profile] };
}

test('starts Volt in the foreground and stops it on Ctrl+C', async t => {
	const s = await setup(t);
	const run = cli([...s.args, '--no-open'], s.env);
	await run.waitFor('Press Ctrl+C to stop Volt.');
	const info = await readJson(s.runtimeFile);
	assert.match(run.output(), new RegExp(`Local:\\s+http://127\\.0\\.0\\.1:${info.port}/`));
	assert.match(run.output(), /Volt 0\.0\.6\s+ready in/);
	// Started the way Volt starts it, plus the compile cache, and no idle exit while the terminal holds it.
	assert.deepEqual(info.env, { compileCache: path.join(s.profile, 'agentServer', 'compile-cache'), idleExit: '0', runAsNode: '1' });
	const health = await fetch(`http://127.0.0.1:${info.port}/health`, { headers: { Authorization: `Bearer ${(await import('node:fs')).readFileSync(path.join(s.profile, 'agentServer', 'token'), 'utf8')}` } });
	assert.equal(health.status, 200);

	run.child.kill('SIGINT');
	assert.equal(await run.exited, 0);
	assert.match(run.output(), /Stopped Volt\./);
	assert.equal(isAlive(info.pid), false);
	assert.equal(await exists(s.runtimeFile), false);
});

test('a server that stops to load its recompiled code is started again, on the same port', async t => {
	const s = await setup(t);
	const run = cli([...s.args, '--no-open'], s.env);
	await run.waitFor('Press Ctrl+C to stop Volt.');
	const first = await readJson(s.runtimeFile);
	process.kill(first.pid, 'SIGUSR2');
	await run.waitFor('Restarted Volt\'s agent server with its recompiled code.');
	const second = await readJson(s.runtimeFile);
	assert.notEqual(second.pid, first.pid);
	assert.equal(second.port, first.port);
	assert.equal(second.env.idleExit, '0');

	run.child.kill('SIGINT');
	assert.equal(await run.exited, 0);
	assert.equal(isAlive(second.pid), false);
});

test('--detach leaves it running; later runs attach, status reports, stop stops', async t => {
	const s = await setup(t);
	const detached = await cliRun([...s.args, '--no-open', '-d'], s.env);
	assert.equal(detached.code, 0, detached.output);
	assert.match(detached.output, /keeps running in the background/);
	const info = await readJson(s.runtimeFile);
	assert.ok(isAlive(info.pid));
	assert.equal(info.env.idleExit, null);

	const attached = await cliRun(['--profile', s.profile, '--no-open'], s.env);
	assert.equal(attached.code, 0, attached.output);
	assert.match(attached.output, /already running/);
	assert.equal((await readJson(s.runtimeFile)).pid, info.pid);

	const status = await cliRun(['status', '--profile', s.profile], s.env);
	assert.equal(status.code, 0, status.output);
	assert.match(status.output, /Volt 0\.0\.6 is running/);
	assert.match(status.output, /signs in on this computer/);

	const stop = await cliRun(['stop', '--profile', s.profile], s.env);
	assert.equal(stop.code, 0, stop.output);
	assert.equal(isAlive(info.pid), false);
	assert.equal((await cliRun(['status', '--profile', s.profile], s.env)).code, 1);
});

test('--host shares Volt on the network with a pairing code, and Volt keeps that setting', async t => {
	const s = await setup(t);
	const run = await cliRun([...s.args, '--no-open', '-d', '--host', '0.0.0.0'], s.env);
	assert.equal(run.code, 0, run.output);
	assert.match(run.output, /Network:\s+http:\/\/192\.168\.1\.2:\d+\/pair#code=ABCDEFGH/);
	assert.match(run.output, /Pairing code ABCD-EFGH/);
	assert.deepEqual(await readJson(path.join(s.profile, 'agentServer', 'network.json')), { network: true });
	assert.equal((await readJson(s.runtimeFile)).host, '0.0.0.0');

	const pair = await cliRun(['pair', '--profile', s.profile], s.env);
	assert.equal(pair.code, 0, pair.output);
	assert.match(pair.output, /Pairing code ABCD-EFGH/);

	// Back to this computer only: the running server is restarted on loopback.
	const local = await cliRun([...s.args, '--no-open', '-d', '--host', '127.0.0.1'], s.env);
	assert.equal(local.code, 0, local.output);
	assert.match(local.output, /Restarted the agent server/);
	assert.equal((await readJson(s.runtimeFile)).host, '127.0.0.1');
	assert.deepEqual(await readJson(path.join(s.profile, 'agentServer', 'network.json')), { network: false });
	await cliRun(['stop', '--profile', s.profile], s.env);
});

test('a server too old for browsers is stopped with a clear reason', async t => {
	const s = await setup(t);
	const run = await cliRun([...s.args, '--no-open'], { ...s.env, FAKE_SERVER_OLD: '1' });
	assert.equal(run.code, 1);
	assert.match(run.output, /can't sign a browser in \(that needs Volt 0\.0\.6 or newer\)/);
	assert.equal(await exists(s.runtimeFile), false);
});

test('a server that dies while starting shows its log', async t => {
	const s = await setup(t);
	const run = await cliRun([...s.args, '--no-open'], { ...s.env, FAKE_SERVER_CRASH: '1' });
	assert.equal(run.code, 1);
	assert.match(run.output, /stopped while starting \(exit code 3\)/);
	assert.match(run.output, /crashing on purpose/);
});

test('the first run downloads Volt from the update feed, checks it and starts it', async t => {
	const s = await setup(t);
	const target = targetId();
	const { name, data } = await packRelease(s.root, target);
	const files = {};
	const base = await serve(t, files);
	files[`/${name}`] = data;
	files['/stable/latest.json'] = JSON.stringify({ channel: 'stable', version: '0.0.6', commit: 'c0ffee', assets: [{ name, url: `${base}/${name}`, size: data.length, sha256: sha256(data) }] });

	const run = await cliRun(['--profile', s.profile, '--download', '--feed', base, '--no-open', '-d'], s.env);
	assert.equal(run.code, 0, run.output);
	assert.match(run.output, /Downloaded Volt 0\.0\.6 and checked its SHA-256/);
	const info = await readJson(s.runtimeFile);
	assert.ok(info.appRoot.startsWith(path.join(s.env.VOLT_RUN_CACHE, `stable-0.0.6-${target}`)), info.appRoot);
	await cliRun(['stop', '--profile', s.profile], s.env);

	// The next start skips the download.
	const again = await cliRun(['--profile', s.profile, '--download', '--feed', base, '--no-open', '-d'], s.env);
	assert.equal(again.code, 0, again.output);
	assert.doesNotMatch(again.output, /Downloaded/);
	await cliRun(['stop', '--profile', s.profile], s.env);

	const clean = await cliRun(['clean', '--profile', s.profile], s.env);
	assert.match(clean.output, /Deleted 1 downloaded Volt build/);
});

test('stop, status and pair when nothing runs', async t => {
	const s = await setup(t);
	assert.match((await cliRun(['stop', '--profile', s.profile], s.env)).output, /not running/);
	const pair = await cliRun(['pair', '--profile', s.profile], s.env);
	assert.equal(pair.code, 1);
	assert.match(pair.output, /Volt is not running/);
	const version = await cliRun(['--version'], s.env);
	assert.match(version.output, /^volt-run \d+\.\d+\.\d+/);
});
