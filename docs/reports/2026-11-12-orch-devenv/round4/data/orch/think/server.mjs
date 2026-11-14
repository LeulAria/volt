// MCP stdio server exposing Volt's task tools (from a checkout's out/), answering every call at once.
import { createInterface } from 'readline';
const m = await import(process.env.VOLT_OUT + '/vs/workbench/services/voltRuntime/common/orchestration/agentTasks.js');
const tools = m.AGENT_TASK_TOOLS.filter(t => t.alwaysLoad).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, _meta: { 'anthropic/alwaysLoad': true } }));
let n = 0;
const rl = createInterface({ input: process.stdin });
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
rl.on('line', line => {
	const msg = JSON.parse(line);
	if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'volt', version: '1' } } }); }
	else if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools } }); }
	else if (msg.method === 'tools/call') { send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Started task t-00000${++n}.` }] } }); }
	else if (msg.id !== undefined) { send({ jsonrpc: '2.0', id: msg.id, result: {} }); }
});
