// One Haiku 5.5 prompt through a claude-agent-acp build: the cost and context size its usage_update
// reports, next to the tokens. Shows whether the adapter's bundled Claude Code knows the model.
//   node acpcost.mjs <path to claude-agent-acp bin>
import { spawn } from 'child_process';
const bin = process.argv[2];
const env = { ...process.env };
for (const k of Object.keys(env)) { if (/^CLAUDE|^ELECTRON_RUN_AS_NODE$/.test(k)) { delete env[k]; } }
const p = spawn(bin, [], { cwd: '/tmp/vcmp/w/t0', env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const waits = new Map(); const updates = [];
p.stdout.on('data', d => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); try { const m = JSON.parse(line); if (m.id !== undefined && waits.has(m.id)) { waits.get(m.id)(m); } else if (m.method === 'session/update' && m.params?.update?.sessionUpdate === 'usage_update') { updates.push(m.params.update); } else if (m.method && m.id !== undefined) { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n'); } } catch { } } });
const req = (id, method, params) => new Promise(r => { waits.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
await req(1, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'bench', version: '0' } });
const s = await req(2, 'session/new', { cwd: '/tmp/vcmp/w/t0', mcpServers: [], _meta: { claudeCode: { options: { model: 'claude-haiku-5-5' } } } });
const sessionId = s.result.sessionId;
const r = await req(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: OK' }] });
console.log(JSON.stringify({ bin: bin.split('/').slice(-4).join('/'), stop: r.result?.stopReason, error: r.error?.message, usage: r.result?.usage, updates }));
p.kill();
process.exit(0);
