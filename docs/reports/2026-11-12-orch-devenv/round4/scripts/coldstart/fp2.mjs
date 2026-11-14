// First paint -> restored chat visible / composer typeable, measured inside the page from its very first frame.
// The rig connects to the app's browser-level CDP endpoint as soon as it is up, auto-attaches to the window's page
// with the page paused at start, installs a per-frame probe (Page.addScriptToEvaluateOnNewDocument), then lets it run.
// The probe records, per animation frame: the first frame, the first frame showing a reply row of the restored chat
// (from the window snapshot or the workbench), and the first frame where a composer takes keys (the snapshot's text
// area, or the real composer focused). Times are ms after the launch (t0, wall clock).
//   node fp2.mjs <arm> <out.jsonl> [label]
import { spawnSync } from 'child_process';
import { appendFileSync } from 'fs';
const [arm, outFile, label = ''] = process.argv.slice(2);
const RUN = '/Users/leularia/Desktop/VOLT/volt-e4-coldstart/docs/reports/2026-11-12-orch-devenv/round4/scripts/coldstart/run.ts';
const PORT = 9944;
const PROBE = `(() => {
	const now = () => performance.timeOrigin + performance.now();
	const s = window.__fp = { first: 0, transcript: 0, transcriptFrom: '', composer: 0, composerFrom: '', real: 0, frames: 0 };
	const inView = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
	const tick = () => {
		const t = now(); s.frames++;
		if (!s.first) s.first = t;
		const snap = document.getElementById('volt-window-snapshot');
		const realShown = document.body && !document.body.classList.contains('volt-window-snapshot-shown');
		if (!s.transcript) {
			const fromSnap = snap && [...snap.querySelectorAll('.volt-agent-reply, .volt-agent-user-message, .volt-agent-message')].some(inView);
			const real = realShown && [...document.querySelectorAll('body > .monaco-workbench .volt-agent-editor .volt-agent-reply')].some(inView);
			if (fromSnap || real) { s.transcript = t; s.transcriptFrom = fromSnap ? 'snapshot' : 'workbench'; }
		}
		const a = document.activeElement;
		const realComposer = realShown && a && a.closest && a.closest('.volt-agent-composer .monaco-editor');
		if (!s.composer && (a && a.id === 'volt-window-snapshot-input' || realComposer)) { s.composer = t; s.composerFrom = realComposer ? 'workbench' : 'snapshot'; }
		if (!s.real && realComposer) s.real = t;
		if (!(s.transcript && s.real)) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
})()`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
spawnSync('bun', [RUN, '--app', arm, '--launch'], { env: { ...process.env, ADE_KEEP_RENDERING: '1' } });
let ws;
for (;;) {
	try {
		const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
		ws = new WebSocket(v.webSocketDebuggerUrl);
		await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
		break;
	} catch { await sleep(5); }
}
const browserAt = Date.now() - t0;
let id = 0; const pending = new Map();
const sessions = [];
let pageSession;
const send = (method, params = {}, sessionId) => new Promise(r => { const i = ++id; const timer = setTimeout(() => { pending.delete(i); r({ timeout: true }); }, 2000); pending.set(i, m => { clearTimeout(timer); r(m); }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
let firstAttach;
ws.addEventListener('message', async e => {
	const m = JSON.parse(e.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
	if (m.method === 'Target.attachedToTarget') {
		const { sessionId, targetInfo, waitingForDebugger } = m.params;
		if (targetInfo.type === 'page') {
			// Every page gets the probe: at start a window's page has no URL yet.
			sessions.push(sessionId);
			firstAttach ??= { waitingForDebugger, at: Date.now() - t0 };
			// Sent in order without waiting: a page paused at start answers only once it runs.
			void send('Page.enable', {}, sessionId);
			void send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE }, sessionId);
			if (!waitingForDebugger) { void send('Runtime.evaluate', { expression: `window.__fp || ${PROBE}` }, sessionId); }
		}
		if (waitingForDebugger) { void send('Runtime.runIfWaitingForDebugger', {}, sessionId); }
	}
});
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
let fp;
const end = Date.now() + 60_000;
while (Date.now() < end) {
	for (const sessionId of sessions) {
		const v = (await send('Runtime.evaluate', { expression: '/workbench/.test(location.href) ? JSON.stringify(window.__fp || null) : "skip"', returnByValue: true }, sessionId)).result?.result?.value;
		if (v && v !== 'skip') { pageSession = sessionId; fp = JSON.parse(v); }
	}
	if (fp?.transcript && fp?.real) { break; }
	await sleep(50);
}
const info = firstAttach ?? {};
const marks = JSON.parse((await send('Runtime.evaluate', { expression: `JSON.stringify(Object.fromEntries(performance.getEntriesByType('mark').filter(m=>/didStartRenderer|didShowPartsSplash|WindowSnapshot|didLoadWorkbenchMain|didStartWorkbench/.test(m.name)).map(m=>[m.name.replace('code/',''), Math.round(performance.timeOrigin+m.startTime)])))`, returnByValue: true }, pageSession)).result.result.value);
const rel = v => (v ? Math.round(v - t0) : null);
const load = Number(/load averages?: ([\d.]+)/.exec(spawnSync('uptime').stdout.toString())?.[1]);
const row = {
	arm, label, at: new Date(t0).toISOString(), load, browserAt, attachedAt: info.at, pausedAtStart: info.waitingForDebugger,
	firstFrame: rel(fp?.first), transcript: rel(fp?.transcript), transcriptFrom: fp?.transcriptFrom, composer: rel(fp?.composer), composerFrom: fp?.composerFrom, realComposer: rel(fp?.real),
	firstFrameToTranscript: fp?.transcript && fp?.first ? Math.round(fp.transcript - fp.first) : null,
	firstFrameToComposer: fp?.composer && fp?.first ? Math.round(fp.composer - fp.first) : null,
	firstFrameToRealComposer: fp?.real && fp?.first ? Math.round(fp.real - fp.first) : null,
	marks: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, rel(v)])),
};
appendFileSync(outFile, JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
process.exit(0);
