/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { allEnforcement, checkEnforcement, dimensionsUsed, ISandboxBackendCapabilities, redactSandboxText } from '../../common/sandboxBackend.js';
import { describeCapabilities, evaluateCapabilities } from '../../common/sandboxCapabilities.js';
import { allowCovers, composeSandboxPolicy, entryInside } from '../../common/sandboxComposition.js';
import { agentSandboxPolicy, IAgentSandboxHost } from '../../common/sandboxPolicy.js';
import { builtinProfile, gitDirWritable, isReservedEnvName, isSecretEnvName } from '../../common/sandboxProfiles.js';
import { IResolvedSandboxPolicy, resolvedPolicyAllows } from '../../common/sandboxResolved.js';
import { completeSandboxPolicy, networkEntryError, parseSandboxPolicy, parseSandboxPolicyLayer, parseSandboxPolicyText, pathEntryError, SANDBOX_POLICY_SCHEMA_VERSION } from '../../common/sandboxSchema.js';
import { buildSeatbeltProfile } from '../../common/seatbelt.js';

function errors(input: unknown): string[] {
	const result = parseSandboxPolicyLayer(input);
	return result.ok ? [] : result.errors.map(e => `${e.path}: ${e.message}`);
}

suite('Volt sandbox policy schema', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('built-in profiles carry their own names', () => {
		assert.deepStrictEqual(['restricted', 'workspace', 'network'].map(id => builtinProfile(id as 'restricted').name), ['restricted', 'workspace', 'network']);
	});

	test('a minimal policy completes to the most restrictive values', () => {
		const result = parseSandboxPolicy({ schemaVersion: 1 });
		assert.ok(result.ok);
		assert.deepStrictEqual(result.value.network, { mode: 'none', allow: [], loopbackPorts: [], listen: false });
		assert.deepStrictEqual(result.value.filesystem.write, []);
		assert.deepStrictEqual(result.value.env.inherit, []);
		assert.strictEqual(result.value.host.systemServices, false);
	});

	test('unknown fields, wrong versions and wrong types are errors, never ignored', () => {
		assert.deepStrictEqual(errors({ schemaVersion: 2 }), ['schemaVersion: must be 1']);
		assert.ok(errors({ schemaVersion: 1, extra: true }).includes('extra: is not a known field'));
		assert.ok(errors({ schemaVersion: 1, filesystem: { write: ['${workspace}'], execute: [] } }).includes('filesystem.execute: is not a known field'));
		assert.ok(errors({ schemaVersion: 1, network: { mode: 'internet' } })[0].startsWith('network.mode'));
		assert.ok(errors({ schemaVersion: 1, network: { listen: 'yes' } })[0].startsWith('network.listen'));
		assert.ok(errors({ schemaVersion: 1, process: { limits: { cpuSeconds: 0 } } })[0].startsWith('process.limits.cpuSeconds'));
		assert.ok(errors({ schemaVersion: 1, process: { limits: { cpuSeconds: 1.5 } } })[0].startsWith('process.limits.cpuSeconds'));
		assert.ok(errors({ schemaVersion: 1, bestEffort: ['filesystem.everything'] })[0].startsWith('bestEffort[0]'));
		assert.ok(errors(null).length && errors([]).length && errors('x').length);
	});

	test('path entries: absolute or token-anchored, no traversal, no control characters, NFC only', () => {
		for (const ok of ['/usr', '${workspace}', '${workspace}/src', '${home}/.cache/x', '${tmp}', '${system}', '${path}', '/']) {
			assert.strictEqual(pathEntryError(ok, false), undefined, ok);
		}
		for (const bad of ['relative', './x', '/a/../b', '/a/./b', '/a//b', '/a/', '${workspace}/..', '${workspace}x', '${nope}/x', '${system}/usr', '/a/${home}', '/a\u0000b', '/a\nb', 'C:\\x', '/caf\u0065\u0301']) {
			assert.ok(pathEntryError(bad, true), bad);
		}
		assert.ok(pathEntryError('**/.git', false), 'patterns only where allowed');
		assert.strictEqual(pathEntryError('**/.git/hooks', true), undefined);
		assert.ok(pathEntryError('**/*.pem', true), 'no globs inside a pattern');
		assert.ok(pathEntryError('**/a/../b', true));
	});

	test('write roots can never be the whole filesystem, home, system folders or PATH', () => {
		for (const root of ['/', '${home}', '${system}', '${path}']) {
			assert.ok(errors({ schemaVersion: 1, filesystem: { write: [root] } }).length, root);
		}
	});

	test('network entries: lower-case hostnames, wildcards with a base, IPv4, optional port', () => {
		for (const ok of ['example.com', '*.example.com', 'api.example.com:8443', '1.2.3.4', '*', 'xn--bcher-kva.example']) {
			assert.strictEqual(networkEntryError(ok), undefined, ok);
		}
		for (const bad of ['Example.com', '*.com', 'example', 'exa mple.com', 'bücher.example', 'example.com:0', 'example.com:99999', '*example.com', 'http://example.com']) {
			assert.ok(networkEntryError(bad), bad);
		}
	});

	test('env names and values', () => {
		assert.ok(errors({ schemaVersion: 1, env: { set: { 'A-B': 'x' } } }).length);
		assert.ok(errors(JSON.parse('{"schemaVersion":1,"env":{"set":{"__proto__":"x"}}}')).length, '__proto__ from JSON is refused');
		assert.ok(errors({ schemaVersion: 1, env: { set: { A: 'x\u0000y' } } }).length);
		assert.ok(errors({ schemaVersion: 1, env: { inherit: ['*', 'PATH'] } }).length === 0);
	});

	test('oversized and malformed text is refused before parsing', () => {
		assert.ok(!parseSandboxPolicyText('x'.repeat(300 * 1024), true).ok);
		assert.ok(!parseSandboxPolicyText('{', false).ok);
		assert.ok(!parseSandboxPolicyLayer({ schemaVersion: 1, filesystem: { read: new Array(300).fill('/usr') } }).ok);
	});
});

