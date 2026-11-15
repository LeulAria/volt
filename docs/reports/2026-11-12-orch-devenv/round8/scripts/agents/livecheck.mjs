// Live check of the shared adapter host in a running test instance (a correctness check, no timing lock):
//   1. five chats stream (`replay:stream-1..5`, 2 s apart): one adapter host, five CLIs, none a child of the host,
//      each CLI pid attested by the sandbox (agent-server.log `[volt-sandbox-spawn] <id> attested seatbelt {"pid":N`);
//   2. the newest CLI killed (SIGKILL) mid-stream: the host and the four other CLIs stay;
//   3. after the streams: the idle stop ends every CLI (20 s after its answer) and then the host (2 s);
//   4. a follow-up in the chat in front answers on a new host, its CLI attested (Enter -> answer text, ms);
//   5. the idle stop again, timed from that answer;
//   6. every stream's answer ended in its chat (the killed chat's turn is re-run by Volt's mid-turn recovery).
//   node livecheck.mjs      (prints a report; exits 1 on a failed check)
import { readFileSync } from 'fs';
import { join } from 'path';
import { cdp, newChat, paste, profileProcesses, sleep, UD } from './lib.mjs';
import { role } from './roles.mjs';

const c = await cdp();
const t0 = Date.now();
const s = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const fails = [];
const check = (ok, what) => { console.log(`${s()} ${ok ? 'OK  ' : 'FAIL'} ${what}`); if (!ok) { fails.push(what); } };
const procs = () => {
	const all = profileProcesses().map(p => ({ ...p, role: role(p.cmd) }));
	return { hosts: all.filter(p => p.role === 'ACP adapter (node)'), clis: all.filter(p => p.role === 'claude CLI') };
};
const attested = () => {
	// The agent server writes logs/agent-server.log (it outlives a relaunch).
	const text = readFileSync(join(UD, 'logs', 'agent-server.log'), 'utf8');
	return new Set([...text.matchAll(/attested seatbelt \{"pid":(\d+)/g)].map(m => Number(m[1])));
};
async function clickComposer() {
	const pt = await c.evaluate(`(() => { const t = [...document.querySelectorAll('.volt-agent-input-box')].filter(e => e.offsetParent).at(-1); if (!t) { return null; } const r = t.getBoundingClientRect(); return [r.x + 60, r.y + r.height / 2]; })()`);
	if (!pt) { throw new Error('no composer'); }
	await c.click(pt[0], pt[1]);
}
const transcript = () => c.evaluate(`[...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).map(m => m.textContent).join('\\n')`);
const count = (text, re) => (text.match(re) || []).length;
async function sendAndWait(text, re, timeoutMs = 60_000) {
	const n = count(await transcript(), re);
	await clickComposer();
	await c.send('Input.insertText', { text });
	await sleep(400);
	const at = Date.now();
	await c.key('Enter', 'Enter', 13, 0, '\r');
	while (Date.now() - at < timeoutMs) {
		await sleep(100);
		if (count(await transcript(), re) > n) { return Date.now() - at; }
	}
	return undefined;
}
async function waitFor(pred, timeoutMs, stepMs = 1000) {
	const at = Date.now();
	while (Date.now() - at < timeoutMs) { const v = pred(); if (v) { return Date.now() - at; } await sleep(stepMs); }
	return undefined;
}
const streamRows = () => c.evaluate(`[...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && /stream-\\d/.test(e.getAttribute('aria-label') || '')).length`);
async function openStreamRow(index) {
	if (await streamRows() === 0) {
		await c.evaluate(`[...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^Toggle Primary Side Bar/.test(e.getAttribute('aria-label'))).click()`);
		await sleep(1500);
	}
	const pt = await c.evaluate(`(() => { const e = [...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && /stream-\\d/.test(e.getAttribute('aria-label') || ''))[${index}]; if (!e) { return null; } const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, e.getAttribute('aria-label')]; })()`);
	if (!pt) { return undefined; }
	await c.click(pt[0], pt[1]);
	await sleep(1500);
	return pt[2];
}

// 1. Five streams.
for (let i = 1; i <= 5; i++) {
	await newChat(c);
	await sleep(1500);
	await clickComposer();
	await paste(c, `replay:stream-${i}`);
	await sleep(500);
	await c.key('Enter', 'Enter', 13, 0, '\r');
	await sleep(2000);
}
await sleep(8000);
let p = procs();
check(p.hosts.length === 1, `one adapter host while 5 chats stream (hosts ${p.hosts.map(h => h.pid).join(',')})`);
check(p.clis.length === 5, `five CLIs (${p.clis.map(x => x.pid).join(',')})`);
const att = attested();
check(p.clis.every(x => att.has(x.pid)), `every CLI pid attested by the sandbox (${p.clis.filter(x => !att.has(x.pid)).map(x => x.pid).join(',') || 'all'})`);
check(p.clis.every(x => x.ppid !== p.hosts[0]?.pid), 'no CLI is a child of the host');

// 2. Kill the newest CLI mid-stream.
const victim = [...p.clis].sort((a, b) => b.pid - a.pid)[0];
const others = p.clis.filter(x => x !== victim).map(x => x.pid);
const host = p.hosts[0];
process.kill(victim.pid, 'SIGKILL');
console.log(`${s()} killed CLI ${victim.pid}`);
await sleep(5000);
p = procs();
check(p.hosts.length === 1 && p.hosts[0].pid === host.pid, `host ${host.pid} alive after one CLI died`);
check(others.every(pid => p.clis.some(x => x.pid === pid)), `the four other CLIs alive (${others.join(',')}; now ${p.clis.map(x => x.pid).join(',')})`);

// 3. Idle stop after the streams: every CLI, then the host.
const allIdle = await waitFor(() => { const q = procs(); return q.clis.length === 0 && q.hosts.length === 0; }, 330_000, 1000);
check(allIdle !== undefined, `CLIs and host stopped after the streams (${allIdle} ms after kill + 5 s)`);

// 4. A follow-up in the chat in front, on a new host.
const before4 = attested();
const ms = await sendAndWait('replay:seed', /Seeded\. This thread is open/g, 90_000);
check(ms !== undefined, `follow-up after the idle stop answers (${ms} ms Enter -> answer text, host and CLI started cold)`);
p = procs();
const fresh = [...attested()].filter(x => !before4.has(x));
check(p.hosts.length === 1 && p.hosts[0].pid !== host.pid, `a new host serves it (${p.hosts.map(h => h.pid)})`);
check(p.clis.length >= 1 && p.clis.every(x => fresh.includes(x.pid)), `its CLI attested again (${p.clis.map(x => x.pid)}; attested since: ${fresh})`);

// 5. The idle stop again, from that answer.
const idle2 = await waitFor(() => { const q = procs(); return q.clis.length === 0 && q.hosts.length === 0; }, 90_000, 250);
check(idle2 !== undefined && idle2 < 30_000, `idle stop after the follow-up: CLI and host gone ${idle2} ms after its answer`);

// 6. Every stream's answer ended (opening a chat warms its agent: last, after the idle checks).
const ends = {};
for (let i = 0; i < 5; i++) {
	const label = await openStreamRow(i);
	if (!label) { break; }
	const text = await transcript();
	ends[label] = text.includes('That is the whole change');
}
console.log(`${s()} chats: ${JSON.stringify(ends)}`);
check(Object.keys(ends).length === 5 && Object.values(ends).every(Boolean), 'all five answers ended, the killed one too');
c.close();
console.log(fails.length ? `FAILED: ${fails.join('; ')}` : 'ALL OK');
process.exit(fails.length ? 1 : 0);
