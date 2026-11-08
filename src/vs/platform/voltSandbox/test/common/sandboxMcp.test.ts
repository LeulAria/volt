/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The T4-MCP policy (spec M.3 C6, H.8): MCP-POL-1, a sandboxed chat's MCP server is never wider
 * than the chat (property test over random chats); MCP-5 (no home: the agent's state, credentials
 * and other projects stay out of reach); MCP-6 (network only to the server's approved hosts, and
 * only those the chat may reach; none otherwise); MCP-QUOTA-1 (H.8 limits in the policy).
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { allowCovers, entryInside } from '../../common/authority.js';
import { MCP_HOST_QUOTAS, mcpAllowedHosts, mcpHostPolicy } from '../../common/sandboxMcp.js';
import { agentSandboxPolicy, IAgentSandboxHost, IVoltSandboxRequest } from '../../common/sandboxPolicy.js';
import { IVoltSandboxPolicy } from '../../common/sandboxSchema.js';
import { forAll } from './seededGen.js';

const HOME = '/Users/me';
const HOST: IAgentSandboxHost = { platform: 'darwin', home: HOME, tempDirs: ['/private/tmp'], uid: 501, cacheDir: `${HOME}/.volt/sandbox-cache/abc`, userDataDir: `${HOME}/Library/Application Support/Volt` };

function chatRequest(overrides: Partial<IVoltSandboxRequest> = {}): IVoltSandboxRequest {
	return { level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: [`${HOME}/repo`], ...overrides };
}

function policyFor(request: IVoltSandboxRequest, allowedHosts: readonly string[] = [], host: IAgentSandboxHost = HOST): { chat: IVoltSandboxPolicy; mcp: IVoltSandboxPolicy } {
	const chat = agentSandboxPolicy(request, host);
	return { chat, mcp: mcpHostPolicy({ server: 'github', chat, request, platform: host.platform, home: host.home, allowedHosts }).policy };
}

/** Volt's own per-server folders, the only entries the chat does not have. */
const OWN = new Set(['${tmp}', '${storage}']);

const NETWORK_ORDER = { none: 0, proxy: 1, host: 2 } as const;

function assertNotWider(chat: IVoltSandboxPolicy, mcp: IVoltSandboxPolicy, label: string): void {
	for (const path of mcp.filesystem.read) {
		assert.ok(chat.filesystem.read.some(parent => entryInside(path, parent)) || chat.filesystem.write.some(parent => entryInside(path, parent)), `${label}: read ${path} is inside the chat's`);
	}
	for (const path of mcp.filesystem.write) {
		assert.ok(OWN.has(path) || chat.filesystem.write.some(parent => entryInside(path, parent)), `${label}: write ${path} is inside the chat's`);
	}
	for (const path of chat.filesystem.deny) {
		assert.ok(mcp.filesystem.deny.includes(path), `${label}: the chat's deny ${path} stays`);
	}
	for (const path of chat.filesystem.protect) {
		assert.ok(mcp.filesystem.protect.includes(path), `${label}: the chat's protection ${path} stays`);
	}
	assert.deepStrictEqual(mcp.filesystem.unmask, chat.filesystem.unmask, `${label}: no credential deny is lifted`);
	assert.ok(NETWORK_ORDER[mcp.network.mode] <= NETWORK_ORDER[chat.network.mode], `${label}: network ${mcp.network.mode} within ${chat.network.mode}`);
	if (chat.network.mode === 'proxy') {
		for (const host of mcp.network.allow) {
			assert.ok(chat.network.allow.some(parent => allowCovers(parent, host)), `${label}: host ${host} is one the chat may reach`);
		}
	}
	assert.deepStrictEqual(mcp.network.loopbackPorts, [], `${label}: no loopback ports (not even Volt's MCP port)`);
	assert.strictEqual(mcp.network.listen, false);
	assert.deepStrictEqual(mcp.network.listenPorts ?? [], []);
	assert.deepStrictEqual(mcp.host.unixSockets, []);
	assert.strictEqual(mcp.host.systemServices, false);
	for (const name of mcp.env.inherit) {
		assert.ok(chat.env.inherit.includes(name), `${label}: env ${name} is one the chat inherits`);
	}
	assert.ok(!mcp.env.inherit.includes('HOME'), 'its HOME is its own');
	// Only what the OS cannot count is relaxed, and the chat itself has no process limit at all.
	for (const dimension of mcp.bestEffort) {
		assert.ok(chat.bestEffort.includes(dimension) || dimension === 'limits.processes', `${label}: best effort ${dimension}`);
	}
}

