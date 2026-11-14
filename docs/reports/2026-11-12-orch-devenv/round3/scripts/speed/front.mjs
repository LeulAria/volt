// Brings the test window (SPEED_CDP) to the front.
import { cdp } from './lib.mjs';
const c = await cdp();
await c.send('Page.bringToFront');
c.close();
