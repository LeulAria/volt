/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AGENT_OVERLAYS, agentStateKey, agentStatePlan, formatKeyPath, IAgentStateHost, keyPatternCovers, mergeAgentState, sameCredentialIdentity } from '../../common/agentState.js';
import { agentHomeWrites, agentSandboxPolicy, footprintLintErrors, IAgentSandboxHost, IVoltSandboxRequest } from '../../common/sandboxPolicy.js';
import { AGENT_CONFIG_NAMES, isSecretEnvName } from '../../common/sandboxProfiles.js';

const HOME = '/Users/me';
const STATE_HOST: IAgentStateHost = { platform: 'darwin', home: HOME, root: `${HOME}/.volt/sandbox/agent-state`, hostEnv: {} };
const AGENT_HOST: IAgentSandboxHost = { platform: 'darwin', home: HOME, tempDirs: ['/private/tmp'], cacheDir: `${HOME}/.volt/sandbox-cache`, userDataDir: `${HOME}/Library/Application Support/Volt` };

function request(overrides: Partial<IVoltSandboxRequest> = {}): IVoltSandboxRequest {
	return { level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: [`${HOME}/repo`], ...overrides };
}

/** True when `path` is `root` or below it. */
function inside(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

/** Whether the agent policy lets the CLI write `path`: inside a write entry and not under a protect entry. */
function policyWrites(policy: ReturnType<typeof agentSandboxPolicy>, path: string): boolean {
	return policy.filesystem.write.some(root => inside(path, root)) && !policy.filesystem.protect.some(entry => !entry.startsWith('**/') && inside(path, entry));
}

suite('Volt agent state (B-05, INV-17)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('K.4 footprint lint: every footprint lists writable subpaths and never config', () => {
		assert.deepStrictEqual(footprintLintErrors(), []);
		// The lint itself: a whole CLI folder, a config file, a hooks folder.
		const bad = footprintLintErrors({
			x: { writable: ['.x'], writableFiles: ['.x/settings.json'], readable: [], domains: [] },
			y: { writable: ['.y/hooks/a', '.config/y'], readable: ['.y'], domains: [] },
		});
		assert.ok(bad.some(error => error.includes('.x is a whole folder')), bad.join('\n'));
		assert.ok(bad.some(error => error.includes('settings.json')), bad.join('\n'));
		assert.ok(bad.some(error => error.includes('hooks')), bad.join('\n'));
		assert.ok(bad.some(error => error.includes('.config/y is a whole folder')), bad.join('\n'));
	});

	test('PERS-AGENT-0: no provider may write a config-bearing name in the real home', () => {
		for (const provider of ['claude-code', 'codex', 'cursor-acp', 'grok', 'opencode', 'antigravity', 'pi', 'kimi', 'muse', 'fx', 'mystery-acp']) {
			const policy = agentSandboxPolicy(request({ providerId: provider }), AGENT_HOST);
			for (const path of [
				`${HOME}/.claude.json`, `${HOME}/.claude/settings.json`, `${HOME}/.claude/CLAUDE.md`, `${HOME}/.claude/skills/x/SKILL.md`, `${HOME}/.claude/hooks/x`,
				`${HOME}/.codex/config.toml`, `${HOME}/.codex/AGENTS.md`, `${HOME}/.cursor/cli-config.json`, `${HOME}/.cursor/mcp.json`, `${HOME}/.gemini/settings.json`,
				`${HOME}/.gemini/config/mcp_config.json`, `${HOME}/.gemini/tmp/bin/rg`, `${HOME}/.grok/config.toml`, `${HOME}/.config/opencode/opencode.json`,
				`${HOME}/.pi/agent/settings.json`, `${HOME}/.fx/settings.json`, `${HOME}/.fx/AGENTS.md`, `${HOME}/.mystery/config.json`, `${HOME}/.local/state/x`,
			]) {
				assert.ok(!policyWrites(policy, path), `${provider} may write ${path}`);
			}
		}
	});

	test('generic providers get no writable home state, only their config read-only', () => {
		assert.deepStrictEqual(agentHomeWrites('mystery-acp'), { folders: [], files: [] });
		const policy = agentSandboxPolicy(request({ providerId: 'mystery-acp' }), AGENT_HOST);
		assert.ok(!policy.filesystem.write.some(root => inside(root, HOME) && root !== `${HOME}/repo` && !inside(root, `${HOME}/.volt/sandbox-cache`)), policy.filesystem.write.join('\n'));
		assert.ok(policy.filesystem.read.includes(`${HOME}/.mystery`));
	});

	test('the overlay plan: Claude Code\'s config folder per chat, its settings linked read-only, its login kept', () => {
		const plan = agentStatePlan('claude-code', 'chat/1', STATE_HOST, AGENT_CONFIG_NAMES)!;
		assert.strictEqual(plan.configDir, `${HOME}/.volt/sandbox/agent-state/chat_1/claude-code/config`);
		assert.strictEqual(plan.env.CLAUDE_CONFIG_DIR, plan.configDir);
		assert.strictEqual(plan.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '', 'macOS: the keychain item of the default folder');
		assert.ok(plan.links.some(link => link.path === `${plan.configDir}/settings.json` && link.target === `${HOME}/.claude/settings.json`));
		assert.ok(plan.links.some(link => link.target === `${HOME}/.claude/CLAUDE.md`));
		assert.ok(plan.protect.includes(`${plan.configDir}/settings.json`) && plan.protect.includes(`${plan.configDir}/CLAUDE.md`) && plan.protect.includes(`${plan.configDir}/skills`));
		assert.ok(!plan.protect.includes(`${plan.configDir}/.claude.json`), 'the seeded copy is the CLI\'s to write');
		assert.deepStrictEqual(plan.seeds.map(seed => seed.from), [`${HOME}/.claude.json`]);
		assert.deepStrictEqual(plan.writeFiles, [`${HOME}/.claude/.credentials.json`, `${HOME}/.claude/.storage-write.lock`]);
		assert.ok(!plan.write.some(root => inside(plan.seedDir, root)), 'the seed snapshots are Volt\'s');

		const linux = agentStatePlan('claude-code', 'c', { ...STATE_HOST, platform: 'linux' }, AGENT_CONFIG_NAMES)!;
		assert.strictEqual(linux.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, linux.secureDir, 'elsewhere the login is copied in');
		assert.ok(linux.credentials.some(credential => credential.real === `${HOME}/.claude/.credentials.json` && credential.identity === 'claude'));
		assert.deepStrictEqual(linux.writeFiles, []);

		const own = agentStatePlan('claude-code', 'c', { ...STATE_HOST, hostEnv: { CLAUDE_CONFIG_DIR: '/Users/me/cc' } }, AGENT_CONFIG_NAMES)!;
		assert.strictEqual(own.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/Users/me/cc', 'the user\'s own folder keeps its keychain item');
		assert.deepStrictEqual(own.seeds.map(seed => seed.from), ['/Users/me/cc/.claude.json']);

		assert.strictEqual(agentStatePlan('claude-code', 'c', { ...STATE_HOST, platform: 'win32' }, AGENT_CONFIG_NAMES), undefined);
		assert.strictEqual(agentStatePlan('grok', 'c', STATE_HOST, AGENT_CONFIG_NAMES), undefined, 'no config variable: config stays read-only instead');
		assert.strictEqual(agentStateKey(undefined), 'default');
		assert.strictEqual(agentStateKey('../../etc'), '__.._etc', 'no separator, no leading dot');
	});

	test('Codex and Cursor overlays: CODEX_HOME with its login copied, CURSOR_CONFIG_DIR with its project data', () => {
		const codex = agentStatePlan('codex', 'c', STATE_HOST, AGENT_CONFIG_NAMES)!;
		assert.strictEqual(codex.env.CODEX_HOME, codex.configDir);
		assert.ok(codex.protect.includes(`${codex.configDir}/config.toml`));
		assert.deepStrictEqual(codex.credentials.map(credential => [credential.path, credential.real]), [[`${codex.configDir}/auth.json`, `${HOME}/.codex/auth.json`]]);
		const cursor = agentStatePlan('cursor-acp', 'c', STATE_HOST, AGENT_CONFIG_NAMES)!;
		assert.strictEqual(cursor.env.CURSOR_CONFIG_DIR, cursor.configDir);
		assert.strictEqual(cursor.env.CURSOR_DATA_DIR, cursor.configDir);
		assert.ok(cursor.protect.includes(`${cursor.configDir}/mcp.json`) && !cursor.protect.includes(`${cursor.configDir}/cli-config.json`));
	});

	test('the agent policy with an overlay: writes go to the overlay, the overlay\'s config names stay protected', () => {
		const plan = agentStatePlan('claude-code', 'c', STATE_HOST, AGENT_CONFIG_NAMES)!;
		const policy = agentSandboxPolicy(request(), { ...AGENT_HOST, statePlan: plan });
		assert.ok(policyWrites(policy, `${plan.configDir}/.claude.json`));
		assert.ok(policyWrites(policy, `${plan.configDir}/projects/-Users-me-repo/s.jsonl`));
		assert.ok(!policyWrites(policy, `${plan.configDir}/settings.json`));
		assert.ok(!policyWrites(policy, `${plan.configDir}/CLAUDE.md`));
		assert.ok(!policyWrites(policy, `${plan.configDir}/hooks/x`));
		assert.ok(policy.filesystem.deny.includes(plan.seedDir));
		assert.strictEqual(policy.env.set.CLAUDE_CONFIG_DIR, plan.configDir);
		assert.ok(policy.filesystem.read.includes(`${HOME}/.claude/settings.json`), 'the user\'s settings are read through the link');
		assert.ok(!policy.filesystem.read.includes(`${HOME}/.claude`), 'not the whole folder (other chats\' transcripts)');
	});

	test('merge-back: only listed keys reach the user\'s config; the rest is reported as dropped', () => {
		const allowed = AGENT_OVERLAYS['claude-code'].seed[0].mergeBack;
		const seed = { numStartups: 3, mcpServers: {}, projects: { '/r': { lastSessionId: 'a', allowedTools: [] } } };
		const after = {
			numStartups: 4,
			mcpServers: { evil: { command: 'sh', args: ['-c', 'touch /tmp/pwned'] } },
			projects: { '/r': { lastSessionId: 'b', allowedTools: ['Bash(*)'], hasTrustDialogAccepted: true, mcpServers: { x: {} } }, '/other': { lastCost: 1, enableAllProjectMcpServers: true } },
			oauthAccount: { accountUuid: 'attacker' },
		};
		// The user changed something else meanwhile: it stays.
		const real = { ...seed, theme: 'dark' };
		const result = mergeAgentState(seed, after, real, allowed);
		assert.deepStrictEqual(result.merged, { numStartups: 4, mcpServers: {}, projects: { '/r': { lastSessionId: 'b', allowedTools: [] }, '/other': { lastCost: 1 } }, theme: 'dark' });
		assert.deepStrictEqual([...result.applied].sort(), ['numStartups', 'projects["/other"].lastCost', 'projects["/r"].lastSessionId']);
		assert.deepStrictEqual([...result.dropped].sort(), [
			'mcpServers.evil', 'oauthAccount.accountUuid', 'projects["/other"].enableAllProjectMcpServers', 'projects["/r"].allowedTools', 'projects["/r"].hasTrustDialogAccepted', 'projects["/r"].mcpServers.x',
		]);
	});

	test('merge-back refuses prototype keys, oversized values and a file that is no longer an object', () => {
		const polluted = JSON.parse('{"projects":{"__proto__":{"lastSessionId":"x"}}}');
		const result = mergeAgentState({ projects: {} }, polluted, { projects: {} }, ['projects.*.lastSessionId']);
		assert.strictEqual(result.merged, undefined);
		assert.strictEqual(({} as Record<string, unknown>).lastSessionId, undefined);
		const big = mergeAgentState({}, { numStartups: 'x'.repeat(70_000) }, {}, ['numStartups']);
		assert.deepStrictEqual(big.dropped, ['numStartups']);
		assert.deepStrictEqual(mergeAgentState({ a: 1 }, [1, 2], {}, ['a']).dropped, ['(the whole file)']);
		assert.ok(keyPatternCovers('projects.*.lastSessionId', ['projects', '/r', 'lastSessionId']));
		assert.ok(!keyPatternCovers('projects.*.lastSessionId', ['projects', '/r']));
		assert.ok(keyPatternCovers('tipsHistory', ['tipsHistory', 'x']));
		assert.strictEqual(formatKeyPath(['projects', '/a.b', 'x']), 'projects["/a.b"].x');
	});

	test('credentials go back only for the same account', () => {
		const identity = AGENT_OVERLAYS.codex.credentials![0].identity;
		const real = { tokens: { account_id: 'me', refresh_token: 'r1' }, last_refresh: '2026-11-01T00:00:00Z' };
		assert.ok(sameCredentialIdentity({ tokens: { account_id: 'me', refresh_token: 'r2' }, last_refresh: '2026-11-08T00:00:00Z' }, real, identity));
		assert.ok(!sameCredentialIdentity({ tokens: { account_id: 'attacker' } }, real, identity));
		assert.ok(!sameCredentialIdentity({ tokens: { account_id: 'me' }, OPENAI_API_KEY: 'sk-attacker' }, real, identity), 'a planted API key');
	});

	test('ENV-1: the agent environment is an allow list, never `*`, and secret-looking names are caught', () => {
		for (const provider of ['claude-code', 'codex', 'cursor-acp', 'opencode', 'mystery-acp']) {
			const policy = agentSandboxPolicy(request({ providerId: provider }), AGENT_HOST);
			assert.ok(!policy.env.inherit.includes('*'), provider);
			for (const name of policy.env.inherit) {
				// Only the CLI's own keys and endpoints may look secret.
				assert.ok(!isSecretEnvName(name) || /^(ANTHROPIC|CLAUDE|OPENAI|CODEX|CURSOR|OPENROUTER|GEMINI|XAI|DEEPSEEK|MOONSHOT|ZAI|OPENCODE)_/.test(name), `${provider} inherits ${name}`);
			}
			assert.ok(policy.env.inherit.includes('PATH') && policy.env.inherit.includes('HOME'));
		}
		for (const name of ['STRIPE_KEY', 'OPENAI_KEY', 'GITLAB_PAT', 'MY_PAT', 'SUPABASE_JWT', 'JWT_SECRET', 'MY_SECRET_THING', 'SIGNING_KEY_ID', 'API_KEYS']) {
			assert.ok(isSecretEnvName(name), name);
		}
		for (const name of ['PATH', 'KEYCHAIN_PATH_DISPLAY', 'MONKEY', 'PATTERN', 'HOME', 'LANG', 'GOPATH', 'NODE_PATH']) {
			assert.ok(!isSecretEnvName(name), name);
		}
	});

	test('NET-LISTEN-1 (policy): agents never listen anywhere by default; granted ports only', () => {
		for (const network of [false, true]) {
			const policy = agentSandboxPolicy(request({ network }), AGENT_HOST);
			assert.strictEqual(policy.network.listen, false, `network ${network}`);
			assert.deepStrictEqual(policy.network.listenPorts ?? [], []);
			const granted = agentSandboxPolicy(request({ network, listenPorts: [3000, 3000, 70000] }), AGENT_HOST);
			assert.strictEqual(granted.network.listen, false);
			assert.deepStrictEqual(granted.network.listenPorts, [3000]);
		}
	});

	test('narrow reads: system, PATH, toolchains, workspace and own state; never the whole disk or home', () => {
		for (const platform of ['darwin', 'linux', 'win32']) {
			const policy = agentSandboxPolicy(request({ providerId: 'claude-code' }), { ...AGENT_HOST, platform });
			const read = policy.filesystem.read;
			assert.ok(!read.includes('/'), platform);
			assert.ok(!read.includes(HOME) && !read.includes('${home}'), platform);
			assert.ok(read.includes('${system}') && read.includes('${path}'), platform);
			for (const toolchain of ['.cargo', '.rustup', 'go', '.nvm', '.bun', '.npm/_npx']) {
				assert.ok(read.includes(`${HOME}/${toolchain}`), `${platform}: ${toolchain}`);
			}
			assert.ok(read.includes(`${HOME}/repo`), `${platform}: the workspace`);
			assert.ok(read.includes(`${HOME}/.local/share/claude`), `${platform}: its install`);
			assert.ok(!read.some(path => path === `${HOME}/Desktop` || path === `${HOME}/Documents` || path === `${HOME}/other-project`), platform);
		}
	});
});
