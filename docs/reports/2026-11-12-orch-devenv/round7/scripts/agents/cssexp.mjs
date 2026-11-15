// Exploratory: does a style change remove GPU render passes / layers at rest? Dumps the GPU's shared images
// (gputiles.mjs), applies `js` in the test window, forces a few frames (a 1 px box changing colour), dumps again.
// The change stays in the window (relaunch to undo).
//   node cssexp.mjs '<js>'      e.g. node cssexp.mjs "document.querySelectorAll('.volt-agent-turn.user').forEach(e => e.style.position = 'static')"
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { cdp, sleep } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const js = process.argv[2];
const tiles = () => execFileSync('node', [join(here, 'gputiles.mjs')], { encoding: 'utf8' }).split('\n').filter(l => /RenderPass|VizBuffer|raster tiles|shared images/.test(l)).join('\n');
const c = await cdp();
const frames = async () => {
	await c.evaluate(`(() => { let b = document.getElementById('__px'); if (!b) { b = document.createElement('div'); b.id = '__px'; b.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;z-index:99999'; document.body.appendChild(b); } return true; })()`);
	for (let i = 0; i < 4; i++) {
		await c.evaluate(`document.getElementById('__px').style.background = ['red','blue','green','yellow'][${i}]`);
		await sleep(300);
	}
	await c.evaluate(`document.getElementById('__px').remove()`);
	await sleep(4000);
};
await frames();
console.log('-- before\n' + tiles());
if (js) {
	console.log('applied:', await c.evaluate(`(() => { ${js}; return 'ok'; })()`));
	await frames();
	console.log('-- after\n' + tiles());
}
c.close();
