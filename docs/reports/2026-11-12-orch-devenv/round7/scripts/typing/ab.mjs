// A3 (new thread to typing) and A4 (Enter to first word) on fresh launches of each arm, interleaved: per arm and rep a
// fresh launch, one seeded thread (`replay:seed`), then `a3.mjs <arm> <n3>` and `a4.mjs <arm> <n4>` (rows to
// data/typing/a3.jsonl, a4.jsonl). Each launch waits for the 1-minute load gate (14).
//   node ab.mjs <arms=minbase,minafter> [reps=2] [n3=6] [n4=6]
import { execFileSync } from 'child_process';
import { cdp, launch, load1, newChat, send, sleep, stop, waitQuiet, waitWorkbench, writeSettings } from './lib.mjs';

const [armsArg = 'minbase,minafter', reps = '2', n3 = '6', n4 = '6'] = process.argv.slice(2);
for (let r = 0; r < Number(reps); r++) {
	const arms = armsArg.split(',');
	for (const arm of r % 2 ? arms.reverse() : arms) {
		const l = await waitQuiet(14);
		console.log(`== ${arm} rep ${r} load ${l} ${new Date().toISOString()}`);
		writeSettings(arm);
		launch(arm, { keepRendering: true });
		await waitWorkbench();
		await sleep(8000);
		const c = await cdp();
		await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
		await newChat(c);
		await sleep(1500);
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
