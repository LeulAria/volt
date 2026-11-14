// The "blocked by the sandbox" card, live: an arm with the real model (Haiku 5.5, not the replay server) is asked to
// run a write outside its workspace; the sandbox refuses it and the chat must show the denial card naming the file.
//   node denial-card.mjs <arm>     prints one JSON line (card seen, its text, seconds from send to card)
import { spawn } from 'child_process';
import { mkdirSync, openSync, existsSync, rmSync } from 'fs';
import { ARMS, cdp, ext, FOLDER, HOME, newChat, PORT, send, sleep, stop, ud, waitWorkbench, writeSettings } from './lib.mjs';

const [arm = 'after'] = process.argv.slice(2);
const target = `${HOME}/volt-r5-sbx-probe-${arm}.txt`;
rmSync(target, { force: true });
writeSettings(arm, { 'volt.agent.defaultModel': 'agent:seed-claude-code:claude-haiku-5-5' });
mkdirSync(ud(arm), { recursive: true });
const env = { ...process.env };
for (const k of Object.keys(env)) {
	if (/^(CLAUDE|VSCODE_|ELECTRON_RUN_AS_NODE$|ANTHROPIC_)/.test(k)) {
		delete env[k];
	}
}
env.VSCODE_SKIP_PRELAUNCH = '1';
const log = openSync(`${ud(arm)}.log`, 'a');
spawn('./scripts/code.sh', ['--user-data-dir', ud(arm), '--extensions-dir', ext(arm), `--remote-debugging-port=${PORT}`, FOLDER], { cwd: ARMS[arm], env, detached: true, stdio: ['ignore', log, log] }).unref();
await waitWorkbench();
await sleep(6000);
const c = await cdp();
await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
await newChat(c);
await sleep(1500);
const sentAt = Date.now();
await send(c, `Run exactly this one shell command with your Bash tool and nothing else, then reply with its output: touch ${target}`);
let card;
for (let i = 0; i < 300 && !card; i++) {
	await sleep(500);
	// The agent asks before it runs a command: approve this one run.
	await c.evaluate(`(() => { const b = [...document.querySelectorAll('button, .monaco-button, [role="button"]')].find(e => e.offsetParent && /^Run[^A-Za-z]*$/.test(e.textContent.trim())); if (b) { b.click(); } })()`);
	card = await c.evaluate(`(() => { const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent); const t = ed?.querySelector('.volt-agent-thread-inner')?.textContent ?? ''; const i = t.indexOf('Blocked by the sandbox'); const m = /Writing [^ ]*volt-r5-sbx-probe[^ ]* was blocked/.exec(t); return i >= 0 && m ? m[0] : undefined; })()`);
}
const seconds = card ? Math.round((Date.now() - sentAt) / 100) / 10 : null;
const transcript = await c.evaluate(`(() => { const ed = [...document.querySelectorAll('.volt-agent-editor')].find(e => e.offsetParent); return ed?.querySelector('.volt-agent-thread-inner')?.textContent?.slice(-400); })()`);
c.close();
console.log(JSON.stringify({ arm, card: !!card, cardText: card ?? null, secondsFromSend: seconds, written: existsSync(target), transcriptTail: transcript }));
await stop(arm);
