// Analysis aid: a fresh launch of an arm with 5 streams, then typeprof --light (frame and task distribution, key stages).
//   node light.mjs <arm|name=/path> [out.txt]
import { execSync } from 'child_process';
import { arm as armOf, cdp, launch, load1, newChat, send, sleep, stop, waitWorkbench, writeSettings } from './lib.mjs';
import { freshProfile } from './a8.mjs';
const arm = armOf(process.argv[2] ?? 'after');
await freshProfile(arm);
writeSettings(arm);
launch(arm, { keepRendering: true });
await waitWorkbench();
await sleep(8000);
const c = await cdp();
await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
for (let n = 1; n <= 5; n++) { await newChat(c); await sleep(1500); await send(c, `replay:stream-${n}`); await sleep(2000); }
c.close();
await sleep(8000);
console.log(`== ${arm} load ${load1()}`);
console.log(execSync(`node typeprof.mjs 60 --light ${process.argv[3] ? `--out ${process.argv[3]}` : ''}`, { maxBuffer: 64 << 20 }).toString());
if (process.env.LIGHT_KEEP !== '1') { await stop(arm); }
