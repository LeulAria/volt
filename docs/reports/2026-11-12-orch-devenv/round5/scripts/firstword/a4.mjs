// A4 First Word (ADEMark method, unofficial, in-app timing), round 5: ADEMark's A4 sequence (TESTS.md A4, its
// runRep): New Chat (Cmd+N), 1.5 s, type `replay:hi` key by key, 0.4 s, Enter; time until `LEDGERMARK` is in the
// transcript. Three readings of "on screen": the DOM poll of round 3's ADEMark-method runner (a CDP read every ~4 ms,
// midpoint of its round trip: `pollMs`), the DOM insert (`domMs`) and two animation frames after it (`totalMs`, round
// 4's). Split with the replay server's request log: before = request received - Enter, onScreen = total - before.
// Keys go in over CDP (round 3's choice: the user works at this Mac, native keys would need the window in front).
//   node a4.mjs <arm> <runs>   (rows appended to data/firstword/a4.jsonl)
import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { cdp, DATA, focusComposer, load, newChat, replayRequests, sleep, UD, median } from './lib.mjs';

const [arm = 'dev', runsArg = '6'] = process.argv.slice(2);
mkdirSync(DATA, { recursive: true });

/** Wall-clock offset of the replay server's clock (CLOCK_UPTIME_RAW): wall_ns = t_ns + offset. */
function clockOffsetNs() {
	const [wall, up] = execFileSync('python3', ['-c', 'import time; a=time.clock_gettime_ns(time.CLOCK_UPTIME_RAW); w=time.time_ns(); b=time.clock_gettime_ns(time.CLOCK_UPTIME_RAW); print(w, (a+b)//2)'], { encoding: 'utf8' }).trim().split(' ').map(BigInt);
	return wall - up;
}

export const INSTALL_PROBE = `(() => {
	const now = () => Date.now(); // wall clock, the clock of t0 and the replay log (timeOrigin + now() drifts from it)
	const s = window.__a4 = { enter: 0, dom: 0, raf1: 0, raf2: 0, wsSend: 0, wsFrame: 0 };
	window.addEventListener('keydown', e => { if (e.key === 'Enter' && !s.enter) { s.enter = now(); } }, { capture: true, once: true });
	// The agent server connection: the first frame the renderer sends after Enter (the run request) and the
	// first frame it receives that holds the marker, so the server-to-screen part splits into wire and render.
	if (!window.__a4ws) {
		window.__a4ws = true;
		const dec = new TextDecoder();
		const send = WebSocket.prototype.send;
		WebSocket.prototype.send = function (data) {
			const a4 = window.__a4;
			if (a4?.enter && !a4.wsSend) { a4.wsSend = Date.now(); }
			if (!this.__a4) {
				this.__a4 = true;
				this.addEventListener('message', e => {
					const a = window.__a4;
					if (!a || a.wsFrame || !a.enter) { return; }
					const d = e.data;
					const text = typeof d === 'string' ? d : d instanceof ArrayBuffer ? dec.decode(d) : '';
					if (text.includes('LEDGERMARK')) { a.wsFrame = Date.now(); }
				});
			}
			return send.call(this, data);
		};
	}
	const hit = n => (n.nodeType === 3 ? n.data : n.textContent || '').includes('LEDGERMARK');
	const mo = new MutationObserver(list => {
		if (s.dom) { return; }
		for (const m of list) {
			if ((m.type === 'characterData' && hit(m.target)) || [...m.addedNodes].some(hit)) {
				s.dom = now();
				mo.disconnect();
				requestAnimationFrame(() => { s.raf1 = now(); requestAnimationFrame(() => { s.raf2 = now(); }); });
				return;
			}
		}
	});
	mo.observe(document.body, { subtree: true, childList: true, characterData: true });
	return true;
})()`;

