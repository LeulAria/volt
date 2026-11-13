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
import { homedir, tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { dimensionsUsed, ISandboxRunResult } from '../../common/sandboxBackend.js';
import { composeSandboxPolicy } from '../../common/sandboxComposition.js';
import { agentStatePlan, IAgentStatePlan } from '../../common/agentState.js';
import { AGENT_STATE_ROOT, agentSandboxPolicy, IVoltSandboxRequest } from '../../common/sandboxPolicy.js';
import { AGENT_CONFIG_NAMES, builtinProfile } from '../../common/sandboxProfiles.js';
import { AgentStateOverlay } from '../../node/agentStateOverlay.js';
import { IVoltSandboxPolicy, parseSandboxPolicyLayer } from '../../common/sandboxSchema.js';
import { sshPrivateKeys, sshReadablePaths } from '../../node/sandboxLauncher.js';
import { SandboxManager } from '../../node/sandboxManager.js';
import { SandboxPolicyFiles } from '../../node/sandboxPolicyFiles.js';
import { composeLaunchLayers } from '../../common/compile.js';
import { ISandboxHostFacts, sandboxHostFacts } from '../../node/sandboxResolver.js';
import { realSandboxAvailable } from './sandboxSuiteGate.js';

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
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
		for (const dir of [home, ws, outside, userData, runRoot, agentTmp, join(home, '.ssh'), join(home, '.aws'), join(home, '.config', 'gh'), join(home, '.codex'), join(home, '.claude'), join(home, '.npm', '_npx'), join(home, '.local', 'share', 'claude'), join(home, 'Library', 'Caches', 'claude-cli-nodejs'), join(home, '.gemini', 'tmp'), join(home, '.cargo', 'bin'), join(home, 'other-project'), join(ws, '.git', 'hooks'), join(ws, 'sub')]) {
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
		// Agent CLI config a sandboxed chat must not change in place (B-05), and another project in $HOME.
		await plant(join(home, '.claude.json'), '{"mcpServers":{},"projects":{}}');
		await plant(join(home, '.claude', 'settings.json'), '{"model":"opus"}');
		await plant(join(home, '.claude', 'CLAUDE.md'), '# canary instructions\n');
		await plant(join(home, '.gemini', 'settings.json'), '{"mcpServers":{}}');
		await plant(join(home, 'other-project', 'notes.md'), 'CANARY-OTHER-PROJECT\n');
		await fs.writeFile(join(home, '.cargo', 'bin', 'cargo-canary'), 'TOOLCHAIN-OK\n');
		await fs.writeFile(join(ws, '.env.example'), 'SECRET=\n');
		await fs.writeFile(join(ws, 'readme.txt'), 'hello\n');
		await fs.symlink(join(outside, 'secret.txt'), join(ws, 'link-out'));
		const real = await sandboxHostFacts();
		const host: ISandboxHostFacts = { ...real, home };
		const manager = new SandboxManager(undefined, { runRoot, host });
		f = { root, home, ws, outside, userData, runRoot, agentTmp, host, canaries, manager };
		// A backend missing a dimension every platform's tests exercise (bubblewrap without socat has
		// no network.proxy) is not a working backend for this suite.
		available = realSandboxAvailable(await manager.capabilities(), 'adversarial sandbox suite');
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
	async function sh(policy: IVoltSandboxPolicy, script: string, options: { timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string>; hostEnv?: Record<string, string>; expectRefusal?: boolean; workspaceRoots?: string[] } = {}): Promise<ISandboxRunResult> {
		const result = await f.manager.run({
			command: '/bin/sh',
			args: ['-c', `echo volt-sandbox-ran; ${script}`],
			policy,
			context: { workspaceRoots: options.workspaceRoots ?? [f.ws], hostEnv: hostEnv(options.hostEnv), env: options.env },
		}, { timeoutMs: options.timeoutMs ?? 30_000, signal: options.signal });
		if (!options.expectRefusal) {
			assert.strictEqual(result.status, 'completed', `the run did not happen: ${result.error ?? ''} ${result.stderr}`);
			assert.ok(result.stdout.startsWith('volt-sandbox-ran'), `the script did not start: ${result.stderr}`);
		}
		return { ...result, stdout: result.stdout.replace(/^volt-sandbox-ran\n/, '') };
	}

	const workspace = () => builtinProfile('workspace');
	const agentHost = (statePlan?: IAgentStatePlan) => ({ platform: process.platform, home: f.home, tempDirs: [f.agentTmp], userDataDir: f.userData, sshPrivateKeys: [join(f.home, '.ssh', 'id_ed25519')], cacheDir: join(f.home, '.volt', 'sandbox-cache'), ...(statePlan ? { statePlan } : {}) });
	const agent = (network = false, providerId = 'claude-code', extra: Partial<IVoltSandboxRequest> = {}, statePlan?: IAgentStatePlan) => agentSandboxPolicy(
		{ level: 'workspace-write', network, providerId, workspaceRoots: [f.ws], ...extra },
		agentHost(statePlan),
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

	test('SSH-1, SSH-2: with the network on, an agent reads only ssh\'s configs (and what they include), known hosts and public keys; keys in any format, name, folder or link, and anything made after the launch, stay unreadable', async () => {
		const ssh = join(f.home, '.ssh');
		const made: string[] = [];
		const write = async (relative: string, text: string) => {
			const path = join(ssh, relative);
			await fs.mkdir(join(path, '..'), { recursive: true });
			await fs.writeFile(path, text, { mode: 0o600 });
			made.push(path);
			return path;
		};
		const keygen = async (relative: string, args: string[], fallback: string) => {
			const path = join(ssh, relative);
			await fs.mkdir(join(path, '..'), { recursive: true });
			try {
				// Throwaway keys, made here for this test only.
				execFileSync('ssh-keygen', ['-q', '-C', 'volt-test', '-f', path, ...args], { stdio: 'ignore' });
				made.push(path, `${path}.pub`);
				return path;
			} catch {
				// No ssh-keygen (the Linux rig): the same first line, which is what Volt judges.
				return write(`${relative}.pub`, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl volt-test\n').then(() => write(relative, `${fallback}\nVOLTTESTKEYBODY\n`));
			}
		};
		const elsewhere = join(f.root, 'kept-elsewhere');
		const dotfiles = join(f.home, 'dotfiles');
		await fs.mkdir(elsewhere, { recursive: true });
		await fs.mkdir(dotfiles, { recursive: true });
		try {
			// Keys in every format and under names that do not say "key".
			await keygen('id_ecdsa_pem', ['-t', 'ecdsa', '-m', 'PEM', '-N', ''], '-----BEGIN EC PRIVATE KEY-----');
			await keygen('id_rsa_pem', ['-t', 'rsa', '-b', '1024', '-m', 'PEM', '-N', ''], '-----BEGIN RSA PRIVATE KEY-----');
			await keygen('pkcs8', ['-t', 'ecdsa', '-m', 'PKCS8', '-N', ''], '-----BEGIN PRIVATE KEY-----');
			await keygen('pkcs8_encrypted', ['-t', 'ecdsa', '-m', 'PKCS8', '-N', 'volt-test-passphrase'], '-----BEGIN ENCRYPTED PRIVATE KEY-----');
			await keygen('pem_encrypted', ['-t', 'rsa', '-b', '1024', '-m', 'PEM', '-N', 'volt-test-passphrase'], '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED');
			await keygen('github', ['-t', 'ed25519', '-N', ''], '-----BEGIN OPENSSH PRIVATE KEY-----');
			await keygen('keys/work/deploy', ['-t', 'ed25519', '-N', ''], '-----BEGIN OPENSSH PRIVATE KEY-----');
			await write('putty.ppk', 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n');
			await write('ssh2_key', '---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nComment: "volt-test"\n');
			// A private key under a name ssh's files have (`*.pub`): judged by content, not name.
			await write('mislabeled.pub', '-----BEGIN OPENSSH PRIVATE KEY-----\nVOLTTESTKEYBODY\n');
			await write('notes.txt', 'a token kept next to the keys\n');
			// What ssh needs: its config (linked from a dotfiles folder), included files (config.d, by name,
			// by glob, outside ~/.ssh as OrbStack and Colima add), known hosts (default and named), public keys.
			// An `Include` or `UserKnownHostsFile` naming a private key does not make it readable.
			// (The lines naming files are in a config the ssh check below doesn't load: ssh takes `~` and
			// a relative path's folder from the user database, which is the real home, never $HOME.)
			await fs.writeFile(join(dotfiles, 'ssh_config'), 'Host volt-canary\n\tUser voltcanaryuser\n\tHostName 127.0.0.1\n');
			await fs.symlink(join(dotfiles, 'ssh_config'), join(ssh, 'config'));
			made.push(join(ssh, 'config'));
			await write('config.d/work', 'Host volt-work\n\tUser voltworkuser\n');
			await write('config.d/files', [
				'Include work_config "conf/*.conf" ~/.orb/ssh/config github',
				'Host volt-files',
				'\tUserKnownHostsFile=~/.ssh/known_hosts_work pkcs8',
				'\tIdentityFile ~/.ssh/keys/work/deploy',
				'',
			].join('\n'));
			await write('work_config', 'Host volt-named\n\tUser voltnameduser\n');
			await write('conf/a.conf', 'Host volt-glob\n\tUser voltglobuser\n');
			await write('conf/b.txt', 'not matched by the glob\n');
			await fs.mkdir(join(f.home, '.orb', 'ssh'), { recursive: true });
			await fs.writeFile(join(f.home, '.orb', 'ssh', 'config'), 'Host volt-orb\n\tUser voltorbuser\n');
			await write('known_hosts', 'volt-canary.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n');
			await write('known_hosts_work', 'volt-work.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n');
			// A key kept outside and linked in; a hard link of a key under a public key's name.
			await fs.writeFile(join(elsewhere, 'linked_key'), '-----BEGIN OPENSSH PRIVATE KEY-----\nVOLTTESTKEYBODY\n');
			await fs.symlink(join(elsewhere, 'linked_key'), join(ssh, 'linked'));
			made.push(join(ssh, 'linked'));
			await fs.link(join(ssh, 'github'), join(ssh, 'hardlink.pub'));
			made.push(join(ssh, 'hardlink.pub'));

			// What a launch computes (sandboxLauncher), on this home.
			const host = { ...agentHost(), sshPrivateKeys: await sshPrivateKeys(ssh), sshReadable: await sshReadablePaths(ssh) };
			const policy = agentSandboxPolicy({ level: 'workspace-write', network: true, providerId: 'claude-code', workspaceRoots: [f.ws] }, host);
			// Made after the launch: a new key, a key dropped into config.d, a key under a public key's name.
			await write('late_key', '-----BEGIN OPENSSH PRIVATE KEY-----\nVOLTTESTKEYBODY\n');
			await write('config.d/late', '-----BEGIN OPENSSH PRIVATE KEY-----\nVOLTTESTKEYBODY\n');
			await write('late.pub', '-----BEGIN OPENSSH PRIVATE KEY-----\nVOLTTESTKEYBODY\n');
			await fs.symlink(join(ssh, 'github'), join(f.ws, 'ssh-link'));
			made.push(join(f.ws, 'ssh-link'));

			const denied = ['id_ed25519', 'id_ecdsa_pem', 'id_rsa_pem', 'pkcs8', 'pkcs8_encrypted', 'pem_encrypted', 'github', 'keys/work/deploy', 'putty.ppk', 'ssh2_key', 'mislabeled.pub', 'notes.txt', 'linked', 'hardlink.pub', 'late_key', 'config.d/late', 'late.pub', 'conf/b.txt'];
			// Linux: bubblewrap mounts a link's target, not the link, so a linked config is not at
			// `~/.ssh/config` there (05-limitations item 5; git over SSH has no ssh-agent on Linux anyway).
			const readable = [...isLinux ? [] : ['config'], 'config.d/work', 'work_config', 'conf/a.conf', 'known_hosts', 'known_hosts_work', 'github.pub', 'keys/work/deploy.pub', '../.orb/ssh/config'];
			assert.ok(host.sshReadable.includes(join(dotfiles, 'ssh_config')), 'the linked config at its real path');
			// Probes print READABLE or DENIED, never what a file holds.
			const probe = (label: string, path: string) => `if head -c 1 '${path}' >/dev/null 2>&1; then echo 'READABLE ${label}'; else echo 'DENIED ${label}'; fi`;
			const result = await sh(policy, [
				...[...denied, ...readable].map(name => probe(name, join(ssh, name))),
				probe('ws/ssh-link', join(f.ws, 'ssh-link')),
				probe('kept-elsewhere', join(elsewhere, 'linked_key')),
				// File names are not secret; the listing shows at most the readable ones (Linux binds only those).
				`echo "LISTING $(ls -a '${ssh}' 2>/dev/null | tr '\\n' ' ')"`,
				`echo "LISTKEYS $(ls -a '${join(ssh, 'keys', 'work')}' 2>/dev/null | tr '\\n' ' ')"`,
			].join('\n'));
			const lines = result.stdout.trim().split('\n');
			const verdicts = new Map(lines.filter(line => !line.startsWith('LIST')).map(line => [line.slice(line.indexOf(' ') + 1), line.slice(0, line.indexOf(' '))]));
			for (const name of [...denied, 'ws/ssh-link', 'kept-elsewhere']) {
				assert.strictEqual(verdicts.get(name), 'DENIED', `${name}: ${result.stdout}`);
			}
			const listing = (tag: string) => (lines.find(line => line.startsWith(`${tag} `)) ?? '').split(' ').slice(1).filter(Boolean);
			// (Linux shows `keys/`: it holds a readable public key, so bubblewrap made the folder.)
			assert.deepStrictEqual(listing('LISTING').filter(name => ['id_ed25519', 'github', 'notes.txt', 'late_key', 'pkcs8'].includes(name)), [], `the folder lists no key or note: ${listing('LISTING').join(' ')}`);
			assert.ok(!listing('LISTKEYS').includes('deploy'), `nor a key in a subfolder: ${listing('LISTKEYS').join(' ')}`);
			for (const name of readable) {
				assert.strictEqual(verdicts.get(name), 'READABLE', `${name} is what ssh needs: ${result.stdout} ${result.stderr}`);
			}
			assert.ok(!result.stdout.includes('VOLTTESTKEYBODY') && !result.stdout.includes('PRIVATE KEY'));
			if (isMac) {
				// git over SSH: ssh reads its config (through the dotfiles link) and the included file. `-F`
				// names this home's files: ssh takes `~` from the user database, never $HOME.
				const config = await sh(policy, `ssh -F '${join(ssh, 'config')}' -G volt-canary 2>&1 | grep -i '^user '; ssh -F '${join(ssh, 'config.d', 'work')}' -G volt-work 2>&1 | grep -i '^user '`);
				assert.match(config.stdout, /user voltcanaryuser/i, config.stdout + config.stderr);
				assert.match(config.stdout, /user voltworkuser/i, config.stdout + config.stderr);
			}
		} finally {
			for (const path of made.reverse()) {
				await fs.rm(path, { force: true });
			}
			await fs.rm(join(ssh, 'keys'), { recursive: true, force: true });
			await fs.rm(join(ssh, 'config.d'), { recursive: true, force: true });
			await fs.rm(join(ssh, 'conf'), { recursive: true, force: true });
			await fs.rm(join(f.home, '.orb'), { recursive: true, force: true });
			await fs.rm(elsewhere, { recursive: true, force: true });
			await fs.rm(dotfiles, { recursive: true, force: true });
		}
		await assertHostUnchanged();
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
		const agentTry = await sh(agent(false), `touch ${f.home}/.npm/_npx/evil ${f.home}/.local/share/claude/evil; echo ok > ${f.home}/.claude/state.json; mkdir -p ${f.home}/Library/Caches/claude-cli-nodejs && echo ok > ${f.home}/Library/Caches/claude-cli-nodejs/log.txt`);
		assert.ok(!await exists(join(f.home, '.npm', '_npx', 'evil')), 'shared npx cache');
		assert.ok(!await exists(join(f.home, '.local', 'share', 'claude', 'evil')), 'the CLI binaries');
		// B-05: the CLI's own folder is no longer writable in place (its state goes to the chat's overlay);
		// the subpaths its footprint lists still are.
		assert.ok(!await exists(join(f.home, '.claude', 'state.json')), 'the CLI folder in place');
		assert.ok(await exists(join(f.home, 'Library', 'Caches', 'claude-cli-nodejs', 'log.txt')), `its listed state stays writable: ${agentTry.stderr}`);
	});

	test('EXEC-LATER-1: files that something unsandboxed runs later (git, editor tasks and settings, agent CLI configs and skills, hook managers) cannot be planted or changed; build files the guard reviews stay writable', async () => {
		// Files a project already has: every backend keeps them read-only.
		const existing = ['.vscode/tasks.json', '.claude/skills/x/SKILL.md', '.gemini/settings.json', '.codex/config.toml', '.zed/settings.json', '.helix/languages.toml', '.nvim.lua'];
		// Planted where nothing was: macOS refuses them; bubblewrap guards only what exists (filesystem.protectNew).
		const planted = [
			'.git/config', '.git/hooks/pre-commit', '.git/info/attributes', '.git/config.worktree', '.git/commondir', '.git/objects/info/alternates', '.git/modules/x/config', 'sub/.git/config',
			'.gitmodules', '.vscode/launch.json', '.vscode/settings.json', '.envrc', 'sub/.envrc', '.mcp.json', '.claude/settings.json', '.claude/settings.local.json', '.claude/commands/x.md',
			'.claude/skills/y/SKILL.md', '.claude/skills/y/run.sh', '.gemini/commands/x.toml', '.gemini/extensions/x/gemini-extension.json', '.codex/hooks.json', '.cursor/mcp.json',
			'.zed/tasks.json', '.helix/config.toml', '.nvimrc', '.exrc', '.husky/pre-commit', '.githooks/pre-commit', '.idea/workspace.xml', '.devcontainer/devcontainer.json',
			'.volt/hooks.json', '.pre-commit-config.yaml', 'lefthook.yml',
		];
		// A case-insensitive volume: another spelling is the same file.
		const variants = ['.GIT/config', '.Git/hooks/pre-commit', '.git/HOOKS/pre-commit', '.git/INFO/attributes', '.git/OBJECTS/info/alternates', 'sub/.GIT/config', '.GITMODULES', '.VSCode/tasks.json',
			'.ENVRC', '.MCP.json', '.CLAUDE/settings.json', '.Claude/skills/x/SKILL.md', '.GEMINI/settings.json', '.Codex/config.toml', '.Cursor/mcp.json', '.ZED/settings.json', '.HUSKY/pre-commit', '.VOLT/hooks.json', 'LEFTHOOK.yml'];
		// By design writable: the build-entry guard shows changes to the build files before Volt runs them,
		// CI runs remotely after a push the user makes, and the rest name no command (05-limitations item 42).
		const writable = ['package.json', 'Makefile', '.npmrc', '.yarnrc.yml', '.github/workflows/ci.yml', '.gitattributes', '.lfsconfig', 'sub/.vscode/tasks.json', 'app.code-workspace', 'AGENTS.md'];
		const before = new Set([...await fs.readdir(f.ws), ...(await fs.readdir(join(f.ws, 'sub'))).map(name => `sub/${name}`)]);
		for (const target of existing) {
			await fs.mkdir(join(f.ws, target, '..'), { recursive: true });
			await fs.writeFile(join(f.ws, target), 'ORIGINAL\n');
		}
		const attempt = (target: string) => {
			const path = join(f.ws, target);
			return `mkdir -p '${join(path, '..')}' 2>/dev/null; printf 'VOLTPWN\\n' >> '${path}' 2>/dev/null; true`;
		};
		const hasMarker = async (target: string) => (await fs.readFile(join(f.ws, target), 'utf8').catch(() => '')).includes('VOLTPWN');
		try {
			for (const policy of [workspace(), agent(false)]) {
				const result = await sh(policy, [...existing, ...planted, ...isMac ? variants : [], ...writable].map(attempt).join('\n'));
				for (const target of existing) {
					assert.strictEqual(await fs.readFile(join(f.ws, target), 'utf8'), 'ORIGINAL\n', `${policy.name}: ${target}`);
				}
				for (const target of isMac ? [...planted, ...variants] : ['.git/config', '.git/hooks/pre-commit']) {
					assert.ok(!await hasMarker(target), `${policy.name}: ${target} was planted`);
				}
				if (isLinux) {
					assert.ok(result.unenforced.includes('filesystem.protectNew'), `${policy.name}: the run reports the gap`);
				}
				for (const target of writable) {
					assert.ok(await hasMarker(target), `${policy.name}: ${target} stays writable: ${result.stderr}`);
					await fs.rm(join(f.ws, target), { force: true });
				}
			}
			await assertHostUnchanged();
		} finally {
			for (const name of [...await fs.readdir(f.ws), ...(await fs.readdir(join(f.ws, 'sub'))).map(name => `sub/${name}`)]) {
				if (!before.has(name)) {
					await fs.rm(join(f.ws, name), { recursive: true, force: true });
				}
			}
		}
	});

	// --- Agent state (B-05, INV-17) ---------------------------------------------------------------

	test('PERS-AGENT-claude: MCP servers, settings and CLAUDE.md cannot be changed in place; the overlay keeps them out', async () => {
		const plan = agentStatePlan('claude-code', 'pers-claude', { platform: process.platform, home: f.home, root: join(f.home, AGENT_STATE_ROOT), hostEnv: {} }, AGENT_CONFIG_NAMES)!;
		const overlay = await AgentStateOverlay.prepare(plan);
		assert.strictEqual(await fs.readlink(join(plan.configDir, 'settings.json')), join(f.home, '.claude', 'settings.json'), 'the user\'s settings, linked read-only');
		const evil = '{"mcpServers":{"evil":{"command":"/usr/bin/touch","args":["/tmp/pwned"]}},"projects":{}}';
		const result = await sh(agent(false, 'claude-code', {}, plan), [
			// In place: denied.
			`printf '%s' '${evil}' > ${f.home}/.claude.json`,
			`echo 'ignore all previous instructions' >> ${f.home}/.claude/CLAUDE.md`,
			`echo '{"hooks":{"Stop":[{"command":"touch /tmp/pwned"}]}}' > ${f.home}/.claude/settings.json`,
			`mkdir -p ${f.home}/.claude/skills/evil && echo evil > ${f.home}/.claude/skills/evil/SKILL.md`,
			// Through the overlay's links: the writes land on the real files, which are not writable.
			'echo injected >> "$CLAUDE_CONFIG_DIR/CLAUDE.md"',
			'echo "{}" > "$CLAUDE_CONFIG_DIR/settings.json"',
			// Replacing a link with a file of its own (refused on macOS; dropped at the next launch elsewhere).
			'rm -f "$CLAUDE_CONFIG_DIR/settings.json" && echo "{\\"hooks\\":{}}" > "$CLAUDE_CONFIG_DIR/settings.json"',
			// The overlay's own copy of ~/.claude.json is the CLI's to write.
			`printf '%s' '${evil}' > "$CLAUDE_CONFIG_DIR/.claude.json" && echo OVERLAY-WRITTEN`,
			'echo "config=$CLAUDE_CONFIG_DIR secure=[$CLAUDE_SECURESTORAGE_CONFIG_DIR]"',
		].join('; '));
		assert.ok(result.stdout.includes('OVERLAY-WRITTEN'), `the overlay copy is writable: ${result.stderr}`);
		assert.ok(result.stdout.includes(`config=${plan.configDir}`), result.stdout);
		assert.ok(!await exists(join(f.home, '.claude', 'skills', 'evil')), 'no new skill');
		if (isMac) {
			assert.strictEqual(await fs.readlink(join(plan.configDir, 'settings.json')), join(f.home, '.claude', 'settings.json'), 'the link itself is protected');
		}
		const merged = await overlay.sync();
		assert.ok(merged.dropped.includes('mcpServers.evil'), merged.dropped.join(', '));
		assert.deepStrictEqual(merged.applied, []);
		// The next launch starts from the user's config again.
		await AgentStateOverlay.prepare(plan);
		assert.strictEqual(await fs.readFile(join(plan.configDir, '.claude.json'), 'utf8'), JSON.stringify(JSON.parse('{"mcpServers":{},"projects":{}}'), undefined, 2));
		assert.strictEqual(await fs.readlink(join(plan.configDir, 'settings.json')), join(f.home, '.claude', 'settings.json'));
		await assertHostUnchanged();
	});

	test('PERS-AGENT-gemini: ~/.gemini/settings.json and the binaries it runs are never writable', async () => {
		await sh(agent(false, 'antigravity'), [
			`echo '{"mcpServers":{"evil":{"command":"sh"}}}' > ${f.home}/.gemini/settings.json`,
			`mkdir -p ${f.home}/.gemini/tmp/bin && echo evil > ${f.home}/.gemini/tmp/bin/rg`,
			`echo ok > ${f.home}/.gemini/tmp/session.json`,
		].join('; '));
		if (!isLinux) {
			assert.ok(!await exists(join(f.home, '.gemini', 'tmp', 'bin', 'rg')), 'a binary the CLI runs later (Linux: not-yet-existing paths are best effort)');
		}
		assert.ok(await exists(join(f.home, '.gemini', 'tmp', 'session.json')), 'its listed state stays writable');
		await assertHostUnchanged();
	});

	test('PERS-AGENT-generic: an unknown CLI gets no writable home state', async () => {
		await fs.mkdir(join(f.home, '.mystery'), { recursive: true });
		await sh(agent(false, 'mystery-acp'), `echo '{"hooks":1}' > ${f.home}/.mystery/config.json; echo x > ${f.home}/.mystery/state`);
		assert.ok(!await exists(join(f.home, '.mystery', 'config.json')) && !await exists(join(f.home, '.mystery', 'state')));
	});

	test('narrow reads (D-14): another project and shell startup files are unreadable; toolchains, the workspace and its own install are readable', async () => {
		for (const policy of [agent(false), agent(true)]) {
			const result = await sh(policy, [
				`cat ${f.home}/other-project/notes.md`,
				`cat ${f.home}/.zshrc`,
				`ls ${f.home} | sed 's/^/LIST:/'`,
				`cat ${f.home}/.cargo/bin/cargo-canary`,
				`cat ${f.ws}/readme.txt`,
				`ls ${f.home}/.local/share/claude >/dev/null && echo INSTALL-OK`,
			].join('; '));
			assert.ok(!result.stdout.includes('CANARY-OTHER-PROJECT'), `${policy.name}: another project read`);
			assert.ok(!result.stdout.includes('canary rc'), `${policy.name}: shell startup file read`);
			assert.ok(!result.stdout.includes('LIST:other-project'), `${policy.name}: the home folder listed`);
			assert.ok(result.stdout.includes('TOOLCHAIN-OK'), `${policy.name}: toolchains readable: ${result.stderr}`);
			assert.ok(result.stdout.includes('hello'), `${policy.name}: the workspace readable`);
			assert.ok(result.stdout.includes('INSTALL-OK'), `${policy.name}: its own install readable: ${result.stderr}`);
		}
		await assertHostUnchanged();
	});

	test('NET-LISTEN-1: an agent listens only on the ports it was granted', async () => {
		const listen = (port: number) => `${PERL} -MIO::Socket::INET -e '$s=IO::Socket::INET->new(Listen=>5, LocalAddr=>"127.0.0.1", LocalPort=>${port}, ReuseAddr=>1) and print "LISTENING-${port}\\n" or print STDERR "NOT-LISTENING-${port}: $!\\n"'`;
		const free = await canaryListener();
		const port = free.port;
		await free.close();
		// With the network on the sandbox shares the host's loopback: squatting a port is the risk.
		const open = await sh(agent(true), `${listen(0)}; ${listen(port)}`);
		assert.ok(!open.stdout.includes('LISTENING'), `network on: ${open.stdout}`);
		assert.ok(open.stderr.includes(`NOT-LISTENING-${port}: Operation not permitted`), `refused by the sandbox: ${open.stderr}`);
		if (isMac) {
			// Linux puts a network-off sandbox in its own namespace, where a listener reaches nothing outside.
			const offline = await sh(agent(false), `${listen(0)}; ${listen(port)}`);
			assert.ok(!offline.stdout.includes('LISTENING'), `network off: ${offline.stdout}`);
			assert.ok(offline.stderr.includes(`NOT-LISTENING-${port}: Operation not permitted`), `refused by the sandbox: ${offline.stderr}`);
		}
		const granted = await sh(agent(true, 'claude-code', { listenPorts: [port] }), listen(port));
		assert.ok(granted.stdout.includes(`LISTENING-${port}`), `a granted port works: ${granted.stderr}`);
	});

	test('ENV-1: an agent gets only allow-listed variables; *_KEY, *_PAT and *_JWT never pass', async () => {
		const result = await sh(agent(false), 'env', { hostEnv: { STRIPE_KEY: 'CANARY-KEY', GITLAB_PAT: 'CANARY-PAT', SUPABASE_JWT: 'CANARY-JWT', SOME_TOOL_SETTING: 'CANARY-UNLISTED', CARGO_HOME: `${f.home}/.cargo` } });
		for (const leak of ['CANARY-KEY', 'CANARY-PAT', 'CANARY-JWT', 'CANARY-UNLISTED']) {
			assert.ok(!result.stdout.includes(leak), `leaked ${leak}`);
		}
		assert.ok(result.stdout.includes(`CARGO_HOME=${f.home}/.cargo`), 'toolchain locations pass');
		assert.ok(result.stdout.includes(`HOME=${f.home}`), 'the real home folder');
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

	const gitPolicies = (repo: string) => [workspace(), agent(false, 'claude-code', { workspaceRoots: [repo] })];

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
			if (isLinux) {
				// bubblewrap binds only names that exist at launch: a new config.worktree or alternates is the
				// protectNew residual, and the run says so. On the host, HostGit refuses alternates planted
				// while a sandboxed writer worked (GIT-4); config.worktree is read only with
				// extensions.worktreeConfig, which lives in the protected config.
				assert.ok(result.unenforced.includes('filesystem.protectNew'), `${policy.name}: the run reports the gap`);
			} else {
				assert.ok(!await exists(join(worktreeDir, 'config.worktree')), policy.name);
				assert.ok(!await exists(join(repo, '.git', 'objects', 'info', 'alternates')), `${policy.name}: alternates`);
			}
			// Lock files are writable by design (git takes them for every update); a stale one only blocks.
			await fs.rm(join(worktreeDir, 'config.worktree'), { force: true });
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
				// The proxy URL carries the run's token (B-31), sent as Proxy-Authorization, so the refusals below are the address rules'.
				`for t in 127.0.0.1:${canary.port} 169.254.169.254:80 localhost:${canary.port} [::ffff:127.0.0.1]:${canary.port}; do ${PERL} -MIO::Socket::INET -MMIME::Base64 -e '($a,$h)=$ENV{HTTPS_PROXY}=~m{//([^@]+)@([^/]+)}; $s=IO::Socket::INET->new(PeerAddr=>$h, Timeout=>3) or exit 1; print $s "CONNECT $ARGV[0] HTTP/1.1\\r\\nHost: $ARGV[0]\\r\\nProxy-Authorization: Basic ".encode_base64($a,"")."\\r\\n\\r\\n"; $l=<$s>; print "$ARGV[0] $l"' "$t"; done`,
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

	test('SRV-1: a granted loopback port (the chat\'s own MCP bridge) opens only that port; Volt\'s other loopback servers (another chat\'s MCP, the agent server, a CDP/inspect port) stay unreachable, and the agent-server token stays unreadable', async () => {
		// The chat's own MCP bridge, and three loopback servers the sandbox must not reach: another
		// chat's MCP port, the agent server's API, an inspector port. Each counts the connections it got.
		const own = await canaryListener();
		const otherMcp = await canaryListener();
		const agentServer = await canaryListener();
		const inspector = await canaryListener();
		const connect = (label: string, port: number) => `${PERL} -MIO::Socket::INET -e 'IO::Socket::INET->new(PeerAddr=>"127.0.0.1:${port}", Timeout=>2) and print "REACHED ${label}\\n"'`;
		try {
			// The chat is granted its own MCP port (as a real launch grants the loopback ports of its MCP servers).
			const result = await sh(agent(false, 'claude-code', { loopbackPorts: [own.port] }), [
				connect('own', own.port),
				connect('other-mcp', otherMcp.port),
				connect('agent-server', agentServer.port),
				connect('inspector', inspector.port),
				`cat '${join(f.userData, 'token')}'`,
			].join('; '));
			assert.ok(result.stdout.includes('REACHED own'), `the granted port is reachable: ${result.stdout} ${result.stderr}`);
			for (const label of ['other-mcp', 'agent-server', 'inspector']) {
				assert.ok(!result.stdout.includes(`REACHED ${label}`), `${label} is reachable through the granted port: ${result.stdout}`);
			}
			assert.ok(!result.stdout.includes('CANARY-AGENT-SERVER-TOKEN'), 'the agent-server token stays unreadable (F-04)');
			assert.strictEqual(own.hits(), 1, 'only the granted port was contacted');
			assert.strictEqual(otherMcp.hits() + agentServer.hits() + inspector.hits(), 0, 'no other Volt loopback server was contacted');
		} finally {
			await Promise.all([own.close(), otherMcp.close(), agentServer.close(), inspector.close()]);
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

	/** Answers of Volt's proxy to `CONNECT <host>:443`, one line per host: `<host> <status line> | <body of a 403>` (an open tunnel has no body to wait for). */
	const proxyAnswers = (hosts: readonly string[]) => hosts.map(host => `${PERL} -MIO::Socket::INET -MMIME::Base64 -e 'alarm 15; ($a,$h)=$ENV{HTTPS_PROXY}=~m{//([^@]+)@([^/]+)}; $s=IO::Socket::INET->new(PeerAddr=>$h, Timeout=>3) or exit 1; print $s "CONNECT $ARGV[0]:443 HTTP/1.1\\r\\nHost: $ARGV[0]:443\\r\\nProxy-Authorization: Basic ".encode_base64($a,"")."\\r\\n\\r\\n"; $l=<$s>; $l=~s/\\r?\\n//; while(defined($x=<$s>)){ last if $x=~/^\\r?\\n$/ } $b=$l=~/ 403 / ? <$s> : ""; $b//=""; $b=~s/\\r?\\n//; print "$ARGV[0] $l | $b\\n"' ${host}`).join('; ');

	test('POLFILE-REAL-1: a repository .volt/sandbox.json deny blocks a real read, write and host; the user\'s file widens', async () => {
		const dir = join(f.ws, 'polfile');
		await fs.mkdir(join(dir, 'private'), { recursive: true });
		await fs.writeFile(join(dir, 'private', 'secret.txt'), 'CANARY-POLFILE\n');
		await fs.writeFile(join(dir, 'locked.txt'), 'original\n');
		await fs.mkdir(join(f.ws, '.volt'), { recursive: true });
		const userFile = join(f.root, 'user-sandbox.json');
		await fs.writeFile(userFile, JSON.stringify({ schemaVersion: 1, network: { allow: ['example.com', 'example.org'] } }));
		await fs.writeFile(join(f.ws, '.volt', 'sandbox.json'), JSON.stringify({ schemaVersion: 1, filesystem: { deny: ['${workspace}/polfile/private'], protect: ['${workspace}/polfile/locked.txt'] }, network: { allow: ['example.org'] } }));
		try {
			const files = await new SandboxPolicyFiles(userFile).read(f.home, [f.ws], {});
			assert.deepStrictEqual(files.files.map(file => [file.source, file.state]), [['user', 'loaded'], ['workspace', 'loaded']]);
			const script = [`cat ${dir}/private/secret.txt`, `echo changed >> ${dir}/locked.txt`, `cat ${dir}/locked.txt`, proxyAnswers(['example.com', 'example.org'])].join('; ');
			// The user's file alone: the folder is readable, the file writable, and example.com is allowed.
			const userOnly = composeLaunchLayers(agent(false), files.layers.filter(layer => layer.source === 'user'));
			const before = await sh(userOnly.policy, script);
			assert.ok(before.stdout.includes('CANARY-POLFILE'), `readable without the repository's file: ${before.stdout} ${before.stderr}`);
			assert.ok(before.stdout.includes('changed'), 'writable without it');
			assert.ok(/^example\.com /m.test(before.stdout) && !/network access to example\.com is off/.test(before.stdout), `the user's file allows example.com: ${before.stdout}`);
			await fs.writeFile(join(dir, 'locked.txt'), 'original\n');
			// With the repository's file: the deny, the protection and the narrowed hosts hold in the real sandbox.
			const both = composeLaunchLayers(agent(false), files.layers, files.realpaths);
			assert.deepStrictEqual(both.ignored, []);
			const after = await sh(both.policy, script);
			assert.ok(!after.stdout.includes('CANARY-POLFILE'), `the repository's deny holds: ${after.stdout}`);
			assert.strictEqual(await fs.readFile(join(dir, 'locked.txt'), 'utf8'), 'original\n', 'the repository\'s protection holds');
			assert.ok(/^example\.com HTTP\/1\.1 403 .*network access to example\.com is off/m.test(after.stdout), `example.com is refused by the proxy: ${after.stdout} ${after.stderr}`);
			assert.ok(/^example\.org /m.test(after.stdout) && !/network access to example\.org is off/.test(after.stdout), `example.org is still allowed: ${after.stdout}`);
			assert.ok(after.denials.some(denial => denial.source === 'proxy' && denial.target.includes('example.com')), 'the refusal is reported');
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
			await fs.rm(join(f.ws, '.volt'), { recursive: true, force: true });
		}
		await assertHostUnchanged();
	});

	test('POLFILE-PROT-2: no sandboxed writer can change a .volt/sandbox.json, the user\'s even with ~/.volt writable (Linux: a missing one is best effort)', async () => {
		const repoFile = join(f.ws, '.volt', 'sandbox.json');
		const userDir = join(f.home, '.volt');
		const userFile = join(userDir, 'sandbox.json');
		await fs.mkdir(join(f.ws, '.volt'), { recursive: true });
		await fs.mkdir(userDir, { recursive: true });
		const policies = () => [workspace(), agent(false), agent(false, 'claude-code', { extraWritableRoots: [userDir] })];
		const attempts = (file: string) => [
			`echo '{"schemaVersion":1,"network":{"mode":"host"}}' > ${file}`,
			`echo x >> ${file}`,
			`mv ${file} ${file}.moved`,
			`rm -f ${file}`,
			`echo '{"schemaVersion":1}' > ${file}.new && mv ${file}.new ${file}`,
		].join('; ');
		try {
			// Existing files: never modified, replaced, moved or removed, on every OS.
			await fs.writeFile(repoFile, '{"schemaVersion":1}\n');
			await fs.writeFile(userFile, '{"schemaVersion":1}\n');
			for (const policy of policies()) {
				await sh(policy, `${attempts(repoFile)}; ${attempts(userFile)}`, { workspaceRoots: [f.ws] });
				assert.strictEqual(await fs.readFile(repoFile, 'utf8'), '{"schemaVersion":1}\n', `${policy.name}: the repository's file`);
				assert.ok(!await exists(`${repoFile}.moved`), policy.name);
			}
			// The third profile is the one with ~/.volt writable.
			assert.strictEqual(await fs.readFile(userFile, 'utf8'), '{"schemaVersion":1}\n', 'the user\'s file');
			// Missing files: macOS refuses creating them; bubblewrap can only guard paths that exist.
			await fs.rm(repoFile);
			await fs.rm(userFile);
			for (const policy of policies()) {
				const result = await sh(policy, `${attempts(repoFile)}; ${attempts(userFile)}`, { workspaceRoots: [f.ws] });
				if (isLinux) {
					assert.ok(result.unenforced.includes('filesystem.protectNew'), `${policy.name}: the run reports the gap`);
					await fs.rm(repoFile, { force: true });
					await fs.rm(userFile, { force: true });
				} else {
					assert.ok(!await exists(repoFile), `${policy.name}: created the repository's file`);
					assert.ok(!await exists(userFile), `${policy.name}: created the user's file`);
				}
			}
		} finally {
			await fs.rm(join(f.ws, '.volt'), { recursive: true, force: true });
			await fs.rm(userDir, { recursive: true, force: true });
		}
		await assertHostUnchanged();
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
		const composed = composeSandboxPolicy(workspace(), [{ source: 'user', trusted: true, layer: parsed.value }]).policy;
		// A dimension this policy uses that this backend reports it does not fully enforce, memory first
		// (macOS polls the footprint; Linux without a cgroup scope has RLIMIT_AS, virtual memory only).
		// With C4's cgroup layer memory is enforced, so another one is picked (bubblewrap's
		// filesystem.protectNew); there is always one, so the refusal is proven on every backend.
		const capabilities = await f.manager.capabilities();
		const dimension = ['limits.memory' as const, ...dimensionsUsed(composed)].find(used => capabilities.enforcement[used] !== 'enforced' && !(capabilities.optional ?? []).includes(used));
		assert.ok(dimension, `${capabilities.backend} enforces every dimension this policy uses: nothing to refuse`);
		// Not marked best effort, so the run must be refused rather than run as partial.
		const policy: IVoltSandboxPolicy = { ...composed, bestEffort: composed.bestEffort.filter(entry => entry !== dimension) };
		const result = await sh(policy, `touch ${f.ws}/should-not-run`, { expectRefusal: true });
		assert.strictEqual(result.status, 'unavailable');
		assert.ok(result.unenforced.includes(dimension), `${dimension} is reported unenforced: ${result.unenforced.join(', ')}`);
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

	macTest('MACOS-OUT-1: an app the agent made cannot be opened, made a URL handler or loaded as a launchd job; launchd\'s environment and the pasteboard stay the user\'s', async () => {
		const id = `dev.volt.sbxtest${process.pid}`;
		const scheme = `volt-sbx-${process.pid}`;
		const label = `dev.volt.sbxjob${process.pid}`;
		const variable = `VOLT_SBX_TEST_${process.pid}`;
		const marker = `VOLTSBXPASTE${process.pid}`;
		const app = join(f.ws, 'Probe.app');
		const plist = join(f.ws, `${label}.plist`);
		const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
		// An app whose only act is to leave a canary outside: launched by LaunchServices or launchd, it runs unsandboxed.
		await fs.mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
		await fs.writeFile(join(app, 'Contents', 'MacOS', 'probe'), `#!/bin/sh\n/usr/bin/touch '${f.outside}/canary-app'\n`, { mode: 0o755 });
		await fs.writeFile(join(app, 'Contents', 'Info.plist'), [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
			'<plist version="1.0"><dict>',
			`<key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>${id}</string>`,
			'<key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/>',
			`<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>${id}</string><key>CFBundleURLSchemes</key><array><string>${scheme}</string></array></dict></array>`,
			'</dict></plist>',
		].join('\n'));
		await fs.writeFile(plist, [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
			'<plist version="1.0"><dict>',
			`<key>Label</key><string>${label}</string>`,
			`<key>ProgramArguments</key><array><string>/usr/bin/touch</string><string>${f.outside}/canary-job</string></array>`,
			'<key>RunAtLoad</key><true/>',
			'</dict></plist>',
		].join('\n'));
		// What LaunchServices knows on the host: the app it would open for the scheme, the app it has for the
		// bundle id (registered), and the user's handler records (set even before an app is registered).
		const handlerOf = async () => {
			const known = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import("AppKit"); var w = $.NSWorkspace.sharedWorkspace; var u = w.URLForApplicationToOpenURL($.NSURL.URLWithString("${scheme}://x")); var a = w.URLForApplicationWithBundleIdentifier("${id}"); (u.isNil() ? "none" : u.path.js) + " " + (a.isNil() ? "none" : a.path.js)`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
			const secure = join(homedir(), 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist');
			const records = await fs.access(secure).then(() => execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', secure], { encoding: 'utf8' }), () => '');
			return `${known}${records.includes(scheme) ? ` RECORD ${scheme}` : ''}${records.includes(id) ? ` RECORD ${id}` : ''}`;
		};
		const uid = process.getuid?.() ?? 0;
		const jxa = (code: string) => `/usr/bin/osascript -l JavaScript -e '${code}' 2>&1`;
		try {
			const result = await sh(agent(true), [
				// LaunchServices: open the app, by path, by name and by bundle id; open its URL.
				`open '${app}' 2>&1`, `open -a '${app}' 2>&1`, `open -b ${id} 2>&1`, `open '${scheme}://x' 2>&1`,
				// Register it and make it the handler of its scheme (lsd), with no `open` at all.
				`${lsregister} -f '${app}' 2>&1`,
				jxa(`ObjC.import("CoreServices"); console.log("REGISTER " + $.LSRegisterURL($.NSURL.fileURLWithPath("${app}"), true))`),
				jxa(`ObjC.import("CoreServices"); console.log("HANDLER " + $.LSSetDefaultHandlerForURLScheme($("${scheme}"), $("${id}")))`),
				// launchd: load, bootstrap and submit a job; set a variable every app the user starts later inherits.
				`launchctl load '${plist}' 2>&1`, `launchctl bootstrap gui/${uid} '${plist}' 2>&1`,
				`launchctl submit -l ${label}.submit -- /usr/bin/touch '${f.outside}/canary-submit' 2>&1`,
				`launchctl setenv ${variable} pwned 2>&1`,
				// Apple Events to another app (refused before TCC is asked, so no prompt), and the pasteboard.
				`/usr/bin/osascript -e 'tell application "Finder" to count windows' 2>&1`,
				`printf ${marker} | pbcopy 2>&1`,
			].join('; '), { timeoutMs: 60_000 });
			await new Promise(resolve => setTimeout(resolve, 2_000));
			for (const canary of ['canary-app', 'canary-job', 'canary-submit']) {
				assert.ok(!await exists(join(f.outside, canary)), `${canary}: ${result.stdout}`);
			}
			const handler = await handlerOf();
			assert.ok(!handler.includes('Probe.app') && !handler.includes(id), `the agent's app handles ${scheme}: ${handler} ${result.stdout}`);
			const env = execFileSync('/bin/launchctl', ['getenv', variable], { encoding: 'utf8' }).trim();
			assert.strictEqual(env, '', `launchd's environment was changed: ${result.stdout}`);
			const paste = execFileSync('/usr/bin/pbpaste', { encoding: 'utf8' });
			assert.ok(!paste.includes(marker), 'the pasteboard was written');
			assert.ok(!/^\d+$/m.test(result.stdout), `an Apple Event reached Finder: ${result.stdout}`);
		} finally {
			for (const args of [['bootout', `gui/${uid}/${label}`], ['remove', label], ['remove', `${label}.submit`], ['unsetenv', variable]]) {
				try { execFileSync('/bin/launchctl', args, { stdio: 'ignore' }); } catch { /* not there */ }
			}
			try { execFileSync(lsregister, ['-u', app], { stdio: 'ignore' }); } catch { /* not registered */ }
			await fs.rm(app, { recursive: true, force: true });
			await fs.rm(plist, { force: true });
			for (const canary of ['canary-app', 'canary-job', 'canary-submit']) {
				await fs.rm(join(f.outside, canary), { force: true });
			}
		}
		await assertHostUnchanged();
	});

	macTest('MACOS-OUT-2: the mach services that run code for the agent outside the sandbox are unreachable (ServiceManagement, Background Task Management, login items, the LaunchServices database, Apple Events, cfprefsd, the pasteboard)', async () => {
		// `bootstrap_look_up` succeeds only when the sandbox lets the agent reach the service: a denied
		// mach-lookup returns a non-zero kern_return. The SMAppService/login-item/LaunchServices-database
		// APIs are built on these, so blocking the lookups blocks the API (verified with a signed helper).
		const probe = join(f.ws, 'mach-probe.py');
		await fs.writeFile(probe, [
			'import ctypes, sys',
			"libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')",
			"bp = ctypes.c_uint.in_dll(libc, 'bootstrap_port')",
			'look = libc.bootstrap_look_up',
			'look.argtypes = [ctypes.c_uint, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint)]',
			'for name in sys.argv[1:]:',
			'    port = ctypes.c_uint(0)',
			'    kr = look(bp.value, name.encode(), ctypes.byref(port))',
			"    print(('OPEN ' if kr == 0 else 'CLOSED ') + name)",
			'',
		].join('\n'));
		// Every service these deny: registering a launch agent or login item, or the LaunchServices
		// database that makes the agent's app a URL or document handler the host opens later.
		const denied = [
			'com.apple.xpc.smd', 'com.apple.xpc.loginitemregisterd', 'com.apple.backgroundtaskmanagement', 'com.apple.backgroundtaskmanagementagent',
			'com.apple.coreservices.sharedfilelistd.xpc', 'com.apple.lsd.modifydb', 'com.apple.lsd.open', 'com.apple.coreservices.launchservicesd',
			'com.apple.CoreServices.coreservicesd', 'com.apple.coreservices.appleevents', 'com.apple.cfprefsd.agent', 'com.apple.cfprefsd.daemon',
			'com.apple.pasteboard.1', 'com.apple.windowserver.active',
		];
		// A control the agent legitimately reaches: user and group lookups. If this came back CLOSED the
		// probe would be meaningless (every lookup failing), so the denials below would prove nothing.
		const control = 'com.apple.system.opendirectoryd.libinfo';
		for (const network of [false, true]) {
			const result = await sh(agent(network), `/usr/bin/python3 '${probe}' ${[control, ...denied].join(' ')}`);
			const verdict = new Map(result.stdout.trim().split('\n').map(line => [line.slice(line.indexOf(' ') + 1), line.slice(0, line.indexOf(' '))]));
			assert.strictEqual(verdict.get(control), 'OPEN', `the probe works (network=${network}): ${result.stdout} ${result.stderr}`);
			for (const name of denied) {
				assert.strictEqual(verdict.get(name), 'CLOSED', `${name} is reachable (network=${network}): ${result.stdout}`);
			}
		}
		await fs.rm(probe, { force: true });
		await assertHostUnchanged();
	});
});