suite('Volt sandbox policy composition', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const workspace = builtinProfile('workspace');
	const layer = (value: object) => {
		const parsed = parseSandboxPolicyLayer({ schemaVersion: SANDBOX_POLICY_SCHEMA_VERSION, ...value });
		assert.ok(parsed.ok, JSON.stringify(parsed));
		return parsed.value;
	};

	test('a repository policy can narrow', () => {
		const { policy, ignored } = composeSandboxPolicy(workspace, [{ source: 'workspace', trusted: false, layer: layer({ filesystem: { write: ['${workspace}/src'] }, process: { limits: { cpuSeconds: 10 } } }) }]);
		assert.deepStrictEqual(policy.filesystem.write, ['${workspace}/src']);
		assert.strictEqual(policy.process.limits.cpuSeconds, 10);
		assert.deepStrictEqual(ignored, []);
	});

	test('a repository policy cannot widen anything; every attempt is recorded', () => {
		const attack = layer({
			filesystem: { read: ['${home}'], write: ['${workspace}', '/etc'], unmask: ['${home}/.ssh'] },
			network: { mode: 'host', listen: true, loopbackPorts: [6379] },
			process: { limits: { cpuSeconds: 100000 } },
			env: { inherit: ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY'], set: { HTTPS_PROXY: 'http://evil', VOLT_SANDBOX: 'off', LD_PRELOAD: '/tmp/x.so', NODE_OPTIONS: '--require /tmp/x.js' } },
			host: { unixSockets: ['/var/run/docker.sock'], systemServices: true },
			bestEffort: ['filesystem.deny'],
		});
		const { policy, ignored } = composeSandboxPolicy(workspace, [{ source: 'workspace', trusted: false, layer: attack }]);
		assert.ok(!policy.filesystem.read.includes('${home}'));
		assert.ok(!policy.filesystem.write.includes('/etc'));
		assert.strictEqual(policy.network.mode, 'none');
		assert.strictEqual(policy.network.listen, false);
		assert.deepStrictEqual(policy.network.loopbackPorts, []);
		assert.strictEqual(policy.process.limits.cpuSeconds, workspace.process.limits.cpuSeconds);
		assert.ok(!policy.env.inherit.includes('GITHUB_TOKEN'));
		assert.strictEqual(policy.env.set.HTTPS_PROXY, undefined);
		assert.strictEqual(policy.env.set.VOLT_SANDBOX, undefined);
		assert.strictEqual(policy.env.set.LD_PRELOAD, undefined, 'loader hooks could reach a launcher outside the sandbox');
		assert.strictEqual(policy.env.set.NODE_OPTIONS, undefined);
		assert.deepStrictEqual(policy.host.unixSockets, []);
		assert.strictEqual(policy.host.systemServices, false);
		assert.ok(!policy.bestEffort.includes('filesystem.deny'));
		assert.ok(policy.filesystem.deny.includes('${home}/.ssh'), 'credential denies survive');
		const fields = new Set(ignored.map(note => note.field));
		for (const field of ['filesystem.read', 'filesystem.write', 'filesystem.unmask', 'network.mode', 'network.listen', 'network.loopbackPorts', 'process.limits.cpuSeconds', 'env.inherit', 'env.set', 'host.unixSockets', 'host.systemServices', 'bestEffort']) {
			assert.ok(fields.has(field), `recorded: ${field}`);
		}
	});

	test('denies and protections only grow, even from a trusted layer', () => {
		const { policy } = composeSandboxPolicy(workspace, [{ source: 'user', trusted: true, layer: layer({ filesystem: { deny: ['${workspace}/secrets'] } }) }]);
		assert.ok(policy.filesystem.deny.includes('${workspace}/secrets'));
		assert.ok(policy.filesystem.protect.includes('${workspace}/.vscode'));
	});

	test('narrowing a proxy allow list keeps only covered hosts', () => {
		const net = composeSandboxPolicy(workspace, [{ source: 'user', trusted: true, layer: layer({ network: { mode: 'proxy', allow: ['*.github.com'] } }) }]).policy;
		const { policy, ignored } = composeSandboxPolicy(net, [{ source: 'workspace', trusted: false, layer: layer({ network: { allow: ['api.github.com', 'evil.com', 'github.com:22'] } }) }]);
		assert.deepStrictEqual(policy.network.allow, ['api.github.com']);
		assert.deepStrictEqual(ignored.map(n => n.value).sort(), ['evil.com', 'github.com:22']);
	});

	test('containment helpers', () => {
		assert.ok(entryInside('${workspace}/a', '${workspace}'));
		assert.ok(!entryInside('${workspace}x', '${workspace}'));
		assert.ok(!entryInside('/usr/bin', '${system}'), 'different tokens are never provably inside');
		assert.ok(allowCovers('*.a.com', 'b.a.com') && allowCovers('*.a.com', 'a.com') && !allowCovers('*.a.com', 'ba.com'));
		assert.ok(!allowCovers('a.com', 'a.com:8080') && allowCovers('*', 'x.org'));
	});
});

