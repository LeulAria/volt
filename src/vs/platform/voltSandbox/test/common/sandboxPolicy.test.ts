/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { denialKindForOperation, denialsInOutput, describeDenial, folderToAllow, isNoiseDenial } from '../../common/sandboxDenials.js';
import { agentApiDomains, codexSandboxValue, domainAllowed, isAgentHousekeepingDenial, ISandboxHostInfo, isPathInside, IVoltSandboxRequest, IVoltSandboxSettings, nativeSandboxOffArgs, normalizeSandboxLevel, planAllowsWrite, resolveSandboxPlan, sandboxLaunchKey, sandboxStrategy, sandboxWorkspaceRoots, withAllowedDomain, withWritableRoot } from '../../common/sandboxPolicy.js';
import { parseSeatbeltLogLine, sbplRegex, sbplString } from '../../common/seatbelt.js';
import { protectedEditTarget } from '../../common/sandboxProfiles.js';
import { isUserFacingDenial } from '../../common/sandboxWorkloads.js';

/** Who writes a real refusal to the unified log. */
const KERNEL_SANDBOX = '/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox';
const MAC: ISandboxHostInfo = { platform: 'darwin', home: '/Users/me', tmpdir: '/private/var/folders/ab/xyz/T', darwinUserCacheDir: '/private/var/folders/ab/xyz/C', uid: 501 };

function request(overrides: Partial<IVoltSandboxRequest> = {}): IVoltSandboxRequest {
	return { level: 'workspace-write', network: true, providerId: 'claude-code', workspaceRoots: ['/Users/me/repo'], ...overrides };
}

