// Prints the capture numbers of the main-model /v1/messages requests inside a window: node lastbody.mjs <label> [rep]
import { readFileSync } from 'fs';
const dir = process.env.TOK_DIR;
const [label, rep] = process.argv.slice(2);
const w = readFileSync(`${dir}/windows.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(x => x.label === label && (!rep || String(x.rep) === rep)).at(-1);
const rows = readFileSync(`${dir}/capture.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.t >= w.start && r.t <= w.end && r.usage && /\/v1\/messages(\?|$)/.test(r.path));
for (const r of rows) { console.log(r.n, r.model, JSON.stringify(r.usage)); }
