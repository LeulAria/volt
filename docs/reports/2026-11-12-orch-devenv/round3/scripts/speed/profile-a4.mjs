// One A4 run with a renderer CPU profile from 200 ms before Enter to 1.5 s after (writes <out>.cpuprofile)
//   node profile-a4.mjs <out>
import { writeFileSync } from 'fs';
import { cdp, focusComposer, newChat, sleep } from './lib.mjs';
const out = process.argv[2] ?? '/tmp/v3-speed/a4';
const c = await cdp();
await newChat(c);
await sleep(2500);
await focusComposer(c);
await c.send('Input.insertText', { text: 'replay:hi' });
await sleep(1500);
await c.send('Profiler.enable');
await c.send('Profiler.setSamplingInterval', { interval: 200 });
await c.send('Profiler.start');
await sleep(200);
const t0 = Date.now();
await c.key('Enter', 'Enter', 13, 0, '\r');
await sleep(1500);
const { result } = await c.send('Profiler.stop');
writeFileSync(`${out}.cpuprofile`, JSON.stringify(result.profile));
console.log('enter at', t0, 'profile start', result.profile.startTime);
c.close();
