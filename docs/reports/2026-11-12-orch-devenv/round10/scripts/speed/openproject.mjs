// What project a new chat gets: after a launch with the folder as the last argument (round 8's rig), after the app's
// own CLI opens the folder while the app runs (ADEMark's openProject step for Volt), and after Cmd+N there.
//   node openproject.mjs <arm>      (untimed; A_PROJECT unset)
import { execFileSync } from 'child_process';
import { arm as armOf, ARMS, cdp, freshProfile, launch, newChat, sleep, stop, targets, ud, ext, waitWorkbench, writeSettings, FOLDER } from './lib.mjs';
const arm = armOf(process.argv[2] ?? 'r8');
await freshProfile(arm);
writeSettings(arm);
launch(arm, { keepRendering: true });
await waitWorkbench();
await sleep(6000);
const pick = async () => { const c = await cdp(); const v = await c.evaluate('[...document.querySelectorAll(".volt-agent-landing-pick")].filter(e=>e.offsetParent).map(e=>e.innerText).join("|") + " // " + document.title'); c.close(); return v; };
console.log('after launch with folder arg:', await pick());
// ADEMark's openProject step for Volt: the app's own CLI with the folder, while the app runs.
try { console.log(execFileSync(`${ARMS[arm]}/Contents/Resources/app/bin/code`, ['--user-data-dir', ud(arm), '--extensions-dir', ext(arm), FOLDER], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }).slice(0, 200)); } catch (e) { console.log('cli failed', String(e).slice(0, 200)); }
await sleep(5000);
console.log('targets:', JSON.stringify((await targets()).map(t => [t.type, t.title])));
console.log('after `code <folder>`:', await pick());
{ const c = await cdp(); await c.key('n', 'KeyN', 78, 4); await sleep(2500); c.close(); }
console.log('after Cmd+N:', await pick());
await stop(arm);
