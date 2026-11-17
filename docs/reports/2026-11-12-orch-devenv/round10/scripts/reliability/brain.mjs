// A scripted model ("brain") for ADEMark's reliability tests C2-C6, so they run without a live model turn.
// It speaks the Anthropic Messages API (SSE, ADEMark's replay pacing: 16 characters every 50 ms) and plays each C
// task with real tool calls (Read, Write, Bash) that the app's own Claude Code executes in the arena.
// Unlike ADEMark's replay server (turn = number of assistant messages), the next step is derived from the request:
// which steps have a successful tool result, and which follow-up messages are in the conversation. So it
//   - applies a C2 follow-up only when its text really reached the model (delivered -> applied),
//   - carries on after a resume (C4-C6) only when the resumed request still holds the conversation,
//   - redoes a step whose tool call was interrupted.
// It is also the capture (every request logged, bodies saved) and the per-instance network fault for C5:
//   POST /_ctl/cut {"seconds":30,"mode":"drop"|"reset"}   drop: in-flight streams freeze and new requests wait
//                                                         (packets dropped, as pf does); reset: sockets are
//                                                         destroyed and new ones refused (no route / Wi-Fi off)
//   GET  /_ctl/state                                      phase per task (streaming / tool), requests, cut state
//   POST /_ctl/config {"pad":3200,"sleep":6}             filler characters before each step, seconds per Bash step
//   node brain.mjs --port 18999 --out <dir>
import { createServer } from 'http';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { apiTs, serverTs, PAGINATE_FIXED, RATE_LIMITER, CURSOR_TEST } from './solutions.mjs';

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const PORT = Number(arg('--port', 18999));
const OUT = arg('--out', join(process.env.HOME, '.volt-r10/reliability/capture'));
mkdirSync(join(OUT, 'bodies'), { recursive: true });
const LOG = join(OUT, 'capture.jsonl');

const config = { pad: Number(arg('--pad', 3200)), sleep: Number(arg('--sleep', 6)) };
const CHUNK = 16;
const TICK_MS = 50;

