// Opens a new chat (the new-chat page) in the test window and leaves it there.
import { cdp, newChat, sleep } from './lib.mjs';
const c = await cdp();
await c.send('Page.bringToFront');
await newChat(c);
await sleep(1000);
c.close();
