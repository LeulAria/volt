// Minimal MCP stdio server: one tool "probe" that logs when each call arrives.
import { appendFileSync } from 'fs';
import { createInterface } from 'readline';
const LOG = process.env.PROBE_LOG;
const readOnly = process.env.PROBE_RO === '1';
const rl = createInterface({ input: process.stdin });
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', line => {
	const m = JSON.parse(line);
	if (m.method === 'initialize') {
		send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } } });
	} else if (m.method === 'tools/list') {
		send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'probe', description: 'Start job n. Returns at once.', inputSchema: { type: 'object', properties: { n: { type: 'number' }, note: { type: 'string' } } }, ...(readOnly ? { annotations: { readOnlyHint: true } } : {}), _meta: { 'anthropic/alwaysLoad': true } }] } });
	} else if (m.method === 'tools/call') {
		appendFileSync(LOG, JSON.stringify({ at: Date.now(), n: m.params.arguments?.n }) + '\n');
		send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `started ${m.params.arguments?.n}` }] } });
	} else if (m.id !== undefined) {
		send({ jsonrpc: '2.0', id: m.id, result: {} });
	}
});
