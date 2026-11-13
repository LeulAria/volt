// node shot.mjs <out.png>   screenshot of the test window, plus the visible New Chat and composer state
import { writeFileSync } from 'fs';
import { cdp } from './lib.mjs';
const c = await cdp();
const r = await c.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(process.argv[2] ?? '/tmp/v3-speed/shot.png', Buffer.from(r.result.data, 'base64'));
console.log(await c.evaluate(`JSON.stringify({ title: document.title, size: [innerWidth, innerHeight], newChat: !![...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^New (Chat|Agent)/.test(e.getAttribute('aria-label'))), composers: [...document.querySelectorAll('textarea.inputarea')].filter(e => e.offsetParent).length, agent: !!document.querySelector('.volt-agent-editor-main') })`));
c.close();
