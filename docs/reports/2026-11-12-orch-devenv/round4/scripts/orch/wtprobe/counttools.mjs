// count_tokens for the always-loaded task tools (Haiku 5.5), as Claude Code lists MCP tools.
// Arms: before = volt-e4-base out/ (b2db4e7f605); untyped = e4/orch out/ with `isolation` taken back out of the
// schema and named in the description again (00ede1cf0eb's shape); now = e4/orch out/ as it is.
// usage: TOK_CFG_CREDS=<.credentials.json> node counttools.mjs
import { readFileSync } from 'fs';
const token = JSON.parse(readFileSync(process.env.TOK_CFG_CREDS, 'utf8')).claudeAiOauth.accessToken;
async function count(extra) {
	for (let attempt = 0; attempt < 5; attempt++) {
		const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20,token-counting-2024-11-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'hi' }], ...extra }) });
		const json = await res.json();
		if (typeof json.input_tokens === 'number') { return json.input_tokens; }
		if (res.status === 429) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
		throw new Error(`count_tokens ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
	}
}
const anchor = { name: 'anchor', description: 'x', input_schema: { type: 'object', properties: {} } };
const base = await count({ tools: [anchor] });
const load = async root => (await import(`${root}/out/vs/workbench/services/voltRuntime/common/orchestration/agentTasks.js`)).AGENT_TASK_TOOLS
	.filter(t => t.alwaysLoad).map(t => ({ name: `mcp__volt__${t.name}`, description: t.description, input_schema: t.inputSchema }));
const now = await load('/Users/leularia/Desktop/VOLT/volt-e4-orch');
const untyped = now.map(t => {
	if (t.name !== 'mcp__volt__delegate_task') { return t; }
	const { isolation, ...properties } = t.input_schema.properties;
	return { ...t, description: t.description.replace('Also: models (2-4, same brief), ', 'Also: models (2-4, same brief), isolation:"worktree", '), input_schema: { ...t.input_schema, properties } };
});
for (const [label, tools] of [['before', await load('/Users/leularia/Desktop/VOLT/volt-e4-base')], ['untyped', untyped], ['now', now]]) {
	const each = [];
	for (const t of tools) { each.push(`${t.name.replace('mcp__volt__', '')} ${await count({ tools: [anchor, t] }) - base}`); }
	const all = await count({ tools: [anchor, ...tools] }) - base;
	console.log(JSON.stringify({ label, chars: tools.reduce((n, t) => n + JSON.stringify(t).length, 0), tokens: all, each }));
}
