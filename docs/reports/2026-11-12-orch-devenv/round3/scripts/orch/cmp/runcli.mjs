// One run of a CLI harness on one bench task. Resets the fixture, spawns the harness headless,
// timestamps every stdout line, then scores the result and appends a row to runs.jsonl.
// Usage: node runcli.mjs <arm> <task t0|t1|t2|t3> <rep>
// Arms: cc (claude -p, Haiku 5.5), cursor-sonnet, cursor-grok (cursor-agent), hermes (hermes chat).
import { spawn, execSync } from 'child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resetFixture, scoreT1, scoreT2, scoreT3 } from './score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CMP_DATA ?? join(here, '../../../data/orch/cmp');
const [arm, task, rep] = process.argv.slice(2);
const TIMEOUT = 10 * 60_000;

export function buildPrompt(family, task, submodel = '') {
	const base = readFileSync(join(here, 'prompts', `${task}.txt`), 'utf8').trim();
	if (task === 't0') {
		return base;
	}
	const delegation = JSON.parse(readFileSync(join(here, 'prompts', 'delegation.json'), 'utf8'))[family][task];
	return base.replace('{{DELEGATION}}', delegation.replace('{{SUBMODEL}}', submodel));
}

const ARMS = {
	cc: { family: 'cc', cmd: 'claude', args: p => ['-p', p, '--model', 'claude-haiku-5-5', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'bypassPermissions'] },
	'cursor-sonnet': { family: 'cursor', cmd: 'cursor-agent', args: p => ['--print', '--output-format', 'stream-json', '--stream-partial-output', '--trust', '--force', '--model', 'claude-sonnet-5-thinking-high', p] },
	'cursor-grok': { family: 'cursor', cmd: 'cursor-agent', args: p => ['--print', '--output-format', 'stream-json', '--stream-partial-output', '--trust', '--force', '--model', 'grok-4.7-medium', p] },
	// Hermes on the Claude subscription plugin (model.provider claude-subscription-directsdk-experimental,
	// model.default claude-haiku-5-5 in ~/.hermes/config.yaml); children inherit the parent's model.
	hermes: { family: 'hermes', cmd: 'hermes', args: p => ['chat', '-q', p, '--format', 'stream-json', '--yolo'] },
};

function parse(armName, lines) {
	// Returns { ttftMs, firstTextMs, finalText, usage, costUsd, subagents, toolCalls }
	const r = { ttftMs: null, firstTextMs: null, finalText: '', usage: {}, costUsd: null, subagents: 0, toolCalls: 0, isError: false };
	const fam = ARMS[armName].family;
	for (const { at, m } of lines) {
		if (fam === 'cc') {
			if (m.type === 'stream_event' && !m.parent_tool_use_id) {
				const d = m.event?.delta;
				if (d && (d.type === 'text_delta' || d.type === 'thinking_delta' || d.type === 'input_json_delta')) {
					r.ttftMs ??= at;
				}
				if (d?.type === 'text_delta') {
					r.firstTextMs ??= at;
				}
			}
			if (m.type === 'assistant') {
				for (const part of m.message?.content ?? []) {
					if (part.type === 'tool_use') {
						r.toolCalls++;
						if (!m.parent_tool_use_id && /^(Task|Agent)$/.test(part.name)) {
							r.subagents++;
						}
					}
				}
			}
			if (m.type === 'result') {
				r.finalText = m.result ?? '';
				r.costUsd = m.total_cost_usd ?? null;
				r.isError = !!m.is_error;
				const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				for (const mu of Object.values(m.modelUsage ?? {})) {
					u.input += mu.inputTokens ?? 0; u.output += mu.outputTokens ?? 0; u.cacheRead += mu.cacheReadInputTokens ?? 0; u.cacheWrite += mu.cacheCreationInputTokens ?? 0;
				}
				r.usage = u;
				r.models = Object.keys(m.modelUsage ?? {});
				r.numTurns = m.num_turns;
			}
		} else if (fam === 'cursor') {
			if ((m.type === 'thinking' && m.subtype === 'delta') || (m.type === 'assistant')) {
				r.ttftMs ??= at;
			}
			if (m.type === 'assistant') {
				r.firstTextMs ??= at;
			}
			if (m.type === 'tool_call' && m.subtype === 'started') {
				r.toolCalls++;
				const tc = m.tool_call ?? {};
				if (Object.keys(tc).some(k => /task|subagent/i.test(k))) {
					r.subagents++;
				}
			}
			if (m.type === 'result') {
				r.finalText = m.result ?? '';
				r.isError = !!m.is_error;
				const u = m.usage ?? {};
				r.usage = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cacheReadTokens ?? 0, cacheWrite: u.cacheWriteTokens ?? 0 };
				r.apiMs = m.duration_ms;
			}
		} else if (fam === 'hermes') {
			if (m.type === 'text' || m.type === 'tool_use') {
				r.ttftMs ??= at;
			}
			if (m.type === 'text') {
				r.firstTextMs ??= at;
			}
			if (m.type === 'tool_use') {
				r.toolCalls++;
				if (m.name === 'delegate_task') {
					r.subagents += Array.isArray(m.input?.tasks) ? m.input.tasks.length : 1;
				}
			}
			if (m.type === 'result') {
				r.finalText = m.text ?? '';
				r.sessionId = m.session_id;
				r.isError = !!m.exit_code;
				r.parentTokens = m.tokens;
			}
		}
	}
	return r;
}

