// The T3 Code arm: drives a SEPARATE T3 Code server (the installed Nightly app's own server bundle,
// started with `serve --base-dir /tmp/vcmp/t3home --port 9981`) over its WebSocket RPC, as a host of
// Claude Code on Haiku 5.5. One run = new project + thread (full-access) with the task prompt.
// Usage: node runt3.mjs <task t0..t3> <rep>      Env: T3_PORT (9981), T3_TOKEN_FILE, CMP_DATA
// Protocol (installed bundle apps/server/dist/binCli-*.mjs): Effect RPC JSON frames on
// /ws?orchestrationProtocol=2, Bearer token; streams need an Ack per Chunk.
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildPrompt } from './runcli.mjs';
import { resetFixture, scoreT1, scoreT2, scoreT3 } from './score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CMP_DATA ?? join(here, '../../../data/orch/cmp');
const PORT = Number(process.env.T3_PORT ?? 9981);
const TOKEN = readFileSync(process.env.T3_TOKEN_FILE ?? '/tmp/vcmp/t3token.txt', 'utf8').trim();
const [task, rep] = process.argv.slice(2);

resetFixture(task);
// T3 hosts Claude Code: the prompt is the Claude Code one (native Agent subagents).
const prompt = buildPrompt('cc', task);
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?orchestrationProtocol=2`, { headers: { Authorization: `Bearer ${TOKEN}` } });
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let nextId = 0;
const pending = new Map();
const streams = new Map();
const events = [];
let t0 = 0;
ws.addEventListener('message', e => {
	const msgs = [].concat(JSON.parse(e.data));
	for (const m of msgs) {
		if (m._tag === 'Ping') {
			ws.send(JSON.stringify({ _tag: 'Pong' }));
		} else if (m._tag === 'Chunk') {
			ws.send(JSON.stringify({ _tag: 'Ack', requestId: m.requestId }));
			streams.get(m.requestId)?.(m.values);
		} else if (m._tag === 'Exit') {
			pending.get(m.requestId)?.(m.exit);
			pending.delete(m.requestId);
		}
	}
});
const call = (tag, payload) => new Promise(res => {
	const id = String(++nextId);
	pending.set(id, res);
	ws.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
});
const subscribe = (tag, payload, onValues) => {
	const id = String(++nextId);
	streams.set(id, onValues);
	ws.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
};

const cwd = `/tmp/v5orch/w/${task}`;
let projectId = `p-${randomUUID()}`;
const project = await call('projects.mutate', { type: 'project.create', commandId: `c-${randomUUID()}`, projectId, title: `${task}-${rep}`, workspaceRoot: cwd, createWorkspaceRootIfMissing: true });
// The fixture folder is the same every run: reuse the project an earlier run made for it.
const existing = /already belongs to project (p-[\w-]+)/.exec(JSON.stringify(project))?.[1];
if (existing) {
	projectId = existing;
} else if (project._tag !== 'Success') {
	console.error('project.create failed', JSON.stringify(project).slice(0, 800));
	process.exit(1);
}
const load = execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();
const threadId = `t-${randomUUID()}`;
let done;
const finished = new Promise(res => done = res);
let firstText = null;
let status = null;
let turnUsage = null;
let finalText = '';
let subagents = 0;
const onValues = values => {
	for (const v of values) {
		if (v.kind !== 'event') {
			continue;
		}
		const at = Date.now() - t0;
		const ev = v.event;
		events.push({ at, type: ev.type, payload: ev.payload });
		if (ev.type === 'message.updated' && ev.payload?.role === 'assistant' && ev.payload?.text) {
			firstText ??= at;
			finalText = ev.payload.text;
		}
		if (ev.type === 'subagent.updated' && ev.payload?.origin === 'provider_native') {
			subagents = Math.max(subagents, new Set(events.filter(x => x.type === 'subagent.updated').map(x => x.payload?.subagentId ?? x.payload?.id ?? x.payload?.nativeTaskRef)).size);
		}
		if (ev.type === 'provider-turn.updated' && ev.payload?.turnTokenUsage) {
			turnUsage = ev.payload.turnTokenUsage;
		}
		if (ev.type === 'run.updated' && ['completed', 'failed', 'interrupted', 'cancelled'].includes(ev.payload?.status)) {
			status = ev.payload.status;
			setTimeout(() => done(), 1500);
		}
	}
};
t0 = Date.now();
const launched = await call('orchestration.launchThread', {
	commandId: `c-${randomUUID()}`, projectId, threadId, title: `bench ${task} ${rep}`,
	modelSelection: { instanceId: 'claudeAgent', model: 'claude-haiku-5-5' },
	runtimeMode: 'full-access', interactionMode: 'default', workspaceStrategy: { type: 'root' },
	initialMessage: { text: prompt, attachments: [] },
});
const launchMs = Date.now() - t0;
if (launched._tag !== 'Success') {
	console.error('launchThread failed', JSON.stringify(launched).slice(0, 1500));
	process.exit(1);
}
subscribe('orchestration.subscribeThread', { threadId }, onValues);
const timer = setTimeout(() => { status = 'timeout'; done(); }, 10 * 60_000);
await finished;
clearTimeout(timer);
const wallMs = Math.max(...events.filter(e => e.type === 'run.updated').map(e => e.at));
ws.close();
// Cost and subagent tokens are not on T3's stream: read the Claude transcript of this thread's
// session (T3 runs Claude with the user's ~/.claude) and price every request id once.
let usage = turnUsage ? { input: turnUsage.inputTokens - (turnUsage.cachedInputTokens ?? 0) - (turnUsage.cacheCreationTokens ?? 0), output: turnUsage.outputTokens, cacheRead: turnUsage.cachedInputTokens ?? 0, cacheWrite: turnUsage.cacheCreationTokens ?? 0 } : {};
let transcript;
try {
	const dir = join(process.env.HOME, '.claude', 'projects', cwd.replace(/\//g, '-').replace(/^-tmp/, '-private-tmp'));
	const files = execSync(`ls -t ${dir}/*.jsonl`).toString().trim().split('\n');
	transcript = files[0];
	const reqs = new Map();
	const scan = file => {
		for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
			try {
				const x = JSON.parse(line);
				if (x.type === 'assistant' && x.message?.usage && x.requestId) {
					reqs.set(x.requestId, { model: x.message.model, u: x.message.usage });
				}
			} catch { }
		}
	};
	scan(transcript);
	const sub = transcript.replace(/\.jsonl$/, '/subagents');
	try {
		for (const f of execSync(`ls ${sub}/*.jsonl 2>/dev/null`).toString().trim().split('\n').filter(Boolean)) {
			scan(f);
		}
	} catch { }
	const all = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const { u } of reqs.values()) {
		all.input += u.input_tokens ?? 0; all.output += u.output_tokens ?? 0; all.cacheRead += u.cache_read_input_tokens ?? 0; all.cacheWrite += u.cache_creation_input_tokens ?? 0;
	}
	usage = { ...all, requests: reqs.size, models: [...new Set([...reqs.values()].map(r => r.model))] };
} catch { }
let score;
if (task === 't0') {
	score = { ok: /^\s*OK\s*\.?\s*$/.test(finalText) };
} else if (task === 't1') {
	score = scoreT1(finalText);
} else if (task === 't2') {
	score = scoreT2();
} else {
	score = scoreT3();
}
const id = `t3-${task}-${rep}`;
mkdirSync(join(DATA, 'raw'), { recursive: true });
writeFileSync(join(DATA, 'raw', `${id}.events.json`), JSON.stringify(events));
const row = { id, arm: 't3', task, rep: Number(rep), at: new Date(t0).toISOString(), load, timedOut: status === 'timeout', status, wallMs, launchMs, ttftMs: firstText, firstTextMs: firstText, subagents, usage, turnUsage, transcript, finalText: finalText.slice(0, 2000), score };
appendFileSync(join(DATA, 'runs.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify({ id, wallMs, launchMs, ttftMs: firstText, usage, subagents, score, status, load }));
process.exit(0);
