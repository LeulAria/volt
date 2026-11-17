// What a new chat's project picker reads right after launch with the arena folder as the window's folder (no pick):
// tells whether `volt <folder>` + Cmd+N (ADEMark's openProject steps for Volt) gives the new chat that project.
//   node landing.mjs <arm>
import { arm as armOf, cdp, freshProfile, launch, newChat, sleep, stop, waitWorkbench, writeSettings } from './lib.mjs';
const arm = armOf(process.argv[2] ?? 'r8');
await freshProfile(arm);
writeSettings(arm);
launch(arm, { keepRendering: true });
await waitWorkbench();
await sleep(8000);
const c = await cdp();
await newChat(c);
await sleep(2500);
console.log(JSON.stringify({ arm, pick: await c.evaluate('[...document.querySelectorAll(".volt-agent-landing-pick")].filter(e=>e.offsetParent).map(e=>e.innerText).join("|")'), title: await c.evaluate('document.title') }));
c.close();
await stop(arm);
