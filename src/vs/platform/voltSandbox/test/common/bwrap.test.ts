/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { bridgeHolderArgs, BUBBLEWRAP_BRIDGE_SCRIPT, BUBBLEWRAP_FDS, BUBBLEWRAP_READY_ARGV0, BUBBLEWRAP_READY_SCRIPT, bubblewrapArgs, bubblewrapEnvArgs, bubblewrapRefusals, BubblewrapPathKind, encodeBubblewrapArgs, IBubblewrapArgsOptions, IBubblewrapHostLayout, nsenterArgs, prlimitOptions } from '../../common/bwrap.js';
import { IResolvedSandboxPolicy } from '../../common/sandboxResolved.js';

/** bubblewrap's options and how many values each takes: anything else before `--` is an error. */
const ARITY: Readonly<Record<string, number>> = {
	'--unshare-user': 0, '--unshare-pid': 0, '--unshare-ipc': 0, '--unshare-uts': 0, '--unshare-cgroup-try': 0, '--unshare-net': 0,
	'--die-with-parent': 0, '--disable-userns': 0, '--new-session': 0,
	'--args': 1, '--json-status-fd': 1, '--seccomp': 1, '--hostname': 1, '--cap-drop': 1, '--tmpfs': 1, '--remount-ro': 1, '--chdir': 1, '--dev': 1, '--proc': 1,
	'--ro-bind': 2, '--ro-bind-try': 2, '--bind': 2, '--bind-try': 2, '--symlink': 2, '--dev-bind': 2, '--bind-fd': 2, '--ro-bind-fd': 2,
};

interface IOp { readonly option: string; readonly values: readonly string[] }

/** Parses argv the way bubblewrap does: options with their values, then the command after `--`. */
function parse(args: readonly string[]): { ops: IOp[]; command: string[] } {
	const ops: IOp[] = [];
	let i = 0;
	while (i < args.length) {
		const option = args[i];
		if (option === '--') {
			return { ops, command: args.slice(i + 1) };
		}
		const arity = ARITY[option];
		assert.ok(arity !== undefined, `unknown or misplaced option ${JSON.stringify(option)} at ${i}`);
		ops.push({ option, values: args.slice(i + 1, i + 1 + arity) });
		i += 1 + arity;
	}
	assert.fail('no -- before the command');
}

function indexOf(ops: readonly IOp[], option: string, value?: string): number {
	return ops.findIndex(op => op.option === option && (value === undefined || op.values.includes(value)));
}

function has(ops: readonly IOp[], option: string, ...values: string[]): boolean {
	return ops.some(op => op.option === option && values.every((v, i) => op.values[i] === v));
}

const REPO = '/home/me/repo';
const TMP = '/tmp/volt-sbx-a/tmp';
const SENTINEL = '/tmp/volt-sbx-a/canary';

function policy(overrides: Partial<IResolvedSandboxPolicy> = {}): IResolvedSandboxPolicy {
	return {
		name: 'test', platform: 'linux', readAll: false,
		read: ['/usr', '/etc'], write: [REPO, TMP], writeFiles: [], deny: [], protect: [],
		denyPatterns: [], protectPatterns: [], newRepositoryGuard: [],
		network: { mode: 'none', allow: [], loopbackPorts: [], listen: false },
		unixSockets: [], systemServices: false, limits: {}, env: { PATH: '/usr/bin' },
		cwd: REPO, tmp: TMP, home: '/home/me',
		...overrides,
	};
}

function host(kinds: Record<string, BubblewrapPathKind> = {}): IBubblewrapHostLayout {
	return {
		kinds: new Map(Object.entries(kinds)),
		rootLinks: [{ path: '/bin', target: 'usr/bin' }, { path: '/lib', target: 'usr/lib' }, { path: '/lib64', target: 'usr/lib64' }, { path: '/libx32', target: 'opt/x32' }],
		masks: ['/tmp', '/var/tmp', '/run', '/dev/shm'],
		reexpose: ['/run/systemd/resolve/stub-resolv.conf'],
	};
}

function options(overrides: Partial<IBubblewrapArgsOptions> = {}): IBubblewrapArgsOptions {
	return { terminal: false, disableUserns: true, bridged: false, host: host(), matches: { deny: [], protect: [], sockets: [] }, shell: '/usr/bin/dash', sentinel: SENTINEL, ...overrides };
}

