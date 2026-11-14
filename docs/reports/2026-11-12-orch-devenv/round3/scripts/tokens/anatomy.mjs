// ADEMark B2 request anatomy: split one captured /v1/messages body into segments and count each with
// POST /v1/messages/count_tokens (the live login's access token from the throwaway config dir).
//   node anatomy.mjs <body.json> [--json]
// Segments: system prompt blocks, built-in tools, MCP tools (mcp__*; deferred ones are only names), and the
// text injected into messages, cut at its headings (Volt's turn lead, <volt_workspace>, the environment,
// deferred tool list, MCP server instructions per server, agent types, skills, reminders).
import { readFileSync } from 'fs';

const file = process.argv[2];
const asJson = process.argv.includes('--json');
const body = JSON.parse(readFileSync(file, 'utf8'));
const token = JSON.parse(readFileSync(process.env.TOK_CFG_CREDS ?? '/tmp/v3-tokens/cfg/.credentials.json', 'utf8')).claudeAiOauth.accessToken;
const model = body.model;

async function count(extra) {
	const req = { model, messages: [{ role: 'user', content: 'hi' }], ...extra };
	for (let attempt = 0; attempt < 4; attempt++) {
		const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20,token-counting-2024-11-01', 'content-type': 'application/json' },
			body: JSON.stringify(req),
		});
		const json = await res.json();
		if (typeof json.input_tokens === 'number') { return json.input_tokens; }
		if (res.status === 429) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
		throw new Error(`count_tokens ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
	}
	throw new Error('count_tokens: rate limited');
}

const base = await count({});
const textTokens = async text => (await count({ messages: [{ role: 'user', content: `hi\n${text}` }] })) - base;
const rows = [];
const add = (segment, name, tokens, chars) => rows.push({ segment, name, tokens, chars });

// System prompt blocks.
for (const [i, block] of (body.system ?? []).entries()) {
	add('system', i === 0 ? 'billing header' : `block ${i}: ${block.text.slice(0, 50).replace(/\s+/g, ' ')}`, await count({ system: [{ type: 'text', text: block.text }] }) - base, block.text.length);
}

// Tools: each counted on its own (the per-request tool preamble is counted once, below).
const tools = body.tools ?? [];
const live = tools.filter(t => !t.defer_loading);
const oneTool = async t => (await count({ tools: [{ ...t, cache_control: undefined }] })) - base;
const toolRows = [];
for (const t of live) {
	toolRows.push({ segment: t.name.startsWith('mcp__') ? 'mcp-tools' : 'tools', name: t.name, tokens: await oneTool(t), chars: JSON.stringify(t).length });
}
const strip = t => { const { cache_control, ...rest } = t; return rest; };
const allBuiltin = live.filter(t => !t.name.startsWith('mcp__'));
const allMcp = live.filter(t => t.name.startsWith('mcp__'));
const builtinTotal = allBuiltin.length ? (await count({ tools: allBuiltin.map(strip) })) - base : 0;
const mcpTotal = allMcp.length ? (await count({ tools: [...allBuiltin, ...allMcp].map(strip) })) - base - builtinTotal : 0;
rows.push(...toolRows);

// Injected text in messages, cut at known headings.
const MARKERS = [
	['volt lead', /^\[Volt\]/m],
	['volt_workspace', /<volt_workspace source=/],
	['environment', /^# Environment/m],
	['deferred tool list', /^The following deferred tools/m],
	['new tools list', /^The following tools just became available/m],
	['mcp auth notice', /^The following MCP servers require authentication/m],
	['agent types', /^Available agent types/m],
	['mcp instructions', /^# MCP Server Instructions/m],
	['skills list', /^The following skills are available/m],
	['date', /^Today's date is/m],
];
function cut(text) {
	const hits = [];
	for (const [name, re] of MARKERS) {
		const m = re.exec(text);
		if (m) { hits.push([m.index, name]); }
	}
	// MCP instructions: one piece per server (## name).
	const mcp = /^# MCP Server Instructions/m.exec(text);
	if (mcp) {
		const re = /^## (.+)$/gm;
		re.lastIndex = mcp.index;
		let m;
		while ((m = re.exec(text))) {
			const stop = /^The following skills are available/m.exec(text)?.index ?? text.length;
			if (m.index > stop) { break; }
			hits.push([m.index, `mcp instructions: ${m[1]}`]);
		}
	}
	hits.sort((a, b) => a[0] - b[0]);
	if (!hits.length || hits[0][0] > 0) { hits.unshift([0, 'other']); }
	return hits.map(([at, name], i) => [name, text.slice(at, hits[i + 1]?.[0] ?? text.length)]);
}
let lastUserText;
for (const message of body.messages ?? []) {
	const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
	for (const block of blocks) {
		if (block.type === 'text') {
			const reminder = block.text.startsWith('<system-reminder>');
			const pieces = reminder ? [[`reminder: ${block.text.slice(18, 80).replace(/\s+/g, ' ').trim()}`, block.text]] : cut(block.text);
			for (const [name, text] of pieces) {
				if (!text.trim()) { continue; }
				add(`injected (${message.role})`, name, await textTokens(text), text.length);
			}
			if (message.role === 'user' && !reminder) { lastUserText = block.text; }
		} else if (block.type === 'tool_addition') {
			const def = block.tool?.definition;
			add(`injected (${message.role})`, `tool_addition ${def?.name}`, def ? (await count({ tools: [def] })) - base : 0, JSON.stringify(block).length);
		} else {
			add(`message ${message.role}`, block.type, null, JSON.stringify(block).length);
		}
	}
}

const total = await count({ system: body.system, tools: tools.map(strip), messages: body.messages, ...(body.thinking ? { thinking: body.thinking } : {}) }).catch(err => `n/a (${err.message.slice(0, 80)})`);
const params = { model, thinking: body.thinking, effort: body.output_config?.effort, max_tokens: body.max_tokens, context_management: body.context_management ? 'yes' : 'no' };
const sum = seg => rows.filter(r => r.segment.startsWith(seg)).reduce((a, r) => a + (r.tokens ?? 0), 0);
const summary = {
	file, total, params,
	system: sum('system'),
	tools: builtinTotal, toolsNamed: allBuiltin.map(t => t.name),
	mcpTools: mcpTotal, mcpNamed: allMcp.map(t => t.name), deferred: tools.filter(t => t.defer_loading).length,
	injected: sum('injected'),
	lastUserText: lastUserText?.slice(-40),
};
if (asJson) {
	console.log(JSON.stringify({ summary, rows }, null, 1));
} else {
	console.log(JSON.stringify(summary, null, 1));
	console.log('| Segment | Part | Tokens | Chars |\n|---|---|---|---|');
	for (const r of rows) { console.log(`| ${r.segment} | ${r.name} | ${r.tokens ?? ''} | ${r.chars} |`); }
}
