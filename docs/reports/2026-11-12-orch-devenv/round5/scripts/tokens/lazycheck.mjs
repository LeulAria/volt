// Lazy-tool check (round 4): each of Claude Code's tools the after build loads on demand (Agent, Workflow,
// ScheduleWakeup, ReportFindings, ListAgents) is asked for by a task, on the base build (tools always
// loaded) and the after build (loaded with ToolSearch), and the capture says whether the model called it
// and how long "task needs the tool" took to "tool available".
//   node lazycheck.mjs run [ids|all] [model ref] [reps]   per task: base then after (TOK_FOLDER = fixture)
//   node lazycheck.mjs report [label regex]               table from windows.jsonl + capture.jsonl (+ bodies)
// Timing, from the proxy capture of the chat's main thread: the request whose answer calls ToolSearch for
// the tool is "need" (the model decided it needs it when it wrote that answer; we take the request's
// send time), the next request (sent with the schema loaded) is "available". need-to-available = that
// request's model time + Claude Code's ToolSearch + its next send. "batched" = the ToolSearch call shared
// its message with other tool calls, so no round trip was added for it.
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = process.env.TOK_DIR ?? `${process.env.HOME}/.volt-r5/tokens/run`;
const FOLDER = process.env.TOK_FOLDER ?? join(DIR, 'capfx');
const PREFIX = process.env.CAP_PREFIX ?? 'lazy';
// Round 5: base = the before build (volt-e5-base), after = volt-e5-tokens (see env.sh / matrix.sh).
const ARMS = { base: { ud: `${process.env.HOME}/.volt-r5/tokens/ud-base`, port: 9979 }, after: { ud: `${process.env.HOME}/.volt-r5/tokens/ud`, port: 9973 } };

export const TASKS = [
	{ id: 'agent', tool: 'Agent', prompt: 'Use Claude Code\'s Agent tool (a general-purpose subagent, not Volt\'s delegate_task) to find every function in src that parses or formats dates, and give me its report. Do not change any files.' },
	{ id: 'agent-natural', tool: 'Agent', prompt: 'Spin up an Explore subagent to map which files in src import each other, then summarize what it found. Do not change any files.' },
	{ id: 'workflow', tool: 'Workflow', prompt: 'Run a tiny workflow with the Workflow tool: one step that lists the files under src and returns their names. Keep it to that single step, then tell me what it returned. Do not change any files.' },
	{ id: 'wakeup', tool: 'ScheduleWakeup', prompt: 'Use ScheduleWakeup to wake yourself up in 60 seconds to check `git status` again, then end this turn. When you wake up, just report the status in one line.' },
	{ id: 'findings', tool: 'ReportFindings', prompt: 'Review src/paginate.ts for correctness bugs and report the verified findings with the ReportFindings tool. Do not change any files.' },
	{ id: 'listagents', tool: 'ListAgents', prompt: 'Use the ListAgents tool to list the agents running in this session, and tell me what it returned.' },
];

const [cmd, ids = 'all', model = 'agent:seed-claude-code:claude-haiku-5-5', reps = '1'] = process.argv.slice(2);
const read = f => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean) : [];

if (cmd === 'run') {
	for (let rep = 1; rep <= Number(reps); rep++) {
		for (const task of TASKS.filter(t => ids === 'all' || ids.split(',').includes(t.id))) {
			for (const [arm, { ud, port }] of Object.entries(ARMS).filter(([a]) => !process.env.CAP_ARMS || process.env.CAP_ARMS.split(',').includes(a))) {
				execFileSync('git', ['-C', FOLDER, 'checkout', '-q', '--', '.']);
				execFileSync('git', ['-C', FOLDER, 'clean', '-qfd']);
				try {
					const out = execFileSync('node', [join(here, 'runtok.mjs'), 'run', `${PREFIX}-${arm}-${task.id}`, model, task.prompt, String(rep)], { env: { ...process.env, VOLT_UD: ud, VOLT_CDP: String(port), TOK_FOLDER: FOLDER, TOK_SIDE_WAIT_MS: process.env.TOK_SIDE_WAIT_MS ?? '3000', TOK_SKIP_QUESTIONS: '1' }, encoding: 'utf8', timeout: 480_000 });
					console.log(out.trim().split('\n').at(-1).slice(0, 300));
				} catch (err) {
					console.log(`${PREFIX}-${arm}-${task.id} failed: ${String(err.message).slice(0, 200)}`);
				}
			}
		}
	}
} else if (cmd === 'report') {
	const capFile = join(DIR, 'capture.jsonl');
	const captured = read(capFile).filter(r => /\/v1\/messages(\?|$)/.test(r.path ?? '') && r.usage);
	const body = n => { const f = `${capFile}.bodies/${n}.json`; return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
	const windows = read(join(DIR, 'windows.jsonl')).filter(w => !w.invalid && new RegExp(ids === 'all' ? `^${PREFIX}-` : ids).test(w.label));
	const rows = [];
	for (const w of windows) {
		const task = TASKS.find(t => w.label.endsWith(`-${t.id}`));
		if (!task) { continue; }
		// Both test instances share the proxy, and a wake-up or workflow of an earlier task can still run: the
		// chat's own thread is the Claude Code session (metadata.user_id's session_id) whose first request
		// carries this prompt, after it was sent; within it, requests that carry the prompt (not its subagents').
		const session = r => { try { return JSON.parse(r.b?.metadata?.user_id ?? '{}').session_id; } catch { return undefined; } };
		const hasPrompt = r => JSON.stringify(r.b?.messages ?? []).includes(task.prompt.slice(0, 40));
		const inWindow = captured.filter(r => r.t >= w.sent && r.t <= w.end).sort((a, b) => a.t - b.t).map(r => ({ ...r, b: body(r.n) }));
		const first = inWindow.find(r => (r.b?.tools?.length ?? 0) >= 5 && hasPrompt(r) && (r.b?.messages?.length ?? 0) <= 2);
		const reqs = first ? inWindow.filter(r => session(r) === session(first) && (r.b?.tools?.length ?? 0) >= 5 && hasPrompt(r)) : [];
		const uses = r => (r.b?.messages ?? []).filter(m => m.role === 'assistant').flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === 'tool_use') : []);
		const last = reqs.at(-1);
		// Tool calls the model made: those in the last main request's history, plus the final answer's (not in any body).
		const called = last ? uses(last).map(u => u.name) : [];
		const usedTool = called.includes(task.tool) || (w.tools ?? []).some(n => n === task.tool || String(n).includes(task.tool));
		let timing;
		for (let i = 1; i < reqs.length; i++) {
			const assistant = (reqs[i].b?.messages ?? []).filter(m => m.role === 'assistant').at(-1);
			const blocks = Array.isArray(assistant?.content) ? assistant.content.filter(c => c.type === 'tool_use') : [];
			const search = blocks.find(c => c.name === 'ToolSearch' && String(c.input?.query ?? '').includes(task.tool));
			if (search && !timing) {
				timing = { needToAvailableMs: reqs[i].t - reqs[i - 1].t, decideMs: reqs[i - 1].ms, query: search.input.query, batched: blocks.length > 1, step: i };
			}
		}
		rows.push({ label: w.label, rep: w.rep, tool: task.tool, session: first ? session(first) : undefined, used: usedTool, toolSearch: !!timing, ...timing, requests: reqs.length, called: [...new Set(called)].join(','), traceTools: [...new Set(w.tools ?? [])].join(','), load: w.load });
	}
	for (const r of rows) { console.log(JSON.stringify(r)); }
} else {
	console.log('usage: lazycheck.mjs run [ids] [model] [reps] | report [label regex]');
}
