// ADEMark B2 (request anatomy) exactly as bench/tracks/b/b2-request-anatomy.ts splits and counts it:
// system = the system blocks' text joined by blank lines; tools = JSON of the non-mcp__ tools; mcp-tools =
// JSON of the mcp__ tools; injected = the first user message's text blocks minus the prompt; params = JSON of
// every body key but messages/input/system/instructions/tools. Each segment is counted alone as one user
// message with POST /v1/messages/count_tokens (the throwaway config dir's OAuth token in place of an API key).
//   node b2.mjs <body.json> [prompt=hi] [--json]   (TOK_CFG_CREDS: credentials file)
import { readFileSync } from 'fs';

const [file, prompt = 'hi'] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const body = JSON.parse(readFileSync(file, 'utf8'));
const token = JSON.parse(readFileSync(process.env.TOK_CFG_CREDS ?? `${process.env.HOME}/.volt-r4/tokens/run/cfg/.credentials.json`, 'utf8')).claudeAiOauth.accessToken;

const blockTexts = content => typeof content === 'string' ? (content ? [content] : []) : Array.isArray(content)
	? content.flatMap(p => typeof p === 'string' ? (p ? [p] : []) : (p && (!p.type || ['text', 'input_text', 'output_text'].includes(p.type)) && typeof p.text === 'string' && p.text ? [p.text] : [])) : [];
const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? blockTexts(body.system).join('\n\n') : '';
const firstUser = (body.messages ?? []).find(m => m?.role === 'user');
const injected = (() => {
	const wanted = prompt.trim();
	const parts = [];
	for (const raw of blockTexts(firstUser?.content)) {
		const t = raw.trim();
		if (!t || t === wanted) { continue; }
		if (wanted && t.endsWith(wanted)) { const rest = t.slice(0, t.length - wanted.length).trim(); if (rest) { parts.push(rest); } continue; }
		parts.push(raw);
	}
	return parts.join('\n\n');
})();
const tools = body.tools ?? [];
const mcp = tools.filter(t => t?.name?.startsWith('mcp__'));
const builtin = tools.filter(t => !t?.name?.startsWith('mcp__'));
const params = Object.fromEntries(Object.entries(body).filter(([k]) => !['messages', 'input', 'system', 'instructions', 'tools'].includes(k)));
const segments = [
	['system', system],
	['tools', builtin.length ? JSON.stringify(builtin) : ''],
	['mcp-tools', mcp.length ? JSON.stringify(mcp) : ''],
	['injected', injected],
	['params', Object.keys(params).length ? JSON.stringify(params) : ''],
];
async function count(text) {
	if (!text) { return 0; }
	for (let attempt = 0; attempt < 5; attempt++) {
		const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20,token-counting-2024-11-01', 'content-type': 'application/json' },
			body: JSON.stringify({ model: body.model, messages: [{ role: 'user', content: text }] }),
		});
		const json = await res.json();
		if (typeof json.input_tokens === 'number') { return json.input_tokens; }
		if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
		throw new Error(`count_tokens ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
	}
	throw new Error('count_tokens: gave up');
}
const out = { file, model: body.model, toolNames: builtin.map(t => t.name), mcpToolNames: mcp.map(t => t.name), paramsKeys: Object.keys(params), segments: {} };
for (const [name, text] of segments) { out.segments[name] = { tokens: await count(text), chars: text.length }; }
if (process.argv.includes('--json')) {
	console.log(JSON.stringify(out));
} else {
	for (const [name, s] of Object.entries(out.segments)) { console.log(`${name.padEnd(10)} ${String(s.tokens).padStart(6)} tokens  ${String(s.chars).padStart(7)} chars`); }
	console.log('tools:', out.toolNames.join(' '));
	console.log('mcp-tools:', out.mcpToolNames.join(' '));
	console.log('params:', out.paramsKeys.join(' '));
}
