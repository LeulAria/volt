// usageFor(marker, sinceMs): tokens/cost from the Claude Code transcript(s) (incl. subagents) whose prompt contains marker
import fs from 'node:fs'; import path from 'node:path';
const STATE = '/Users/leularia/.volt/sandbox/agent-state';
export function usageFor(marker, since = 0, project = '-private-tmp-vbench-hotel') {
	const files = [];
	for (const agent of fs.readdirSync(STATE)) {
		const dir = path.join(STATE, agent, 'claude-code/config/projects', project);
		if (!fs.existsSync(dir)) continue;
		for (const f of fs.readdirSync(dir)) {
			const p = path.join(dir, f);
			if (!f.endsWith('.jsonl') || fs.statSync(p).mtimeMs < since) continue;
			const body = fs.readFileSync(p, 'utf8'); if (!body.includes(marker)) continue;
			// The prompt with the marker must have been sent within 60 s of the run's start (later runs of the same question are other files).
			const first = body.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).find(x => x?.type === 'user' && JSON.stringify(x.message ?? '').includes(marker.slice(0, 40)));
			const at = first?.timestamp ? Date.parse(first.timestamp) : undefined;
			if (since && at !== undefined && (at < since - 5000 || at > since + 65000)) continue;
			files.push(p);
			const sub = path.join(dir, f.replace(/\.jsonl$/, ''), 'subagents');
			if (fs.existsSync(sub)) for (const s of fs.readdirSync(sub)) if (s.endsWith('.jsonl')) files.push(path.join(sub, s));
		}
	}
	const seen = new Set(); const u = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, toolUses: {} };
	for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
		let x; try { x = JSON.parse(line); } catch { continue; }
		if (x.type !== 'assistant' || !x.message?.usage) continue;
		for (const c of x.message.content ?? []) if (c.type === 'tool_use' && !seen.has(c.id)) { seen.add(c.id); u.toolUses[c.name] = (u.toolUses[c.name] ?? 0) + 1; }
		const key = x.message.id; if (seen.has(key)) continue; seen.add(key);
		const m = x.message.usage; u.input += m.input_tokens ?? 0; u.output += m.output_tokens ?? 0; u.cacheRead += m.cache_read_input_tokens ?? 0;
		u.cacheWrite1h += m.cache_creation?.ephemeral_1h_input_tokens ?? 0; u.cacheWrite5m += m.cache_creation?.ephemeral_5m_input_tokens ?? (m.cache_creation ? 0 : m.cache_creation_input_tokens ?? 0);
	}
	// Haiku 5.5 list prices derived from claude -p total_cost_usd: $0.10/M in, $0.50/M out, $0.01/M cache read, 1h write $0.20/M, 5m write $0.125/M
	u.cost = (u.input * 0.10 + u.output * 0.50 + u.cacheRead * 0.01 + u.cacheWrite1h * 0.20 + u.cacheWrite5m * 0.125) / 1e6;
	u.files = files.length;
	return u;
}
if (process.argv[1]?.endsWith('usage.mjs') && process.argv[2]) console.log(JSON.stringify(usageFor(process.argv[2], +(process.argv[3] ?? 0))));
