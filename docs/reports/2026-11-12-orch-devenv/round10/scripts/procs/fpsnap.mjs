// Footprint categories (macOS `footprint`) of every process of the test instance and its agent server's tree, now:
// one block per process (role, pid, footprint, top categories). For telling V8 heap from malloc from code.
//   node fpsnap.mjs [out.txt] [top=6]
import { execFileSync, execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { UD } from './lib.mjs';
import { role } from './roles.mjs';

const [out, topArg = '6'] = process.argv.slice(2);
const ps = execSync('ps -axo pid=,ppid=,command=', { maxBuffer: 64 << 20 }).toString().split('\n').filter(Boolean).map(l => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); return { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }; });
const roots = ps.filter(p => p.cmd.includes(`--user-data-dir ${UD}`) && (!p.cmd.includes('--type=') || true) && !/--type=/.test(p.cmd)).map(p => p.pid);
const tree = new Set(roots);
for (let grew = true; grew;) { grew = false; for (const p of ps) { if (!tree.has(p.pid) && tree.has(p.ppid)) { tree.add(p.pid); grew = true; } } }
const lines = [`# fpsnap ${new Date().toISOString()} ${UD}`];
for (const p of ps.filter(p => tree.has(p.pid))) {
	let fp;
	try { fp = execFileSync('footprint', ['-p', String(p.pid)], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }).toString(); } catch { continue; }
	const total = /Footprint: ([\d.]+ \w+)/.exec(fp)?.[1];
	if (!total || /KB|^0 B/.test(total)) { continue; }
	const cats = fp.split('\n').filter(l => /^\s*[\d.]+ [KMG]?B\s+[\d.]+ [KMG]?B/.test(l) && !/TOTAL/.test(l)).slice(0, Number(topArg)).map(l => { const f = l.trim().split(/\s{2,}/); return `${f[0]} ${f.at(-1)}`; });
	lines.push(`${role(p.cmd).padEnd(48)} ${String(p.pid).padStart(6)} ${total.padStart(8)} | ${cats.join(' | ')}`);
}
const text = lines.join('\n') + '\n';
if (out) { writeFileSync(out, text); }
process.stdout.write(text);
