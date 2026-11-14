// ADEMark Track C reliability tests on Volt (C2 message delivery, C3 chat lock, C4 agent killed, C5 network cut,
// C6 app restart), ADEMark method, unofficial. Shares the C1 rig's instance, clean Claude config and capture proxy
// (../c1: VOLT_UD, VOLT_CDP, C1_DIR, proxy on 19972).
//   node crel.mjs run <C2|C4|C5|C6> <id> [--model-row 'Opus 5.5 Medium'] [--no-probe] [--checkout <volt checkout>]
//   node crel.mjs grade <C2|C4|C5|C6> <repo>          grade a finished run's checkout again (own tests)
// A run: a fresh clone of the arena becomes a new chat's project; the task prompt (tasks/<task>/prompt.md, byte for
// byte) is pasted and sent; t0 is taken just before Enter. Then, per TESTS.md 4:
//   C2: follow-ups F1-F3 pasted and sent (Enter, the default send) at t0+30/90/150 s; accepted = the text shows in
//       the thread within 5 s; queued = Volt shows it in its queue card; delivered = the text is in a later captured
//       model request; applied = its own hidden test passes.
//   C3: every 2 s one probe character typed into the composer, its echo timed (DOM: the composer shows it), deleted
//       at once; a lock is a probe with no echo within 2 s. Paused 3 s around each C2 follow-up and each fault.
//   C4: at t0+90 s kill -9 the agent process of the thread (basename claude, cwd = the task clone), as ADEMark's
//       fault injector does with its default agent executables.
//   C5: at t0+90 s the proxy cuts the model API for 30 s (in-flight streams cut, new connections reset), not pf.
//   C6: at t0+90 s Cmd-Q (a normal Quit); 5 s after exit the app is launched again and the thread reopened.
//   Recovery: 60 s after the fault, or after the API is back, with no new model request from the chat, "continue"
//   is sent once (manual). Survival: pass (no manual action, tests pass), partial (manual or work lost), fail.
// End: the chat ran at least once, nothing is running or queued, and no model request for 60 s; cap 10 min (C2) /
// 15 min (C4-C6). Grade (TESTS.md 4): the checkout's state, pristine test/ plus our own hidden tests (ADEMark's are
// private), TZ=UTC node --test per group.
import { execSync, spawn, spawnSync } from 'child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ADEMARK, ARENA, ARENA_BASE, bodyOf, CFG, isCompletion, loadAvg, PROXY, readJsonl, rowsBetween, RUNS, sleep } from '../c1/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '../../../data/orch/crel');
const UD = process.env.VOLT_UD ?? join(process.env.HOME, '.volt-r6/orch/ud');
const EXT = process.env.VOLT_EXT ?? `${UD}-ext`;
const PORT = Number(process.env.VOLT_CDP ?? 9971);
const USER = join(UD, 'User');
const opt = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const flag = name => process.argv.includes(name);

const TASKS = {
	C2: { folder: 'C2-message-delivery', groups: ['w1-limiter', 'w1-api', 'c2-f1', 'c2-f2', 'c2-f3'], capMs: 10 * 60_000 },
	C4: { folder: 'C4-agent-killed', groups: ['w3-cursor'], capMs: 15 * 60_000 },
	C5: { folder: 'C5-network-cut', groups: ['w3-cursor'], capMs: 15 * 60_000 },
	C6: { folder: 'C6-app-restart', groups: ['w3-cursor'], capMs: 15 * 60_000 },
};
const FOLLOWUPS = [{ id: 'C2-F1', atS: 30, file: 'F1.md' }, { id: 'C2-F2', atS: 90, file: 'F2.md' }, { id: 'C2-F3', atS: 150, file: 'F3.md' }];
const FAULT_AT_MS = 90_000;
const CUT_MS = 30_000;
const RECOVERY_WAIT_MS = 60_000;
const QUIET_MS = 60_000;
const PROBE_INTERVAL_MS = 2000;
const PROBE_CHAR = 'z';

// ---------- CDP ----------

