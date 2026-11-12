// IDE tool use at runtime: natural requests in a Volt chat on the IDE fixture, N runs each.
// Records which tools the agent picked (Volt host tools with their op/capability, shell commands),
// whether the Volt tool worked, wall time and cost.
//
//   node ide.mjs <outDir> <tag> <task ids comma|all> [runs=3] [port=9946] [ud=/tmp/v2-ide-ud] [--full]
//
// The chat's project must already be the fixture (/private/tmp/vbench-ide-fx): new chats (Cmd+N) keep it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageFor } from './usage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = '/private/tmp/vbench-ide-fx';
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const [outDir, tag, ids = 'all', runsArg = '3', port = '9946', ud = '/tmp/v2-ide-ud'] = args;
const full = process.argv.includes('--full');
const TR = `${ud}/User/voltTraces`;

/** expect(hostTools, shell): did the agent use the fitting Volt tool. */
export const TASKS = [
	{ id: 'tests', prompt: 'The cart tests in this project fail. Which test fails and why? Do not change any files.', expect: h => h.some(t => t.name === 'tests' && t.args.op === 'run') },
	{ id: 'debug', prompt: 'The discount test in test/cart.test.ts fails. Stop at the return line of cartTotal in the debugger and tell me the values of subtotal, discount and items.length there. Do not change any files.', expect: h => h.some(t => t.name === 'debug' && (t.args.op === 'start' || t.args.op === 'attach')) },
	{ id: 'http', prompt: 'Using requests.http with the local environment, log in and fetch the profile. What name and email does the profile return?', expect: h => h.some(t => t.name === 'ide' && t.args.capability === 'http' && t.args.op === 'send') },
	{ id: 'docker', prompt: 'The flaky service from docker-compose.yml keeps restarting. Why? Do not change any files.', expect: h => h.some(t => t.name === 'ide' && t.args.capability === 'docker') },
	{ id: 'db', prompt: 'In shop.db, which sku brings in the most revenue (qty times price), and how much?', expect: h => h.some(t => t.name === 'ide' && t.args.capability === 'db') },
	{ id: 'profile', prompt: 'scripts/slow.mjs is slow. Which function takes most of the time? Do not change any files.', expect: h => h.some(t => t.name === 'ide' && t.args.capability === 'profile') },
	{ id: 'notebook', prompt: 'Run analysis.ipynb and tell me what its last cell prints.', expect: h => h.some(t => t.name === 'ide' && t.args.capability === 'notebook' && t.args.op === 'run') },
	{ id: 'rename', prompt: 'Rename the function lineTotal in src/cart.ts to lineAmount everywhere it is used.', expect: h => h.some(t => t.name === 'code_action' && t.args.op === 'rename') },
	{ id: 'scratch', prompt: 'Sketch out the login, token and profile flow of server.mjs on the whiteboard.', expect: h => h.some(t => t.name === 'scratch_draw') },
	{ id: 'canvas', prompt: 'Design the screens of a small mobile app for this API: a login screen and a profile screen.', expect: h => h.some(t => t.name === 'canvas_render' || t.name === 'mockups_render') },
];

const parse = file => fs.readFileSync(`${TR}/${file}`, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const load = () => execFileSync('uptime').toString().trim().replace(/.*load averages?: /, '');

function reset() {
	execFileSync('git', ['-C', FX, 'checkout', '-q', '--', '.']);
	execFileSync('git', ['-C', FX, 'clean', '-qfd', '-e', 'node_modules', '-e', '.venv']);
}

if (process.argv[1]?.endsWith('ide.mjs')) {
	fs.mkdirSync(outDir, { recursive: true });
	const tasks = TASKS.filter(t => ids === 'all' || ids.split(',').includes(t.id));
	for (let run = 1; run <= Number(runsArg); run++) {
		for (const task of tasks) {
			reset();
			const loadAt = load();
			const t0 = Date.now();
			const raw = execFileSync('node', [`${HERE}/send.mjs`, port, ud, task.prompt, ...(full ? ['--full'] : [])], { maxBuffer: 64 * 1024 * 1024, timeout: 900_000 }).toString().trim().split('\n').at(-1);
			const sent = JSON.parse(raw);
			const L = parse(sent.chat);
			const host = L.map(x => x.event).filter(e => e?.type === 'host.tool').map(e => ({ name: e.name, args: { ...(e.args ?? {}), ...(e.args?.args && typeof e.args.args === 'object' ? e.args.args : {}) }, error: e.error ? String(e.error).slice(0, 300) : undefined }));
			const shell = sent.tools.filter(t => !/^mcp__/.test(t)).map(t => t.slice(0, 160));
			const u = usageFor(task.prompt.slice(0, 60), t0 - 5000, '-private-tmp-vbench-ide-fx');
			const changed = execFileSync('git', ['-C', FX, 'status', '--porcelain']).toString().trim();
			const row = { id: task.id, tag, run, access: full ? 'full' : 'supervised', load: loadAt, wallMs: sent.wallMs, outcome: sent.outcome, approvals: sent.approvals, picked: task.expect(host), voltErrors: host.filter(h => h.error).length, host: host.map(h => `${h.name}${h.args.capability ? `:${h.args.capability}` : ''}${h.args.op ? `.${h.args.op}` : ''}${h.error ? ' ERROR' : ''}`), shell, cost: u.cost, output: u.output, cacheRead: u.cacheRead, toolUses: u.toolUses, changed, chat: sent.chat };
			fs.writeFileSync(`${outDir}/${task.id}-${tag}-r${run}.json`, JSON.stringify({ ...row, answer: sent.answer, hostCalls: host }, null, 1));
			fs.appendFileSync(`${outDir}/summary.jsonl`, JSON.stringify(row) + '\n');
			console.log(JSON.stringify({ id: row.id, run, picked: row.picked, host: row.host, shell: row.shell.length, wallS: Math.round(row.wallMs / 1000), cost: row.cost?.toFixed(4) }));
		}
	}
	reset();
}
