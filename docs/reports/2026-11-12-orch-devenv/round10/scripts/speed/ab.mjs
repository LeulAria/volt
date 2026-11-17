// A3 (new thread to typing) and A4 (Enter to first word) on fresh launches of each arm, interleaved: per arm and rep a
// fresh launch, one seeded thread (`replay:seed`), then `a3.mjs <arm> <n3>` and `a4.mjs <arm> <n4>` (rows to
// data/speed/a3.jsonl, a4.jsonl). Each launch waits for the 1-minute load gate (14).
//   node ab.mjs <arms=minbase,minafter> [reps=2] [n3=6] [n4=6]
import { execFileSync } from 'child_process';
import { arm as armOf, cdp, freshProfile, launch, load1, newChat, send, sleep, stop, waitQuiet, waitWorkbench, writeSettings } from './lib.mjs';

const [armsArg = 'minbase,minafter', reps = '2', n3 = '6', n4 = '6'] = process.argv.slice(2);
for (let r = 0; r < Number(reps); r++) {
	const arms = armsArg.split(',').map(armOf);
	for (const arm of r % 2 ? arms.reverse() : arms) {
		await freshProfile(arm);
		const l = await waitQuiet(14);
		console.log(`== ${arm} rep ${r} load ${l} ${new Date().toISOString()}`);
		// A_PROJECT=1: the window opens on the arena, so new chats run in that project (ADEMark's precondition: "the
		// arena project selected"); without it the window has no folder and a new chat has no project (a scratch folder).
		const project = process.env.A_PROJECT === '1';
		writeSettings(arm);
		launch(arm, { keepRendering: true });
		await waitWorkbench();
		await sleep(8000);
		const c = await cdp();
		await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
		await newChat(c);
		await sleep(1500);
		if (project) {
			// The window opened on the arena (lib.launch, A_PROJECT=1): the new chat's project picker must name it.
			const pick = await c.evaluate('[...document.querySelectorAll(".volt-agent-landing-pick")].filter(e=>e.offsetParent).map(e=>e.innerText).join("|")');
			console.log('project: ' + pick);
			if (!/^arena/.test(pick ?? '')) { throw new Error('the new chat is not in the arena project'); }
		}
		await send(c, 'replay:seed');
		for (let i = 0; i < 100 && !await c.evaluate(`[...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).some(m => m.textContent.includes('unchanged'))`); i++) {
			await sleep(200);
		}
		await sleep(1500);
		c.close();
		const env = { ...process.env, A_ARM: arm, LOAD_MAX: process.env.LOAD_MAX ?? '14' };
		for (const [script, n] of [['a3.mjs', n3], ['a4.mjs', n4]]) {
			try {
				console.log(execFileSync('node', [script, arm, n], { env, encoding: 'utf8', timeout: 600_000 }).trim().split('\n').at(-1));
			} catch (err) {
				console.log(`${script} failed`, String(err).slice(0, 300));
			}
		}
		console.log(`load after ${load1()}`);
		await stop(arm);
		await sleep(8000);
	}
}
