/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Windows 11 sandbox (MXC ProcessContainer) adversarial suite: the WIN-*, NET-WIN-*, ATTEST-WIN,
 * TREE-WIN, RES-WIN, HELPER-WIN-1 and PERF-WIN-1 cases of the spec (K.3, J.3). Real containers,
 * real escape attempts; every denial is paired with proof that the workload ran.
 *
 * Windows only. With `VOLT_SANDBOX_REQUIRED` set (the `Sandbox (Windows MXC)` workflow on the
 * hosted windows-11-arm runner) a missing backend FAILS the suite. The binaries come from
 * `VOLT_MXC_DIR\<arch>\` (wxc-exec.exe from the pinned MXC release, volt-mxc-helper.exe built
 * by build/volt/mxc/buildHelper.mjs). The proxy cases need Medium integrity, as a normal user
 * runs Volt; CI starts the suite through a test-only `run-medium` launcher.
 */

import assert from 'assert';
import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as net from 'net';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { checkMxcEvidence, GIT_BASH_REFUSAL, MXC_HELPER_DIGESTS, MxcArch, mxcControlText, parseMxcAttestation, parseMxcStatus, WSL_REFUSAL } from '../../common/mxc.js';
import { ISandboxRunResult } from '../../common/sandboxBackend.js';
import { builtinProfile } from '../../common/sandboxProfiles.js';
import { IVoltSandboxPolicy } from '../../common/sandboxSchema.js';
import { MxcBackend } from '../../node/mxcBackend.js';
import { SandboxManager } from '../../node/sandboxManager.js';
import { ISandboxHostFacts, sandboxHostFacts } from '../../node/sandboxResolver.js';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';
const required = !!process.env.VOLT_SANDBOX_REQUIRED;
/** Chosen up front: Windows-only cases never run (and never claim anything) elsewhere. */
const winTest = isWindows ? test : test.skip;
const MARKER = 'volt-sandbox-ran';

interface IFixture {
	readonly root: string;
	readonly home: string;
	readonly ws: string;
	readonly outside: string;
	readonly copyDir: string;
	readonly host: ISandboxHostFacts;
	readonly manager: SandboxManager;
	readonly canary: { port: number; hits: () => number; close: () => Promise<void> };
	readonly canaries: Map<string, string>;
	readonly systemRoot: string;
	readonly helper: string;
}

async function sha(path: string): Promise<string> {
	return createHash('sha256').update(await fs.readFile(path)).digest('hex');
}

async function exists(path: string): Promise<boolean> {
	return fs.lstat(path).then(() => true, () => false);
}

async function canaryListener(): Promise<IFixture['canary']> {
	let hits = 0;
	const server = net.createServer(socket => { hits++; socket.destroy(); });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return { port: (server.address() as net.AddressInfo).port, hits: () => hits, close: () => new Promise(resolve => server.close(() => resolve())) };
}

function percentile(values: readonly number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)];
}

suite('Volt sandbox security: Windows MXC (adversarial, real containers)', function () {

	this.timeout(240_000);
	ensureNoDisposablesAreLeakedInTestSuite();
	let f: IFixture;
	let available = false;

	suiteSetup(async function () {
		if (!isWindows) {
			return;
		}
		const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-mxc-sec-')));
		const home = join(root, 'home');
		const ws = join(root, 'ws');
		const outside = join(root, 'outside');
		const copyDir = join(root, 'bin');
		for (const dir of [home, ws, outside, copyDir, join(home, '.ssh'), join(home, 'AppData', 'Roaming', 'Microsoft', 'Credentials'), join(ws, '.git', 'hooks'), join(ws, 'sub')]) {
			await fs.mkdir(dir, { recursive: true });
		}
		const canaries = new Map<string, string>();
		const plant = async (path: string, text: string) => {
			await fs.writeFile(path, text);
			canaries.set(path, await sha(path));
		};
		await plant(join(home, '.ssh', 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nCANARY-SSH\n');
		await plant(join(home, 'AppData', 'Roaming', 'Microsoft', 'Credentials', 'blob'), 'CANARY-DPAPI');
		await plant(join(ws, '.env'), 'SECRET=CANARY-DOTENV\n');
		await plant(join(ws, 'sub', '.env'), 'SECRET=CANARY-DOTENV-SUB\n');
		await plant(join(ws, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
		await plant(join(outside, 'secret.txt'), 'CANARY-OUTSIDE\n');
		await fs.writeFile(join(ws, 'readme.txt'), 'hello\n');
		await fs.writeFile(join(ws, '.env.example'), 'SECRET=\n');
		const real = await sandboxHostFacts();
		const host: ISandboxHostFacts = { ...real, home };
		const canary = await canaryListener();
		const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
		const arch = (process.arch === 'arm64' ? 'arm64' : 'x64') as MxcArch;
		const helper = join(copyDir, MXC_HELPER_DIGESTS[arch].slice(0, 16), 'volt-mxc-helper.exe');
		const manager = new SandboxManager(undefined, { runRoot: join(root, 'runs'), host, backend: new MxcBackend({ canaryPort: canary.port, copyDir }) });
		f = { root, home, ws, outside, copyDir, host, manager, canary, canaries, systemRoot, helper };
		const capabilities = await manager.capabilities();
		available = capabilities.available;
		console.log(`[volt-mxc] backend ${capabilities.backend} available=${available} details=${JSON.stringify(capabilities.details)} diagnostics=${JSON.stringify(capabilities.diagnostics)}`);
		if (!available && required) {
			throw new Error(`No Windows sandbox: ${capabilities.diagnostics.join(' ')} (CI requires the sandbox; failing instead of skipping)`);
		}
	});

	suiteTeardown(async () => {
		if (f) {
			await f.manager.dispose();
			await f.canary.close();
			await fs.rm(f.root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
		}
	});

	setup(function () {
		if (isWindows && !available) {
			this.skip();
		}
	});

	function hostEnv(): Record<string, string> {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && /^(path|pathext|systemroot|systemdrive|windir|comspec|programfiles|programfiles\(x86\)|programw6432|lang)$/i.test(key)) {
				env[key] = value;
			}
		}
		return { ...env, GITHUB_TOKEN: 'CANARY-ENV-GH', AWS_SECRET_ACCESS_KEY: 'CANARY-ENV-AWS' };
	}

	function workspace(extra: Partial<IVoltSandboxPolicy> = {}): IVoltSandboxPolicy {
		return { ...builtinProfile('workspace'), ...extra };
	}

	async function assertHostUnchanged(): Promise<void> {
		for (const [path, digest] of f.canaries) {
			assert.strictEqual(await sha(path), digest, `canary changed: ${path}`);
		}
		assert.deepStrictEqual((await fs.readdir(f.outside)).filter(name => name !== 'secret.txt'), [], 'nothing created outside');
		assert.strictEqual(f.canary.hits(), 0, 'the canary listener was reached');
	}

	async function run(policy: IVoltSandboxPolicy, file: string, args: readonly string[], options: { timeoutMs?: number; signal?: AbortSignal; expectRefusal?: boolean; stdin?: string } = {}): Promise<ISandboxRunResult> {
		const result = await f.manager.run({ command: file, args, policy, context: { workspaceRoots: [f.ws], hostEnv: hostEnv() } }, { timeoutMs: options.timeoutMs ?? 60_000, signal: options.signal, stdin: options.stdin });
		if (!options.expectRefusal) {
			assert.strictEqual(result.status, 'completed', `the run did not happen: ${result.error ?? ''} ${result.stderr}`);
		}
		return result;
	}

	let scripts = 0;
	/** Runs Node code in the sandbox; the script prints MARKER first, so a denial can't pass because nothing ran. */
	async function node(policy: IVoltSandboxPolicy, code: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ISandboxRunResult> {
		const script = join(f.ws, `probe-${++scripts}.js`);
		await fs.writeFile(script, `console.log(${JSON.stringify(MARKER)});\n${code}`);
		const result = await run(policy, process.execPath, [script], options);
		assert.ok(result.stdout.startsWith(MARKER), `the script did not start: ${JSON.stringify({ status: result.status, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, error: result.error, denials: result.denials, timing: result.timing })}`);
		return result;
	}

	function cmd(...parts: string[]): [string, string[]] {
		return [join(f.systemRoot, 'System32', 'cmd.exe'), ['/d', '/c', `echo ${MARKER}& ${parts.join(' & ')}`]];
	}

	const TRY = `const fs = require('fs'); const t = (label, fn) => { try { const v = fn(); console.log(label, 'OK', v === undefined ? '' : String(v).slice(0, 60)); } catch (e) { console.log(label, 'ERR', e.code); } };`;
	const CONNECT = `const net = require('net'); const connect = (h, p, ms = 3000) => new Promise(r => { const s = net.connect({ host: h, port: p }); const t0 = Date.now(); s.setTimeout(ms); s.on('connect', () => { s.destroy(); r('OK'); }); s.on('timeout', () => { s.destroy(); r('TIMEOUT'); }); s.on('error', e => r(e.code + '@' + (Date.now() - t0))); });`;

	winTest('PROBE-WIN: the backend probes, trials and reports Windows\' row honestly', async () => {
		const capabilities = await f.manager.capabilities();
		assert.strictEqual(capabilities.backend, 'mxc');
		assert.match(capabilities.details[0], /^Windows 11 /);
		assert.ok(capabilities.details.some(d => d.startsWith('trial: attested')), JSON.stringify(capabilities.details));
		for (const dimension of ['filesystem.read', 'filesystem.write', 'filesystem.deny', 'filesystem.protect', 'network.none', 'network.proxy', 'process.tree', 'process.isolation', 'env.clear'] as const) {
			assert.strictEqual(capabilities.enforcement[dimension], 'enforced', dimension);
		}
		assert.strictEqual(capabilities.enforcement['network.loopbackPorts'], 'unsupported');
		assert.strictEqual(capabilities.enforcement['limits.memory'], 'partial');
	});

	winTest('ATTEST-WIN-1: the workload runs only after external attestation of an AppContainer process', async () => {
		const prepared = await f.manager.prepare({ command: join(f.systemRoot, 'System32', 'cmd.exe'), args: ['/d', '/c', 'echo attested'], policy: workspace(), context: { workspaceRoots: [f.ws], hostEnv: hostEnv() } });
		try {
			const child = spawn(prepared.command, [...prepared.args], { cwd: prepared.cwd, env: prepared.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
			let out = '';
			child.stdout?.on('data', d => out += d);
			// 'close', not 'exit': output can still be in flight when the process exits.
			const exited = new Promise(resolve => child.once('close', resolve));
			const confirmation = await prepared.confirm(child);
			assert.ok(confirmation.ok, confirmation.ok ? '' : confirmation.error);
			assert.match(confirmation.ok ? confirmation.detail : '', /S-1-15-2-\d+(-\d+){6}, Low integrity, in job/);
			await exited;
			assert.match(out, /attested/);
			await prepared.terminate(child);
		} finally {
			await prepared.dispose();
		}
	});

	winTest('ATTEST-WIN-2 / FAULT-WIN-1: a prologue outside the sandbox is rejected, and without the go file nothing runs', async () => {
		const dir = await fs.mkdtemp(join(f.root, 'forged-'));
		const nonce = 'f0f0f0f0';
		const status = join(dir, 'status');
		const marker = join(f.ws, 'fault-marker.txt');
		const control = join(dir, 'prologue.txt');
		await fs.writeFile(control, mxcControlText({ nonce, statusFile: status, goFile: join(dir, 'go'), sentinel: join(f.outside, 'secret.txt'), network: 'none', limits: {}, commandLine: `cmd.exe /d /c echo x> "${marker}"` }));
		// The real prologue, run unsandboxed: the forged "ready" must not attest.
		const child = spawn(f.helper, ['prologue', control], { stdio: 'ignore', windowsHide: true });
		try {
			for (let i = 0; i < 100 && !parseMxcStatus(await fs.readFile(status, 'utf8').catch(() => '')).ready; i++) {
				await new Promise(resolve => setTimeout(resolve, 50));
			}
			const ready = parseMxcStatus(await fs.readFile(status, 'utf8'));
			assert.ok(ready.ready, 'the prologue wrote ready');
			const { stdout } = await execFileAsync(f.helper, ['attest', String(ready.ready.pid)]);
			const check = checkMxcEvidence(ready, parseMxcAttestation(stdout), { nonce, helperPath: f.helper, network: 'none' });
			assert.strictEqual(check.ok, false);
			assert.match(check.error ?? '', /not in an AppContainer/);
			// No go file was written: the workload never started.
			await new Promise(resolve => setTimeout(resolve, 1500));
			assert.strictEqual(await exists(marker), false, 'the workload ran without the go file');
		} finally {
			child.kill();
		}
	});

	winTest('WIN-FS-1 / CRED-WIN: credentials, .env files and anything outside the policy are unreadable', async () => {
		const r = await node(workspace(), `${TRY}
			t('ssh', () => fs.readFileSync(${JSON.stringify(join(f.home, '.ssh', 'id_ed25519'))}, 'utf8'));
			t('dpapi', () => fs.readFileSync(${JSON.stringify(join(f.home, 'AppData', 'Roaming', 'Microsoft', 'Credentials', 'blob'))}, 'utf8'));
			t('outside', () => fs.readFileSync(${JSON.stringify(join(f.outside, 'secret.txt'))}, 'utf8'));
			t('dotenv', () => fs.readFileSync(${JSON.stringify(join(f.ws, '.env'))}, 'utf8'));
			t('dotenv-sub', () => fs.readFileSync(${JSON.stringify(join(f.ws, 'sub', '.env'))}, 'utf8'));
			t('example', () => fs.readFileSync(${JSON.stringify(join(f.ws, '.env.example'))}, 'utf8'));
			t('readme', () => fs.readFileSync(${JSON.stringify(join(f.ws, 'readme.txt'))}, 'utf8'));`);
		for (const label of ['ssh', 'dpapi', 'outside', 'dotenv', 'dotenv-sub']) {
			assert.match(r.stdout, new RegExp(`^${label} ERR (EPERM|EACCES|ENOENT)`, 'm'), `${label}: ${r.stdout}`);
		}
		assert.match(r.stdout, /^example OK/m);
		assert.match(r.stdout, /^readme OK hello/m);
		assert.ok(!/CANARY/.test(r.stdout + r.stderr));
		await assertHostUnchanged();
	});

	winTest('WIN-FS-2 / PERS-WIN: writes land only in the workspace and temp; protected git files stay read-only', async () => {
		const r = await node(workspace(), `${TRY}
			t('outside', () => fs.writeFileSync(${JSON.stringify(join(f.outside, 'x.txt'))}, 'x'));
			t('home', () => fs.writeFileSync(${JSON.stringify(join(f.home, 'x.txt'))}, 'x'));
			t('git-config', () => fs.appendFileSync(${JSON.stringify(join(f.ws, '.git', 'config'))}, '[core]\\n\\tfsmonitor = evil\\n'));
			t('git-hook', () => fs.writeFileSync(${JSON.stringify(join(f.ws, '.git', 'hooks', 'pre-commit'))}, 'evil'));
			t('git-config-read', () => fs.readFileSync(${JSON.stringify(join(f.ws, '.git', 'config'))}, 'utf8').length);
			t('workspace', () => fs.writeFileSync(${JSON.stringify(join(f.ws, 'new.txt'))}, 'ok'));
			t('temp', () => fs.writeFileSync(require('path').join(process.env.TEMP, 't.txt'), 'ok'));`);
		for (const label of ['outside', 'home', 'git-config', 'git-hook']) {
			assert.match(r.stdout, new RegExp(`^${label} ERR (EPERM|EACCES|ENOENT)`, 'm'), `${label}: ${r.stdout}`);
		}
		for (const label of ['git-config-read', 'workspace', 'temp']) {
			assert.match(r.stdout, new RegExp(`^${label} OK`, 'm'), `${label}: ${r.stdout}`);
		}
		assert.strictEqual(await exists(join(f.ws, '.git', 'hooks', 'pre-commit')), false);
		assert.strictEqual(await exists(join(f.home, 'x.txt')), false);
		await fs.rm(join(f.ws, 'new.txt'), { force: true });
		await assertHostUnchanged();
	});

	winTest('WIN-TMP-1 / WIN-DLL-1: temp is the run\'s own folder; system folders lead PATH; no current-folder lookup', async () => {
		const r = await node(workspace(), `console.log('TEMP=' + process.env.TEMP); console.log('TMP=' + process.env.TMP); console.log('PATH0=' + process.env.PATH.split(';')[0]); console.log('NDC=' + process.env.NoDefaultCurrentDirectoryInExePath); console.log('TOKEN=' + (process.env.GITHUB_TOKEN ?? '') + (process.env.AWS_SECRET_ACCESS_KEY ?? ''));`);
		const temp = /^TEMP=(.*)$/m.exec(r.stdout)?.[1] ?? '';
		assert.ok(temp.toLowerCase().startsWith(join(f.root, 'runs').toLowerCase()), temp);
		assert.match(r.stdout, new RegExp(`^TMP=${temp.replace(/\\/g, '\\\\')}$`, 'm'));
		assert.match(r.stdout, /^PATH0=.*\\System32$/im);
		assert.match(r.stdout, /^NDC=1$/m);
		assert.match(r.stdout, /^TOKEN=$/m, 'secret-looking host variables never reach the workload');
	});

	winTest('WIN-ENV-1: the container cannot open the user\'s other processes', async () => {
		const r = await node(workspace(), `try { process.kill(${process.pid}, 0); console.log('signal OK'); } catch (e) { console.log('signal ERR', e.code); }`);
		assert.match(r.stdout, /^signal ERR (EPERM|EACCES)/m, r.stdout);
	});

	winTest('NET-WIN-2: network none (Model 3): no loopback, no public connections, no DNS', async () => {
		const r = await node(workspace(), `${CONNECT} (async () => {
			console.log('loop', await connect('127.0.0.1', ${f.canary.port}));
			console.log('public', await connect('1.1.1.1', 443));
			await new Promise(res => require('dns').lookup('example.com', (e, a) => { console.log('dns', e ? e.code : 'resolved ' + a); res(); }));
		})();`);
		assert.match(r.stdout, /^loop EACCES@/m, r.stdout);
		assert.match(r.stdout, /^public EACCES@/m, r.stdout);
		assert.match(r.stdout, /^dns (ENOTFOUND|EAI_AGAIN|ESERVFAIL)/m, r.stdout);
		await assertHostUnchanged();
	});

	winTest('NET-WIN-1: network proxy (Model 2): only Volt\'s proxy is reachable', async () => {
		const r = await node(builtinProfile('network'), `${CONNECT} (async () => {
			const proxy = new URL(process.env.HTTP_PROXY);
			console.log('proxy', await connect('127.0.0.1', Number(proxy.port)));
			console.log('loop', await connect('127.0.0.1', ${f.canary.port}));
			console.log('public', await connect('1.1.1.1', 443));
		})();`);
		assert.match(r.stdout, /^proxy OK/m, `${r.stdout}\n(Model 2 needs a Medium-integrity proxy; run the suite through run-medium)`);
		assert.match(r.stdout, /^loop EACCES@/m, r.stdout);
		assert.match(r.stdout, /^public EACCES@/m, r.stdout);
		await assertHostUnchanged();
	});

	winTest('NET-WIN-DNS (expected residual, MXC#1666): DNS still resolves in proxy mode', async () => {
		const r = await node(builtinProfile('network'), `require('dns').lookup('example.com', (e, a) => console.log('dns', e ? e.code : 'resolved'));`);
		assert.match(r.stdout, /^dns resolved/m, `Residual gone: DNS no longer resolves in proxy mode. Remove NET-WIN-DNS from the residuals (J.3) and this expectation. ${r.stdout}`);
	});

	winTest('NET-WIN-3: a sandboxed listener is unreachable from the host', async () => {
		const port = 20000 + Math.floor(Math.random() * 20000);
		const controller = new AbortController();
		const running = node(workspace(), `require('net').createServer(c => c.end('x')).listen(${port}, '0.0.0.0', () => console.log('listening')); setTimeout(() => process.exit(0), 8000);`, { signal: controller.signal });
		await new Promise(resolve => setTimeout(resolve, 3000));
		const reached = await new Promise<string>(resolve => {
			const s = net.connect({ host: '127.0.0.1', port });
			s.setTimeout(2000);
			s.on('connect', () => { s.destroy(); resolve('OK'); });
			s.on('timeout', () => { s.destroy(); resolve('TIMEOUT'); });
			s.on('error', e => resolve((e as NodeJS.ErrnoException).code ?? 'error'));
		});
		const r = await running;
		assert.match(r.stdout, /listening/);
		assert.notStrictEqual(reached, 'OK');
	});

	winTest('WIN-SPAWN-1: "no new processes" is refused on Windows, never run without it', async () => {
		const policy = workspace({ process: { limits: { processes: 1 } } });
		const r = await run(policy, ...cmd('echo should-not-run'), { expectRefusal: true });
		assert.strictEqual(r.status, 'unavailable');
		assert.match(r.error ?? '', /No new processes/i);
		assert.ok(!r.stdout.includes(MARKER));
	});

	winTest('WIN-MSYS-1: Git Bash, MSYS2 and WSL images are refused with a reason', async () => {
		const gitBash = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
		if (await exists(gitBash)) {
			for (const file of [gitBash, 'C:\\Program Files\\Git\\bin\\bash.exe']) {
				const r = await run(workspace(), file, ['-c', 'echo ok'], { expectRefusal: true });
				assert.strictEqual(r.status, 'unavailable', file);
				assert.strictEqual(r.error, GIT_BASH_REFUSAL);
			}
		} else {
			console.warn('[volt-mxc] Git for Windows is not installed: WIN-MSYS-1 checks only the classifier (common suite)');
		}
		const wsl = join(f.systemRoot, 'System32', 'wsl.exe');
		if (await exists(wsl)) {
			const r = await run(workspace(), wsl, ['--status'], { expectRefusal: true });
			assert.strictEqual(r.status, 'unavailable');
			assert.strictEqual(r.error, WSL_REFUSAL);
		}
	});

	winTest('WIN-MSYS-2: Git Bash on the approved AppContainer-compatible runtime runs, contained, through this backend', async () => {
		// Prepared by scripts/volt-sandbox-windows-gitbash.ps1: a copy of Git for Windows with the
		// pinned patched msys-2.0.dll and every image opted into ASLR. The policy is the plain
		// workspace profile plus a read grant for the copy: nothing is widened for Git Bash.
		const root = process.env.VOLT_MSYS_RUNTIME_ROOT;
		if (!root) {
			assert.ok(!required, 'CI prepares VOLT_MSYS_RUNTIME_ROOT before the suite');
			console.warn('[volt-mxc] VOLT_MSYS_RUNTIME_ROOT is not set: WIN-MSYS-2 needs the prepared runtime copy');
			return;
		}
		const manager = new SandboxManager(undefined, { runRoot: join(f.root, 'runs-msys'), host: f.host, backend: new MxcBackend({ canaryPort: f.canary.port, copyDir: f.copyDir, msysRuntimeRoot: root }) });
		try {
			const unix = (path: string) => path.replace(/\\/g, '/');
			const script = [
				`echo ${MARKER}`,
				'echo hi | tr a-z A-Z | sed s/^/pipe=/',
				'x=$(echo ok); echo cmdsub=$x',
				'(echo subshell=ok)',
				'sleep 1 & wait $! && echo background=ok',
				'git --version >/dev/null && echo git=ok',
				'cd $(cygpath -u $TEMP) && git init -q r && cd r && echo a > f && git add f && git -c user.name=v -c user.email=v@x commit -qm m && echo commit=$(git rev-list --count HEAD)',
				`cat '${unix(join(f.outside, 'secret.txt'))}' >/dev/null 2>&1 && echo read-outside=LEAK || echo read-outside=denied`,
				`cat '${unix(join(f.home, '.ssh', 'id_ed25519'))}' >/dev/null 2>&1 && echo ssh=LEAK || echo ssh=denied`,
				`echo x 2>/dev/null > '${unix(join(f.outside, 'msys.txt'))}' && echo write-outside=LEAK || echo write-outside=denied`,
			].join('; ');
			const env = hostEnv();
			const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
			env[pathKey] = [join(root, 'usr', 'bin'), join(root, 'cmd'), env[pathKey]].join(';');
			const policy = workspace({ filesystem: { ...builtinProfile('workspace').filesystem, read: [...builtinProfile('workspace').filesystem.read, root] } });
			const r = await manager.run({ command: join(root, 'usr', 'bin', 'bash.exe'), args: ['--noprofile', '--norc', '-c', script], policy, context: { workspaceRoots: [f.ws], hostEnv: env } }, { timeoutMs: 120_000 });
			console.log(`[volt-mxc] WIN-MSYS-2 ${r.status} exit=${r.exitCode} in ${r.timing.totalMs} ms: ${r.stdout.replace(/\s+/g, ' ').trim()} ${r.stderr.replace(/\s+/g, ' ').trim().slice(0, 400)}`);
			assert.strictEqual(r.status, 'completed', `${r.error ?? ''} ${r.stderr}`);
			assert.ok(r.stdout.startsWith(MARKER), r.stdout + r.stderr);
			for (const expected of ['pipe=HI', 'cmdsub=ok', 'subshell=ok', 'background=ok', 'git=ok', 'commit=1', 'read-outside=denied', 'ssh=denied', 'write-outside=denied']) {
				assert.match(r.stdout, new RegExp(`^${expected}$`, 'm'), `${expected}: ${r.stdout} ${r.stderr}`);
			}
			assert.strictEqual(r.exitCode, 0);
			await assertHostUnchanged();
		} finally {
			await manager.dispose();
		}
	});

	winTest('WIN-ESC-1/2: WSL and Task Scheduler cannot be reached from inside', async () => {
		const task = `VoltEscape${process.pid}`;
		const marker = join(f.outside, 'esc-wsl.txt');
		// `%errorlevel%` would expand when cmd parses the line, before either command runs.
		const r = await run(workspace(), ...cmd(`(schtasks /create /tn ${task} /tr "cmd /c echo x > ${join(f.outside, 'esc-task.txt')}" /sc once /st 23:59 /f && echo schtasks=created || echo schtasks=refused)`, `(wsl.exe -e sh -c "echo x > /mnt/c${marker.slice(2).replace(/\\/g, '/')}" && echo wsl=ran || echo wsl=refused)`));
		assert.ok(r.stdout.startsWith(MARKER), JSON.stringify({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }));
		console.log(`[volt-mxc] WIN-ESC-1/2 ${r.stdout.replace(/\s+/g, ' ').trim()}`);
		assert.match(r.stdout, /schtasks=refused/, r.stdout);
		const registered = await execFileAsync(join(f.systemRoot, 'System32', 'schtasks.exe'), ['/query', '/tn', task]).then(() => true, () => false);
		if (registered) {
			await execFileAsync(join(f.systemRoot, 'System32', 'schtasks.exe'), ['/delete', '/tn', task, '/f']).catch(() => undefined);
		}
		assert.strictEqual(registered, false, 'a scheduled task was registered from inside the sandbox');
		await assertHostUnchanged();
	});

	winTest('WIN-ESC-3: WMI Win32_Process.Create cannot start a process outside', async () => {
		const marker = join(f.outside, 'esc-wmi.txt');
		const ps = join(f.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
		const r = await run(workspace(), ps, ['-NoProfile', '-NonInteractive', '-Command', `Write-Output ${MARKER}; try { $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c echo x > ${marker}' } -ErrorAction Stop; Write-Output ('wmi=' + $r.ReturnValue) } catch { Write-Output ('wmi-error ' + $_.Exception.Message) }`], { timeoutMs: 180_000 });
		assert.ok(r.stdout.includes(MARKER), r.stdout + r.stderr);
		await new Promise(resolve => setTimeout(resolve, 3000));
		assert.strictEqual(await exists(marker), false, `WMI started a process outside the sandbox: ${r.stdout}`);
		console.log(`[volt-mxc] WIN-ESC-3 ${r.stdout.trim().split(/\r?\n/).pop()} in ${r.timing.totalMs} ms`);
	});

	winTest('WIN-ESC-4: ShellExecute (url.dll FileProtocolHandler) cannot start a program outside', async () => {
		const marker = join(f.outside, 'esc-shell.txt');
		const script = join(f.ws, 'esc.cmd');
		await fs.writeFile(script, `@echo x > "${marker}"\r\n`);
		const r = await run(workspace(), ...cmd(`rundll32.exe url.dll,FileProtocolHandler "${script}"`, 'echo shell=%errorlevel%'));
		assert.ok(r.stdout.startsWith(MARKER), JSON.stringify({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }));
		await new Promise(resolve => setTimeout(resolve, 4000));
		assert.strictEqual(await exists(marker), false, 'ShellExecute ran a program outside the sandbox');
	});

	winTest('WIN-UI-1: the clipboard is closed to the container', async () => {
		const ps = join(f.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
		await execFileAsync(ps, ['-NoProfile', '-Command', 'Set-Clipboard -Value volt-host-before']);
		const token = `volt-clip-${process.pid}`;
		const r = await run(workspace(), ...cmd(`(echo ${token}| clip) & echo clip=%errorlevel%`));
		assert.ok(r.stdout.startsWith(MARKER), JSON.stringify({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }));
		const { stdout } = await execFileAsync(ps, ['-NoProfile', '-Command', 'Get-Clipboard']);
		assert.ok(!stdout.includes(token), `the container wrote the clipboard: ${r.stdout}`);
	});

	winTest('WIN-HANDLE-1: handles the launcher inherited never reach the workload', async () => {
		const prepared = await f.manager.prepare({ command: process.execPath, args: ['-e', `console.log(${JSON.stringify(MARKER)}); for (let fd = 3; fd < 9; fd++) { try { require('fs').writeSync(fd, 'leak'); console.log('fd' + fd + ' OPEN'); } catch (e) { console.log('fd' + fd + ' ' + e.code); } }`], policy: workspace(), context: { workspaceRoots: [f.ws], hostEnv: hostEnv() } });
		try {
			const child = spawn(prepared.command, [...prepared.args], { cwd: prepared.cwd, env: prepared.env, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true });
			let out = '';
			let leaked = '';
			child.stdout?.on('data', d => out += d);
			for (let fd = 3; fd < 9; fd++) {
				(child.stdio[fd] as NodeJS.ReadableStream | null)?.on('data', d => leaked += d);
			}
			const exited = new Promise(resolve => child.once('exit', resolve));
			const confirmation = await prepared.confirm(child);
			assert.ok(confirmation.ok, confirmation.ok ? '' : confirmation.error);
			await exited;
			await new Promise(resolve => setTimeout(resolve, 200));
			assert.ok(out.startsWith(MARKER), out);
			assert.ok(!/OPEN/.test(out), out);
			assert.strictEqual(leaked, '', 'data reached a pipe the workload should not hold');
			await prepared.terminate(child);
		} finally {
			await prepared.dispose();
		}
	});

	winTest('WIN-PIPE-1: the container cannot open Volt\'s named pipes', async () => {
		let hits = 0;
		const name = `\\\\.\\pipe\\volt-mxc-test-${process.pid}`;
		const server = net.createServer(socket => { hits++; socket.destroy(); });
		await new Promise<void>(resolve => server.listen(name, resolve));
		try {
			const r = await node(workspace(), `const s = require('net').connect(${JSON.stringify(name)}); s.on('connect', () => { console.log('pipe OK'); s.destroy(); }); s.on('error', e => console.log('pipe ERR', e.code));`);
			assert.match(r.stdout, /^pipe ERR/m, r.stdout);
			assert.strictEqual(hits, 0);
		} finally {
			await new Promise(resolve => server.close(resolve));
		}
	});

	winTest('TREE-WIN-1: stopping a run ends every process it started, detached ones included', async () => {
		const beat = join(f.ws, 'heartbeat.txt');
		const child = `setInterval(() => require('fs').writeFileSync(${JSON.stringify(beat)}, String(Date.now())), 100)`;
		const controller = new AbortController();
		const running = node(workspace(), `const cp = require('child_process'); const c = cp.spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: true, stdio: 'ignore' }); c.unref(); console.log('grandchild', c.pid); setInterval(() => {}, 1000);`, { signal: controller.signal });
		for (let i = 0; i < 100 && !await exists(beat); i++) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		assert.ok(await exists(beat), 'the detached grandchild started');
		controller.abort();
		const r = await running;
		assert.strictEqual(r.cancelled, true);
		await new Promise(resolve => setTimeout(resolve, 1500));
		const before = await fs.readFile(beat, 'utf8');
		await new Promise(resolve => setTimeout(resolve, 1500));
		assert.strictEqual(await fs.readFile(beat, 'utf8'), before, 'a process of the run outlived it');
		await fs.rm(beat, { force: true });
	});

	winTest('TREE-WIN-2: when the workload exits, what it left behind is ended too', async () => {
		const beat = join(f.ws, 'heartbeat2.txt');
		const child = `setInterval(() => require('fs').writeFileSync(${JSON.stringify(beat)}, String(Date.now())), 100)`;
		await node(workspace(), `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: true, stdio: 'ignore' }); c.unref(); setTimeout(() => process.exit(0), 1500);`);
		await new Promise(resolve => setTimeout(resolve, 1500));
		const before = await fs.readFile(beat, 'utf8').catch(() => '');
		await new Promise(resolve => setTimeout(resolve, 1500));
		assert.strictEqual(await fs.readFile(beat, 'utf8').catch(() => ''), before, 'a leftover process kept running');
		await fs.rm(beat, { force: true });
	});

	winTest('RES-WIN-1: a memory limit is enforced by polling the job (best effort)', async () => {
		const policy = workspace({ process: { limits: { memoryMB: 128, wallClockSeconds: 60 } } });
		const r = await node(policy, `const keep = []; setInterval(() => { keep.push(Buffer.alloc(32 * 1024 * 1024, 1)); }, 100);`, { timeoutMs: 60_000 });
		assert.ok(r.denials.some(d => d.kind === 'limit' && d.target.startsWith('memory')), JSON.stringify(r.denials));
		assert.strictEqual(r.timedOut, false);
		assert.ok(r.unenforced.includes('limits.memory'));
	});

	winTest('WIN-NODE-1: tools that look upward from their folders work (ancestors are listable, not readable)', async () => {
		await fs.mkdir(join(f.ws, 'lib'), { recursive: true });
		await fs.writeFile(join(f.ws, 'lib', 'm.js'), 'module.exports = 42;');
		const r = await node(workspace(), `console.log('require', require('./lib/m.js')); ${TRY} t('list-parent', () => fs.readdirSync(${JSON.stringify(f.root)}).length); t('read-parent-file', () => fs.readFileSync(${JSON.stringify(join(f.outside, 'secret.txt'))}, 'utf8'));`);
		assert.match(r.stdout, /^require 42/m);
		assert.match(r.stdout, /^read-parent-file ERR/m);
	});

	winTest('HELPER-WIN-1: a wxc-exec that is not the pinned build is refused', async () => {
		const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
		const source = process.env.VOLT_MXC_DIR;
		assert.ok(source, 'VOLT_MXC_DIR is set');
		const tampered = join(f.root, 'tampered');
		await fs.mkdir(join(tampered, arch), { recursive: true });
		const exe = await fs.readFile(join(source!, arch, 'wxc-exec.exe'));
		exe[exe.length - 1] ^= 0xff;
		await fs.writeFile(join(tampered, arch, 'wxc-exec.exe'), exe);
		await fs.copyFile(join(source!, arch, 'volt-mxc-helper.exe'), join(tampered, arch, 'volt-mxc-helper.exe'));
		const capabilities = await new MxcBackend({ binaryDir: tampered, copyDir: join(f.root, 'tampered-bin') }).probe();
		assert.strictEqual(capabilities.available, false);
		assert.match(capabilities.diagnostics.join(' '), /pinned/);
	});

	winTest('PERF-WIN-1: sandboxed command start-up (p50/p95)', async () => {
		const cmdTimes: number[] = [];
		const nodeTimes: number[] = [];
		for (let i = 0; i < 20; i++) {
			const r = await run(workspace(), join(f.systemRoot, 'System32', 'cmd.exe'), ['/d', '/c', 'exit 0']);
			cmdTimes.push(r.timing.totalMs);
		}
		for (let i = 0; i < 10; i++) {
			const r = await run(workspace(), process.execPath, ['-e', '0']);
			nodeTimes.push(r.timing.totalMs);
		}
		const unsandboxed: number[] = [];
		for (let i = 0; i < 10; i++) {
			const t0 = Date.now();
			await execFileAsync(join(f.systemRoot, 'System32', 'cmd.exe'), ['/d', '/c', 'exit 0']);
			unsandboxed.push(Date.now() - t0);
		}
		const line = `PERF-WIN-1 cmd p50=${percentile(cmdTimes, 50)}ms p95=${percentile(cmdTimes, 95)}ms; node p50=${percentile(nodeTimes, 50)}ms p95=${percentile(nodeTimes, 95)}ms; unsandboxed cmd p50=${percentile(unsandboxed, 50)}ms (n=${cmdTimes.length}/${nodeTimes.length}/${unsandboxed.length})`;
		console.log(`[volt-mxc] ${line}`);
		if (process.env.GITHUB_STEP_SUMMARY) {
			await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
		}
		assert.ok(cmdTimes.every(ms => ms > 0));
	});
});