function lastTrace(after) {
	const dir = join(UD, 'User', 'voltTraces');
	if (!existsSync(dir)) {
		return undefined;
	}
	const files = readdirSync(dir).filter(n => n.endsWith('.jsonl') && !after.has(n));
	for (const f of files) {
		const lines = readFileSync(join(dir, f), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
		const m = lines.filter(l => l.kind === 'metrics').map(l => l.metrics).at(-1);
		if (m) {
			const ev = lines.filter(l => l.kind === 'event');
			const at = type => ev.find(l => l.event.type === type)?.ts;
			return { chat: f.replace(/\.jsonl$/, ''), serverAt: { runStart: at('run.start'), running: ev.find(l => l.event.type === 'lifecycle' && l.event.phase === 'running')?.ts, textEnd: at('text.end') }, metrics: { agentSource: m.agentSource, preparedMs: m.preparedMs, agentReadyMs: m.agentReadyMs, promptMs: m.promptMs, firstEventMs: m.firstEventMs, firstTextMs: m.firstTextMs, totalMs: m.totalMs } };
		}
	}
	return undefined;
}

async function once(c, rep) {
	// LOAD_MAX=<n>: a run starts only once the 1-minute load is at most n (the brief: no timing above 14).
	const loadMax = Number(process.env.LOAD_MAX ?? 0);
	while (loadMax && Number(load().split(/\s+/)[0]) > loadMax) { await sleep(15_000); }
	const traces = join(UD, 'User', 'voltTraces');
	const before = new Set(existsSync(traces) ? readdirSync(traces) : []);
	await c.key('n', 'KeyN', 78, 4);
	await sleep(1500);
	if (!await focusComposer(c)) {
		throw new Error('no composer');
	}
	for (const ch of 'replay:hi') {
		await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
		await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
		await sleep(50);
	}
	await sleep(400);
	await c.evaluate(INSTALL_PROBE);
	const offset = clockOffsetNs();
	const loadAvg = load();
	const fromNs = BigInt(Date.now()) * 1_000_000n - offset;
	const t0 = Date.now();
	await c.key('Enter', 'Enter', 13, 0, '\r');
	// Round 3's reading: poll the answer text, midpoint of each read's round trip.
	let pollMs = null;
	for (const end = Date.now() + 30_000; Date.now() < end;) {
		const a = Date.now();
		const seen = await c.evaluate(`[...document.querySelectorAll('.volt-agent-editor .volt-agent-reply')].some(e => e.offsetParent && e.textContent.includes('LEDGERMARK'))`);
		const b = Date.now();
		if (seen) { pollMs = (a + b) / 2 - t0; break; }
		await sleep(4);
	}
	let s;
	for (let i = 0; i < 300; i++) {
		s = await c.evaluate('window.__a4');
		if (s?.raf2) {
			break;
		}
		await sleep(50);
	}
	const req = replayRequests(fromNs).find(r => r.session === 'hi' && r.path === '/v1/messages');
	const tReq = req ? Number((BigInt(Math.round(req.t_ns)) + offset) / 1_000_000n) : null;
	const first = replayRequests(fromNs)[0];
	const tFirstReq = first ? Number((BigInt(Math.round(first.t_ns)) + offset) / 1_000_000n) : null;
	await sleep(2500);
	const trace = lastTrace(before);
	const rel = v => (typeof v === 'number' ? v - t0 : null);
	if (trace?.serverAt) {
		trace.serverAt = Object.fromEntries(Object.entries(trace.serverAt).map(([k, v]) => [k, rel(v)]));
	}
	const row = {
		arm, rep, at: new Date(t0).toISOString(), load: loadAvg,
		totalMs: s?.raf2 ? Math.round(s.raf2 - t0) : null,
		pollMs,
		domMs: s?.dom ? Math.round(s.dom - t0) : null,
		enterEventMs: s?.enter ? Math.round(s.enter - t0) : null,
		wsSendMs: s?.wsSend ? Math.round(s.wsSend - t0) : null,
		wsFrameMs: s?.wsFrame ? Math.round(s.wsFrame - t0) : null,
		beforeRequestMs: tReq ? tReq - t0 : null,
		onScreenMs: tReq && s?.raf2 ? Math.round(s.raf2 - tReq) : null,
		firstAnyRequestMs: tFirstReq ? tFirstReq - t0 : null,
		requests: replayRequests(fromNs).filter(r => r.path === '/v1/messages').map(r => ({ session: r.session, atMs: Number((BigInt(Math.round(r.t_ns)) + offset) / 1_000_000n) - t0, bytes: r.bytes })),
		...trace,
	};
	appendFileSync(join(DATA, 'a4.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify({ rep, totalMs: row.totalMs, pollMs, beforeRequestMs: row.beforeRequestMs, onScreenMs: row.onScreenMs, domMs: row.domMs, wsSendMs: row.wsSendMs, wsFrameMs: row.wsFrameMs, serverAt: row.serverAt, metrics: row.metrics, load: loadAvg }));
	return row;
}

const c = await cdp();
const rows = [];
for (let i = 0; i < Number(runsArg); i++) {
	try {
		rows.push(await once(c, i));
	} catch (err) {
		console.log('run failed', String(err));
	}
	await sleep(1500);
}
c.close();
console.log(JSON.stringify({ arm, n: rows.length, totalMs: median(rows.map(r => r.totalMs)), pollMs: median(rows.map(r => r.pollMs)), beforeRequestMs: median(rows.map(r => r.beforeRequestMs)), onScreenMs: median(rows.map(r => r.onScreenMs)) }));