suite('Volt sandbox capabilities', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the install sheet lists valid capabilities by risk and rejects unknown ones', () => {
		const { capabilities, errors } = describeCapabilities(['fs.read:workspace', 'net.host', 'net.connect:api.github.com', 'socket:/var/run/docker.sock', 'fs.write:/', 'teleport', 'env:GITHUB_TOKEN', 'net.listen:yes']);
		assert.deepStrictEqual(capabilities.map(c => c.risk), ['critical', 'critical', 'high', 'medium', 'low']);
		assert.deepStrictEqual(errors.map(e => e.id).sort(), ['fs.write:/', 'net.listen:yes', 'teleport']);
	});

	test('only granted capabilities reach the policy, starting from restricted', () => {
		const evaluation = evaluateCapabilities(['fs.write:workspace', 'net.connect:api.github.com', 'env:HOME_TOOL'], new Set(['fs.write:workspace']));
		assert.ok(evaluation.policy.filesystem.write.includes('${workspace}'));
		assert.strictEqual(evaluation.policy.network.mode, 'none', 'not granted');
		assert.deepStrictEqual([...evaluation.ungranted].sort(), ['env:HOME_TOOL', 'net.connect:api.github.com']);
		assert.ok(evaluation.policy.filesystem.deny.includes('${home}/.ssh'), 'restricted keeps its protections');
		const granted = evaluateCapabilities(['net.connect:api.github.com'], new Set(['net.connect:api.github.com', 'net.host']));
		assert.strictEqual(granted.policy.network.mode, 'proxy', 'a grant the workload did not request adds nothing');
		assert.deepStrictEqual(granted.policy.network.allow, ['api.github.com']);
	});
});

