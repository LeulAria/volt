// The bottom fade's A/B as the screen shows it (vibrancy on): macOS's own capture of the test window
// (`screencapture -l`, what the window server composites over the desktop), with `bottom-clear` as the build set
// it and with the class removed (mask on, as shipped before), plus an A/A control. Every RGBA byte compared.
//   node vibab.mjs <label> <CGWindowID>
import { execFileSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { cdp, sleep } from './lib.mjs';

const [label, windowId] = process.argv.slice(2);
const out = join(process.env.HOME, '.volt-r8/render/pix');
mkdirSync(out, { recursive: true });
const c = await cdp();
const S = `[...document.querySelectorAll('.volt-agent-thread > .volt-agent-thread-scroll')].find(e => e.offsetParent)`;
const shot = async name => {
	await c.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))))');
	await sleep(300);
	const file = join(out, `${label}-${name}.png`);
	execFileSync('screencapture', ['-x', '-o', `-l${windowId}`, file]);
	return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 });
};
const cmp = (a, b) => {
	let diff = 0;
	const maxDelta = [0, 0, 0, 0];
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] !== b[i]) {
			diff++;
			maxDelta[i & 3] = Math.max(maxDelta[i & 3], Math.abs(a[i] - b[i]));
		}
	}
	return { bytes: a.length, sameLength: a.length === b.length, diffBytes: diff, maxDelta };
};
const state = await c.evaluate(`(() => { const s = ${S}; return { clear: s.classList.contains('bottom-clear'), theme: document.querySelector('.monaco-workbench').className.match(/\\b(vs-dark|vs|hc-black|hc-light)\\b/)?.[0] }; })()`);
const a1 = await shot('clear-1');
const a2 = await shot('clear-2');
await c.evaluate(`(() => { ${S}.classList.remove('bottom-clear'); return true; })()`);
const b = await shot('masked');
await c.evaluate(`(() => { ${S}.classList.add('bottom-clear'); return true; })()`);
console.log(JSON.stringify({ label, ...state, control: cmp(a1, a2), ab: cmp(a2, b) }));
c.close();
