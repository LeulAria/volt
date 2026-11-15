// Capture proxy for the C1 rig (ADEMark Track C capture, unofficial): Claude Code processes get
// ANTHROPIC_BASE_URL=http://127.0.0.1:<port>; every request is forwarded to https://api.anthropic.com unchanged.
// One JSON line per request in <out>: start t, duration ms (t + ms is the row's end, ADEMark's t_ns), path, model,
// status, usage (SSE or JSON), and `meta`, ADEMark's reading of the body (tracks/c/agents.ts): the client session,
// whether the request carries a coding tool, whether it answers a tool, and the hash of the thread it starts.
// Bodies (no auth headers) are kept gzipped in <out>.bodies/<n>.json.gz.
//   node proxy.mjs [port] [out.jsonl]
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { CAPTURE, PROXY_PORT } from './common.mjs';

const port = Number(process.argv[2] ?? PROXY_PORT);
const out = process.argv[3] ?? CAPTURE;
const bodies = `${out}.bodies`;
mkdirSync(bodies, { recursive: true });
let seq = Date.now() * 1000;

const CODING_TOOLS = /^(bash|edit|write|multiedit|notebookedit|shell|local_shell|exec_command|apply_patch)$/i;
const NOT_AN_AGENT = [/\[SUGGESTION MODE/, /^This session is being continued from a previous conversation/];
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '').join('') : '';
const hasToolResult = c => Array.isArray(c) && c.some(b => b?.type === 'tool_result');

function sessionOf(body) {
	const user = body?.metadata?.user_id;
	if (typeof user !== 'string') { return null; }
	try { const p = JSON.parse(user); if (typeof p.session_id === 'string' && p.session_id) { return p.session_id; } } catch { }
	return /session_([0-9a-f-]{36})/.exec(user)?.[1] ?? null;
}

function metaOf(body) {
	if (!body || !Array.isArray(body.messages)) { return null; }
	const users = body.messages.filter(m => m?.role === 'user');
	const tools = Array.isArray(body.tools) ? body.tools.map(t => t?.name ?? t?.type).filter(n => typeof n === 'string') : [];
	const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map(b => b?.text ?? '').join('\n') : '';
	const startsTurn = users.length > 0 && !hasToolResult(users.at(-1).content);
	const continuation = /cc_prev_req=req_\w+/.test(system);
	const first = textOf(users[0]?.content).trim();
	const coding = tools.some(n => CODING_TOOLS.test(n));
	const starts = coding && startsTurn && !continuation && first.length > 0 && !NOT_AN_AGENT.some(p => p.test(first));
	return {
		session: sessionOf(body), coding, answersTool: !startsTurn,
		root: starts ? createHash('sha256').update(first).digest('hex').slice(0, 16) : null,
		// Rows are committed: no <system-reminder> blocks (Claude Code puts the account email there), no email at all.
		firstUser: first.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>').trim().slice(0, 160),
		firstUserHash: first ? createHash('sha256').update(first).digest('hex').slice(0, 16) : null,
		task: first.includes('You are working in the Ledger repository'),
		tools: tools.length, messages: body.messages.length, systemChars: system.length,
		effort: body.output_config?.effort ?? body.effort ?? null,
		thinking: body.thinking?.type ?? null, maxTokens: body.max_tokens ?? null,
	};
}

function usageFromSse(text) {
	const usage = { input: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0, output: 0 };
	let id = null, model = null, found = false, stop = null;
	for (const line of text.split('\n')) {
		if (!line.startsWith('data:')) { continue; }
		let event;
		try { event = JSON.parse(line.slice(5)); } catch { continue; }
		if (event.type === 'message_start') { id = event.message?.id ?? null; model = event.message?.model ?? null; }
		if (event.type === 'message_delta') { stop = event.delta?.stop_reason ?? stop; }
		const u = event.type === 'message_start' ? event.message?.usage : event.type === 'message_delta' ? event.usage : undefined;
		if (!u) { continue; }
		found = true;
		if (u.input_tokens !== undefined) { usage.input = u.input_tokens; }
		if (u.cache_creation_input_tokens !== undefined) { usage.cache_write = u.cache_creation_input_tokens; }
		if (u.cache_creation?.ephemeral_1h_input_tokens !== undefined) { usage.cache_write_1h = u.cache_creation.ephemeral_1h_input_tokens; }
		if (u.cache_read_input_tokens !== undefined) { usage.cache_read = u.cache_read_input_tokens; }
		if (u.output_tokens !== undefined) { usage.output = u.output_tokens; }
	}
	return found ? { usage, id, model, stop } : null;
}

