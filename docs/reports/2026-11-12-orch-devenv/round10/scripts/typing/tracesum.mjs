// Tabulates the typeprof.mjs summaries in data/typing/traces (one column per trace): frames, main-thread ms per frame,
// forced Layout / UpdateLayoutTree totals and the counts per forcing stack, key to presented frame. Markdown to stdout.
//   node tracesum.mjs [dir=../../data/typing/traces]
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] ?? join(here, '../../data/typing/traces');
const files = readdirSync(dir).filter(f => /^typeprof-.*\.txt$/.test(f)).sort();
const rows = new Map();
const put = (k, f, v) => (rows.get(k) ?? rows.set(k, {}).get(k))[f] = v;
for (const f of files) {
	const text = readFileSync(join(dir, f), 'utf8');
	const name = f.replace(/^typeprof-|\.txt$/g, '');
	const window = /typing window (\d+) ms/.exec(text)?.[1];
	put('typing window ms', name, window);
	const frames = /^\s*(\d+)\s+([\d.]+)\s+[\d.]+\/s\s+[\d.]+ ProxyMain::BeginMainFrame/m.exec(text);
	if (frames) {
		put('frames (BeginMainFrame)', name, frames[1]);
		put('main ms per frame', name, (Number(frames[2]) / Number(frames[1])).toFixed(1));
	}
	const stall = /^\s*\d+\s+([\d.]+)\s+[\d.]+\/s\s+([\d.]+) V8\.InvokeApiInterruptCallbacks/m.exec(text);
	put('longest V8 interrupt stall ms', name, stall ? Math.round(Number(stall[2])) : 0);
	for (const kind of ['Layout', 'UpdateLayoutTree']) {
		const m = new RegExp(`== forced ${kind}: (\\d+) of (\\d+), ([\\d.]+) ms; top stacks\\n([\\s\\S]*?)\\n\\n`).exec(text);
		if (!m) { continue; }
		put(`forced ${kind}: forced of all (ms)`, name, `${m[1]} of ${m[2]} (${Math.round(Number(m[3]))})`);
		for (const line of m[4].split('\n')) {
			const s = /^\s*(\d+)\s+([\d.]+)\s+(\S+?)@/.exec(line);
			if (s && /syncThreadScroll|adoptNativeScroll|scrollableElement|writeBackThreadScrollTop|_readClientRects|readClientRect|_render|syncStuckTurns/.test(s[3])) {
				put(`forced ${kind} by ${s[3]}`, name, `${s[1]} (${Math.round(Number(s[2]))})`);
			}
		}
	}
	const k2p = /key to presented frame: n (\d+), p50 ([\d.]+), p95 ([\d.]+), max ([\d.]+)/.exec(text);
	if (k2p) {
		put('key to presented frame p50 / p95 / max ms (load > 14: not a result)', name, `${k2p[2]} / ${k2p[3]} / ${Math.round(Number(k2p[4]))}`);
	}
	const busy = /main thread busy ([\d.]+) ms of (\d+) ms \((\d+) %\)/.exec(text);
	if (busy) {
		put('main thread busy %', name, busy[3]);
	}
	const anim = [...text.matchAll(/^\s*(\d+) (\S+?)@\S+ <= StyleRecalc Animation SPAN class='volt-agent-fresh-text'/gm)].reduce((a, m) => a + Number(m[1]), 0);
	const dots = [...text.matchAll(/^\s*(\d+) \S+ <= StyleRecalc Animation \S+ class='volt-browser-dock-dot/gm)].reduce((a, m) => a + Number(m[1]), 0);
	if (/== style invalidations/.test(text)) {
		put('fresh-text span animation recalcs before forced reads', name, anim);
		put('dock-dot animation recalcs before forced reads', name, dots);
	}
}
const names = files.map(f => f.replace(/^typeprof-|\.txt$/g, ''));
console.log(`| Count | ${names.join(' | ')} |`);
console.log(`|---|${names.map(() => '---').join('|')}|`);
for (const [k, v] of rows) {
	console.log(`| ${k} | ${names.map(n => v[n] ?? '-').join(' | ')} |`);
}
