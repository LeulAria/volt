// No-capability-loss check for the idle stop (live model, after arm): chat A learns a code word, chat B takes a turn,
// A's agent is left idle past its 30 s grace (stopped), A is opened again and asked for the word. Pass = the answer
// carries the word and the agent server logged a session/resume (not a new session with a recap) for A.
//   node launch.mjs --live; node livecheck.mjs; node launch.mjs stop   (row appended to data/weight/livecheck.jsonl)
import { appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { cdp, DATA, focusComposer, load, newChat, sleep, UD } from './lib.mjs';

const WORD = `PELICAN-${Math.floor(Math.random() * 900 + 100)}`;
const c = await cdp();
const text = () => c.evaluate(`[...document.querySelectorAll('.volt-agent-editor-main')].filter(e => e.offsetParent).map(m => m.textContent).join('\\n')`);
const count = (s, w) => s.split(w).length - 1;
async function send(prompt, until) {
	if (!await focusComposer(c)) { throw new Error('no composer'); }
	await c.send('Input.insertText', { text: prompt });
	await sleep(400);
	await c.key('Enter', 'Enter', 13, 0, '\r');
	for (let i = 0; i < 600; i++) {
		await sleep(200);
		if (await until()) { return true; }
	}
	return false;
}

await newChat(c);
await sleep(1500);
const a1 = await send(`Remember this code word for later in this chat: ${WORD}. Reply with only the word ACK in lowercase.`, async () => /\back\b/.test((await text()).split(WORD).at(-1) ?? ''));
await sleep(2000);
await newChat(c);
await sleep(1500);
await send('What is two plus two? Reply with only the digit.', async () => /\b4\b/.test(await text()));
const idleFrom = new Date().toISOString();
await sleep(45_000);
// A is the second row of the chat list now (B is the most recent).
const pt = await c.evaluate(`(() => { const e = [...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent && /code word|PELICAN|Remember/i.test(e.getAttribute('aria-label') || ''))[0]; if (!e) { return null; } const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
if (!pt) { throw new Error('chat A not in the list: ' + JSON.stringify(await c.evaluate(`[...document.querySelectorAll('.monaco-list-row')].filter(e => e.offsetParent).map(e => e.getAttribute('aria-label')).slice(0, 12)`))); }
await c.click(pt[0], pt[1]);
await sleep(3000);
const before = count(await text(), WORD);
const ok = await send('What was the code word I gave you? Reply with only the code word.', async () => count(await text(), WORD) > before);
await sleep(1500);
const log = readFileSync(join(UD, 'logs', 'agent-server.log'), 'utf8').split('\n').filter(l => l.slice(0, 24) >= idleFrom);
const row = {
	test: 'resume-recall', at: new Date().toISOString(), load: load(), word: WORD, taught: a1, recalled: ok,
	resumed: log.filter(l => /session\/resume/.test(l)).length, newSessions: log.filter(l => /session\/new/.test(l)).length,
	resourceNotFound: log.filter(l => /Resource not found/i.test(l)).length,
	answerTail: (await text()).slice(-200),
};
appendFileSync(join(DATA, 'livecheck.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
c.close();
