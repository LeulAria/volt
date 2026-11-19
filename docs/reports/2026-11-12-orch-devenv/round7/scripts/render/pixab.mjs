// Pixel A/B of two page states in the test window: runs script A, captures the chat's scroller (transparent page
// background, so alpha counts), runs script B, captures again, and compares every RGBA byte.
//   node pixab.mjs <label> '<js A>' '<js B>'
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cdp } from './lib.mjs';

const [label, jsA, jsB] = process.argv.slice(2);
const out = join(process.env.HOME, '.volt-r7/render/pix');
mkdirSync(out, { recursive: true });
const c = await cdp();
await c.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
const frames = () => c.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80))))');
const rect = await c.evaluate(`(() => { const r = [...document.querySelectorAll('.volt-agent-thread > .volt-agent-thread-scroll')].find(e => e.offsetParent).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const shot = async name => {
	const r = await c.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 }, captureBeyondViewport: false });
	const file = join(out, `${label}-${name}.png`);
	writeFileSync(file, Buffer.from(r.result.data, 'base64'));
	return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 });
};
await c.evaluate(`(() => { ${jsA}; return true; })()`);
await frames();
const a = await shot('A');
await c.evaluate(`(() => { ${jsB}; return true; })()`);
await frames();
const b = await shot('B');
const w = Math.round(rect.width * 2);
let diff = 0;
const box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
const maxDelta = [0, 0, 0, 0];
for (let i = 0; i < Math.min(a.length, b.length); i++) {
	if (a[i] !== b[i]) {
		diff++;
		const p = i >> 2, x = p % w, y = Math.floor(p / w);
		box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y); box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y);
		maxDelta[i & 3] = Math.max(maxDelta[i & 3], Math.abs(a[i] - b[i]));
	}
}
console.log(JSON.stringify({ label, bytes: a.length, sameLength: a.length === b.length, diffBytes: diff, ...(diff ? { box, maxDelta } : {}) }));
c.close();
