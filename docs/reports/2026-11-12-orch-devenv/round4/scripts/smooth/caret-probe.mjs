// Native caret check: a plain <input> (put in the window for the test, removed after) is focused, and a 6 s trace
// counts the frames drawn while nothing else changes. A blinking caret draws about 2 frames a second.
//   node caret-probe.mjs
import { cdp, sleep } from './lib.mjs';
import { execFileSync } from 'child_process';
const c = await cdp();
await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
console.log(await c.evaluate(`(() => { const i = document.createElement('input'); i.id = 'v4s-caret-probe'; i.style.cssText = 'position:fixed;left:300px;top:300px;z-index:99999;width:200px'; document.body.appendChild(i); i.focus(); return document.activeElement === i; })()`));
c.close();
await sleep(2000);
const out = execFileSync('node', [new URL('./idle-trace.mjs', import.meta.url).pathname, '6', '--focus']).toString();
console.log(out.split('\n').filter(l => /DrawAndSwap|display link|"secs"/.test(l)).join('\n'));
const d = await cdp();
await d.evaluate(`document.getElementById('v4s-caret-probe')?.remove()`);
d.close();
