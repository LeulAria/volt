import { cdp } from './lib.mjs';
const c = await cdp();
await c.evaluate(`(() => { let s = document.getElementById('probecss'); if (!s) { s = document.createElement('style'); s.id = 'probecss'; document.head.appendChild(s); } s.textContent = ${JSON.stringify(process.argv[2] ?? '')}; })()`);
c.close(); process.exit(0);
