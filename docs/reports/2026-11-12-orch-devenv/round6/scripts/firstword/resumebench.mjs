// Where a stopped chat's first prompt goes (round 5): Claude Code's ACP adapter outside Volt, spawned the way Volt
// spawns it (same npx copy, Volt's recorded `initialize` / `session/new` params, Volt's preload, the MCP stub serving
// Volt's tool list), timed phase by phase: spawn -> initialize -> session/new|session/resume -> prompt -> the turn's
// model request at the tap -> first text chunk. One fresh adapter per repetition.
//   node resumebench.mjs <label> <reps> [flags...]
// Flags:
//   resume       continue a seeded session (seeded once per run: session/new + `replay:seed`, then the adapter stops)
//   warm=<ms>    wait this long after the session is ready before the prompt (default 0: prompt at once, as a send
//                to a stopped chat does)
//   cc           NODE_COMPILE_CACHE for the adapter process (dir ~/.volt-r6/firstword/node-cc)
//   noprompt     time the setup only
//   novolt       no Volt preload (the adapter as shipped)
//   nomcp        no MCP server (Volt's host tools)
//   env:K=V      an extra environment variable for the adapter and its CLI
//   debug        the CLI with its debug log (~/.volt-r6/firstword/cli-debug) and the adapter's stderr (adapter-stderr.log)
//   nometa       session params without `_meta` (no system prompt append, no hooks, no plugins)
// LOAD_MAX=<n>: each repetition starts only once the 1-minute load is at most n; every row records the load.
// Rows go to ../../data/firstword/resumebench.jsonl.
import { spawn, execSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const [label = 'base', repsArg = '5', ...flags] = process.argv.slice(2);
const has = f => flags.includes(f);
const warmMs = Number(flags.find(f => f.startsWith('warm='))?.slice(5) ?? 0);
const R6 = join(homedir(), '.volt-r6/firstword');
const TAP_LOG = process.env.TAP_LOG ?? join(R6, 'tap.jsonl');
const TAP_PORT = process.env.TAP_PORT ?? '18974';
const STUB_PORT = process.env.STUB_PORT ?? '18975';
const ADAPTER = process.env.ADAPTER ?? join(homedir(), '.npm/_npx/21a32ccb11becb3a/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js');
const CFG = process.env.CLAUDE_CFG ?? join(R6, 'claude-config');
const PARAMS = process.env.ACP_PARAMS ?? join(homedir(), '.volt-r4/firstword');
const ARENA = process.env.ARENA ?? join(R6, 'arena');
const OUT = join(here, '../../data/firstword/resumebench.jsonl');
const VOLT_CHECKOUT = process.env.VOLT_CHECKOUT ?? '/Users/leularia/Desktop/VOLT/volt-e5-firstword';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const load = () => execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();
let preload;
async function voltPreload() {
	preload ??= (await import(join(VOLT_CHECKOUT, 'out/vs/workbench/services/voltRuntime/common/claudeAcpPatch.js'))).acpAdapterPreload('@agentclientprotocol/claude-agent-acp@0.106.0');
	return preload;
}

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
				child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'session/request_permission' ? { outcome: { outcome: 'selected', optionId: m.params?.options?.[0]?.optionId } } : {} }) + '\n');
			}
			events.push({ t, method: m.method, kind: m.params?.update?.sessionUpdate, text: m.params?.update?.content?.text });
		}
	});
	const request = (method, params) => new Promise(res => { const i = ++id; pending.set(i, m => res({ m, t: Date.now() })); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
	return { request, events };
}

function sessionParams() {
	const sn = JSON.parse(readFileSync(join(PARAMS, 'volt-session-new.json'), 'utf8'));
	sn.cwd = ARENA;
	if (has('nomcp')) { sn.mcpServers = []; }
	if (has('nometa')) { delete sn._meta; }
	// Round 6: allow=<csv> names allow rules (`mcp__volt`) the way CLAUDE_SESSION_OPTIONS does after e6/firstword,
	// which makes Volt's server one Claude Code's first command waits for (see the report).
	const allow = flags.find(f => f.startsWith('allow='))?.slice(6);
	if (allow && sn._meta?.claudeCode?.options) { sn._meta.claudeCode.options.allowedTools = allow.split(','); }
	for (const s of sn.mcpServers ?? []) { if (s.url) { s.url = s.url.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${STUB_PORT}`); } }
	return sn;
}

async function spawnAdapter() {
	const env = { ...process.env };
	for (const k of Object.keys(env)) { if (/^(CLAUDE|ANTHROPIC_|VSCODE_|ELECTRON_RUN_AS_NODE$|NODE_COMPILE_CACHE$)/.test(k)) { delete env[k]; } }
	Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${TAP_PORT}`, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CONFIG_DIR: CFG, CLAUDE_SECURESTORAGE_CONFIG_DIR: '', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' });
	for (const f of flags.filter(f => f.startsWith('env:'))) { const [k, ...v] = f.slice(4).split('='); env[k] = v.join('='); }
	if (has('debug')) { env.CLAUDE_CODE_EXECUTABLE = join(R6, 'claude-debug.sh'); }
	if (has('cc')) { mkdirSync(join(R6, 'node-cc'), { recursive: true }); env.NODE_COMPILE_CACHE = join(R6, 'node-cc'); }
	const nodeArgs = has('novolt') ? [] : ['--import', await voltPreload()];
	const t = Date.now();
	const child = spawn(process.execPath, [...nodeArgs, ADAPTER], { cwd: ARENA, env, stdio: ['pipe', 'pipe', has('debug') ? 'pipe' : 'ignore'] });
	if (has('debug')) { child.stderr.on('data', d => appendFileSync(join(R6, 'adapter-stderr.log'), d.toString().split('\n').map(l => l && `${Date.now()} ${l}`).join('\n'))); }
	return { child, c: client(child), t };
}

async function stop(child) {
	child.stdin.end();
	child.kill('SIGTERM');
	await sleep(400);
	try { execSync(`pkill -P ${child.pid}`); } catch { }
}

async function seed() {
	const { child, c } = await spawnAdapter();
	await c.request('initialize', JSON.parse(readFileSync(join(PARAMS, 'volt-initialize.json'), 'utf8')));
	const created = await c.request('session/new', sessionParams());
	const sessionId = created.m.result?.sessionId;
	if (!sessionId) { await stop(child); throw new Error(`seed session/new failed: ${JSON.stringify(created.m).slice(0, 300)}`); }
	await c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'replay:seed' }] });
	await sleep(1500);
	await stop(child);
	return sessionId;
}

