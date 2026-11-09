/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Failover of a chat's sandbox (R1): every way a launch can fail ends in a typed refusal, fast,
 * or in a working run; never a hang, a silent unsandboxed run, or a stuck start. And the denial
 * noise of a normal turn (a shell's startup files, npm's own `~/.npmrc`, the run's canary) stays
 * denied without a card. Ids: FAIL-*, PROBE-RETRY-1, DENY-QUIET-*.
 *
 * The pure and scripted-backend suites run everywhere. The real-sandbox suite skips loudly
 * without a backend, and fails instead under `VOLT_SANDBOX_REQUIRED`.
 */

import assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { allEnforcement, ISandboxBackendCapabilities, SandboxUnavailableError } from '../../common/sandboxBackend.js';
import { ISandboxDenial, isNoiseDenial, isQuietDenial } from '../../common/sandboxDenials.js';
import { agentSandboxPolicy, IVoltSandboxRequest } from '../../common/sandboxPolicy.js';
import { builtinProfile } from '../../common/sandboxProfiles.js';
import { IResolvedSandboxPolicy } from '../../common/sandboxResolved.js';
import { ISandboxBackend, ISandboxLaunchOptions, ISandboxLaunchSpec } from '../../node/sandboxBackends.js';
import { sandboxCacheKey, VoltSandboxLauncher } from '../../node/sandboxLauncher.js';
import { processAlive, SandboxManager, sweepRunRoot } from '../../node/sandboxManager.js';
import { ProbeCache } from '../../node/sandboxProbeCache.js';
import { ISandboxHostFacts, sandboxHostFacts } from '../../node/sandboxResolver.js';
import { SeatbeltBackend } from '../../node/seatbeltBackend.js';
import { realSandboxAvailable } from './sandboxSuiteGate.js';

const isMac = process.platform === 'darwin';
const macTest = isMac ? test : test.skip;

/** A pid that existed and is gone: a process this test started and waited for. */
async function deadPid(): Promise<number> {
	const child = spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' });
	await new Promise(resolve => child.once('exit', resolve));
	return child.pid!;
}

suite('Volt sandbox failover: pure parts (R1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('DENY-QUIET-1: a shell\'s and a tool\'s own startup reads are quiet; the agent asking for the same file is not', () => {
		const home = '/Users/u';
		const read = (relative: string, process?: string): ISandboxDenial => ({ kind: 'read', target: `${home}/${relative}`, source: 'os', ...(process ? { process } : {}) });
		const quiet = [
			read('.zshrc', 'zsh'), read('.zshenv', 'zsh'), read('.zprofile', '-zsh'), read('.zlogin', 'zsh'), read('.bashrc', 'bash'), read('.bash_profile', 'bash'),
			read('.bash_login', 'bash'), read('.profile', 'sh'), read('.inputrc', 'bash'), read('.config/fish/config.fish', 'fish'), read('.oh-my-zsh/oh-my-zsh.sh', 'zsh'),
			// Linux reports no process: a shell file is still quiet.
			read('.bashrc'),
			read('.npmrc', 'node'), read('.npmrc', 'npm'), read('.yarnrc', 'node'), read('.yarnrc.yml', 'yarn'), read('.netrc', 'git-remote-https'), read('.netrc', 'curl'),
			read('.pypirc', 'python3'), read('.pypirc', 'pip'), read('.docker/config.json', 'docker'),
		];
		for (const denial of quiet) {
			assert.ok(isQuietDenial(denial, home), `quiet: ${denial.target} (${denial.process})`);
		}
		const loud: ISandboxDenial[] = [
			// The agent itself reading them.
			read('.zshrc', 'cat'), read('.npmrc', 'cat'), read('.netrc', 'head'), read('.docker/config.json', 'cat'),
			// No process named: a credential file keeps its card.
			read('.npmrc'),
			// Writes, other files and other homes.
			{ kind: 'write', target: `${home}/.zshrc`, source: 'os', process: 'zsh' },
			read('.ssh/id_ed25519', 'ssh'), read('other-project/notes.md', 'zsh'), read('.aws/credentials', 'node'),
			{ kind: 'read', target: '/Users/someone-else/.zshrc', source: 'os', process: 'zsh' },
			{ kind: 'network', target: 'example.com', source: 'proxy' },
		];
		for (const denial of loud) {
			assert.ok(!isQuietDenial(denial, home), `card: ${denial.kind} ${denial.target} (${denial.process})`);
		}
		// The home folder and the folders above the workspace or an allowed folder: the CLI and git
		// probe them by themselves; `ls ~` is the agent asking.
		const roots = [`${home}/Projects/app`, '/Volumes/work/extra'];
		const at = (target: string, process?: string): ISandboxDenial => ({ kind: 'read', target, source: 'os', ...(process ? { process } : {}) });
		for (const denial of [at(home, 'node'), at(home, 'claude'), at(`${home}/`, 'codex'), at(`${home}/Projects`, 'node'), at('/Users', 'node'), at(`${home}/Projects/.git`, 'git'), at(`${home}/.gitignore`, 'rg'), at(`${home}/Projects/package.json`, 'node'), at('/Volumes/work', 'node')]) {
			assert.ok(isQuietDenial(denial, home, roots), `quiet: ${denial.target} (${denial.process})`);
		}
		for (const denial of [at(home, 'ls'), at(`${home}/Projects`, 'find'), at(`${home}/Projects/.git`, 'cat'), at(home), at(`${home}/Documents`, 'node'), at(`${home}/Projects/app2`, 'node'), at(`${home}/Projects/secrets.txt`, 'node'), at('/', 'node'), { kind: 'write', target: home, source: 'os', process: 'node' } satisfies ISandboxDenial]) {
			assert.ok(!isQuietDenial(denial, home, roots), `card: ${denial.kind} ${denial.target} (${denial.process})`);
		}
	});

	test('PROBE-RETRY-1: a failed probe is tried again after a while; a working one stands until its key changes', async () => {
		let now = 0;
		let calls = 0;
		let works = false;
		const cache = new ProbeCache<boolean>(ok => !ok, 30_000, () => now);
		const probe = async () => { calls++; return works; };
		assert.strictEqual(await cache.get('k', probe), false);
		assert.strictEqual(await cache.get('k', probe), false, 'within the retry delay the failure stands');
		assert.strictEqual(calls, 1);
		works = true;
		now = 30_000;
		assert.strictEqual(await cache.get('k', probe), true, 'a transient failure no longer refuses every launch');
		assert.strictEqual(calls, 2);
		now = 10_000_000;
		assert.strictEqual(await cache.get('k', probe), true, 'a working probe is kept');
		assert.strictEqual(calls, 2);
		works = false;
		assert.strictEqual(await cache.get('k2', probe), false, 'a new key (an OS update, a new binary) probes again');
		assert.strictEqual(calls, 3);
		// A probe that throws counts as failed too.
		const throwing = new ProbeCache<boolean>(ok => !ok, 10, () => now);
		await assert.rejects(throwing.get('k', async () => { calls++; throw new Error('boom'); }));
		await new Promise(resolve => setTimeout(resolve, 0));
		now += 10;
		assert.strictEqual(await throwing.get('k', async () => true), true);
	});

	test('FAIL-CRASH-1: a run whose Volt died is swept at the next start, its tag reaped; a live owner\'s run never is', async () => {
		const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-sweep-')));
		try {
			const dead = await deadPid();
			const make = async (name: string, files: Record<string, unknown>, ageMs = 0) => {
				const dir = join(root, name);
				await fs.mkdir(join(dir, 'tmp'), { recursive: true });
				for (const [file, value] of Object.entries(files)) {
					await fs.writeFile(join(dir, file), JSON.stringify(value));
				}
				const at = new Date(Date.now() - ageMs);
				await fs.utimes(dir, at, at);
				return dir;
			};
			const day = 24 * 3600 * 1000;
			const deadRun = await make('volt-sbx-dead', { 'owner.json': { ownerPid: dead, tag: '0123456789abcdef' } });
			const liveRun = await make('volt-sbx-live', { 'owner.json': { ownerPid: process.pid, tag: 'aaaaaaaaaaaaaaaa' } }, 3 * day);
			const oldUnowned = await make('volt-sbx-old', {}, 2 * day);
			const newUnowned = await make('volt-sbx-new', {});
			const deadHostYoung = await make('volt-sbx-host', { 'ledger.json': { version: 1, ownerPid: dead, tag: 'bbbbbbbbbbbbbbbb', label: 'h' } });
			const deadHostOld = await make('volt-sbx-hostold', { 'ledger.json': { version: 1, ownerPid: dead, tag: 'cccccccccccccccc', label: 'h' } }, 2 * day);
			const other = await make('not-a-run', {}, 5 * day);
			const reaped: string[] = [];
			const swept = await sweepRunRoot(root, async tag => { reaped.push(tag); });
			const exists = (path: string) => fs.stat(path).then(() => true, () => false);
			assert.ok(!await exists(deadRun), 'a dead owner\'s run goes at once, whatever its age');
			assert.ok(await exists(liveRun), 'a live owner\'s run stays, however old');
			assert.ok(!await exists(oldUnowned), 'an unowned run goes after a day');
			assert.ok(await exists(newUnowned), 'an unowned young run stays (an older Volt may still run it)');
			assert.ok(await exists(deadHostYoung), 'a host\'s folder is the supervisor\'s to recover first');
			assert.ok(!await exists(deadHostOld));
			assert.ok(await exists(other), 'only run folders are touched');
			assert.deepStrictEqual(reaped.sort(), ['0123456789abcdef', 'cccccccccccccccc'], 'what is left of a dead owner\'s run is killed before its folder goes');
			assert.strictEqual(swept, 3);
			assert.ok(!processAlive(dead));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

/** A backend that never runs anything: the test drives its denials and its failures. */
class ScriptedBackend implements ISandboxBackend {
	readonly id = 'seatbelt' as const;
	launchError: Error | undefined;
	lastOptions: ISandboxLaunchOptions | undefined;
	lastPolicy: IResolvedSandboxPolicy | undefined;

	async probe(): Promise<ISandboxBackendCapabilities> {
		return { backend: 'seatbelt', available: true, enforcement: allEnforcement('enforced'), notes: {}, details: ['scripted backend'], diagnostics: [] };
	}

	async launch(policy: IResolvedSandboxPolicy, command: string, args: readonly string[], options: ISandboxLaunchOptions): Promise<ISandboxLaunchSpec> {
		if (this.launchError) {
			throw this.launchError;
		}
		this.lastOptions = options;
		this.lastPolicy = policy;
		return {
			command, args, env: { ...policy.env }, cwd: policy.cwd, extraStdio: [], extraStdioDirections: [],
			confirm: async () => ({ ok: false, error: 'the scripted backend never runs anything' }),
			terminate: () => undefined,
			dispose: async () => undefined,
		};
	}
}

suite('Volt sandbox failover: launcher and manager with a scripted backend (R1)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let ws: string;
	let backend: ScriptedBackend;
	const cacheKeys = new Set<string>();

	setup(async () => {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-failover-')));
		ws = join(root, 'repo');
		await fs.mkdir(ws);
		backend = new ScriptedBackend();
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
		const facts = await sandboxHostFacts();
		for (const key of cacheKeys) {
			await fs.rm(join(facts.home, '.volt', 'sandbox-cache', key), { recursive: true, force: true });
		}
		cacheKeys.clear();
	});

	function launcher(info: string[] = [], runRoot = join(root, 'runs')): VoltSandboxLauncher {
		const manager = new SandboxManager(undefined, { backend, runRoot });
		return disposables.add(new VoltSandboxLauncher(join(root, 'user-data'), { info: message => info.push(message), warn: () => undefined }, { manager, admin: async () => ({}), executionHost: 'test' }));
	}

	function request(): IVoltSandboxRequest {
		const value: IVoltSandboxRequest = { level: 'workspace-write', network: false, providerId: 'mystery-acp', workspaceRoots: [ws] };
		cacheKeys.add(sandboxCacheKey(value));
		return value;
	}

	test('FAIL-TYPED-1: a launch step that fails with a plain error is a typed refusal, its principal retired', async () => {
		backend.launchError = new Error(`ENOSPC: no space left on device, open '${root}/x'`);
		const l = launcher();
		await assert.rejects(l.prepare('/bin/echo', ['hi'], request(), { cwd: ws, hostEnv: { PATH: '/usr/bin:/bin' } }), (err: unknown) => err instanceof SandboxUnavailableError && /could not prepare the sandbox: ENOSPC/.test(err.message));
		assert.strictEqual(l.livePrincipals, 0);
		assert.deepStrictEqual((await fs.readdir(join(root, 'runs'))).filter(name => name.startsWith('volt-sbx-')), [], 'its run folder was removed');
	});

	test('FAIL-RUNROOT-1: a run folder that cannot be made is a typed refusal, and the next launch tries again', async () => {
		const blocked = join(root, 'blocked');
		await fs.writeFile(blocked, 'a file where the run root should be');
		const l = launcher([], join(blocked, 'runs'));
		await assert.rejects(l.prepare('/bin/echo', ['hi'], request(), { cwd: ws, hostEnv: { PATH: '/usr/bin:/bin' } }), (err: unknown) => err instanceof SandboxUnavailableError && /could not create its sandbox run folder/.test(err.message) && err.status === 'unavailable');
		// The user (or the disk) fixed it: no restart needed.
		await fs.rm(blocked);
		const launch = await l.prepare('/bin/echo', ['hi'], request(), { cwd: ws, hostEnv: { PATH: '/usr/bin:/bin' } });
		try {
			const runs = (await fs.readdir(join(blocked, 'runs'))).filter(name => name.startsWith('volt-sbx-'));
			assert.strictEqual(runs.length, 1);
			const owner = JSON.parse(await fs.readFile(join(blocked, 'runs', runs[0], 'owner.json'), 'utf8'));
			assert.deepStrictEqual(owner, { ownerPid: process.pid, tag: launch.tag }, 'every run records its owner and tag for the next start\'s sweep');
		} finally {
			launch.dispose();
		}
	});

	test('DENY-QUIET-2: the run\'s canary and a shell\'s or npm\'s startup reads get no card; what the agent itself reads does', async () => {
		const info: string[] = [];
		const l = launcher(info);
		const seen: ISandboxDenial[] = [];
		disposables.add(l.onViolation(e => seen.push(e.denial)));
		const launch = await l.prepare('/bin/zsh', ['-lc', 'npm -v'], request(), { cwd: ws, hostEnv: { PATH: '/usr/bin:/bin' } });
		try {
			const home = (await sandboxHostFacts()).home;
			const emit = backend.lastOptions!.onDenial;
			emit({ kind: 'read', target: backend.lastPolicy!.sentinel!, source: 'os', process: 'sh' });
			emit({ kind: 'read', target: `${home}/.zshenv`, source: 'os', process: 'zsh' });
			emit({ kind: 'read', target: `${home}/.zshrc`, source: 'os', process: 'zsh' });
			emit({ kind: 'read', target: `${home}/.npmrc`, source: 'os', process: 'node' });
			emit({ kind: 'read', target: `${home}/.npmrc`, source: 'os', process: 'cat' });
			emit({ kind: 'write', target: `${home}/notes.txt`, source: 'os', process: 'touch' });
			assert.deepStrictEqual(seen.map(denial => `${denial.kind} ${denial.target.replace(home, '~')} ${denial.process}`), ['read ~/.npmrc cat', 'write ~/notes.txt touch']);
			const quiet = info.filter(line => line.includes('quiet denial'));
			assert.deepStrictEqual(quiet.map(line => line.replace(/^.*quiet denial: /, '')), ['read ~/.zshenv (zsh)', 'read ~/.zshrc (zsh)', 'read ~/.npmrc (node)'], 'quiet denials stay on record in the log');
			assert.ok(!info.some(line => line.includes('canary')), 'the canary read is not a denial at all');
		} finally {
			launch.dispose();
		}
	});
});

suite('Volt sandbox failover against real sandboxes (R1)', function () {

	this.timeout(120_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let ws: string;
	let host: ISandboxHostFacts;
	let available = false;
	const managers: SandboxManager[] = [];

	const managerWith = (backend?: ISandboxBackend) => {
		const created = new SandboxManager(undefined, { runRoot: join(root, 'runs'), host, ...(backend ? { backend } : {}) });
		managers.push(created);
		return created;
	};
	const hostEnv = () => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'C' });
	const exists = (path: string) => fs.lstat(path).then(() => true, () => false);

	suiteSetup(async () => {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-sbx-failover-')));
		home = join(root, 'home');
		ws = join(root, 'ws');
		for (const dir of [home, ws, join(root, 'agent-tmp')]) {
			await fs.mkdir(dir, { recursive: true });
		}
		await fs.writeFile(join(home, '.zshrc'), '# canary rc\n');
		host = { ...await sandboxHostFacts(), home };
		available = realSandboxAvailable(await managerWith().capabilities(), 'failover suite');
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

	/** Prepares `touch <marker>` and spawns `file` in its place with the launch's channels. */
	async function confirmWith(file: string, marker: string): Promise<{ ok: boolean; error: string; ms: number }> {
		const manager = managers[0];
		const prepared = await manager.prepare({ command: '/usr/bin/touch', args: [marker], policy: builtinProfile('workspace'), context: { workspaceRoots: [ws], hostEnv: hostEnv() } });
		const started = Date.now();
		let child: ChildProcess | undefined;
		try {
			child = spawn(file, [], { cwd: prepared.cwd, env: prepared.env, stdio: ['ignore', 'ignore', 'pipe', ...prepared.extraStdio], detached: true });
			child.on('error', () => undefined);
			const confirmation = await prepared.confirm(child);
			return { ok: confirmation.ok, error: confirmation.ok ? '' : confirmation.error, ms: Date.now() - started };
		} finally {
			if (child) {
				await prepared.terminate(child);
				for (const stream of child.stdio) {
					stream?.destroy();
				}
			}
			await prepared.dispose();
		}
	}

	test('FAIL-EXIT-1: a launcher that exits before confirming, or never starts, is refused at once, not after the timeout', async () => {
		const marker = join(ws, 'fail-exit-marker');
		const exited = await confirmWith('/usr/bin/false', marker);
		assert.strictEqual(exited.ok, false);
		assert.match(exited.error, /exited|not confirm|could not/);
		assert.ok(exited.ms < 3_000, `refused in ${exited.ms} ms`);
		const missing = await confirmWith(join(root, 'no-such-launcher'), marker);
		assert.strictEqual(missing.ok, false);
		assert.match(missing.error, /could not (?:be )?start|ENOENT/);
		assert.ok(missing.ms < 3_000, `refused in ${missing.ms} ms, not after the confirmation timeout`);
		assert.ok(!await exists(marker), 'nothing ran');
	});

	macTest('FAIL-HELPER-1: without the sandbox helper every launch is a typed refusal naming it', async () => {
		const manager = managerWith(new SeatbeltBackend({ helperPath: join(root, 'missing', 'volt-sandbox-helper') }));
		const marker = join(ws, 'helper-missing-marker');
		const result = await manager.run({ command: '/usr/bin/touch', args: [marker], policy: builtinProfile('workspace'), context: { workspaceRoots: [ws], hostEnv: hostEnv() } });
		assert.strictEqual(result.status, 'unavailable');
		assert.match(result.error ?? '', /sandbox helper/);
		assert.ok(!await exists(marker));
	});

	macTest('FAIL-HELPER-2: a helper that lost its execute bit after the probe is refused in moments, typed, and nothing runs', async () => {
		const backend = new SeatbeltBackend();
		const manager = managerWith(backend);
		assert.ok((await manager.capabilities()).available, 'probed while the helper still runs');
		const helper = (await manager.capabilities()).details.join(' ').match(/\((\/[^)]+volt-sandbox-helper)\)/)?.[1];
		assert.ok(helper, 'the probe names its helper');
		const marker = join(ws, 'helper-noexec-marker');
		const mode = (await fs.stat(helper)).mode & 0o777;
		await fs.chmod(helper, 0o644);
		try {
			const started = Date.now();
			const result = await manager.run({ command: '/usr/bin/touch', args: [marker], policy: builtinProfile('workspace'), context: { workspaceRoots: [ws], hostEnv: hostEnv() } }, { timeoutMs: 30_000 });
			assert.ok(result.status === 'failed' || result.status === 'unavailable', `typed: ${result.status} ${result.error}`);
			assert.match(result.error ?? '', /could not be started|EACCES|helper/);
			assert.ok(Date.now() - started < 5_000, `refused in ${Date.now() - started} ms, not after the confirmation timeout`);
		} finally {
			await fs.chmod(helper, mode);
		}
		assert.ok(!await exists(marker), 'nothing ran');
	});

	macTest('DENY-QUIET-3: the prologue\'s canary read never reaches a run\'s denials; the shell file read it made does', async () => {
		const manager = managers[0];
		const policy = agentSandboxPolicy({ level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: [ws] }, { platform: process.platform, home, tempDirs: [join(root, 'agent-tmp')], cacheDir: join(home, '.volt', 'sandbox-cache') });
		const result = await manager.run({ command: '/bin/sh', args: ['-c', `echo ran; cat "${home}/.zshrc"; sleep 1.5`], policy, context: { workspaceRoots: [ws], hostEnv: hostEnv() } }, { timeoutMs: 30_000 });
		assert.strictEqual(result.status, 'completed', result.error);
		assert.ok(result.stdout.startsWith('ran') && !result.stdout.includes('canary rc'), 'it ran, and the rc file stayed unreadable');
		assert.ok(result.denials.some(denial => denial.kind === 'read' && denial.target.endsWith('/.zshrc')), `the kernel reported the run's own denial: ${JSON.stringify(result.denials)}`);
		assert.ok(!result.denials.some(denial => denial.target.endsWith('/canary')), 'the canary read is the attestation, not a denial');
	});

	macTest('DENY-QUIET-4, TOOLCHAIN-MAC-1: a login shell running git and python in the agent profile works, and nothing it does by itself is a card', async () => {
		const repo = join(ws, 'quiet-4');
		await fs.mkdir(repo, { recursive: true });
		await fs.writeFile(join(repo, 'a.txt'), 'a');
		// A home outside the system temp folder, which the agent writes (xcrun, behind /usr/bin/git, keeps its cache there).
		const agentHome = await fs.realpath(await fs.mkdtemp(join(homedir(), '.volt-quiet-4-')));
		try {
			for (const [name, text] of [['.zshrc', '# rc\n'], ['.zshenv', '# env\n'], ['.zprofile', '# profile\n'], ['.npmrc', '//registry.npmjs.org/:_authToken=secret\n'], ['.CFUserTextEncoding', '0x1F5:0x0:0x0'], ['.gitconfig', '[user]\n\tname = Volt Test\n']]) {
				await fs.writeFile(join(agentHome, name), text);
			}
			// As in every real home: Apple's python caches its bytecode under it (a denied write, noise).
			await fs.mkdir(join(agentHome, 'Library', 'Caches'), { recursive: true });
			await new Promise<void>((resolve, reject) => spawn('/usr/bin/git', ['init', '-q', repo], { stdio: 'ignore' }).once('exit', code => code === 0 ? resolve() : reject(new Error(`git init: ${code}`))));
			const agentPolicy = agentSandboxPolicy({ level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: [ws] }, { platform: process.platform, home: agentHome, tempDirs: [await fs.realpath(tmpdir())], cacheDir: join(agentHome, '.volt', 'sandbox-cache') });
			assert.ok(agentPolicy.filesystem.read.includes(join(agentHome, '.CFUserTextEncoding')));
			// CoreFoundation reads the account's home, not $HOME: the real one's file is what a real chat's policy allows.
			const policy = { ...agentPolicy, filesystem: { ...agentPolicy.filesystem, read: [...agentPolicy.filesystem.read, join(homedir(), '.CFUserTextEncoding')] } };
			const script = `cd "${repo}" && git status --short && git config user.name && /usr/bin/python3 -c "print('py-ok')" && echo all-ok; sleep 1.5`;
			const manager = new SandboxManager(undefined, { runRoot: join(root, 'runs'), host: { ...host, home: agentHome } });
			managers.push(manager);
			const result = await manager.run({ command: '/bin/zsh', args: ['-lic', script], policy, context: { workspaceRoots: [ws], hostEnv: { ...hostEnv(), HOME: agentHome, SHELL: '/bin/zsh' } } }, { timeoutMs: 60_000 });
			assert.strictEqual(result.status, 'completed', result.error);
			assert.match(result.stdout, /\?\? a\.txt[\s\S]*Volt Test[\s\S]*py-ok[\s\S]*all-ok/, `the tools worked: ${result.stdout}${result.stderr} ${JSON.stringify(result.denials)}`);
			assert.ok(result.denials.some(denial => denial.target === join(agentHome, '.zshrc')), `the shell's rc read stays denied: ${JSON.stringify(result.denials)}`);
			const cards = result.denials.filter(denial => (denial.kind === 'read' || denial.kind === 'write') && !isQuietDenial({ kind: denial.kind, target: denial.target, source: 'os', ...(denial.process ? { process: denial.process } : {}) }, agentHome, [ws]) && !isNoiseDenial({ kind: denial.kind, target: denial.target, source: 'os' }));
			assert.deepStrictEqual(cards, [], 'nothing the shell, git or python did by itself gets a card');
		} finally {
			await fs.rm(agentHome, { recursive: true, force: true });
		}
	});
});