async function cdp() {
	const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
	const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url) && t.title);
	if (!page) { throw new Error('no workbench target'); }
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
	let n = 0;
	const pending = new Map();
	ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
	const send = (method, params = {}) => new Promise(r => { const i = ++n; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
	const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
	const key = async (key, code, vk, modifiers = 0, text) => {
		await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
		await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
	};
	return { send, evaluate, key, close: () => ws.close() };
}

const COMPOSER = `[...document.querySelectorAll('textarea.inputarea')].filter(e => e.offsetParent).at(-1)`;
const composerText = c => c.evaluate(`(() => [...document.querySelectorAll('.volt-agent-composer .view-lines')].filter(e => e.offsetParent).at(-1)?.textContent ?? '')()`);
const composerFocused = c => c.evaluate(`(() => { const t = ${COMPOSER}; return !!t && document.activeElement === t; })()`);
const focusComposer = c => c.evaluate(`(() => { const t = ${COMPOSER}; if (!t) { return false; } t.focus(); return document.activeElement === t; })()`);
const pageText = c => c.evaluate('document.body.innerText');
const enter = async c => {
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
/** A paste (as ADEMark's harness pastes): the composer's auto-indent re-indents typed bullets. */
const paste = (c, text) => c.evaluate(`(() => { const t = ${COMPOSER}; if (!t) { return false; } t.focus(); const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)}); t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);

async function pickProject(c, folder) {
	const name = folder.split('/').at(-1);
	const shown = () => c.evaluate(`(() => [...document.querySelectorAll('*')].some(e => e.offsetParent && e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(name)} && /label|project/.test(e.className)))()`);
	const opened = await c.evaluate(`(() => { const e = [...document.querySelectorAll('button.volt-agent-landing-pick')].filter(e => e.offsetParent && e.querySelector('.label')).at(0); if (!e) { return false; } e.click(); return true; })()`);
	if (!opened) { throw new Error('no project picker'); }
	let focused = false;
	for (let i = 0; i < 40 && !focused; i++) {
		await sleep(250);
		focused = await c.evaluate(`(() => { const i = [...document.querySelectorAll('input')].filter(e => e.offsetParent && /search projects/i.test(e.placeholder)).at(-1); i?.focus(); i?.select(); return !!i && document.activeElement === i; })()`);
	}
	if (!focused) { throw new Error('the project search box did not open'); }
	await c.send('Input.insertText', { text: folder });
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		if (await c.evaluate(`[...document.querySelectorAll('.monaco-list-row')].some(e => e.offsetParent && ((e.getAttribute('aria-label') ?? '').endsWith(${JSON.stringify(folder)}) || /^Open /.test(e.textContent.trim())))`)) { break; }
	}
	const picked = await c.evaluate(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && (e.getAttribute('aria-label') ?? '').endsWith(${JSON.stringify(folder)})).at(-1) ?? [...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && /^Open /.test(e.textContent.trim())).at(-1); r?.click(); return !!r; })()`);
	await sleep(1500);
	if (!picked || !await shown()) { throw new Error(`could not pick the project ${folder}`); }
}

async function pickModel(c, rowLabel) {
	const chipText = () => c.evaluate(`(() => [...document.querySelectorAll('.volt-agent-model')].filter(e => e.offsetParent).at(-1)?.textContent.replace(/\\s+/g, ' ').trim() ?? '')()`);
	const same = text => text.replace(/\s+/g, '') === rowLabel.replace(/\s+/g, '');
	if (same(await chipText())) { return rowLabel; }
	await c.evaluate(`(() => { [...document.querySelectorAll('.volt-agent-model')].filter(e => e.offsetParent).at(-1)?.click(); })()`);
	await sleep(1200);
	const at = await c.evaluate(`(() => { const e = [...document.querySelectorAll('.monaco-list-row *')].filter(e => e.offsetParent && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim() === ${JSON.stringify(rowLabel)})).at(0); if (!e) { return null; } const r = e.getBoundingClientRect(); return [r.x + 20, r.y + r.height / 2]; })()`);
	if (!at) { throw new Error(`no model row ${rowLabel}`); }
	for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
		await c.send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
	}
	await sleep(1000);
	const shown = await chipText();
	if (!same(shown)) { throw new Error(`model chip shows "${shown}", not "${rowLabel}"`); }
	return shown;
}