suite('Volt sandbox enforcement check', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const caps = (overrides: Partial<ISandboxBackendCapabilities['enforcement']>): ISandboxBackendCapabilities => ({
		backend: 'seatbelt', available: true, enforcement: { ...allEnforcement('enforced'), ...overrides }, notes: {}, details: [], diagnostics: [],
	});

	test('a dimension the backend cannot enforce blocks the run unless it is best effort', () => {
		const policy = builtinProfile('workspace');
		assert.deepStrictEqual(checkEnforcement(policy, caps({})).blocking, []);
		assert.deepStrictEqual(checkEnforcement(policy, caps({ 'limits.processes': 'unsupported' })), { unenforced: ['limits.processes'], blocking: [] });
		assert.deepStrictEqual(checkEnforcement(policy, caps({ 'filesystem.write': 'partial' })).blocking, ['filesystem.write']);
		assert.deepStrictEqual(checkEnforcement(policy, caps({ 'network.proxy': 'unsupported' })).blocking, [], 'workspace has no network, so the proxy is not needed');
		const memory = completeSandboxPolicy({ schemaVersion: 1, process: { limits: { memoryMB: 512 } } });
		assert.deepStrictEqual(checkEnforcement(memory, caps({ 'limits.memory': 'unsupported' })).blocking, ['limits.memory']);
		assert.ok(dimensionsUsed(builtinProfile('network')).includes('network.proxy'));
	});

	test('secret-looking variables and reserved names', () => {
		for (const name of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'DATABASE_URL', 'SSH_AUTH_SOCK', 'VSCODE_IPC_HOOK_CLI', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'LD_PRELOAD', 'HTTPS_PROXY', 'PGPASSWORD']) {
			assert.ok(isSecretEnvName(name), name);
		}
		for (const name of ['PATH', 'LANG', 'TERM', 'HOME', 'SHELL', 'EDITOR']) {
			assert.ok(!isSecretEnvName(name), name);
		}
		assert.ok(isReservedEnvName('http_proxy') && isReservedEnvName('VOLT_SANDBOX_TAG') && !isReservedEnvName('PATH'));
		assert.strictEqual(redactSandboxText('/Users/me/x GITHUB_TOKEN=abc sk-ant-12345678901234', '/Users/me'), '~/x GITHUB_TOKEN=… sk-ant-1234…');
	});
});

const RESOLVED: IResolvedSandboxPolicy = {
	name: 'test', platform: 'darwin', readAll: false,
	read: ['/usr', '/System'], write: ['/Users/me/repo', '/private/tmp/run'], writeFiles: ['/Users/me/.claude.json'],
	deny: ['/Users/me/.ssh'], protect: ['/Users/me/repo/.vscode'],
	denyPatterns: [{ root: '/Users/me/repo', names: ['.env'] }],
	protectPatterns: [{ root: '/Users/me/repo', names: ['.git', 'hooks'] }],
	newRepositoryGuard: ['/Users/me/repo'],
	gitDirs: [],
	network: { mode: 'proxy', allow: ['api.example.com'], loopbackPorts: [4321], listen: false },
	unixSockets: [], systemServices: false, limits: { cpuSeconds: 10, fileSizeMB: 1 },
	env: {}, cwd: '/Users/me/repo', tmp: '/private/tmp/run', home: '/Users/me',
};

