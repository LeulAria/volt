// Minimal stdio MCP server: instructions + three tools, for hooks-module probes.
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', line => {
	const m = JSON.parse(line);
	if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'volt', version: '1' }, instructions: 'STUB INSTRUCTIONS: use browser_act for multi-step checks.' } });
	else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: ['browser_act', 'ask_question', 'thread_list'].map(name => ({ name, description: `The ${name} tool.`, inputSchema: { type: 'object', properties: {} } })) } });
	else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
