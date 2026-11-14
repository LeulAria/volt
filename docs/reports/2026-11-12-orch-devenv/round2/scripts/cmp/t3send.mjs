// Starts one T3 Code thread (Claude Code, Haiku 5.5, full-access) with a prompt and waits for it to end.
//   node t3send.mjs <port> <token file> <folder> <prompt>
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';

const [port, tokenFile, folder, prompt] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?orchestrationProtocol=2`, { headers: { Authorization: `Bearer ${readFileSync(tokenFile, 'utf8').trim()}` } });
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let n = 0;
const pending = new Map();
let finished;
const done = new Promise(r => finished = r);
ws.addEventListener('message', e => {
	for (const m of [].concat(JSON.parse(e.data))) {
		if (m._tag === 'Ping') { ws.send(JSON.stringify({ _tag: 'Pong' })); }
		if (m._tag === 'Chunk') {
			ws.send(JSON.stringify({ _tag: 'Ack', requestId: m.requestId }));
			if (m.values.some(v => v.kind === 'event' && v.event.type === 'run.updated' && ['completed', 'failed', 'interrupted', 'cancelled'].includes(v.event.payload?.status))) { finished(); }
		}
		if (m._tag === 'Exit') { pending.get(m.requestId)?.(m.exit); }
	}
});
const call = (tag, payload) => new Promise(r => { const id = String(++n); pending.set(id, r); ws.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] })); });
let projectId = `p-${randomUUID()}`;
const created = await call('projects.mutate', { type: 'project.create', commandId: `c-${randomUUID()}`, projectId, title: 'mem', workspaceRoot: folder, createWorkspaceRootIfMissing: true });
projectId = /already belongs to project (p-[\w-]+)/.exec(JSON.stringify(created))?.[1] ?? projectId;
const threadId = `t-${randomUUID()}`;
await call('orchestration.launchThread', { commandId: `c-${randomUUID()}`, projectId, threadId, title: 'mem', modelSelection: { instanceId: 'claudeAgent', model: 'claude-haiku-5-5' }, runtimeMode: 'full-access', interactionMode: 'default', workspaceStrategy: { type: 'root' }, initialMessage: { text: prompt, attachments: [] } });
ws.send(JSON.stringify({ _tag: 'Request', id: String(++n), tag: 'orchestration.subscribeThread', payload: { threadId }, headers: [] }));
await Promise.race([done, new Promise(r => setTimeout(r, 120_000))]);
process.exit(0);
