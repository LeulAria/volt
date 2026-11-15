// node shot.mjs [out=/tmp/v4s-shot.png]  screenshot of the test window over CDP
import { writeFileSync } from 'fs';
import { cdp } from './lib.mjs';
const c = await cdp();
const r = await c.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(process.argv[2] ?? '/tmp/v4s-shot.png', Buffer.from(r.result.data, 'base64'));
console.log(await c.evaluate('JSON.stringify({vis: document.visibilityState, focus: document.hasFocus(), w: innerWidth, h: innerHeight})'));
c.close();
