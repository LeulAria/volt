// Capability check for the token work: one natural request per volt tool family, on the base build and the
// after build, interleaved. "Used" = the agent called a tool of the expected family (from the chat's trace).
// Run in the capability fixture (an arena copy with shop.db; see README), with both test instances up.
//   node capcheck.mjs run [task ids comma|all] [model ref]   runs base then after per task (TOK_FOLDER = fixture)
//   node capcheck.mjs report                                  table from windows.jsonl and the traces
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = process.env.TOK_DIR ?? '/tmp/v3-tokens';
const FOLDER = process.env.TOK_FOLDER ?? join(DIR, 'capfx');
// CAP_PREFIX labels a round of checks (cap: the first, on the after build before AskUserQuestion went; cap2: the final build).
const PREFIX = process.env.CAP_PREFIX ?? 'cap';
const ARMS = { base: { ud: '/tmp/v3-tokens-ud-base', port: 9964 }, after: { ud: '/tmp/v3-tokens-ud', port: 9954 } };

/** One request per family; `family` matches tool names (MCP names end with the volt tool's name). */
export const TASKS = [
	{ id: 'code', family: /(^|__)(code_nav|find_symbol|instant_grep|find_files)$/, prompt: 'Which functions end up calling parseDay, directly or through other functions? Do not change any files.' },
	{ id: 'tests', family: /(^|__)tests$/, prompt: 'Run the invoice tests and tell me which ones fail and why. Do not change any files.' },
	{ id: 'debug', family: /(^|__)debug$/, prompt: 'Stop at the return line of paginate in the debugger while the tests run and tell me the values of page and pageSize there. Do not change any files.' },
	{ id: 'db', family: /(^|__)ide$/, prompt: 'In shop.db, which sku brings in the most revenue (qty times price), and how much?' },
	{ id: 'chart', family: /(^|__)(render_chart|html_render)$/, prompt: 'Chart how many lines each file under src has.' },
	{ id: 'scratch', family: /(^|__)scratch_draw$/, prompt: 'Sketch the request flow of src/server.ts and src/api.ts on the whiteboard.' },
	{ id: 'browser', family: /(^|__)browser_[a-z_]+$/, prompt: 'Open https://example.com in the browser and tell me the main heading on the page.' },
	{ id: 'threads', family: /(^|__)(thread_list|thread_search)$/, prompt: 'List my other chats in Volt and their titles.' },
	// Base asks with Claude Code's AskUserQuestion, after with Volt's ask_question: both reach the question
	// tray, which the runner records and skips (TOK_SKIP_QUESTIONS), so "used" also counts a tray that showed.
	// "ask me how it should look" alone was answered in plain text on both builds (Haiku, 1 run each): "ask-mc" names multiple choice.
	{ id: 'ask', family: /(^|__)(ask_question|AskUserQuestion)$/i, skipQuestions: true, prompt: 'I want a function that formats invoice totals as money. Before you write any code, ask me how it should look (currency, decimals, symbol position).' },
	{ id: 'ask-mc', family: /(^|__)(ask_question|AskUserQuestion)$/i, skipQuestions: true, prompt: 'I want a function that formats invoice totals as money. Before you write any code, give me multiple-choice questions about how it should look (currency, decimals, symbol position).' },
];

function toolsOf(ud, chat) {
	const file = join(ud, 'User', 'voltTraces', `${chat}.jsonl`);
	if (!existsSync(file)) { return []; }
	const names = [];
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		let l;
		try { l = JSON.parse(line); } catch { continue; }
		const e = l?.event;
		if (l?.kind === 'event' && e && (e.type === 'tool.start' || e.type === 'host.tool')) {
			names.push(String(e.name ?? e.title ?? ''));
		}
	}
	return names;
}

const [cmd, ids = 'all', model = 'agent:seed-claude-code:claude-haiku-5-5'] = process.argv.slice(2);
if (cmd === 'run') {
	for (const task of TASKS.filter(t => ids === 'all' || ids.split(',').includes(t.id))) {
		// CAP_ARMS=after re-checks one build only (e.g. after a fix on it).
		for (const [arm, { ud, port }] of Object.entries(ARMS).filter(([a]) => !process.env.CAP_ARMS || process.env.CAP_ARMS.split(',').includes(a))) {
			execFileSync('git', ['-C', FOLDER, 'checkout', '-q', '--', '.']);
			execFileSync('git', ['-C', FOLDER, 'clean', '-qfd']);
			try {
				const out = execFileSync('node', [join(here, 'runtok.mjs'), 'run', `${PREFIX}-${arm}-${task.id}`, model, task.prompt, '1'], { env: { ...process.env, VOLT_UD: ud, VOLT_CDP: String(port), TOK_FOLDER: FOLDER, TOK_SIDE_WAIT_MS: '3000', ...(task.skipQuestions ? { TOK_SKIP_QUESTIONS: '1' } : {}) }, encoding: 'utf8', timeout: 420_000 });
				console.log(out.trim().split('\n').at(-1).slice(0, 300));
			} catch (err) {
				console.log(`cap-${arm}-${task.id} failed: ${String(err.message).slice(0, 200)}`);
			}
		}
	}
} else if (cmd === 'report') {
	const rows = readFileSync(join(DIR, 'windows.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.label.startsWith(`${PREFIX}-`));
	console.log('| Family | Prompt | Base: used / tools | After: used / tools |\n|---|---|---|---|');
	for (const task of TASKS) {
		const cell = arm => {
			const runs = rows.filter(x => x.label === `${PREFIX}-${arm}-${task.id}`);
			if (!runs.length) { return 'not run'; }
			return runs.map(r => {
				const tools = toolsOf(ARMS[arm].ud, r.chat);
				const used = tools.some(name => task.family.test(name)) || !!r.questions?.length;
				const short = [...new Set(tools.map(n => n.replace(/^mcp__volt__/, 'volt:')))].join(', ');
				return `${used ? 'yes' : 'no'} / ${short || 'none'}${r.questions?.length ? ` (question tray shown ${r.questions.length}x)` : ''}`;
			}).join('<br>');
		};
		console.log(`| ${task.id} | ${task.prompt} | ${cell('base')} | ${cell('after')} |`);
	}
} else {
	console.log('usage: capcheck.mjs run [ids] [model] | report');
}
