// Every live Node timer of a process over its inspector (round 7): Runtime.queryObjects on Timeout's prototype, then
// each timer's repeat interval, whether it is ref'd, and its callback's source and location. Finds intervals created
// before any hook could be installed. Analysis aid.
//   node live-timers.mjs <ws://inspector url> [--all]   (default: repeating or short timers only)
import { connect } from './lib.mjs';

const [ws] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const all = process.argv.includes('--all');
const c = await connect(ws);
const call = async (method, params) => {
	const r = await c.send(method, params);
	if (r.error || r.result?.exceptionDetails) {
		throw new Error(JSON.stringify(r.error ?? r.result.exceptionDetails).slice(0, 300));
	}
	return r.result;
};
await call('Runtime.enable', {});
const proto = await call('Runtime.evaluate', { expression: '(() => { const t = setTimeout(() => {}, 1e9); clearTimeout(t); return Object.getPrototypeOf(t); })()' });
const list = await call('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
const summary = await call('Runtime.callFunctionOn', {
	objectId: list.objects.objectId,
	functionDeclaration: `function () { return this.filter(t => !t._destroyed && t._idleTimeout > 0).map((t, i) => ({ i, repeat: t._repeat, idle: t._idleTimeout, ref: typeof t.hasRef === 'function' ? t.hasRef() : undefined, src: String(t._onTimeout).replace(/\\s+/g, ' ').slice(0, 220) })); }`,
	returnByValue: true,
});
const timers = summary.result.value.filter(t => all || t.repeat || t.idle <= 5000);
// Locations: the callback function's [[FunctionLocation]].
const fns = await call('Runtime.callFunctionOn', {
	objectId: list.objects.objectId,
	functionDeclaration: 'function () { return this.filter(t => !t._destroyed && t._idleTimeout > 0).map(t => t._onTimeout); }',
});
const props = await call('Runtime.getProperties', { objectId: fns.result.objectId, ownProperties: true });
const scripts = new Map();
c.on('Debugger.scriptParsed', p => scripts.set(p.scriptId, p.url));
await call('Debugger.enable', {});
for (const t of timers) {
	const fn = props.result.find(p => p.name === String(t.i))?.value;
	let where = '';
	if (fn?.objectId) {
		const internal = await call('Runtime.getProperties', { objectId: fn.objectId, ownProperties: true });
		const loc = internal.internalProperties?.find(p => p.name === '[[FunctionLocation]]')?.value?.value;
		if (loc) {
			where = `${(scripts.get(loc.scriptId) ?? loc.scriptId).replace(/^.*\/out\//, '')}:${loc.lineNumber + 1}:${loc.columnNumber}`;
		}
	}
	console.log(`${t.repeat ? `every ${t.repeat} ms` : `once in ${t.idle} ms`}${t.ref === false ? ' (unref)' : ''}  ${where}\n    ${t.src}`);
}
console.log(`${summary.result.value.length} live timers, ${timers.length} shown`);
c.close();
