/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { bwrapArgs, landlockArgs } from '../../common/landlock.js';
import { denialKindForOperation, denialsInOutput, describeDenial, folderToAllow, isNoiseDenial } from '../../common/sandboxDenials.js';
import { agentApiDomains, codexSandboxValue, domainAllowed, ISandboxHostInfo, isPathInside, IVoltSandboxRequest, IVoltSandboxSettings, nativeSandboxOffArgs, normalizeSandboxLevel, planAllowsWrite, resolveSandboxPlan, sandboxEnv, sandboxLaunchKey, sandboxStrategy, sandboxWorkspaceRoots, withAllowedDomain, withWritableRoot } from '../../common/sandboxPolicy.js';
import { buildSeatbeltProfile, parseSeatbeltLogLine, sbplRegex, sbplString, seatbeltCommand } from '../../common/seatbelt.js';

const MAC: ISandboxHostInfo = { platform: 'darwin', home: '/Users/me', tmpdir: '/private/var/folders/ab/xyz/T', darwinUserCacheDir: '/private/var/folders/ab/xyz/C', uid: 501 };
const LINUX: ISandboxHostInfo = { platform: 'linux', home: '/home/me', tmpdir: '/tmp', uid: 1000 };

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

	test('cursor: the CLI may save its own settings (cli-config.json) but not its hooks or MCP config', () => {
		const plan = resolveSandboxPlan({ ...request(), providerId: 'cursor-acp' }, MAC);
		assert.ok(planAllowsWrite(plan, `${MAC.home}/.cursor/cli-config.json`), 'choosing a model rewrites it');
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
		assert.ok(planAllowsWrite(plan, '/Users/me/.claude/projects/p/s.jsonl'));
		assert.ok(planAllowsWrite(plan, '/Users/me/.claude.json'));
		assert.ok(planAllowsWrite(plan, '/Users/me/.claude.json.tmp.123.abc'), 'atomic write sibling');
		assert.ok(planAllowsWrite(plan, '/Users/me/.npm/_cacache/x'));
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
		assert.ok(planAllowsWrite(plan, '/Users/me/.claude/sessions/x'));
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
		assert.ok(planAllowsWrite(cursor, '/Users/me/.cursor/projects/x/state.json'));
		assert.ok(planAllowsWrite(cursor, '/Users/me/.local/share/cursor-agent/versions/x'));
		assert.ok(!planAllowsWrite(cursor, '/Users/me/.cursor/mcp.json'));
		const grok = resolveSandboxPlan(request({ providerId: 'grok' }), MAC);
		assert.ok(planAllowsWrite(grok, '/Users/me/.grok/sessions/x'));
		const opencode = resolveSandboxPlan(request({ providerId: 'opencode' }), MAC);
		assert.ok(planAllowsWrite(opencode, '/Users/me/.local/share/opencode/storage/x'));
		assert.ok(planAllowsWrite(opencode, '/Users/me/.cache/opencode/models.json'));
		assert.ok(!planAllowsWrite(opencode, '/Users/me/.config/opencode/opencode.json'));
		const unknown = resolveSandboxPlan(request({ providerId: 'mystery-acp' }), MAC);
		assert.ok(planAllowsWrite(unknown, '/Users/me/.mystery/state'));
		assert.ok(!planAllowsWrite(unknown, '/Users/me/.claude/x'), 'another agent\'s state is not shared');
	});

	test('network off: the agent API plus allowed hosts; on: no proxy', () => {
		const off = resolveSandboxPlan(request({ network: false, allowedDomains: ['Example.org'] }), MAC);
		assert.strictEqual(off.network, 'proxy');
		assert.ok(domainAllowed('api.anthropic.com', off.allowedDomains));
		assert.ok(domainAllowed('example.org', off.allowedDomains));
		assert.ok(domainAllowed('registry.npmjs.org', off.allowedDomains), 'the npx adapter');
		assert.ok(!domainAllowed('evil.com', off.allowedDomains));
		assert.ok(!domainAllowed('anthropic.com.evil.com', off.allowedDomains));
		const on = resolveSandboxPlan(request(), MAC);
		assert.strictEqual(on.network, 'all');
		assert.deepStrictEqual(on.allowedDomains, []);
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

	test('strategy: Codex keeps its own sandbox for workspace-write, everything else is wrapped', () => {
		assert.strictEqual(sandboxStrategy('codex', 'workspace-write', 'darwin'), 'native');
		assert.strictEqual(sandboxStrategy('codex', 'read-only', 'darwin'), 'wrap');
		assert.strictEqual(sandboxStrategy('claude-code', 'workspace-write', 'darwin'), 'wrap');
		assert.strictEqual(sandboxStrategy('claude-code', 'workspace-write', 'linux'), 'wrap');
		assert.strictEqual(sandboxStrategy('claude-code', 'off', 'darwin'), 'none');
		assert.strictEqual(sandboxStrategy('claude-code', 'read-only', 'win32'), 'none');
		assert.deepStrictEqual(nativeSandboxOffArgs('cursor-acp'), ['--sandbox', 'disabled']);
		assert.deepStrictEqual(nativeSandboxOffArgs('claude-code'), []);
	});

	test('environment routes HTTP through the proxy only when network is off', () => {
		const off = resolveSandboxPlan(request({ network: false }), MAC);
		const env = sandboxEnv(off, 'http://127.0.0.1:5000', 'tag1');
		assert.strictEqual(env.HTTPS_PROXY, 'http://127.0.0.1:5000');
		assert.strictEqual(env.https_proxy, 'http://127.0.0.1:5000');
		assert.ok(env.NO_PROXY.includes('127.0.0.1'));
		assert.strictEqual(env.VOLT_SANDBOX, 'workspace-write');
		assert.strictEqual(env.VOLT_SANDBOX_NETWORK_DISABLED, '1');
		const on = sandboxEnv(resolveSandboxPlan(request(), MAC), undefined, 'tag1');
		assert.strictEqual(on.HTTPS_PROXY, undefined);
		assert.strictEqual(on.VOLT_SANDBOX_NETWORK_DISABLED, undefined);
	});

	test('paths', () => {
		assert.ok(isPathInside('/a/b/c', '/a/b'));
		assert.ok(isPathInside('/a/b', '/a/b/'));
		assert.ok(!isPathInside('/a/bc', '/a/b'));
		assert.ok(isPathInside('/x', '/'));
	});
});

