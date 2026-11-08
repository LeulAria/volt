/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Adversarial tests: real sandboxes, real escape attempts. Every test checks that the attempt
 * failed AND that the host is unchanged (canary files intact, nothing created outside, no stray
 * processes, canary listeners never contacted). Runs against a fake HOME full of canary
 * credentials; never against the real home folder.
 *
 * A machine without a working backend skips loudly; with `VOLT_SANDBOX_REQUIRED` set (CI's
 * Sandbox Security job, which installs the backend) it FAILS instead, so CI cannot pass without
 * actually exercising the sandbox. Generic test jobs without bubblewrap only skip.
 * Linux: run inside the container rig (scripts/volt-sandbox-linux-test.sh).
 */

import assert from 'assert';
import { execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs, readdirSync } from 'fs';
import * as net from 'net';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ISandboxRunResult } from '../../common/sandboxBackend.js';
import { composeSandboxPolicy } from '../../common/sandboxComposition.js';
import { agentSandboxPolicy } from '../../common/sandboxPolicy.js';
import { builtinProfile } from '../../common/sandboxProfiles.js';
import { IVoltSandboxPolicy, parseSandboxPolicyLayer } from '../../common/sandboxSchema.js';
import { SandboxManager } from '../../node/sandboxManager.js';
import { ISandboxHostFacts, sandboxHostFacts } from '../../node/sandboxResolver.js';

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const required = !!process.env.VOLT_SANDBOX_REQUIRED;
const PERL = '/usr/bin/perl';
/** Platform-only tests are chosen up front (Bun's mocha shim has no `this.skip()` inside a test). */
const linuxTest = isLinux ? test : test.skip;
const macTest = isMac ? test : test.skip;

interface IFixture {
	readonly root: string;
	readonly home: string;
	readonly ws: string;
	readonly outside: string;
	readonly userData: string;
	readonly runRoot: string;
	/** The agent profile's temp folder, apart from the run root as in production. */
	readonly agentTmp: string;
	readonly host: ISandboxHostFacts;
	readonly canaries: Map<string, string>;
	readonly manager: SandboxManager;
}

const MARKER = `volt-sbx-escape-${process.pid}`;

async function sha(path: string): Promise<string> {
	return createHash('sha256').update(await fs.readFile(path)).digest('hex');
}

async function exists(path: string): Promise<boolean> {
	return fs.lstat(path).then(() => true, () => false);
}

/** Processes still carrying this run's marker (optionally one test's), the sandbox launchers themselves excluded. */
function strayProcesses(name?: string): string[] {
	const needle = name ? `${MARKER}-${name}` : MARKER;
	try {
		return execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')
			.filter(line => line.includes(needle) && !line.includes('/bin/ps') && !line.includes('sandbox-exec') && !line.includes('bwrap') && (name || !line.includes(`${MARKER}-envless`)));
	} catch {
		return [];
	}
}

async function waitFor(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return check();
}

/** A TCP listener that counts connections: proof that nothing reached it. */
async function canaryListener(): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
	let hits = 0;
	const server = net.createServer(socket => { hits++; socket.destroy(); });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return { port: (server.address() as net.AddressInfo).port, hits: () => hits, close: () => new Promise(resolve => server.close(() => resolve())) };
}

async function canaryUnixSocket(dir: string): Promise<{ path: string; hits: () => number; close: () => Promise<void> }> {
	let hits = 0;
	const path = join(dir, 'canary.sock');
	const server = net.createServer(socket => { hits++; socket.destroy(); });
	await new Promise<void>(resolve => server.listen(path, resolve));
	return { path, hits: () => hits, close: () => new Promise(resolve => server.close(() => resolve())) };
}

