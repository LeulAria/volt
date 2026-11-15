// Logging tap in front of the replay server (diagnosis only, never in timed A/B runs): every request the
// Claude Code CLI sends to ANTHROPIC_BASE_URL is logged with its arrival time, path, headers (auth removed)
// and body, then forwarded unchanged to the replay server.
//   node tap.mjs <listen port> <replay port> <out.jsonl>     bodies go to <out>.bodies/<n>.json
import { createServer, request } from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

const [listen = '18944', target = '18942', out = '/tmp/v4-fw/tap.jsonl'] = process.argv.slice(2);
mkdirSync(`${out}.bodies`, { recursive: true });
let seq = 0;
createServer((req, res) => {
	const t = Date.now();
	const chunks = [];
	req.on('data', c => chunks.push(c));
	req.on('end', () => {
		const body = Buffer.concat(chunks);
		const n = ++seq;
		const headers = { ...req.headers };
		for (const k of ['authorization', 'x-api-key', 'cookie']) { if (headers[k]) { headers[k] = '<redacted>'; } }
		let json = null;
		try { json = body.length ? JSON.parse(body.toString('utf8')) : null; } catch { }
		if (body.length) { writeFileSync(`${out}.bodies/${n}.json`, json ? JSON.stringify(json, null, 1) : body); }
		const up = request({ host: '127.0.0.1', port: Number(target), method: req.method, path: req.url, headers: req.headers }, r => {
			let first = 0;
			res.writeHead(r.statusCode ?? 502, r.headers);
			r.on('data', c => { first ||= Date.now(); res.write(c); });
			r.on('end', () => {
				res.end();
				appendFileSync(out, JSON.stringify({ n, t, firstByteMs: first ? first - t : null, endMs: Date.now() - t, method: req.method, path: req.url, status: r.statusCode, bytes: body.length, model: json?.model ?? null, maxTokens: json?.max_tokens ?? null, stream: json?.stream ?? null, messages: json?.messages?.length ?? null, tools: json?.tools?.length ?? null, headers }) + '\n');
			});
		});
		up.on('error', err => { res.writeHead(502); res.end(String(err)); appendFileSync(out, JSON.stringify({ n, t, error: String(err), path: req.url }) + '\n'); });
		up.end(body);
	});
}).listen(Number(listen), '127.0.0.1', () => console.log(`tap on ${listen} -> ${target}, log ${out}`));
