#!/usr/bin/env node
// Waits until the test window lists the seeded chats (opening the sidebar if a restart left it
// closed), then lets the window idle for `--idle` ms.
//   node ready.mjs [--port 9953] [--chat "Short thread"] [--idle 8000]
import { connect, rowCenter, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const port = Number(opt('port', '9953'));
const chat = opt('chat', 'Short thread');
const idle = Number(opt('idle', '8000'));

let cdp;
for (let i = 0; i < 60 && !cdp; i++) {
	try {
		cdp = await connect(port);
	} catch {
		await sleep(1000);
	}
}
for (let i = 0; i < 120; i++) {
	try {
		if (await rowCenter(cdp, chat)) {
			await sleep(idle);
			cdp.close();
			process.exit(0);
		}
		if (i % 6 === 5) {
			await cdp.evaluate(`(() => { if (document.querySelector('.monaco-list-row .volt-agent-home-row, .monaco-list-row')?.textContent.includes(${JSON.stringify(chat)})) return; const t = document.querySelector('[aria-label^="Toggle Primary Side Bar"]'); t && t.click(); })()`);
		}
	} catch { }
	await sleep(500);
}
console.error('chats never listed');
process.exit(1);