suite('Volt sandbox Seatbelt profile', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('deny-default workload profile: order, reads, writes, protections, network', () => {
		const profile = buildSeatbeltProfile(RESOLVED, { tag: 'abc', proxyPort: 5000 });
		const at = (needle: string) => {
			const index = profile.indexOf(needle);
			assert.ok(index >= 0, `missing: ${needle}\n${profile}`);
			return index;
		};
		assert.ok(at('(deny default (with message "VOLTSBX-abc"))') < at('(allow file-read* file-write*\n\t(regex'));
		assert.ok(at('(allow file-read* (literal "/"))') > 0, 'dyld needs it');
		at('(subpath "/Users/me/repo")');
		const allowWrite = at('(subpath "/private/tmp/run")');
		const protect = at('(regex #"^/[uU][sS][eE][rR][sS]/[mM][eE]/[rR][eE][pP][oO]/\\.[vV][sS][cC][oO][dD][eE](/.*)?$")');
		const deny = at('(deny file-read* file-write* (with message "VOLTSBX-abc")');
		assert.ok(allowWrite < protect && protect < deny, 'last match wins: allow, then protect, then deny');
		at('(deny file-write-create (with message "VOLTSBX-abc")');
		at('(remote ip "localhost:5000")');
		at('(remote ip "localhost:4321")');
		at('(deny network-outbound (with message "VOLTSBX-abc") (remote unix-socket))');
		at('(deny signal (with message "VOLTSBX-abc"))');
		at('(allow signal (target same-sandbox))');
		at('(global-name "com.apple.cfprefsd.agent")');
		at('(deny job-creation');
		assert.ok(!profile.includes('(allow default)'));
		assert.ok(!profile.includes('localhost:*'), 'no blanket loopback');
		assert.ok(!profile.includes('com.apple.dnssd.service'), 'no DNS without an open network');
	});

	test('system services mode: allow-default base with the escape hatches still denied', () => {
		const profile = buildSeatbeltProfile({ ...RESOLVED, readAll: true, systemServices: true, network: { ...RESOLVED.network, mode: 'host' } }, { tag: 't' });
		assert.ok(profile.includes('(allow default)'));
		assert.ok(profile.includes('(deny file-write* (with message "VOLTSBX-t"))'));
		assert.ok(profile.includes('(allow file-read*)'));
		assert.ok(profile.includes('(deny lsopen') && profile.includes('(deny appleevent-send'));
		assert.ok(profile.includes('(path-literal "/private/var/run/mDNSResponder")'), 'DNS with an open network');
		assert.ok(!profile.includes('(deny network* '), 'open network is not denied');
	});

	test('hostile path text cannot break out of a string or regex', () => {
		// A double quote cannot be escaped in an SBPL regex literal: refused, never emitted.
		const quoted = '/Users/me/x") (allow default) ("';
		assert.throws(() => buildSeatbeltProfile({ ...RESOLVED, protect: [quoted] }, { tag: 'z' }), /double quote/);
		assert.throws(() => buildSeatbeltProfile({ ...RESOLVED, write: ['/a\nb'] }, { tag: 'z' }), /control character/);
		const evil = '/Users/me/x) (allow default) (\\ $HOME --bind';
		const profile = buildSeatbeltProfile({ ...RESOLVED, write: [evil], deny: [evil], protect: [evil], newRepositoryGuard: [evil] }, { tag: 'z' });
		// Everything outside string and regex literals is profile syntax; the path must not be in it.
		let outside = '';
		for (let i = 0, inLiteral = false; i < profile.length; i++) {
			const ch = profile[i];
			if (inLiteral) {
				if (ch === '\\') {
					i++;
				} else if (ch === '"') {
					inLiteral = false;
				}
			} else if (ch === '"') {
				inLiteral = true;
			} else {
				outside += ch;
			}
		}
		assert.ok(!outside.includes('allow default'), outside);
	});
});

