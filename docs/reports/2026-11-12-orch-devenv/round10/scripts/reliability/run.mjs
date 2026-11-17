// ADEMark Track C reliability tests C2-C6 on Volt, ADEMark method, unofficial, on a scripted model (brain.mjs):
// no live model turn. One test instance (own profile, CDP 9989), faults scoped to that instance only.
//   node run.mjs --arm r8|dev launch            start the instance (r8 = ~/.volt-r8/min/r8/VOLT.app, dev = this tree)
//   node run.mjs --arm <arm> storage            sandbox Off + Full access defaults (ADEMark's pin), instance stopped
//   node run.mjs --arm <arm> c2 <id>            C2 Message Delivery + the C3 chat-lock probe
//   node run.mjs --arm <arm> c4 <id> [--at stream|tool] [--what cli|adapter|server]
//   node run.mjs --arm <arm> c5 <id> [--mode drop|reset] [--seconds 30]
//   node run.mjs --arm <arm> c6 <id> [--queued]  (--queued: a follow-up is queued just before the quit)
//   node run.mjs --arm <arm> stop | shot [file] | eval <js>
// Faults (TESTS.md 1.6), scoped: C4 = kill -9 of the `claude` process whose cwd is the task worktree and that
// descends from this profile's processes; C5 = the brain stops answering this instance for 30 s (ADEMark blocks the
// API hosts machine-wide with pf, which needs root and would cut every other agent on this Mac); C6 = Cmd+Q in the
// test window over CDP, then the same launch again (ADEMark quits by app name, which would hit the user's Volt).
import { execSync, spawn } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { grade, ADEMARK } from './grade.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const flag = name => argv.includes(name);
const ARM = opt('--arm', 'r8');
const W = `${process.env.HOME}/.volt-r10/reliability`;
process.env.SPEED_UD ??= `${W}/ud-${ARM}`;
process.env.SPEED_EXT ??= `${W}/ext-${ARM}`;
if (ARM === 'dev') {
	process.env.SPEED_CHECKOUT ??= join(here, '../../../../../..');
} else {
	process.env.SPEED_APP ??= opt('--app', ARM === 'r8' ? `${process.env.HOME}/.volt-r8/min/r8/VOLT.app` : undefined);
}
const { UD, PORT, REPLAY, CFG, DATA, cdp, launchDev, waitWorkbench, writeSettings, stopInstance, profileProcesses, sleep, load, paste, newChat, focusComposer } = await import('./lib.mjs');
const USER = join(UD, 'User');
const RUNS = `${W}/runs`;
const BRAIN = `http://127.0.0.1:${REPLAY}`;
const positional = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1]?.startsWith('--') && !['--queued', '--keep'].includes(argv[i - 1])));
const [cmd, id] = positional;

const task = name => {
	const dir = join(ADEMARK, 'tasks', name);
	return { prompt: readFileSync(join(dir, 'prompt.md'), 'utf8').replace(/\n$/, ''), dir };
};
const brain = async (path, body) => (await fetch(`${BRAIN}${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined)).json();
const readJsonl = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

// ---------- the instance ----------

function writeStorage() {
	const db = join(UD, 'agentServer', 'application.vscdb');
	if (!existsSync(db)) { return false; }
	const q = sql => execSync(`sqlite3 ${JSON.stringify(db)} ${JSON.stringify(sql)}`).toString().trim();
	const put = (key, value) => q(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${key}', '${value.replace(/'/g, "''")}')`);
	put('volt.runtime.sandbox', JSON.stringify({ v: 2, defaults: { level: 'off', network: true }, chats: {} }));
	put('volt.runtime.accessMode', 'full-access');
	console.log(q(`SELECT key || ' = ' || value FROM ItemTable WHERE key IN ('volt.runtime.sandbox', 'volt.runtime.accessMode')`));
	return true;
}

