// Keys typed while a window starts (dev tree or app, the normal launch path): types the probe letters every 60 ms from
// the moment the page exists, and prints what the composer holds once the workbench has taken over. A text that
// starts with the probe's first letters lost no key.
//   node typeahead.mjs <arm> [keys=30]      (untimed; second launch of the profile, so a window snapshot exists)
import { arm as armOf, connect, freshProfile, launch, sleep, stop, targets, waitWorkbench, writeSettings } from './lib.mjs';
const arm = armOf(process.argv[2] ?? 'dev');
const KEYS = Number(process.argv[3] ?? 30);
const PROBE = 'ademarkqz';
await freshProfile(arm);
writeSettings(arm);
// First launch: makes the window's snapshot (written at quit).
launch(arm, { keepRendering: true });
await waitWorkbench();
await sleep(8000);
await stop(arm);
await sleep(3000);
const t0 = Date.now();
launch(arm, { keepRendering: true });
let c;
for (; !c;) {
	try {
		const page = (await targets()).find(t => t.type === 'page' && /workbench/.test(t.url));
		if (page) { c = await connect(page.webSocketDebuggerUrl, page.id); }
	} catch { }
	if (!c) { await sleep(15); }
}
const connected = Date.now() - t0;
let firstShown = null;
for (let i = 0; i < KEYS; i++) {
	const ch = PROBE[i % PROBE.length];
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
	if (firstShown === null) {
		const snap = await c.evaluate(`document.getElementById('volt-window-snapshot-input')?.value ?? null`).catch(() => null);
		if (snap) { firstShown = { atMs: Date.now() - t0, afterKeys: i + 1, text: snap }; }
	}
	await sleep(60);
}
await waitWorkbench();
await sleep(6000);
const text = await c.evaluate(`[...document.querySelectorAll('.volt-agent-composer .view-lines')].filter(e => e.offsetParent).map(e => e.textContent).join('|')`);
console.log(JSON.stringify({ arm, connectedMs: connected, keys: KEYS, snapshotFirstShown: firstShown, composer: text, composerChars: text.length, startsWithProbe: text.replace(/\s/g, '').startsWith(PROBE.slice(0, 4)) }));
c.close();
await stop(arm);
