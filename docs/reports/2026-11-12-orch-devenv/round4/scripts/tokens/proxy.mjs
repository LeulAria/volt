// Logging reverse proxy for Anthropic model requests (ADEMark Track B method, unofficial).
// Point a Claude Code process at it with ANTHROPIC_BASE_URL=http://127.0.0.1:<port>; every request is
// forwarded to https://api.anthropic.com unchanged and one JSON line per request is appended to <out>:
// time, path, model, status, usage (from the SSE stream or JSON body), request id, user agent, and the
// request body (auth headers are never written) in <out>.bodies/<n>.json.
//   node proxy.mjs <port> <out.jsonl>
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 9955);
const out = process.argv[3] ?? '/tmp/v3-tokens/capture.jsonl';
const bodies = `${out}.bodies`;
mkdirSync(bodies, { recursive: true });
let seq = 0;

function usageFromSse(text) {
	const usage = { input: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0, output: 0 };
	let id = null;
	let model = null;
	let found = false;
	for (const line of text.split('\n')) {
		if (!line.startsWith('data:')) { continue; }
		let event;
		try { event = JSON.parse(line.slice(5)); } catch { continue; }
		const u = event.type === 'message_start' ? event.message?.usage : event.type === 'message_delta' ? event.usage : undefined;
		if (event.type === 'message_start') { id = event.message?.id ?? null; model = event.message?.model ?? null; }
		if (!u) { continue; }
		found = true;
		// message_delta carries the final cumulative counts; message_start the prompt side.
		if (u.input_tokens !== undefined) { usage.input = u.input_tokens; }
		if (u.cache_creation_input_tokens !== undefined) { usage.cache_write = u.cache_creation_input_tokens; }
		if (u.cache_creation?.ephemeral_1h_input_tokens !== undefined) { usage.cache_write_1h = u.cache_creation.ephemeral_1h_input_tokens; }
		if (u.cache_read_input_tokens !== undefined) { usage.cache_read = u.cache_read_input_tokens; }
		if (u.output_tokens !== undefined) { usage.output = u.output_tokens; }
	}
	return found ? { usage, id, model } : null;
}

function usageFromJson(text) {
	try {
		const body = JSON.parse(text);
		const u = body.usage;
		if (!u) { return null; }
		return {
			usage: { input: u.input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 },
			id: body.id ?? null,
			model: body.model ?? null,
			count: u.input_tokens === undefined && body.input_tokens !== undefined ? body.input_tokens : undefined,
		};
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
		if (json) { writeFileSync(`${bodies}/${n}.json`, JSON.stringify(json)); }
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
				let countTokens;
				if (req.url.includes('count_tokens')) { try { countTokens = JSON.parse(text).input_tokens; } catch { } }
				const row = {
					n, t, ms: Date.now() - t, method: req.method, path: req.url, status: up.statusCode,
					model: json?.model ?? parsed?.model ?? null,
					ua: req.headers['user-agent'] ?? null, app: req.headers['x-app'] ?? null,
					beta: req.headers['anthropic-beta'] ?? null,
					request_id: up.headers['request-id'] ?? null, message_id: parsed?.id ?? null,
					tools: Array.isArray(json?.tools) ? json.tools.length : null,
					messages: Array.isArray(json?.messages) ? json.messages.length : null,
					req_bytes: body.length, usage: parsed?.usage ?? null,
					...(countTokens !== undefined ? { count_tokens: countTokens } : {}),
					...(up.statusCode >= 400 ? { error: text.slice(0, 400) } : {}),
				};
				appendFileSync(out, JSON.stringify(row) + '\n');
			});
		});
		upstream.on('error', err => {
			appendFileSync(out, JSON.stringify({ n, t, path: req.url, error: String(err) }) + '\n');
			res.writeHead(502);
			res.end();
		});
		upstream.end(body);
	});
}).listen(port, '127.0.0.1', () => console.log(`proxy on ${port} -> ${out}`));
