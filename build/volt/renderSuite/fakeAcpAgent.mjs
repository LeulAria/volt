/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A scripted Agent Client Protocol agent for reproducible render benchmarks. Add it in Volt as a
// custom ACP agent (Settings > Providers > Add custom ACP agent: command `node`, args
// `<this file>`). What it streams depends on the prompt:
//
//   <<<BEGIN>>> … <<<END>>>       echoes the text between the markers (the render-suite echo prompt)
//   bench:r01 … bench:r11         streams payloads/rNN-*.md
//   bench:t01 … bench:t03         a scripted tool run (reads, edits with diffs, a terminal, an error)
//   bench:long                    r09 four times over (~20 KB)
//   anything else                 a short markdown reply
//
// Options anywhere in the prompt: `cps=<chars per second>` (default 600), `chunk=<chars>` (mean
// chunk size, default 12), `think=<ms>` (a reasoning phase first), `burst` (network-like bursts:
// 3-8 chunks at once every ~80 ms). Session/cancel stops the stream and answers `cancelled`.
// Every run logs one line per event to $VOLT_FAKE_ACP_LOG when set.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const here = path.dirname(new URL(import.meta.url).pathname);
const payloadDir = path.join(here, '..', '..', '..', 'test', 'volt-render-suite', 'payloads');
const logFile = process.env.VOLT_FAKE_ACP_LOG;

function log(line) {
	if (logFile) {
		fs.appendFileSync(logFile, `${Date.now()} ${line}\n`);
	}
}