function usageFromJson(text) {
	try {
		const body = JSON.parse(text);
		const u = body.usage;
		if (!u) { return null; }
		return { usage: { input: u.input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 }, id: body.id ?? null, model: body.model ?? null, stop: body.stop_reason ?? null };
	} catch {
		return null;
	}
}

// C5 (network cut) through the proxy, round 6: GET /__block?ms=30000 cuts the model API for that long. In-flight
// upstream responses are cut (the stream ends early) and every new request gets a connection reset, as a pf
// `block return` on the API hosts would do; after the block traffic flows again. Not ADEMark's pf anchor (that needs
// root); the report says so. GET /__block?ms=0 lifts a block early.
let blockedUntil = 0;
const inFlight = new Set();
const blocked = () => Date.now() < blockedUntil;

createServer((req, res) => {
	if (req.url.startsWith('/__block')) {
		const ms = Number(new URL(req.url, 'http://x').searchParams.get('ms') ?? 0);
		blockedUntil = Date.now() + ms;
		let cut = 0;
		if (ms > 0) {
			for (const up of inFlight) { try { up.destroy(new Error('network cut')); cut++; } catch { } }
		}
		appendFileSync(out, JSON.stringify({ n: ++seq, t: Date.now(), ms: 0, path: req.url, status: 0, block: { ms, cut } }) + '\n');
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ blockedUntil, cut }));
		return;
	}
	if (blocked()) {
		appendFileSync(out, JSON.stringify({ n: ++seq, t: Date.now(), ms: 0, method: req.method, path: req.url, status: 598, error: 'blocked: network cut' }) + '\n');
		req.socket.destroy();
		return;
	}
	const chunks = [];
	req.on('data', c => chunks.push(c));
	req.on('end', () => {
		const body = Buffer.concat(chunks);
		const n = ++seq;
		const t = Date.now();
		let json = null;
		try { json = body.length ? JSON.parse(body.toString('utf8')) : null; } catch { }
		// A capture problem must never stop the traffic: the folder is made again if it went away.
		if (json) {
			try {
				mkdirSync(bodies, { recursive: true });
				writeFileSync(`${bodies}/${n}.json.gz`, gzipSync(body));
			} catch (err) {
				console.error('body not kept', n, String(err));
			}
		}
		const headers = { ...req.headers, host: 'api.anthropic.com' };
		delete headers['accept-encoding'];
		const upstream = httpsRequest({ host: 'api.anthropic.com', port: 443, method: req.method, path: req.url, headers }, up => {
			const resChunks = [];
			res.writeHead(up.statusCode ?? 502, up.headers);
			up.on('data', c => { resChunks.push(c); res.write(c); });
			up.on('end', () => {
				inFlight.delete(upstream);
				res.end();
				const text = Buffer.concat(resChunks).toString('utf8');
				const parsed = (up.headers['content-type'] ?? '').includes('event-stream') ? usageFromSse(text) : usageFromJson(text);
				let meta = null;
				try { meta = metaOf(json); } catch { }
				const row = {
					n, t, ms: Date.now() - t, method: req.method, path: req.url, status: up.statusCode,
					model: json?.model ?? parsed?.model ?? null, ua: req.headers['user-agent'] ?? null, beta: req.headers['anthropic-beta'] ?? null,
					request_id: up.headers['request-id'] ?? null, message_id: parsed?.id ?? null, stop: parsed?.stop ?? null,
					req_bytes: body.length, usage: parsed?.usage ?? null, meta,
					// The subscription's limit state (5 h / 7 d utilization) as the API reports it, so a queue can stop
					// before a run would spend the account's last few percent.
					rl: Object.fromEntries(Object.entries(up.headers).filter(([k]) => k.startsWith('anthropic-ratelimit-unified')).map(([k, v]) => [k.slice('anthropic-ratelimit-unified-'.length), v])),
					...(up.statusCode >= 400 ? { error: text.slice(0, 400) } : {}),
				};
				try { appendFileSync(out, JSON.stringify(row) + '\n'); } catch (err) { console.error('row not kept', n, String(err)); }
			});
		});
		upstream.on('error', err => {
			inFlight.delete(upstream);
			appendFileSync(out, JSON.stringify({ n, t, ms: Date.now() - t, path: req.url, status: 599, error: String(err) }) + '\n');
			// A cut stream ends the client's socket as the network would, not with a tidy 502.
			if (/network cut/.test(String(err))) { res.destroy(); return; }
			res.writeHead(502);
			res.end();
		});
		inFlight.add(upstream);
		upstream.end(body);
	});
}).listen(port, '127.0.0.1', () => console.log(`proxy on ${port} -> ${out}`));
