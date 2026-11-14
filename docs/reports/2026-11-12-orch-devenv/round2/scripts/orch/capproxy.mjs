// Logging proxy for Anthropic API requests: node capproxy.mjs <port> <outDir>
// Point Claude Code at it with ANTHROPIC_BASE_URL=http://127.0.0.1:<port>. Every /v1/messages body
// is saved as <outDir>/<n>-<ts>.req.json, its usage (from the SSE stream) as .usage.json.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
const [port, out] = [+process.argv[2], process.argv[3]];
fs.mkdirSync(out, { recursive: true });
let n = 0;
http.createServer((req, res) => {
	const chunks = [];
	req.on('data', c => chunks.push(c));
	req.on('end', () => {
		const body = Buffer.concat(chunks);
		const k = `${String(++n).padStart(4, '0')}-${Date.now()}`;
		const isMsg = req.url.startsWith('/v1/messages') && !req.url.includes('count_tokens');
		if (isMsg) { fs.writeFileSync(`${out}/${k}.req.json`, body); }
		const headers = { ...req.headers, host: 'api.anthropic.com' };
		delete headers['accept-encoding'];
		const up = https.request({ host: 'api.anthropic.com', port: 443, path: req.url, method: req.method, headers }, upRes => {
			res.writeHead(upRes.statusCode, upRes.headers);
			let text = '';
			upRes.on('data', c => { res.write(c); if (isMsg && text.length < 2e6) { text += c; } });
			upRes.on('end', () => {
				res.end();
				if (isMsg) {
					const usage = [...text.matchAll(/"usage":\s*(\{[^}]*\})/g)].map(m => { try { return JSON.parse(m[1]); } catch { return m[1]; } });
					fs.writeFileSync(`${out}/${k}.usage.json`, JSON.stringify({ status: upRes.statusCode, url: req.url, usage }));
				}
			});
		});
		up.on('error', e => { res.writeHead(502); res.end(String(e)); });
		up.end(body);
	});
}).listen(port, '127.0.0.1', () => console.log('proxy on', port, '->', out));
