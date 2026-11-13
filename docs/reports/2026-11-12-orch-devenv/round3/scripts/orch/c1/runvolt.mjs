// C1-style run in Volt (the dev test instance of ../cmp/runvolt.mjs: CDP 9955, profile /tmp/v3-orch-ud).
//   node runvolt.mjs <id> [--model agent:seed-claude-code:claude-opus-5-5] [--trigger prompts/volt-trigger.txt]
// A fresh copy of the arena (/tmp/v3orch/c1/<id>, git, on main) becomes the chat's project through the
// project picker; the trigger line, then the C1 prompt, are typed into a new chat with Full access. Done:
// nothing in the chat's tree runs, is queued or undelivered for 60 s (TESTS.md: 60 s quiet), cap 45 min.
// Row: time to the last run.end, tokens of the parent and every subagent (Volt's traces), fan-out, grade.
import { execSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { grade } from './grade.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '../../../data/orch/c1');
const UD = process.env.VOLT_UD ?? '/tmp/v3-orch-ud';
const PORT = Number(process.env.VOLT_CDP ?? 9955);
const USER = join(UD, 'User');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const [id] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const model = opt('--model', 'agent:seed-claude-code:claude-opus-5-5');
const trigger = readFileSync(join(here, opt('--trigger', 'prompts/volt-trigger.txt')), 'utf8').trim();

async function cdp() {
	const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
	const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title);
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
	let n = 0;
	const pending = new Map();
	ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
	const send = (method, params = {}) => new Promise(r => { const i = ++n; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
	const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
	const click = async (x, y) => {
		for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
			await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
		}
	};
	const center = async script => evaluate(`(() => { const e = ${script}; if (!e) { return undefined; } const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
	const leaf = text => `[...document.querySelectorAll('*')].filter(e => e.offsetParent && e.childElementCount === 0 && ${text}).at(-1)`;
	return { ws, send, evaluate, click, center, leaf, close: () => ws.close() };
}

const readLines = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean) : [];
const readTrace = chat => readLines(join(USER, 'voltTraces', `${chat}.jsonl`));
const readTree = chat => { try { return JSON.parse(readFileSync(join(USER, 'voltOrchestrator', 'roots', `${chat}.json`), 'utf8')); } catch { return undefined; } };

/** Billed tokens of one chat's runs (the last billed usage of each run). */
function billed(lines) {
	const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const events = lines.filter(l => l.kind === 'event');
	for (const runId of new Set(events.map(l => l.runId))) {
		const usage = events.filter(l => l.runId === runId && l.event.type === 'usage');
		const total = usage.filter(l => l.event.used === undefined).at(-1)?.event;
		const last = usage.filter(l => l.event.billed).at(-1)?.event.billed ?? (total ? { input: total.input, output: total.output, cacheRead: total.cache, cacheWrite: total.cacheWrite } : undefined);
		for (const k of Object.keys(sum)) {
			sum[k] += last?.[k] ?? 0;
		}
	}
	return sum;
}

const repo = `/tmp/v3orch/c1/${id}`;
if (existsSync(repo)) {
	throw new Error(`${repo} exists`);
}
mkdirSync(DATA, { recursive: true });
execSync(`git clone -q /tmp/v3orch/c1/arena-base ${repo} && git -C ${repo} remote remove origin`);
const settingsFile = join(USER, 'settings.json');
const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
writeFileSync(settingsFile, JSON.stringify({ ...settings, 'volt.agent.defaultModel': model }, null, '\t'));
await sleep(1000);

const c = await cdp();
const ok = await c.evaluate(`(() => { const e = [...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^New (Chat|Agent)/.test(e.getAttribute('aria-label'))); if (!e) { return false; } e.click(); return true; })()`);
if (!ok) {
	throw new Error('no New Chat button');
}
await sleep(1500);
// The project: the picker's search takes a path and offers "Open <folder>".
const chip = await c.center(c.leaf(`/^(Select project|w|arena-base|cli-|volt-)/.test(e.textContent.trim()) && e.closest('.volt-agent-landing, .monaco-workbench')`));
await c.click(...chip);
await sleep(600);
await c.send('Input.insertText', { text: repo });
await sleep(1200);
const open = await c.center(c.leaf(`e.textContent.trim() === 'Open ${id}'`));
if (!open) {
	throw new Error('no "Open" item for the project');
}
await c.click(...open);
await sleep(1500);
// Full access, as the Haiku bench does.
const access = await c.center(`[...document.querySelectorAll('[aria-label^="Permissions:"], button.volt-agent-status-access')].find(e => e.offsetParent)`);
if (access) {
	await c.click(...access);
	await sleep(500);
	const full = await c.center(c.leaf(`e.textContent.trim() === 'Full access'`));
	if (full) {
		await c.click(...full);
		await sleep(500);
	}
}
const labels = await c.evaluate(`[...document.querySelectorAll('.volt-agent-model-label, button.volt-agent-status-access')].filter(e => e.offsetParent).map(e => e.textContent.trim())`);
await c.evaluate(`(() => { const t = [...document.querySelectorAll('textarea.inputarea')].filter(e => e.offsetParent).at(-1); t.focus(); return true; })()`);
const prompt = `${trigger}\n${readFileSync(join(here, 'prompts', 'C1-orchestrated-build.md'), 'utf8').trim()}`;
await c.send('Input.insertText', { text: prompt });
await sleep(500);
const sessionsDir = join(USER, 'agentSessions', 'sessions');
const before = new Set(readdirSync(sessionsDir));
const load = execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();
const sentAt = Date.now();
await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
let chat;
for (let i = 0; i < 240 && !chat; i++) {
	await sleep(250);
	chat = readdirSync(sessionsDir).filter(n => n.endsWith('.jsonl') && !before.has(n)).find(n => { try { return !JSON.parse(readFileSync(join(sessionsDir, n), 'utf8').split('\n')[0]).parentId; } catch { return false; } })?.replace(/\.jsonl$/, '');
}
c.close();
if (!chat) {
	throw new Error('no chat');
}
console.log(JSON.stringify({ id, chat, labels, load }));
const deadline = sentAt + 45 * 60_000;
let idleSince = 0;
let timedOut = true;
while (Date.now() < deadline) {
	await sleep(2000);
	const ev = readTrace(chat).filter(l => l.kind === 'event');
	const starts = ev.filter(l => l.event.type === 'run.start').length;
	const ends = ev.filter(l => l.event.type === 'run.end').length;
	const tree = readTree(chat);
	const busy = starts === 0 || starts > ends || (tree && (tree.threads.some(t => t.active || t.queue?.length || t.inputs?.length) || tree.tasks.some(t => ['queued', 'running', 'waiting'].includes(t.state) || t.delivery === 'pending')));
	if (busy) {
		idleSince = 0;
		continue;
	}
	idleSince ||= Date.now();
	if (Date.now() - idleSince > 60_000) {
		timedOut = false;
		break;
	}
}
const tree = readTree(chat);
const children = (tree?.tasks ?? []).filter(t => t.childId).map(t => ({ task: t, lines: readTrace(t.childId) }));
const root = readTrace(chat);
const ends = [root, ...children.map(ch => ch.lines)].flatMap(lines => lines.filter(l => l.event?.type === 'run.end').map(l => l.ts));
const endMs = Math.max(...ends) - sentAt;
const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
for (const lines of [root, ...children.map(ch => ch.lines)]) {
	const b = billed(lines);
	for (const k of Object.keys(tokens)) {
		tokens[k] += b[k];
	}
}
// Fan-out: the most subagent runs at once, and how many subagents ran (each its own chat and checkout when isolated).
const spans = children.flatMap(ch => {
	const ev = ch.lines.filter(l => l.kind === 'event');
	return [...new Set(ev.map(l => l.runId))].map(runId => ({ start: ev.find(l => l.runId === runId && l.event.type === 'run.start')?.ts, end: ev.find(l => l.runId === runId && l.event.type === 'run.end')?.ts })).filter(s => s.start && s.end);
});
const maxParallel = Math.max(0, ...spans.map(s => spans.filter(o => o.start <= s.start && o.end > s.start).length));
const graded = grade(repo);
const total = Object.values(tokens).reduce((a, b) => a + b, 0);
const row = {
	id, arm: 'volt', model, at: new Date(sentAt).toISOString(), load, chat, timedOut, endMs, minutes: +(endMs / 60_000).toFixed(2), tokens: total, usage: tokens,
	parentRuns: new Set(root.filter(l => l.kind === 'event').map(l => l.runId)).size,
	workers: children.length, maxParallel,
	tasks: (tree?.tasks ?? []).map(t => ({ title: t.title, role: t.role, isolation: t.isolation, state: t.state, model: t.modelLabel, startedAt: t.startedAt && t.startedAt - sentAt, endedAt: t.endedAt && t.endedAt - sentAt, report: t.result?.length, worktree: t.worktree?.branch ?? t.branch })),
	shipped: graded.shipped, groups: graded.groups, handoff: graded.handoff, npmTest: graded.npmTest,
};
writeFileSync(join(DATA, `${id}.grade.json`), JSON.stringify(graded, null, 1));
writeFileSync(join(DATA, `${id}.traces.json`), JSON.stringify({ tree, traces: [{ chat, lines: root }, ...children.map(ch => ({ chat: ch.task.childId, lines: ch.lines }))] }));
appendFileSync(join(DATA, 'c1-runs.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify({ id, minutes: row.minutes, tokens: total, workers: row.workers, maxParallel, shipped: `${graded.shipped}/5`, handoff: `${graded.handoff}/4`, groups: graded.groups, timedOut }));