suite('Volt sandbox resolved rules', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('writes Volt performs for the workload follow the OS rules', () => {
		const allows = (path: string, access: 'read' | 'write' = 'write') => resolvedPolicyAllows(RESOLVED, path, access);
		assert.ok(allows('/Users/me/repo/src/a.ts'));
		assert.ok(allows('/Users/me/.claude.json') && allows('/Users/me/.claude.json.tmp.1') && !allows('/Users/me/.claude.jsonx'));
		assert.ok(!allows('/Users/me/notes.txt'));
		assert.ok(!allows('/Users/me/repo/.vscode/tasks.json'));
		assert.ok(!allows('/Users/me/repo/.VSCode/tasks.json'), 'case variants on macOS');
		assert.ok(!allows('/Users/me/repo/sub/.git/hooks/pre-commit'), 'pattern at depth');
		assert.ok(!allows('/Users/me/repo/sub/.git'), 'no new repository');
		assert.ok(!allows('/Users/me/repo/a/.env', 'read'));
		assert.ok(allows('/Users/me/repo/a/.env.example', 'read'));
		assert.ok(!allows('/Users/me/.ssh/id_ed25519', 'read'));
		assert.ok(!allows('/Users/me/repo/../.ssh/id', 'read'), 'no traversal');
		assert.ok(!allows('relative', 'read'));
		assert.ok(allows('/usr/bin/git', 'read') && !allows('/etc/passwd', 'read'));
	});

	test('.git is an allow list: commits, merges, rebases and fetches write; nothing that runs or redirects git does (B-03)', () => {
		const writable = ['index', 'index.lock', 'HEAD', 'HEAD.lock', 'ORIG_HEAD', 'FETCH_HEAD', 'MERGE_HEAD', 'MERGE_MSG', 'COMMIT_EDITMSG', 'packed-refs', 'config.lock',
			'objects/ab/cdef', 'objects/pack/p.pack', 'objects/info/commit-graph', 'refs/heads/main', 'logs/HEAD', 'rebase-merge/done', 'index.stash.123',
			'worktrees/w/HEAD', 'worktrees/w/index', 'worktrees/w/logs/HEAD', 'worktrees/w/ORIG_HEAD'];
		const readonly = ['', 'config', 'config.worktree', 'commondir', 'gitdir', 'hooks', 'hooks/pre-commit', 'info/exclude', 'info/attributes', 'modules/x/config',
			'objects/info/alternates', 'objects/info/http-alternates', 'description', 'something-new', 'worktrees', 'worktrees/w', 'worktrees/w/commondir',
			'worktrees/w/gitdir', 'worktrees/w/config.worktree', 'worktrees/w/hooks/x', 'worktrees/w/../../config', 'head', 'objects/../config'];
		for (const name of writable) {
			assert.ok(gitDirWritable(name), name);
		}
		for (const name of readonly) {
			assert.ok(!gitDirWritable(name), name);
		}
		const policy: IResolvedSandboxPolicy = { ...RESOLVED, gitDirs: [{ root: '/Users/me/repo', anyDepth: true }, { root: '/Users/me/main/.git', anyDepth: false }], write: [...RESOLVED.write, '/Users/me/main/.git'] };
		const allows = (path: string) => resolvedPolicyAllows(policy, path, 'write');
		assert.ok(allows('/Users/me/repo/.git/objects/ab/cd') && allows('/Users/me/repo/sub/.git/index') && allows('/Users/me/repo/src/x.git'));
		assert.ok(!allows('/Users/me/repo/.git/commondir') && !allows('/Users/me/repo/.GIT/CommonDir') && !allows('/Users/me/repo/vendor/lib/.git/hooks/x'));
		assert.ok(!allows('/Users/me/repo/.git'), 'the .git entry itself');
		assert.ok(allows('/Users/me/main/.git/worktrees/w/index') && !allows('/Users/me/main/.git/worktrees/w/commondir') && !allows('/Users/me/main/.git/objects/info/alternates'));
		assert.ok(allows('/private/tmp/run/repo/.git/config'), 'temp roots are not guarded (scratch repositories)');
	});

	test('Seatbelt expresses the .git allow list with name patterns, so later names are covered', () => {
		const profile = buildSeatbeltProfile({ ...RESOLVED, gitDirs: [{ root: '/Users/me/repo', anyDepth: true }] }, { tag: 't' });
		const deny = profile.indexOf('(deny file-write* (with message "VOLTSBX-t")\n\t(regex #"^/[uU][sS][eE][rR][sS]/[mM][eE]/[rR][eE][pP][oO]/(.*/)?\\.[gG][iI][tT](/.*)?$")');
		const allow = profile.indexOf('(allow file-write*\n\t(regex #"^/[uU][sS][eE][rR][sS]/[mM][eE]/[rR][eE][pP][oO]/(.*/)?\\.[gG][iI][tT]/(worktrees/[^/]+/)?(objects|refs|logs|');
		const redeny = profile.indexOf('/(worktrees/[^/]+/)?objects/info/(http-)?alternates$")');
		const writes = profile.indexOf('(allow file-read* file-write*\n\t(regex');
		const protect = profile.indexOf('(deny file-write* (with message "VOLTSBX-t")\n\t(regex #"^/[uU]');
		assert.ok(writes >= 0 && deny > writes && allow > deny && redeny > allow, profile);
		assert.ok(protect >= 0 && profile.lastIndexOf('(deny file-read* file-write*') > redeny, 'protect and deny sections still come after');
	});
});

