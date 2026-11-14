// Over-delegation probe: a Haiku 5.5 main chat on a one-tool request (a chart, a browser look-up), set up as
// Volt sets one up (Claude Code 2.1.322 from the agent SDK, a clean config dir, Volt's appended main rules and
// its lazy-tools hooks plugin from PLUGIN_OUT, the volt server's instructions and task tools from VOLT_OUT;
// stub server.mjs). Records the tool calls up to the first Volt tool other than ToolSearch: does the chat call
// delegate_task for work it should do itself?
//   PLUGIN_OUT=<out dir> node dprobe.mjs <label> <volt out dir> <chart|browser> <rep>
// Rows go to ~/.volt-r5/orch/tsprobe/drows.jsonl.
import { spawn } from 'child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
const [label, out, task, rep] = process.argv.slice(2);
const PROMPTS = {
	chart: 'Chart how many lines each file under src has.',
	browser: 'Open https://example.com in the browser and tell me the main heading on the page.',
	scratch: 'Sketch the request flow of src/checkout.ts and src/cart.ts on the whiteboard.',
	threads: 'List my other chats in Volt and their titles.',
};
const dir = join(process.env.HOME, '.volt-r5/orch/tsprobe');
mkdirSync(dir, { recursive: true });
const id = `${label}-${task}-${rep}${process.env.PROBE_MODEL ? '-' + process.env.PROBE_MODEL : ''}`;
const log = join(dir, `${id}.calls.jsonl`);
writeFileSync(log, '');
writeFileSync(join(dir, `${id}.mcp.json`), JSON.stringify({ mcpServers: { volt: { command: 'node', args: [join(here, 'server.mjs')], env: { VOLT_OUT: out, TS_LOG: log, ...(process.env.DELEGATE_DESC ? { DELEGATE_DESC: process.env.DELEGATE_DESC } : {}) } } } }));
const pluginOut = process.env.PLUGIN_OUT ?? out;
const rules = await import(join(pluginOut, 'vs/workbench/services/voltRuntime/common/harness/claudeWorkRules.js'));
const plugin = rules.claudeLazyToolsPlugin();
const pdir = join(mkdtempSync(join(tmpdir(), 'volt-dprobe-')), plugin.name);
// PLUGIN_REPLACE="from|||to": try another wording of the plugin's text (e.g. the compacted deferred-tools line).
const [from, to] = (process.env.PLUGIN_REPLACE ?? '').split('|||');
for (const [path, text] of plugin.files) { mkdirSync(dirname(join(pdir, path)), { recursive: true }); writeFileSync(join(pdir, path), from ? text.split(from).join(to) : text); }
const append = rules.claudeWorkRulesMeta(undefined, { voltAsks: true, lazyToolsPlugin: pdir }).systemPrompt.append;
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? join(process.env.HOME, '.npm/_npx/21a32ccb11becb3a/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude');
const args = ['-p', PROMPTS[task], '--model', process.env.PROBE_MODEL ?? 'claude-haiku-5-5', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
	'--append-system-prompt', append, '--plugin-dir', pdir,
	'--mcp-config', join(dir, `${id}.mcp.json`), '--strict-mcp-config', '--disallowedTools', 'AskUserQuestion'];
const env = { HOME: process.env.HOME, USER: process.env.USER, PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8', CLAUDE_CONFIG_DIR: join(process.env.HOME, '.volt-r5/orch/c1/cfg-clean'), ENABLE_TOOL_SEARCH: 'true' };
const t0 = Date.now();
const child = spawn(CLAUDE_BIN, args, { cwd: '/tmp/v5orch/w/t1', env, stdio: ['ignore', 'pipe', 'pipe'] });
const timer = setTimeout(() => finish('timeout'), 3 * 60_000);
const calls = [];
let buf = '';
let result = '';
let stray = 0;
let done = false;
function finish(outcome) {
	if (done) { return; }
	done = true;
	clearTimeout(timer);
	child.kill('SIGTERM');
	const row = { id, label, task, rep: Number(rep), outcome: stray && outcome !== 'delegate' ? `stray+${outcome}` : outcome, calls, result, ms: Date.now() - t0, at: new Date().toISOString() };
	appendFileSync(join(dir, 'drows.jsonl'), JSON.stringify(row) + '\n');
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
		if (m.type === 'result') { result = String(m.result ?? '').slice(0, 300); }
		if (m.type !== 'assistant' || m.parent_tool_use_id) { continue; }
		for (const b of m.message.content ?? []) {
			if (b.type !== 'tool_use') { continue; }
			const name = b.name.replace('mcp__volt__', 'volt:');
			calls.push(`${name} ${JSON.stringify(b.input).slice(0, 120)}`);
			if (name === 'volt:delegate_task') {
				const brief = typeof b.input?.task === 'string' ? b.input.task.trim() : '';
				// A stray call (no brief, a placeholder) is refused by the stub as Volt refuses it: see what comes next.
				if (Array.isArray(b.input?.tasks) || brief.split(/\s+/).length > 1) { return finish('delegate'); }
				stray++;
				continue;
			}
			if (name.startsWith('volt:')) { return finish('direct'); }
			if (calls.length >= 8) { return finish('other'); }
		}
	}
});
child.on('exit', () => finish('exit'));
