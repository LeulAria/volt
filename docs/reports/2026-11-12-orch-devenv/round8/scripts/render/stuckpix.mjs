// Pixel A/B of the pinned sent card's mask in the test window (a build that masks a tall reply row by row): the chat
// column is captured as the build draws it (`volt-under-stuck` on the rows in the card's band) and with the mask as it
// was before (on the whole reply, same gradient), on a transparent page background so alpha is compared too. Scrolls
// the thread by wheel to several positions first. Prints one JSON line per position; every RGBA byte should match.
//   node stuckpix.mjs <label> [positions=6]     PIX_CONTROL=1: A/A (the build's drawing twice)
import { execFileSync } from 'child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA, cdp, sleep } from './lib.mjs';

const label = process.argv[2] ?? 'case';
const positions = Number(process.argv[3] ?? 6);
const out = join(process.env.HOME, '.volt-r8/render/pix');
mkdirSync(out, { recursive: true });
mkdirSync(DATA, { recursive: true });
const c = await cdp();
await c.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
const frames = () => c.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80))))');
const scroller = `[...document.querySelectorAll('.volt-agent-thread > .volt-agent-thread-scroll')].find(e => e.offsetParent)`;
const rect = await c.evaluate(`(() => { const r = ${scroller}.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const rgba = async name => {
	const r = await c.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 }, captureBeyondViewport: false });
	const file = join(out, `${label}-${name}.png`);
	writeFileSync(file, Buffer.from(r.result.data, 'base64'));
	return { file, raw: execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 }) };
};
// As before this build: the mask on each reply of the pinned exchange, whole; the rows' own masks off.
const asBefore = `(() => {
	const s = ${scroller};
	const ex = s.querySelector('.volt-agent-exchange.has-stuck-turn');
	if (!ex) { return null; }
	const card = ex.querySelector(':scope > .volt-agent-turn.user.stuck');
	const bottom = card.getBoundingClientRect().bottom;
	const rows = [...s.querySelectorAll('.volt-under-stuck')];
	const replies = [...ex.children].filter(e => e.classList.contains('volt-agent-turn') && (!e.classList.contains('user') || e.classList.contains('notification')));
	const ends = replies.map(e => Math.round(bottom - e.getBoundingClientRect().top));
	window.__stuckRows = rows;
	window.__stuckReplies = replies;
	rows.forEach(e => e.classList.remove('volt-under-stuck'));
	replies.forEach((e, i) => { const m = 'linear-gradient(to bottom, transparent 0px, transparent ' + (ends[i] + 10) + 'px, #000 ' + (ends[i] + 34) + 'px)'; e.style.webkitMaskImage = m; e.style.maskImage = m; });
	return { rows: rows.length, rowHeights: rows.map(e => Math.round(e.getBoundingClientRect().height)), replies: replies.length, replyHeights: replies.map(e => Math.round(e.getBoundingClientRect().height)), ends };
})()`;
const asBuilt = `(() => { (window.__stuckReplies ?? []).forEach(e => { e.style.webkitMaskImage = ''; e.style.maskImage = ''; }); (window.__stuckRows ?? []).forEach(e => e.classList.add('volt-under-stuck')); return true; })()`;
const theme = await c.evaluate(`document.querySelector('.monaco-workbench').className.match(/\\b(vs-dark|vs|hc-black|hc-light)\\b/)?.[0]`);
// The scrollbar's slider fades out after a scroll (an animation between the two captures): hidden meanwhile.
await c.evaluate(`(() => { const s = document.createElement('style'); s.id = '__pixbar'; s.textContent = '.volt-agent-thread-scroll > .scrollbar { visibility: hidden !important; }'; document.head.appendChild(s); return true; })()`);
for (let i = 0; i < positions; i++) {
	// A wheel turn up from the end, a different distance each time, so the band cuts rows at different places.
	await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, deltaX: 0, deltaY: -(137 + i * 211) });
	await sleep(700);
	await frames();
	const a = await rgba(`${i}-built`);
	const before = process.env.PIX_CONTROL === '1' ? { control: true } : await c.evaluate(asBefore);
	if (!before) {
		console.log(JSON.stringify({ label, i, skipped: 'no pinned card here' }));
		continue;
	}
	await frames();
	const b = await rgba(`${i}-before`);
	await c.evaluate(asBuilt);
	let differing = 0, maxDelta = 0, alphaDiffering = 0, firstRow = -1, lastRow = -1;
	const w = Math.round(a.raw.length / 4 / Math.round(rect.height * (a.raw.length / 4 / (rect.width * rect.height)) ** 0.5));
	for (let k = 0; k < a.raw.length; k++) {
		const d = Math.abs(a.raw[k] - b.raw[k]);
		if (d) {
			differing++;
			maxDelta = Math.max(maxDelta, d);
			if (k % 4 === 3) { alphaDiffering++; }
			const row = Math.floor(k / 4 / w);
			if (firstRow < 0) { firstRow = row; }
			lastRow = row;
		}
	}
	const row = { label, i, theme, at: new Date().toISOString(), bytes: a.raw.length, sameSize: a.raw.length === b.raw.length, differing, differingPct: Math.round(differing / a.raw.length * 1e5) / 1e3, maxDelta, alphaDiffering, rowsDiffering: firstRow < 0 ? null : [firstRow, lastRow], ...before };
	appendFileSync(join(DATA, 'stuck-pixel-ab.jsonl'), JSON.stringify(row) + '\n');
	console.log(JSON.stringify(row));
}
await c.evaluate(`document.getElementById('__pixbar')?.remove()`);
await c.send('Emulation.setDefaultBackgroundColorOverride', {});
c.close();
