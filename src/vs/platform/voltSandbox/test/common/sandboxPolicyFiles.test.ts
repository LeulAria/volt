/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sandbox policy files (02-design.md "Policy files"): parsing with lines, the managed policy's cap
 * on the user's file, and the composition the launch compiles (user trusted, repository narrow
 * only). Pure; the node side's loading and a real launch are `test/node/sandboxPolicyFiles.test.ts`.
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { composeLaunchLayers, ISandboxLayer, launchPolicyBytes } from '../../common/compile.js';
import { executionBearingReason } from '../../common/executionBearing.js';
import { agentSandboxPolicy, IAgentSandboxHost, IVoltSandboxRequest } from '../../common/sandboxPolicy.js';
import { capUserLayer, expandPolicyFileTokens, parseSandboxPolicyFile } from '../../common/sandboxPolicyFiles.js';
import { IVoltSandboxPolicyLayer } from '../../common/sandboxSchema.js';

const HOME = '/Users/me';
const WS = '/Users/me/src/app';
const host: IAgentSandboxHost = { platform: 'darwin', home: HOME, tempDirs: ['/private/tmp'], cacheDir: `${HOME}/.volt/sandbox-cache/k` };
const request: IVoltSandboxRequest = { level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: [WS], allowedDomains: ['a.example.com', 'b.example.com'], listenPorts: [3000] };

function layer(value: unknown): IVoltSandboxPolicyLayer {
	const parsed = parseSandboxPolicyFile(JSON.stringify(value));
	assert.ok(parsed.ok, parsed.ok ? '' : parsed.problem);
	return parsed.layer;
}

function repo(value: unknown): ISandboxLayer {
	return { source: 'workspace', trusted: false, layer: expandPolicyFileTokens(layer(value), HOME, WS) };
}

function user(value: unknown): ISandboxLayer {
	return { source: 'user', trusted: true, layer: expandPolicyFileTokens(layer(value), HOME, undefined) };
}

