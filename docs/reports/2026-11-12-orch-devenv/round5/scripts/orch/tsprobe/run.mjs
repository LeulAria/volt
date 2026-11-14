// A Haiku 5.5 lead on the t1 prompt (as Volt sends it, with Volt's [Volt] lines) up to its first tool call:
// does it call delegate_task directly, or ToolSearch for tools it already has?
// usage: node run.mjs <label> <volt out dir> <rep>    rows go to ~/.volt-r5/orch/tsprobe/rows.jsonl
import { spawn } from 'child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
const [label, out, rep] = process.argv.slice(2);
const dir = join(process.env.HOME, '.volt-r5/orch/tsprobe');
mkdirSync(dir, { recursive: true });
const id = `${label}-${rep}`;
const log = join(dir, `${id}.calls.jsonl`);
writeFileSync(log, '');
writeFileSync(join(dir, `${id}.mcp.json`), JSON.stringify({ mcpServers: { volt: { command: 'node', args: [join(here, 'server.mjs')], env: { VOLT_OUT: out, TS_LOG: log, ...(process.env.DELEGATE_DESC ? { DELEGATE_DESC: process.env.DELEGATE_DESC } : {}) } } } }));
const prompt = readFileSync(join(here, process.env.TS_PROMPT ?? 'prompt-t1.txt'), 'utf8').trim();
// Volt's Claude agents have no Agent/Task, Workflow or the other Claude Code team tools.
const args = ['-p', prompt, '--model', 'claude-haiku-5-5', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
	'--mcp-config', join(dir, `${id}.mcp.json`), '--strict-mcp-config', '--disallowedTools', 'Agent,Task,Workflow,ListAgents,ReportFindings,ScheduleWakeup,Glob,Grep'];
const env = { ...process.env };
delete env.CLAUDECODE;
delete env.ELECTRON_RUN_AS_NODE;
const t0 = Date.now();
const child = spawn('claude', args, { cwd: '/tmp/v5orch/w/t1', env, stdio: ['ignore', 'pipe', 'pipe'] });
const timer = setTimeout(() => finish('timeout'), 3 * 60_000);
let buf = '';
let done = false;
function finish(outcome, extra = {}) {
	if (done) { return; }
	done = true;
	clearTimeout(timer);
	child.kill('SIGTERM');
	const row = { id, label, rep: Number(rep), outcome, ms: Date.now() - t0, ...extra, at: new Date().toISOString() };
	appendFileSync(join(dir, 'rows.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify(row));
}
child.stdout.on('data', d => {
	buf += d;
	let i;
	while ((i = buf.indexOf('\n')) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		let m;
		try { m = JSON.parse(line); } catch { continue; }
		if (m.type !== 'assistant' || m.parent_tool_use_id) { continue; }
		for (const b of m.message.content ?? []) {
			if (b.type === 'tool_use') {
				return finish(b.name === 'ToolSearch' ? 'toolsearch' : b.name.replace('mcp__volt__', ''), { input: JSON.stringify(b.input).slice(0, 200) });
			}
		}
	}
});
child.on('exit', () => finish('exit'));
