// ADEMark seeded state: n finished threads, each `replay:seed` answered by the replay server. The test window must
// have the arena project selected (setup.sh, then pick ~/.volt-r6/firstword/arena once in the project picker).
//   node seed.mjs [n=5]
import { cdp, focusComposer, newChat, sleep } from './lib.mjs';

const n = Number(process.argv[2] ?? 5);
const marker = `[...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).some(m => m.textContent.includes('unchanged'))`;
const c = await cdp();
for (let i = 0; i < n; i++) {
	await newChat(c);
	await sleep(1500);
	if (!await focusComposer(c)) {
		throw new Error('no composer');
	}
	await c.send('Input.insertText', { text: 'replay:seed' });
	await sleep(400);
	await c.key('Enter', 'Enter', 13, 0, '\r');
	let ok = false;
	for (let t = 0; t < 150 && !ok; t++) {
		await sleep(200);
		ok = await c.evaluate(marker);
	}
	console.log(`thread ${i + 1}: ${ok ? 'seeded' : 'no seed reply in 30 s'}`);
	await sleep(1500);
}
c.close();
