/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CPU profile of one streamed scenario in a Volt test instance: opens a new chat, sends the
// prompt, samples the renderer until the turn finishes, and prints the heaviest functions by
// self time and by total time (own source files only).
// Usage: node build/volt/renderSuite/voltProfile.mjs --port 9961 [--save out.cpuprofile] 'bench:r09 cps=600'

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(path.join(import.meta.dirname, '..', '..', '..', 'package.json'));
const CDP = require('chrome-remote-interface');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i < 0 ? fallback : args.splice(i, 2)[1];
};
const port = Number(opt('port', '9961'));
const save = opt('save', undefined);
const prompt = args[0] ?? 'bench:r09 cps=600';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const targets = await CDP.List({ port });
const client = await CDP({ port, target: targets.find(t => t.type === 'page' && /workbench/.test(t.url)) });
const ev = async body => (await client.Runtime.evaluate({ expression: `(() => { ${body} })()`, returnByValue: true })).result.value;

const p = await ev(`const r = document.querySelector('.volt-agent-home-row.is-new').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
	await client.Input.dispatchMouseEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
}
await sleep(1200);
await ev(`const ta = [...document.querySelectorAll('textarea.inputarea')].find(t => t.getClientRects().length && t.closest('.volt-agent-editor')); ta.focus(); return 1;`);
await client.Input.insertText({ text: prompt });
await client.Profiler.enable();
await client.Profiler.setSamplingInterval({ interval: 200 });
await client.Profiler.start();
await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
const until = Date.now() + 180000;
while (Date.now() < until && !(await ev(`const t = [...document.querySelectorAll('.volt-agent-turn.agent')].pop(); return !!t?.querySelector('.volt-agent-footer');`))) {
	await sleep(150);
}
const { profile } = await client.Profiler.stop();
await client.close();
if (save) {
	fs.writeFileSync(save, JSON.stringify(profile));
}

// Self time per node from samples, then roll up by function and by total (inclusive) time.
const byId = new Map(profile.nodes.map(n => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) {
	for (const c of n.children ?? []) {
		parent.set(c, n.id);
	}
}
const self = new Map();
for (let i = 0; i < profile.samples.length; i++) {
	const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
	self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + dt);
}
const label = n => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/out\//, '').replace(/^.*\/node_modules\//, 'nm/')}:${n.callFrame.lineNumber + 1}`;
const selfBy = new Map();
const totalBy = new Map();
for (const [id, ms] of self) {
	const node = byId.get(id);
	selfBy.set(label(node), (selfBy.get(label(node)) ?? 0) + ms);
	const seen = new Set();
	for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
		const l = label(byId.get(cur));
		if (!seen.has(l)) {
			seen.add(l);
			totalBy.set(l, (totalBy.get(l) ?? 0) + ms);
		}
	}
}
const top = (map, n, filter = () => true) => [...map].filter(([l]) => filter(l)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([l, ms]) => `${ms.toFixed(0).padStart(6)} ms  ${l}`).join('\n');
console.log('--- self time ---\n' + top(selfBy, 30));
console.log('--- total time (vs/ only) ---\n' + top(totalBy, 45, l => / vs\//.test(l)));