suite('Volt sandbox policy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('levels normalize to off', () => {
		assert.strictEqual(normalizeSandboxLevel('read-only'), 'read-only');
		assert.strictEqual(normalizeSandboxLevel('workspace-write'), 'workspace-write');
		assert.strictEqual(normalizeSandboxLevel('nope'), 'off');
		assert.strictEqual(normalizeSandboxLevel(undefined), 'off');
	});

	test('cursor: its settings (cli-config.json, with command allow lists) are saved in the chat\'s overlay, never in place (B-05)', () => {
		const plan = resolveSandboxPlan({ ...request(), providerId: 'cursor-acp' }, MAC);
		assert.ok(!planAllowsWrite(plan, `${MAC.home}/.cursor/cli-config.json`), 'it holds permissions.allow');
		assert.ok(planAllowsWrite(plan, `${MAC.home}/.volt/sandbox/agent-state/chat/cursor-acp/config/cli-config.json`), 'choosing a model rewrites the overlay copy');
		assert.ok(!planAllowsWrite(plan, `${MAC.home}/.cursor/hooks.json`));
		assert.ok(!planAllowsWrite(plan, `${MAC.home}/.cursor/mcp.json`));
	});

	test('workspace-write: workspace, temp and the agent state are writable; nothing else', () => {
		const plan = resolveSandboxPlan(request(), MAC);
		assert.ok(planAllowsWrite(plan, '/Users/me/repo/src/a.ts'));
		assert.ok(planAllowsWrite(plan, '/Users/me/repo'));
		assert.ok(planAllowsWrite(plan, '/private/tmp/x'));
		assert.ok(planAllowsWrite(plan, '/tmp/x'), 'the /tmp alias of /private/tmp');
		assert.ok(planAllowsWrite(plan, '/private/var/folders/ab/xyz/T/node-123'));
		// B-05: Claude Code's state is a per-chat overlay; its MCP servers in ~/.claude.json are never writable in place.
		assert.ok(planAllowsWrite(plan, '/Users/me/.volt/sandbox/agent-state/chat/claude-code/config/projects/p/s.jsonl'));
		assert.ok(!planAllowsWrite(plan, '/Users/me/.claude/projects/p/s.jsonl'));
		assert.ok(!planAllowsWrite(plan, '/Users/me/.claude.json'));
		assert.ok(!planAllowsWrite(plan, '/Users/me/.claude.json.tmp.123.abc'), 'nor its atomic write sibling');
		assert.ok(planAllowsWrite(plan, '/Users/me/Library/Caches/claude-cli-nodejs/log.txt'));
		assert.ok(!planAllowsWrite(plan, '/Users/me/.npm/_npx/x/node_modules/.bin/adapter'), 'shared caches hold code Volt runs later');
		assert.ok(!planAllowsWrite(plan, '/Users/me/notes.txt'));
		assert.ok(!planAllowsWrite(plan, '/Users/me/repo-other/a'), 'a sibling folder with the same prefix');
		assert.ok(!planAllowsWrite(plan, '/Users/me/.claude.jsonx'));
		assert.ok(!planAllowsWrite(plan, '/etc/hosts'));
		assert.ok(!planAllowsWrite(plan, 'relative/path'));
	});

	test('code that runs later outside the sandbox is never writable', () => {
		const plan = resolveSandboxPlan(request(), MAC);
		assert.ok(!planAllowsWrite(plan, '/Users/me/repo/.git/hooks/pre-commit'));
		assert.ok(!planAllowsWrite(plan, '/Users/me/repo/.git/config'));
		assert.ok(planAllowsWrite(plan, '/Users/me/repo/.git/index'), 'commits still work');
		assert.ok(!planAllowsWrite(plan, '/Users/me/repo/.vscode/tasks.json'));
		assert.ok(!planAllowsWrite(plan, '/Users/me/repo/.claude/settings.json'));
		assert.ok(!planAllowsWrite(plan, '/Users/me/.claude/settings.json'), 'Claude Code hooks live here');
		assert.ok(!planAllowsWrite(plan, '/Users/me/.claude/commands/x.md'));
		assert.ok(!planAllowsWrite(plan, '/Users/me/.zshrc'));
	});

	test('a worktree\'s git common dir is writable but its hooks and config are not', () => {
		const plan = resolveSandboxPlan(request({ workspaceRoots: ['/Users/me/wt', '/Users/me/repo/.git'] }), MAC);
		assert.ok(planAllowsWrite(plan, '/Users/me/repo/.git/objects/ab/cd'));
		assert.ok(planAllowsWrite(plan, '/Users/me/repo/.git/worktrees/wt/index'));
		assert.ok(!planAllowsWrite(plan, '/Users/me/repo/.git/hooks/post-checkout'));
		assert.ok(!planAllowsWrite(plan, '/Users/me/repo/.git/config'));
		assert.ok(!planAllowsWrite(plan, '/Users/me/repo/src/a.ts'), 'the main checkout itself stays read-only');
	});

	test('read-only: the workspace is not writable, allowed folders and temp still are', () => {
		const plan = resolveSandboxPlan(request({ level: 'read-only', extraWritableRoots: ['/Users/me/scratch'] }), MAC);
		assert.ok(!planAllowsWrite(plan, '/Users/me/repo/a.ts'));
		assert.ok(planAllowsWrite(plan, '/Users/me/scratch/out.txt'));
		assert.ok(planAllowsWrite(plan, '/private/tmp/x'));
		assert.ok(planAllowsWrite(plan, '/Users/me/.volt/sandbox/agent-state/chat/claude-code/config/sessions/x'), 'the agent\'s own state (its overlay)');
	});

	test('read-only holds for a workspace inside temp', () => {
		const plan = resolveSandboxPlan(request({ level: 'read-only', workspaceRoots: ['/private/tmp/repo'] }), MAC);
		assert.ok(!planAllowsWrite(plan, '/private/tmp/repo/a.ts'));
		assert.ok(!planAllowsWrite(plan, '/tmp/repo/a.ts'), 'through the /tmp alias too');
		assert.ok(planAllowsWrite(plan, '/private/tmp/other.txt'));
	});

	test('the home folder and / are never accepted as roots', () => {
		const plan = resolveSandboxPlan(request({ workspaceRoots: ['/Users/me', '/', '/Users/me/'], extraWritableRoots: ['/'] }), MAC);
		assert.ok(!planAllowsWrite(plan, '/Users/me/notes.txt'));
		assert.ok(!planAllowsWrite(plan, '/opt/x'));
	});

	test('agent footprints keep each CLI working', () => {
		const cursor = resolveSandboxPlan(request({ providerId: 'cursor-acp' }), MAC);
		assert.ok(planAllowsWrite(cursor, '/Users/me/.volt/sandbox/agent-state/chat/cursor-acp/config/projects/x/state.json'), 'its project data lives in the overlay');
		assert.ok(!planAllowsWrite(cursor, '/Users/me/.cursor/projects/x/mcp-approvals.json'), 'never in place: MCP approvals live there');
		assert.ok(planAllowsWrite(cursor, '/Users/me/.cursor/auth.json'), 'its own login refresh');
		assert.ok(!planAllowsWrite(cursor, '/Users/me/.local/share/cursor-agent/versions/x'), 'the CLI\'s own binaries');
		assert.ok(!planAllowsWrite(cursor, '/Users/me/.cursor/mcp.json'));
		const grok = resolveSandboxPlan(request({ providerId: 'grok' }), MAC);
		assert.ok(planAllowsWrite(grok, '/Users/me/.grok/sessions/x'));
		assert.ok(!planAllowsWrite(grok, '/Users/me/.grok/config.toml'));
		assert.ok(!planAllowsWrite(grok, '/Users/me/.grok/installed-plugins/x'));
		const opencode = resolveSandboxPlan(request({ providerId: 'opencode' }), MAC);
		assert.ok(planAllowsWrite(opencode, '/Users/me/.local/share/opencode/storage/x'));
		assert.ok(!planAllowsWrite(opencode, '/Users/me/.local/share/opencode/bin/x'), 'its own binaries');
		assert.ok(!planAllowsWrite(opencode, '/Users/me/.cache/opencode/models.json'), 'caches are redirected to a sandbox-only folder');
		assert.ok(!planAllowsWrite(opencode, '/Users/me/.config/opencode/opencode.json'));
		const gemini = resolveSandboxPlan(request({ providerId: 'antigravity' }), MAC);
		assert.ok(!planAllowsWrite(gemini, '/Users/me/.gemini/settings.json'), 'MCP servers and hooks');
		assert.ok(!planAllowsWrite(gemini, '/Users/me/.gemini/tmp/bin/rg'), 'a binary the CLI runs later');
		assert.ok(planAllowsWrite(gemini, '/Users/me/.gemini/tmp/abc/chats/x.json'));
		const unknown = resolveSandboxPlan(request({ providerId: 'mystery-acp' }), MAC);
		assert.ok(!planAllowsWrite(unknown, '/Users/me/.mystery/state'), 'B-05: an unknown CLI gets no writable home state');
		assert.ok(!planAllowsWrite(unknown, '/Users/me/.claude/x'), 'another agent\'s state is not shared');
	});

	test('network off: the agent API plus allowed hosts; on: the same plus the package registries', () => {
		const off = resolveSandboxPlan(request({ network: false, allowedDomains: ['Example.org'] }), MAC);
		assert.strictEqual(off.network, 'proxy');
		assert.ok(domainAllowed('api.anthropic.com', off.allowedDomains));
		assert.ok(domainAllowed('example.org', off.allowedDomains));
		assert.ok(domainAllowed('registry.npmjs.org', off.allowedDomains), 'the npx adapter');
		assert.ok(!domainAllowed('evil.com', off.allowedDomains));
		assert.ok(!domainAllowed('anthropic.com.evil.com', off.allowedDomains));
		// Network on: hostname rules too (the broker), with the package registries added.
		const on = resolveSandboxPlan(request({ allowedDomains: ['example.org'] }), MAC);
		assert.strictEqual(on.network, 'proxy');
		assert.ok(domainAllowed('api.anthropic.com', on.allowedDomains) && domainAllowed('pypi.org', on.allowedDomains) && domainAllowed('example.org', on.allowedDomains));
		assert.ok(!domainAllowed('evil.com', on.allowedDomains));
		assert.ok(!domainAllowed('pypi.org', off.allowedDomains), 'registries only with the network on');
	});

	test('domain patterns', () => {
		assert.ok(domainAllowed('a.b.cursor.sh', ['*.cursor.sh']));
		assert.ok(domainAllowed('cursor.sh', ['*.cursor.sh']));
		assert.ok(!domainAllowed('xcursor.sh', ['*.cursor.sh']));
		assert.ok(domainAllowed('localhost', []));
		assert.ok(domainAllowed('127.0.0.1', []));
		assert.ok(domainAllowed('API.OPENAI.COM.', ['api.openai.com']));
		assert.ok(!domainAllowed('', ['*']));
		assert.ok(domainAllowed('anything.io', ['*']));
		assert.ok(agentApiDomains('codex').includes('chatgpt.com'));
	});

	test('strategy: every agent is wrapped at every sandboxed level, Codex included (B-10, D-16)', () => {
		assert.strictEqual(sandboxStrategy('codex', 'workspace-write', 'darwin'), 'wrap');
		assert.strictEqual(sandboxStrategy('codex', 'workspace-write', 'linux'), 'wrap');
		assert.strictEqual(sandboxStrategy('codex', 'read-only', 'darwin'), 'wrap');
		assert.strictEqual(codexSandboxValue('sandbox', 'workspace-write', sandboxStrategy('codex', 'workspace-write', 'darwin')), 'danger-full-access', 'its own sandbox off inside Volt\'s');
		assert.strictEqual(sandboxStrategy('claude-code', 'workspace-write', 'darwin'), 'wrap');
		assert.strictEqual(sandboxStrategy('claude-code', 'workspace-write', 'linux'), 'wrap');
		assert.strictEqual(sandboxStrategy('claude-code', 'off', 'darwin'), 'none');
		assert.strictEqual(sandboxStrategy('claude-code', 'read-only', 'win32'), 'none');
		assert.deepStrictEqual(nativeSandboxOffArgs('cursor-acp'), ['--sandbox', 'disabled']);
		assert.deepStrictEqual(nativeSandboxOffArgs('claude-code'), []);
	});


	test('paths', () => {
		assert.ok(isPathInside('/a/b/c', '/a/b'));
		assert.ok(isPathInside('/a/b', '/a/b/'));
		assert.ok(!isPathInside('/a/bc', '/a/b'));
		assert.ok(isPathInside('/x', '/'));
	});
});

