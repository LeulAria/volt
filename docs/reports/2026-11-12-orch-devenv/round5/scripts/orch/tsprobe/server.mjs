// MCP stdio stand-in for Volt's host MCP server as a top-level chat sees it: the server instructions
// (hostMcpInstructions() from a checkout's out/, VOLT_OUT), the three always-loaded task tools with their
// real schemas and `anthropic/alwaysLoad`, and every other Volt tool by name (deferred, so Claude Code lists
// only their names). Every call is logged to TS_LOG and answered "Started task".
import { appendFileSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.VOLT_OUT;
const { hostMcpInstructions } = await import(out + '/vs/platform/voltHostMcp/common/voltHostMcp.js');
const { AGENT_TASK_TOOLS } = await import(out + '/vs/workbench/services/voltRuntime/common/orchestration/agentTasks.js');
const loaded = AGENT_TASK_TOOLS.filter(t => t.alwaysLoad).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, _meta: { 'anthropic/alwaysLoad': true } }));
const names = new Set(loaded.map(t => t.name));
const deferred = readFileSync(join(here, 'volt-deferred-tools.txt'), 'utf8').split('\n').map(s => s.trim()).filter(n => n && !names.has(n))
	.map(name => ({ name, description: `Volt ${name.replace(/_/g, ' ')}.`, inputSchema: { type: 'object', properties: {} } }));
const tools = [...loaded, ...deferred];
const instructions = hostMcpInstructions();
let n = 0;
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
	const msg = JSON.parse(line);
	if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'volt', version: '1' }, instructions } }); }
	else if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools } }); }
	else if (msg.method === 'tools/call') { appendFileSync(process.env.TS_LOG, JSON.stringify(msg.params) + '\n'); send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Started task t-00000${++n}.` }] } }); }
	else if (msg.id !== undefined) { send({ jsonrpc: '2.0', id: msg.id, result: {} }); }
});
