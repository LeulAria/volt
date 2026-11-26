// Injects a CSS file into the running test window (exploratory variants).  node inject.mjs <file.css>
import { readFileSync } from 'fs';
import { cdp } from './lib.mjs';
const c = await cdp();
await c.evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(readFileSync(process.argv[2], 'utf8'))}; document.head.appendChild(s); })()`);
c.close();