let cut = null; // { until, mode }
const sockets = new Set();
const waiters = new Set();
const state = { requests: 0, taskRequests: 0, last: null, phase: {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cutActive = () => cut !== null && Date.now() < cut.until;
/** While a "drop" cut is on nothing is written: the bytes wait, as they would behind a packet filter. */
async function gate() {
	while (cutActive() && cut.mode === 'drop') {
		await new Promise(r => { waiters.add(r); setTimeout(() => { waiters.delete(r); r(); }, 250); });
	}
}

// ---------- the tasks ----------

const FOLLOWUPS = [
	{ id: 'C2-F1', mark: 'RATE_LIMIT_RPS' },
	{ id: 'C2-F2', mark: 'x-request-id' },
	{ id: 'C2-F3', mark: 'dueOn' },
];

/** User text of the conversation (text blocks only: never tool results, which echo file contents). */
function userTexts(messages) {
	const out = [];
	for (const m of messages ?? []) {
		if (m.role !== 'user') { continue; }
		if (typeof m.content === 'string') { out.push(m.content); continue; }
		for (const b of m.content ?? []) { if (b.type === 'text') { out.push(b.text); } }
	}
	return out;
}

function taskOf(body) {
	const tools = new Set((body.tools ?? []).map(t => t.name));
	if (!tools.has('Bash') || !tools.has('Write') || !tools.has('Read')) { return null; }
	const text = userTexts(body.messages).join('\n');
	if (text.includes('replace page-number pagination with cursor pagination')) { return 'W3'; }
	if (text.includes('In the Ledger repository, add rate limiting.')) { return 'C2'; }
	if (text.includes('brain:orch')) { return 'ORCH'; }
	if (text.includes('brain:slow')) { return 'SLOW'; }
	return null;
}

function cwdOf(body) {
	const hay = JSON.stringify(body.system ?? '') + JSON.stringify(body.messages?.[0] ?? '');
	const m = /Primary working directory: ([^\\\n"]+)/.exec(hay) ?? /Working directory: ([^\\\n"]+)/.exec(hay) ?? /<cwd>([^<]+)<\/cwd>/.exec(hay);
	return m?.[1]?.trim() ?? null;
}

const bash = (id, why, command) => ({ id, why, calls: () => [{ name: 'Bash', input: { command: `sleep ${config.sleep}; ${command}`, description: why } }] });
const read = (id, why, file) => ({ id, why, calls: cwd => [{ name: 'Read', input: { file_path: `${cwd}/${file}` } }] });
/** A second attempt reads the file first: after a resume Claude Code may no longer hold the file as read. */
const write = (id, why, file, content) => ({ id, why, calls: (cwd, attempt) => [
	...(attempt > 1 ? [{ name: 'Read', input: { file_path: `${cwd}/${file}` }, optional: true }] : []),
	{ name: 'Write', input: { file_path: `${cwd}/${file}`, content: content() } },
] });

function stepsFor(task, texts, toolNames = []) {
	if (task === 'W3') {
		return [
			read('agents', 'Reading the repository rules first.', 'AGENTS.md'),
			read('paginate', 'Looking at the current pagination helper.', 'src/paginate.ts'),
			read('api', 'Looking at how GET /invoices uses it.', 'src/api.ts'),
			read('invoices', 'Checking the invoice shape and ids.', 'src/invoices.ts'),
			bash('baseline', 'Run the tests before changing anything', 'npm test 2>&1 | tail -6; true'),
			write('w-paginate', 'Fixing paginate(): a page has at most pageSize items and hasNext is false on the last page.', 'src/paginate.ts', () => PAGINATE_FIXED),
			bash('check-paginate', 'Check the paginate fix', 'node -e "import(\'./src/paginate.ts\').then(m => console.log(JSON.stringify(m.paginate([1,2,3,4,5], 2, 2))))"; true'),
			write('w-api', 'Replacing page numbers with an opaque cursor in GET /invoices.', 'src/api.ts', () => apiTs({ cursor: true })),
			write('w-test', 'Adding a test that walks every page by cursor.', 'test/cursor.test.ts', () => CURSOR_TEST),
			bash('final-test', 'Run the tests', 'npm test 2>&1 | tail -8; true'),
		];
	}
	if (task === 'C2') {
		const has = Object.fromEntries(FOLLOWUPS.map(f => [f.id, texts.some(t => t.includes(f.mark) && t.includes('Also:'))]));
		const api = () => apiTs({ limit: true, reqId: has['C2-F2'], dueOn: has['C2-F3'] });
		const server = () => serverTs({ rps: has['C2-F1'] });
		const steps = [
			read('agents', 'Reading the repository rules first.', 'AGENTS.md'),
			read('api', 'Looking at createApp and AppOptions.', 'src/api.ts'),
			read('server', 'Looking at how the server builds the app.', 'src/server.ts'),
			bash('baseline', 'Run the tests before changing anything', 'npm test 2>&1 | tail -6; true'),
			write('w-limiter', 'Writing the token bucket per key.', 'src/rate-limiter.ts', () => RATE_LIMITER),
			bash('check-limiter', 'Check the limiter on its own', 'node -e "import(\'./src/rate-limiter.ts\').then(m => { const l = m.createRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => 0 }); console.log(JSON.stringify([l.take(\'a\'), l.take(\'a\'), l.take(\'a\')])); })"; true'),
			write('w-api', 'Wiring the limiter into createApp: every request except GET /health takes one token.', 'src/api.ts', api),
			write('w-server', 'Turning rate limiting on in the server: capacity 60, one token per second.', 'src/server.ts', server),
			bash('test-1', 'Run the tests', 'npm test 2>&1 | tail -8; true'),
		];
		if (has['C2-F1']) {
			steps.push(write('f1-server', 'Follow-up: RATE_LIMIT_RPS sets capacity and refill when it is a positive integer.', 'src/server.ts', server));
			steps.push(bash('f1-test', 'Check the server still starts', 'npm test 2>&1 | tail -4; true'));
		}
		if (has['C2-F2']) {
			steps.push(write('f2-api', 'Follow-up: every response gets x-request-id (the request\'s, or a random UUID).', 'src/api.ts', api));
			steps.push(bash('f2-test', 'Run the tests', 'npm test 2>&1 | tail -4; true'));
		}
		if (has['C2-F3']) {
			steps.push(write('f3-api', 'Follow-up: the summaries get dueOn, and due stays as a deprecated alias.', 'src/api.ts', api));
			steps.push(bash('f3-test', 'Run the tests', 'npm test 2>&1 | tail -4; true'));
		}
		return steps;
	}
	if (task === 'ORCH') {
		// A lead that hands two slow tasks to Volt's subagents and waits for their reports (the variants: a
		// subagent's CLI killed mid-tool-call, the app quit with a queued message and running subagents).
		const n = Number(/brain:orch (\d+)/.exec(texts.join('\n'))?.[1] ?? 8);
		const tool = name => (id, why, input) => ({ id, why, calls: () => [{ name, input }] });
		const delegate = tool(toolNames.find(t => /delegate_task$/.test(t)) ?? 'mcp__volt__delegate_task');
		const wait = tool(toolNames.find(t => /wait_tasks$/.test(t)) ?? 'mcp__volt__wait_tasks');
		return [
			delegate('delegate-a', 'Handing the first slow task to a subagent.', { title: 'Worker A', task: `brain:slow ${n} worker A. Run the slow steps one after another and report when they are done.`, wait: false }),
			delegate('delegate-b', 'Handing the second slow task to a subagent.', { title: 'Worker B', task: `brain:slow ${n} worker B. Run the slow steps one after another and report when they are done.`, wait: false }),
			wait('wait', 'Waiting for both reports.', {}),
		];
	}
	// SLOW: a turn that only streams and sleeps, for the variants (two windows, quit with a queued message).
	const n = Number(/brain:slow (\d+)/.exec(texts.join('\n'))?.[1] ?? 6);
	return Array.from({ length: n }, (_, i) => bash(`slow${i + 1}`, `Slow step ${i + 1} of ${n}`, `echo slow-step-${i + 1} >> slow-${/worker ([AB])/.exec(texts.join('\n'))?.[1] ?? 'X'}.log`));
}

/** Per step: attempts made, and whether one of them has a successful result. */
function progress(messages, prefix) {
	const uses = new Map(); // tool_use id -> { step, optional }
	const done = new Set();
	const attempts = new Map();
	for (const m of messages ?? []) {
		if (!Array.isArray(m.content)) { continue; }
		for (const b of m.content) {
			if (m.role === 'assistant' && b.type === 'tool_use' && b.id.startsWith(prefix)) {
				const match = /^.*?_s_(.+)_a(\d+)(o?)$/.exec(b.id);
				if (match) {
					uses.set(b.id, { step: match[1], optional: match[3] === 'o' });
					attempts.set(match[1], Math.max(attempts.get(match[1]) ?? 0, Number(match[2])));
				}
			} else if (m.role === 'user' && b.type === 'tool_result' && uses.has(b.tool_use_id)) {
				const use = uses.get(b.tool_use_id);
				if (!b.is_error && !use.optional) { done.add(use.step); }
			}
		}
	}
	return { done, attempts };
}

function filler(why, index) {
	const sentences = [
		'I will keep the change small and follow the rules in AGENTS.md: no new dependencies, local imports with the .ts extension, and import type for types.',
		'The existing tests in test/ stay as they are; I only add files next to them.',
		'Before writing I check what the current code does, so the change matches its style and its error shapes.',
		'Each step is verified with the test runner before I move on to the next one.',
		'The response shapes are part of the contract, so I keep field names and status codes exactly as the task states them.',
		'Ledger runs TypeScript natively on Node, so there is no build step to keep in mind.',
	];
	let text = `${why}\n\n`;
	for (let i = 0; text.length < config.pad; i++) { text += sentences[(index + i) % sentences.length] + ' '; }
	return text.trimEnd() + '\n';
}

/** The assistant turn for this request: content blocks and the stop reason. */
function plan(body) {
	const task = taskOf(body);
	if (task === null) { return { task: null, blocks: [{ type: 'text', text: 'ok' }], stop: 'end_turn' }; }
	const texts = userTexts(body.messages);
	const cwd = cwdOf(body) ?? process.env.BRAIN_CWD ?? '.';
	const prefix = `toolu_${task.toLowerCase()}`;
	const steps = stepsFor(task, texts, (body.tools ?? []).map(t => t.name));
	const { done, attempts } = progress(body.messages, prefix);
	const index = steps.findIndex(s => !done.has(s.id));
	if (index < 0) {
		const followups = task === 'C2' ? FOLLOWUPS.filter(f => texts.some(t => t.includes(f.mark) && t.includes('Also:'))).map(f => f.id) : [];
		const worker = /worker ([AB])/.exec(texts.join('\n'))?.[1] ?? 'X';
		const results = JSON.stringify((body.messages ?? []).flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result') : [])) + texts.join('\n');
		const extra = task === 'SLOW' ? ` SLOW-DONE-${worker}` : task === 'ORCH' ? ` ORCH-DONE reports seen: ${['A', 'B'].filter(w => results.includes(`SLOW-DONE-${w}`)).join(',') || 'none'}.` : '';
		const queued = texts.some(t => t.includes('QUEUED-OK')) ? '\n\nQUEUED-OK' : '';
		const text = `Done.${extra} ${task === 'W3' ? 'GET /invoices now uses cursor pagination and paginate() is fixed.' : task === 'C2' ? `Rate limiting is in place${followups.length ? `, with the follow-ups applied (${followups.join(', ')})` : ''}.` : 'The slow steps finished.'} The tests ran.${queued}\n\nledger-ok`;
		return { task, step: 'final', blocks: [{ type: 'text', text }], stop: 'end_turn' };
	}
	const step = steps[index];
	const attempt = (attempts.get(step.id) ?? 0) + 1;
	if (attempt > 5) {
		return { task, step: `${step.id}:gave-up`, blocks: [{ type: 'text', text: `I could not complete the step "${step.id}" after 5 attempts.\n\nledger-ok` }], stop: 'end_turn' };
	}
	const blocks = [{ type: 'text', text: filler(step.why, index) }];
	for (const call of step.calls(cwd, attempt)) {
		blocks.push({ type: 'tool_use', id: `${prefix}_s_${step.id}_a${attempt}${call.optional ? 'o' : ''}`, name: call.name, input: call.input });
	}
	return { task, step: step.id, attempt, blocks, stop: 'tool_use' };
}

// ---------- the wire ----------

function chunks(text) {
	const out = [];
	for (let i = 0; i < text.length; i += CHUNK) { out.push(text.slice(i, i + CHUNK)); }
	return out.length ? out : [''];
}

async function stream(res, body, turn, entry) {
	const write = async (event, data) => {
		await gate();
		if (res.destroyed) { throw new Error('client gone'); }
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};
	const id = `msg_brain_${String(state.requests).padStart(5, '0')}`;
	const usage = { input_tokens: Math.ceil(entry.bytes / 4), output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
	res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'request-id': id });
	await write('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
	let out = 0;
	let first = true;
	for (const [index, block] of turn.blocks.entries()) {
		const start = block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} };
		await write('content_block_start', { type: 'content_block_start', index, content_block: start });
		const parts = chunks(block.type === 'text' ? block.text : JSON.stringify(block.input));
		for (const part of parts) {
			if (!first) { await sleep(TICK_MS); }
			first = false;
			out += part.length;
			await write('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: part } : { type: 'input_json_delta', partial_json: part } });
		}
		await write('content_block_stop', { type: 'content_block_stop', index });
	}
	await write('message_delta', { type: 'message_delta', delta: { stop_reason: turn.stop, stop_sequence: null }, usage: { output_tokens: Math.ceil(out / 4) } });
	await write('message_stop', { type: 'message_stop' });
	res.end();
}

function log(entry) {
	appendFileSync(LOG, JSON.stringify(entry) + '\n');
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	let raw = '';
	for await (const part of req) { raw += part; }
	if (url.pathname.startsWith('/_ctl/') || url.pathname === '/_ademark/health') {
		let body = {};
		try { body = raw ? JSON.parse(raw) : {}; } catch { }
		if (url.pathname === '/_ctl/cut') {
			cut = { until: Date.now() + (body.seconds ?? 30) * 1000, mode: body.mode ?? 'drop', at: Date.now() };
			log({ t: Date.now(), ctl: 'cut', ...cut });
			if (cut.mode === 'reset') { for (const s of sockets) { if (s !== req.socket) { s.destroy(); } } }
		} else if (url.pathname === '/_ctl/config') {
			Object.assign(config, body);
		} else if (url.pathname === '/_ctl/mark') {
			log({ t: Date.now(), ctl: 'mark', ...body });
		}
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ ok: true, ...state, config, cut: cutActive() ? { mode: cut.mode, leftMs: cut.until - Date.now() } : null }));
		return;
	}
	if (cutActive() && cut.mode === 'reset') { req.socket.destroy(); return; }
	await gate();
	if (req.method !== 'POST') { res.writeHead(404).end('{}'); return; }
	let body = {};
	try { body = JSON.parse(raw); } catch { }
	if (url.pathname.endsWith('/count_tokens')) {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) }));
		return;
	}
	if (!url.pathname.endsWith('/v1/messages')) { res.writeHead(404, { 'content-type': 'application/json' }).end('{}'); return; }
	const n = ++state.requests;
	const turn = plan(body);
	const bodyFile = `bodies/${String(n).padStart(4, '0')}.json`;
	if (turn.task) { writeFileSync(join(OUT, bodyFile), raw); state.taskRequests++; }
	const texts = userTexts(body.messages);
	const key = turn.task === 'SLOW' ? `SLOW-${/worker ([AB])/.exec(texts.join('\n'))?.[1] ?? 'X'}` : turn.task;
	const entry = { key, t: Date.now(), n, path: url.pathname, model: body.model, bytes: raw.length, messages: body.messages?.length ?? 0, task: turn.task, step: turn.step ?? null, attempt: turn.attempt ?? null, body_file: turn.task ? bodyFile : null, cwd: cwdOf(body), lastUser: texts.at(-1)?.slice(0, 160) ?? null, session: req.headers['x-claude-code-session-id'] ?? null, ua: req.headers['user-agent'] ?? null };
	state.last = { n, task: turn.task, step: entry.step, t: entry.t };
	// A line when the request arrives too: the answer's line is written only when its stream ends.
	if (turn.task) { log({ start: true, t: entry.t, n, task: turn.task, key, step: entry.step }); }
	if (turn.task) { state.phase[key] = { step: entry.step, phase: 'streaming', n, since: Date.now() }; }
	try {
		if (body.stream) {
			await stream(res, body, turn, entry);
		} else {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ id: `msg_brain_${n}`, type: 'message', role: 'assistant', model: body.model, content: turn.blocks, stop_reason: turn.stop, stop_sequence: null, usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 10 } }));
		}
		entry.status = 200;
		if (turn.task && state.phase[key]?.n === n) { state.phase[key] = { step: entry.step, phase: turn.stop === 'tool_use' ? 'tool' : 'ended', n, since: Date.now() }; }
	} catch (error) {
		entry.status = 0;
		entry.aborted = String(error?.message ?? error);
		if (turn.task && state.phase[key]?.n === n) { state.phase[key] = { step: entry.step, phase: 'aborted', n, since: Date.now() }; }
	}
	entry.ms = Date.now() - entry.t;
	log(entry);
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); if (cutActive() && cut.mode === 'reset') { socket.destroy(); } });
server.listen(PORT, '127.0.0.1', () => console.log(`brain on 127.0.0.1:${PORT}, capture ${LOG}`));
