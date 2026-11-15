// Analysis aid (not a timing): the renderer's JS profile while 60 keys go into the composer of the chat on screen of a
// running arm (streams or not: with none, the key path alone shows). Prints inclusive/self per function as jsprof.mjs.
//   node keyprof.mjs [keys=60] [--new] [--out file.cpuprofile] [--interval us=100]
//   --new opens a new chat first (an idle composer, no stream behind it).
import { writeFileSync } from 'fs';
import { cdp, focusComposer, newChat, sleep } from './lib.mjs';
import { analyze } from './jsprof.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d;
const keys = Number(args.find(a => /^\d+$/.test(a)) ?? 60);
const PROBE_CHARS = 'abcdefghijklmnopqrstuvwxyz';
const c = await cdp();
await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
if (args.includes('--new')) {
	await newChat(c);
	await sleep(1500);
}
if (!await focusComposer(c)) {
	throw new Error('no composer');
}
await c.send('Profiler.enable');
await c.send('Profiler.setSamplingInterval', { interval: Number(opt('interval', 100)) });
await c.send('Profiler.start');
const t0 = Date.now();
for (let i = 0; i < keys; i++) {
	const ch = PROBE_CHARS[i % PROBE_CHARS.length];
	const code = ch.toUpperCase().charCodeAt(0);
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: ch });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
	await sleep(250 * (0.8 + Math.random() * 0.4));
}
await sleep(500);
const { result } = await c.send('Profiler.stop');
console.log(`${keys} keys over ${Date.now() - t0} ms`);
await c.key('a', 'KeyA', 65, 4);
await c.key('Backspace', 'Backspace', 8);
await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
c.close();
if (opt('out')) {
	writeFileSync(opt('out'), JSON.stringify(result.profile));
}
analyze(result.profile, Number(opt('top', 60)));
