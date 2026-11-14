// One parent first message: thinking time and first tool block, then the process is stopped.
// usage: node run.mjs <variant cc|volt-base|volt-after> <effort|-> <rep>
import { spawn } from 'child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
const [variant, effort, rep] = process.argv.slice(2);
const cmp = '/Users/leularia/Desktop/VOLT/volt-e4-orch/docs/reports/2026-11-12-orch-devenv/round4/scripts/orch/cmp/prompts';
const base = readFileSync(`${cmp}/t1.txt`, 'utf8').trim();
const del = JSON.parse(readFileSync(`${cmp}/delegation.json`, 'utf8'));
const prompt = base.replace('{{DELEGATION}}', variant === 'cc' ? del.cc.t1 : del.voltn.t1.replace('{{SUBMODEL}}', 'claude-haiku-5-5'));
const args = ['-p', prompt, '--model', 'claude-haiku-5-5', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'bypassPermissions'];
if (effort !== '-') { args.push('--effort', effort); }
if (variant !== 'cc') {
	const out = variant === 'volt-base' ? '/Users/leularia/Desktop/VOLT/volt-e4-base/out' : '/Users/leularia/Desktop/VOLT/volt-e4-orch/out';
	writeFileSync(`/tmp/v4orch/think/${variant}.mcp.json`, JSON.stringify({ mcpServers: { volt: { command: 'node', args: ['/tmp/v4orch/think/server.mjs'], env: { VOLT_OUT: out } } } }));
	args.push('--mcp-config', `/tmp/v4orch/think/${variant}.mcp.json`, '--strict-mcp-config', '--disallowedTools', 'Agent,Task');
}
const env = { ...process.env }; delete env.CLAUDECODE; delete env.ELECTRON_RUN_AS_NODE;
const t0 = Date.now();
const child = spawn('claude', args, { cwd: '/tmp/v4orch/w/t1', env, stdio: ['ignore', 'pipe', 'pipe'] });
let buf = ''; const r = { variant, effort, rep: Number(rep), load: readFileSync('/dev/null', 'utf8') };
const marks = {};
let thinkChars = 0; let toolArgs = 0; let tools = 0;
child.stdout.on('data', d => {
	buf += d; let i;
	while ((i = buf.indexOf('\n')) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		let m; try { m = JSON.parse(line); } catch { continue; }
		const at = Date.now() - t0;
		if (m.type !== 'stream_event' || m.parent_tool_use_id) { continue; }
		const e = m.event;
		if (e.type === 'message_start') { marks.messageStart ??= at; }
		if (e.type === 'content_block_start' && e.content_block.type === 'thinking') { marks.thinkStart ??= at; }
		if (e.type === 'content_block_delta' && e.delta.type === 'thinking_delta') { thinkChars += e.delta.thinking.length; }
		if (e.type === 'content_block_start' && e.content_block.type === 'text') { marks.textStart ??= at; }
		if (e.type === 'content_block_start' && e.content_block.type === 'tool_use') { tools++; marks.firstTool ??= at; marks.firstToolName ??= e.content_block.name; }
		if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta') { toolArgs += e.delta.partial_json.length; }
		if (e.type === 'content_block_stop') { marks.firstBlockStop ??= at; if (tools === 1) { marks.firstToolDone ??= at; } }
		if (e.type === 'message_delta' && e.usage) { marks.outputTokens = e.usage.output_tokens; }
		if (e.type === 'message_stop') { marks.messageStop = at; child.kill('SIGTERM'); }
	}
});
child.on('exit', () => {
	const row = { ...r, load: undefined, ...marks, thinkChars, tools, toolArgs };
	appendFileSync('/tmp/v4orch/think/rows.jsonl', JSON.stringify(row) + '\n');
	console.log(JSON.stringify(row));
});
