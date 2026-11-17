import { readFileSync } from 'node:fs';
const [file, offS, fromS, toS, which = 'browser'] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(file, 'utf8')); const ev = Array.isArray(raw) ? raw : raw.traceEvents;
const procs = new Map(), threads = new Map();
for (const e of ev) { if (e.ph === 'M' && e.name === 'process_name') procs.set(e.pid, e.args?.name); if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args?.name); }
const zm = ev.find(e => e.cat === 'blink.user_timing' && e.name === 'code/didStartRenderer');
const zero = zm.ts - Number(offS) * 1000;
const bpid = [...procs].find(([, n]) => n === 'Browser')[0];
const btid = Number([...threads].find(([k, n]) => k.startsWith(`${bpid}:`) && n === 'CrBrowserMain')[0].split(':')[1]);
const [pid, tid] = which === 'browser' ? [bpid, btid] : [zm.pid, zm.tid];
const from = zero + Number(fromS) * 1000, to = zero + Number(toS) * 1000;
const xs = ev.filter(e => e.pid === pid && e.tid === tid && e.ph === 'X' && e.ts >= from && e.ts < to);
const by = new Map();
for (const e of xs) { const d = e.args?.data ?? e.args ?? {}; const k = e.name + (/CompileScript|compileModule|evaluateModule|EvaluateScript|V8.CompileDeserialize|ParseProgram/.test(e.name) && (d.url || d.fileName) ? ' ' + String(d.url ?? d.fileName).split('/').slice(-2).join('/') : ''); const v = by.get(k) ?? { cpu: 0, wall: 0, n: 0 }; v.cpu += e.tdur ?? 0; v.wall += e.dur ?? 0; v.n++; by.set(k, v); }
console.log(`${which} main thread, ${fromS}..${toS} ms after t0: CPU by event name`);
for (const [n, v] of [...by].sort((a, b) => b[1].cpu - a[1].cpu).slice(0, 34)) console.log(`  ${(v.cpu / 1000).toFixed(1).padStart(7)} cpu ${(v.wall / 1000).toFixed(0).padStart(5)} wall x${v.n}  ${n}`);
