// Chat switch time (exploratory A/B, in-page clock): alternates between the two most recent sidebar chats N times;
// each switch = row click to the window title naming the chat and its thread drawn, plus two frames. Median ms.
//   node switch.mjs <arm> [n=20]   (rows appended to data/render/switch.jsonl)
import { appendFileSync } from 'fs';
import { join } from 'path';
import { DATA, cdp, load } from './lib.mjs';
const [arm = 'after', nArg = '20'] = process.argv.slice(2);
const c = await cdp();
const r = await c.evaluate(`(async () => {
	const frame = () => new Promise(r => requestAnimationFrame(() => r()));
	const rows = () => [...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && /Replay/i.test(e.getAttribute('aria-label') || ''));
	const out = [];
	for (let i = 0; i < ${Number(nArg)}; i++) {
		const row = rows()[i % 2];
		const want = (row.getAttribute('aria-label') || '').split(/[,\\n]/)[0].trim().toLowerCase();
		await frame(); await frame();
		const t0 = performance.now();
		row.click();
		const until = t0 + 5000;
		while (performance.now() < until) {
			await frame();
			const inner = [...document.querySelectorAll('.volt-agent-thread-inner')].find(e => e.offsetParent);
			if (document.title.toLowerCase().includes(want.slice(0, 14)) && inner && inner.childElementCount) break;
		}
		await frame(); await frame();
		out.push(Math.round((performance.now() - t0) * 10) / 10);
		await new Promise(r => setTimeout(r, 300));
	}
	return out;
})()`);
c.close();
const s = [...r].sort((a, b) => a - b);
const row = { arm, test: 'switch', at: new Date().toISOString(), load: load(), n: s.length, medianMs: s[s.length >> 1], min: s[0], max: s.at(-1), all: r };
appendFileSync(join(DATA, 'switch.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
process.exit(0);
