// A minimal streamable-HTTP MCP server with one tool, `sleep`, that answers after `seconds`. It shows how long
// Claude Code waits for an MCP tool before it gives up ("The operation timed out."), with and without
// MCP_TOOL_TIMEOUT. Every call is logged with its start, end and whether the client hung up first.
//   node sleepserver.mjs <port>
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 19949);
const log = (...a) => console.log(new Date().toISOString(), ...a);

createServer((req, res) => {
	if (req.method !== 'POST') {
		res.writeHead(405).end();
		return;
	}
	const chunks = [];
	req.on('data', c => chunks.push(c));
	req.on('end', () => {
		const msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
		const reply = result => {
			res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sleep-1' });
			res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
		};
		if (msg.id === undefined) {
			res.writeHead(202).end();
			return;
		}
		if (msg.method === 'initialize') {
			reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'sleep', version: '1' } });
		} else if (msg.method === 'tools/list') {
			reply({ tools: [{ name: 'sleep', description: 'Waits the given number of seconds, then answers "slept N s".', inputSchema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] } }] });
		} else if (msg.method === 'tools/call') {
			const seconds = Number(msg.params?.arguments?.seconds ?? 90);
			const start = Date.now();
			let gone = false;
			res.on('close', () => { if (!res.writableEnded) { gone = true; log(`call ${msg.id}: client hung up after ${((Date.now() - start) / 1000).toFixed(1)} s`); } });
			log(`call ${msg.id}: sleep ${seconds} s`);
			setTimeout(() => {
				if (!gone) {
					log(`call ${msg.id}: answered after ${((Date.now() - start) / 1000).toFixed(1)} s`);
					reply({ content: [{ type: 'text', text: `slept ${seconds} s` }] });
				}
			}, seconds * 1000);
		} else {
			reply({});
		}
	});
}).listen(port, '127.0.0.1', () => log(`sleep MCP on ${port}`));
