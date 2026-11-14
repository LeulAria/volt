// Drives claude-agent-acp directly: session with the probe MCP server, optional mode switch, one prompt.
// usage: node acp.mjs <mode|-> <tag>
import { spawn } from 'child_process';
import { readFileSync, rmSync, existsSync } from 'fs';
const [mode, tag] = process.argv.slice(2);
const D = '/tmp/v4orch/mcpprobe';
const LOG = `${D}/${tag}.calls.jsonl`;
if (existsSync(LOG)) { rmSync(LOG); }
const env = { ...process.env }; delete env.CLAUDECODE; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn('/Users/leularia/.npm/_npx/21a32ccb11becb3a/node_modules/.bin/claude-agent-acp', [], { cwd: D, env, stdio: ['pipe', 'pipe', 'inherit'] });
let id = 0; const pending = new Map(); let buf = '';
const events = [];
child.stdout.on('data', d => {
	buf += d; let i;
	while ((i = buf.indexOf('\n')) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		if (!line.trim()) { continue; }
		const m = JSON.parse(line);
		if (m.id !== undefined && pending.has(m.id) && (m.result !== undefined || m.error)) { pending.get(m.id)(m); pending.delete(m.id); continue; }
		if (m.method === 'session/request_permission') {
			events.push({ at: Date.now(), ev: 'permission' });
			const opt = m.params.options.find(o => o.kind === 'allow_once') ?? m.params.options[0];
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }) + '\n');
			continue;
		}
		if (m.method === 'session/update') {
			const u = m.params.update;
			if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update' && u.status) { events.push({ at: Date.now(), ev: u.sessionUpdate + ':' + (u.status ?? '') + ':' + (u.title ?? '').slice(0, 30) }); }
		}
	}
});
const req = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const init = await req('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
const s = await req('session/new', { cwd: D, mcpServers: [{ name: 'probe', command: 'node', args: [`${D}/server.mjs`], env: [{ name: 'PROBE_LOG', value: LOG }, { name: 'PROBE_RO', value: '0' }] }] });
if (s.error) { console.log(JSON.stringify(s.error)); process.exit(1); }
const sid = s.result.sessionId;
console.log('modes', JSON.stringify(s.result.modes?.currentModeId), (s.result.modes?.availableModes ?? []).map(m => m.id).join(','), 'config', (s.result.configOptions ?? []).map(o => o.id + '=' + o.currentValue).join(','));
const m = await req('session/set_config_option', { sessionId: sid, configId: 'model', value: 'claude-haiku-5-5' });
if (m.error) { console.log('model', JSON.stringify(m.error)); }
if (mode !== '-') {
	const r = await req('session/set_config_option', { sessionId: sid, configId: 'mode', value: mode });
	console.log('set mode', JSON.stringify(r.error ?? (r.result.configOptions ?? []).find(o => o.id === 'mode')?.currentValue));
}
const t0 = Date.now();
const p = await req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'Call mcp__probe__probe three times in parallel, all in this one message, with n=1, 2 and 3; give each a note of about 60 words describing a different imaginary job. Then reply: done' }] });
const t1 = Date.now();
console.log('prompt', JSON.stringify(p.result ?? p.error).slice(0, 100));
for (const e of events) { console.log(e.at - t0, e.ev); }
console.log('calls:'); console.log(existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').map(l => { const c = JSON.parse(l); return `${c.at - t0} n=${c.n}`; }).join('\n') : 'none');
console.log('end', t1 - t0);
child.kill();
process.exit(0);