suite('Volt sandbox Seatbelt helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();


	test('quoting', () => {
		assert.strictEqual(sbplString('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
		assert.strictEqual(sbplRegex('/Users/me/.claude.json', '\\.lock'), '#"^/Users/me/\\.claude\\.json\\.lock$"');
		assert.strictEqual(sbplRegex('/a/.git', '', true), '#"^/[aA]/\\.[gG][iI][tT]$"', 'case-insensitive form for denies');
	});

	test('kernel log lines are parsed and attributed by tag', () => {
		const ndjson = JSON.stringify({ eventMessage: 'Sandbox: touch(49447) deny(1) file-write-create /Users/me/Desktop/x y.txt\nVOLTSBX-abc123', processID: 0, senderImagePath: KERNEL_SANDBOX });
		assert.deepStrictEqual(parseSeatbeltLogLine(ndjson), { process: 'touch', pid: 49447, operation: 'file-write-create', target: '/Users/me/Desktop/x y.txt', tag: 'abc123' });
		assert.deepStrictEqual(parseSeatbeltLogLine('Sandbox: 2.1.291(50239) deny(1) network-outbound 1.2.3.4:443\nVOLTSBX-t9'), { process: '2.1.291', pid: 50239, operation: 'network-outbound', target: '1.2.3.4:443', tag: 't9' });
		assert.strictEqual(parseSeatbeltLogLine(JSON.stringify({ eventMessage: 'Sandbox: x(1) deny(1) file-write-create /a' })), undefined, 'not ours');
		assert.strictEqual(parseSeatbeltLogLine('Filtering the log data using ...'), undefined);
		assert.strictEqual(parseSeatbeltLogLine('{broken'), undefined);
	});

	test('LOG-FORGE-1: a refusal counts only from the kernel\'s Sandbox.kext; a line any process writes with `logger` is ignored', () => {
		// Measured on macOS 26.6: `logger "Sandbox: touch(1) deny(1) file-write-create ~/.ssh/x VOLTSBX-<tag>"` from
		// inside a sandbox reaches a `log stream` whose predicate is only the tag, as processID 9xxxx, sender /usr/bin/logger.
		const forged = 'Sandbox: touch(1) deny(1) file-write-create /Users/me/other-project VOLTSBX-abc123';
		assert.strictEqual(parseSeatbeltLogLine(JSON.stringify({ eventMessage: forged, processID: 96619, senderImagePath: '/usr/bin/logger', processImagePath: '/usr/bin/logger' })), undefined);
		assert.strictEqual(parseSeatbeltLogLine(JSON.stringify({ eventMessage: forged, processID: 0, senderImagePath: '/usr/bin/logger' })), undefined, 'pid 0 alone is not enough');
		assert.strictEqual(parseSeatbeltLogLine(JSON.stringify({ eventMessage: forged })), undefined, 'no origin: not trusted');
		assert.strictEqual(parseSeatbeltLogLine(JSON.stringify({ eventMessage: forged, processID: 0, senderImagePath: KERNEL_SANDBOX }))?.target, '/Users/me/other-project');
	});

	test('LOCAL-DENIAL-1: a refused connection to this machine names its port; elsewhere stays as the kernel said', () => {
		// macOS 26.6 logs `remote:*:<port>` without the address; the `-local` rule says which it was.
		assert.deepStrictEqual(parseSeatbeltLogLine(JSON.stringify({ eventMessage: 'Sandbox: curl(812) deny(1) network-outbound remote:*:5432\nVOLTSBX-abc123-local', processID: 0, senderImagePath: KERNEL_SANDBOX })), { process: 'curl', pid: 812, operation: 'network-outbound', target: 'localhost:5432', tag: 'abc123' });
		assert.deepStrictEqual(parseSeatbeltLogLine('Sandbox: node(9) deny(1) network-outbound remote:*:443\nVOLTSBX-abc123'), { process: 'node', pid: 9, operation: 'network-outbound', target: 'remote:*:443', tag: 'abc123' });
		assert.strictEqual(parseSeatbeltLogLine('Sandbox: node(9) deny(1) network-outbound remote:*:22\nVOLTSBX-abc123-local')?.tag, 'abc123', 'attributed to its run');
	});
});


suite('Volt sandbox denials', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('denials named in command output', () => {
		const out = [
			'touch: /Users/me/outside.txt: Operation not permitted',
			'/bin/sh: /Users/me/b.txt: Operation not permitted',
			'touch: cannot touch \'/home/me/c.txt\': Permission denied',
			'PermissionError: [Errno 1] Operation not permitted: \'/Users/me/d.txt\'',
			'Error: EPERM: operation not permitted, open \'/Users/me/e.txt\'',
			'curl: (22) Blocked by Volt sandbox: network access to example.com is off for this chat.',
		].join('\n');
		const targets = denialsInOutput(out).map(d => `${d.kind}:${d.target}`);
		assert.deepStrictEqual(targets.sort(), ['network:example.com', 'write:/Users/me/b.txt', 'write:/Users/me/d.txt', 'write:/Users/me/e.txt', 'write:/Users/me/outside.txt', 'write:/home/me/c.txt'].sort());
		assert.deepStrictEqual(denialsInOutput('all good\nwrote 3 files'), []);
	});

	test('kinds, noise and labels', () => {
		assert.strictEqual(denialKindForOperation('file-write-create'), 'write');
		assert.strictEqual(denialKindForOperation('file-read-data'), 'read');
		assert.strictEqual(denialKindForOperation('network-outbound'), 'network');
		assert.strictEqual(denialKindForOperation('lsopen'), 'launch');
		assert.strictEqual(denialKindForOperation('sysctl-read'), undefined);
		assert.ok(isNoiseDenial({ kind: 'write', target: '/dev/dtracehelper', source: 'os' }));
		assert.ok(isNoiseDenial({ kind: 'write', target: '/Users/me/Library/Caches/com.x/y', source: 'os' }));
		assert.ok(!isNoiseDenial({ kind: 'write', target: '/Users/me/notes.txt', source: 'os' }));
		assert.ok(isNoiseDenial({ kind: 'read', target: '/private/var/run/utmpx', source: 'os' }));
		assert.ok(isNoiseDenial({ kind: 'write', target: '/var/run/utmp', source: 'os' }));
		assert.ok(!isNoiseDenial({ kind: 'write', target: '/private/var/run/notes.txt', source: 'os' }));
		// Claude Code's start-up knock on other sessions' sockets: still refused, no card.
		assert.ok(isNoiseDenial({ kind: 'network', target: '/private/tmp/cc-socks/68979.sock', source: 'os' }));
		assert.ok(!isNoiseDenial({ kind: 'network', target: '/private/tmp/other/68979.sock', source: 'os' }));
		assert.ok(!isNoiseDenial({ kind: 'write', target: '/private/tmp/cc-socks/68979.sock', source: 'os' }));
		assert.strictEqual(describeDenial({ kind: 'write', target: '/Users/me/notes.txt', source: 'os' }, '/Users/me'), 'Sandbox blocked a write to ~/notes.txt');
		assert.strictEqual(folderToAllow('/Users/me/out/a.txt', false), '/Users/me/out');
		assert.strictEqual(folderToAllow('/Users/me/out/', true), '/Users/me/out');
	});

	test('HOUSEKEEPING-1: the agent CLI\'s own background state, the run\'s canary and the home listing are never offered; real edits still are', () => {
		const home = '/Users/me';
		const quiet = (kind: 'read' | 'write' | 'network' | 'launch', target: string, own: { sentinel?: string; realConfig?: string } = {}, providerId = 'claude-code') => isAgentHousekeepingDenial(providerId, home, { kind, target }, own);
		// What Claude Code writes on its own at start (seen as "Blocked by the sandbox" cards in a fresh chat).
		for (const target of ['/Users/me/.claude/skills/synced/0b1c/manifest.json', '/Users/me/.claude/skills/.trash', '/Users/me/.claude/plugins/store', '/Users/me/.claude/sessions/123.key.tmp', '/Users/me/.claude.json', '/Users/me/.local/state/claude/locks', '/Users/me/.cache/claude/staging/x']) {
			assert.ok(quiet('write', target), target);
		}
		// Plugins synced from claude.ai and the marketplace list's lock (2026-11-12: four cards in every new sandboxed chat).
		for (const target of ['/Users/me/.claude/plugins/known_marketplaces_claudeai.json.lock', '/Users/me/.claude/plugins/synced/bb14_5f1e/.last-complete-round', '/Users/me/.claude/plugins/synced/bb14_5f1e/.marketplaces.json.tmp.7bd7a611', '/Users/me/.claude/plugins/synced/bb14_5f1e/manifest.json']) {
			assert.ok(quiet('write', target), target);
		}
		assert.ok(quiet('read', '/Users/me/.local/state/claude/locks'));
		assert.ok(quiet('read', '/Users/me'), 'a look at the home folder itself');
		assert.ok(quiet('read', '/Users'), 'and at its parent');
		assert.ok(quiet('read', '/Users/me/.claude'), 'its real config folder as a folder');
		assert.ok(quiet('read', '/Users/me/.volt/sandbox/runs/volt-sbx-x/canary', { sentinel: '/Users/me/.volt/sandbox/runs/volt-sbx-x/canary' }), 'the attestation canary');
		// A moved config folder (CLAUDE_CONFIG_DIR): its housekeeping there too.
		assert.ok(quiet('write', '/opt/claude-cfg/skills/synced/a/manifest.json', { realConfig: '/opt/claude-cfg' }));
		// Still shown: edits to settings, instructions and skills, anything else in the home folder, other agents, network.
		for (const target of ['/Users/me/.claude/settings.json', '/Users/me/.claude/CLAUDE.md', '/Users/me/.claude/skills/my-skill/SKILL.md', '/Users/me/.claude/hooks/x.sh', '/Users/me/.zshrc', '/Users/me/notes/a.txt', '/Users/me/.claude.json.evil', '/Users/me/.claude-other/x', '/Users/me/.claude/plugins/known_marketplaces_claudeai.json.evil']) {
			assert.ok(!quiet('write', target), target);
		}
		assert.ok(!quiet('read', '/Users/me/notes'), 'a folder below the home folder');
		// What every Claude subagent's first turn logged in a sandboxed chat (2026-11-12): plugin sync,
		// its state folder, XDG and temp path walks, and the Bash tool's zsh reading the user's rc files.
		for (const target of ['/Users/me/.claude/plugins/synced/a_b/.last-complete-round', '/Users/me/.claude/plugins/known_marketplaces_claudeai.json.lock']) {
			assert.ok(quiet('write', target), target);
		}
		for (const target of ['/Users/me/.claude/state', '/Users/me/.config', '/private/var', '/Users/me/.zshrc', '/Users/me/.zshenv']) {
			assert.ok(quiet('read', target), target);
		}
		assert.ok(!quiet('read', '/Users/me/.config/gh/hosts.yml'), 'below ~/.config still shows');
		assert.ok(!quiet('read', '/private/var/root'), 'below the path-walk folders still shows');
		assert.ok(!quiet('read', '/Users/me/notes/.zshrc'), 'an rc file outside the home folder still shows');
		assert.ok(!quiet('read', '/Users/me/.ssh/id_ed25519'));
		assert.ok(!quiet('write', '/Users/me/.claude/skills/synced/x', {}, 'codex'), 'another CLI has its own footprint');
		assert.ok(!quiet('network', 'api.anthropic.com') && !quiet('launch', '/Users/me/.claude/sessions'));
	});

	test('per-chat settings: folders and hosts are added once, and the launch key follows them', () => {
		const base: IVoltSandboxSettings = { level: 'workspace-write', network: false };
		const withOut = withWritableRoot(base, '/Users/me/out');
		assert.deepStrictEqual(withOut.extraWritableRoots, ['/Users/me/out']);
		assert.strictEqual(withWritableRoot(withOut, '/Users/me/out/deep'), withOut, 'a folder already inside a root is not added again');
		assert.strictEqual(withWritableRoot(base, 'relative/path'), base, 'only absolute folders are accepted');
		assert.deepStrictEqual(withWritableRoot(withOut, '/Users/me').extraWritableRoots, ['/Users/me'], 'a parent replaces the children it covers');

		const withHost = withAllowedDomain(base, 'API.Example.com');
		assert.deepStrictEqual(withHost.allowedDomains, ['api.example.com']);
		assert.strictEqual(withAllowedDomain(withHost, 'api.example.com'), withHost);

		assert.strictEqual(sandboxLaunchKey(undefined), 'off');
		assert.strictEqual(sandboxLaunchKey({ level: 'off', network: true }), 'off');
		assert.notStrictEqual(sandboxLaunchKey(base), sandboxLaunchKey(withOut), 'a new writable folder restarts the agent');
		const ab = { ...base, extraWritableRoots: ['/a', '/b'] };
		assert.strictEqual(sandboxLaunchKey(ab), sandboxLaunchKey({ ...base, extraWritableRoots: ['/b', '/a'] }), 'root order does not change the key');
	});

	test('workspace roots: the checkout, plus the main repository git dir for a linked worktree', () => {
		assert.deepStrictEqual(sandboxWorkspaceRoots('/Users/me/wt', '/Users/me/repo', true), ['/Users/me/wt', '/Users/me/repo/.git']);
		assert.deepStrictEqual(sandboxWorkspaceRoots('/Users/me/repo', '/Users/me/repo', false), ['/Users/me/repo']);
		assert.deepStrictEqual(sandboxWorkspaceRoots(undefined, undefined, true), []);
	});

	test('Codex config values follow the strategy that wraps or keeps its own sandbox', () => {
		assert.strictEqual(codexSandboxValue('sandbox', 'workspace-write', 'native'), 'workspace-write');
		assert.strictEqual(codexSandboxValue('sandbox', 'danger-full-access', 'native'), 'workspace-write');
		assert.strictEqual(codexSandboxValue('sandbox', 'read-only', 'wrap'), 'danger-full-access');
		assert.strictEqual(codexSandboxValue('mode', 'agent-full-access', 'native'), 'agent');
		assert.strictEqual(codexSandboxValue('mode', 'agent', 'wrap'), 'agent-full-access');
		assert.strictEqual(codexSandboxValue('model', 'gpt-5', 'wrap'), 'gpt-5');
		assert.strictEqual(codexSandboxValue('sandbox', true, 'wrap'), true);
		assert.strictEqual(codexSandboxValue('sandbox', 'read-only', 'none'), 'read-only');
	});

	test('instruction files and hooks other tools run later are never writable', () => {
		const plan = resolveSandboxPlan(request(), MAC);
		assert.ok(!planAllowsWrite(plan, '/Users/me/repo/.husky/pre-commit'));
		assert.ok(!planAllowsWrite(plan, '/Users/me/repo/.envrc'));
		assert.ok(!planAllowsWrite(plan, '/Users/me/.claude/CLAUDE.md'), 'read into every later Claude Code session');
		assert.ok(!planAllowsWrite(resolveSandboxPlan(request({ providerId: 'codex' }), MAC), '/Users/me/.codex/AGENTS.md'));
	});
});

