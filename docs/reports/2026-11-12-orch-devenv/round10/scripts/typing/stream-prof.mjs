// Analysis aid (not a timing): the renderer's JS profile while 5 chats stream, as in A8 (a8.mjs's setup).
//   node stream-prof.mjs <arm> [secs=15] [out.cpuprofile]
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { cdp, launch, newChat, send, sleep, stop, waitQuiet, waitWorkbench, writeSettings } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [arm = 'after', secs = '15', out] = process.argv.slice(2);
await waitQuiet(14);
writeSettings(arm);
launch(arm, { keepRendering: true });
await waitWorkbench();
await sleep(8000);
const c = await cdp();
await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
for (let n = 1; n <= 5; n++) {
	await newChat(c);
	await sleep(1500);
	await send(c, `replay:stream-${n}`);
	await sleep(2000);
}
await sleep(8000);
c.close();
process.stdout.write(execFileSync('node', [join(here, 'jsprof.mjs'), secs, '--focus', ...(out ? ['--out', out] : [])], { encoding: 'utf8' }));
await stop(arm);
