import { cdp } from './lib.mjs';
const c = await cdp();
const r = await Promise.race([c.evaluate(`[...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).map(e => e.innerText.slice(0, 1500)).join('\\n----\\n')`), new Promise(r => setTimeout(() => r('timeout'), 8000))]);
console.log(r); c.close(); process.exit(0);
