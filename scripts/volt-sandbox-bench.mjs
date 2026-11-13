/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Measures the sandbox: policy compilation, startup latency, per-command overhead, concurrency and
// small-file I/O, sandboxed against direct. Runs the transpiled sources in out/ (run
// `npm run transpile-client-oxc` first). Prints JSON and a table; numbers go in
// docs/security/sandbox/04-performance.md with the machine they came from.
//
//   node scripts/volt-sandbox-bench.mjs [--runs 30]

import { execFileSync, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { cpus, tmpdir, totalmem } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// As bootstrap-esm sets it: the macOS backend finds its helper (.build/volt-helpers) from the app root.
globalThis._VSCODE_FILE_ROOT = join(root, 'out');
const load = path => import(pathToFileURL(join(root, 'out', path)).href);
const { SandboxManager } = await load('vs/platform/voltSandbox/node/sandboxManager.js');
const { builtinProfile } = await load('vs/platform/voltSandbox/common/sandboxProfiles.js');
const { agentSandboxPolicy } = await load('vs/platform/voltSandbox/common/sandboxPolicy.js');
const { resolveSandboxPolicy, sandboxHostFacts } = await load('vs/platform/voltSandbox/node/sandboxResolver.js');
const { buildSeatbeltProfile } = await load('vs/platform/voltSandbox/common/seatbelt.js');

const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 30;
const work = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-sbx-bench-')));
const ws = join(work, 'ws');
await fs.mkdir(ws);
// Run folders apart from the workspace: every run's sibling folders are hidden from it (B-35).
const runRoot = join(work, 'runs');
await fs.mkdir(runRoot);
const manager = new SandboxManager(undefined, { runRoot });
const capabilities = await manager.capabilities();
if (!capabilities.available) {
	console.error(`No sandbox backend: ${capabilities.diagnostics.join(' ')}`);
	process.exit(1);
}
const host = await sandboxHostFacts();
const hostEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C' };

const stats = values => {
	const sorted = [...values].sort((a, b) => a - b);
	const pick = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
	return { median: +pick(0.5).toFixed(2), p90: +pick(0.9).toFixed(2), p95: +pick(0.95).toFixed(2), min: +sorted[0].toFixed(2), n: sorted.length };
};
const time = async fn => { const t = performance.now(); await fn(); return performance.now() - t; };
const direct = (command, args) => new Promise((resolve, reject) => {
	const child = spawn(command, args, { cwd: ws, env: hostEnv, stdio: 'ignore' });
	child.on('error', reject);
	child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
const sandboxed = async (policy, command, args) => {
	const result = await manager.run({ command, args, policy, context: { workspaceRoots: [ws], hostEnv } });
	if (result.status !== 'completed' || result.exitCode !== 0) {
		throw new Error(`${command}: ${result.status} ${result.exitCode} ${result.signal ?? ''} ${result.error ?? ''} ${result.stderr}`);
	}
	return result;
};

const results = { machine: { cpu: cpus()[0]?.model, cores: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), platform: process.platform, node: process.version, backend: capabilities.backend, details: capabilities.details }, runs };

// 1. Policy compilation: resolve + profile text, no process.
const compile = [];
for (let i = 0; i < runs; i++) {
	const runTmp = await fs.mkdtemp(join(work, 'compile-'));
	compile.push(await time(async () => {
		const { policy } = await resolveSandboxPolicy(builtinProfile('workspace'), { workspaceRoots: [ws], hostEnv }, host, runTmp);
		if (process.platform === 'darwin') {
			buildSeatbeltProfile(policy, { tag: 'bench' });
		}
	}));
}
results.compileMs = stats(compile);

// The agent profile: narrow reads with its deny patterns. Size and filter counts of the profile
// text, and the time `sandbox-exec` alone takes to compile it and run `/usr/bin/true`.
const agent = agentSandboxPolicy({ level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: [ws] }, { platform: process.platform, home: host.home, tempDirs: [host.tmpRoot], cacheDir: join(work, 'cache') });
if (process.platform === 'darwin') {
	const agentCompile = [];
	let profile = '';
	for (let i = 0; i < runs; i++) {
		const runTmp = await fs.mkdtemp(join(work, 'compile-'));
		agentCompile.push(await time(async () => {
			const { policy } = await resolveSandboxPolicy(agent, { workspaceRoots: [ws], hostEnv }, host, runTmp);
			profile = buildSeatbeltProfile(policy, { tag: 'bench' });
		}));
	}
	results.agentCompileMs = stats(agentCompile);
	const count = construct => (profile.match(new RegExp(`\\(${construct} `, 'g')) ?? []).length;
	results.agentProfile = { bytes: profile.length, regex: count('regex'), subpath: count('subpath'), literal: count('literal') };
	const file = join(work, 'agent.sb');
	await fs.writeFile(file, profile);
	const exec = [];
	for (let i = 0; i < runs; i++) {
		exec.push(await time(() => direct('/usr/bin/sandbox-exec', ['-f', file, '/usr/bin/true'])));
	}
	results.agentSandboxExecMs = stats(exec);
}

// 2. Startup: /usr/bin/true direct vs sandboxed (workspace and agent profiles).
const startup = { direct: [], workspace: [], agent: [], phases: [], agentPhases: [] };
for (let i = 0; i < runs; i++) {
	startup.direct.push(await time(() => direct('/usr/bin/true', [])));
	const r = await sandboxed(builtinProfile('workspace'), '/usr/bin/true', []);
	startup.workspace.push(r.timing.totalMs);
	startup.phases.push(r.timing);
	const a = await sandboxed(agent, '/usr/bin/true', []);
	startup.agent.push(a.timing.totalMs);
	startup.agentPhases.push(a.timing);
}
results.startupMs = {
	direct: stats(startup.direct),
	workspace: stats(startup.workspace),
	agent: stats(startup.agent),
	workspacePrepare: stats(startup.phases.map(p => p.prepareMs)),
	workspaceStart: stats(startup.phases.map(p => p.startMs)),
	agentPrepare: stats(startup.agentPhases.map(p => p.prepareMs)),
	agentStart: stats(startup.agentPhases.map(p => p.startMs)),
};

// 3. Per-command overhead inside one sandbox: 200 `true` in a sandboxed shell vs a direct one.
const loop = 'i=0; while [ $i -lt 200 ]; do /usr/bin/true; i=$((i+1)); done';
const inner = { direct: [], sandboxed: [] };
for (let i = 0; i < Math.min(runs, 10); i++) {
	inner.direct.push(await time(() => direct('/bin/sh', ['-c', loop])) / 200);
	inner.sandboxed.push(await time(() => sandboxed(builtinProfile('workspace'), '/bin/sh', ['-c', loop])) / 200);
}
results.perCommandMs = { direct: stats(inner.direct), sandboxed: stats(inner.sandboxed) };

// 4. Concurrency: 8 sandboxes at once.
const concurrent = [];
for (let i = 0; i < Math.min(runs, 10); i++) {
	concurrent.push(await time(() => Promise.all(Array.from({ length: 8 }, () => sandboxed(builtinProfile('workspace'), '/usr/bin/true', [])))));
}
results.eightConcurrentMs = stats(concurrent);

// 5. Small-file I/O: write and read back 1000 files of 1 KB.
const io = 'mkdir -p f && i=0; while [ $i -lt 1000 ]; do head -c 1024 /dev/zero > f/$i; i=$((i+1)); done; cat f/* > /dev/null; rm -rf f';
const fsio = { direct: [], sandboxed: [] };
for (let i = 0; i < Math.min(runs, 5); i++) {
	fsio.direct.push(await time(() => direct('/bin/sh', ['-c', io])));
	fsio.sandboxed.push(await time(() => sandboxed(builtinProfile('workspace'), '/bin/sh', ['-c', io])));
}
results.thousandSmallFilesMs = { direct: stats(fsio.direct), sandboxed: stats(fsio.sandboxed) };

// 6. Memory: what a run adds on the host side (the macOS watchdog shell; bubblewrap's monitor).
try {
	const prepared = await manager.prepare({ command: '/bin/sleep', args: ['5'], policy: builtinProfile('workspace'), context: { workspaceRoots: [ws], hostEnv } });
	const child = spawn(prepared.command, [...prepared.args], { cwd: prepared.cwd, env: prepared.env, stdio: ['ignore', 'ignore', 'ignore', ...prepared.extraStdio], detached: true });
	await prepared.confirm(child);
	await new Promise(resolve => setTimeout(resolve, 300));
	const rss = execFileSync('/bin/ps', ['-axo', 'rss=,command='], { encoding: 'utf8' }).split('\n')
		.filter(line => /volt-sandbox-watchdog|bwrap|socat/.test(line)).map(line => Number(line.trim().split(/\s+/)[0]));
	results.hostSideRssKB = { processes: rss.length, total: rss.reduce((a, b) => a + b, 0) };
	await prepared.terminate(child);
	await prepared.dispose();
} catch (err) {
	results.hostSideRssKB = { error: String(err) };
}

await manager.dispose();
await fs.rm(work, { recursive: true, force: true });
console.log(JSON.stringify(results, null, 2));
