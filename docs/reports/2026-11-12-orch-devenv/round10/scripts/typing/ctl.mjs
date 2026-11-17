// node ctl.mjs launch <arm> [--keep]   start an arm (before|after) on CDP 9949 and wait for the workbench
// node ctl.mjs stop <arm>              quit it and kill what is left of its profile
// node ctl.mjs seed <arm> [n=5]        ADEMark seeded state: n new threads answered `replay:seed` (marker "unchanged")
// node ctl.mjs procs <arm>             the arm's processes by role
import { cdp, launch, load1, newChat, profileProcesses, role, send, sleep, stop, waitWorkbench, writeSettings } from './lib.mjs';

const [cmd, arm = 'after', ...rest] = process.argv.slice(2);
if (cmd === 'launch') {
	writeSettings(arm);
	const pid = launch(arm, { keepRendering: rest.includes('--keep') });
	const ms = await waitWorkbench();
	console.log(JSON.stringify({ arm, pid, ms, load: load1() }));
} else if (cmd === 'stop') {
	await stop(arm);
	console.log(`stopped ${arm}; left: ${profileProcesses(arm).length}`);
} else if (cmd === 'seed') {
	const n = Number(rest[0] ?? 5);
	const marker = `[...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).some(m => m.textContent.includes('unchanged'))`;
	const c = await cdp();
	for (let i = 0; i < n; i++) {
		await newChat(c);
		await sleep(1500);
		await send(c, 'replay:seed');
		let ok = false;
		for (let t = 0; t < 150 && !ok; t++) {
			await sleep(200);
			ok = await c.evaluate(marker);
		}
		console.log(`thread ${i + 1}: ${ok ? 'seeded' : 'no seed reply in 30 s'}`);
		await sleep(1500);
	}
	c.close();
} else if (cmd === 'procs') {
	for (const p of profileProcesses(arm)) {
		console.log(String(p.pid).padStart(6), role(p.cmd).padEnd(20), String(Math.round(p.rssKiB / 1024)).padStart(5), 'MiB', p.cmd.slice(0, 140));
	}
} else {
	console.error('usage: ctl.mjs launch|stop|seed|procs <arm>');
	process.exit(2);
}