function send(message) {
	process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

function notify(sessionId, update) {
	send({ method: 'session/update', params: { sessionId, update } });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A small deterministic PRNG, so two runs of a scenario chunk text identically. */
function rng(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13; s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5; s >>>= 0;
		return s / 0x100000000;
	};
}

function payload(id) {
	const file = fs.readdirSync(payloadDir).find(name => name.startsWith(id + '-'));
	return file ? fs.readFileSync(path.join(payloadDir, file), 'utf8') : `No payload ${id}.`;
}

function promptText(prompt) {
	return (prompt ?? []).map(block => block.type === 'text' ? block.text : block.type === 'resource' ? (block.resource?.text ?? '') : '').join('\n');
}

function options(text) {
	const num = (name, fallback) => {
		const match = new RegExp(`\\b${name}=(\\d+)`).exec(text);
		return match ? Number(match[1]) : fallback;
	};
	return { cps: num('cps', 600), chunk: num('chunk', 12), think: num('think', 0), burst: /\bburst\b/.test(text) };
}

const sessions = new Map();
let nextSession = 1;

/** Streams `text` as agent_message_chunk (or thought) updates at the configured rate. */
async function stream(state, text, kind, opts) {
	const random = rng(text.length + 7);
	let i = 0;
	const started = Date.now();
	let sent = 0;
	while (i < text.length) {
		if (state.cancelled) {
			return false;
		}
		const pieces = opts.burst ? 3 + Math.floor(random() * 6) : 1;
		let chunk = '';
		for (let p = 0; p < pieces && i < text.length; p++) {
			const size = Math.max(1, Math.round(opts.chunk * (0.4 + random() * 1.2)));
			chunk += text.slice(i, i + size);
			i += size;
		}
		notify(state.id, { sessionUpdate: kind, content: { type: 'text', text: chunk } });
		sent += chunk.length;
		// Pace by the total sent so far, so timer drift does not slow the stream down.
		const due = started + (sent / opts.cps) * 1000;
		const wait = due - Date.now();
		if (wait > 0) {
			await sleep(wait);
		}
	}
	return true;
}

function toolCall(state, call) {
	notify(state.id, { sessionUpdate: 'tool_call', status: 'in_progress', ...call });
}

function toolDone(state, toolCallId, update) {
	notify(state.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', ...update });
}

const textContent = text => [{ type: 'content', content: { type: 'text', text } }];

async function scriptedTask(state, id, opts, cwd) {
	const read = (file, text) => ({ path: path.join(cwd, file), text });
	const users = read('src/users.ts', 'export async function loadUser(id: string) {\n  const res = await fetch(`/api/users/${id}`);\n  const body = await res.json();\n  if (!res.ok) {\n    throw new Error(body.message);\n  }\n  return body;\n}\n');
	const math = read('src/math.js', 'export function add(a, b) {\n  return a + b;\n}\n\nexport function divide(a, b) {\n  return a / b;\n}\n\nexport function average(values) {\n  return values.reduce((sum, v) => sum + v, 0) / values.length;\n}\n');
	if (!await stream(state, 'Let me look at the code first.', 'agent_thought_chunk', opts)) {
		return false;
	}
	for (const [n, file] of [users, math].entries()) {
		const callId = `read-${n}`;
		toolCall(state, { toolCallId: callId, title: `Read ${path.basename(file.path)}`, kind: 'read', locations: [{ path: file.path }], rawInput: { path: file.path } });
		await sleep(120);
		toolDone(state, callId, { content: textContent(file.text) });
	}
	toolCall(state, { toolCallId: 'grep-0', title: 'grep "loadUser"', kind: 'search', rawInput: { pattern: 'loadUser', path: cwd } });
	await sleep(150);
	toolDone(state, 'grep-0', { content: textContent('src/users.ts:1\nsrc/routes/users.ts:1\nsrc/routes/users.ts:4') });
	if (!await stream(state, 'I found the two problems. Fixing `average` and `divide` now.\n\n', 'agent_message_chunk', opts)) {
		return false;
	}
	const newMath = math.text.replace('  return a / b;', `  if (b === 0) {\n    throw new RangeError('Division by zero');\n  }\n  return a / b;`)
		.replace('  return values.reduce', '  if (values.length === 0) {\n    return 0;\n  }\n  return values.reduce');
	toolCall(state, { toolCallId: 'edit-0', title: 'Edit math.js', kind: 'edit', locations: [{ path: math.path }], rawInput: { path: math.path } });
	await sleep(200);
	toolDone(state, 'edit-0', { content: [{ type: 'diff', path: math.path, oldText: math.text, newText: newMath }] });
	const testPath = path.join(cwd, 'src/math.test.js');
	toolCall(state, { toolCallId: 'edit-1', title: 'Edit math.test.js', kind: 'edit', locations: [{ path: testPath }], rawInput: { path: testPath } });
	await sleep(150);
	toolDone(state, 'edit-1', { content: [{ type: 'diff', path: testPath, oldText: `test('average', () => assert.equal(average([1, 2, 3]), 2));\n`, newText: `test('average', () => assert.equal(average([1, 2, 3]), 2));\ntest('divide by zero throws', () => assert.throws(() => divide(1, 0), RangeError));\n` }] });
	if (id === 't02' || id === 't01') {
		toolCall(state, { toolCallId: 'term-0', title: 'npm test', kind: 'execute', rawInput: { command: 'npm test' } });
		await sleep(400);
		const output = id === 't02'
			? 'npm error Missing script: "does-not-exist"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run\n'
			: '> render-suite-fixture@1.0.0 test\n> node --test src/\n\nok add (0.4ms)\nok divide (0.1ms)\nok average (0.1ms)\nok average of empty list is 0 (0.1ms)\nok divide by zero throws (0.2ms)\ni tests 5\ni pass 5\ni fail 0\n';
		notify(state.id, { sessionUpdate: 'tool_call_update', toolCallId: 'term-0', status: id === 't02' ? 'failed' : 'completed', content: textContent(output), rawOutput: { exitCode: id === 't02' ? 1 : 0, output } });
	}
	notify(state.id, { sessionUpdate: 'plan', entries: [
		{ content: 'Make average([]) return 0', priority: 'medium', status: 'completed' },
		{ content: 'Throw on division by zero', priority: 'medium', status: 'completed' },
		{ content: 'Add a test and run it', priority: 'medium', status: 'completed' },
	] });
	return stream(state, '## Done\n\n- `average([])` now returns **0**.\n- `divide(a, 0)` throws a `RangeError`.\n- Added `divide by zero throws` to `src/math.test.js`; all 5 tests pass.\n', 'agent_message_chunk', opts);
}

async function prompt(id, params) {
	const state = sessions.get(params.sessionId);
	if (!state) {
		send({ id, error: { code: -32602, message: 'Unknown session' } });
		return;
	}
	state.cancelled = false;
	const text = promptText(params.prompt);
	const opts = options(text);
	log(`prompt ${state.id} ${JSON.stringify(text.slice(0, 80))}`);
	let ok = true;
	if (opts.think) {
		const thought = 'Thinking about the request and planning the answer. '.repeat(Math.max(1, Math.round(opts.think / 300)));
		ok = await stream(state, thought, 'agent_thought_chunk', { ...opts, cps: thought.length / (opts.think / 1000) });
	}
	const echo = /<<<BEGIN>>>\n?([\s\S]*?)\n?<<<END>>>/.exec(text);
	const bench = /\bbench:([a-z]+\d*)\b/.exec(text)?.[1];
	if (ok && echo) {
		ok = await stream(state, echo[1], 'agent_message_chunk', opts);
	} else if (ok && bench && /^t\d+$/.test(bench)) {
		ok = await scriptedTask(state, bench, opts, state.cwd);
	} else if (ok && bench === 'long') {
		ok = await stream(state, Array.from({ length: 4 }, () => payload('r09')).join('\n\n---\n\n'), 'agent_message_chunk', opts);
	} else if (ok && bench) {
		ok = await stream(state, payload(bench), 'agent_message_chunk', opts);
	} else if (ok) {
		ok = await stream(state, 'Hi! This is the **fake ACP agent**. Send `bench:r01` … `bench:r11`, `bench:t01`, or `bench:long`.', 'agent_message_chunk', opts);
	}
	log(`end ${state.id} ${ok ? 'end_turn' : 'cancelled'}`);
	send({ id, result: { stopReason: ok ? 'end_turn' : 'cancelled' } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	const { id, method, params } = message;
	switch (method) {
		case 'initialize':
			send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: false, embeddedContext: true } }, authMethods: [] } });
			return;
		case 'authenticate':
			send({ id, result: {} });
			return;
		case 'session/new':
		case 'session/resume': {
			const sessionId = method === 'session/resume' && params?.sessionId ? params.sessionId : `fake-${process.pid}-${nextSession++}`;
			sessions.set(sessionId, { id: sessionId, cwd: params?.cwd || process.cwd(), cancelled: false });
			send({ id, result: { sessionId, models: { availableModels: [{ modelId: 'fake-stream', name: 'Fake Stream' }], currentModelId: 'fake-stream' } } });
			return;
		}
		case 'session/set_model':
		case 'session/set_mode':
		case 'session/set_config_option':
			send({ id, result: {} });
			return;
		case 'session/prompt':
			void prompt(id, params);
			return;
		case 'session/cancel': {
			const state = sessions.get(params?.sessionId);
			if (state) {
				state.cancelled = true;
			}
			return;
		}
		default:
			if (id !== undefined && method) {
				send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
			}
	}
});