const chips = c => c.evaluate(`(() => ({ model: [...document.querySelectorAll('.volt-agent-model-label')].filter(e => e.offsetParent).map(e => e.textContent.trim()), access: [...document.querySelectorAll('button.volt-agent-status-access')].filter(e => e.offsetParent).map(e => e.getAttribute('aria-label') + ' / ' + (e.dataset.mode ?? '')) }))()`);
const shot = async (c, file) => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(file, Buffer.from(s.result.data, 'base64')); };

// ---------- the instance (as ../c1/runvolt.mjs launch) ----------

async function launch(checkout) {
	const env = {
		HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.USER, SHELL: process.env.SHELL ?? '/bin/zsh', LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR,
		PATH: process.env.PATH, VSCODE_SKIP_PRELAUNCH: '1', CLAUDE_CONFIG_DIR: CFG, ANTHROPIC_BASE_URL: PROXY,
	};
	const log = openSync(join(UD + '-dev.log'), 'a');
	const child = spawn('./scripts/code.sh', ['--user-data-dir', UD, '--extensions-dir', EXT, `--remote-debugging-port=${PORT}`,
		'--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'],
		{ cwd: checkout, env, detached: true, stdio: ['ignore', log, log] });
	child.unref();
	const t0 = Date.now();
	for (let i = 0; i < 180; i++) {
		await sleep(1000);
		try {
			const c = await cdp();
			const ok = await c.evaluate('document.readyState === "complete" && !!document.querySelector(".monaco-workbench")');
			c.close();
			if (ok) { return { pid: child.pid, ms: Date.now() - t0 }; }
		} catch { }
	}
	throw new Error('test instance did not come up');
}

/** The instance's processes (matched on the profile path), for the C6 quit check. */
function instancePids() {
	const esc = UD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const mine = new RegExp(`(--user-data-dir[ =]|--volt-user-data-dir=)${esc}(\\s|$)`);
	return execSync('ps -axo pid=,command=').toString().split('\n').filter(l => mine.test(l) && !/crel\.mjs|runvolt\.mjs|grep /.test(l)).map(l => Number(l.trim().split(/\s+/)[0])).filter(pid => pid && pid !== process.pid);
}

// ---------- processes of the thread (C4) ----------

/** Every process whose cwd is `repo`: pid, command, basename (one lsof call, as ADEMark's kill-agent.ts). */
function processesIn(repo) {
	const out = execSync('lsof -a -d cwd -Fpn 2>/dev/null || true', { maxBuffer: 64 * 1024 * 1024 }).toString();
	const pids = [];
	let pid = null;
	for (const line of out.split('\n')) {
		if (line.startsWith('p')) { pid = Number(line.slice(1)); }
		else if (line.startsWith('n') && pid && line.slice(1).trim() === repo) { pids.push(pid); }
	}
	const commands = new Map(execSync('ps -axo pid=,command=').toString().split('\n').map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf(' '); return [Number(l.slice(0, i)), l.slice(i + 1)]; }));
	return pids.map(pid => ({ pid, command: (commands.get(pid) ?? '').slice(0, 200), name: (commands.get(pid) ?? '').split(' ')[0].split('/').at(-1) }));
}

// ---------- traces, sessions, capture ----------

const readTrace = chat => readJsonl(join(USER, 'voltTraces', `${chat}.jsonl`));
const sessionsDir = join(USER, 'agentSessions', 'sessions');
const newRootSession = before => readdirSync(sessionsDir).filter(n => n.endsWith('.jsonl') && !before.has(n)).find(n => { try { return !JSON.parse(readFileSync(join(sessionsDir, n), 'utf8').split('\n')[0]).parentId; } catch { return false; } })?.replace(/\.jsonl$/, '');
/** The chat's model requests in the capture: rows whose first user message carries the task text (lead) or any row of its Claude session. */
function chatRows(fromMs, toMs, sessions) {
	return rowsBetween(fromMs, toMs).filter(r => isCompletion(r) && r.meta && (r.meta.task || sessions.has(r.meta.session)));
}
/**
 * The Claude sessions the task ran on (a resumed or restarted chat may get a new session id): every coding session
 * whose first request after t0 carries the task prompt (one body read per new session; the capture's `meta.task`
 * flag knows only C1's wording).
 */
