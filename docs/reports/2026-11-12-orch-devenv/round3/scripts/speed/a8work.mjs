// A8's work, not its wall clock: the same five replay streams as a8.mjs, then a 10 s renderer timeline trace
// while a probe letter is typed every 250 ms into the front thread's composer. Reports the renderer main
// thread's busy time (sum of top-level tasks), style and layout passes, and tasks over 50 ms. On a shared Mac
// the key-to-frame latency of a8.mjs swings with the other agents' load; the main thread's own work per
// second moves much less, so this is the A/B for the typing-path fixes.
//   node a8work.mjs <arm> [seconds=10]   (one row appended to data/speed/a8work.jsonl)
import { appendFileSync } from 'fs';
import { join } from 'path';
import { cdp, DATA, focusComposer, load, newChat, sleep } from './lib.mjs';

const [arm = 'dev', secsArg = '10'] = process.argv.slice(2);
const secs = Number(secsArg);
const c = await cdp();
await c.send('Page.bringToFront');
const loadStart = load();
const t0 = Date.now();
for (let i = 1; i <= 5; i++) {
	await newChat(c);
	await sleep(1500);
	if (!await focusComposer(c)) {
		throw new Error('no composer');
	}
	await c.send('Input.insertText', { text: `replay:stream-${i}` });
	await sleep(500);
	await c.key('Enter', 'Enter', 13, 0, '\r');
	if (i < 5) {
		await sleep(2000);
	}
}
await sleep(6000);
await focusComposer(c);
const events = [];
c.on('Tracing.dataCollected', p => events.push(...p.value));
const done = new Promise(r => c.on('Tracing.tracingComplete', r));
await c.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
const loadTyping = load();
for (let i = 0; i < secs * 4; i++) {
	const ch = 'ademarkqz'[i % 9];
	const kc = ch.toUpperCase().charCodeAt(0);
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
	await sleep(250);
}
await c.send('Tracing.end');
await done;
await c.key('a', 'KeyA', 65, 4);
await c.key('Backspace', 'Backspace', 8);
c.close();

const tid = events.find(e => e.name === 'thread_name' && e.args?.name === 'CrRendererMain')?.tid;
const main = events.filter(e => e.tid === tid && e.ph === 'X');
// Top-level tasks only: RunTask events not nested in another RunTask.
const tasks = main.filter(e => e.name === 'RunTask').sort((a, b) => a.ts - b.ts);
let busy = 0;
let end = 0;
const long = [];
for (const t of tasks) {
	if (t.ts >= end) {
		busy += t.dur ?? 0;
		end = t.ts + (t.dur ?? 0);
		if (t.dur > 50_000) {
			long.push(Math.round(t.dur / 1000));
		}
	}
}
const span = tasks.length ? (tasks.at(-1).ts + (tasks.at(-1).dur ?? 0) - tasks[0].ts) / 1e6 : secs;
const sum = name => { const xs = main.filter(e => e.name === name); return { n: xs.length, ms: Math.round(xs.reduce((s, e) => s + (e.dur ?? 0), 0) / 1000) }; };
const row = {
	arm, at: new Date(t0).toISOString(), load: loadStart, loadTyping, secs,
	busyMsPerS: Math.round(busy / 1000 / span), keys: secs * 4,
	style: sum('UpdateLayoutTree'), layout: sum('Layout'), paint: sum('Paint'), longTasks: long.length, longestMs: Math.max(0, ...long),
};
appendFileSync(join(DATA, 'a8work.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
