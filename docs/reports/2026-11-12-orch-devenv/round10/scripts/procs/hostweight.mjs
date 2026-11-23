// Footprint of the shared ACP adapter host alone while N chats stream (ADEMark's A7 replay streams), by node flags.
// The host is started as Volt's stdio service starts it (`node [flags] --input-type=module -e <host> <entry>`), each
// chat's CLI is started by this script (unsandboxed, replay server), and only the host process is weighed with
// ADEMark's sampler (phys_footprint, 4 Hz) for the window. Needs this worktree's dev build (out/) and the replay server.
//   node hostweight.mjs [chats=5] [window s=90] [variant ...]     variants: default semi1 semi2 semi4 gc
//   rows -> ../../data/procs/hostweight.jsonl
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, FOLDER, REPLAY, load, sleep } from './lib.mjs';

const [chatsArg = '5', windowArg = '90', ...variants] = process.argv.slice(2);
// Round 10: `electron` runs the host on Volt's own Node (Electron as Node) instead of the user's `node`; `fp` after a variant name
// (HOSTWEIGHT_FP=1) prints the host's footprint categories 10 s before the window ends.
const ELECTRON = process.env.HOSTWEIGHT_ELECTRON ?? `${process.env.HOME}/.volt-r8/min/r8/VOLT.app/Contents/MacOS/Electron`;
const FLAGS = { default: [], electron: [], electronsemi4: ['--max-semi-space-size=4'], semi1: ['--max-semi-space-size=1'], semi2: ['--max-semi-space-size=2'], semi4: ['--max-semi-space-size=4'], gc: ['--expose-gc'] };
const ENTRY = process.env.ADAPTER_BIN ?? execFileSync('/bin/sh', ['-c', 'command -v claude-agent-acp']).toString().trim();
const NATIVE = process.env.SPEED_NATIVE ?? `${process.env.HOME}/.volt-r3/speed/native/bin/ademark-native`;
const { acpSharedHostSource } = await import(join(process.env.SPEED_CHECKOUT ?? '/Users/leularia/Desktop/VOLT/volt-e5-weight', 'out/vs/platform/voltStdio/common/acpSharedHostSource.js'));
mkdirSync(join(DATA, 'raw'), { recursive: true });
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function run(variant) {
	const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${REPLAY}` };
	for (const k of Object.keys(env)) { if (/^(CLAUDECODE|CLAUDE_CODE_|VSCODE_|ELECTRON_RUN_AS_NODE$)/.test(k)) { delete env[k]; } }
	const onElectron = variant.startsWith('electron');
	const host = spawn(onElectron ? ELECTRON : 'node', [...FLAGS[variant], '--input-type=module', '-e', acpSharedHostSource(), ENTRY], { env: onElectron ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env, stdio: ['pipe', 'pipe', 'ignore'] });
	const send = (k, id, p) => host.stdin.write(`${k} ${id} ${p}\n`);
	const kids = new Map();
	const state = new Map();
	let buf = '';
	let chunks = 0;
	const ready = new Promise(resolve => {
		host.stdout.setEncoding('utf8').on('data', d => {
			const lines = (buf + d).split('\n'); buf = lines.pop();
			for (const line of lines) {
				const a = line.indexOf(' '), b = line.indexOf(' ', a + 1);
				const kind = line.slice(0, a), id = line.slice(a + 1, b), rest = line.slice(b + 1);
				if (kind === 'ready') { resolve(); }
				else if (kind === 'acp') {
					const m = JSON.parse(rest);
					if (m.id === 1) { send('acp', id, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: FOLDER, mcpServers: [] } })); }
					else if (m.id === 2 && m.result?.sessionId) { state.get(id).session = m.result.sessionId; state.get(id).opened(); }
					else if (m.id === 3) { state.get(id).done = true; }
					else if (m.method === 'session/update') { chunks++; }
					else if (m.method === 'session/request_permission') { send('acp', id, JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: m.params.options[0].optionId } } })); }
				}
				else if (kind === 'spawn') {
					const sp = rest.indexOf(' '); const n = rest.slice(0, sp); const req = JSON.parse(rest.slice(sp + 1));
					const e = { ...env, ...req.env }; for (const k of req.unset) { delete e[k]; }
					const child = spawn(req.command, req.args, { cwd: req.cwd, env: e, stdio: ['pipe', 'pipe', 'ignore'] });
					kids.set(id + n, child);
					send('spawned', id, `${n} ${JSON.stringify({ pid: child.pid })}`);
					child.stdout.setEncoding('utf8').on('data', x => send('out', id, `${n} ${JSON.stringify(x)}`));
					child.on('close', (code, signal) => send('exit', id, `${n} ${JSON.stringify({ code, signal })}`));
				}
				else if (kind === 'in') { const sp = rest.indexOf(' '); kids.get(id + rest.slice(0, sp))?.stdin.write(JSON.parse(rest.slice(sp + 1))); }
				else if (kind === 'end') { kids.get(id + rest)?.stdin.end(); }
				else if (kind === 'kill') { const sp = rest.indexOf(' '); kids.get(id + rest.slice(0, sp))?.kill(); }
			}
		});
	});
	await ready;
	const loadAtStart = load();
	const opened = [];
	for (let i = 1; i <= Number(chatsArg); i++) {
		const id = `c${i}`;
		opened.push(new Promise(resolve => state.set(id, { opened: resolve })));
		send('open', id, JSON.stringify({ cwd: FOLDER }));
		send('acp', id, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'hostweight', version: '0' } } }));
	}
	await Promise.all(opened);
	const rules = join(DATA, 'raw', `hostweight-rules.json`);
	writeFileSync(rules, JSON.stringify({ rootPids: [host.pid], bundlePaths: [], vendorDirs: [], agentExecutables: [], excludeNames: [] }));
	const csv = join(DATA, 'raw', `hostweight-${variant}-${Date.now()}.csv`);
	const sampler = spawn(NATIVE, ['sample', '--rules', rules, '--hz', '4', '--duration-s', windowArg, '--csv', csv], { stdio: 'ignore' });
	for (let i = 1; i <= Number(chatsArg); i++) {
		send('acp', `c${i}`, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: state.get(`c${i}`).session, prompt: [{ type: 'text', text: `replay:stream-${i}` }] } }));
		await sleep(2000);
	}
	let cats;
	if (process.env.HOSTWEIGHT_FP) { await sleep((Number(windowArg) - 10 - 2 * Number(chatsArg)) * 1000); try { cats = execFileSync('footprint', ['-p', String(host.pid)]).toString().split('\n').filter(l => /^\s*[\d.]+ [KMG]?B\s+[\d.]+ [KMG]?B/.test(l) && !/TOTAL/.test(l)).slice(0, 8).map(l => { const f = l.trim().split(/\s{2,}/); return `${f[0]} ${f.at(-1)}`; }); } catch { } }
	await new Promise(resolve => sampler.on('exit', resolve));
	const fp = readFileSync(csv, 'utf8').trim().split('\n').slice(1).map(l => l.split(',')).filter(r => Number(r[1]) === host.pid).map(r => Number(r[5]) / 1048576);
	const row = { test: 'hostweight', variant, flags: FLAGS[variant], chats: Number(chatsArg), windowS: Number(windowArg), at: new Date().toISOString(), load: loadAtStart, loadEnd: load(), ticks: fp.length, medianMiB: +q(fp, 0.5).toFixed(1), p95MiB: +q(fp, 0.95).toFixed(1), maxMiB: +Math.max(...fp).toFixed(1), updates: chunks, cats, csv };
	appendFileSync(join(DATA, 'hostweight.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify(row));
	for (const k of kids.values()) { k.kill('SIGKILL'); }
	host.stdin.end();
	host.kill('SIGKILL');
	await sleep(1500);
}
for (const variant of variants.length ? variants : ['default']) { await run(variant); }
process.exit(0);
