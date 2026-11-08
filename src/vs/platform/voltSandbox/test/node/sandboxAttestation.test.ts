/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * H7: external attestation, the go byte, and the backend hardening that goes with them, against
 * real sandboxes. Test ids are the spec's (K.3): ATTEST-1..4, FAULT-1, MAC-TCC-1, MAC-TTY-1,
 * MAC-ENV-1 (expected to fail: a known residual), SEC-CROSS-1, NET live grant, LNX-ENV-1,
 * LNX-SECCOMP-VSOCK, LNX-BWRAP-CVE.
 *
 * Like sandboxSecurity.test.ts: a machine without a working backend skips loudly, and with
 * `VOLT_SANDBOX_REQUIRED` set it fails instead. Every assertion that something did not happen
 * comes with proof that the run did happen. Linux: run inside the rig
 * (scripts/volt-sandbox-linux-test.sh suite).
 */

import assert from 'assert';
import { ChildProcess, execFileSync, spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as net from 'net';
import { tmpdir } from 'os';
import { basename, join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BUBBLEWRAP_FDS } from '../../common/bwrap.js';
import { composeSandboxPolicy } from '../../common/sandboxComposition.js';
import { agentSandboxPolicy } from '../../common/sandboxPolicy.js';
import { builtinProfile } from '../../common/sandboxProfiles.js';
import { IResolvedSandboxPolicy } from '../../common/sandboxResolved.js';
import { IVoltSandboxPolicy, parseSandboxPolicyLayer } from '../../common/sandboxSchema.js';
import { SEATBELT_FDS } from '../../common/seatbelt.js';
import { walkPatterns } from '../../node/bubblewrapBackend.js';
import { SandboxFault } from '../../node/sandboxBackends.js';
import { sandboxCacheKey } from '../../node/sandboxLauncher.js';
import { IPreparedSandbox, ISandboxManagerOptions, SandboxManager } from '../../node/sandboxManager.js';
import { ISandboxHostFacts, sandboxHostFacts } from '../../node/sandboxResolver.js';
import { realSandboxAvailable } from './sandboxSuiteGate.js';

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const PERL = '/usr/bin/perl';
const macTest = isMac ? test : test.skip;
const linuxTest = isLinux ? test : test.skip;

async function exists(path: string): Promise<boolean> {
	return fs.lstat(path).then(() => true, () => false);
}

async function waitFor(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	return check();
}

/** Compiles a small C program for a test (macOS: the system compiler). Fails, never skips, when CI requires the sandbox. */
function compile(dir: string, name: string, source: string): string {
	const file = join(dir, `${name}.c`);
	const out = join(dir, name);
	execFileSync('/bin/sh', ['-c', 'cat > "$1"', 'sh', file], { input: source });
	execFileSync('/usr/bin/cc', ['-O1', '-o', out, file], { stdio: 'pipe' });
	return out;
}

suite('Volt sandbox attestation and backend hardening (H7, real processes)', function () {

	this.timeout(120_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let ws: string;
	let runRoot: string;
	let host: ISandboxHostFacts;
	let manager: SandboxManager;
	let available = false;
	const managers: SandboxManager[] = [];

	const managerWith = (options: ISandboxManagerOptions = {}, facts: ISandboxHostFacts = host) => {
		const created = new SandboxManager(undefined, { runRoot, host: facts, ...options });
		managers.push(created);
		return created;
	};

	suiteSetup(async function () {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-sbx-att-')));
		home = join(root, 'home');
		ws = join(root, 'ws');
		runRoot = join(home, '.volt', 'sandbox', 'runs');
		for (const dir of [home, ws, runRoot, join(home, '.ssh'), join(root, 'agent-tmp')]) {
			await fs.mkdir(dir, { recursive: true });
		}
		await fs.writeFile(join(home, '.ssh', 'id_ed25519'), 'CANARY-SSH\n');
		host = { ...await sandboxHostFacts(), home };
		manager = managerWith();
		available = realSandboxAvailable(await manager.capabilities(), 'attestation suite');
	});

	suiteTeardown(async () => {
		await Promise.all(managers.map(m => m.dispose()));
		if (root) {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	setup(function () {
		if (!available) {
			this.skip();
		}
	});

	const workspace = () => builtinProfile('workspace');
	const agent = (workspaceRoot = ws, cacheDir = join(home, '.volt', 'sandbox-cache')) => agentSandboxPolicy(
		{ level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: [workspaceRoot] },
		{ platform: process.platform, home, tempDirs: [join(root, 'agent-tmp')], cacheDir },
	);
	const hostEnv = () => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'C' });

	function run(m: SandboxManager, policy: IVoltSandboxPolicy, script: string, workspaceRoot = ws) {
		return m.run({ command: '/bin/sh', args: ['-c', script], policy, context: { workspaceRoots: [workspaceRoot], hostEnv: hostEnv() } }, { timeoutMs: 30_000 });
	}

	/** Prepares, spawns and leaves the confirmation to the caller. */
	async function start(m: SandboxManager, policy: IVoltSandboxPolicy, script: string, workspaceRoot = ws): Promise<{ prepared: IPreparedSandbox; child: ChildProcess; stdout: () => string }> {
		const prepared = await m.prepare({ command: '/bin/sh', args: ['-c', script], policy, context: { workspaceRoots: [workspaceRoot], hostEnv: hostEnv() } });
		const child = spawn(prepared.command, [...prepared.args], { cwd: prepared.cwd, env: prepared.env, stdio: ['ignore', 'pipe', 'pipe', ...prepared.extraStdio], detached: true });
		let out = '';
		child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
		child.stderr?.on('data', () => undefined);
		return { prepared, child, stdout: () => out };
	}

	async function stop(handle: { prepared: IPreparedSandbox; child: ChildProcess }): Promise<void> {
		await handle.prepared.terminate(handle.child);
		for (const stream of handle.child.stdio) {
			stream?.destroy();
		}
		await handle.prepared.dispose();
	}

	// --- ATTEST ----------------------------------------------------------------------------------

	test('ATTEST-1: a run starts only on external evidence, recorded with the policy it ran under', async () => {
		const result = await run(manager, workspace(), 'echo ran');
		assert.strictEqual(result.status, 'completed', result.error);
		assert.strictEqual(result.stdout.trim(), 'ran');
		const attestation = result.attestation;
		assert.ok(attestation, 'the run carries its attestation');
		assert.match(attestation.launchPolicyHash, /^[0-9a-f]{64}$/);
		assert.ok(attestation.osBuild.length > 0 && attestation.backendVersion.length > 0);
		assert.deepStrictEqual(attestation.canary, { credOpen: 'denied' });
		if (isMac) {
			assert.strictEqual(attestation.evidence.sandbox_check, 1, 'sandbox_check(pid) from outside');
			assert.strictEqual(attestation.evidence.credentialDenied, 1);
			assert.strictEqual(attestation.evidence.networkDenied, 1);
			assert.strictEqual(attestation.evidence.dnsDenied, 1);
			assert.strictEqual(attestation.evidence.responsibility, 'disclaimed');
		} else {
			assert.strictEqual(attestation.evidence.seccomp, 2, '/proc/<pid>/status from outside');
			assert.strictEqual(attestation.evidence.noNewPrivs, 1);
			for (const ns of ['nsMnt', 'nsPid', 'nsUser', 'nsNet']) {
				assert.strictEqual(typeof attestation.evidence[ns], 'number', ns);
			}
		}
	});

	test('ATTEST-2: a forged ready line from an unsandboxed prologue is rejected and the workload never runs', async () => {
		const marker = join(ws, 'attest2-marker');
		const prepared = await manager.prepare({ command: '/usr/bin/touch', args: [marker], policy: workspace(), context: { workspaceRoots: [ws], hostEnv: hostEnv() } });
		try {
			// The same prologue and workload, minus the sandbox: everything after the launcher's `--`.
			const args = [...prepared.args];
			const prologue = args.slice(args.indexOf('--') + 1);
			let file = prologue[0];
			let argv = prologue.slice(1);
			if (isLinux) {
				// Forge bubblewrap's status line too, naming the forger as the sandbox's pid 1.
				file = '/bin/sh';
				argv = ['-c', `printf '{"child-pid": %s, "mnt-namespace": 1, "pid-namespace": 2, "ipc-namespace": 3, "uts-namespace": 4, "net-namespace": 5}\\n' "$$" >&${BUBBLEWRAP_FDS.status}; "$@"`, 'forge', ...prologue];
			}
			const child = spawn(file, argv, { cwd: prepared.cwd, env: { ...process.env, ...prepared.env }, stdio: ['ignore', 'ignore', 'pipe', ...prepared.extraStdio], detached: true });
			const confirmation = await prepared.confirm(child);
			assert.strictEqual(confirmation.ok, false, 'an unsandboxed process cannot attest itself');
			assert.match(confirmation.ok ? '' : confirmation.error, isMac ? /not sandboxed|sandbox_check/ : /pid namespace|seccomp|namespace/);
			await new Promise(resolve => setTimeout(resolve, 500));
			assert.ok(!await exists(marker), 'the workload never ran');
			await prepared.terminate(child);
		} finally {
			await prepared.dispose();
		}
	});

	for (const [id, fault, expect] of [
		['ATTEST-3: go byte withheld', 'withhold-go', /withheld/],
		['ATTEST-4: a wrong go byte', 'wrong-go', /wrong go byte/],
		['FAULT-1: a failed attestation', 'attest', /fault injection|not sandboxed/],
	] as const) {
		test(`${id}: the workload's first-syscall marker never appears`, async () => {
			const marker = join(ws, `fault-${fault}`);
			const faulty = managerWith({ fault: fault as SandboxFault });
			const result = await faulty.run({ command: '/usr/bin/touch', args: [marker], policy: workspace(), context: { workspaceRoots: [ws], hostEnv: hostEnv() } }, { timeoutMs: 20_000 });
			assert.strictEqual(result.status, 'failed', `refused: ${result.error}`);
			assert.match(result.error ?? '', expect);
			assert.strictEqual(result.attestation, undefined, 'no attestation is recorded for a run that did not start');
			await new Promise(resolve => setTimeout(resolve, 300));
			assert.ok(!await exists(marker), 'the workload never ran');
		});
	}

	test('ATTEST-3b: without the go byte the prologue waits, alive, and the workload does not run', async () => {
		const marker = join(ws, 'attest3b-marker');
		const handle = await start(manager, workspace(), `touch ${marker}`);
		try {
			// Never confirmed, so never told to go. macOS: the prologue sits on the go pipe;
			// Linux: bubblewrap waits for its arguments, which only `confirm` sends.
			await new Promise(resolve => setTimeout(resolve, 1_000));
			assert.strictEqual(handle.child.exitCode, null, 'still waiting');
			assert.ok(!await exists(marker), 'the workload did not run');
		} finally {
			await stop(handle);
		}
	});

	// --- macOS -----------------------------------------------------------------------------------

	macTest('MAC-TCC-1: the sandbox root is its own TCC-responsible process', async () => {
		// Test-only private API: responsibility_get_pid_responsible_for_pid.
		const tool = compile(root, 'responsible', '#include <dlfcn.h>\n#include <stdio.h>\n#include <stdlib.h>\nint main(int c, char **v) { int (*f)(int) = dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid"); if (!f) return 2; printf("%d\\n", f(atoi(v[1]))); return 0; }\n');
		const handle = await start(manager, workspace(), 'sleep 20');
		try {
			const confirmation = await handle.prepared.confirm(handle.child);
			assert.ok(confirmation.ok, confirmation.ok ? '' : confirmation.error);
			const pid = handle.child.pid!;
			const responsible = Number(execFileSync(tool, [String(pid)], { encoding: 'utf8' }).trim());
			const ours = Number(execFileSync(tool, [String(process.pid)], { encoding: 'utf8' }).trim());
			assert.strictEqual(responsible, pid, 'disclaimed: not attributed to Volt or the terminal that started it');
			assert.notStrictEqual(responsible, ours);
			assert.strictEqual(handle.prepared.attestation()?.evidence.responsibility, 'disclaimed');
		} finally {
			await stop(handle);
		}
	});

	macTest('MAC-TTY-1: a sandbox can neither read nor write another terminal', async () => {
		// A terminal of the user's: a pty whose name is printed, and whatever reaches it echoed to stdout.
		const holder = compile(root, 'pty-holder', '#include <stdio.h>\n#include <unistd.h>\n#include <util.h>\nint main(void) { int m, s; char name[128]; if (openpty(&m, &s, name, NULL, NULL) != 0) return 1; printf("%s\\n", name); fflush(stdout); char buf[256]; ssize_t n; while ((n = read(m, buf, sizeof buf)) > 0) { fwrite(buf, 1, n, stdout); fflush(stdout); } return 0; }\n');
		const term = spawn(holder, [], { stdio: ['ignore', 'pipe', 'ignore'] });
		let screen = '';
		term.stdout?.on('data', (d: Buffer) => { screen += d.toString(); });
		try {
			assert.ok(await waitFor(() => /\/dev\/ttys\d+/.test(screen), 5_000), `no pty: ${screen}`);
			const device = /\/dev\/ttys\d+/.exec(screen)![0];
			// Control: unsandboxed, the same write reaches that terminal.
			await fs.appendFile(device, 'VOLT-TTY-CONTROL\n');
			assert.ok(await waitFor(() => screen.includes('VOLT-TTY-CONTROL'), 3_000), 'the terminal shows what is written to it');
			for (const policy of [workspace(), agent()]) {
				const result = await run(manager, policy, `echo ran; echo VOLT-TTY-CANARY > ${device} && echo WROTE; (exec 3<${device}) && echo OPENED; true`);
				assert.strictEqual(result.status, 'completed', result.error);
				assert.ok(result.stdout.startsWith('ran'), 'the run happened');
				assert.ok(!/WROTE|OPENED/.test(result.stdout), `${policy.name}: ${result.stdout}`);
			}
			await new Promise(resolve => setTimeout(resolve, 300));
			assert.ok(!screen.includes('VOLT-TTY-CANARY'), 'nothing reached the terminal');
		} finally {
			term.kill('SIGKILL');
		}
	});

	macTest('MAC-ENV-1 (expected to fail, residual B-12): a sandbox reads another process\'s environment through KERN_PROCARGS2', async () => {
		const secret = `hunter2-${process.pid}`;
		// A non-platform process holding a secret, and a reader that asks the kernel for its argv and env.
		const sleeper = compile(root, 'canary-sleeper', '#include <unistd.h>\nint main(void) { sleep(30); return 0; }\n');
		const reader = compile(ws, 'procargs-reader', '#include <stdio.h>\n#include <stdlib.h>\n#include <sys/sysctl.h>\nint main(int c, char **v) { int mib[3] = { CTL_KERN, KERN_PROCARGS2, atoi(v[1]) }; static char buf[1 << 16]; size_t n = sizeof buf; if (sysctl(mib, 3, buf, &n, NULL, 0) != 0) { perror("sysctl"); return 1; } fwrite(buf, 1, n, stdout); return 0; }\n');
		const canary = spawn(sleeper, [], { env: { CANARY_SECRET: secret }, stdio: 'ignore' });
		try {
			await new Promise(resolve => setTimeout(resolve, 200));
			let leaked = false;
			for (const policy of [workspace(), agent()]) {
				const result = await run(manager, policy, `echo ran; ${reader} ${canary.pid} | tr '\\0' '\\n'`);
				assert.strictEqual(result.status, 'completed', result.error);
				leaked ||= result.stdout.includes(secret);
			}
			// Expected failure: the residual holds today. When this assertion fails, the residual is
			// fixed (a Seatbelt rule or hardened runtime): remove the expected-fail marker and invert it.
			assert.ok(leaked, 'MAC-ENV-1 residual no longer reproduces: KERN_PROCARGS2 is blocked. Remove the expected-fail marker and make this a normal test.');
		} finally {
			canary.kill('SIGKILL');
		}
	});

	// --- Both ------------------------------------------------------------------------------------

	test('SEC-CROSS-1: a sandbox cannot read another run\'s folder or another principal\'s cache', async () => {
		const a = await start(manager, workspace(), 'echo SECRET-RUN-A > "$TMPDIR/secret"; echo ready; sleep 20');
		try {
			assert.ok((await a.prepared.confirm(a.child)).ok);
			assert.ok(await waitFor(() => a.stdout().includes('ready'), 5_000));
			const runA = (await fs.readdir(runRoot)).map(name => join(runRoot, name)).find(dir => a.prepared.policy.tmp.startsWith(dir));
			assert.ok(runA && await exists(join(runA, 'tmp', 'secret')), 'run A wrote its temp');
			// B: the agent profile reads the whole disk but other runs.
			const b = await run(manager, agent(), `echo ran; cat ${runA}/tmp/secret; ls ${runRoot}; echo x > ${runA}/tmp/planted`);
			assert.strictEqual(b.status, 'completed', b.error);
			assert.ok(b.stdout.startsWith('ran'));
			assert.ok(!b.stdout.includes('SECRET-RUN-A'), b.stdout);
			assert.ok(!b.stdout.includes(basename(runA)), `other runs are not even listed: ${b.stdout}`);
			assert.ok(!await exists(join(runA, 'tmp', 'planted')));
		} finally {
			await stop(a);
		}
		// Package caches: one per principal; another principal's is out of reach.
		const cacheRoot = join(home, '.volt', 'sandbox-cache');
		const otherWs = join(root, 'other-ws');
		await fs.mkdir(otherWs, { recursive: true });
		const mine = join(cacheRoot, sandboxCacheKey({ providerId: 'claude-code', workspaceRoots: [ws] }));
		const theirs = join(cacheRoot, sandboxCacheKey({ providerId: 'claude-code', workspaceRoots: [otherWs] }));
		assert.notStrictEqual(mine, theirs);
		for (const dir of [mine, theirs]) {
			await fs.mkdir(join(dir, 'npm'), { recursive: true });
		}
		await fs.writeFile(join(theirs, 'npm', 'pkg.js'), 'THEIR-PACKAGE');
		const realCacheRoot = await fs.realpath(cacheRoot);
		const result = await manager.run({
			command: '/bin/sh',
			args: ['-c', `echo ran; echo mine > "$npm_config_cache/ok"; cat ${theirs}/npm/pkg.js; echo evil > ${theirs}/npm/pkg.js`],
			policy: agent(ws, await fs.realpath(mine)),
			context: { workspaceRoots: [ws], hostEnv: hostEnv() },
			isolate: [{ root: realCacheRoot, keep: await fs.realpath(mine) }],
		}, { timeoutMs: 30_000 });
		assert.strictEqual(result.status, 'completed', result.error);
		assert.ok(result.stdout.startsWith('ran'));
		assert.ok(!result.stdout.includes('THEIR-PACKAGE'), 'another principal\'s cache is unreadable');
		assert.strictEqual(await fs.readFile(join(theirs, 'npm', 'pkg.js'), 'utf8'), 'THEIR-PACKAGE', 'and unwritable');
		assert.ok(await exists(join(mine, 'npm', 'ok')), `its own stays usable: ${result.stderr}`);
	});

	test('NET live grant: after "Allow host" the same process connects, without a restart', async () => {
		let hits = 0;
		const upstream = net.createServer(socket => { hits++; socket.on('error', () => undefined); socket.end(); });
		await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
		const upstreamPort = (upstream.address() as net.AddressInfo).port;
		const proxied = managerWith({
			// Nothing leaves the machine: the name resolves to a public-looking address the test's connector sends to a local server.
			proxy: { lookup: async () => [{ address: '93.184.216.34', family: 4 }], connect: () => net.connect({ host: '127.0.0.1', port: upstreamPort }) },
		});
		const parsed = parseSandboxPolicyLayer({ schemaVersion: 1, network: { mode: 'proxy', allow: ['first.test'] } });
		assert.ok(parsed.ok);
		const { policy } = composeSandboxPolicy(workspace(), [{ source: 'user', trusted: true, layer: parsed.value }]);
		const trigger = join(ws, 'live-grant-go');
		// One perl process: CONNECT, report, wait for the trigger file, CONNECT again, report.
		const script = `${PERL} -MIO::Socket::INET -MMIME::Base64 -e '
			my ($auth, $hp) = $ENV{HTTPS_PROXY} =~ m{//([^@]+)@([^/]+)};
			sub try { my $s = IO::Socket::INET->new(PeerAddr => $hp, Timeout => 5) or return "noproxy";
				print $s "CONNECT later.test:443 HTTP/1.1\\r\\nHost: later.test:443\\r\\nProxy-Authorization: Basic " . encode_base64($auth, "") . "\\r\\n\\r\\n"; my $l = <$s>; $l =~ s/\\r?\\n//; return $l }
			$| = 1; print "pid=$$ ", try(), "\\n";
			for (1..200) { last if -e $ARGV[0]; select(undef, undef, undef, 0.05) }
			print "pid=$$ ", try(), "\\n";' ${trigger}`;
		const handle = await start(proxied, policy, script);
		try {
			assert.ok((await handle.prepared.confirm(handle.child)).ok);
			assert.ok(await waitFor(() => /pid=\d+ .*\n/.test(handle.stdout()), 10_000), handle.stdout());
			assert.match(handle.stdout(), /pid=\d+ HTTP\/1\.1 403/, 'not allowed yet');
			handle.prepared.allowDomains(['later.test']);
			await fs.writeFile(trigger, '');
			assert.ok(await waitFor(() => handle.stdout().split('\n').filter(Boolean).length >= 2, 10_000), handle.stdout());
			const [first, second] = handle.stdout().trim().split('\n');
			assert.match(second, /HTTP\/1\.1 200/, `allowed live: ${handle.stdout()}`);
			assert.strictEqual(first.split(' ')[0], second.split(' ')[0], 'the same process');
			assert.strictEqual(hits, 1, 'the connection reached the destination');
		} finally {
			await stop(handle);
			await new Promise(resolve => upstream.close(() => resolve(undefined)));
		}
	});

	test('LNX-ENV-1: a .env at depth 9 in a 25k-entry home is masked or the run is refused', async () => {
		const bigHome = join(root, 'big-home');
		const deep = join(bigHome, 'p', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
		await fs.mkdir(deep, { recursive: true });
		await fs.writeFile(join(deep, '.env'), 'SECRET=CANARY-DEEP-ENV\n');
		for (let d = 0; d < 50; d++) {
			const dir = join(bigHome, 'bulk', `d${d}`);
			await fs.mkdir(dir, { recursive: true });
			await Promise.all(Array.from({ length: 500 }, (_, i) => fs.writeFile(join(dir, `f${i}`), '')));
		}
		const facts: ISandboxHostFacts = { ...host, home: bigHome };
		const big = managerWith({}, facts);
		const policy = agentSandboxPolicy(
			{ level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: [ws] },
			{ platform: process.platform, home: bigHome, tempDirs: [join(root, 'agent-tmp')], cacheDir: join(bigHome, '.volt', 'sandbox-cache') },
		);
		const result = await big.run({ command: '/bin/sh', args: ['-c', `echo ran; cat ${join(deep, '.env')}`], policy, context: { workspaceRoots: [ws], hostEnv: { ...hostEnv(), HOME: bigHome } } }, { timeoutMs: 60_000 });
		if (result.status === 'unavailable') {
			assert.ok(result.unenforced.includes('filesystem.denyPatterns'), `refused for the pattern walk: ${result.error}`);
		} else {
			assert.strictEqual(result.status, 'completed', result.error);
			assert.ok(result.stdout.startsWith('ran'));
			assert.ok(!result.stdout.includes('CANARY-DEEP-ENV'), 'masked');
		}
	});

	linuxTest('LNX-SECCOMP-VSOCK: socket(AF_VSOCK) and netlink audit fail inside the sandbox; netlink route still lists interfaces', async () => {
		// AF_VSOCK; AF_NETLINK + NETLINK_AUDIT (9) as SOCK_RAW; then what must keep working.
		const result = await run(manager, workspace(), `${PERL} -e 'for my $t ([40, 1, 0], [16, 3, 9]) { if (socket(my $s, $t->[0], $t->[1], $t->[2])) { print "OPEN @$t\\n" } else { print "refused $t->[0]: $!\\n" } } socket(my $i, 2, 1, 0) and print "inet ok\\n"; socket(my $r, 16, 3, 0) and print "route ok\\n"'; ${process.execPath} -e 'console.log("interfaces", Object.keys(require("os").networkInterfaces()).join(","))' 2>&1 || true`);
		assert.strictEqual(result.status, 'completed', result.error);
		assert.ok(!result.stdout.includes('OPEN'), result.stdout);
		assert.match(result.stdout, /refused 40: Address family not supported/);
		assert.match(result.stdout, /refused 16: Address family not supported/);
		assert.match(result.stdout, /inet ok/, 'the allowed families still work');
		assert.match(result.stdout, /route ok/, 'netlink route stays open for getifaddrs');
		assert.match(result.stdout, /interfaces lo/, `os.networkInterfaces() works: ${result.stdout}`);
	});

	linuxTest('LNX-BWRAP-CVE: the probe ran the CVE-2026-87766 trial on the system bubblewrap and it held', async () => {
		const capabilities = await manager.capabilities();
		assert.ok(capabilities.details.some(line => line.startsWith('CVE-2026-87766: setup-time creation stayed inside')), capabilities.details.join('\n'));
		assert.ok(capabilities.details.some(line => line.includes('/usr/bin/bwrap')), 'the system bubblewrap');
	});

	test('launch protocol fds are the documented ones', () => {
		assert.deepStrictEqual(isMac ? SEATBELT_FDS : { status: BUBBLEWRAP_FDS.marker, go: BUBBLEWRAP_FDS.go }, isMac ? { status: 3, go: 4 } : { status: 3, go: 7 });
	});
});

/**
 * LNX-BWRAP-CVE, refusal half: run in the bubblewrap 0.9.0 image (scripts/volt-sandbox-linux-test.sh
 * cve). That build has CVE-2026-87766, so the probe must refuse it on the trial's evidence.
 */
(isLinux && process.env.VOLT_SANDBOX_EXPECT_BWRAP_CVE_REFUSAL ? suite : suite.skip)('Volt sandbox LNX-BWRAP-CVE refusal (bubblewrap 0.9.0 image)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('LNX-BWRAP-CVE: a bubblewrap whose trial lands outside the fixture is refused with install guidance', async function () {
		this.timeout(60_000);
		const manager = new SandboxManager();
		try {
			const capabilities = await manager.capabilities();
			assert.strictEqual(capabilities.available, false, capabilities.details.join('\n'));
			assert.ok(capabilities.diagnostics.some(line => /CVE-2026-87766/.test(line) && /landed outside/.test(line) && /0\.12\.0 or later/.test(line)), capabilities.diagnostics.join('\n'));
		} finally {
			await manager.dispose();
		}
	});
});

suite('Volt sandbox pattern walk scope (B-27)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('B-27: with narrow reads the unreadable home is not walked, and its toolchains are best effort: neither refuses the run', async () => {
		const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-walk-')));
		try {
			const home = join(root, 'home');
			const tools = join(home, 'tools');
			const ws = join(root, 'ws');
			await fs.mkdir(tools, { recursive: true });
			await fs.mkdir(join(ws, 'src'), { recursive: true });
			await fs.writeFile(join(tools, '.env'), 'SECRET=1\n');
			await fs.writeFile(join(ws, 'src', '.env'), 'SECRET=2\n');
			// More than the walk may visit: outside every readable root, and inside a toolchain.
			for (let d = 0; d < 40; d++) {
				await fs.mkdir(join(home, 'checkout', `d${d}`), { recursive: true });
				await fs.mkdir(join(tools, 'sdk', `d${d}`), { recursive: true });
			}
			const limits = { maxEntries: 30, maxDepth: 12, budgetMs: 5_000 } as const;
			const base: IResolvedSandboxPolicy = {
				name: 'walk', platform: process.platform, readAll: false,
				read: ['/usr', tools, ws], write: [ws], writeFiles: [], deny: [], protect: [],
				denyPatterns: [{ root: '/', names: ['.env'] }], protectPatterns: [], newRepositoryGuard: [], gitDirs: [],
				network: { mode: 'none', allow: [], loopbackPorts: [], listen: false },
				unixSockets: [], systemServices: false, limits: {}, env: {},
				cwd: ws, tmp: join(root, 'tmp'), home,
			};
			const narrow = await walkPatterns(base, { collectSockets: false }, limits);
			assert.strictEqual(narrow.complete, true, 'the workspace was walked whole; the rest of the home is not walked, the toolchain only best effort');
			assert.deepStrictEqual(narrow.deny.map(match => match.path).sort(), [join(tools, '.env'), join(ws, 'src', '.env')].sort());

			// A workspace the walk cannot finish still refuses.
			for (let d = 0; d < 40; d++) {
				await fs.mkdir(join(ws, 'bulk', `d${d}`), { recursive: true });
			}
			assert.strictEqual((await walkPatterns(base, { collectSockets: false }, limits)).complete, false);

			// So does a home the sandbox can read: it is walked whole.
			await fs.rm(join(ws, 'bulk'), { recursive: true });
			assert.strictEqual((await walkPatterns({ ...base, read: [...base.read, home] }, { collectSockets: false }, limits)).complete, false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
