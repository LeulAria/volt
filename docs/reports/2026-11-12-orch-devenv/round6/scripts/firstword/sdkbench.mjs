// Floor of the path under the ACP adapter: Claude Code driven straight through the Agent SDK (no adapter),
// warm, then one user message; time from the push to the main request at the replay tap.
//   node sdkbench.mjs <label> <reps> [settings] [mcp] [warm=<ms>]
//   settings: settingSources user/project/local (as the adapter); mcp: Volt's MCP server from the recorded session/new.
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const NPX = join(homedir(), '.npm/_npx/21a32ccb11becb3a/node_modules');
const { query } = await import(join(NPX, '@anthropic-ai/claude-agent-sdk/sdk.mjs'));
const [label = 'sdk', repsArg = '3', ...flags] = process.argv.slice(2);
const has = f => flags.includes(f);
const warmMs = Number(flags.find(f => f.startsWith('warm='))?.slice(5) ?? 5000);
const TAP_LOG = join(homedir(), '.volt-r6/firstword/tap.jsonl');
const OUT = join(here, '../../data/firstword/sdkbench.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tapRows = from => existsSync(TAP_LOG) ? readFileSync(TAP_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.t >= from).sort((a, b) => a.t - b.t) : [];

async function once(rep) {
	const env = { ...process.env };
	for (const k of Object.keys(env)) { if (/^(CLAUDE|ANTHROPIC_)/.test(k)) { delete env[k]; } }
	Object.assign(env, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18974', CLAUDE_CONFIG_DIR: join(homedir(), '.volt-r6/firstword/claude-config'), CLAUDE_SECURESTORAGE_CONFIG_DIR: '', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' });
	let push;
	const queue = [];
	const input = (async function* () { while (true) { const m = queue.shift() ?? await new Promise(r => { push = r; }); push = undefined; yield m; } })();
	const sn = JSON.parse(readFileSync(join(homedir(), '.volt-r4/firstword/volt-session-new.json'), 'utf8'));
	const mcp = has('mcp') ? Object.fromEntries(sn.mcpServers.map(s => [s.name, { type: 'http', url: s.url.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:18975'), headers: Object.fromEntries(s.headers.map(h => [h.name, h.value])) }])) : {};
	const tSpawn = Date.now();
	const q = query({ prompt: input, options: { model: 'claude-haiku-5-5', cwd: join(homedir(), '.volt-r6/firstword/arena'), env, settingSources: has('settings') ? ['user', 'project', 'local'] : [], mcpServers: mcp, systemPrompt: { type: 'preset', preset: 'claude_code' }, includePartialMessages: true, pathToClaudeCodeExecutable: join(NPX, '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude') } });
	await q.initializationResult();
	const readyMs = Date.now() - tSpawn;
	await sleep(warmMs);
	const t = Date.now();
	const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'replay:hi' }] }, parent_tool_use_id: null, session_id: '' };
	if (push) { push(msg); } else { queue.push(msg); }
	let firstText;
	for await (const m of q) {
		if (!firstText && m.type === 'stream_event' && m.event?.delta?.text) { firstText = Date.now() - t; }
		if (m.type === 'result') { break; }
	}
	await sleep(800);
	const main = tapRows(t - 20).find(r => r.path?.startsWith('/v1/messages?') && r.tools > 0);
	const row = { label, flags, rep, at: new Date(t).toISOString(), load: execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim(), readyMs, warmMs, spawnToFirstTextMs: firstText ? t - tSpawn + firstText : null, mainReqMs: main ? main.t - t : null, firstTextMs: firstText ?? null, before: tapRows(t - 20).filter(r => !main || r.t <= main.t).length };
	appendFileSync(OUT, JSON.stringify(row) + '\n');
	console.log(JSON.stringify(row));
	q.close?.();
	await sleep(500);
}
for (let i = 0; i < Number(repsArg); i++) { await once(i); }
process.exit(0);
