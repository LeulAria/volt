// prints the main thread's tool calls and result heads for one label
import { readFileSync, existsSync } from 'fs';
const H = process.env.HOME + '/.volt-r5/codeintel/run';
const read = f => readFileSync(f, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { } }).filter(Boolean);
const w = read(H + '/windows.jsonl').filter(w => w.label === process.argv[2]).at(-1);
const rows = read(H + '/capture.jsonl').filter(r => r.usage && r.t >= w.start && r.t <= w.end).sort((a, b) => a.n - b.n);
let last;
for (const r of rows) { const f = `${H}/capture.jsonl.bodies/${r.n}.json`; if (!existsSync(f)) continue; const b = JSON.parse(readFileSync(f, 'utf8')); if ((b.tools?.length ?? 0) >= 5 && JSON.stringify(b.messages[0]).includes(w.prompt.slice(0, 50))) last = b; }
const N = Number(process.argv[3] ?? 600);
for (const m of last.messages) for (const c of (Array.isArray(m.content) ? m.content : [])) {
  if (c.type === 'tool_use') console.log('>>', c.name, JSON.stringify(c.input).slice(0, 300));
  if (c.type === 'tool_result') console.log('<<', JSON.stringify(c.content).slice(0, N));
}
