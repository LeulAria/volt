// Exploratory: what each process of the running test instance does at rest, natively: macOS `sample <pid> <secs>` (1 ms
// stacks of every thread), reduced to the frames on top of the stack that are not a wait (mach_msg, kevent, psynch,
// semaphore, ...), per thread name. Finds wakeups a JS profile cannot see (Chromium's own tasks, libuv, watchers).
// The files are deleted unless NATIVESAMPLE_KEEP=1. No rows; analysis aid for A6.
//   node nativesample.mjs [secs=20] [role regex=.]
import { execFile } from 'child_process';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { profileProcesses } from './lib.mjs';
import { role } from './roles.mjs';
const [secs = '20', only = '.'] = process.argv.slice(2);
const dir = `${process.env.HOME}/.volt-r10/rest/probe/sample`;
mkdirSync(dir, { recursive: true });
const WAIT = /mach_msg|kevent|__psynch|semaphore_wait|__workq_kernreturn|__select|__ulock_wait|start_wqthread|thread_start|_pthread|__semwait|poll$|read$|__read_nocancel|kqueue|__sigsuspend|sigwait/;
const procs = profileProcesses().map(p => ({ ...p, role: role(p.cmd) })).filter(p => new RegExp(only).test(p.role) && !/sandbox|caffeinate|^other/.test(p.role));
await Promise.all(procs.map(p => new Promise(res => execFile('sample', [String(p.pid), secs, '1', '-mayDie', '-file', `${dir}/${p.pid}.txt`], { maxBuffer: 64 << 20 }, () => res()))));
for (const p of procs) {
	let text;
	try { text = readFileSync(`${dir}/${p.pid}.txt`, 'utf8'); } catch { console.log(`${p.role} ${p.pid}: no sample`); continue; }
	// Call graph lines: "    2843 Thread_12345   DispatchQueue_1: com.apple.main-thread  (serial)" then indented frames with counts.
	const graph = text.split('Call graph:')[1]?.split('Total number in stack')[0] ?? '';
	const threads = [];
	let cur;
	for (const line of graph.split('\n')) {
		const t = /^\s{4}(\d+) Thread_\w+(?:\s+DispatchQueue_\d+: (.*?)\s+\(|: (.*?)$|)/.exec(line);
		if (t) { cur = { name: (t[2] ?? t[3] ?? 'thread').trim(), total: Number(t[1]), leaves: new Map(), last: undefined }; threads.push(cur); continue; }
		const f = /^([\s+!:|]*)(\d+) (.+?)\s+\(in (.+?)\)/.exec(line);
		if (cur && f) { cur.frames ??= []; cur.frames.push({ depth: f[1].length, n: Number(f[2]), fn: f[3], lib: f[4] }); }
	}
	console.log(`\n== ${p.role} ${p.pid}`);
	for (const t of threads) {
		const fr = t.frames ?? [];
		let busy = 0; const tops = new Map();
		for (let i = 0; i < fr.length; i++) {
			// A leaf: the next frame is not deeper. Its own count = n minus the sum of its children.
			let children = 0;
			for (let j = i + 1; j < fr.length && fr[j].depth > fr[i].depth; j++) { if (fr[j].depth === fr.slice(i + 1, j + 1).reduce((m, x) => Math.min(m, x.depth), Infinity) && fr[j].depth > fr[i].depth) { /* direct child candidates handled below */ } }
			const direct = []; let minDepth = Infinity;
			for (let j = i + 1; j < fr.length && fr[j].depth > fr[i].depth; j++) { if (fr[j].depth < minDepth) { minDepth = fr[j].depth; } }
			for (let j = i + 1; j < fr.length && fr[j].depth > fr[i].depth; j++) { if (fr[j].depth === minDepth) { direct.push(fr[j]); } }
			children = direct.reduce((s, x) => s + x.n, 0);
			const own = fr[i].n - children;
			if (own > 0 && !WAIT.test(fr[i].fn)) { busy += own; const k = `${fr[i].fn.slice(0, 90)} (${fr[i].lib})`; tops.set(k, (tops.get(k) ?? 0) + own); }
		}
		if (busy > 0) {
			console.log(`  ${t.name.slice(0, 40).padEnd(40)} busy ${busy} of ${t.total} samples (${(busy / t.total * 100).toFixed(2)} %)`);
			for (const [k, v] of [...tops].sort((a, b) => b[1] - a[1]).slice(0, 6)) { console.log(`      ${String(v).padStart(4)}  ${k}`); }
		}
	}
	if (process.env.NATIVESAMPLE_KEEP !== '1') { rmSync(`${dir}/${p.pid}.txt`, { force: true }); }
}
