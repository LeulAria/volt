// Untimed setup for a Volt test window over CDP (never the user's window): new thread, send a prompt, wait for the
// turn to end, pick a composer chip option. The timed tests in run.ts use real keystrokes from ademark-native instead.
//   node volt-drive.mjs <port> seed <n>            n new threads, each sends `replay:seed` and waits for its answer
//   node volt-drive.mjs <port> send '<text>'       new thread, send, wait for the turn to end
//   node volt-drive.mjs <port> project-send <name> '<text>'   new thread in the recent project <name>, send, wait
//   node volt-drive.mjs <port> chip '<label>' '<option>'   open the composer chip showing <label>, click <option>
//   node volt-drive.mjs <port> threads             list the sidebar rows
const [port, cmd, ...args] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(t => t.type === 'page' && /workbench/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const key = async (k, code, vk, modifiers = 0) => {
	await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
	await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
const focusComposer = () => evaluate(`(()=>{const t=document.querySelector('.volt-agent-composer .monaco-editor textarea'); t?.focus(); return !!t})()`);
const newThread = async () => { await key('n', 'KeyN', 78, 4); await sleep(1500); await focusComposer(); };
const replies = () => evaluate(`document.querySelectorAll('.volt-agent-editor .volt-agent-reply').length`);
// A chat that runs shows "Working" in its sidebar row, or (sidebar closed) in the pill above the composer.
const busy = () => evaluate(`[...document.querySelectorAll('.monaco-list-row')].some(r=>/\\bWorking\\b/.test(r.innerText)) || [...document.querySelectorAll('.volt-agent-editor *')].some(e=>e.children.length===0&&/^Working\\b/.test(e.textContent.trim()))`);

async function sendAndWait(text, timeoutMs = 120_000) {
	await focusComposer();
	await send('Input.insertText', { text });
	await sleep(300);
	await key('Enter', 'Enter', 13);
	const end = Date.now() + timeoutMs;
	await sleep(1500);
	while (Date.now() < end) {
		if (!(await busy()) && (await replies()) > 0) { return true; }
		await sleep(500);
	}
	return false;
}

if (cmd === 'seed') {
	for (let i = 0; i < Number(args[0] ?? 5); i++) {
		await newThread();
		console.log(`seed ${i + 1}:`, await sendAndWait('replay:seed'));
		await sleep(1000);
	}
} else if (cmd === 'send') {
	await newThread();
	console.log(await sendAndWait(args[0], Number(args[1] ?? 600_000)));
} else if (cmd === 'project-send') {
	// Volt 0.0.6's new chat starts with no project (a scratch folder); ADEMark's B prompts run in the arena, so the
	// landing's recent-project row <name> is picked first.
	await newThread();
	const picked = await evaluate(`(()=>{const el=[...document.querySelectorAll('.volt-agent-landing-recent')].find(e=>e.innerText.includes(${JSON.stringify(args[0])})); if(el){ el.click(); return true } return [...document.querySelectorAll('.volt-agent-primary-header-project')].some(e=>e.textContent.trim()===${JSON.stringify(args[0])})})()`); // once picked, the next new chat keeps it
	await sleep(1000);
	console.log({ picked }, picked && await sendAndWait(args[1], Number(args[2] ?? 600_000)));
} else if (cmd === 'chip') {
	const opened = await evaluate(`(()=>{const el=[...document.querySelectorAll('.volt-agent-composer *')].find(e=>e.children.length===0&&e.textContent.trim()===${JSON.stringify(args[0])}); if(!el) return false; (el.closest('.monaco-button,.volt-button,[role=button]')||el).click(); return true})()`);
	await sleep(700);
	const picked = await evaluate(`(()=>{const el=[...document.querySelectorAll('.monaco-list-row,[role=option],[role=menuitem],[role=menuitemradio],.action-label')].find(e=>e.innerText.trim().split('\\n')[0]===${JSON.stringify(args[1])}); if(!el) return [...document.querySelectorAll('.monaco-list-row,[role=option],[role=menuitem],[role=menuitemradio]')].map(e=>e.innerText.trim()).slice(0,30); el.click(); return true})()`);
	console.log({ opened, picked });
} else if (cmd === 'threads') {
	console.log(await evaluate(`[...document.querySelectorAll('.monaco-list-row')].map(e=>e.innerText.replace(/\\n/g,' / ')).slice(0,40)`));
}
ws.close();
