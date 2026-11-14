// Stand-in for Volt's MCP server in the adapter bench: answers `initialize` and `tools/list` from a snapshot of a
// real Volt session's server (same instructions, same 138 tools), so the CLI connects and lists as it does in Volt.
// Tool calls are not served.   node mcpstub.mjs <port> <snapshot.json>
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const [port = '18945', file = `${process.env.HOME}/.volt-r4/firstword/volt-mcp-snapshot.json`] = process.argv.slice(2);
const snap = JSON.parse(readFileSync(file, 'utf8'));
createServer((req, res) => {
	if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
	const chunks = [];
	req.on('data', c => chunks.push(c));
	req.on('end', () => {
		let msg;
		try { msg = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); res.end(); return; }
		if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
		const result = msg.method === 'initialize' ? snap.initialize : msg.method === 'tools/list' ? snap.tools : msg.method === 'ping' ? {} : undefined;
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(result ? { jsonrpc: '2.0', id: msg.id, result } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not served by the stub' } }));
	});
}).listen(Number(port), '127.0.0.1', () => console.log(`mcp stub on ${port}`));
