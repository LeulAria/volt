// Child-process census of a Node/Electron process over its inspector: wraps ChildProcess.prototype.spawn (every
// spawn/exec/execFile/fork goes through it) for `secs` s and prints what was started, with a short JS stack of the
// caller. Analysis aid.
//   node spawns.mjs <ws://inspector url> [secs=90]
import { connect, sleep } from './lib.mjs';

const [ws, secsArg = '90'] = process.argv.slice(2);
const secs = Number(secsArg);
const c = await connect(ws);
await c.send('Runtime.enable');
const install = `(() => {
	const cp = require('child_process');
	const g = globalThis;
	if (!g.__voltSpawnLog) {
		g.__voltSpawnLog = [];
		const orig = cp.ChildProcess.prototype.spawn;
		cp.ChildProcess.prototype.spawn = function (o) {
			try {
				const stack = new Error().stack.split('\\n').slice(2, 9).map(s => s.trim().replace(/^at /, '').replace(/^.*\\/out\\//, '').replace(/^.*node:internal\\S*/, 'node')).filter(s => !/^node/.test(s)).slice(0, 4).join(' < ');
				g.__voltSpawnLog.push(new Date().toISOString().slice(11, 23) + ' ' + String(o.file) + ' ' + (o.args || []).slice(1).join(' ').slice(0, 160) + '  @' + stack);
			} catch { }
			return orig.call(this, o);
		};
	}
	g.__voltSpawnLog.length = 0;
	return 'installed';
})()`;
const r = await c.send('Runtime.evaluate', { expression: install, includeCommandLineAPI: true, returnByValue: true });
if (r.result?.exceptionDetails) {
	throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
}
await sleep(secs * 1000);
const out = await c.send('Runtime.evaluate', { expression: 'JSON.stringify(globalThis.__voltSpawnLog)', returnByValue: true });
c.close();
const lines = JSON.parse(out.result.result.value);
console.log(`${lines.length} spawns in ${secs} s`);
for (const l of lines) {
	console.log(l);
}