suite('Volt sandbox agent profile', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const host: IAgentSandboxHost = {
		platform: 'darwin', home: '/Users/me', tempDirs: ['/private/tmp', '/private/var/folders/ab/T'], uid: 501,
		userDataDir: '/Users/me/Library/Application Support/Volt', sshPrivateKeys: ['/Users/me/.ssh/id_ed25519'], sshAuthSock: '/private/tmp/ssh-x/agent.1', cacheDir: '/Users/me/.volt/sandbox-cache',
	};

	test('reads everything but credentials; writes the workspace, temp and its own state', () => {
		const policy = agentSandboxPolicy({ level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: ['/Users/me/repo'], loopbackPorts: [4000] }, host);
		assert.deepStrictEqual(policy.filesystem.read, ['/']);
		assert.ok(policy.filesystem.write.includes('/Users/me/repo') && policy.filesystem.write.includes('/Users/me/.claude'));
		assert.ok(policy.filesystem.write.includes('/Users/me/.claude.json'));
		assert.ok(!policy.filesystem.write.some(path => path.endsWith('/.npm') || path.endsWith('/Library/Caches') || path.endsWith('/.cache')), 'shared caches are not writable');
		assert.ok(policy.filesystem.protect.includes('/Users/me/.local/share/claude'), 'the CLI binaries');
		assert.ok(policy.filesystem.protect.includes('/Users/me/.claude/plugins'));
		assert.ok(policy.filesystem.deny.includes('/Users/me/.ssh'), 'network off: no ssh at all');
		assert.ok(policy.filesystem.deny.includes('/Users/me/Library/Application Support/Volt'), 'agent-server token');
		assert.ok(policy.filesystem.deny.includes('/Users/me/.codex/auth.json'), 'other agents\' credentials');
		assert.ok(!policy.filesystem.deny.includes('/Users/me/.claude/.credentials.json'), 'its own login');
		assert.ok(!policy.filesystem.deny.includes('/Users/me/Library/Keychains'), 'the Keychain stays (per-item access lists)');
		assert.strictEqual(policy.network.mode, 'proxy');
		assert.deepStrictEqual(policy.network.loopbackPorts, [4000]);
		assert.ok(policy.network.allow.includes('api.anthropic.com'));
		assert.deepStrictEqual(policy.host.unixSockets, []);
		assert.ok(policy.env.inherit.includes('*') && policy.env.inherit.includes('ANTHROPIC_API_KEY'));
		assert.strictEqual(policy.env.set.npm_config_cache, '/Users/me/.volt/sandbox-cache/npm');
		assert.strictEqual(policy.env.set.DISABLE_AUTOUPDATER, '1');
	});

	test('network on: ssh config readable, private keys denied, ssh-agent granted', () => {
		const policy = agentSandboxPolicy({ level: 'workspace-write', network: true, providerId: 'codex', workspaceRoots: ['/Users/me/repo'] }, host);
		assert.ok(!policy.filesystem.deny.includes('/Users/me/.ssh'));
		assert.ok(policy.filesystem.deny.includes('/Users/me/.ssh/id_ed25519'));
		assert.deepStrictEqual(policy.host.unixSockets, ['/private/tmp/ssh-x/agent.1']);
		assert.strictEqual(policy.network.mode, 'host');
	});

	test('read-only protects the workspace even inside temp; home and / are never roots', () => {
		const policy = agentSandboxPolicy({ level: 'read-only', network: false, providerId: 'grok', workspaceRoots: ['/private/tmp/repo', '/Users/me', '/'], extraWritableRoots: ['/Users'] }, host);
		assert.ok(policy.filesystem.protect.includes('/private/tmp/repo'));
		assert.ok(!policy.filesystem.write.includes('/Users/me') && !policy.filesystem.write.includes('/') && !policy.filesystem.write.includes('/Users'));
	});
});