suite('Volt sandbox Seatbelt profile', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('denies writes by default, then allows the plan, then re-denies dangerous paths', () => {
		const profile = buildSeatbeltProfile(resolveSandboxPlan(request(), MAC), 'abc123');
		const denyAll = profile.indexOf('(deny file-write* (with message "VOLTSBX-abc123"))');
		const allow = profile.indexOf('(allow file-write*');
		const denyHooks = profile.indexOf('(subpath "/Users/me/repo/.git/hooks")');
		assert.ok(denyAll > 0 && allow > denyAll && denyHooks > allow, 'order matters: the last matching rule wins');
		assert.ok(profile.startsWith('(version 1)'));
		assert.ok(profile.includes('(allow default)'));
		assert.ok(profile.includes('(subpath "/Users/me/repo")'));
		assert.ok(profile.includes('(literal "/Users/me/.claude.json")'));
		assert.ok(profile.includes('(deny lsopen'));
		assert.ok(profile.includes('(deny appleevent-send'));
		assert.ok(profile.includes('(subpath "/Users/me/.aws")'));
		assert.ok(!profile.includes('network-outbound'), 'network on: untouched');
	});

	test('network off allows loopback only', () => {
		const profile = buildSeatbeltProfile(resolveSandboxPlan(request({ network: false }), MAC), 't');
		assert.ok(profile.includes('(deny network-outbound (with message "VOLTSBX-t"))'));
		assert.ok(profile.includes('(allow network-outbound (remote ip "localhost:*"))'));
	});

	test('quoting', () => {
		assert.strictEqual(sbplString('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
		assert.strictEqual(sbplRegex('/Users/me/.claude.json', '\\.lock'), '#"^/Users/me/\\.claude\\.json\\.lock$"');
		assert.deepStrictEqual(seatbeltCommand('(version 1)', 'claude', ['-p']), { command: '/usr/bin/sandbox-exec', args: ['-p', '(version 1)', '--', 'claude', '-p'] });
	});

	test('kernel log lines are parsed and attributed by tag', () => {
		const ndjson = JSON.stringify({ eventMessage: 'Sandbox: touch(49447) deny(1) file-write-create /Users/me/Desktop/x y.txt\nVOLTSBX-abc123' });
		assert.deepStrictEqual(parseSeatbeltLogLine(ndjson), { process: 'touch', pid: 49447, operation: 'file-write-create', target: '/Users/me/Desktop/x y.txt', tag: 'abc123' });
		assert.deepStrictEqual(parseSeatbeltLogLine('Sandbox: 2.1.291(50239) deny(1) network-outbound 1.2.3.4:443\nVOLTSBX-t9'), { process: '2.1.291', pid: 50239, operation: 'network-outbound', target: '1.2.3.4:443', tag: 't9' });
		assert.strictEqual(parseSeatbeltLogLine(JSON.stringify({ eventMessage: 'Sandbox: x(1) deny(1) file-write-create /a' })), undefined, 'not ours');
		assert.strictEqual(parseSeatbeltLogLine('Filtering the log data using ...'), undefined);
		assert.strictEqual(parseSeatbeltLogLine('{broken'), undefined);
	});
});

suite('Volt sandbox Linux', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Landlock helper arguments', () => {
		const plan = resolveSandboxPlan(request({ workspaceRoots: ['/home/me/repo'], network: false }), LINUX);
		const args = landlockArgs(plan, [4000, 5000]);
		const pairs = (flag: string) => args.flatMap((arg, i) => arg === flag ? [args[i + 1]] : []);
		assert.ok(pairs('--rw').includes('/home/me/repo'));
		assert.ok(pairs('--rw').includes('/tmp'));
		assert.ok(pairs('--rw').includes('/dev'));
		assert.ok(!pairs('--rw').includes('/private/tmp'), 'no macOS aliases on Linux');
		assert.ok(pairs('--protect').includes('/home/me/repo/.git/hooks'));
		assert.ok(pairs('--hide').includes('/home/me/.aws'));
		assert.ok(args.includes('--restrict-net'));
		assert.deepStrictEqual(pairs('--connect'), ['4000', '5000']);
		const open = landlockArgs(resolveSandboxPlan(request({ workspaceRoots: ['/home/me/repo'] }), LINUX), [4000]);
		assert.ok(!open.includes('--restrict-net'));
	});

	test('bubblewrap fallback binds the plan', () => {
		const args = bwrapArgs(resolveSandboxPlan(request({ workspaceRoots: ['/home/me/repo'] }), LINUX));
		assert.deepStrictEqual(args.slice(0, 3), ['--ro-bind', '/', '/']);
		assert.ok(args.join(' ').includes('--bind-try /home/me/repo /home/me/repo'));
		assert.ok(args.join(' ').includes('--ro-bind-try /home/me/repo/.git/hooks /home/me/repo/.git/hooks'));
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
		assert.strictEqual(describeDenial({ kind: 'write', target: '/Users/me/notes.txt', source: 'os' }, '/Users/me'), 'Sandbox blocked a write to ~/notes.txt');
		assert.strictEqual(folderToAllow('/Users/me/out/a.txt', false), '/Users/me/out');
		assert.strictEqual(folderToAllow('/Users/me/out/', true), '/Users/me/out');
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
});
