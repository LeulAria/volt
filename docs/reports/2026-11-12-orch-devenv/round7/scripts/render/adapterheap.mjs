// V8 heap of one Claude ACP adapter process (node) at rest after one turn (adapterflags.mjs's run, with --inspect): the adapter
// started as Volt starts it (`node [flags] <npx copy of claude-agent-acp>`), `initialize`, `session/new`, one
// `replay:seed` prompt answered by the replay server, then the node process alone weighed (`footprint`, phys)
// every 5 s for 30 s. The CLI it starts is not counted (it is the same for every variant).
//   ADAPTER_HEAP=<out.heapsnapshot> node adapterheap.mjs   (summary in <out>.txt)
import { execSync, spawn } from 'child_process';
import { appendFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
import { DATA, REPLAY, load, sleep } from './lib.mjs';

const BIN = process.env.ADAPTER_BIN ?? execSync(`ls -d ${process.env.HOME}/.npm/_npx/*/node_modules/.bin/claude-agent-acp | while read b; do d=$(dirname $(dirname $b)); grep -q '"version": "0.106.0"' $d/@agentclientprotocol/claude-agent-acp/package.json 2>/dev/null && echo $b && break; done`).toString().trim();
const VARIANTS = {
	default: [],
	'semi1': ['--max-semi-space-size=1'],
	'optsize': ['--optimize-for-size'],
	'semi1+optsize': ['--max-semi-space-size=1', '--optimize-for-size'],
	'semi1+old96': ['--max-semi-space-size=1', '--max-old-space-size=96'],
	'semi2': ['--max-semi-space-size=2'],
};
const footprintMiB = pid => {
	const out = execSync(`footprint -p ${pid} 2>/dev/null || true`).toString();
	const m = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(out);
	return m ? Math.round(Number(m[1]) * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : 1) * 10) / 10 : null;
};

async function run(name, flags) {
	const cfg = mkdtempSync(join(tmpdir(), 'acpflags-'));
	const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${REPLAY}`, ANTHROPIC_API_KEY: 'sk-ant-replay', CLAUDE_CONFIG_DIR: cfg };
	for (const k of Object.keys(env)) { if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|VSCODE_|ELECTRON_RUN_AS_NODE)/.test(k)) { delete env[k]; } }
	const child = spawn('node', [...flags, BIN], { env, cwd: `${process.env.HOME}/.volt-r7/render/arena`, stdio: ['pipe', 'pipe', 'ignore'] });
	let buf = '';
	let id = 0;
	const pending = new Map();
	child.stdout.on('data', d => {
		buf += d;
		let i;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i); buf = buf.slice(i + 1);
			let m; try { m = JSON.parse(line); } catch { continue; }
			if (m.id !== undefined && pending.has(m.id) && (m.result !== undefined || m.error)) { pending.get(m.id)(m); pending.delete(m.id); }
			else if (m.id !== undefined && m.method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'session/request_permission' ? { outcome: { outcome: 'selected', optionId: 'allow' } } : {} }) + '\n'); }
		}
	});
	const req = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
	await req('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
	const s = await req('session/new', { cwd: `${process.env.HOME}/.volt-r7/render/arena`, mcpServers: [] });
	const sessionId = s.result?.sessionId;
	const t0 = Date.now();
	const p = await req('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'replay:seed' }] });
	const turnMs = Date.now() - t0;
	const samples = [];
	for (let i = 0; i < 6; i++) { await sleep(5000); samples.push(footprintMiB(child.pid)); }
	if (process.env.ADAPTER_HEAP) { execSync(`node ${join(here, 'heapsummary.mjs')} http://127.0.0.1:9339 ${process.env.ADAPTER_HEAP} 45 > ${process.env.ADAPTER_HEAP}.txt 2>&1`); }
	child.kill('SIGTERM');
	await sleep(1000);
	try { execSync(`rm -rf '${cfg}'`); } catch { }
	const row = { name, flags, at: new Date().toISOString(), load: load(), ok: !!sessionId && !p.error, stopReason: p.result?.stopReason, turnMs, samples, restMiB: samples.at(-1) };
	
	console.log(JSON.stringify(row));
}

await run('inspect', ['--inspect=127.0.0.1:9339']);
