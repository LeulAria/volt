// Exploratory GPU/renderer experiments on the running test instance; each prints the footprint by role before and
// after (fp.mjs), to tell what grows the GPU process with threads (round 5: +330-405 MB after seeding 15).
//   node exp.mjs pressure            a critical memory-pressure notification to every process (CDP Memory domain)
//   node exp.mjs newchats [n=10]     n New Chat clicks, nothing sent (landing + Orbit only)
//   node exp.mjs seeds [n=10]        n `replay:seed` turns in the current chat (transcripts only, no new chat)
//   node exp.mjs occlude [s=20]      the window hidden for s seconds (Chromium drops frames/tiles for occluded windows)
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PORT, cdp, focusComposer, newChat, paste, sleep } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [mode, arg] = process.argv.slice(2);
const fp = label => console.log(`-- ${label}\n` + execFileSync('node', [join(here, 'fp.mjs'), '2'], { encoding: 'utf8' }).split('\n').filter(l => /^app|gpu \[|renderer \[/.test(l.trim())).join('\n'));

async function browserSend(method, params = {}) {
	const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
	const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
	await new Promise(r => ws.addEventListener('open', r, { once: true }));
	const reply = new Promise(r => ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id === 1) { r(m); } }));
	ws.send(JSON.stringify({ id: 1, method, params }));
	const m = await reply;
	ws.close();
	return m;
}

fp('before');
if (mode === 'pressure') {
	// Every page target and the browser: Chromium forwards the level to the GPU process's caches too.
	const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
	for (const t of targets.filter(t => t.type === 'page')) {
		const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
		await new Promise(r => ws.addEventListener('open', r, { once: true }));
		const reply = new Promise(r => ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id === 1) { r(m); } }));
		ws.send(JSON.stringify({ id: 1, method: 'Memory.simulatePressureNotification', params: { level: 'critical' } }));
		console.log(t.title?.slice(0, 40), JSON.stringify(await reply).slice(0, 120));
		ws.close();
	}
	console.log('browser', JSON.stringify(await browserSend('Memory.simulatePressureNotification', { level: 'critical' })).slice(0, 120));
	await sleep(5000);
} else if (mode === 'newchats') {
	const c = await cdp();
	for (let i = 0; i < Number(arg ?? 10); i++) {
		await newChat(c);
		await sleep(2500);
	}
	c.close();
	await sleep(3000);
} else if (mode === 'seeds') {
	const c = await cdp();
	const marker = `[...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).map(m => (m.textContent.match(/unchanged/g) || []).length)[0] || 0`;
	for (let i = 0; i < Number(arg ?? 10); i++) {
		const before = await c.evaluate(marker);
		await focusComposer(c);
		await paste(c, 'replay:seed');
		await sleep(500);
		await c.key('Enter', 'Enter', 13, 0, '\r');
		for (let t = 0; t < 150 && await c.evaluate(marker) <= before; t++) { await sleep(200); }
		await sleep(1500);
	}
	c.close();
	await sleep(3000);
} else if (mode === 'occlude') {
	const c = await cdp();
	await c.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
	const win = await browserSend('Browser.getWindowForTarget', { targetId: c.targetId });
	await browserSend('Browser.setWindowBounds', { windowId: win.result.windowId, bounds: { windowState: 'minimized' } });
	await sleep(Number(arg ?? 20) * 1000);
	fp('while minimized');
	await browserSend('Browser.setWindowBounds', { windowId: win.result.windowId, bounds: { windowState: 'normal' } });
	await sleep(5000);
	c.close();
}
fp('after');
