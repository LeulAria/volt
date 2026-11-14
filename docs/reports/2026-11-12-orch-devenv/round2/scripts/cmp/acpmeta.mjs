// claude-agent-acp with Volt's session/new _meta (work rules, exact model, hooks): does a newer adapter take it?
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
const [bin, checkout] = process.argv.slice(2);
globalThis._VSCODE_FILE_ROOT = checkout + '/out';
const { claudeWorkRulesMeta } = await import(pathToFileURL(checkout + '/out/vs/workbench/services/voltRuntime/common/harness/claudeWorkRules.js').href);
const env = { ...process.env };
for (const k of Object.keys(env)) { if (/^CLAUDE|^ELECTRON_RUN_AS_NODE$/.test(k)) { delete env[k]; } }
const t0 = Date.now();
const p = spawn(bin, [], { cwd: '/tmp/vcmp/w/t0', env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const waits = new Map(); const updates = [];
p.stdout.on('data', d => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); try { const m = JSON.parse(line); if (m.id !== undefined && waits.has(m.id) && !m.method) { waits.get(m.id)(m); } else if (m.method === 'session/update' && m.params?.update?.sessionUpdate === 'usage_update') { updates.push(m.params.update); } else if (m.method && m.id !== undefined) { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n'); } } catch { } } });
const req = (id, method, params) => new Promise(r => { waits.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const init = await req(1, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'bench', version: '0' } });
const tInit = Date.now() - t0;
const s = await req(2, 'session/new', { cwd: '/tmp/vcmp/w/t0', mcpServers: [], _meta: claudeWorkRulesMeta('claude-haiku-5-5', { subagent: true }) });
const tNew = Date.now() - t0;
const r = await req(3, 'session/prompt', { sessionId: s.result?.sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: OK' }] });
console.log(JSON.stringify({ bin: bin.split('/').slice(-5, -3).join('/'), protocol: init.result?.protocolVersion, resume: !!init.result?.agentCapabilities?.sessionCapabilities?.resume, initMs: tInit, sessionNewMs: tNew - tInit, newError: s.error?.message, stop: r.result?.stopReason, error: r.error?.message, usage: r.result?.usage, last: updates.at(-1) && { used: updates.at(-1).used, cost: updates.at(-1).cost, model: updates.at(-1)._meta?.['_claude/model'] } }));
p.kill(); process.exit(0);
