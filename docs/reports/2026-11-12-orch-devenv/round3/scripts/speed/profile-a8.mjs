// Renderer CPU profile for <s> seconds while the open streams run, typing one probe letter every 250 ms
//   node profile-a8.mjs <out> [seconds=8]
import { writeFileSync } from 'fs';
import { cdp, focusComposer, sleep } from './lib.mjs';
const out = process.argv[2] ?? '/tmp/v3-speed/a8';
const secs = Number(process.argv[3] ?? 8);
const c = await cdp();
await focusComposer(c);
await c.send('Profiler.enable');
await c.send('Profiler.setSamplingInterval', { interval: 500 });
await c.send('Profiler.start');
for (let i = 0; i < secs * 4; i++) {
	const ch = 'ademarkqz'[i % 9];
	const kc = ch.toUpperCase().charCodeAt(0);
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
	await sleep(250);
}
const { result } = await c.send('Profiler.stop');
writeFileSync(`${out}.cpuprofile`, JSON.stringify(result.profile));
await c.key('a', 'KeyA', 65, 4);
await c.key('Backspace', 'Backspace', 8);
c.close();
