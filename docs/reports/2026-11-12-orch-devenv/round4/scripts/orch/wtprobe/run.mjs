// One C1 lead up to its first delegation: does it use Volt's worktrees (isolation) or make its own (git worktree add)?
// usage: node run.mjs <variant base|head|candidate> <rep>
import { execSync, spawn } from 'child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
const [variant, rep] = process.argv.slice(2);
const id = `${variant}-${rep}`;
const dir = `/tmp/v4orch/wtprobe/runs/${id}`;
execSync(`rm -rf ${dir} && git clone -q ${process.env.HOME}/.volt-r4/c1/arena-base ${dir}`);
const out = variant === 'base' ? '/Users/leularia/Desktop/VOLT/volt-e4-base/out' : '/Users/leularia/Desktop/VOLT/volt-e4-orch/out';
const log = `/tmp/v4orch/wtprobe/${id}.calls.jsonl`; writeFileSync(log, '');
const env = { VOLT_OUT: out, WT_LOG: log, ...(variant === 'candidate' ? { WT_PATCH: 'candidate', WT_ISOLATION: process.env.WT_ISOLATION } : {}) };
writeFileSync(`/tmp/v4orch/wtprobe/${id}.mcp.json`, JSON.stringify({ mcpServers: { volt: { command: 'node', args: ['/tmp/v4orch/wtprobe/server.mjs'], env } } }));
const prompt = readFileSync('/Users/leularia/Desktop/VOLT/volt-e4-c1/docs/reports/2026-11-12-orch-devenv/round4/data/c1/volt-after-1.prompt.txt', 'utf8').trim();
const args = ['-p', prompt, '--model', 'claude-opus-5-5', '--effort', 'high', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
	'--mcp-config', `/tmp/v4orch/wtprobe/${id}.mcp.json`, '--strict-mcp-config', '--disallowedTools', 'Agent,Task'];
const e = { ...process.env }; delete e.CLAUDECODE; delete e.ELECTRON_RUN_AS_NODE;
const t0 = Date.now();
const child = spawn('claude', args, { cwd: dir, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
const timer = setTimeout(() => finish('timeout'), 6 * 60_000);
let buf = ''; const bash = []; let done = false; let usage = { in: 0, out: 0, cr: 0, cw: 0 };
function finish(outcome, extra = {}) {
	if (done) { return; } done = true; clearTimeout(timer); child.kill('SIGTERM');
	const row = { id, variant, rep: Number(rep), outcome, ms: Date.now() - t0, bash, usage, ...extra, at: new Date().toISOString() };
	appendFileSync('/tmp/v4orch/wtprobe/rows.jsonl', JSON.stringify(row) + '\n');
	console.log(JSON.stringify(row));
}
child.stdout.on('data', d => {
	buf += d; let i;
	while ((i = buf.indexOf('\n')) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		let m; try { m = JSON.parse(line); } catch { continue; }
		if (m.type !== 'assistant' || m.parent_tool_use_id) { continue; }
		const u = m.message.usage ?? {}; usage = { in: usage.in + (u.input_tokens ?? 0), out: usage.out + (u.output_tokens ?? 0), cr: usage.cr + (u.cache_read_input_tokens ?? 0), cw: usage.cw + (u.cache_creation_input_tokens ?? 0) };
		for (const b of m.message.content ?? []) {
			if (b.type !== 'tool_use') { continue; }
			if (b.name === 'Bash') { bash.push(String(b.input.command).slice(0, 200)); if (/worktree add/.test(b.input.command)) { return finish('self-worktree'); } }
			if (b.name === 'mcp__volt__delegate_task') {
				const iso = b.input.isolation ?? (b.input.tasks ?? []).map(t => t.isolation).find(Boolean);
				return finish(iso === 'worktree' ? 'volt-worktree' : 'shared', { isolation: iso ?? null, task: String(b.input.task ?? '').slice(0, 300) });
			}
		}
	}
});
child.on('exit', () => finish('exit'));