async function launch() {
	mkdirSync(CFG, { recursive: true });
	if (!existsSync(join(CFG, '.claude.json'))) { writeFileSync(join(CFG, '.claude.json'), '{"hasCompletedOnboarding":true,"theme":"dark"}'); }
	if (!existsSync(join(CFG, '.credentials.json'))) {
		// A placeholder sign-in: a made-up token that only ever goes to the brain on 127.0.0.1.
		writeFileSync(join(CFG, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-oat01-replay-${'0'.repeat(86)}-AAAAAAAA`, expiresAt: 4102444800000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }), { mode: 0o600 });
	}
	writeSettings({ 'volt.agent.defaultModel': 'agent:seed-claude-code:claude-opus-5-5' });
	const pid = launchDev({ replay: true });
	const ms = await waitWorkbench();
	return { pid, ms, load: load() };
}

let brainChild;
async function startBrain(out, config = {}) {
	try { execSync(`pkill -f "brain.mjs --port ${REPLAY}"`); } catch { }
	await sleep(300);
	const log = openSync(`${out}.brain.log`, 'a');
	brainChild = spawn(process.execPath, [join(here, 'brain.mjs'), '--port', String(REPLAY), '--out', out, '--pad', String(config.pad ?? 3200), '--sleep', String(config.sleep ?? 6)], { stdio: ['ignore', log, log], detached: true });
	brainChild.unref();
	for (let i = 0; i < 50; i++) { try { await brain('/_ctl/state'); return; } catch { await sleep(100); } }
	throw new Error('brain did not start');
}
const stopBrain = () => { try { process.kill(brainChild.pid); } catch { } };

// ---------- driving the chat ----------

async function pickProject(c, folder) {
	const name = folder.split('/').at(-1);
	const shown = () => c.evaluate(`(() => [...document.querySelectorAll('*')].some(e => e.offsetParent && e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(name)} && /label|project/.test(e.className)))()`);
	// Under load the landing appears late: wait for its picker.
	let opened = false;
	for (let i = 0; i < 60; i++) {
		const label = await c.evaluate(`[...document.querySelectorAll('button.volt-agent-landing-pick')].filter(e => e.offsetParent && e.querySelector('.label')).at(0)?.querySelector('.label')?.textContent.trim() ?? null`);
		// Run ids are unique, so a picker that already names this folder has it (a rerun after a failed start).
		if (label === name) { return; }
		if (label !== null) { break; }
		await sleep(500);
	}
	for (let i = 0; i < 60 && !opened; i++) {
		opened = await c.evaluate(`(() => { const e = [...document.querySelectorAll('button.volt-agent-landing-pick')].filter(e => e.offsetParent && e.querySelector('.label')).at(0); if (!e) { return false; } e.click(); return true; })()`);
		if (!opened) { await sleep(500); }
	}
	if (!opened) { throw new Error('no project picker'); }
	let focused = false;
	for (let i = 0; i < 40 && !focused; i++) {
		await sleep(250);
		focused = await c.evaluate(`(() => { const i = [...document.querySelectorAll('input')].filter(e => e.offsetParent && /search projects/i.test(e.placeholder)).at(-1); i?.focus(); i?.select(); return !!i && document.activeElement === i; })()`);
	}
	if (!focused) { throw new Error('the project search box did not open'); }
	await c.send('Input.insertText', { text: folder });
	let listed = false;
	for (let i = 0; i < 40 && !listed; i++) {
		await sleep(250);
		listed = await c.evaluate(`[...document.querySelectorAll('.monaco-list-row')].some(e => e.offsetParent && ((e.getAttribute('aria-label') ?? '').endsWith(${JSON.stringify(folder)}) || /^Open /.test(e.textContent.trim())))`);
	}
	const picked = await c.evaluate(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && (e.getAttribute('aria-label') ?? '').endsWith(${JSON.stringify(folder)})).at(-1) ?? [...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && /^Open /.test(e.textContent.trim())).at(-1); r?.click(); return !!r; })()`);
	await sleep(1500);
	if (!picked || !await shown()) { throw new Error(`could not pick the project ${folder}`); }
}

const THREAD = `[...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).map(e => e.innerText).join('\\n')`;
const threadText = c => c.evaluate(THREAD);
const composerText = c => c.evaluate(`(() => { const t = [...document.querySelectorAll('textarea.inputarea')].filter(e => e.offsetParent).at(-1); return t?.closest('.monaco-editor')?.querySelector('.view-lines')?.innerText ?? null; })()`);
/** What the window says about the run: buttons and status rows that read like stopped / error / queued / retry. */
const uiState = c => c.evaluate(`(() => { const vis = e => e.offsetParent !== null; const texts = [...document.querySelectorAll('[class*="queue"], [class*="error"], [class*="retry"], [class*="stopped"], [class*="interrupted"], [class*="banner"], [class*="notification-toast"]')].filter(vis).map(e => (e.className + ' :: ' + (e.innerText ?? '').replace(/\\s+/g, ' ').trim()).slice(0, 260)).filter(t => !/ :: $/.test(t)); const stop = [...document.querySelectorAll('[aria-label]')].filter(vis).map(e => e.getAttribute('aria-label')).filter(l => /^(Stop|Cancel|Send|Queue|Interrupt)/i.test(l)); return { marks: [...new Set(texts)].slice(0, 14), buttons: [...new Set(stop)] }; })()`);

async function shot(c, file) {
	const s = await c.send('Page.captureScreenshot', { format: 'png' });
	writeFileSync(file, Buffer.from(s.result.data, 'base64'));
	return file;
}

async function sendText(c, text) {
	if (!await focusComposer(c)) { throw new Error('no composer'); }
	await c.key('a', 'KeyA', 65, 4);
	await c.key('Backspace', 'Backspace', 8);
	await sleep(150);
	await paste(c, text);
	await sleep(350);
	await c.key('Enter', 'Enter', 13, 0, '\r');
	return Date.now();
}

async function startTask(c, repo, prompt) {
	await c.send('Page.bringToFront');
	await newChat(c);
	await sleep(1500);
	await pickProject(c, repo);
	await sleep(800);
	const sessionsDir = join(USER, 'agentSessions', 'sessions');
	const before = new Set(existsSync(sessionsDir) ? readdirSync(sessionsDir) : []);
	const chips = await c.evaluate(`(() => ({ model: [...document.querySelectorAll('.volt-agent-model')].filter(e => e.offsetParent).map(e => e.textContent.trim()), access: [...document.querySelectorAll('button.volt-agent-status-access')].filter(e => e.offsetParent).map(e => e.getAttribute('aria-label') + ' / ' + (e.dataset.mode ?? '')) }))()`);
	const startLoad = load();
	const t0 = await sendText(c, prompt);
	let chat;
	for (let i = 0; i < 80 && !chat; i++) {
		await sleep(250);
		chat = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter(n => n.endsWith('.jsonl') && !before.has(n)).at(0)?.replace(/\.jsonl$/, '') : undefined;
	}
	return { t0, chat, chips, load: startLoad };
}

const capture = out => readJsonl(join(out, 'capture.jsonl'));
/** The end: the model's last answer for the task is its final message, and nothing followed for `quietMs`. */
async function waitEnd(out, { t0, minMs = 0, capMs = 9 * 60_000, quietMs = 20_000 }) {
	for (;;) {
		const rows = capture(out).filter(r => r.task);
		const last = rows.at(-1);
		const now = Date.now();
		if (last?.step === 'final' && last.status === 200 && now - (last.t + (last.ms ?? 0)) >= quietMs && now - t0 >= minMs) {
			return { done: true, endMs: last.t + last.ms - t0 };
		}
		if (now - t0 >= capMs) { return { done: false, endMs: now - t0, last: last ? { step: last.step, status: last.status, ago: now - last.t } : null }; }
		await sleep(2000);
	}
}

// ---------- processes (C4) ----------

function cwdOf(pid) {
	try { return /^n(.*)$/m.exec(execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`).toString())?.[1] ?? null; } catch { return null; }
}
/** This profile's processes with their role; `agent` = ADEMark's rule (executable `claude`, cwd = the worktree). */
function processes(repo) {
	return profileProcesses().map(p => {
		const exe = p.cmd.split(' ')[0].split('/').at(-1);
		const role = /volt-agent-server|agentServerMain|voltAgentServer/.test(p.cmd) ? 'agent-server' : /claude-agent-acp|claude-code-acp|acp/.test(p.cmd) && !/\/claude( |$)/.test(p.cmd.split(' ')[0]) ? 'adapter' : exe === 'claude' || /\/claude( |$)/.test(p.cmd) ? 'cli' : 'other';
		return { pid: p.pid, ppid: p.ppid, exe, role, cmd: p.cmd.slice(0, 200) };
	}).map(p => (p.role === 'cli' || p.role === 'adapter') ? { ...p, cwd: cwdOf(p.pid) } : p).map(p => ({ ...p, agent: p.exe === 'claude' && !!repo && !!p.cwd && p.cwd.replace(/^\/private/, '') === repo.replace(/^\/private/, '') }));
}

// ---------- resume watch (TESTS.md 4, C4-C6): the session log or the files under the worktree changed ----------

function newestMs(dir, skip = /\/(\.git|node_modules)(\/|$)/) {
	let newest = 0;
	const walk = d => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (skip.test(p + (e.isDirectory() ? '/' : ''))) { continue; }
			if (e.isDirectory()) { walk(p); } else { try { newest = Math.max(newest, statSync(p).mtimeMs); } catch { } }
		}
	};
	try { walk(dir); } catch { }
	return newest;
}
function changeMark(repo) {
	const slug = repo.replace(/[^a-zA-Z0-9]/g, '-');
	return Math.max(newestMs(repo), newestMs(join(CFG, 'projects', slug)), newestMs(join(CFG, 'projects', `-private${slug}`)));
}
async function watchResume(repo, windowS) {
	const before = changeMark(repo);
	const start = Date.now();
	while (Date.now() - start < windowS * 1000) {
		await sleep(2000);
		if (changeMark(repo) > before) { return { resumed: true, afterMs: Date.now() - start }; }
	}
	return { resumed: false };
}

// ---------- C3 probe ----------

async function probeLoop(c, { until, pauses, stopped, samples }) {
	const focus = `(() => { const t = [...document.querySelectorAll('textarea.inputarea')].filter(e => e.offsetParent).at(-1); if (!t) { return false; } if (document.activeElement !== t) { t.focus(); } return true; })()`;
	while (Date.now() < until && !stopped()) {
		const now = Date.now();
		const inside = pauses.find(p => p[0] <= now && now < p[1]);
		if (inside) { await sleep(inside[1] - now); continue; }
		const sample = { t: now, ms: null };
		try {
			await Promise.race([(async () => {
				await c.evaluate(focus);
				const before = (await composerText(c)) ?? '';
				const sent = performance.now();
				await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, text: 'q' });
				await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81 });
				while (performance.now() - sent < 2000) {
					const text = (await composerText(c)) ?? '';
					if (text.length > before.length && text.includes('q')) { sample.ms = Math.round(performance.now() - sent); break; }
					await sleep(15);
				}
			})(), sleep(2000)]);
			await c.key('Backspace', 'Backspace', 8);
		} catch (error) { sample.error = String(error.message ?? error).slice(0, 80); }
		samples.push(sample);
		await sleep(Math.max(0, 2000 - (Date.now() - now)));
	}
}
/** ADEMark's rule (tracks/c/probe.ts): a lock is a run of lost probes, from the first lost one to the next echo. */
function locks(samples) {
	const runs = [];
	for (let i = 0; i < samples.length;) {
		if (samples[i].ms !== null) { i++; continue; }
		const first = i;
		while (i < samples.length && samples[i].ms === null) { i++; }
		runs.push(((i < samples.length ? samples[i].t : samples[i - 1].t) - samples[first].t) / 1000);
	}
	return runs;
}

// ---------- the tests ----------

function freshRepo(name) {
	const repo = join(RUNS, name);
	if (existsSync(repo)) { throw new Error(`${repo} exists: pick another id`); }
	mkdirSync(RUNS, { recursive: true });
	execSync(`git clone -q ${W}/arena-base ${repo} && git -C ${repo} remote remove origin`);
	return repo;
}

function finishRow(row) {
	mkdirSync(DATA, { recursive: true });
	appendFileSync(join(DATA, 'runs.jsonl'), JSON.stringify(row) + '\n');
	const brief = { ...row };
	for (const k of ['processesAtFault', 'probes', 'threadTail', 'ui', 'captureSteps']) { delete brief[k]; }
	console.log(JSON.stringify(brief, null, 1));
}

async function c2(name) {
	const repo = freshRepo(name);
	const out = join(RUNS, `${name}.capture`);
	await startBrain(out, { pad: Number(opt('--pad', 4200)), sleep: Number(opt('--sleep', 8)) });
	const t = task('C2-message-delivery');
	const followups = [['C2-F1', 30, 'F1.md'], ['C2-F2', 90, 'F2.md'], ['C2-F3', 150, 'F3.md']].map(([fid, at, file]) => ({ id: fid, at, text: readFileSync(join(t.dir, 'followups', file), 'utf8').replace(/\n$/, '') }));
	const c = await cdp();
	const { t0, chat, chips, load: startLoad } = await startTask(c, repo, t.prompt);
	const samples = [];
	let stop = false;
	const pauses = followups.map(f => [t0 + f.at * 1000 - 1500, t0 + f.at * 1000 + 1500 + 2500]);
	const probing = probeLoop(c, { until: t0 + 9 * 60_000, pauses, stopped: () => stop, samples });
	const states = [];
	for (const f of followups) {
		await sleep(Math.max(0, t0 + f.at * 1000 - Date.now()));
		const sentAt = await sendText(c, f.text);
		let accepted = false;
		const snippet = f.text.slice(0, 24);
		for (let i = 0; i < 25 && !accepted; i++) {
			await sleep(200);
			accepted = await c.evaluate(`document.body.innerText.replace(/\\s+/g, ' ').includes(${JSON.stringify(snippet)}) && !(${JSON.stringify(snippet)} && ((document.activeElement?.closest?.('.monaco-editor')?.querySelector('.view-lines')?.innerText ?? '').replace(/\\s+/g, ' ').includes(${JSON.stringify(snippet)})))`);
		}
		const ui = await uiState(c);
		await shot(c, join(RUNS, `${name}.queued-${f.id}.png`));
		const phase = (await brain('/_ctl/state')).phase?.C2;
		states.push({ id: f.id, sentAt, delayMs: sentAt - (t0 + f.at * 1000), accepted, queuedUi: ui.marks.filter(m => /queue/i.test(m)).slice(0, 3), modelPhase: phase ? `${phase.step}:${phase.phase}` : null });
	}
	const end = await waitEnd(out, { t0, minMs: 160_000 });
	stop = true;
	await probing;
	await sleep(1500);
	const rows = capture(out).filter(r => r.task === 'C2');
	const norm = s => s.replace(/\s+/g, ' ').trim();
	for (const s of states) {
		const f = followups.find(x => x.id === s.id);
		// TESTS.md C2 "delivered": the text appears in a later model request (the capture).
		const hit = rows.find(r => r.t >= s.sentAt && r.body_file && (() => { try { const body = JSON.parse(readFileSync(join(out, r.body_file), 'utf8')); return body.messages.some(m => m.role === 'user' && norm(typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).includes(norm(f.text))); } catch { return false; } })());
		s.delivered = !!hit;
		s.deliveredAfterMs = hit ? hit.t - s.sentAt : null;
		s.deliveredInRequest = hit?.n ?? null;
	}
	const graded = grade(repo, 'C2');
	for (const s of states) { s.applied = graded.groups[s.id]; }
	const lockRuns = locks(samples);
	const echoed = samples.filter(s => s.ms !== null).map(s => s.ms).sort((a, b) => a - b);
	const thread = await threadText(c);
	await shot(c, join(RUNS, `${name}.end.png`));
	c.close();
	finishRow({
		test: 'C2', id: name, arm: ARM, at: new Date(t0).toISOString(), load: startLoad, loadEnd: load(), chat, chips, repo,
		dropped: states.filter(s => !s.delivered).length, applied: states.filter(s => s.applied).length, followups: states,
		done: end.done, endS: Math.round(end.endMs / 1000), groups: graded.groups,
		c3: { probes: samples.length, lost: samples.filter(s => s.ms === null).length, locks: lockRuns.length, longestLockS: Math.max(0, ...lockRuns), echoP50: echoed[echoed.length >> 1] ?? null, echoMax: echoed.at(-1) ?? null },
		probes: samples, threadTail: thread.slice(-500), captureSteps: rows.map(r => `${r.n}:${r.step}:${r.status}`),
	});
	stopBrain();
}

async function faultTest(kind, name) {
	const repo = freshRepo(name);
	const out = join(RUNS, `${name}.capture`);
	await startBrain(out, { pad: Number(opt('--pad', 3600)), sleep: Number(opt('--sleep', 8)) });
	const t = task(kind === 'c4' ? 'C4-agent-killed' : kind === 'c5' ? 'C5-network-cut' : 'C6-app-restart');
	let c = await cdp();
	const { t0, chat, chips, load: startLoad } = await startTask(c, repo, t.prompt);
	const atS = Number(opt('--at-s', 90));
	await sleep(Math.max(0, t0 + atS * 1000 - Date.now()));
	// --at stream|tool: fire only once the model is streaming an answer / waiting for a tool result (variants).
	const want = opt('--at');
	if (want) {
		for (let i = 0; i < 400; i++) {
			const p = (await brain('/_ctl/state')).phase?.W3;
			if (p && ((want === 'stream' && p.phase === 'streaming' && Date.now() - p.since > 1500) || (want === 'tool' && p.phase === 'tool' && /baseline|check|final-test/.test(p.step) && Date.now() - p.since > 1500))) { break; }
			await sleep(100);
		}
	}
	const phaseAtFault = (await brain('/_ctl/state')).phase?.W3 ?? null;
	const faultAt = Date.now();
	let fault;
	let processesAtFault;
	if (kind === 'c4') {
		processesAtFault = processes(repo);
		const what = opt('--what', 'cli');
		const targets = what === 'cli' ? processesAtFault.filter(p => p.agent) : processesAtFault.filter(p => p.role === (what === 'server' ? 'agent-server' : 'adapter'));
		for (const p of targets) { try { process.kill(p.pid, 'SIGKILL'); } catch { } }
		fault = { kind: `kill-${what}`, pids: targets.map(p => p.pid), applied: targets.length > 0, agentsByAdemarkRule: processesAtFault.filter(p => p.agent).map(p => p.pid) };
	} else if (kind === 'c5') {
		const seconds = Number(opt('--seconds', 30));
		await brain('/_ctl/cut', { seconds, mode: opt('--mode', 'drop') });
		await shot(c, join(RUNS, `${name}.cut.png`));
		await sleep(seconds * 1000 + 300);
		fault = { kind: `network-cut-${opt('--mode', 'drop')}`, seconds, applied: true };
	} else {
		if (flag('--queued')) { await sendText(c, 'Also: when you are done, write the single word QUEUED-OK as the last line before ledger-ok.'); await sleep(1500); }
		const mainPid = profileProcesses().find(p => p.cmd.includes(`--user-data-dir ${UD}`) && !/--type=/.test(p.cmd))?.pid;
		if (!mainPid) { throw new Error('no main process of the test instance'); }
		const quitAt = Date.now();
		// The window closes under the key: its reply may never come.
		await Promise.race([c.key('q', 'KeyQ', 81, 4).catch(() => { }), sleep(1500)]);
		let dialog = null;
		const alive = () => { try { process.kill(mainPid, 0); return true; } catch { return false; } };
		while (alive() && Date.now() - quitAt < 10_000) {
			await sleep(300);
			try {
				const text = await Promise.race([c.evaluate(`(() => { const d = [...document.querySelectorAll('.monaco-dialog-box')].filter(e => e.offsetParent).at(-1); if (!d) { return null; } const t = d.innerText.replace(/\\s+/g, ' ').slice(0, 300); d.querySelector('.dialog-buttons .monaco-button')?.click(); return t; })()`), sleep(800)]);
				if (text) { dialog = text; }
			} catch { }
		}
		const quitMs = Date.now() - quitAt;
		const exited = !alive();
		// The relaunch needs the CDP port back (a rig matter: ADEMark's launches have no debug port).
		for (let i = 0; i < 100; i++) {
			try { execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN`, { stdio: 'pipe' }); await sleep(200); } catch { break; }
		}
		const portWaitMs = Date.now() - quitAt - quitMs;
		try { c.close(); } catch { }
		const left = profileProcesses().map(p => p.cmd.split(' ')[0].split('/').at(-1) + (/agent-server|agentServer/.test(p.cmd) ? '(agent-server)' : ''));
		const pid = launchDev({ replay: true });
		await waitWorkbench();
		await sleep(1500);
		c = await cdp();
		await c.send('Page.bringToFront');
		// returnToThread: Volt reopens the chat it was showing; check it is the interrupted one, else pick it in the sidebar.
		let returned = /cursor pagination/.test(await threadText(c));
		if (!returned) {
			await c.evaluate(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && /Ledger|pagination|cursor/i.test(e.innerText)).at(0); r?.click(); })()`);
			await sleep(2000);
			returned = /cursor pagination/.test(await threadText(c));
		}
		fault = { kind: 'app-restart', applied: exited, quitMs, portWaitMs, dialog, processesLeftAfterQuit: left, newPid: pid, returnedToThread: returned, queued: flag('--queued') };
	}
	const faultEnd = Date.now();
	await sleep(1200);
	const uiAfterFault = await uiState(c).catch(() => null);
	await shot(c, join(RUNS, `${name}.fault.png`)).catch(() => { });
	const watch = await watchResume(repo, 60);
	const uiAfterWatch = await uiState(c).catch(() => null);
	const threadAfterWatch = (await threadText(c).catch(() => '')).slice(-400);
	await shot(c, join(RUNS, `${name}.watch.png`)).catch(() => { });
	let manual = false;
	if (!watch.resumed) {
		manual = true;
		await sendText(c, 'continue');
		await sleep(1000);
		await shot(c, join(RUNS, `${name}.continue.png`)).catch(() => { });
	}
	const end = await waitEnd(out, { t0, minMs: Date.now() - t0 + 5000, capMs: Number(opt('--cap-s', 540)) * 1000 });
	await sleep(1500);
	const graded = grade(repo, 'W3');
	const crashed = !profileProcesses().some(p => p.cmd.includes(`--user-data-dir ${UD}`));
	const passed = graded.groups['W3-cursor'];
	// TESTS.md C4: pass = completes with nothing lost and no manual action; partial = after a manual continue, or work lost.
	const survival = !end.done || crashed ? 'fail' : passed && !manual ? 'pass' : 'partial';
	const rows = capture(out).filter(r => r.task === 'W3');
	const thread = await threadText(c).catch(() => '');
	await shot(c, join(RUNS, `${name}.end.png`)).catch(() => { });
	c.close();
	finishRow({
		test: kind.toUpperCase(), id: name, arm: ARM, at: new Date(t0).toISOString(), load: startLoad, loadEnd: load(), chat, chips, repo,
		survival, resumed: watch.resumed, resumedAfterMs: watch.afterMs ?? null, manualContinue: manual, done: end.done, endS: Math.round(end.endMs / 1000), lastStep: end.last ?? null,
		groups: graded.groups, crashed, fault: { ...fault, atS: Math.round((faultAt - t0) / 100) / 10, tookMs: faultEnd - faultAt, phaseAtFault: phaseAtFault ? `${phaseAtFault.step}:${phaseAtFault.phase}` : null },
		uiAfterFault, uiAfterWatch, threadAfterWatch, processesAtFault, threadTail: thread.slice(-500), finalHasLedgerOk: /ledger-ok/.test(thread.slice(-400)),
		captureSteps: rows.map(r => `${r.n}:${r.step}${r.attempt > 1 ? `#${r.attempt}` : ''}:${r.status}`),
	});
	stopBrain();
}

if (cmd === 'launch') {
	console.log(JSON.stringify(await launch()));
} else if (cmd === 'stop') {
	await stopInstance();
	try { execSync(`pkill -f "brain.mjs --port ${REPLAY}"`); } catch { }
	console.log('stopped');
} else if (cmd === 'storage') {
	console.log(writeStorage() ? 'storage written' : 'no application.vscdb yet: launch once, stop, then run storage');
} else if (cmd === 'c2') {
	await c2(id);
} else if (cmd === 'c4' || cmd === 'c5' || cmd === 'c6') {
	await faultTest(cmd, id);
} else if (cmd === 'shot') {
	const c = await cdp();
	console.log(await shot(c, id ?? `${W}/shot.png`));
	c.close();
} else if (cmd === 'eval') {
	const c = await cdp();
	console.log(JSON.stringify(await c.evaluate(id), null, 1));
	c.close();
} else if (cmd === 'procs') {
	console.log(processes(id).map(p => `${p.pid} ${p.ppid} ${p.role} ${p.exe} agent=${p.agent} cwd=${p.cwd ?? ''} :: ${p.cmd.slice(0, 110)}`).join('\n'));
} else {
	console.log('usage: run.mjs --arm r8|dev launch | storage | c2 <id> | c4 <id> | c5 <id> | c6 <id> | stop | shot | eval <js> | procs [repo]');
}
