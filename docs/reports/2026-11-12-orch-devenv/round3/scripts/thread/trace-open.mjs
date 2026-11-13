#!/usr/bin/env node
// Timeline trace of a chat switch: style recalcs (elements), layouts (objects), scripts and paints
// on the renderer main thread, from the click until `--ms` later.
//   node trace-open.mjs --chat "Long thread 41k" [--from "Short thread"] [--ms 1500] [--out trace.json]
import fs from 'node:fs';
import { connect, rowCenter, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const port = Number(opt('port', '9953'));
const chat = opt('chat', 'Long thread 41k');
const from = opt('from', 'Short thread');
const ms = Number(opt('ms', '1500'));
const out = opt('out');

const cdp = await connect(port);
const fromAt = await rowCenter(cdp, from);
await cdp.click(fromAt.x, fromAt.y);
await sleep(2500);
const events = [];
let done;
const finished = new Promise(r => done = r);
cdp.on(m => {
	if (m.method === 'Tracing.dataCollected') {
		events.push(...m.params.value);
	} else if (m.method === 'Tracing.tracingComplete') {
		done();
	}
});
await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
await sleep(200);
const at = await rowCenter(cdp, chat);
await cdp.click(at.x, at.y);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 60 });
await sleep(ms);
await cdp.send('Tracing.end');
await finished;
cdp.close();
if (out) {
	fs.writeFileSync(out, JSON.stringify(events));
}
const main = events.filter(e => e.ph === 'X' && e.dur !== undefined);
const click = events.find(e => e.name === 'EventDispatch' && e.args?.data?.type === 'mousedown');
const t0 = click?.ts ?? Math.min(...main.map(e => e.ts));
const sum = name => main.filter(e => e.name === name && e.ts >= t0).reduce((s, e) => s + e.dur / 1000, 0);
const list = (name, f) => main.filter(e => e.name === name && e.ts >= t0).sort((a, b) => b.dur - a.dur).slice(0, 8).map(e => `@${((e.ts - t0) / 1000).toFixed(0)} ${(e.dur / 1000).toFixed(1)}ms${f ? ' ' + f(e) : ''}`).join(', ');
console.log(`script ${sum('FunctionCall').toFixed(1)} ms, style ${sum('UpdateLayoutTree').toFixed(1)} ms, layout ${sum('Layout').toFixed(1)} ms, paint ${sum('Paint').toFixed(1)} ms, raster/commit ${(sum('Commit') + sum('PrePaint')).toFixed(1)} ms`);
console.log('style:', list('UpdateLayoutTree', e => `${e.args?.elementCount ?? ''}el`));
console.log('layout:', list('Layout', e => `${e.args?.beginData?.dirtyObjects ?? ''}/${e.args?.beginData?.totalObjects ?? ''}obj`));
