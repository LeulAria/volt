// Prompt breakdown of one captured request: node breakdown.mjs <n-ts.req.json> [--json]
// Sizes are characters of each part's JSON; tokens are those characters scaled by the request's
// real token count (usage from the paired .usage.json), so the parts add up to the billed prompt.
import fs from 'node:fs';
const file = process.argv[2];
const req = JSON.parse(fs.readFileSync(file, 'utf8'));
let usage;
try { const raw = JSON.parse(fs.readFileSync(file.replace('.req.json', '.usage.json'), 'utf8')).usage; usage = raw.map(u => typeof u === 'string' ? JSON.parse(u.replace(/,"cache_creation":\{.*$/, '}').replace(/,"output_tokens_details":\{.*$/, '}')) : u).find(u => u && 'input_tokens' in u); } catch { }
const total = usage ? (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) : undefined;
const parts = [];
const add = (group, name, v) => parts.push({ group, name, chars: typeof v === 'string' ? v.length : JSON.stringify(v).length });
const sys = Array.isArray(req.system) ? req.system : [{ text: req.system || '' }];
sys.forEach((b, i) => add('system', `system[${i}] ${(b.text || '').slice(0, 60).replace(/\n/g, ' ')}`, b.text || ''));
for (const t of req.tools || []) {
	const g = t.defer_loading ? 'tools (deferred stub)' : t.name.startsWith('mcp__volt__') ? 'tools: volt MCP' : t.name.startsWith('mcp__claude_ai') ? 'tools: claude.ai connectors' : t.name.startsWith('mcp__') ? 'tools: other MCP' : 'tools: built-in';
	add(g, t.name, t);
}
// Claude Code 2.1.3xx sends its session context as one system-role message; split it by section.
function sections(text) {
	const marks = [
		[/^# Environment/m, 'env + model'],
		[/^The following tools just became available/m, 'tools now available (names)'],
		[/^The following deferred tools are now available/m, 'deferred tool names'],
		[/^The following MCP servers require authentication/m, 'MCP servers needing auth'],
		[/^Available agent types for the Agent tool/m, 'agent type listing'],
		[/^# MCP Server Instructions/m, 'MCP server instructions'],
		[/^The following skills are available/m, 'skill listing'],
		[/^# (claudeMd|Memory|Plan mode)/m, 'memory / plan'],
	];
	const hits = marks.map(([re, name]) => { const m = re.exec(text); return m ? { at: m.index, name } : undefined; }).filter(Boolean).sort((a, b) => a.at - b.at);
	if (!hits.length || hits[0].at > 0) { hits.unshift({ at: 0, name: 'head' }); }
	return hits.map((h, i) => ({ name: h.name, text: text.slice(h.at, hits[i + 1]?.at ?? text.length) }));
}
function mcpServers(text) {
	return text.split(/^## /m).slice(1).map(chunk => ({ name: 'MCP instructions: ' + chunk.split('\n')[0], text: chunk }));
}
const msgs = req.messages || [];
msgs.forEach((m, i) => {
	const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
	for (const b of blocks) {
		if (b.type === 'tool_addition') { const name = b.tool?.definition?.name ?? '?'; add(name.startsWith('mcp__claude_ai') ? 'tools: claude.ai connectors (loaded)' : name.startsWith('mcp__volt__') ? 'tools: volt MCP (loaded)' : 'tools: loaded', name, b); continue; }
		if (m.role === 'system' && b.type === 'text') {
			for (const sec of sections(b.text)) {
				if (sec.name === 'MCP server instructions') { for (const srv of mcpServers(sec.text)) { add('session context', srv.name, srv.text); } }
				else { add('session context', sec.name, sec.text); }
			}
			continue;
		}
		const text = b.text ?? JSON.stringify(b);
		let label = 'user text';
		const tag = /^<(system-reminder|[a-z_-]+)>\s*([\s\S]{0,80})/.exec(text);
		if (/^<system-reminder>/.test(text)) {
			const head = text.slice(17, 140).replace(/\s+/g, ' ');
			label = /skills are available|following skills/i.test(text) ? 'reminder: skill listing'
				: /deferred tools|ToolSearch/i.test(text) ? 'reminder: deferred tool names'
				: /MCP Server Instructions|server instructions|have provided instructions/i.test(text) ? 'reminder: MCP server instructions'
				: /claudeMd|CLAUDE\.md|Codebase and user instructions/i.test(text) ? 'reminder: CLAUDE.md / memory'
				: /plan mode/i.test(text) ? 'reminder: plan mode'
				: /gitStatus|currentDate|# userEmail|context:/i.test(text) ? 'reminder: context (git/date/email)'
				: `reminder: ${head.slice(0, 50)}`;
		} else if (b.type === 'tool_result' || b.type === 'tool_use') { label = b.type; }
		else if (tag) { label = `tag <${tag[1]}>`; }
		add(`messages[${i}] ${m.role}`, label, text);
	}
});
const chars = parts.reduce((s, p) => s + p.chars, 0);
const k = total ? total / chars : 0.25;
const groups = {};
for (const p of parts) { (groups[p.group] ??= { chars: 0, n: 0 }); groups[p.group].chars += p.chars; groups[p.group].n++; }
if (process.argv.includes('--json')) { console.log(JSON.stringify({ file, model: req.model, total, chars, groups, parts })); process.exit(0); }
console.log(`${file}\nmodel ${req.model}  billed prompt ${total ?? '?'} tokens  ${chars} chars  (${(chars / (total || 1)).toFixed(2)} chars/token)  tools ${req.tools?.length ?? 0}`);
for (const [g, v] of Object.entries(groups)) { console.log(`  ${g.padEnd(32)} ${String(v.n).padStart(4)} parts ${String(Math.round(v.chars * k)).padStart(7)} tok`); }
const big = [...parts].sort((a, b) => b.chars - a.chars).slice(0, +(process.argv[3] || 25));
console.log('  largest parts:');
for (const p of big) { console.log(`    ${String(Math.round(p.chars * k)).padStart(6)} tok  ${p.group} :: ${p.name}`); }