function hermesSessions(rootId) {
	const db = join(process.env.HOME, '.hermes', 'state.db');
	const q = sql => JSON.parse(execSync(`sqlite3 -readonly -json ${db} ${JSON.stringify(sql)}`).toString() || '[]');
	const all = [];
	let frontier = [rootId];
	while (frontier.length) {
		const rows = q(`select id, parent_session_id, model, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, api_call_count, tool_call_count from sessions where id in (${frontier.map(i => `'${i.replace(/'/g, '')}'`).join(',')})`);
		all.push(...rows);
		const kids = q(`select id from sessions where parent_session_id in (${frontier.map(i => `'${i.replace(/'/g, '')}'`).join(',')})`).map(r => r.id);
		frontier = kids.filter(k => !all.some(r => r.id === k));
	}
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let cost = 0;
	let apiCalls = 0;
	for (const s of all) {
		usage.input += s.input_tokens ?? 0; usage.output += s.output_tokens ?? 0; usage.cacheRead += s.cache_read_tokens ?? 0; usage.cacheWrite += s.cache_write_tokens ?? 0;
		cost += s.estimated_cost_usd ?? 0;
		apiCalls += s.api_call_count ?? 0;
	}
	return { usage, costUsd: cost, apiCalls, sessions: all };
}

async function main() {
	const a = ARMS[arm];
	if (!a) {
		throw new Error('unknown arm ' + arm);
	}
	resetFixture(task);
	const prompt = buildPrompt(a.family, task);
	const cwd = `/tmp/v3orch/w/${task}`;
	const env = { ...process.env };
	for (const k of Object.keys(env)) {
		if (k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_AGENT_SDK_VERSION') {
			delete env[k];
		}
	}
	const id = `${arm}-${task}-${rep}`;
	const rawDir = join(DATA, 'raw');
	mkdirSync(rawDir, { recursive: true });
	const args = a.args(prompt);
	const load = execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();
	const t0 = Date.now();
	const child = spawn(a.cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
	const lines = [];
	const plain = [];
	let buf = '';
	child.stdout.on('data', chunk => {
		buf += chunk;
		let i;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			const at = Date.now() - t0;
			try {
				lines.push({ at, m: JSON.parse(line) });
			} catch {
				plain.push({ at, line });
			}
		}
	});
	let stderr = '';
	child.stderr.on('data', c => stderr += c);
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch { } }, TIMEOUT);
	const code = await new Promise(res => child.on('close', res));
	clearTimeout(timer);
	const wallMs = Date.now() - t0;
	if (buf.trim()) {
		plain.push({ at: wallMs, line: buf });
	}
	writeFileSync(join(rawDir, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
	writeFileSync(join(rawDir, `${id}.stderr.txt`), stderr.slice(-20000) + (plain.length ? '\n--- plain stdout ---\n' + plain.map(p => `${p.at} ${p.line}`).join('\n') : ''));
	const r = parse(arm, lines);
	if (a.family === 'hermes' && r.sessionId) {
		// Parent + delegated children: Hermes records every session (tokens, estimated cost) in state.db.
		Object.assign(r, hermesSessions(r.sessionId));
	}
	let score;
	if (task === 't0') {
		score = { ok: /^\s*OK\s*\.?\s*$/.test(r.finalText) };
	} else if (task === 't1') {
		score = scoreT1(r.finalText);
	} else if (task === 't2') {
		score = scoreT2();
	} else {
		score = scoreT3();
	}
	const row = { id, arm, task, rep: Number(rep), at: new Date(t0).toISOString(), load, exit: code, timedOut, wallMs, ...r, finalText: r.finalText.slice(0, 2000), score };
	appendFileSync(join(DATA, 'runs.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify({ id, wallMs, ttftMs: r.ttftMs, costUsd: r.costUsd, usage: r.usage, subagents: r.subagents, score, exit: code, timedOut, load }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await main();
}
