// MCP stdio server: Volt's always-loaded task tools from a checkout's out/ (VOLT_OUT), optionally with
// delegate_task patched (WT_PATCH=candidate). Logs every call to WT_LOG and answers "Started task".
import { appendFileSync } from 'fs';
import { createInterface } from 'readline';
const m = await import(process.env.VOLT_OUT + '/vs/workbench/services/voltRuntime/common/orchestration/agentTasks.js');
let tools = m.AGENT_TASK_TOOLS.filter(t => t.alwaysLoad).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
if (process.env.WT_PATCH === 'candidate') {
	tools = tools.map(t => t.name !== 'delegate_task' ? t : {
		...t,
		description: t.description.replace('isolation:"worktree", ', ''),
		inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, isolation: JSON.parse(process.env.WT_ISOLATION) } },
	});
}
tools = tools.map(t => ({ ...t, _meta: { 'anthropic/alwaysLoad': true } }));
let n = 0;
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
	const msg = JSON.parse(line);
	if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'volt', version: '1' } } }); }
	else if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools } }); }
	else if (msg.method === 'tools/call') { appendFileSync(process.env.WT_LOG, JSON.stringify(msg.params) + '\n'); send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Started task t-00000${++n}.` }] } }); }
	else if (msg.id !== undefined) { send({ jsonrpc: '2.0', id: msg.id, result: {} }); }
});
