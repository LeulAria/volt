// fx acp start through the real VoltSandboxLauncher: initialize -> session/new, with every denial logged.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
const [outDir, mode = 'sbx', net = 'on'] = process.argv.slice(2);
globalThis._VSCODE_FILE_ROOT = outDir;
const { VoltSandboxLauncher } = await import(pathToFileURL(join(outDir, 'vs/platform/voltSandbox/node/sandboxLauncher.js')).href);
const bin = '/Users/leularia/.local/bin/fx';
const cwd = '/private/tmp/v2-sbx/fx/ws';
const env = { ...process.env, FX_TRACE_LOG: '/private/tmp/v2-sbx/fx/ws/trace.log' }; delete env.ELECTRON_RUN_AS_NODE;
const userData = '/tmp/v2-sbx/fx/ud'; await fs.mkdir(userData, { recursive: true });
const launcher = mode === 'plain' ? undefined : new VoltSandboxLauncher(userData, { info: m => process.env.V && console.error(m), warn: m => console.error('WARN', m) });
const T0 = performance.now();
const denials = [];
launcher?.onViolation(e => { denials.push(e.denial); console.error(`DENIAL +${Math.round(performance.now() - T0)}ms ${e.denial.kind} ${e.denial.target} ${e.denial.process ?? ''}`); });
let p, launch;
if (launcher) {
	launch = await launcher.prepare(bin, ['acp'], { level: 'workspace-write', network: net === 'on', providerId: 'fx', workspaceRoots: [cwd], stateKey: 'v2-fx-probe' }, { cwd, hostEnv: env, env: { FX_TRACE_LOG: '/private/tmp/v2-sbx/fx/ws/trace.log' }, label: 'fx probe' });
	p = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe', ...launch.extraStdio], detached: true });
} else {
	p = spawn(bin, ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
}
let err = ''; p.stderr.on('data', d => { err += d; });
if (launch) { const c = await launch.confirm(p); if (!c.ok) throw new Error(c.error); }
let buf = ''; const waits = new Map();
p.stdout.on('data', d => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); try { const m = JSON.parse(line); if (m.id && waits.has(m.id)) waits.get(m.id)(m); } catch { } } });
const req = (id, method, params) => Promise.race([new Promise(r => { waits.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }), new Promise(r => setTimeout(() => r({ error: 'timeout 30s' }), 30000))]);
const t0 = performance.now();
const init = await req(1, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'probe', version: '0' } });
const t1 = performance.now();
const s = await req(2, 'session/new', { cwd, mcpServers: [] });
const t2 = performance.now();
console.log(JSON.stringify({ mode, net, initMs: Math.round(t1 - t0), sessionMs: Math.round(t2 - t1), init: init.error ?? 'ok', session: s.error ?? (s.result ? 'ok ' + JSON.stringify(s.result).slice(0, 120) : s), stderr: err.slice(-1200) }, null, 1));
await new Promise(r => setTimeout(r, 1500));
if (launch) { await launch.terminate(p); launch.dispose(); } else { p.kill(); }
if (launcher) { await launcher.shutdown(); launcher.dispose(); }
