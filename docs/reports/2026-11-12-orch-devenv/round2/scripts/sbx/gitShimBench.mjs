// `/usr/bin/git --version` under the T3 extension-host policy, before/after builds interleaved (A, B, A, B...).
//   node gitShimBench.mjs <out-before> <out-after> [runs]
// Each run is a fresh SandboxManager run (a new process tree), as an extension's child process is.
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
const [before, after, runsArg = '5'] = process.argv.slice(2);
const runs = Number(runsArg);
async function arm(root) {
	globalThis._VSCODE_FILE_ROOT = root;
	const load = p => import(pathToFileURL(join(root, p)).href);
	const { SandboxManager } = await load('vs/platform/voltSandbox/node/sandboxManager.js');
	const { sandboxHostFacts } = await load('vs/platform/voltSandbox/node/sandboxResolver.js');
	const { t3ExtensionHostPolicy, t3ManifestView } = await load('vs/platform/voltSandbox/common/extensionHostSandbox.js');
	const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'v2-gitbench-')));
	const home = join(base, 'home'), ws = join(base, 'ws'), ext = join(base, 'ext');
	for (const d of [home, ws, ext, join(base, 'runs')]) await fs.mkdir(d, { recursive: true });
	const manager = new SandboxManager(undefined, { runRoot: join(base, 'runs'), host: { ...await sandboxHostFacts(), home } });
	const policy = t3ExtensionHostPolicy({ platform: process.platform, home, extensionDir: ext, appRoots: [], workspaceTrusted: true });
	return {
		async run() {
			const t0 = performance.now();
			const r = await manager.run({ command: '/usr/bin/git', args: ['--version'], policy, context: { workspaceRoots: [ws], hostEnv: { PATH: '/usr/bin:/bin', HOME: home }, storageDir: join(base, 'storage') }, networkView: { manifest: t3ManifestView('x.y', []) }, principalKind: 't3' }, { timeoutMs: 120000 });
			return { ms: Math.round(performance.now() - t0), ok: r.status === 'completed' && /^git version/.test(r.stdout) };
		},
		async dispose() { await manager.dispose(); await fs.rm(base, { recursive: true, force: true }); },
	};
}
// Separate module graphs: one child process per arm and run keeps the builds apart.
if (process.env.GITBENCH_ARM) {
	const a = await arm(process.env.GITBENCH_ARM);
	console.log(JSON.stringify(await a.run()));
	await a.dispose();
	process.exit(0);
}
const rows = [];
for (let i = 0; i < runs; i++) {
	for (const [label, root] of [['before', before], ['after', after]]) {
		const load = execFileSync('/usr/sbin/sysctl', ['-n', 'vm.loadavg']).toString().trim().split(/\s+/)[1];
		const out = execFileSync(process.execPath, [new URL(import.meta.url).pathname], { env: { ...process.env, GITBENCH_ARM: root } }).toString().trim().split('\n').pop();
		rows.push({ label, run: i + 1, load: Number(load), ...JSON.parse(out) });
		console.error(label, i + 1, out, 'load', load);
	}
}
const med = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
for (const label of ['before', 'after']) {
	const ms = rows.filter(r => r.label === label).map(r => r.ms);
	console.log(JSON.stringify({ label, n: ms.length, medianMs: med(ms), minMs: Math.min(...ms), maxMs: Math.max(...ms), allOk: rows.filter(r => r.label === label).every(r => r.ok) }));
}
console.log(JSON.stringify({ rows }));
