// Tool time of steps whose calls are all Edit/Write (Volt-side: hooks + the edit), per edit, by arm.
import { readFileSync, existsSync } from 'fs';
const H = process.env.HOME + '/.volt-r5/codeintel/run';
const read = f => readFileSync(f, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { } }).filter(Boolean);
const caps = read(H + '/capture.jsonl').filter(r => r.usage && /\/v1\/messages/.test(r.path));
const ws = read(H + '/windows.jsonl').filter(w => new RegExp(process.argv[2]).test(w.label));
const per = {};
for (const w of ws) {
	const arm = w.label.includes('-after-') ? 'after' : 'before';
	const rows = caps.filter(r => r.t >= w.start && r.t <= w.end).sort((a, b) => a.t - b.t);
	const main = [];
	for (const r of rows) { const f = `${H}/capture.jsonl.bodies/${r.n}.json`; if (!existsSync(f)) continue; const b = JSON.parse(readFileSync(f, 'utf8')); if ((b.tools?.length ?? 0) >= 5 && JSON.stringify(b.messages[0]).includes(w.prompt.slice(0, 50))) main.push({ r, b }); }
	for (let i = 0; i + 1 < main.length; i++) {
		const gap = main[i + 1].r.t - (main[i].r.t + main[i].r.ms);
		const calls = main[i + 1].b.messages.slice(main[i].b.messages.length).filter(m => m.role === 'assistant').flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === 'tool_use').map(c => c.name) : []);
		if (calls.length && calls.every(c => /^(Edit|Write|MultiEdit)$/.test(c))) { (per[arm] ??= []).push({ label: w.label, rep: w.rep, gap, n: calls.length, perEdit: gap / calls.length }); }
	}
}
const med = xs => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
for (const [arm, xs] of Object.entries(per)) {
	console.log(arm, 'steps', xs.length, 'edits', xs.reduce((a, x) => a + x.n, 0), 'median ms per edit', Math.round(med(xs.map(x => x.perEdit))), 'range', Math.round(Math.min(...xs.map(x => x.perEdit))), '-', Math.round(Math.max(...xs.map(x => x.perEdit))), 'total s', (xs.reduce((a, x) => a + x.gap, 0) / 1000).toFixed(1));
}
