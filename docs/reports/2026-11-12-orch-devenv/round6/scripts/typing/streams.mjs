// Starts an arm with 5 chats streaming (A8's setup) and leaves it running for analysis tools. Analysis aid.
//   node streams.mjs <arm>
import { cdp, launch, newChat, send, sleep, waitWorkbench, writeSettings } from './lib.mjs';
const [arm = 'after'] = process.argv.slice(2);
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
c.close();
console.log('streaming');
