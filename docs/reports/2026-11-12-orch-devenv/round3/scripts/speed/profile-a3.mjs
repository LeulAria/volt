// One A3 run with a renderer CPU profile: 200 ms before the New Agent click to 800 ms after (writes <out>.cpuprofile)
//   node profile-a3.mjs <out>
import { writeFileSync } from 'fs';
import { cdp, sleep } from './lib.mjs';
const out = process.argv[2] ?? '/tmp/v3-speed/a3';
const c = await cdp();
const button = await c.center(`[...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^New (Chat|Agent)/.test(e.getAttribute('aria-label')))`);
await c.send('Profiler.enable');
await c.send('Profiler.setSamplingInterval', { interval: 200 });
await c.send('Profiler.start');
await sleep(200);
await c.click(...button);
for (let i = 0; i < 12; i++) {
	const ch = 'ademarkqz'[i % 9];
	const kc = ch.toUpperCase().charCodeAt(0);
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
	await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
	await sleep(50);
}
const { result } = await c.send('Profiler.stop');
writeFileSync(`${out}.cpuprofile`, JSON.stringify(result.profile));
await c.key('a', 'KeyA', 65, 4);
await c.key('Backspace', 'Backspace', 8);
c.close();
