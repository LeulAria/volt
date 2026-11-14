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

createServer((req, res) => {
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
					...(up.statusCode >= 400 ? { error: text.slice(0, 400) } : {}),
				};
				try { appendFileSync(out, JSON.stringify(row) + '\n'); } catch (err) { console.error('row not kept', n, String(err)); }
			});
		});
		upstream.on('error', err => {
			appendFileSync(out, JSON.stringify({ n, t, ms: Date.now() - t, path: req.url, status: 599, error: String(err) }) + '\n');
			res.writeHead(502);
			res.end();
		});
		upstream.end(body);
	});
}).listen(port, '127.0.0.1', () => console.log(`proxy on ${port} -> ${out}`));
