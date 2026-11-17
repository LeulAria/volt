// Starts 5 more streaming chats in the running arm (its earlier streams ended: the replay streams 3 min). Analysis aid.
//   node restream.mjs [n=5]
import { cdp, newChat, send, sleep } from './lib.mjs';
const n = Number(process.argv[2] ?? 5);
const c = await cdp();
await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
for (let i = 1; i <= n; i++) {
	await newChat(c);
	await sleep(1500);
	await send(c, `replay:stream-${i}`);
	await sleep(2000);
}
c.close();
console.log('streaming');
