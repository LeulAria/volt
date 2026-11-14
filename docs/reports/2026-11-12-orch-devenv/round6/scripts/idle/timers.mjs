// Timer census of a Node/Electron process over its inspector: a logpoint on node:internal/timers' listOnTimeout
// (where `timer._onTimeout()` runs) records, for `secs` s, the repeat interval and the callback's source of every
// timer that fires, plus one on processImmediate. Prints distinct callbacks with fire counts. Analysis aid.
//   node timers.mjs <ws://inspector url> [secs=30] [--full]
import { connect, sleep } from './lib.mjs';

const [ws, secsArg = '30'] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const full = process.argv.includes('--full');
const secs = Number(secsArg);
const c = await connect(ws);
const scripts = new Map();
c.on('Debugger.scriptParsed', p => scripts.set(p.url, p.scriptId));
const seen = new Map();
c.on('Runtime.consoleAPICalled', p => {
	const a = p.args?.[0];
	if (a?.value && String(a.value).startsWith('LP:')) {
		const k = String(a.value).slice(3);
		seen.set(k, (seen.get(k) ?? 0) + 1);
	}
});
await c.send('Runtime.enable');
await c.send('Debugger.enable');
await sleep(500);
const timersId = scripts.get('node:internal/timers');
if (!timersId) {
	throw new Error('node:internal/timers not found; scripts: ' + [...scripts.keys()].filter(u => u.startsWith('node:')).slice(0, 5).join(', '));
}
const { result } = await c.send('Debugger.getScriptSource', { scriptId: timersId });
const lines = result.scriptSource.split('\n');
const lineOf = re => lines.findIndex(l => re.test(l));
const fireLine = lineOf(/^\s*timer\._onTimeout\(\);/);
const immLine = lineOf(/^\s*immediate\._onImmediate\(\);/);
if (fireLine < 0) {
	throw new Error('no timer._onTimeout() line in node:internal/timers');
}
const expr = (what, obj, fn) => `console.log('LP:' + ${what} + ' ' + String(${obj}._repeat || 0) + ' ' + String(${fn}).replace(/\\s+/g, ' ').slice(0, ${full ? 400 : 180}) + ' @' + (new Error().stack.split('\\n').slice(2, 7).map(s => s.trim().replace(/^at /, '').replace(/^.*\\/out\\//, '')).join(' < '))), false`;
const bp1 = await c.send('Debugger.setBreakpointByUrl', { url: 'node:internal/timers', lineNumber: fireLine, columnNumber: lines[fireLine].search(/\S/), condition: expr(`'T'`, 'timer', 'timer._onTimeout') });
const bp2 = immLine >= 0 ? await c.send('Debugger.setBreakpointByUrl', { url: 'node:internal/timers', lineNumber: immLine, columnNumber: lines[immLine].search(/\S/), condition: `console.log('LP:I 0 ' + String(immediate._onImmediate).replace(/\\s+/g, ' ').slice(0, 180)), false` }) : undefined;
if (!bp1.result?.locations?.length) {
	throw new Error('timer logpoint not set: ' + JSON.stringify(bp1).slice(0, 300));
}
const t0 = Date.now();
await sleep(secs * 1000);
const span = (Date.now() - t0) / 1000;
await c.send('Debugger.removeBreakpoint', { breakpointId: bp1.result.breakpointId });
if (bp2?.result) { await c.send('Debugger.removeBreakpoint', { breakpointId: bp2.result.breakpointId }); }
await c.send('Debugger.disable');
c.close();
let total = 0;
for (const v of seen.values()) { total += v; }
console.log(`timer fires: ${total} in ${span.toFixed(1)} s (${(total / span).toFixed(2)}/s), distinct callbacks ${seen.size}`);
for (const [k, v] of [...seen].sort((a, b) => b[1] - a[1])) {
	const [kind, repeat, ...rest] = k.split(' ');
	console.log(`${String(v).padStart(5)} ${(v / span).toFixed(2).padStart(6)}/s ${kind} every ${repeat} ms  ${rest.join(' ')}`);
}