function build(p: IResolvedSandboxPolicy, o: IBubblewrapArgsOptions = options(), command = '/usr/bin/node', args: readonly string[] = ['app.js']) {
	return parse(bubblewrapArgs(p, command, args, o));
}

suite('Volt sandbox bubblewrap arguments', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('namespaces, session, capabilities and the control fds', () => {
		const { ops } = build(policy());
		assert.deepStrictEqual(ops[0], { option: '--args', values: [String(BUBBLEWRAP_FDS.args)] }, 'the environment comes first');
		for (const option of ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--unshare-net', '--die-with-parent', '--disable-userns', '--new-session']) {
			assert.ok(indexOf(ops, option) >= 0, option);
		}
		assert.ok(has(ops, '--cap-drop', 'ALL'));
		assert.ok(has(ops, '--hostname', 'volt-sandbox'));
		assert.ok(has(ops, '--json-status-fd', String(BUBBLEWRAP_FDS.status)));
		assert.ok(has(ops, '--seccomp', String(BUBBLEWRAP_FDS.seccomp)));
		assert.ok(has(ops, '--dev', '/dev') && has(ops, '--proc', '/proc'));
		assert.ok(has(ops, '--chdir', REPO));
	});

	test('network: own namespace unless host, or the bridge holder\'s when bridged', () => {
		assert.ok(indexOf(build(policy()).ops, '--unshare-net') >= 0);
		assert.strictEqual(indexOf(build(policy({ network: { mode: 'host', allow: [], loopbackPorts: [], listen: true } })).ops, '--unshare-net'), -1);
		assert.strictEqual(indexOf(build(policy({ network: { mode: 'proxy', allow: ['a.com'], loopbackPorts: [], listen: false } }), options({ bridged: true })).ops, '--unshare-net'), -1);
	});

	test('a terminal keeps its session; old bubblewrap gets no --disable-userns', () => {
		const { ops } = build(policy(), options({ terminal: true, disableUserns: false }));
		assert.strictEqual(indexOf(ops, '--new-session'), -1);
		assert.strictEqual(indexOf(ops, '--disable-userns'), -1);
	});

	test('minimal mounts: reads, the host\'s top-level links, and a frozen root', () => {
		const { ops } = build(policy());
		assert.ok(has(ops, '--ro-bind-try', '/usr', '/usr'));
		assert.ok(has(ops, '--ro-bind-try', '/etc', '/etc'));
		assert.ok(has(ops, '--symlink', 'usr/bin', '/bin'), 'ELF interpreters and #!/bin/sh need the link');
		assert.ok(has(ops, '--symlink', 'usr/lib', '/lib'));
		assert.strictEqual(indexOf(ops, '--symlink', '/libx32'), -1, 'a link to something unreadable is left out');
		assert.strictEqual(indexOf(ops, '--ro-bind', '/'), -1);
		const freeze = indexOf(ops, '--remount-ro', '/');
		assert.ok(freeze > indexOf(ops, '--bind-try', REPO), 'the root is frozen after every mount');
		assert.strictEqual(freeze, ops.length - 2, 'last before --chdir');
	});

	test('readAll: the whole filesystem read-only, then masks over socket folders', () => {
		const p = policy({ readAll: true, read: ['/run/user/1000/doc'] });
		const { ops } = build(p);
		assert.strictEqual(indexOf(ops, '--ro-bind', '/'), indexOf(ops, '--ro-bind'), 'the base comes first');
		assert.strictEqual(indexOf(ops, '--remount-ro', '/'), -1);
		for (const mask of ['/tmp', '/var/tmp', '/run', '/dev/shm']) {
			assert.ok(indexOf(ops, '--tmpfs', mask) > indexOf(ops, '--ro-bind', '/'), mask);
		}
		assert.ok(indexOf(ops, '--ro-bind-try', '/run/user/1000/doc') > indexOf(ops, '--tmpfs', '/run'), 'a read below a mask is bound again after it');
		assert.ok(indexOf(ops, '--bind-try', TMP) > indexOf(ops, '--tmpfs', '/tmp'), 'the run\'s temp folder survives the /tmp mask');
		assert.ok(indexOf(ops, '--ro-bind-try', '/run/systemd/resolve/stub-resolv.conf') > indexOf(ops, '--tmpfs', '/run'), 'resolv.conf\'s target stays readable');
	});

	test('masks only cover folders the sandbox can see', () => {
		const { ops } = build(policy());
		assert.ok(has(ops, '--tmpfs', '/tmp') && has(ops, '--tmpfs', '/dev/shm'), 'always');
		assert.strictEqual(indexOf(ops, '--tmpfs', '/run'), -1, 'not visible in a minimal policy');
		assert.ok(has(ops, '--ro-bind-try', '/run/systemd/resolve/stub-resolv.conf', '/run/systemd/resolve/stub-resolv.conf'), '/etc is readable, so DNS config is too');
		const noEtc = build(policy({ read: ['/usr'] })).ops;
		assert.strictEqual(indexOf(noEtc, '--ro-bind-try', '/run/systemd/resolve/stub-resolv.conf'), -1);
	});

	test('deny: tmpfs over folders, /dev/null over files, nothing for missing paths, last', () => {
		const p = policy({
			readAll: true,
			deny: ['/home/me/.ssh', '/home/me/.netrc', '/home/me/.aws', '/home/me/.ssh/id_rsa'],
			protect: [`${REPO}/.vscode`],
		});
		const { ops } = build(p, options({ host: host({ '/home/me/.ssh': 'dir', '/home/me/.netrc': 'file', '/home/me/.ssh/id_rsa': 'file', [`${REPO}/.vscode`]: 'dir' }) }));
		const tmpfs = indexOf(ops, '--tmpfs', '/home/me/.ssh');
		assert.ok(tmpfs > 0 && ops[tmpfs + 1].option === '--remount-ro' && ops[tmpfs + 1].values[0] === '/home/me/.ssh');
		assert.ok(has(ops, '--ro-bind', '/dev/null', '/home/me/.netrc'));
		assert.ok(!ops.some(op => op.values.includes('/home/me/.aws')), 'missing: nothing to mount over');
		assert.ok(!ops.some(op => op.values.includes('/home/me/.ssh/id_rsa')), 'inside a denied folder already');
		assert.ok(tmpfs > indexOf(ops, '--ro-bind', `${REPO}/.vscode`), 'denies come after protects');
	});

	test('protect: read-only binds inside writable roots, after the writes, with pinned parents', () => {
		const p = policy({ protect: [`${REPO}/.git/config`, `${REPO}/.git/hooks`, `${REPO}/.vscode`, '/etc/hosts', `${REPO}/.idea`] });
		const { ops } = build(p, options({ host: host({ [`${REPO}/.git/config`]: 'file', [`${REPO}/.git/hooks`]: 'dir', [`${REPO}/.vscode`]: 'dir', '/etc/hosts': 'file' }) }));
		const write = indexOf(ops, '--bind-try', REPO);
		const pin = indexOf(ops, '--bind', `${REPO}/.git`);
		assert.ok(write >= 0 && pin > write, 'the .git folder is pinned after the write bind');
		assert.deepStrictEqual(ops[pin].values, [`${REPO}/.git`, `${REPO}/.git`]);
		for (const path of [`${REPO}/.git/config`, `${REPO}/.git/hooks`, `${REPO}/.vscode`]) {
			assert.ok(indexOf(ops, '--ro-bind', path) > pin, path);
		}
		assert.strictEqual(indexOf(ops, '--ro-bind', '/etc/hosts'), -1, 'outside writable roots it is read-only already');
		assert.ok(!ops.some(op => op.values.includes(`${REPO}/.idea`)), 'missing: not enforceable (filesystem.protectNew)');
		assert.strictEqual(ops.filter(op => op.option === '--bind' && op.values[0] === `${REPO}/.git`).length, 1, 'one pin per folder');
	});

	test('pins start at the deepest writable root', () => {
		const p = policy({ write: [REPO, `${REPO}/packages/a`], protect: [`${REPO}/packages/a/.git/config`] });
		const { ops } = build(p, options({ host: host({ [`${REPO}/packages/a/.git/config`]: 'file' }) }));
		assert.ok(has(ops, '--bind', `${REPO}/packages/a/.git`, `${REPO}/packages/a/.git`));
		assert.strictEqual(indexOf(ops, '--bind', `${REPO}/packages`), -1);
		assert.ok(indexOf(ops, '--bind-try', `${REPO}/packages/a`) > indexOf(ops, '--bind-try', REPO), 'nested writes after their parent');
	});

	test('pattern matches from the walk are masked and protected', () => {
		const matches = {
			deny: [{ path: `${REPO}/.env`, kind: 'file' as const }, { path: `${REPO}/sub/.env`, kind: 'file' as const }],
			protect: [{ path: `${REPO}/sub/.git/hooks`, kind: 'dir' as const }, { path: '/elsewhere/.git/hooks', kind: 'dir' as const }],
			sockets: [`${REPO}/dev.sock`],
		};
		const { ops } = build(policy(), options({ matches }));
		assert.ok(has(ops, '--ro-bind', '/dev/null', `${REPO}/.env`));
		assert.ok(has(ops, '--ro-bind', '/dev/null', `${REPO}/sub/.env`));
		assert.ok(has(ops, '--bind', `${REPO}/sub`, `${REPO}/sub`), 'a denied file\'s folder is pinned too');
		assert.ok(has(ops, '--ro-bind', `${REPO}/sub/.git/hooks`, `${REPO}/sub/.git/hooks`));
		assert.strictEqual(indexOf(ops, '--ro-bind', '/elsewhere/.git/hooks'), -1, 'not writable, nothing to protect');
		assert.ok(!ops.some(op => op.values.includes(`${REPO}/dev.sock`)), 'sockets stay as they are while AF_UNIX is refused');
	});

	test('granted unix sockets are bound in; other sockets the walk found are hidden', () => {
		const p = policy({ unixSockets: ['/run/user/1000/ssh-agent.sock'] });
		const { ops } = build(p, options({ host: host({ '/run/user/1000/ssh-agent.sock': 'file' }), matches: { deny: [], protect: [], sockets: [`${REPO}/dev.sock`, '/run/user/1000/ssh-agent.sock'] } }));
		assert.ok(has(ops, '--bind-try', '/run/user/1000/ssh-agent.sock', '/run/user/1000/ssh-agent.sock'));
		assert.ok(has(ops, '--ro-bind', '/dev/null', `${REPO}/dev.sock`));
		assert.ok(!has(ops, '--ro-bind', '/dev/null', '/run/user/1000/ssh-agent.sock'));
	});

	test('single writable files are bound only when they exist', () => {
		const p = policy({ writeFiles: ['/home/me/.claude.json', '/home/me/.missing.json'] });
		const { ops } = build(p, options({ host: host({ '/home/me/.claude.json': 'file' }) }));
		assert.ok(has(ops, '--bind-try', '/home/me/.claude.json', '/home/me/.claude.json'));
		assert.ok(!ops.some(op => op.values.includes('/home/me/.missing.json')));
	});

	test('the workload runs after --, behind the readiness script and prlimit', () => {
		const p = policy({ limits: { cpuSeconds: 300, processes: 512, fileSizeMB: 10, openFiles: 4096, memoryMB: 2048, wallClockSeconds: 600 } });
		const { command } = build(p, options({ prlimit: { path: '/usr/bin/prlimit', hard: { nofile: 1024 } } }), 'node', ['--inspect', 'x.js']);
		assert.deepStrictEqual(command, [
			'/usr/bin/dash', '-c', BUBBLEWRAP_READY_SCRIPT, BUBBLEWRAP_READY_ARGV0, SENTINEL,
			'/usr/bin/prlimit', '--cpu=300:300', `--fsize=${10 * 1024 * 1024}:${10 * 1024 * 1024}`, '--nofile=1024:1024', '--nproc=512:512', `--as=${2048 * 1024 * 1024}:${2048 * 1024 * 1024}`, '--',
			'node', '--inspect', 'x.js',
		]);
		assert.deepStrictEqual(build(policy()).command, ['/usr/bin/dash', '-c', BUBBLEWRAP_READY_SCRIPT, BUBBLEWRAP_READY_ARGV0, SENTINEL, '/usr/bin/node', 'app.js'], 'no limits, no prlimit');
	});

	test('the readiness script waits for the go byte on its own fd before the workload (B-29)', () => {
		const script = BUBBLEWRAP_READY_SCRIPT;
		const ready = script.indexOf('volt-sandbox-ready');
		const go = script.indexOf(`read -r g <&${BUBBLEWRAP_FDS.go}`);
		const exec = script.indexOf('exec "$@"');
		assert.ok(ready > 0 && go > ready && exec > go, 'ready, then the go byte, then the workload');
		assert.ok(script.includes('[ "$g" = g ] || exit 125'), 'anything but the go byte stops it');
		assert.ok(script.includes(`exec ${BUBBLEWRAP_FDS.go}<&-`) && script.includes(`exec ${BUBBLEWRAP_FDS.marker}>&-`), 'no control fd reaches the workload');
		assert.throws(() => bubblewrapArgs(policy(), 'node', [], options({ sentinel: 'relative' })));
	});

	test('B-33: roots opened as fds are bound from the fd, read-only or writable as the policy says', () => {
		const fds = new Map([[REPO, BUBBLEWRAP_FDS.firstRoot], ['/etc', BUBBLEWRAP_FDS.firstRoot + 1]]);
		const { ops } = build(policy(), options({ bindFds: fds }));
		assert.ok(has(ops, '--bind-fd', String(BUBBLEWRAP_FDS.firstRoot), REPO));
		assert.ok(has(ops, '--ro-bind-fd', String(BUBBLEWRAP_FDS.firstRoot + 1), '/etc'));
		assert.ok(!has(ops, '--bind-try', REPO, REPO) && !has(ops, '--ro-bind-try', '/etc', '/etc'), 'never also by path');
		assert.ok(has(ops, '--ro-bind-try', '/usr', '/usr'), 'roots without an fd stay bound by path');
	});

	test('B-35: an isolated folder is emptied, frozen at the end, and the run\'s own child is bound back', () => {
		const runs = '/home/me/.volt/sandbox/runs';
		const own = `${runs}/volt-sbx-a`;
		const p = policy({ readAll: true, read: [], write: [REPO, `${own}/tmp`], isolated: [{ root: runs, keep: own }] });
		const { ops } = build(p);
		const tmpfs = indexOf(ops, '--tmpfs', runs);
		assert.ok(tmpfs > 0, 'other runs are hidden');
		assert.ok(indexOf(ops, '--bind-try', `${own}/tmp`) > tmpfs, 'the run\'s own temp is bound after the mask');
		assert.ok(indexOf(ops, '--remount-ro', runs) > indexOf(ops, '--bind-try', `${own}/tmp`), 'and the mask is frozen last');
		assert.strictEqual(indexOf(build(policy({ isolated: [{ root: runs, keep: own }] })).ops, '--tmpfs', runs), -1, 'nothing to hide where the folder is not visible');
	});

	test('argument injection: paths are always option values, never options or shell text', () => {
		const odd = ['/home/me/repo/--bind', '/home/me/repo/a b', '/home/me/repo/--', '/home/me/repo/$(touch x)', '/home/me/repo/;rm -rf ~'];
		const p = policy({ write: [REPO, ...odd], protect: odd.map(path => `${path}/.git/config`), cwd: '/home/me/repo/a b' });
		const kinds = Object.fromEntries(odd.map(path => [`${path}/.git/config`, 'file' as const]));
		const parsed = build(p, options({ host: host(kinds) }), '/usr/bin/env', ['--', '--bind', '/', '/']);
		for (const path of odd) {
			assert.ok(has(parsed.ops, '--bind-try', path, path), path);
			assert.ok(has(parsed.ops, '--ro-bind', `${path}/.git/config`, `${path}/.git/config`), path);
		}
		assert.ok(has(parsed.ops, '--chdir', '/home/me/repo/a b'));
		assert.deepStrictEqual(parsed.command.slice(5), ['/usr/bin/env', '--', '--bind', '/', '/'], 'the workload\'s own arguments are not bubblewrap\'s');
		assert.ok(!BUBBLEWRAP_READY_SCRIPT.includes('/home/me'), 'the script is constant');
	});

	test('commands bubblewrap or a shell could take as options are refused', () => {
		assert.throws(() => bubblewrapArgs(policy(), '--help', [], options()));
		assert.throws(() => bubblewrapArgs(policy(), '', [], options()));
		assert.throws(() => bubblewrapArgs(policy(), 'node', ['a\0b'], options()));
	});

	test('environment goes through --args, NUL-separated, never on the command line', () => {
		const env = { PATH: '/usr/bin', API_TOKEN: 'secret value\nwith newline', 'BAD=NAME': 'x', '': 'y', LD_PRELOAD: '/x.so' };
		const args = bubblewrapEnvArgs(env);
		assert.deepStrictEqual(args, ['--setenv', 'PATH', '/usr/bin', '--setenv', 'API_TOKEN', 'secret value\nwith newline', '--setenv', 'LD_PRELOAD', '/x.so']);
		assert.strictEqual(encodeBubblewrapArgs(['--setenv', 'A', 'b c']), '--setenv\0A\0b c\0');
		const argv = bubblewrapArgs(policy({ env }), '/usr/bin/node', [], options());
		assert.ok(!argv.some(arg => arg.includes('secret value') || arg === '--setenv'));
	});

	test('prlimit options: soft = hard, lowered to the inherited hard limit', () => {
		assert.deepStrictEqual(prlimitOptions({ openFiles: 8192, processes: 100 }, { nofile: 4096 }), ['--nofile=4096:4096', '--nproc=100:100']);
		assert.deepStrictEqual(prlimitOptions({ wallClockSeconds: 60 }, {}), [], 'the wall clock is the manager\'s');
	});

	test('refusals: what the backend cannot enforce for this policy', () => {
		const facts = { controlDir: '/tmp/volt-sbx-a/ctl', shell: '/usr/bin/dash', prlimit: '/usr/bin/prlimit', limitsApplied: true };
		assert.deepStrictEqual(bubblewrapRefusals(policy(), facts), []);
		const dims = (p: IResolvedSandboxPolicy, f = facts) => bubblewrapRefusals(p, f).map(r => r.dimension);
		assert.deepStrictEqual(dims(policy({ readAll: true, unixSockets: ['/run/a.sock'] })), ['host.unixSockets']);
		assert.deepStrictEqual(dims(policy({ network: { mode: 'host', allow: [], loopbackPorts: [], listen: true }, unixSockets: ['/run/a.sock'] })), ['host.unixSockets'], 'abstract sockets');
		assert.deepStrictEqual(dims(policy({ unixSockets: ['/run/a.sock'] })), [], 'minimal mounts bound what is reachable');
		assert.deepStrictEqual(dims(policy({ write: [REPO, '/tmp/volt-sbx-a'] })), ['filesystem.write'], 'the control folder must not be writable');
		assert.deepStrictEqual(dims(policy({ read: ['/etc'] })), ['process.isolation'], 'the readiness shell must be readable');
		assert.deepStrictEqual(dims(policy({ read: ['/usr', '/etc'], limits: { processes: 10 } }), { ...facts, prlimit: '/opt/bin/prlimit' }), ['limits.processes']);
		assert.deepStrictEqual(dims(policy({ network: { mode: 'none', allow: [], loopbackPorts: [80], listen: false } })), ['network.loopbackPorts']);
	});

	test('the bridge holder: constant script, ports as arguments, no privileged ports', () => {
		const args = bridgeHolderArgs('/usr/bin/socat', '/tmp/volt-sbx-a/ctl', [8080, 9000], '/usr/bin/dash');
		const { ops, command } = parse(args);
		assert.ok(has(ops, '--unshare-net') && has(ops, '--unshare-user') && has(ops, '--die-with-parent'));
		assert.ok(has(ops, '--chdir', '/tmp/volt-sbx-a/ctl'));
		assert.strictEqual(indexOf(ops, '--dev'), -1, '--dev would nest a second user namespace nsenter cannot use');
		assert.deepStrictEqual(command, ['/usr/bin/dash', '-c', BUBBLEWRAP_BRIDGE_SCRIPT, 'volt-bridge', '/usr/bin/socat', '8080', '9000']);
		assert.throws(() => bridgeHolderArgs('/usr/bin/socat', '/tmp/x', [80], '/bin/sh'));
		assert.throws(() => bridgeHolderArgs('/usr/bin/socat', '/tmp/x', [8080.5], '/bin/sh'));
		assert.deepStrictEqual(nsenterArgs(42, '/usr/bin/bwrap', ['--unshare-user']), ['--user=/proc/42/ns/user', '--net=/proc/42/ns/net', '--preserve-credentials', '--', '/usr/bin/bwrap', '--unshare-user']);
	});
});
