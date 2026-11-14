// token count of code_nav / instant_grep tool definitions (as JSON, one user message, minus an empty-message baseline)
import { readFileSync } from 'fs';
const token = JSON.parse(readFileSync(process.env.HOME + '/.volt-r5/codeintel/run/cfg-clean/.credentials.json', 'utf8')).claudeAiOauth.accessToken;
async function count(text) {
	const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20,token-counting-2024-11-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: text }] }) });
	const j = await res.json(); if (typeof j.input_tokens !== 'number') throw new Error(JSON.stringify(j)); return j.input_tokens;
}
const base = await count('x');
for (const root of ['/Users/leularia/Desktop/VOLT/volt-e5-base', '/Users/leularia/Desktop/VOLT/volt-e5-codeintel']) {
	const m = await import(root + '/out/vs/workbench/services/voltRuntime/browser/tools/codeTools.js');
	const c = await import(root + '/out/vs/workbench/services/voltRuntime/common/codeIntelligence.js');
	const p = await import(root + '/out/vs/workbench/services/voltRuntime/common/harness/contextPack.js');
	const grep = c.CODE_INTELLIGENCE_TOOLS.find(t => t.name === 'instant_grep');
	const r = {
		code_nav: await count(JSON.stringify({ name: 'mcp__volt__code_nav', description: m.CODE_NAV_DESCRIPTION, input_schema: m.CODE_NAV_SCHEMA })) - base,
		instant_grep: await count(JSON.stringify({ name: 'mcp__volt__instant_grep', description: grep.description, input_schema: grep.inputSchema })) - base,
		IDE_TOOLS_GUIDE: await count(p.IDE_TOOLS_GUIDE) - base,
		CODE_QUESTIONS: await count(p.CODE_QUESTIONS) - base,
	};
	console.log(root.split('/').pop(), JSON.stringify(r));
}