suite('Volt sandbox: the T4-MCP policy (C6)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('MCP-POL-1: over random chats, a server\'s policy is never wider than its chat\'s', () => {
		const providers = ['claude-code', 'codex', 'cursor-acp', '', 'grok'];
		const hosts = ['api.github.com', '*.example.com', 'evil.com', 'registry.npmjs.org', 'example.com:8443'];
		forAll('MCP-POL-1', gen => {
			const home = gen.pick(['/Users/me', '/home/me']);
			const network = gen.bool();
			const request: IVoltSandboxRequest = {
				level: gen.pick(['workspace-write', 'read-only'] as const),
				network,
				providerId: gen.pick(providers),
				workspaceRoots: gen.some([`${home}/repo`, `${home}/repo/.git`, '/tmp/w', `${home}/other`], 2),
				...(gen.bool(0.4) ? { extraWritableRoots: gen.some([`${home}/extra`, '/tmp/x'], 1) } : {}),
				...(gen.bool(0.4) ? { allowedDomains: gen.some(hosts, 2) } : {}),
				...(gen.bool(0.3) ? { listenPorts: [3000] } : {}),
				...(gen.bool(0.3) ? { loopbackPorts: [4321] } : {}),
			};
			const host: IAgentSandboxHost = { platform: gen.pick(['darwin', 'linux']), home, tempDirs: ['/tmp'], uid: 501, cacheDir: `${home}/.volt/sandbox-cache/a`, ...(network && gen.bool(0.3) ? { sshAuthSock: '/tmp/agent.sock' } : {}) };
			const { chat, mcp } = policyFor(request, gen.some(hosts, 3), host);
			assertNotWider(chat, mcp, JSON.stringify(request));
		});
	});

	test('MCP-5: no home: not the agent\'s state, its config overlay, its caches or other projects; only the system, toolchains and the workspace', () => {
		const { chat, mcp } = policyFor(chatRequest());
		assert.ok(chat.filesystem.read.some(path => path.startsWith(`${HOME}/.claude`)), 'the chat reads its agent state');
		assert.ok(!mcp.filesystem.read.some(path => path === HOME || path.startsWith(`${HOME}/.claude`) || path.startsWith(`${HOME}/Library/Keychains`) || path === `${HOME}/.ssh`), `MCP reads: ${mcp.filesystem.read.join(', ')}`);
		assert.ok(mcp.filesystem.read.includes(`${HOME}/repo`), 'the workspace is readable');
		assert.ok(mcp.filesystem.read.includes(`${HOME}/.nvm`), 'toolchains are readable');
		assert.ok(mcp.filesystem.read.includes('${system}') && mcp.filesystem.read.includes('${path}'));
		assert.deepStrictEqual(mcp.filesystem.write.filter(path => !OWN.has(path)), [`${HOME}/repo`], 'writes only the workspace, as the chat may');
		assert.ok(!mcp.filesystem.write.includes(HOST.cacheDir), 'not the chat\'s package cache');
		assert.ok(mcp.filesystem.deny.includes(`${HOME}/Library/Application Support/Volt`), 'Volt\'s user data stays denied');
		assert.strictEqual(mcp.env.set.HOME, '${storage}/home');
		assert.ok(Object.values(mcp.env.set).every(value => !value.includes(HOST.cacheDir)), 'no variable points into the chat\'s caches');
		assert.ok(!('CLAUDE_CONFIG_DIR' in mcp.env.set));
		const readOnly = policyFor(chatRequest({ level: 'read-only' })).mcp;
		assert.deepStrictEqual(readOnly.filesystem.write.filter(path => !OWN.has(path)), [], 'a read-only chat\'s server writes nothing of the user\'s');
	});

	test('MCP-6: network: none without approved hosts; with them, the proxy and only hosts the chat may reach', () => {
		assert.strictEqual(policyFor(chatRequest()).mcp.network.mode, 'none', 'no approved hosts: no network, even if the chat has API hosts');
		assert.strictEqual(policyFor(chatRequest({ network: true })).mcp.network.mode, 'none', 'a chat with the network on gives its server none by default');
		const open = policyFor(chatRequest({ network: true }), ['api.github.com', 'API.GITHUB.COM', 'localhost', '*']).mcp;
		assert.strictEqual(open.network.mode, 'proxy', 'through Volt\'s proxy, never the host network');
		assert.deepStrictEqual(open.network.allow, ['api.github.com'], 'named hosts only: no localhost, no "*"');
		const closed = policyFor(chatRequest({ network: false, allowedDomains: ['api.github.com'] }), ['api.github.com', 'evil.com']).mcp;
		assert.strictEqual(closed.network.mode, 'proxy');
		assert.deepStrictEqual(closed.network.allow, ['api.github.com'], 'a host the chat cannot reach is dropped');
		assert.strictEqual(policyFor(chatRequest({ network: false }), ['evil.com']).mcp.network.allow.length, 0);
		assert.deepStrictEqual(mcpAllowedHosts(['A.com', 'a.com', 3, '', 'bad host', 'x.io:8443']), ['a.com', 'x.io:8443']);
	});

	test('MCP-QUOTA-1: the H.8 limits the OS can enforce are in the policy; process counting is best effort', () => {
		const { mcp } = policyFor(chatRequest());
		assert.strictEqual(mcp.process.limits.processes, MCP_HOST_QUOTAS.processes);
		assert.strictEqual(mcp.process.limits.fileSizeMB, MCP_HOST_QUOTAS.fileSizeMB);
		assert.strictEqual(mcp.process.limits.cpuSeconds, undefined, 'no CPU-seconds cap: it would kill a long-lived server');
		assert.strictEqual(mcp.process.limits.wallClockSeconds, undefined, 'no wall clock: it is a host');
		assert.ok(mcp.bestEffort.includes('limits.processes'));
		assert.strictEqual(mcp.name, 'mcp github');
		assert.strictEqual(MCP_HOST_QUOTAS.memoryMB, 512);
		assert.strictEqual(MCP_HOST_QUOTAS.idleStopMs, 10 * 60_000);
	});
});