suite('Volt sandbox policy files (pure)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const base = agentSandboxPolicy(request, host);

	test('POLFILE-PARSE-1: problems name their line, for JSON and for the schema', () => {
		const syntax = parseSandboxPolicyFile('{\n\t"schemaVersion": 1,\n\t"network": { "mode": "none", }\n}');
		assert.ok(!syntax.ok);
		assert.match(syntax.problem, /^line 3: not valid JSON/);
		const schema = parseSandboxPolicyFile('{\n\t"schemaVersion": 1,\n\t"filesystem": {\n\t\t"write": [\n\t\t\t"${workspace}/out",\n\t\t\t"relative/path"\n\t\t]\n\t}\n}');
		assert.ok(!schema.ok);
		assert.match(schema.problem, /^line 6: filesystem\.write\[1\] must be absolute/);
		const unknown = parseSandboxPolicyFile('{\n\t"schemaVersion": 1,\n\t"netwrok": {}\n}');
		assert.ok(!unknown.ok);
		assert.match(unknown.problem, /^line 3: netwrok is not a known field/);
		const version = parseSandboxPolicyFile('{ "filesystem": {} }');
		assert.ok(!version.ok);
		assert.match(version.problem, /schemaVersion must be 1/);
		assert.ok(!parseSandboxPolicyFile('[]').ok);
		assert.ok(!parseSandboxPolicyFile('{ "schemaVersion": 1 } // comment').ok, 'strict JSON: no comments');
		assert.ok(parseSandboxPolicyFile('﻿{ "schemaVersion": 1 }').ok, 'a byte order mark is fine');
	});

	test('POLFILE-USER-1: the user file alone may widen (a folder, a host, a port)', () => {
		const { policy, ignored } = composeLaunchLayers(base, [user({ schemaVersion: 1, filesystem: { write: ['${home}/scratch'] }, network: { allow: ['example.com'], listenPorts: [4321] } })]);
		assert.deepStrictEqual(ignored, []);
		assert.ok(policy.filesystem.write.includes(`${HOME}/scratch`), '${home} is expanded');
		assert.ok(policy.network.allow.includes('example.com'));
		assert.ok(policy.network.listenPorts?.includes(4321));
	});

	test('POLFILE-REPO-1: a repository file alone narrows', () => {
		const { policy, ignored } = composeLaunchLayers(base, [repo({ schemaVersion: 1, filesystem: { deny: ['${workspace}/private'], protect: ['${workspace}/locked.txt'] }, network: { allow: ['a.example.com'], listenPorts: [] } })]);
		assert.deepStrictEqual(ignored, []);
		assert.ok(policy.filesystem.deny.includes(`${WS}/private`), '${workspace} is the file\'s own root');
		assert.ok(policy.filesystem.protect.includes(`${WS}/locked.txt`));
		assert.deepStrictEqual(policy.network.allow, ['a.example.com']);
		assert.strictEqual(policy.network.listenPorts, undefined);
	});

	test('POLFILE-NARROW-1: a repository file attempting every widening the schema allows changes nothing', () => {
		const widenings = {
			schemaVersion: 1,
			filesystem: { read: ['${home}/Documents', '/Volumes/secret'], write: ['${home}/Documents', '/opt/volt-widen'], unmask: ['${home}/.ssh', '${home}/.aws'] },
			network: { mode: 'host', allow: ['evil.example.net', '*', 'a.example.com:6379'], loopbackPorts: [6379], listen: true, listenPorts: [3000, 8080] },
			env: { inherit: ['GITHUB_TOKEN', '*', 'AWS_SECRET_ACCESS_KEY'], set: { VSCODE_IPC_HOOK_CLI: '/tmp/ipc', SSH_AUTH_SOCK: '/tmp/agent', LD_PRELOAD: 'evil.so', NODE_OPTIONS: '--require evil', HTTPS_PROXY: 'http://evil', VOLT_SANDBOX_TAG: 'x', PATH: '/evil/bin', HOME: '/evil', npm_config_cache: '/evil' } },
			host: { unixSockets: ['/var/run/docker.sock'], systemServices: true },
			bestEffort: ['filesystem.write', 'network.proxy', 'filesystem.protectNew'],
		};
		const { policy, ignored } = composeLaunchLayers(base, [repo(widenings)]);
		// Lists the repository names replace the policy's with their part inside it: here nothing, except
		// the port the chat already listens on and the one dimension it already runs best effort.
		const narrowedOnly = composeLaunchLayers(base, [repo({
			schemaVersion: 1,
			filesystem: { read: [], write: [] },
			network: { allow: [], loopbackPorts: [], listenPorts: [3000] },
			env: { inherit: [] },
			bestEffort: ['filesystem.protectNew'],
		})]);
		assert.deepStrictEqual(narrowedOnly.ignored, []);
		assert.strictEqual(launchPolicyBytes(policy), launchPolicyBytes(narrowedOnly.policy), 'every widening was dropped, and nothing else changed');
		const fields = new Set(ignored.map(note => `${note.field} ${note.value}`));
		for (const expectedNote of [
			'filesystem.read ' + HOME + '/Documents', 'filesystem.read /Volumes/secret', 'filesystem.write ' + HOME + '/Documents', 'filesystem.write /opt/volt-widen',
			'filesystem.unmask ' + HOME + '/.ssh', 'network.mode host', 'network.allow evil.example.net', 'network.allow *', 'network.allow a.example.com:6379',
			'network.loopbackPorts 6379', 'network.listen true', 'network.listenPorts 8080', 'env.inherit GITHUB_TOKEN', 'env.inherit *',
			'env.set VSCODE_IPC_HOOK_CLI', 'env.set SSH_AUTH_SOCK', 'env.set LD_PRELOAD', 'env.set NODE_OPTIONS', 'env.set HTTPS_PROXY', 'env.set VOLT_SANDBOX_TAG',
			'env.set PATH', 'env.set HOME', 'env.set npm_config_cache', 'host.unixSockets /var/run/docker.sock', 'bestEffort filesystem.write', 'bestEffort network.proxy',
		]) {
			assert.ok(fields.has(expectedNote), `ignored: ${expectedNote} (got ${[...fields].join(', ')})`);
		}
		assert.ok(ignored.every(note => note.source === 'workspace'));
		// The network off with a repository asking for the host network: still the proxy and its hosts.
		assert.strictEqual(policy.network.mode, 'proxy');
	});

	test('POLFILE-NARROW-2: a harmless new variable is kept; a narrowed write is recorded for the resolver', () => {
		const { policy, contained } = composeLaunchLayers(base, [repo({ schemaVersion: 1, env: { set: { CI: '1' } }, filesystem: { write: ['${workspace}/src'] } })]);
		assert.strictEqual(policy.env.set.CI, '1');
		assert.ok(policy.filesystem.write.includes(`${WS}/src`) && !policy.filesystem.write.includes(WS));
		assert.deepStrictEqual(contained.map(entry => [entry.field, entry.path, entry.within]), [['filesystem.write', `${WS}/src`, [WS]]]);
	});

	test('POLFILE-B32-1: a repository entry that resolves outside through a symlink is dropped', () => {
		const realpaths = { [`${WS}/link`]: '/usr/local', [WS]: WS, [HOME]: HOME };
		const { policy, ignored } = composeLaunchLayers(base, [repo({ schemaVersion: 1, filesystem: { write: ['${workspace}/link'] } })], realpaths);
		assert.ok(!policy.filesystem.write.includes(`${WS}/link`));
		assert.ok(ignored.some(note => note.field === 'filesystem.write' && /symlink/.test(note.reason)), JSON.stringify(ignored));
	});

	test('POLFILE-ALL-1: user widens, repository narrows, the managed policy beats both', () => {
		const admin = { denyHosts: ['example.com'], denyCapabilities: ['net.listen:*'] };
		const capped = capUserLayer(layer({ schemaVersion: 1, filesystem: { write: ['${home}/scratch'], unmask: ['${home}/.aws'] }, network: { mode: 'host', allow: ['example.com', 'api.example.org'], listenPorts: [4321], listen: true } }), admin, HOME);
		const notes = capped.ignored.map(note => `${note.field} ${note.value}`);
		// The unfiltered network would reach the denied host, so it goes too.
		assert.deepStrictEqual(notes.sort(), ['network.allow example.com', 'network.listen true', 'network.listenPorts 4321', 'network.mode host'].sort());
		assert.ok(capped.ignored.every(note => note.source === 'user' && /organization/.test(note.reason)));
		const hostDenied = capUserLayer(layer({ schemaVersion: 1, network: { mode: 'host' } }), { denyCapabilities: ['net.connect'] }, HOME);
		assert.strictEqual(hostDenied.layer.network?.mode, undefined, 'the host network is net.connect to everything');
		const writeDenied = capUserLayer(layer({ schemaVersion: 1, filesystem: { write: ['${home}/scratch'], read: ['${home}/notes', '/opt/tools'] } }), { denyCapabilities: ['files.write', 'files.read:home'] }, HOME);
		assert.deepStrictEqual(writeDenied.layer.filesystem?.write, []);
		assert.deepStrictEqual(writeDenied.layer.filesystem?.read, ['/opt/tools'], 'only home reads are files.read:home');

		const { policy, ignored } = composeLaunchLayers(base, [
			{ source: 'user', trusted: true, layer: expandPolicyFileTokens(capped.layer, HOME, undefined) },
			repo({ schemaVersion: 1, filesystem: { deny: ['${workspace}/private'] }, network: { mode: 'proxy', allow: ['api.example.org'] } }),
		]);
		assert.ok(policy.filesystem.write.includes(`${HOME}/scratch`), 'the user\'s widening the admin allows');
		assert.ok(policy.filesystem.unmask.includes(`${HOME}/.aws`));
		assert.strictEqual(policy.network.mode, 'proxy');
		assert.deepStrictEqual(policy.network.allow, ['api.example.org'], 'the user\'s host, narrowed to by the repository');
		// Without the managed policy, the repository narrows the user's host network to the proxy and one host.
		const uncapped = composeLaunchLayers(base, [user({ schemaVersion: 1, network: { mode: 'host' } }), repo({ schemaVersion: 1, network: { mode: 'proxy', allow: ['api.example.org'] } })]);
		assert.deepStrictEqual([uncapped.policy.network.mode, uncapped.policy.network.allow], ['proxy', ['api.example.org']]);
		assert.ok(policy.filesystem.deny.includes(`${WS}/private`));
		assert.deepStrictEqual(ignored, []);
	});

	test('POLFILE-TRUST-1: only a user layer is ever trusted by the launch compile', () => {
		const widen: IVoltSandboxPolicyLayer = { schemaVersion: 1, network: { mode: 'host' } };
		for (const source of ['workspace', 'execution', 'builtin'] as const) {
			const { policy, ignored } = composeLaunchLayers(base, [{ source, trusted: true, layer: widen }]);
			assert.strictEqual(policy.network.mode, 'proxy', source);
			assert.strictEqual(ignored.length, 1, source);
		}
		assert.strictEqual(composeLaunchLayers(base, [{ source: 'user', trusted: true, layer: widen }]).policy.network.mode, 'host');
	});

	test('POLFILE-PROT-1: both policy files are protected paths for every sandboxed writer', () => {
		const policy = agentSandboxPolicy({ ...request, extraWritableRoots: [`${HOME}/.volt`] }, host);
		assert.ok(policy.filesystem.protect.includes(`${WS}/.volt/sandbox.json`), 'the repository\'s');
		assert.ok(policy.filesystem.protect.includes(`${HOME}/.volt/sandbox.json`), 'the user\'s, even with ~/.volt writable');
		assert.ok(executionBearingReason(`${WS}/.volt/sandbox.json`, HOME, true), 'the files broker never writes a repository\'s');
		assert.ok(executionBearingReason(`${WS}/nested/.volt/sandbox.json`, HOME, true), 'at any depth');
		assert.ok(executionBearingReason(`${HOME}/.volt/sandbox.json`, HOME, true), 'or the user\'s');
	});
});
