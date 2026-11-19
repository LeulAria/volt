/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the sandbox costs, and whether normal work still works in it.
//
//   node cost.mjs [--n 10] [--out file.json] [--volt-out /path/to/out] [--files 3000]   timings, plain and sandboxed, interleaved
//   node cost.mjs --workflow                                                            a normal build / test / git workflow in the sandbox; exit 1 when a step fails
//
// Timings: each command runs plain (a direct spawn) and sandboxed (the real SandboxManager with the
// agent profile, workspace-write, network off), alternating, n times each. Two numbers per run:
// `total` is the whole launch as Volt pays it (policy resolve, profile, attestation, the command,
// exit), `inner` is the command alone, timed around it inside the shell, so the sandbox's cost per
// file operation shows without the launch. The 1-minute load is recorded with every sample.

import { execFileSync, spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : fallback; };
const flag = name => process.argv.includes(name);
const here = dirname(fileURLToPath(import.meta.url));
const OUT = arg('--volt-out', process.env.VOLT_OUT ?? join(here, '..', '..', '..', '..', '..', '..', 'out'));
globalThis._VSCODE_FILE_ROOT = OUT;
const load = path => import(pathToFileURL(join(OUT, path)).href);
const { SandboxManager } = await load('vs/platform/voltSandbox/node/sandboxManager.js');
const { agentSandboxPolicy } = await load('vs/platform/voltSandbox/common/sandboxPolicy.js');
const { sandboxHostFacts } = await load('vs/platform/voltSandbox/node/sandboxResolver.js');

const isMac = process.platform === 'darwin';
const n = Number(arg('--n', '10'));
const fileCount = Number(arg('--files', '3000'));
const PERL = '/usr/bin/perl';

