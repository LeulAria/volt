// Logpoint in the test window: logs `expr` each time line:col (0-based, as in the trace's FunctionCall) of a script
// whose URL matches `urlRegex` runs, for `secs` seconds; prints the distinct values with counts. Analysis aid.
//   node logpoint.mjs <urlRegex> <line> <col> <expr> [secs=10]
import { cdp, sleep } from './lib.mjs';

const [urlRegex, line, col, expr, secs = '10'] = process.argv.slice(2);
const c = await cdp();
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
const r = await c.send('Debugger.setBreakpointByUrl', { urlRegex, lineNumber: Number(line), columnNumber: Number(col), condition: `console.log('LP:' + String((() => { try { return ${expr}; } catch (e) { return 'ERR ' + e; } })()).slice(0, 300)), false` });
console.log('locations', JSON.stringify(r.result?.locations ?? r.error));
await sleep(Number(secs) * 1000);
await c.send('Debugger.removeBreakpoint', { breakpointId: r.result.breakpointId });
await c.send('Debugger.disable');
c.close();
for (const [k, v] of [...seen].sort((a, b) => b[1] - a[1])) {
	console.log(String(v).padStart(5), k);
}
