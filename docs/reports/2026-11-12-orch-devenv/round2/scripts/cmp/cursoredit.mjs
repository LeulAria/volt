// Does cursor-agent finish a file edit inside Volt's sandbox? One ACP session through Volt's sandbox
// launcher (VoltSandboxLauncher.prepare, workspace-write, the per-chat CURSOR_CONFIG_DIR overlay),
// asked to change one word in a file. Prints how long the edit tool call took, whether it ended,
// and the sandbox's denials. Runs the transpiled out/ of a checkout (VSCODE_DEV=1 for its helper).
//   VSCODE_DEV=1 node cursoredit.mjs <checkout> [model=grok-4.7] [sandbox|direct]
import { spawn } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

const [checkout, model = 'grok-4.7', mode = 'sandbox'] = process.argv.slice(2);
const cwd = '/private/tmp/vcmp/cedit';
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, 'a.txt'), 'hello world\n');
const outDir = join(checkout, 'out');
globalThis._VSCODE_FILE_ROOT = outDir;
const hostEnv = { ...process.env };
for (const k of Object.keys(hostEnv)) { if (/^CLAUDE|^ELECTRON_RUN_AS_NODE$/.test(k)) { delete hostEnv[k]; } }
const denials = [];
let command = process.env.CURSOR_AGENT ?? `${process.env.HOME}/.local/bin/cursor-agent`, args = ['--model', model, 'acp'], env = hostEnv, extra = [], launch, launcher;
if (mode === 'sandbox') {
	const { VoltSandboxLauncher } = await import(pathToFileURL(join(outDir, 'vs/platform/voltSandbox/node/sandboxLauncher.js')).href);
	launcher = new VoltSandboxLauncher('/tmp/vcmp/sbx-ud', { info: m => /denial|denied|blocked/i.test(m) && denials.push(m.slice(0, 220)), warn: () => undefined });
	launcher.onDidDeny?.(e => denials.push(JSON.stringify(e).slice(0, 220)));
	launch = await launcher.prepare(command, args, { level: 'workspace-write', network: true, providerId: 'cursor-acp', workspaceRoots: [cwd], stateKey: `cmp-cedit-${Date.now()}` }, { hostEnv, cwd });
	({ command, args, env } = launch);
	extra = launch.extraStdio ?? [];
}
console.error("prepared", command, args.length);
const t0 = performance.now();
const p = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe', ...extra], detached: true });
if (launch) { const c = await Promise.race([launch.confirm(p), new Promise(r => setTimeout(() => r({ ok: false, error: "confirm timeout" }), 20_000))]); console.error("confirm", JSON.stringify(c).slice(0, 300)); if (!c.ok) { throw new Error(c.error); } }
let stderr = '';
p.stderr.on('data', d => stderr += d);
let buf = ''; const waits = new Map(); const tools = new Map();
const ms = () => Math.round(performance.now() - t0);
p.stdout.on('data', d => {
	buf += d; let k;
	while ((k = buf.indexOf('\n')) >= 0) {
		const line = buf.slice(0, k); buf = buf.slice(k + 1);
		let m; try { m = JSON.parse(line); } catch { continue; }
		if (m.id !== undefined && waits.has(m.id) && !m.method) { waits.get(m.id)(m); continue; }
		if (m.method === 'session/request_permission') {
			const opt = m.params.options.find(o => /^allow/.test(o.kind)) ?? m.params.options[0];
			p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }) + '\n');
			continue;
		}
		if (m.method && m.id !== undefined) { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n'); continue; }
		const u = m.params?.update;
		if (u?.sessionUpdate === 'tool_call') { tools.set(u.toolCallId, { title: u.title, start: ms() }); }
		if (u?.sessionUpdate === 'tool_call_update' && /completed|failed/.test(u.status ?? '')) { const t = tools.get(u.toolCallId); if (t) { t.end = ms(); t.status = u.status; } }
	}
});
let id = 0;
const req = (method, params, timeout = 120_000) => new Promise(r => { const i = ++id; waits.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); setTimeout(() => r({ timeout: true }), timeout); });
const init = await req('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'bench', version: '0' } }, 30_000);
console.error('init', JSON.stringify(init).slice(0, 200), ms(), stderr.slice(-600));
const s = await req('session/new', { cwd, mcpServers: [] }, 60_000);
console.error("session", JSON.stringify(s).slice(0, 200), ms());
const ready = ms();
const r = await req('session/prompt', { sessionId: s.result?.sessionId, prompt: [{ type: 'text', text: `Use your file edit tool to change "hello" to "bye" in ${cwd}/a.txt. Do nothing else, then reply DONE.` }] }, 150_000);
const result = { mode, model, ready, promptMs: ms() - ready, stop: r.result?.stopReason ?? (r.timeout ? 'TIMEOUT' : r.error?.message), file: readFileSync(join(cwd, 'a.txt'), 'utf8').trim(), tools: [...tools.values()], denials: denials.slice(0, 12), stderr: stderr.slice(-400) };
console.log(JSON.stringify(result));
try { process.kill(-p.pid, 'SIGKILL'); } catch { }
launch?.dispose?.();
await launcher?.shutdown?.();
process.exit(0);
