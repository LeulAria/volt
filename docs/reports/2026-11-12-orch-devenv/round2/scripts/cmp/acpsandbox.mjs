// Cold start of the Claude ACP adapter (initialize + session/new), direct vs through Volt's sandbox
// launcher (VoltSandboxLauncher.prepare with a chat state key: Seatbelt workspace-write + the per-chat
// CLAUDE_CONFIG_DIR overlay), N in parallel. No model call. Runs the transpiled out/ of a checkout.
//   node acpsandbox.mjs <checkout> <direct|sandbox|overlay> [parallel=1]
import { spawn } from 'child_process';
import { join } from 'path';
import { pathToFileURL } from 'url';
const [checkout, mode, par = '1'] = process.argv.slice(2);
const ACP = '/Users/leularia/.npm/_npx/698eb38f5d7f5a61/node_modules/.bin/claude-agent-acp';
const cwd = '/private/tmp/vcmp/w/t1';
const outDir = join(checkout, 'out');
globalThis._VSCODE_FILE_ROOT = outDir;
const hostEnv = { ...process.env };
for (const k of Object.keys(hostEnv)) { if (/^CLAUDE|^ELECTRON_RUN_AS_NODE$/.test(k)) { delete hostEnv[k]; } }
let launcher;
if (mode !== 'direct') {
	const { VoltSandboxLauncher } = await import(pathToFileURL(join(outDir, 'vs/platform/voltSandbox/node/sandboxLauncher.js')).href);
	launcher = new VoltSandboxLauncher('/tmp/vcmp/sbx-ud', { info: () => undefined, warn: () => undefined });
}
async function one(i) {
	const t0 = performance.now();
	let command = ACP, args = [], env = hostEnv, extra = [], launch;
	if (mode === 'sandbox' || mode === 'overlay') {
		launch = await launcher.prepare(ACP, [], { level: 'workspace-write', network: true, providerId: 'claude-code', workspaceRoots: [cwd], stateKey: `cmp-probe-${Date.now()}-${i}` }, { hostEnv, cwd });
		({ command, args, env } = launch);
		extra = launch.extraStdio ?? [];
	}
	const tPrep = performance.now();
	const p = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore', ...extra], detached: true });
	if (launch) { const c = await launch.confirm(p); if (!c.ok) { throw new Error(c.error); } }
	const tSpawn = performance.now();
	let buf = ''; const waits = new Map();
	p.stdout.on('data', d => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); try { const m = JSON.parse(line); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); } } catch { } } });
	const req = (id, method, params) => new Promise(r => { waits.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
	await req(1, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'bench', version: '0' } });
	const t1 = performance.now();
	const s = await req(2, 'session/new', { cwd, mcpServers: [] });
	const t2 = performance.now();
	try { process.kill(-p.pid, 'SIGKILL'); } catch { }
	launch?.dispose?.();
	return { i, prepMs: Math.round(tPrep - t0), spawnMs: Math.round(tSpawn - tPrep), initMs: Math.round(t1 - tSpawn), sessionMs: Math.round(t2 - t1), totalMs: Math.round(t2 - t0), ok: !!s.result };
}
const rows = await Promise.all(Array.from({ length: Number(par) }, (_, i) => one(i)));
console.log(JSON.stringify({ mode, par: Number(par), load: (await import('os')).loadavg()[0].toFixed(1), rows }));
await launcher?.shutdown?.();
process.exit(0);
