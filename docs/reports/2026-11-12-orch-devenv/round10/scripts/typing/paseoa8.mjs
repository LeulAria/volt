// The same A8 measure as a8.mjs and t3a8.mjs (EventLatency of each KEY_PRESSED, key event to presented frame) on
// Paseo, so the three apps are timed by one method on this Mac. Paseo from /Applications with its own HOME (daemon
// home, Claude settings pointing at the replay server, dummy key) and Electron profile.
// Paseo's Cmd+N opens a new-workspace page that first asks for a model, so the 5 chats are started with Paseo's own
// CLI (`paseo run -d --workspace <main>`, `replay:stream-<n>`, 2 s apart) in the workspace on screen; they open as
// tabs, the front tab streams, and the 60 probe characters go to its composer (a textarea) at 250 ms +-20 %.
// Setup once (see the round-8 typing report): <P>/home copied from round 3's Paseo home, .claude/settings.json with
// ANTHROPIC_BASE_URL = the replay server, `paseo project create <P>/arena`.
//   node paseoa8.mjs [reps=1]      rows appended to data/typing/a8.jsonl with arm "paseo"
import { appendFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { join } from 'path';
import { connect, DATA, HOME, load1, median, pct, PORT, sleep, waitQuiet } from './lib.mjs';
import { keyLatencies, keyStages } from './a8.mjs';

const APP = process.env.PASEO_APP ?? '/Applications/Paseo.app';
const BIN = `${APP}/Contents/MacOS/Paseo`;
const CLI = `${APP}/Contents/Resources/bin/paseo`;
const P = `${HOME}/.volt-r8/typing/paseo`;
const env = () => {
	const e = { ...process.env };
	for (const k of Object.keys(e)) { if (/^(CLAUDE|VSCODE_|ELECTRON_RUN_AS_NODE$|ANTHROPIC_)/.test(k)) { delete e[k]; } }
	return {
		...e, HOME: `${P}/home`, DISABLE_AUTOUPDATER: '1', PASEO_ELECTRON_USER_DATA_DIR: `${P}/home/ud`,
		PASEO_ELECTRON_FLAGS: `--remote-debugging-port=${PORT} --use-mock-keychain --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling`,
	};
};
const cli = args => execSync(`'${CLI}' ${args}`, { env: env(), cwd: `${P}/arena` }).toString();
const page = async () => {
	const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
	const p = list.find(t => t.type === 'page' && /^paseo:/.test(t.url));
	if (!p) { throw new Error('no Paseo page'); }
	return connect(p.webSocketDebuggerUrl, p.id);
};
// Every Paseo process: the app, its helpers, and the supervisor/daemon it starts (they carry no path in argv).
const pids = () => execSync(`pgrep -f '^${APP}/|^Paseo (Supervisor|Daemon)' || true`).toString().trim().split('\n').filter(Boolean).map(Number);
async function stop() {
	for (const sig of ['SIGTERM', 'SIGKILL']) {
		for (const pid of pids()) { try { process.kill(pid, sig); } catch { } }
		await sleep(2500);
	}
}
const deleteAgents = () => {
	for (const id of cli('ls -a -q').split('\n').map(s => s.trim()).filter(Boolean)) { try { cli(`delete ${id}`); } catch { } }
};

async function rep() {
	const loadStart = await waitQuiet(14);
	console.log(`== paseo load ${loadStart} ${new Date().toISOString()}`);
	await stop();
	try { execSync(`git -C ${P}/arena checkout -q -- . && git -C ${P}/arena clean -qfd`); } catch { }
	const log = openSync(`${P}/app.log`, 'a');
	spawn(BIN, [], { cwd: `${P}/home`, env: env(), detached: true, stdio: ['ignore', log, log] }).unref();
	let c;
	for (let i = 0; i < 60 && !c; i++) { await sleep(1000); try { c = await page(); } catch { } }
	await sleep(8000);
	deleteAgents();
	const server = readFileSync(`${P}/home/.paseo/server-id`, 'utf8').trim();
	const wks = cli('workspace ls -q').split('\n').map(s => s.trim()).filter(Boolean)[0];
	await c.evaluate(`location.href = 'paseo://app/h/${server}/workspace/${wks}'`);
	try { c.close(); } catch { }
	await sleep(3000);
	for (let i = 0; i < 20; i++) { try { c = await page(); break; } catch { await sleep(500); } }
	await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
	const sentAt = Date.now();
	for (let n = 1; n <= 5; n++) {
		cli(`run -d -q --workspace ${wks} --provider claude --title s${n} 'replay:stream-${n}'`);
		await sleep(2000);
	}
	await sleep(8000);
	const TEXT = `document.body.innerText.length`;
	const COMPOSER = `(document.activeElement?.tagName === 'TEXTAREA' ? document.activeElement.value : '')`;
	const textBefore = await c.evaluate(TEXT);
	const focused = await c.evaluate(`(() => { const e = [...document.querySelectorAll('textarea')].filter(e => e.offsetParent && /Message the agent/.test(e.placeholder)).at(-1); e?.focus(); return !!e && document.activeElement === e; })()`);
	const loadTyping = load1();
	const traced = [];
	c.on('Tracing.dataCollected', p => { for (const e of p.value) { if (e.ph === 'b' || e.ph === 'e' || e.name === 'EventLatency') { traced.push(e); } } });
	const traceDone = new Promise(r => c.on('Tracing.tracingComplete', r));
	await c.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: ['latencyInfo', 'input', 'benchmark'] } });
	await sleep(300);
	const PROBE_CHARS = 'abcdefghijklmnopqrstuvwxyz';
	for (let i = 0; i < 60; i++) {
		const ch = PROBE_CHARS[i % PROBE_CHARS.length];
		const code = ch.toUpperCase().charCodeAt(0);
		await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: ch });
		await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
		await sleep(250 * (0.8 + Math.random() * 0.4));
	}
	await sleep(2000);
	await c.send('Tracing.end');
	await traceDone;
	const typed = (await c.evaluate(COMPOSER) ?? '').replace(/\s/g, '').length;
	const textAfter = await c.evaluate(TEXT);
	const running = (cli('ls -q').match(/\S+/g) ?? []).length;
	const loadEnd = load1();
	// Analysis aid: SMOOTH_TRACE_OUT=<file> keeps the key spans (latencyInfo) for per-key stage tools.
	if (process.env.SMOOTH_TRACE_OUT) { writeFileSync(process.env.SMOOTH_TRACE_OUT, JSON.stringify({ traceEvents: traced })); }
	const k2p = keyLatencies(traced).filter(v => v <= 2000);
	const row = {
		arm: 'paseo', app: APP, at: new Date().toISOString(), loadStart, loadTyping, loadEnd, streamingS: Math.round((Date.now() - sentAt) / 1000), focused, textBefore, textAfter, streamed: textAfter > textBefore, running,
		keys: 60, typed, missed: 60 - typed, k2pN: k2p.length, k2pP50: median(k2p), k2pP95: pct(k2p, 0.95), k2pMax: k2p.length ? Math.max(...k2p) : null, stages: keyStages(traced), k2p,
	};
	mkdirSync(DATA, { recursive: true });
	appendFileSync(join(DATA, 'a8.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify({ ...row, k2p: undefined }));
	c.close();
	try { deleteAgents(); } catch { }
	await stop();
	await sleep(5000);
}

const reps = Number(process.argv[2] ?? 1);
for (let i = 0; i < reps; i++) { await rep(); }
