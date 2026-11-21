import { cdp, newChat, focusComposer, paste, sleep } from './lib.mjs';
const c = await cdp();
await newChat(c); await sleep(1500); await focusComposer(c);
await paste(c, process.argv[2] ?? 'replay:stream-1'); await sleep(400); await c.key('Enter', 'Enter', 13, 0, '\r');
c.close(); process.exit(0);