suite('Volt sandbox security (adversarial, real processes)', function () {

	this.timeout(120_000);
	ensureNoDisposablesAreLeakedInTestSuite();
	let f: IFixture;
	let available = false;

	suiteSetup(async function () {
		const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-sbx-sec-')));
		const home = join(root, 'home');
		const ws = join(root, 'ws');
		const outside = join(root, 'outside');
		const userData = join(home, 'Library', 'Application Support', 'Volt');
		const runRoot = join(root, 'runs');
		const agentTmp = join(root, 'agent-tmp');
		for (const dir of [home, ws, outside, userData, runRoot, agentTmp, join(home, '.ssh'), join(home, '.aws'), join(home, '.config', 'gh'), join(home, '.codex'), join(home, '.claude'), join(home, '.npm', '_npx'), join(home, '.local', 'share', 'claude'), join(ws, '.git', 'hooks'), join(ws, 'sub')]) {
			await fs.mkdir(dir, { recursive: true });
		}
		const canaries = new Map<string, string>();
		const plant = async (path: string, text: string) => {
			await fs.writeFile(path, text);
			canaries.set(path, await sha(path));
		};
		await plant(join(home, '.ssh', 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nCANARY-SSH\n');
		await plant(join(home, '.aws', 'credentials'), '[default]\naws_secret_access_key=CANARY-AWS\n');
		await plant(join(home, '.config', 'gh', 'hosts.yml'), 'oauth_token: CANARY-GH\n');
		await plant(join(home, '.codex', 'auth.json'), '{"token":"CANARY-CODEX"}');
		await plant(join(home, '.zshrc'), '# canary rc\n');
		await plant(join(userData, 'token'), 'CANARY-AGENT-SERVER-TOKEN');
		await plant(join(ws, '.env'), 'SECRET=CANARY-DOTENV\n');
		await plant(join(ws, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
		await plant(join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n');
		await plant(join(outside, 'secret.txt'), 'CANARY-OUTSIDE\n');
		await fs.writeFile(join(ws, '.env.example'), 'SECRET=\n');
		await fs.writeFile(join(ws, 'readme.txt'), 'hello\n');
		await fs.symlink(join(outside, 'secret.txt'), join(ws, 'link-out'));
		const real = await sandboxHostFacts();
		const host: ISandboxHostFacts = { ...real, home };
		const manager = new SandboxManager(undefined, { runRoot, host });
		f = { root, home, ws, outside, userData, runRoot, agentTmp, host, canaries, manager };
		const capabilities = await manager.capabilities();
		available = capabilities.available;
		if (!available) {
			const message = `[volt-sandbox] NO SANDBOX BACKEND on ${process.platform}: ${capabilities.diagnostics.join(' ')}`;
			if (required) {
				throw new Error(`${message} (CI requires the sandbox; failing instead of skipping)`);
			}
			console.warn(`\n\n!!! ${message}\n!!! The adversarial sandbox suite is SKIPPED. Set VOLT_SANDBOX_REQUIRED=1 to make this fail.\n`);
		}
	});

	suiteTeardown(async () => {
		await f?.manager.dispose();
		for (const line of strayProcesses()) {
			const pid = Number(line.trim().split(/\s+/)[0]);
			try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
		}
		if (f) {
			await fs.rm(f.root, { recursive: true, force: true });
		}
	});

	setup(function () {
		if (!available) {
			this.skip();
		}
	});

	/** Every canary still has its original content; nothing new appeared outside. */
	async function assertHostUnchanged(): Promise<void> {
		for (const [path, digest] of f.canaries) {
			assert.strictEqual(await sha(path), digest, `canary changed: ${path}`);
		}
		// Only what the tests themselves put there: the secret and, while a test runs, its canary socket.
		const unexpected = (await fs.readdir(f.outside)).filter(name => name !== 'secret.txt' && name !== 'canary.sock');
		assert.deepStrictEqual(unexpected, [], 'nothing created outside');
	}

	function hostEnv(extra: Record<string, string> = {}): Record<string, string> {
		return {
			PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
			HOME: f.home,
			LANG: 'C',
			GITHUB_TOKEN: 'CANARY-ENV-GH',
			AWS_SECRET_ACCESS_KEY: 'CANARY-ENV-AWS',
			VSCODE_IPC_HOOK_CLI: '/tmp/vscode-ipc-canary.sock',
			SSH_AUTH_SOCK: '/tmp/ssh-canary/agent',
			HTTPS_PROXY: 'http://inherited-proxy.invalid:8080',
			...extra,
		};
	}

	/**
	 * Runs `script` sandboxed and proves it actually ran (status `completed` plus a marker it
	 * prints first), so a denial assertion can never pass just because nothing ran.
	 */
	async function sh(policy: IVoltSandboxPolicy, script: string, options: { timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string>; expectRefusal?: boolean; workspaceRoots?: string[] } = {}): Promise<ISandboxRunResult> {
		const result = await f.manager.run({
			command: '/bin/sh',
			args: ['-c', `echo volt-sandbox-ran; ${script}`],
			policy,
			context: { workspaceRoots: options.workspaceRoots ?? [f.ws], hostEnv: hostEnv(), env: options.env },
		}, { timeoutMs: options.timeoutMs ?? 30_000, signal: options.signal });
		if (!options.expectRefusal) {
			assert.strictEqual(result.status, 'completed', `the run did not happen: ${result.error ?? ''} ${result.stderr}`);
			assert.ok(result.stdout.startsWith('volt-sandbox-ran'), `the script did not start: ${result.stderr}`);
		}
		return { ...result, stdout: result.stdout.replace(/^volt-sandbox-ran\n/, '') };
	}

	const workspace = () => builtinProfile('workspace');
	const agent = (network = false, workspaceRoots = [f.ws]) => agentSandboxPolicy(
		{ level: 'workspace-write', network, providerId: 'claude-code', workspaceRoots },
		{ platform: process.platform, home: f.home, tempDirs: [f.agentTmp], userDataDir: f.userData, sshPrivateKeys: [join(f.home, '.ssh', 'id_ed25519')], cacheDir: join(f.home, '.volt', 'sandbox-cache') },
	);

	// --- Filesystem ------------------------------------------------------------------------------

	test('the sandbox is confirmed before it is reported, and a normal run completes', async () => {
		const result = await sh(workspace(), 'echo hello > "$PWD/out.txt" && cat "$PWD/out.txt"');
		assert.strictEqual(result.status, 'completed', result.error);
		assert.strictEqual(result.exitCode, 0, result.stderr);
		assert.strictEqual(result.stdout.trim(), 'hello');
		assert.strictEqual(await fs.readFile(join(f.ws, 'out.txt'), 'utf8'), 'hello\n');
	});

	test('reads outside the workspace, through ../ and through symlinks are denied', async () => {
		for (const script of [
			`cat ${f.outside}/secret.txt`,
			`cat ${f.ws}/../outside/secret.txt`,
			`cat ${f.ws}/link-out`,
			`ln -s ${f.outside}/secret.txt ${f.ws}/made-link && cat ${f.ws}/made-link`,
		]) {
			const result = await sh(workspace(), script);
			assert.ok(!result.stdout.includes('CANARY'), `${script}\n${result.stdout}`);
			assert.notStrictEqual(result.exitCode, 0, script);
		}
		await assertHostUnchanged();
	});

	test('credential canaries are unreadable, even for the agent profile that reads everything else', async () => {
		const targets = ['.ssh/id_ed25519', '.aws/credentials', '.config/gh/hosts.yml', '.codex/auth.json'].map(p => join(f.home, p));
		for (const policy of [workspace(), agent(false), agent(true)]) {
			for (const target of [...targets, join(f.userData, 'token'), join(f.ws, '.env')]) {
				const result = await sh(policy, `cat '${target}'`);
				assert.ok(!result.stdout.includes('CANARY'), `${policy.name}: read ${target}`);
			}
		}
		const example = await sh(workspace(), `cat ${f.ws}/.env.example`);
		assert.strictEqual(example.exitCode, 0, '.env.example is not a secret');
		if (isMac) {
			const variant = await sh(agent(false), `cat '${join(f.home, '.SSH', 'id_ed25519')}' '${join(f.home, '.Aws', 'credentials')}'`);
			assert.ok(!variant.stdout.includes('CANARY'), 'case variants on a case-insensitive volume');
		}
	});

	test('hard links to credentials cannot be made or read', async () => {
		const result = await sh(agent(false), `ln '${join(f.home, '.aws', 'credentials')}' ${f.ws}/hl; cat ${f.ws}/hl`);
		assert.ok(!result.stdout.includes('CANARY'));
		assert.ok(!await exists(join(f.ws, 'hl')));
	});

	test('writes outside the workspace and into protected paths are denied; the host is unchanged', async () => {
		const attempts = [
			`echo x > ${f.outside}/created.txt`,
			`echo x >> ${f.home}/.zshrc`,
			`echo 'evil' > ${f.ws}/.git/hooks/pre-commit`,
			`printf '[core]\\n\\tfsmonitor = touch ${f.outside}/pwned\\n' >> ${f.ws}/.git/config`,
			`mkdir -p ${f.ws}/.vscode && echo '{}' > ${f.ws}/.vscode/tasks.json`,
			`echo evil > ${f.ws}/.envrc`,
			`echo '{}' > ${f.ws}/.mcp.json`,
			`mkdir -p ${f.ws}/.husky && echo evil > ${f.ws}/.husky/pre-commit`,
			`touch ${f.home}/.npm/_npx/evil`,
		];
		for (const script of attempts) {
			await sh(workspace(), script);
		}
		await assertHostUnchanged();
		assert.ok(!await exists(join(f.ws, '.git', 'hooks', 'pre-commit')));
		for (const name of ['.vscode', '.envrc', '.mcp.json', '.husky']) {
			assert.ok(!await exists(join(f.ws, name)) || isLinux, `${name} must not appear (Linux: not-yet-existing paths are best effort)`);
		}
		const agentTry = await sh(agent(false), `touch ${f.home}/.npm/_npx/evil ${f.home}/.local/share/claude/evil; echo ok > ${f.home}/.claude/state.json`);
		assert.ok(!await exists(join(f.home, '.npm', '_npx', 'evil')), 'shared npx cache');
		assert.ok(!await exists(join(f.home, '.local', 'share', 'claude', 'evil')), 'the CLI binaries');
		assert.ok(await exists(join(f.home, '.claude', 'state.json')), `the agent's own state stays writable: ${agentTry.stderr}`);
	});

	// --- Git internals: `.git` is an allow list (B-03, INV-15) ------------------------------------

	/** A real repository with one commit and a linked worktree (so `.git/worktrees/<name>/` exists), made on the host. */
	async function gitRepo(name: string): Promise<{ repo: string; worktreeDir: string }> {
		const repo = join(f.root, name);
		await fs.mkdir(repo, { recursive: true });
		const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.home, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' });
		git('init', '-q');
		await fs.writeFile(join(repo, 'a.txt'), 'a\n');
		git('add', 'a.txt');
		git('commit', '-qm', 'init');
		git('worktree', 'add', '-q', '-b', `${name}-wt`, join(f.root, `${name}-wt`));
		return { repo, worktreeDir: join(repo, '.git', 'worktrees', `${name}-wt`) };
	}

	const gitPolicies = (repo: string) => [workspace(), agent(false, [repo])];

	test('PERS-1: a sandbox cannot plant .git/commondir (Linux: a residual until Landlock, and the run says so)', async () => {
		const { repo } = await gitRepo('pers1');
		const commondir = join(repo, '.git', 'commondir');
		for (const policy of gitPolicies(repo)) {
			const result = await sh(policy, [
				`echo ${f.outside} > ${commondir}`,
				`echo ${f.outside} > ${repo}/.git/objects/c && mv ${repo}/.git/objects/c ${commondir}`,
				`echo ${f.outside} > ${repo}/.GIT/CommonDir`,
			].join('; '), { workspaceRoots: [repo] });
			if (isLinux) {
				// bubblewrap binds only paths that exist at launch; HostGit refuses the redirect on the host (GIT-1).
				assert.ok(result.unenforced.includes('filesystem.protectNew'), `${policy.name}: the run reports the gap`);
				await fs.rm(commondir, { force: true });
			} else {
				assert.ok(!await exists(commondir), `${policy.name}: ${result.stderr}`);
			}
		}
		await assertHostUnchanged();
	});

	test('PERS-2: a sandbox cannot rewrite a linked worktree\'s commondir or gitdir', async () => {
		const { repo, worktreeDir } = await gitRepo('pers2');
		const before = await Promise.all(['commondir', 'gitdir'].map(name => sha(join(worktreeDir, name))));
		for (const policy of gitPolicies(repo)) {
			await sh(policy, [
				`echo ${f.outside} > ${worktreeDir}/commondir`,
				`echo ${f.outside} > ${worktreeDir}/gitdir`,
				`echo ${f.outside} > ${worktreeDir}/x.lock && mv ${worktreeDir}/x.lock ${worktreeDir}/commondir`,
				`rm -f ${worktreeDir}/commondir`,
			].join('; '), { workspaceRoots: [repo] });
			assert.deepStrictEqual(await Promise.all(['commondir', 'gitdir'].map(name => sha(join(worktreeDir, name)))), before, policy.name);
		}
		await assertHostUnchanged();
	});

	test('PERS-3: a sandbox cannot change .git/config, hooks, info or alternates, while commits keep working', async () => {
		const { repo, worktreeDir } = await gitRepo('pers3');
		const config = join(repo, '.git', 'config');
		const before = await sha(config);
		// The real binary, not the macOS /usr/bin/git shim (which checks the Xcode license in a file the sandbox cannot read).
		const gitBin = join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git');
		for (const [i, policy] of gitPolicies(repo).entries()) {
			const git = `${gitBin} -c user.name=t -c user.email=t@t -c core.hooksPath=/dev/null`;
			const result = await sh(policy, [
				`printf '[core]\\n\\tfsmonitor = touch ${f.outside}/pwned\\n' >> ${config}`,
				`${gitBin} config core.fsmonitor 'touch ${f.outside}/pwned'`,
				`cp ${config} ${repo}/.git/config.lock && mv ${repo}/.git/config.lock ${config}`,
				`echo evil > ${repo}/.git/hooks/post-checkout`,
				`mkdir -p ${repo}/.git/info && echo '* filter=x' > ${repo}/.git/info/attributes`,
				`echo ${f.outside} > ${repo}/.git/objects/info/alternates`,
				`echo evil > ${worktreeDir}/config.worktree`,
				`${git} commit -q --allow-empty -m sandboxed && echo COMMITTED`,
				`${git} checkout -q -b from-sandbox-${i} && echo BRANCHED`,
				`echo b > b.txt && ${git} stash -q -u && echo STASHED`,
			].join('; '), { workspaceRoots: [repo] });
			assert.strictEqual(await sha(config), before, `${policy.name}: config`);
			assert.ok(!await exists(join(repo, '.git', 'hooks', 'post-checkout')), policy.name);
			assert.ok(!await exists(join(repo, '.git', 'info', 'attributes')), policy.name);
			assert.ok(!await exists(join(worktreeDir, 'config.worktree')), policy.name);
			if (!isLinux) {
				assert.ok(!await exists(join(repo, '.git', 'objects', 'info', 'alternates')), `${policy.name}: alternates`);
			}
			// Lock files are writable by design (git takes them for every update); a stale one only blocks.
			await fs.rm(join(repo, '.git', 'objects', 'info', 'alternates'), { force: true });
			await fs.rm(join(repo, '.git', 'config.lock'), { force: true });
			for (const done of ['COMMITTED', 'BRANCHED', 'STASHED']) {
				assert.ok(result.stdout.includes(done), `${policy.name}: ${done} (the allow list keeps git usable): ${result.stderr}`);
			}
			execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '-q', '-'], { cwd: repo, stdio: 'pipe' });
		}
		assert.ok(!await exists(join(f.outside, 'pwned')));
		await assertHostUnchanged();
	});

	// bubblewrap cannot guard paths that do not exist yet: filesystem.protectNew (documented).
	macTest('a new git repository cannot be planted in the workspace (macOS)', async () => {
		await sh(workspace(), `mkdir ${f.ws}/sub/.git; mkdir ${f.ws}/sub/.GIT; echo 'gitdir: ${f.outside}' > ${f.ws}/sub/x; mv ${f.ws}/sub/x ${f.ws}/sub/.git`);
		assert.ok(!await exists(join(f.ws, 'sub', '.git')) && !await exists(join(f.ws, 'sub', '.GIT')));
	});

	test('restricted keeps the workspace and the shared /tmp out of reach', async () => {
		const result = await sh(builtinProfile('restricted'), `cat ${f.ws}/readme.txt; echo x > /tmp/${MARKER}; echo ok > "$TMPDIR/mine" && cat "$TMPDIR/mine"`);
		assert.ok(!result.stdout.includes('hello'), 'workspace unreadable');
		assert.ok(!await exists(`/tmp/${MARKER}`), 'shared /tmp unwritable');
		assert.ok(result.stdout.includes('ok'), `its own temp works: ${result.stderr}`);
	});

	linuxTest('/proc/self/root and /proc/1/root do not reach the host (Linux)', async () => {
		const result = await sh(workspace(), `cat /proc/self/root${f.outside}/secret.txt /proc/1/root${f.outside}/secret.txt`);
		assert.ok(!result.stdout.includes('CANARY'));
	});

	// --- Processes -------------------------------------------------------------------------------

	test('background processes, setsid daemons and double forks die with the run', async () => {
		const script = [
			`${PERL} -e '$0="${MARKER}-bg"; sleep 300' &`,
			`${PERL} -e 'exit 0 if fork; exit 0 if fork; $0="${MARKER}-double"; sleep 300' &`,
			`${PERL} -e 'use POSIX; exit 0 if fork; POSIX::setsid(); exit 0 if fork; $0="${MARKER}-setsid"; sleep 300' &`,
			'sleep 0.5; echo started',
		].join('\n');
		const result = await sh(workspace(), script);
		assert.ok(result.stdout.includes('started'), result.stderr);
		assert.ok(await waitFor(() => strayProcesses().length === 0, 5_000), `survivors: ${strayProcesses().join(' | ')}`);
	});

	test('a daemon that clears its environment and calls setsid', async () => {
		const result = await sh(workspace(), `env -i ${PERL} -e 'use POSIX; exit 0 if fork; POSIX::setsid(); exit 0 if fork; $0="${MARKER}-envless"; sleep 3; open(my $f, ">", "${f.outside}/canary-daemon-wrote") and print $f "x"; sleep 300' & sleep 0.5; echo started`);
		assert.ok(result.stdout.includes('started'), result.stderr);
		const died = await waitFor(() => strayProcesses('envless').length === 0, 5_000);
		try {
			if (isLinux) {
				assert.ok(died, 'the PID namespace takes it down');
			} else if (!died) {
				// Known macOS limitation (process.tree partial): it outlives the run but stays sandboxed.
				await new Promise(resolve => setTimeout(resolve, 3_500));
				assert.ok(!await exists(join(f.outside, 'canary-daemon-wrote')), 'the survivor is still confined');
				assert.ok(result.unenforced.includes('process.tree'), 'and the run said so');
			}
		} finally {
			for (const line of strayProcesses('envless')) {
				try { process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL'); } catch { /* gone */ }
			}
		}
	});

	test('host processes cannot be signalled or listed', async () => {
		const victim = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
		try {
			const result = await sh(workspace(), `kill -TERM ${victim.pid}; kill -0 ${victim.pid} && echo can-see; ps -ax 2>/dev/null | wc -l`);
			assert.strictEqual(victim.exitCode, null);
			assert.strictEqual(victim.signalCode, null, 'the host process is alive');
			assert.ok(!result.stdout.includes('can-see'), result.stdout);
		} finally {
			victim.kill('SIGKILL');
		}
	});

	test('no inherited file descriptors beyond stdio', async () => {
		const result = await sh(workspace(), `${PERL} -e 'for (3..64) { open(my $h, "<&=", $_) and print "$_\\n" }'`);
		assert.strictEqual(result.stdout.trim(), '', `open fds: ${result.stdout}`);
	});

	test('wall clock and cancellation kill the whole tree', async () => {
		const started = Date.now();
		const timed = await sh(workspace(), `sleep 300 & ${PERL} -e '$0="${MARKER}-timeout"; sleep 300'`, { timeoutMs: 1_000 });
		assert.ok(timed.timedOut && Date.now() - started < 10_000);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 500);
		const cancelled = await sh(workspace(), `${PERL} -e '$0="${MARKER}-cancel"; sleep 300'`, { signal: controller.signal });
		assert.ok(cancelled.cancelled);
		assert.ok(await waitFor(() => strayProcesses().length === 0, 5_000), strayProcesses().join(' | '));
	});

	// --- Network ---------------------------------------------------------------------------------

	test('network none: no loopback service, no internet, no DNS', async () => {
		const canary = await canaryListener();
		try {
			const result = await sh(workspace(), [
				`${PERL} -MIO::Socket::INET -e 'IO::Socket::INET->new(PeerAddr=>"127.0.0.1:${canary.port}", Timeout=>2) and print "LOOPBACK\\n"'`,
				`${PERL} -MIO::Socket::INET -e 'IO::Socket::INET->new(PeerAddr=>"1.1.1.1:80", Timeout=>3) and print "INTERNET\\n"'`,
				`${PERL} -e 'gethostbyname("volt-sbx-$$.example.com") and print "DNS\\n"'`,
			].join('; '));
			assert.ok(!/LOOPBACK|INTERNET|DNS/.test(result.stdout), result.stdout);
			assert.strictEqual(canary.hits(), 0, 'the canary listener was never contacted');
		} finally {
			await canary.close();
		}
	});

	test('proxy mode: only allowed hosts, never loopback, private ranges or metadata', async () => {
		const canary = await canaryListener();
		const parsed = parseSandboxPolicyLayer({ schemaVersion: 1, network: { mode: 'proxy', allow: ['*', '127.0.0.1', '169.254.169.254'] } });
		assert.ok(parsed.ok);
		const { policy } = composeSandboxPolicy(workspace(), [{ source: 'user', trusted: true, layer: parsed.value }]);
		try {
			const result = await sh(policy, [
				// Through the proxy: CONNECT to loopback and metadata must be refused despite the allow list.
				`for t in 127.0.0.1:${canary.port} 169.254.169.254:80 localhost:${canary.port} [::ffff:127.0.0.1]:${canary.port}; do ${PERL} -MIO::Socket::INET -e '$s=IO::Socket::INET->new(PeerAddr=>(split m{//}, $ENV{HTTPS_PROXY})[1], Timeout=>3) or exit 1; print $s "CONNECT $ARGV[0] HTTP/1.1\\r\\nHost: $ARGV[0]\\r\\n\\r\\n"; $l=<$s>; print "$ARGV[0] $l"' "$t"; done`,
				// Around the proxy: direct connects must fail.
				`${PERL} -MIO::Socket::INET -e 'IO::Socket::INET->new(PeerAddr=>"127.0.0.1:${canary.port}", Timeout=>2) and print "DIRECT\\n"'`,
				'echo "proxy=$HTTPS_PROXY"',
			].join('; '));
			assert.ok(!result.stdout.includes('200'), result.stdout);
			assert.ok(/403/.test(result.stdout), `the proxy answered with refusals: ${result.stdout} ${result.stderr}`);
			assert.ok(!result.stdout.includes('DIRECT'));
			assert.ok(!result.stdout.includes('inherited-proxy.invalid'), 'inherited proxy variables are replaced');
			assert.strictEqual(canary.hits(), 0);
			assert.ok(result.denials.some(d => d.source === 'proxy'), 'refusals are reported');
		} finally {
			await canary.close();
		}
	});

	test('unix sockets are unreachable unless granted, even with an open network', async () => {
		const socket = await canaryUnixSocket(f.outside);
		try {
			for (const policy of [workspace(), agent(false), agent(true)]) {
				const result = await sh(policy, `${PERL} -MIO::Socket::UNIX -e 'IO::Socket::UNIX->new(Peer=>"${socket.path}") and print "CONNECTED\\n"'`);
				assert.ok(!result.stdout.includes('CONNECTED'), policy.name);
			}
			assert.strictEqual(socket.hits(), 0);
		} finally {
			await socket.close();
		}
	});

	// --- Environment -----------------------------------------------------------------------------

	test('secrets and host IPC endpoints never reach the environment', async () => {
		for (const policy of [workspace(), agent(false), agent(true)]) {
			const result = await sh(policy, 'env');
			for (const leak of ['CANARY-ENV-GH', 'CANARY-ENV-AWS', 'vscode-ipc-canary', 'ssh-canary', 'inherited-proxy.invalid']) {
				assert.ok(!result.stdout.includes(leak), `${policy.name} leaked ${leak}`);
			}
		}
	});

	// --- Policy bypass ---------------------------------------------------------------------------

	test('a repository policy cannot widen the sandbox at run time', async () => {
		const socket = await canaryUnixSocket(f.outside);
		try {
			const repo = parseSandboxPolicyLayer({ schemaVersion: 1, filesystem: { write: ['/'.concat(f.outside.slice(1))] }, host: { unixSockets: [socket.path] }, network: { mode: 'host' } });
			assert.ok(repo.ok);
			const { policy, ignored } = composeSandboxPolicy(workspace(), [{ source: 'workspace', trusted: false, layer: repo.value }]);
			assert.ok(ignored.length >= 3);
			await sh(policy, `echo x > ${f.outside}/created.txt; ${PERL} -MIO::Socket::UNIX -e 'IO::Socket::UNIX->new(Peer=>"${socket.path}") and print "C"'`);
			assert.strictEqual(socket.hits(), 0);
			await assertHostUnchanged();
		} finally {
			await socket.close();
		}
	});

	test('hostile workspace names cannot inject into the profile or arguments', async () => {
		// Parentheses, spaces, `--`, `$` and backslashes are expressed exactly. (Bun's fs.realpath
		// cannot resolve a name with a backslash, which only makes the run fall back to its temp folder.)
		const odd = join(f.root, `ws (allow default) -- --bind $HOME ${process.versions.bun ? '' : '\\'}x`);
		await fs.mkdir(odd, { recursive: true });
		const ok = await f.manager.run({ command: '/bin/sh', args: ['-c', `echo ok > "$PWD/in.txt"; echo x > ${f.outside}/created.txt`], policy: workspace(), context: { workspaceRoots: [odd], hostEnv: hostEnv() } }, { timeoutMs: 20_000 });
		assert.strictEqual(ok.status, 'completed', ok.error);
		assert.ok(await exists(join(odd, 'in.txt')), ok.stderr);
		// A double quote cannot be escaped inside a Seatbelt regex literal: such a path is refused, never guessed.
		const quoted = join(f.root, 'ws") (allow default) ("x');
		await fs.mkdir(quoted, { recursive: true });
		const refused = await f.manager.run({ command: '/bin/sh', args: ['-c', `echo x > ${f.outside}/created.txt`], policy: workspace(), context: { workspaceRoots: [quoted], hostEnv: hostEnv() } }, { timeoutMs: 20_000 });
		assert.strictEqual(refused.status, 'unavailable', refused.error);
		await assertHostUnchanged();
	});

	test('a policy the backend cannot enforce is refused before anything runs', async () => {
		const parsed = parseSandboxPolicyLayer({ schemaVersion: 1, process: { limits: { memoryMB: 256 } } });
		assert.ok(parsed.ok);
		const { policy } = composeSandboxPolicy(workspace(), [{ source: 'user', trusted: true, layer: parsed.value }]);
		// No backend caps resident memory (macOS: none at all; Linux: RLIMIT_AS is virtual memory only).
		const result = await sh(policy, `touch ${f.ws}/should-not-run`, { expectRefusal: true });
		assert.strictEqual(result.status, 'unavailable');
		assert.ok(result.unenforced.includes('limits.memory'));
		assert.ok(!await exists(join(f.ws, 'should-not-run')));
	});

	test('the home folder or / as a workspace is refused', async () => {
		for (const root of [f.home, '/']) {
			const result = await f.manager.run({ command: '/bin/true', policy: workspace(), context: { workspaceRoots: [root], hostEnv: hostEnv() } });
			assert.strictEqual(result.status, 'unavailable', root);
		}
	});

	// --- Resources -------------------------------------------------------------------------------

	test('CPU and file-size limits are applied by the kernel', async () => {
		const limited = (limits: object) => {
			const parsed = parseSandboxPolicyLayer({ schemaVersion: 1, process: { limits } });
			assert.ok(parsed.ok);
			return composeSandboxPolicy(workspace(), [{ source: 'execution', trusted: false, layer: parsed.value }]).policy;
		};
		const started = Date.now();
		const spin = await sh(limited({ cpuSeconds: 1 }), 'while :; do :; done');
		assert.ok(spin.exitCode !== 0 && Date.now() - started < 15_000, `cpu: exit ${spin.exitCode} ${spin.signal}`);
		await sh(limited({ fileSizeMB: 1 }), `dd if=/dev/zero of=${f.ws}/big bs=1048576 count=8 2>/dev/null`);
		const size = (await fs.stat(join(f.ws, 'big')).catch(() => ({ size: 0 }))).size;
		assert.ok(size <= 1024 * 1024, `file size capped: ${size}`);
	});

	// macOS has no per-sandbox process count (limits.processes unsupported): never run this on a Mac.
	linuxTest('a fork bomb is contained by the per-sandbox process limit (Linux)', async () => {
		const parsed = parseSandboxPolicyLayer({ schemaVersion: 1, process: { limits: { processes: 64, wallClockSeconds: 20 } } });
		assert.ok(parsed.ok);
		const { policy } = composeSandboxPolicy(workspace(), [{ source: 'execution', trusted: false, layer: parsed.value }]);
		const result = await sh(policy, 'b() { b | b & }; b; sleep 5; echo survived', { timeoutMs: 15_000 });
		assert.ok(result.status === 'completed' || result.timedOut);
		assert.ok(await waitFor(() => strayProcesses().length === 0, 5_000));
	});

	// --- Lifecycle -------------------------------------------------------------------------------

	test('concurrent sandboxes stay apart, and nothing leaks across many runs', async () => {
		const fdsBefore = readdirSync('/dev/fd').length;
		const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => sh(workspace(), `echo ${i} > "$TMPDIR/id"; sleep 0.2; cat "$TMPDIR/id"`)));
		runs.forEach((result, i) => assert.strictEqual(result.stdout.trim(), String(i), result.stderr));
		for (let i = 0; i < 12; i++) {
			await sh(workspace(), 'true');
		}
		assert.deepStrictEqual(await fs.readdir(f.runRoot), [], 'every run folder was removed');
		assert.ok(readdirSync('/dev/fd').length <= fdsBefore + 2, 'no file descriptors leaked');
	});

	test('shutting the manager down kills running sandboxes', async () => {
		const manager = new SandboxManager(undefined, { runRoot: f.runRoot, host: f.host });
		const prepared = await manager.prepare({ command: '/bin/sh', args: ['-c', `${PERL} -e '$0="${MARKER}-shutdown"; sleep 300'`], policy: workspace(), context: { workspaceRoots: [f.ws], hostEnv: hostEnv() } });
		const child = spawn(prepared.command, [...prepared.args], { cwd: prepared.cwd, env: prepared.env, stdio: ['ignore', 'ignore', 'ignore', ...prepared.extraStdio], detached: true });
		const confirmed = await prepared.confirm(child);
		assert.ok(confirmed.ok, confirmed.ok ? '' : confirmed.error);
		assert.ok(await waitFor(() => strayProcesses().length > 0, 3_000));
		await manager.dispose();
		assert.ok(await waitFor(() => strayProcesses().length === 0, 5_000), strayProcesses().join(' | '));
	});

	// --- macOS escape hatches --------------------------------------------------------------------

	macTest('macOS: Apple Events, LaunchServices, launchd jobs, preferences and the pasteboard are closed to agents', async () => {
		const domain = `volt.sbx.test.${process.pid}`;
		const label = `volt.sbx.test.${process.pid}`;
		const result = await sh(agent(true), [
			`osascript -e 'do shell script "touch ${f.outside}/canary-osascript"' 2>&1`,
			`open -a Terminal ${f.outside} 2>&1`,
			`launchctl submit -l ${label} -- /usr/bin/touch ${f.outside}/canary-launchd 2>&1`,
			`defaults write ${domain} k v 2>&1`,
			'pbpaste 2>&1',
		].join('; '));
		await new Promise(resolve => setTimeout(resolve, 1_500));
		try {
			const written = execFileSync('/usr/bin/defaults', ['read', domain, 'k'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
			assert.fail(`a preference was written through cfprefsd: ${written}`);
		} catch (err) {
			if (err instanceof assert.AssertionError) {
				throw err;
			}
		} finally {
			try { execFileSync('/usr/bin/defaults', ['delete', domain], { stdio: 'ignore' }); } catch { /* not there */ }
			try { execFileSync('/bin/launchctl', ['remove', label], { stdio: 'ignore' }); } catch { /* not there */ }
		}
		assert.ok(!await exists(join(f.outside, 'canary-osascript')), result.stdout);
		assert.ok(!await exists(join(f.outside, 'canary-launchd')), result.stdout);
		await assertHostUnchanged();
	});
});