suite('Volt sandbox: edits through the window and host warnings (e2e review)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('EDIT-GUARD-1: an edit to what the sandbox keeps read-only is named; ordinary project files are not', () => {
		assert.strictEqual(protectedEditTarget('/repo/.git/hooks/post-merge'), '.git/hooks');
		assert.strictEqual(protectedEditTarget('/repo/.git/config'), '.git/config');
		assert.strictEqual(protectedEditTarget('/repo/sub/.git/info/attributes'), '.git/info');
		assert.strictEqual(protectedEditTarget('/repo/.vscode/tasks.json'), '.vscode');
		assert.strictEqual(protectedEditTarget('/repo/packages/a/.vscode/settings.json'), '.vscode');
		assert.strictEqual(protectedEditTarget('/repo/.husky/pre-commit'), '.husky');
		assert.strictEqual(protectedEditTarget('/repo/.claude/settings.json'), '.claude/settings.json');
		assert.strictEqual(protectedEditTarget('/repo/.mcp.json'), '.mcp.json');
		for (const path of ['/repo/src/a.ts', '/repo/lab-notes.md', '/repo/.git/COMMIT_EDITMSG', '/repo/refs/notes.md', '/repo/objects/model.ts', '/repo/HEAD.md', '/repo/.claude/notes.md', '/repo/.vscodeignore', '/repo/docs/.github/x.md']) {
			assert.strictEqual(protectedEditTarget(path), undefined, path);
		}
	});

	test('HOST-WARN-1: a host is warned about what it tried, not the runtime\'s own denials', () => {
		assert.ok(isUserFacingDenial({ kind: 'read', target: '/Users/me/.ssh/id_ed25519' }));
		assert.ok(isUserFacingDenial({ kind: 'write', target: '/private/var/folders/x/T/volt-sbx-other/tmp/f' }), 'another run\'s temp');
		assert.ok(isUserFacingDenial({ kind: 'network', target: 'example.com:443' }));
		assert.ok(!isUserFacingDenial({ kind: 'launch', target: 'com.apple.logd' }));
		assert.ok(!isUserFacingDenial({ kind: 'read', target: '/private/var/folders/x/T/runs/volt-sbx-abc/canary' }), 'the run\'s own canary');
		assert.ok(!isUserFacingDenial({ kind: 'read', target: '/Library/Preferences/Logging/com.apple.diagnosticd.filter.plist' }));
		assert.ok(!isUserFacingDenial({ kind: 'read', target: '/Users/me/.CFUserTextEncoding' }));
		assert.ok(!isUserFacingDenial({ kind: 'read', target: '/dev/dtracehelper' }));
	});
});