const sessionBodies = new Map();
function taskSessions(fromMs, needleText) {
	// The run's clone path, not the prompt: every run of a test sends the same prompt (a session of an earlier
	// run was taken for this one's).
	const needle = JSON.stringify(needleText).slice(1, -1);
	const out = new Set();
	const seen = new Set();
	for (const r of rowsBetween(fromMs).filter(r => isCompletion(r) && r.meta?.coding && r.meta.session)) {
		const s = r.meta.session;
		if (seen.has(s)) { continue; }
		seen.add(s);
		if (!sessionBodies.has(s)) {
			const b = bodyOf(r);
			sessionBodies.set(s, !!b && JSON.stringify(b.messages?.[0] ?? '').includes(needle));
		}
		if (sessionBodies.get(s)) { out.add(s); }
	}
	return out;
}
/** True when some model request made after `sinceMs` carries `text` in a user message. */
function deliveredAfter(sinceMs, text, sessions) {
	const needle = JSON.stringify(text.trim()).slice(1, -1).slice(0, 120);
	return chatRows(sinceMs, Infinity, sessions).some(r => { const b = bodyOf(r); return !!b && JSON.stringify(b.messages ?? []).includes(needle); });
}

// ---------- grading (TESTS.md 4, own tests) ----------

export function gradeRun(test, repo) {
	const groups = TASKS[test].groups;
	const git = (...args) => execSync(`git -C ${JSON.stringify(repo)} ${args.join(' ')}`, { encoding: 'utf8' }).trim();
	const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
	const work = mkdtempSync(join(tmpdir(), 'crel-grade-'));
	try {
		// The thread's checkout at the end, uncommitted changes included (TESTS.md 4: the thread's worktree or branch).
		cpSync(repo, work, { recursive: true, filter: src => !src.includes('/.git/') && !src.endsWith('/.git') && !src.includes('/node_modules/') });
		const diff = git('diff', '--stat', 'HEAD', '--', '.', '":(exclude)test"').length + git('log', '--oneline', 'main@{0}..HEAD', '2>/dev/null', '||', 'true').length + git('status', '--porcelain').length;
		const pristine = readdirSync(join(ARENA, 'test'));
		const testsModified = pristine.some(name => !existsSync(join(work, 'test', name)) || readFileSync(join(work, 'test', name), 'utf8') !== readFileSync(join(ARENA, 'test', name), 'utf8'));
		for (const name of pristine) { cpSync(join(ARENA, 'test', name), join(work, 'test', name)); }
		for (const name of readdirSync(join(here, 'tests'))) { cpSync(join(here, 'tests', name), join(work, 'test', `hidden-${name}`)); }
		const env = { ...process.env, TZ: 'UTC' };
		const files = {};
		for (const name of groups) {
			const r = spawnSyncSafe(process.execPath, ['--test', `test/hidden-${name}.test.ts`], { cwd: work, env, timeout: 120_000 });
			const failed = [...(r.stdout ?? '').matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);
			files[name] = { pass: r.status === 0, failed, tail: r.status === 0 ? undefined : (r.stdout + r.stderr).split('\n').filter(l => /not ok|Error|expected|actual/.test(l)).slice(0, 12).join('\n') };
		}
		const full = spawnSyncSafe('npm', ['test', '--silent'], { cwd: work, env, timeout: 300_000 });
		const result = { branch, changed: diff > 0, testsModified, files, npmTest: { status: full.status, summary: (full.stdout ?? '').split('\n').filter(l => /^# (tests|pass|fail)/.test(l)).join(' ') } };
		if (test === 'C2') {
			result.groups = { W1: files['w1-limiter'].pass && files['w1-api'].pass, 'C2-F1': files['c2-f1'].pass, 'C2-F2': files['c2-f2'].pass, 'C2-F3': files['c2-f3'].pass };
			result.applied = ['C2-F1', 'C2-F2', 'C2-F3'].filter(g => result.groups[g]).length;
		} else {
			result.groups = { W3: files['w3-cursor'].pass };
		}
		return result;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

function spawnSyncSafe(cmd, args, options) {
	const r = spawnSync(cmd, args, { ...options, encoding: 'utf8' });
	return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------- the C3 probe ----------

/**
 * One probe: the character typed as a key, its echo timed on the DOM (the composer shows it), then deleted.
 * `ms` null = no echo within 2 s (a lost probe). `refocused`: the composer had lost the focus and was focused again
 * first (ADEMark's harness clicks `focusClick` for that), counted apart.
 */
async function probeOnce(c) {
	let refocused = false;
	if (!await composerFocused(c)) { refocused = await focusComposer(c); }
	const t = Date.now();
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: PROBE_CHAR, code: 'KeyZ', windowsVirtualKeyCode: 90, text: PROBE_CHAR, unmodifiedText: PROBE_CHAR });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: PROBE_CHAR, code: 'KeyZ', windowsVirtualKeyCode: 90 });
	// The echo: polled in the page itself (one round trip), up to 2 s.
	const ms = await c.evaluate(`new Promise(resolve => { const t0 = performance.now(); const tick = () => { const el = [...document.querySelectorAll('.volt-agent-composer .view-lines')].filter(e => e.offsetParent).at(-1); if (el && el.textContent.includes(${JSON.stringify(PROBE_CHAR)})) { resolve(Math.round(performance.now() - t0)); } else if (performance.now() - t0 > 2000) { resolve(null); } else { requestAnimationFrame(tick); } }; tick(); })`);
	await c.key('Backspace', 'Backspace', 8);
	// Whatever is left of the probe (a late echo) goes too, so the composer stays empty for the next send.
	const left = await composerText(c);
	if (left.includes(PROBE_CHAR)) { await c.key('Backspace', 'Backspace', 8); }
	return { t, ms: ms ?? null, refocused };
}

// ---------- the run ----------

async function run(test, id) {
	const spec = TASKS[test];
	if (!spec) { throw new Error(`unknown test ${test}`); }
	const repo = join(RUNS, id);
	if (existsSync(repo)) { throw new Error(`${repo} exists`); }
	mkdirSync(DATA, { recursive: true });
	mkdirSync(join(DATA, 'shots'), { recursive: true });
	execSync(`git clone -q ${ARENA_BASE} ${repo} && git -C ${repo} remote remove origin`);
	const prompt = readFileSync(join(ADEMARK, 'tasks', spec.folder, 'prompt.md'), 'utf8');
	const followups = test === 'C2' ? FOLLOWUPS.map(f => ({ ...f, text: readFileSync(join(ADEMARK, 'tasks', spec.folder, 'followups', f.file), 'utf8').trim() })) : [];
	writeFileSync(join(DATA, `${id}.prompt.txt`), prompt);
	const probe = !flag('--no-probe');
	const events = [];
	const log = (type, data = {}) => { const e = { at: Date.now() - (state.t0 ?? Date.now()), type, ...data }; events.push(e); console.log(JSON.stringify(e)); };
	const state = { id, test, repo, probes: [], followups: [], fault: undefined, recovery: undefined };

	let c = await cdp();
	const okNew = await c.evaluate(`(() => { const e = [...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^New (Chat|Agent)/.test(e.getAttribute('aria-label'))); if (!e) { return false; } e.click(); return true; })()`);
	if (!okNew) { throw new Error('no New Chat button'); }
	await sleep(1500);
	await pickProject(c, repo);
	await sleep(1000);
	const modelChip = await pickModel(c, opt('--model-row', 'Opus 5.5 Medium'));
	const shown = { ...await chips(c), modelChip };
	if (!shown.access.some(a => /full-access/.test(a))) { throw new Error(`access is not Full access: ${shown.access}`); }
	if (!await focusComposer(c)) { throw new Error('no composer'); }
	await c.key('a', 'KeyA', 65, 4);
	await c.key('Backspace', 'Backspace', 8);
	await sleep(300);
	if (!await paste(c, prompt)) { throw new Error('could not paste the prompt'); }
	await sleep(600);
	mkdirSync(sessionsDir, { recursive: true });
	const before = new Set(readdirSync(sessionsDir));
	state.load = loadAvg();
	state.shown = shown;
	state.t0 = Date.now();
	await enter(c);
	log('enter');
	let chat;
	for (let i = 0; i < 120 && !chat; i++) { await sleep(250); chat = newRootSession(before); }
	if (!chat) { throw new Error('no chat'); }
	state.chat = chat;
	log('chat', { chat });
	writeFileSync(join(RUNS, `${id}.state.json`), JSON.stringify(state));

	// ---- schedule ----
	const t0 = state.t0;
	const elapsed = () => Date.now() - t0;
	const cap = t0 + spec.capMs;
	let probePausedUntil = 0;
	let nextProbe = t0 + PROBE_INTERVAL_MS;
	let nextFollowup = 0;
	let faultDone = test === 'C2';
	// --fault-at <s>: our own variant (ADEMark's fault is at 90 s; Opus 5.5 finished the W3 task in about 60 s, so
	// the 90 s fault hit an idle agent). Rows with another time say so (`faultAtS`).
	const faultAtMs = Number(opt('--fault-at', FAULT_AT_MS / 1000)) * 1000;
	state.faultAtS = faultAtMs / 1000;
	let faultAt = test === 'C2' ? undefined : t0 + faultAtMs;
	let recoveryWatchFrom;
	let resumedAlone;
	let continueSent = false;
	let sessions = new Set();
	let firstRunEnd;
	let lastRequestEnd = t0;
	let quietFrom;
	let endedAt;
	let timedOut = false;

	const reconnect = async () => { try { c.close(); } catch { } c = await cdp(); };
	const requestsSince = since => { sessions = new Set([...sessions, ...taskSessions(t0, repo)]); return chatRows(since, Infinity, sessions); };

	while (Date.now() < cap) {
		const now = Date.now();
		// Follow-ups (C2): paste, Enter, then 5 s for the text to show in the thread.
		if (nextFollowup < followups.length && elapsed() >= followups[nextFollowup].atS * 1000) {
			const f = followups[nextFollowup++];
			probePausedUntil = Date.now() + 3000;
			const r = { id: f.id, atS: f.atS, sentAt: elapsed(), attempts: 0, accepted: false, queued: false, delayMs: 0, delivered: false };
			const startedMs = Date.now();
			for (; ;) {
				r.attempts++;
				await focusComposer(c);
				await paste(c, f.text);
				await sleep(150);
				await enter(c);
				const sentAt = Date.now();
				r.delayMs = sentAt - (t0 + f.atS * 1000);
				for (let i = 0; i < 25; i++) {
					await sleep(200);
					const text = await pageText(c);
					const composer = await composerText(c);
					if (text.includes(f.text.slice(0, 60)) && !composer.includes(f.text.slice(0, 40))) { r.accepted = true; break; }
				}
				if (r.accepted || Date.now() - startedMs >= 10_000) { break; }
				await sleep(1000);
			}
			r.queued = await c.evaluate(`(() => [...document.querySelectorAll('[class*="queue"]')].some(e => e.offsetParent && e.textContent.includes(${JSON.stringify(f.text.slice(0, 40))})))()`);
			await shot(c, join(DATA, 'shots', `${id}-${f.id}.png`));
			state.followups.push(r);
			log('followup', r);
			probePausedUntil = Date.now() + 3000;
			continue;
		}
		// The fault (C4-C6) at t0 + 90 s.
		if (!faultDone && now >= faultAt) {
			faultDone = true;
			probePausedUntil = Date.now() + 3000;
			const procs = processesIn(repo);
			const fault = { at: elapsed(), processes: procs };
			if (test === 'C4') {
				const targets = procs.filter(p => p.name === 'claude');
				for (const p of targets) { try { process.kill(p.pid, 'SIGKILL'); } catch (err) { fault.error = String(err); } }
				fault.killed = targets.map(p => p.pid);
			} else if (test === 'C5') {
				fault.block = await (await fetch(`${PROXY}/__block?ms=${CUT_MS}`)).json();
			} else if (test === 'C6') {
				const pids = instancePids();
				await c.key('q', 'KeyQ', 81, 4);
				const quitAt = Date.now();
				let alive = pids;
				for (let i = 0; i < 100 && alive.length; i++) { await sleep(100); alive = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } }); }
				fault.exitMs = Date.now() - quitAt;
				fault.stillAlive = alive;
				if (alive.length) { for (const pid of alive) { try { process.kill(pid, 'SIGKILL'); } catch { } } fault.forcedKill = true; }
				await sleep(5000);
				fault.relaunch = await launch(opt('--checkout', join(here, '../../../../../..')));
				await reconnect();
				await sleep(3000);
				// Back to the thread: the restored window shows it, or its row in the chat list is clicked.
				let onThread = (await pageText(c)).includes(prompt.slice(0, 50));
				if (!onThread) {
					const clicked = await c.evaluate(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && /pagination|cursor|ledger|invoice/i.test(e.getAttribute('aria-label') ?? e.textContent)).at(0); r?.click(); return r ? (r.getAttribute('aria-label') ?? r.textContent).slice(0, 80) : null; })()`);
					await sleep(2500);
					onThread = (await pageText(c)).includes(prompt.slice(0, 50));
					fault.returnClicked = clicked;
				}
				fault.returnedToThread = onThread;
				await shot(c, join(DATA, 'shots', `${id}-after-relaunch.png`));
			}
			state.fault = fault;
			log('fault', fault);
			recoveryWatchFrom = test === 'C5' ? Date.now() + CUT_MS : Date.now();
			// A screenshot 10 s after the fault: does Volt show the failure?
			setTimeout(async () => { try { await shot(c, join(DATA, 'shots', `${id}-fault+10s.png`)); state.faultShown = { text: ((await pageText(c)).match(/(stopped|exited|crashed|failed|error|restart|interrupted|retry|reconnect|offline|network|unreachable)[^\n]{0,80}/gi) ?? []).slice(0, 8) }; log('fault+10s', state.faultShown); } catch { } }, 10_000);
			continue;
		}
		// Recovery watch: a new model request from the chat after the fault (or after the API is back) = resumed alone.
		if (recoveryWatchFrom !== undefined && resumedAlone === undefined && now >= recoveryWatchFrom - (test === 'C5' ? CUT_MS : 0)) {
			const since = test === 'C5' ? state.fault.at + t0 + CUT_MS : state.fault.at + t0;
			const fresh = requestsSince(since).filter(r => (r.status ?? 0) < 400);
			if (fresh.length) {
				resumedAlone = true;
				state.recovery = { resumedAlone: true, afterMs: fresh[0].t - since, requests: fresh.length };
				log('resumed', state.recovery);
			} else if (now >= recoveryWatchFrom + RECOVERY_WAIT_MS && !continueSent) {
				continueSent = true;
				resumedAlone = false;
				probePausedUntil = Date.now() + 3000;
				await focusComposer(c);
				await paste(c, 'continue');
				await sleep(150);
				await enter(c);
				state.recovery = { resumedAlone: false, continueSentAt: elapsed() };
				log('continue-sent', state.recovery);
				await shot(c, join(DATA, 'shots', `${id}-continue.png`));
			}
		}
		// The probe (C3), every 2 s unless paused.
		if (probe && now >= nextProbe) {
			nextProbe = now + PROBE_INTERVAL_MS;
			if (now >= probePausedUntil) {
				try {
					const p = await probeOnce(c);
					state.probes.push({ at: p.t - t0, ms: p.ms, ...(p.refocused ? { refocused: true } : {}) });
					if (p.ms === null) { log('probe-lost', { at: p.t - t0 }); }
				} catch (err) {
					state.probes.push({ at: elapsed(), ms: null, error: String(err).slice(0, 80) });
					if (test === 'C6') { try { await reconnect(); } catch { } }
				}
			}
		}
		// The end: a run ended, nothing queued or running (the trace's last event is run.end and no later run.start),
		// every follow-up sent and (fault tests) the recovery settled, and no model request for 60 s.
		const ev = readTrace(chat).filter(l => l.kind === 'event');
		const starts = ev.filter(l => l.event.type === 'run.start').length;
		const ends = ev.filter(l => l.event.type === 'run.end');
		if (ends.length && firstRunEnd === undefined) { firstRunEnd = ends[0].ts; log('first-run-end', { at: firstRunEnd - t0 }); }
		const idle = starts > 0 && ends.length >= starts;
		const rows = requestsSince(t0);
		if (rows.length) { lastRequestEnd = Math.max(lastRequestEnd, ...rows.map(r => r.t + (r.ms ?? 0))); }
		const allSent = nextFollowup >= followups.length;
		const settled = faultDone && (test === 'C2' || resumedAlone !== undefined);
		const queuedShown = await c.evaluate(`(() => [...document.querySelectorAll('[class*="queue"] .monaco-list-row, .volt-agent-queue-row')].some(e => e.offsetParent))()`).catch(() => false);
		if (idle && allSent && settled && !queuedShown) {
			quietFrom ??= Math.max(lastRequestEnd, ends.at(-1).ts);
			if (Date.now() - quietFrom >= QUIET_MS) { endedAt = quietFrom; break; }
		} else {
			quietFrom = undefined;
		}
		await sleep(250);
	}
	if (endedAt === undefined) { timedOut = true; endedAt = Math.min(Date.now(), cap); }
	await shot(c, join(DATA, 'shots', `${id}-end.png`));
	c.close();

	// ---- values ----
	sessions = new Set([...sessions, ...taskSessions(t0, repo)]);
	const rows = chatRows(t0, endedAt + 1000, sessions);
	for (const f of state.followups) { f.delivered = deliveredAfter(t0 + f.atS * 1000, f.text ?? followups.find(x => x.id === f.id).text, sessions); }
	const probes = state.probes;
	const lost = probes.filter(p => p.ms === null);
	const locks = [];
	for (let i = 0; i < probes.length;) {
		if (probes[i].ms !== null) { i++; continue; }
		const first = i;
		while (i < probes.length && probes[i].ms === null) { i++; }
		const end = i < probes.length ? probes[i].at : probes[i - 1].at;
		locks.push({ from: probes[first].at, ms: Math.max(0, end - probes[first].at) });
	}
	const graded = gradeRun(test, repo);
	const minutes = +((endedAt - t0) / 60_000).toFixed(2);
	let survival;
	if (test !== 'C2') {
		const pass = graded.groups.W3 && !timedOut;
		survival = !pass ? 'fail' : resumedAlone ? 'pass' : 'partial';
	}
	const echoed = probes.filter(p => p.ms !== null).map(p => p.ms).sort((a, b) => a - b);
	const row = {
		id, test, arm: 'volt', at: new Date(t0).toISOString(), load: state.load, chat, shown, minutes, timedOut, faultAtS: state.faultAtS,
		requests: rows.length, sessions: [...sessions], firstRunEndS: firstRunEnd && +((firstRunEnd - t0) / 1000).toFixed(1),
		...(test === 'C2' ? { followups: state.followups, dropped: state.followups.filter(f => !f.delivered).length + (followups.length - state.followups.length), applied: graded.applied } : {}),
		...(test !== 'C2' ? { fault: state.fault, faultShown: state.faultShown, recovery: state.recovery, survival } : {}),
		probe: probe ? { count: probes.length, lost: lost.length, locks: locks.length, longestLockMs: Math.max(0, ...locks.map(l => l.ms)), echoMedianMs: echoed[Math.floor(echoed.length / 2)] ?? null, echoP95Ms: echoed[Math.floor(echoed.length * 0.95)] ?? null, refocused: probes.filter(p => p.refocused).length } : undefined,
		graded: { groups: graded.groups, branch: graded.branch, testsModified: graded.testsModified, npmTest: graded.npmTest, failed: Object.fromEntries(Object.entries(graded.files).filter(([, f]) => !f.pass).map(([k, f]) => [k, (f.tail ?? '').slice(0, 300)])) },
		events,
	};
	writeFileSync(join(DATA, `${id}.probes.json`), JSON.stringify(probes));
	writeFileSync(join(DATA, `${id}.traces.json`), JSON.stringify({ lines: readTrace(chat) }));
	writeFileSync(join(DATA, `${id}.capture.jsonl`), rowsBetween(t0 - 5000, endedAt + QUIET_MS + 60_000).map(r => JSON.stringify(r)).join('\n') + '\n');
	execSync(`gzip -f ${JSON.stringify(join(DATA, `${id}.capture.jsonl`))} ${JSON.stringify(join(DATA, `${id}.traces.json`))}`);
	appendFileSync(join(DATA, 'crel-runs.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify({ id, test, minutes, timedOut, survival, dropped: row.dropped, applied: row.applied, groups: graded.groups, probe: row.probe, recovery: state.recovery }, null, 1));
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'run') {
	await run(a, b);
} else if (cmd === 'grade') {
	console.log(JSON.stringify(gradeRun(a, b), null, 1));
} else if (cmd === 'procs') {
	console.log(JSON.stringify(processesIn(a), null, 1));
} else {
	console.log('usage: crel.mjs run <C2|C4|C5|C6> <id> [--model-row ...] [--no-probe] | grade <test> <repo> | procs <repo>');
}
