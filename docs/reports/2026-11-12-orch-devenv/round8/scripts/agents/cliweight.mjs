// What Volt adds to a Claude CLI's memory (A7's agents group): the SDK's CLI binary (2.1.322) run standalone the way
// the SDK runs it (stream-json in and out), on A7's replay prompt `replay:stream-1`, in variants that add Volt's parts
// one at a time. ADEMark's sampler (phys_footprint, 4 Hz) over the CLI's tree for WINDOW_S from its spawn; the CLI
// stays idle after its result until the window ends. Peak = max; rest = median of the last 20 s.
//   node cliweight.mjs <reps> <variant...>
// Variants:
//   bare    the binary, stream-json, bypass permissions, haiku; API key auth (no claude.ai connectors in any variant)
//   mcp     + Volt's MCP server (round 6's stub: Volt's real instructions and 138-tool list, over HTTP)
//   mcp1    + the same server with one tool (~/.volt-r8/agents/mcp1-snapshot.json: workspace_status)
//   volt    + Volt's plugin dir (volt-lazy-tools), Volt's --settings (hooks, skill listing), Volt's env, as `ps` shows
//           a Volt chat's CLI (~/.volt-r8/agents/probe/volt-cli-cmd.txt)
//   volt-noplugin, volt-nosettings, volt-noenv, volt-noreplay: Volt's CLI less one part
//   volt-samethread: Volt's CLI with CLAUDE_CODE_HOOKS_SAME_THREAD=1 (the plugin's hook module on the CLI's thread)
// SPEED_REPLAY=<port> points the CLI at another endpoint (a logging tap in front of the replay server).
// Rows -> ../../data/agents/cliweight.jsonl
import { spawn, execFileSync, execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const [repsArg = '2', ...variants] = process.argv.slice(2);
const CLI = '/opt/homebrew/lib/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude';
const NATIVE = `${homedir()}/.volt-r3/speed/native/bin/ademark-native`;
const REPLAY = process.env.SPEED_REPLAY ?? '18996';
const STUB = process.env.STUB_PORT ?? '18988';
// `mcp1`: the same server with one tool (workspace_status), to tell the server's fixed cost from its tool list's.
const STUB1 = process.env.STUB1_PORT ?? '18989';
const ARENA = `${homedir()}/.volt-r8/agents/arena`;
const WINDOW_S = Number(process.env.WINDOW_S ?? 100);
const OUT = join(here, '../../data/agents/cliweight.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const load = () => execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();

// Volt's own flags, from a Volt chat's CLI command line.
const voltCmd = readFileSync(`${homedir()}/.volt-r8/agents/probe/volt-cli-cmd.txt`, 'utf8');
const voltSettings = /--settings (\{.*?\}) [A-Z_]+=/.exec(voltCmd)?.[1];
const voltPluginDir = /--plugin-dir-no-mcp=(\S+)/.exec(voltCmd)?.[1];
const voltEnv = Object.fromEntries(['CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS', 'CLAUDE_CODE_SDK_READS_SESSION_STATE', 'CLAUDE_CODE_STARTUP_FAILURE_RESULTS', 'CLAUDE_CODE_MCP_STARTUP_WAIT_MS', 'CLAUDE_CODE_ENABLE_TODO_TOOLS', 'MCP_TOOL_TIMEOUT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENTRYPOINT']
	.map(k => [k, new RegExp(` ${k}=(\\S*)`).exec(voltCmd)?.[1]]).filter(([, v]) => v !== undefined));
if (!voltSettings || !voltPluginDir) { throw new Error('volt-cli-cmd.txt lacks --settings or --plugin-dir-no-mcp'); }

function args(variant) {
	const a = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--model=claude-haiku-5-5', '--permission-mode=bypassPermissions', '--allow-dangerously-skip-permissions', '--setting-sources=user,project,local', '--include-partial-messages'];
	if (variant !== 'bare') {
		const port = variant === 'mcp1' ? STUB1 : STUB;
		a.push('--mcp-config', JSON.stringify({ mcpServers: { volt: { type: 'http', url: `http://127.0.0.1:${port}/mcp/stub` } } }), '--allowedTools=mcp__volt');
	}
	if (variant.startsWith('volt')) {
		// volt-noplugin / volt-nosettings / volt-noenv / volt-noreplay: Volt's CLI less one part, to weigh each.
		if (!variant.includes('noplugin')) { a.push(`--plugin-dir-no-mcp=${voltPluginDir}`); }
		if (!variant.includes('nosettings')) { a.push('--settings', voltSettings); }
		a.push('--disallowedTools=AskUserQuestion');
		if (!variant.includes('noreplay')) { a.push('--replay-user-messages'); }
	}
	return a;
}

async function run(variant, rep) {
	const cfg = mkdtempSync(join(tmpdir(), 'r7-cliweight-cfg-'));
	const env = { PATH: process.env.PATH, HOME: homedir(), USER: process.env.USER, LANG: 'en_US.UTF-8', SHELL: '/bin/zsh', TMPDIR: tmpdir(),
		ANTHROPIC_BASE_URL: `http://127.0.0.1:${REPLAY}`, ANTHROPIC_API_KEY: 'sk-ant-replay-0000', CLAUDE_CONFIG_DIR: cfg, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
		...(variant.startsWith('volt') && !variant.includes('noenv') ? voltEnv : {}),
		// volt-samethread: Claude Code runs the plugin's hook module on its own thread, not in a Worker isolate.
		...(variant.includes('samethread') ? { CLAUDE_CODE_HOOKS_SAME_THREAD: '1' } : {}) };
	const t0 = Date.now();
	const child = spawn(CLI, args(variant), { cwd: ARENA, env, stdio: ['pipe', 'pipe', 'ignore'] });
	const rules = join(cfg, 'rules.json');
	writeFileSync(rules, JSON.stringify({ rootPids: [child.pid], bundlePaths: [], vendorDirs: [], agentExecutables: ['claude'], excludeNames: [] }));
	const csv = join(cfg, 'fp.csv');
	const sampler = new Promise(res => { const s = spawn(NATIVE, ['sample', '--rules', rules, '--hz', '4', '--duration-s', String(WINDOW_S), '--csv', csv], { stdio: 'ignore' }); s.on('exit', res); });
	let resultAt = 0; let buf = ''; let textChars = 0; let error;
	child.stdout.on('data', d => {
		buf += d;
		let i;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i); buf = buf.slice(i + 1);
			let m; try { m = JSON.parse(line); } catch { continue; }
			if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
				child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: m.request.input } } }) + '\n');
			}
			if (m.type === 'stream_event' && m.event?.delta?.text) { textChars += m.event.delta.text.length; }
			if (m.type === 'result') { resultAt = Date.now(); if (m.is_error) { error = m.result ?? m.subtype; } }
		}
	});
	child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'replay:stream-1' } }) + '\n');
	const loadAvg = load();
	await sampler;
	child.stdin.end();
	child.kill('SIGTERM');
	await sleep(300);
	const lines = readFileSync(csv, 'utf8').trim().split('\n');
	const header = lines.shift().split(',');
	const idx = n => header.indexOf(n);
	// Per tick: the tree's total footprint.
	const ticks = new Map();
	for (const line of lines) {
		const f = line.split(',');
		const t = f[idx('t_ns')];
		ticks.set(t, (ticks.get(t) ?? 0) + Number(f[idx('phys_footprint_b')]) / 1048576);
	}
	const series = [...ticks.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, v]) => v);
	const restN = Math.min(series.length, 80);
	const rest = [...series.slice(-restN)].sort((a, b) => a - b)[restN >> 1];
	const row = { variant, rep, at: new Date(t0).toISOString(), load: loadAvg, resultS: resultAt ? (resultAt - t0) / 1000 : null, textChars, error, peakMiB: Math.round(Math.max(...series)), restMiB: Math.round(rest), samples: series.length };
	if (process.env.CLIWEIGHT_NO_ROWS !== '1') {
		appendFileSync(OUT, JSON.stringify(row) + '\n');
	}
	console.log(JSON.stringify(row));
	rmSync(cfg, { recursive: true, force: true });
}

mkdirSync(dirname(OUT), { recursive: true });
const stubScript = join(here, '../../../round6/scripts/firstword/mcpstub.mjs');
const stub = spawn(process.execPath, [stubScript, STUB], { stdio: 'ignore' });
const stub1 = spawn(process.execPath, [stubScript, STUB1, `${homedir()}/.volt-r8/agents/mcp1-snapshot.json`], { stdio: 'ignore' });
await sleep(500);
try {
	for (let rep = 1; rep <= Number(repsArg); rep++) {
		for (const variant of variants) {
			await run(variant, rep);
		}
	}
} finally {
	stub.kill();
	stub1.kill();
}