async function once(rep, seeded) {
	const loadMax = Number(process.env.LOAD_MAX ?? 0);
	while (loadMax && Number(load().split(/\s+/)[0]) > loadMax) { await sleep(15_000); }
	const loadAvg = load();
	const { child, c, t: t0 } = await spawnAdapter();
	const init = await c.request('initialize', JSON.parse(readFileSync(join(PARAMS, 'volt-initialize.json'), 'utf8')));
	const sp = sessionParams();
	const session = has('resume')
		? await c.request('session/resume', { sessionId: seeded, cwd: sp.cwd, mcpServers: sp.mcpServers, _meta: sp._meta })
		: await c.request('session/new', sp);
	const sessionId = session.m.result?.sessionId ?? (has('resume') ? seeded : undefined);
	if (session.m.error || !sessionId) { await stop(child); throw new Error(`session failed: ${JSON.stringify(session.m).slice(0, 300)}`); }
	await c.request('session/set_config_option', { sessionId, configId: 'effort', value: 'medium' });
	const ready = Date.now();
	const row = { label, flags, rep, at: new Date(t0).toISOString(), load: loadAvg, initMs: init.t - t0, sessionMs: session.t - init.t, readyMs: ready - t0 };
	if (!has('noprompt')) {
		await sleep(warmMs);
		const tPrompt = Date.now();
		if (has('debug')) { appendFileSync(join(R6, 'adapter-stderr.log'), `${tPrompt} BENCH prompt sent (ready at ${ready})\n`); }
		const done = c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: has('resume') ? 'replay:seed' : 'replay:hi' }] });
		const result = await Promise.race([done, sleep(30_000).then(() => undefined)]);
		await sleep(800);
		const reqs = tapRows(tPrompt - 50).filter(r => r.t <= tPrompt + 30_000);
		const main = reqs.find(r => r.path?.startsWith('/v1/messages?') && r.tools > 0);
		const firstText = c.events.find(e => e.t >= tPrompt && e.kind === 'agent_message_chunk' && e.text);
		Object.assign(row, {
			warmMs,
			mainReqMs: main ? main.t - tPrompt : null,
			firstTextMs: firstText ? firstText.t - tPrompt : null,
			resultMs: result ? result.t - tPrompt : null,
			spawnToFirstTextMs: firstText ? firstText.t - t0 : null,
			before: reqs.filter(r => !main || r.t < main.t).map(r => ({ ms: r.t - tPrompt, path: r.path?.replace(/\?.*/, ''), bytes: r.bytes, tools: r.tools, messages: r.messages })),
			mainMessages: main?.messages ?? null,
		});
	}
	appendFileSync(OUT, JSON.stringify(row) + '\n');
	console.log(JSON.stringify({ ...row, before: row.before?.length }));
	await stop(child);
	return row;
}

const seeded = has('resume') ? await seed() : undefined;
const rows = [];
for (let i = 0; i < Number(repsArg); i++) {
	try { rows.push(await once(i, seeded)); } catch (e) { console.log('failed', String(e)); }
}
const med = a => { const s = a.filter(x => typeof x === 'number').sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
console.log(JSON.stringify({ label, n: rows.length, initMs: med(rows.map(r => r.initMs)), sessionMs: med(rows.map(r => r.sessionMs)), mainReqMs: med(rows.map(r => r.mainReqMs)), firstTextMs: med(rows.map(r => r.firstTextMs)), spawnToFirstTextMs: med(rows.map(r => r.spawnToFirstTextMs)) }));
