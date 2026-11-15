// A7 rows of data/render/a7.jsonl as a table: per arm the median (n; range) of the p95 totals, and of each
// process role at the tick whose total is the p95 one. Rows over maxLoad (1-minute load at the start) are left out
// and counted. The "render side" line is this area's part: GPU + renderer + extension host + language helpers +
// main + shared process and other utilities + network service.
//   node a7roles.mjs [maxLoad=14] [arm...]
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DATA } from './lib.mjs';

const maxLoad = Number(process.argv[2] ?? 14);
const file = join(DATA, 'a7.jsonl');
const excluded = existsSync(join(DATA, 'excluded.json')) ? JSON.parse(readFileSync(join(DATA, 'excluded.json'), 'utf8'))['a7.jsonl'] ?? {} : {};
const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.byRoleAtP95 && !excluded[r.at]);
const arms = process.argv.slice(3).length ? process.argv.slice(3) : [...new Set(rows.map(r => r.arm))];
const med = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const cell = a => a.length ? `${med(a)} (n ${a.length}; ${Math.min(...a)}-${Math.max(...a)})` : 'n/a';
const RENDER = ['gpu', 'renderer', 'extension host', 'language helper (tsserver)', 'main', 'node utility (shared process/file watcher/pty)', 'utility (other)', 'network service'];
const lines = [
	['total p95', r => r.totalP95], ['app p95', r => r.appP95], ['agents p95 (Claude CLIs)', r => r.agentsP95],
	['render side at the p95 tick', r => RENDER.reduce((n, k) => n + (r.byRoleAtP95[k]?.mib ?? 0), 0)],
	...RENDER.map(k => [`  ${k}`, r => r.byRoleAtP95[k]?.mib ?? 0]),
	['  language helpers alive (max)', r => r.languageHelpersMax ?? 0],
	['ACP adapters', r => r.byRoleAtP95['ACP adapter (node)']?.mib ?? 0], ['agent server', r => r.byRoleAtP95['agent server']?.mib ?? 0],
	['GPU, its own p95', r => r.byRoleP95.gpu], ['renderer, its own p95', r => r.byRoleP95.renderer],
];
const used = arm => rows.filter(r => r.arm === arm && parseFloat(r.load) <= maxLoad);
console.log(`| A7, MB | ${arms.join(' | ')} |`);
console.log(`|---|${arms.map(() => '---').join('|')}|`);
for (const [name, f] of lines) { console.log(`| ${name} | ${arms.map(a => cell(used(a).map(f))).join(' | ')} |`); }
console.log(`| 1-minute load of the rows | ${arms.map(a => { const l = used(a).map(r => parseFloat(r.load)); return l.length ? `${Math.min(...l)}-${Math.max(...l)}` : ''; }).join(' | ')} |`);
console.log(`| left out (load > ${maxLoad}) | ${arms.map(a => rows.filter(r => r.arm === a && parseFloat(r.load) > maxLoad).map(r => `${r.totalP95} @${parseFloat(r.load)}`).join(', ') || '-').join(' | ')} |`);