// --- Fixture: a fake home, a git repository with `fileCount` files, a small package with tests ---
const fixtureParent = arg('--fixture', join(os.homedir(), '.volt-r10', 'sandbox', 'canary'));
await fs.mkdir(fixtureParent, { recursive: true });
const root = await fs.realpath(await fs.mkdtemp(join(fixtureParent, 'volt-r10-cost-')));
const home = join(root, 'home');
const ws = join(root, 'ws');
const agentTmp = join(root, 'agent-tmp');
for (const dir of [home, ws, agentTmp, join(root, 'runs'), join(home, '.volt', 'sandbox-cache')]) {
	await fs.mkdir(dir, { recursive: true });
}
const which = name => { try { return execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
// The real git binary: on macOS `/usr/bin/git` is a shim that looks up Xcode on every call.
const git = isMac ? join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git') : which('git');
const node = process.execPath;
const npm = which('npm');
const PATH = [...new Set([dirname(node), dirname(git), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
const hostEnv = { PATH, HOME: home, LANG: 'C' };
const hostGit = args => execFileSync(git, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: ws, stdio: ['ignore', 'pipe', 'pipe'], env: { ...hostEnv, GIT_CONFIG_NOSYSTEM: '1' } });
for (let i = 0; i < fileCount; i++) {
	const dir = join(ws, 'src', `m${String(i % 60).padStart(2, '0')}`);
	if (i < 60) { await fs.mkdir(dir, { recursive: true }); }
	await fs.writeFile(join(dir, `f${i}.ts`), `export const value${i} = ${i};\n// ${'x'.repeat(200)}\n`);
}
await fs.mkdir(join(ws, 'test'), { recursive: true });
await fs.writeFile(join(ws, 'package.json'), JSON.stringify({ name: 'volt-r10-cost', version: '1.0.0', private: true, scripts: { test: 'node --test', build: 'node build.js' } }, null, 2) + '\n');
await fs.writeFile(join(ws, 'build.js'), `const fs = require('fs'); const path = require('path');\nfs.mkdirSync('dist', { recursive: true });\nlet count = 0;\nfor (const dir of fs.readdirSync('src')) { let out = ''; for (const file of fs.readdirSync(path.join('src', dir))) { out += fs.readFileSync(path.join('src', dir, file), 'utf8'); count++; } fs.writeFileSync(path.join('dist', dir + '.js'), out); }\nconsole.log('built ' + count);\n`);
for (let i = 0; i < 10; i++) {
	await fs.writeFile(join(ws, 'test', `t${i}.test.js`), `const test = require('node:test'); const assert = require('node:assert');\nfor (let k = 0; k < 5; k++) { test('case ' + k, () => { assert.strictEqual(${i} + k, k + ${i}); }); }\n`);
}
await fs.writeFile(join(ws, '.gitignore'), 'dist/\n');
hostGit(['init', '-q', '-b', 'main']);
hostGit(['add', '-A']);
hostGit(['commit', '-q', '-m', 'init']);
// A working tree with changes: 20 modified, 20 untracked.
for (let i = 0; i < 20; i++) {
	await fs.appendFile(join(ws, 'src', 'm00', `f${i * 60}.ts`), '// changed\n');
	await fs.writeFile(join(ws, 'src', 'm01', `new${i}.ts`), 'export {};\n');
}

const facts = await sandboxHostFacts();
const manager = new SandboxManager(undefined, { runRoot: join(root, 'runs'), host: { ...facts, home } });
// The temp folders of a real launch (sandboxLauncher.ts `hostFacts`): the user's and the shared ones.
const real = path => fs.realpath(path).catch(() => path);
const darwinCache = isMac ? await real(execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8' }).trim()) : undefined;
const tempDirs = [...new Set([facts.tmpRoot, await real('/tmp'), await real('/var/tmp'), ...(darwinCache ? [darwinCache] : []), agentTmp])];
const policy = () => agentSandboxPolicy({ level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: [ws] }, { platform: process.platform, home, tempDirs, cacheDir: join(home, '.volt', 'sandbox-cache') });
const G = `${git} -c user.name=t -c user.email=t@t -c core.hooksPath=/dev/null`;

/** `command` wrapped so the shell reports how long the command alone took. */
const timed = command => `${PERL} -MTime::HiRes=time -e '$t=time; $r=system("/bin/sh","-c",$ARGV[0]); printf STDERR "INNER %.2f %d\\n", (time-$t)*1000, $r>>8' '${command.replace(/'/g, `'\\''`)}'`;
const inner = stderr => { const m = /INNER ([\d.]+) (\d+)/.exec(stderr); return m ? { ms: Number(m[1]), exit: Number(m[2]) } : undefined; };

function plain(command) {
	return new Promise(resolve => {
		const started = performance.now();
		const child = spawn('/bin/sh', ['-c', timed(command)], { cwd: ws, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '', stderr = '';
		child.stdout.on('data', d => stdout += d);
		child.stderr.on('data', d => stderr += d);
		child.on('close', () => resolve({ total: performance.now() - started, inner: inner(stderr), stdout, stderr }));
	});
}
async function sandboxed(command) {
	const started = performance.now();
	const result = await manager.run({ command: '/bin/sh', args: ['-c', timed(command)], policy: policy(), context: { workspaceRoots: [ws], cwd: ws, hostEnv } }, { timeoutMs: 300_000 });
	return { total: performance.now() - started, inner: inner(result.stderr), stdout: result.stdout, stderr: result.stderr, status: result.status, error: result.error };
}

const capabilities = await manager.capabilities();
if (!capabilities.available) {
	console.error(`No sandbox backend: ${capabilities.diagnostics?.join(' ')}`);
	process.exit(2);
}
const testCommand = npm ? 'npm test --silent' : `${node} --test`;
let exitCode = 0;
try {
	if (flag('--workflow')) {
		// Normal agent work, every step inside the sandbox: edit, build, test, and a git round trip.
		const steps = [
			['edit a file', `echo 'export const added = 1;' >> src/m02/f2.ts && grep -q added src/m02/f2.ts`],
			['build', `${node} build.js | grep -q 'built ${fileCount + 20}'`],
			['test', testCommand + ' >/dev/null'],
			['git status', `${G} status --porcelain | grep -q 'src/m02/f2.ts'`],
			['git diff', `${G} diff --stat | grep -q 'changed'`],
			['git add + commit', `${G} add -A && ${G} commit -q -m 'sandboxed work' && ${G} log --oneline | grep -q 'sandboxed work'`],
			['git branch + checkout', `${G} checkout -q -b feature/x && ${G} checkout -q main`],
			['git stash', `echo '// wip' >> src/m03/f3.ts && ${G} stash -q && ${G} stash pop -q && grep -q wip src/m03/f3.ts`],
			['git merge', `${G} checkout -q feature/x && echo 'export {};' > src/m04/merge.ts && ${G} add -A && ${G} commit -q -m branch && ${G} checkout -q main && ${G} merge -q --no-ff -m merge feature/x && test -f src/m04/merge.ts`],
			['git rebase', `${G} checkout -q -b feature/y HEAD~1 && echo 'export {};' > src/m05/rebase.ts && ${G} add -A && ${G} commit -q -m y && ${G} rebase -q main && ${G} checkout -q main`],
			['temp files and pipes', `t=$(mktemp) && echo ok > "$t" && cat "$t" | grep -q ok && rm "$t"`],
			['search', `grep -rl 'value1234 ' src | grep -q f1234.ts`],
		];
		for (const [name, command] of steps) {
			const result = await sandboxed(command);
			const ok = result.status === 'completed' && result.inner?.exit === 0;
			console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(24)} ${Math.round(result.total)} ms${ok ? '' : `  ${result.status} ${result.error ?? ''} ${result.stderr.replace(/INNER.*/, '').slice(0, 300)}`}`);
			if (!ok) { exitCode = 1; }
		}
	} else {
		const commands = [
			['spawn (`true`)', 'true'],
			[`git status (${fileCount} files, 20 changed, 20 new)`, `${G} status --porcelain >/dev/null`],
			[`grep -r over ${fileCount} files`, `grep -rc 'value' src >/dev/null`],
			[`build (read ${fileCount} files, write 60)`, `${node} build.js >/dev/null`],
			[npm ? 'npm test (10 files, 50 tests)' : 'node --test (10 files, 50 tests)', `${testCommand} >/dev/null 2>&1`],
		];
		const results = [];
		for (const [name, command] of commands) {
			// One warm-up of each arm (page cache, the backend's probe), not counted.
			await plain(command); await sandboxed(command);
			const samples = [];
			for (let i = 0; i < n; i++) {
				const order = i % 2 === 0 ? ['plain', 'sandboxed'] : ['sandboxed', 'plain'];
				for (const arm of order) {
					const loadAvg = os.loadavg()[0];
					const result = arm === 'plain' ? await plain(command) : await sandboxed(command);
					if (!result.inner || result.inner.exit !== 0 || (arm === 'sandboxed' && result.status !== 'completed')) {
						console.error(`${name} ${arm} failed: ${result.status ?? ''} ${result.error ?? ''} ${result.stderr.slice(0, 300)}`);
						exitCode = 1;
						continue;
					}
					samples.push({ arm, total: result.total, inner: result.inner.ms, load: loadAvg });
				}
			}
			const stat = (arm, key) => {
				const values = samples.filter(s => s.arm === arm).map(s => s[key]).sort((a, b) => a - b);
				const median = values.length ? (values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2) : NaN;
				return { n: values.length, median: Math.round(median * 10) / 10, min: Math.round(values[0] * 10) / 10, max: Math.round(values[values.length - 1] * 10) / 10 };
			};
			const loads = samples.map(s => s.load);
			const row = { name, plainTotal: stat('plain', 'total'), sandboxedTotal: stat('sandboxed', 'total'), plainInner: stat('plain', 'inner'), sandboxedInner: stat('sandboxed', 'inner'), load: { min: Math.round(Math.min(...loads) * 10) / 10, max: Math.round(Math.max(...loads) * 10) / 10 } };
			results.push({ ...row, samples });
			const show = s => `${s.median} (${s.min}-${s.max}, n=${s.n})`;
			console.log(`${name}\n  total ms  plain ${show(row.plainTotal)}  sandboxed ${show(row.sandboxedTotal)}  +${Math.round((row.sandboxedTotal.median - row.plainTotal.median) * 10) / 10}\n  inner ms  plain ${show(row.plainInner)}  sandboxed ${show(row.sandboxedInner)}  x${Math.round(row.sandboxedInner.median / row.plainInner.median * 100) / 100}\n  load ${row.load.min}-${row.load.max}`);
		}
		const summary = { platform: process.platform, release: os.release(), backend: capabilities.backend, cpus: os.cpus().length, when: new Date().toISOString(), n, fileCount, node: process.version };
		console.log(JSON.stringify(summary));
		if (arg('--out', undefined)) {
			await fs.writeFile(arg('--out'), JSON.stringify({ summary, results }, null, '\t') + '\n');
		}
	}
} finally {
	await manager.dispose();
	await fs.rm(root, { recursive: true, force: true });
}
process.exit(exitCode);
