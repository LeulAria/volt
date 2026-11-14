// Enter-to-request timeline of Claude Code's ACP adapter outside Volt: spawns the adapter the way Volt does
// (same binary, Volt's own `initialize` and `session/new` params, recorded from a dev build), lets the session
// warm up like a pool spare, then sends `replay:hi` and times what follows against the replay server (through
// tap.mjs, which logs every request with the same wall clock). One fresh adapter and session per repetition.
//   node acpbench.mjs <label> <reps> [variant flags...]
// Variants (each removes one thing Volt sends, to see what it costs):
//   noair        initialize without the AIR (`jetbrains.air`) capability
//   nomcp        session/new without Volt's MCP server
//   nometa       session/new without `_meta` (no system prompt append, no settings hooks)
//   probe0       CLAUDE_CODE_EXECUTABLE = a wrapper that answers `auth status` from a cached file
//   debug        CLAUDE_CODE_EXECUTABLE = the debug-log wrapper (/tmp/v4-fw/claude-debug.sh)
//   trace        load adapter-trace.mjs into the adapter (ACP, spawns and CLI pipe lines with times)
//   volt         start the adapter the way Volt's after build does: `node --import <Volt's preload>` (the preload
//                comes from VOLT_CHECKOUT's out/, default the e4/firstword worktree)
//   warm=<ms>    wait before the prompt (default 8000)
// LOAD_MAX=<n>: each repetition starts only once the 1-minute load is at most n; the row records the load.
// Env: TAP_LOG (/tmp/v4-fw/tap.jsonl), TAP_PORT (18944), ADAPTER (the npx copy Volt runs), CLAUDE_CFG.
// Rows go to ../../data/firstword/acpbench.jsonl.
import { spawn, execSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const [label = 'base', repsArg = '5', ...flags] = process.argv.slice(2);
const has = f => flags.includes(f);
const warmMs = Number(flags.find(f => f.startsWith('warm='))?.slice(5) ?? 8000);
const TAP_LOG = process.env.TAP_LOG ?? '/tmp/v4-fw/tap.jsonl';
const TAP_PORT = process.env.TAP_PORT ?? '18944';
const ADAPTER = process.env.ADAPTER ?? join(homedir(), '.npm/_npx/21a32ccb11becb3a/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js');
const CFG = process.env.CLAUDE_CFG ?? join(homedir(), '.volt-r4/firstword/claude-config');
const PARAMS = process.env.ACP_PARAMS ?? join(homedir(), '.volt-r4/firstword');
const OUT = join(here, '../../data/firstword/acpbench.jsonl');
const VOLT_CHECKOUT = process.env.VOLT_CHECKOUT ?? '/Users/leularia/Desktop/VOLT/volt-e4-firstword';
let preload;
async function voltPreload() {
	preload ??= (await import(join(VOLT_CHECKOUT, 'out/vs/workbench/services/voltRuntime/common/claudeAcpPatch.js'))).acpAdapterPreload('@agentclientprotocol/claude-agent-acp@0.106.0');
	return preload;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const load = () => execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();

function tapRows(from) {
	if (!existsSync(TAP_LOG)) { return []; }
	return readFileSync(TAP_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.t >= from).sort((a, b) => a.t - b.t);
}

function client(child) {
	let id = 0;
	const pending = new Map();
	const events = [];
	let buf = '';
	child.stdout.on('data', d => {
		buf += d;
		let i;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i); buf = buf.slice(i + 1);
			if (!line.trim()) { continue; }
			let m; try { m = JSON.parse(line); } catch { continue; }
			const t = Date.now();
			if (m.id !== undefined && !m.method && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); continue; }
			if (m.id !== undefined && m.method) {
				// Requests from the agent (permissions, fs): answer so nothing stalls.
				child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'session/request_permission' ? { outcome: { outcome: 'selected', optionId: m.params?.options?.[0]?.optionId } } : {} }) + '\n');
			}
			events.push({ t, method: m.method, kind: m.params?.update?.sessionUpdate, text: m.params?.update?.content?.text });
		}
	});
	const request = (method, params) => new Promise(res => { const i = ++id; pending.set(i, m => res({ m, t: Date.now() })); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
	return { request, events };
}

async function once(rep) {
	const loadMax = Number(process.env.LOAD_MAX ?? 0);
	while (loadMax && Number(load().split(/\s+/)[0]) > loadMax) { await sleep(15_000); }
	const env = { ...process.env };
	for (const k of Object.keys(env)) { if (/^(CLAUDE|ANTHROPIC_|VSCODE_|ELECTRON_RUN_AS_NODE$)/.test(k)) { delete env[k]; } }
	Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${TAP_PORT}`, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CONFIG_DIR: CFG, CLAUDE_SECURESTORAGE_CONFIG_DIR: '', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' });
	if (has('debug')) { env.CLAUDE_CODE_EXECUTABLE = '/tmp/v4-fw/claude-debug.sh'; }
	if (has('probe0')) { env.CLAUDE_CODE_EXECUTABLE = '/tmp/v4-fw/claude-probe0.sh'; }
	const cwd = '/tmp/v4-fw/arena';
	const nodeArgs = has('trace') ? ['--import', join(here, 'adapter-trace.mjs')] : [];
	if (has('volt')) { nodeArgs.push('--import', await voltPreload()); }
	const child = spawn(process.execPath, [...nodeArgs, ADAPTER], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
	const c = client(child);
	const init = JSON.parse(readFileSync(join(PARAMS, 'volt-initialize.json'), 'utf8'));
	if (has('noair')) { delete init.clientCapabilities._meta.jetbrains; }
	const t0 = Date.now();
	await c.request('initialize', init);
	const sn = JSON.parse(readFileSync(join(PARAMS, 'volt-session-new.json'), 'utf8'));
	sn.cwd = cwd;
	if (has('nomcp')) { sn.mcpServers = []; }
	if (has('nometa')) { delete sn._meta; }
	const created = await c.request('session/new', sn);
	const sessionId = created.m.result?.sessionId;
	if (!sessionId) { child.kill(); throw new Error(`session/new failed: ${JSON.stringify(created.m).slice(0, 300)}`); }
	await c.request('session/set_config_option', { sessionId, configId: 'effort', value: 'medium' });
	const readyMs = Date.now() - t0;
	await sleep(warmMs);
	const loadAvg = load();
	// CPU time of the adapter and its Claude CLI from the prompt to the main request: a load-independent view of
	// the work on the path (wall time on this shared Mac swings with the other agents' load).
	const cli = execSync(`ps -axo pid=,ppid=,command=`).toString().split('\n').map(l => l.trim().split(/\s+/)).find(f => f[1] === String(child.pid) && /claude/.test(f.slice(2).join(' ')))?.[0];
	const cpu = () => Object.fromEntries(execSync(`ps -o pid=,time= -p ${child.pid}${cli ? ',' + cli : ''}`).toString().trim().split('\n').map(l => { const [pid, t] = l.trim().split(/\s+/); const [m, sec] = t.split(':'); return [pid === String(child.pid) ? 'adapter' : 'cli', Math.round((Number(m) * 60 + Number(sec)) * 1000)]; }));
	const cpu0 = cpu();
	const samples = [];
	const tPrompt = Date.now();
	const done = c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'replay:hi' }] });
	let settled = false;
	void done.then(() => { settled = true; });
	while (!settled && Date.now() - tPrompt < 30_000) { samples.push({ t: Date.now(), ...cpu() }); await sleep(10); }
	const result = await Promise.race([done, sleep(30_000).then(() => undefined)]);
	await sleep(1500);
	const reqs = tapRows(tPrompt - 50).filter(r => r.t <= tPrompt + 10_000);
	const main = reqs.find(r => r.path?.startsWith('/v1/messages?') && r.tools > 0);
	const firstText = c.events.find(e => e.t >= tPrompt && e.kind === 'agent_message_chunk' && e.text);
	const row = {
		label, flags, rep, at: new Date(tPrompt).toISOString(), load: loadAvg, readyMs, warmMs,
		mainReqMs: main ? main.t - tPrompt : null,
		firstTextMs: firstText ? firstText.t - tPrompt : null,
		resultMs: result ? result.t - tPrompt : null,
		mainBytes: main?.bytes ?? null,
		...(() => { const at = main ? samples.filter(x => x.t <= main.t).at(-1) : undefined; return at ? { cpuAdapterMs: at.adapter - cpu0.adapter, cpuCliMs: (at.cli ?? 0) - (cpu0.cli ?? 0) } : {}; })(),
		before: reqs.filter(r => !main || r.t <= main.t).map(r => ({ ms: r.t - tPrompt, path: r.path?.replace(/\?.*/, ''), bytes: r.bytes, tools: r.tools })),
		countTokensTotal: reqs.filter(r => r.path?.includes('count_tokens')).length,
		updatesBefore: c.events.filter(e => e.t >= tPrompt && (!firstText || e.t < firstText.t)).map(e => `${e.t - tPrompt} ${e.method ?? ''}${e.kind ? ' ' + e.kind : ''}`),
	};
	appendFileSync(OUT, JSON.stringify(row) + '\n');
	console.log(JSON.stringify({ label, rep, load: loadAvg, mainReqMs: row.mainReqMs, firstTextMs: row.firstTextMs, cpuAdapterMs: row.cpuAdapterMs, cpuCliMs: row.cpuCliMs, before: row.before.length, countTokensTotal: row.countTokensTotal }));
	child.stdin.end();
	child.kill('SIGTERM');
	await sleep(500);
	try { execSync(`pkill -P ${child.pid}`); } catch { }
	return row;
}

const rows = [];
for (let i = 0; i < Number(repsArg); i++) {
	try { rows.push(await once(i)); } catch (e) { console.log('failed', String(e)); }
}
const med = a => { const s = a.filter(x => typeof x === 'number').sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
console.log(JSON.stringify({ label, n: rows.length, mainReqMs: med(rows.map(r => r.mainReqMs)), firstTextMs: med(rows.map(r => r.firstTextMs)) }));
