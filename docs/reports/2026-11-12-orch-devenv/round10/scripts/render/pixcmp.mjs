// Pixel A/B of the thread's bottom fade in the test window (a build with `bottom-clear`): the chat column is
// captured with the class as the build set it (mask off when clear) and with the class removed (the mask on, as
// shipped before), on a transparent page background so alpha is compared too; every RGBA byte must match.
// Each case runs with the scrollbar hidden and shown. Prints one JSON line per case.
//   node pixcmp.mjs <label> [collapse]     collapse: also run with the side toolbar collapsed (class removed)
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cdp, sleep } from './lib.mjs';

const label = process.argv[2] ?? 'case';
const out = join(process.env.HOME, '.volt-r9/render/pix');
mkdirSync(out, { recursive: true });
const c = await cdp();
await c.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
const frames = () => c.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))');
const rgba = async name => {
	const r = await c.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 }, captureBeyondViewport: false });
	const file = join(out, `${label}-${name}.png`);
	writeFileSync(file, Buffer.from(r.result.data, 'base64'));
	return { file, raw: execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 }) };
};
const scroller = `[...document.querySelectorAll('.volt-agent-thread > .volt-agent-thread-scroll')].find(e => e.offsetParent)`;
const rect = await c.evaluate(`(() => { const r = ${scroller}.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const state = () => c.evaluate(`(() => { const s = ${scroller}; const ed = s.closest('.volt-agent-editor'); return { clear: s.classList.contains('bottom-clear'), mask: getComputedStyle(s).maskImage !== 'none', barMask: getComputedStyle(s.querySelector(':scope > .scrollbar.vertical')).maskImage !== 'none', expanded: ed.classList.contains('quick-open-expanded'), theme: document.body.parentElement.className.match(/vs-dark|vs|hc-black|hc-light/)?.[0] ?? document.querySelector('.monaco-workbench').className.match(/\b(vs-dark|vs|hc-black|hc-light)\b/)?.[0] }; })()`);
const bar = show => c.evaluate(`(() => { const b = ${scroller}.querySelector(':scope > .scrollbar.vertical'); b.classList.toggle('visible', ${show}); b.classList.toggle('invisible', ${!show}); b.classList.remove('fade'); return true; })()`);
const setClear = on => c.evaluate(`(() => { ${scroller}.classList.toggle('bottom-clear', ${on}); return true; })()`);

async function compare(name) {
	await frames();
	const st = await state();
	if (!st.clear) {
		console.log(JSON.stringify({ label, name, skipped: 'not bottom-clear here', ...st }));
		return;
	}
	const a = await rgba(`${name}-clear`);
	await setClear(process.env.PIX_CONTROL === "1");
	await frames();
	const masked = await state();
	const b = await rgba(`${name}-masked`);
	await setClear(true);
	let diff = 0;
	let first;
	const n = Math.min(a.raw.length, b.raw.length);
	const w = Math.round(rect.width * 2);
	const box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
	const maxDelta = [0, 0, 0, 0];
	for (let i = 0; i < n; i++) {
		if (a.raw[i] !== b.raw[i]) {
			diff++;
			first ??= i;
			const p = i >> 2, x = p % w, y = Math.floor(p / w);
			box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y); box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y);
			maxDelta[i & 3] = Math.max(maxDelta[i & 3], Math.abs(a.raw[i] - b.raw[i]));
		}
	}
	const px = first === undefined ? undefined : { x: (first >> 2) % w, y: Math.floor((first >> 2) / w), box, maxDelta };
	console.log(JSON.stringify({ label, name, bytes: n, sameLength: a.raw.length === b.raw.length, diffBytes: diff, firstDiffPx: px, clearState: st, maskedState: masked }));
}

for (const collapsed of process.argv.includes('collapse') ? [false, true] : [false]) {
	if (collapsed) {
		await c.evaluate(`(() => { ${scroller}.closest('.volt-agent-editor').classList.remove('quick-open-expanded'); return true; })()`);
	}
	for (const shown of [false, true]) {
		await bar(shown);
		await compare(`${collapsed ? 'collapsed' : 'asis'}-bar${shown ? 'on' : 'off'}`);
	}
}
await bar(false);
await sleep(100);
c.close();
