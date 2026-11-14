// Spawn to `initialize` answered for Claude Code's ACP adapter, with and without Node's compile cache, interleaved,
// as Volt starts it (`node --import <Volt's preload> <adapter bin>`). Records wall time and the adapter's CPU time
// (getrusage of the child, from `ps` at the answer, 10 ms steps), so a loaded machine still shows the work saved.
//   node initbench.mjs <label> <rounds> [variants=plain,cc]
// Variants: plain (as before), cc (NODE_COMPILE_CACHE=<dir>), ccvolt (the preload enables the cache itself, from
// VOLT_CHECKOUT's out/: the after build). Rows -> ../../data/firstword/initbench.jsonl.
import { spawn, execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const [label = 'init', roundsArg = '5', variantsArg = 'plain,cc'] = process.argv.slice(2);
const R5 = join(homedir(), '.volt-r5/firstword');
const ADAPTER = process.env.ADAPTER ?? join(homedir(), '.npm/_npx/21a32ccb11becb3a/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js');
const PARAMS = join(homedir(), '.volt-r4/firstword');
const OUT = join(here, '../../data/firstword/initbench.jsonl');
const BEFORE = process.env.BEFORE_CHECKOUT ?? '/Users/leularia/Desktop/VOLT/volt-e5-base';
const AFTER = process.env.VOLT_CHECKOUT ?? '/Users/leularia/Desktop/VOLT/volt-e5-firstword';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const load = () => execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();
const preloads = {};
async function preloadOf(checkout) {
	preloads[checkout] ??= (await import(join(checkout, 'out/vs/workbench/services/voltRuntime/common/claudeAcpPatch.js'))).acpAdapterPreload('@agentclientprotocol/claude-agent-acp@0.106.0');
	return preloads[checkout];
}
const cpuMs = pid => { try { const t = execSync(`ps -o time= -p ${pid}`).toString().trim(); const [m, s] = t.split(':'); return Math.round((Number(m) * 60 + Number(s)) * 1000); } catch { return null; } };

async function once(variant, round) {
	const loadMax = Number(process.env.LOAD_MAX ?? 0);
	while (loadMax && Number(load().split(/\s+/)[0]) > loadMax) { await sleep(15_000); }
	const env = { ...process.env };
	for (const k of Object.keys(env)) { if (/^(CLAUDE|ANTHROPIC_|VSCODE_|ELECTRON_RUN_AS_NODE$|NODE_COMPILE_CACHE$)/.test(k)) { delete env[k]; } }
	env.CLAUDE_CONFIG_DIR = join(R5, 'claude-config');
	if (variant === 'cc') { mkdirSync(join(R5, 'node-cc'), { recursive: true }); env.NODE_COMPILE_CACHE = join(R5, 'node-cc'); }
	const preload = await preloadOf(variant === 'ccvolt' ? AFTER : BEFORE);
	// cc: Node writes its compile cache at a normal exit or on flushCompileCache(); Volt stops adapters with a signal,
	// so this variant flushes 2 s in (the after build's preload does the same itself).
	const flush = variant === 'cc' ? ['--import', 'data:text/javascript,' + encodeURIComponent("import m from 'node:module'; setTimeout(() => m.flushCompileCache?.(), 2000).unref();")] : [];
	const loadAvg = load();
	const t0 = Date.now();
	const child = spawn(process.execPath, [...flush, '--import', preload, ADAPTER], { cwd: join(R5, 'arena'), env, stdio: ['pipe', 'pipe', 'ignore'] });
	let buf = '';
	const answered = new Promise(res => child.stdout.on('data', d => { buf += d; if (buf.includes('"id":1')) { res(Date.now()); } }));
	child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: JSON.parse(readFileSync(join(PARAMS, 'volt-initialize.json'), 'utf8')) }) + '\n');
	const t = await Promise.race([answered, sleep(20_000).then(() => null)]);
	const cpu = cpuMs(child.pid);
	// Every variant lives 2.5 s past its answer (the cache flush), then stops the way Volt stops it.
	await sleep(2500);
	child.kill('SIGTERM');
	const row = { label, variant, round, at: new Date(t0).toISOString(), load: loadAvg, initMs: t ? t - t0 : null, cpuMs: cpu };
	appendFileSync(OUT, JSON.stringify(row) + '\n');
	console.log(JSON.stringify(row));
	await sleep(300);
	return row;
}

const variants = variantsArg.split(',');
const rows = [];
for (let r = 0; r < Number(roundsArg); r++) {
	const order = r % 2 ? [...variants].reverse() : variants;
	for (const v of order) { rows.push(await once(v, r)); }
}
const med = a => { const s = a.filter(x => typeof x === 'number').sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
for (const v of variants) {
	const vs = rows.filter(r => r.variant === v);
	console.log(JSON.stringify({ variant: v, n: vs.length, initMs: med(vs.map(r => r.initMs)), cpuMs: med(vs.map(r => r.cpuMs)) }));
}
