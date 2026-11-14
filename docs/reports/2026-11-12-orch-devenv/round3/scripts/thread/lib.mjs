// Small CDP client for the Volt test window (Node 22 global WebSocket, no dependencies).
import { execSync } from 'node:child_process';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function connect(port, match = /workbench/) {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	const page = targets.find(t => t.type === 'page' && match.test(t.url) && t.title) ?? targets.find(t => t.type === 'page' && match.test(t.url));
	if (!page) {
		throw new Error(`no page on ${port}`);
	}
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
	let id = 0;
	const pending = new Map();
	const listeners = new Set();
	ws.addEventListener('message', e => {
		const m = JSON.parse(e.data);
		if (m.id && pending.has(m.id)) {
			pending.get(m.id)(m);
			pending.delete(m.id);
		} else if (m.method) {
			for (const l of listeners) {
				l(m);
			}
		}
	});
	ws.addEventListener('close', e => {
		if (pending.size) {
			console.error(`cdp socket closed (${e.code} ${e.reason}) with ${pending.size} calls pending`);
			process.exit(3);
		}
	});
	// A keepalive so Node never sees an empty event loop while a call waits on a busy renderer.
	const keepalive = setInterval(() => { }, 1000);
	ws.addEventListener('close', () => clearInterval(keepalive));
	const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
	const evaluate = async (expression, awaitPromise = true) => {
		const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
		if (r.result?.exceptionDetails) {
			throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
		}
		return r.result?.result?.value;
	};
	const click = async (x, y) => {
		for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
			await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
		}
	};
	const wheel = (x, y, deltaY) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
	return { send, evaluate, click, wheel, on: l => listeners.add(l), close: () => ws.close() };
}

/** Center of the sidebar row whose text starts with `title`. */
export async function rowCenter(cdp, title) {
	for (let i = 0; i < 3; i++) {
		const at = await rowAt(cdp, title);
		if (at) {
			return at;
		}
		// The project lists its latest chats; "Show more" lists the rest.
		const more = await rowAt(cdp, 'Show more');
		if (!more) {
			return null;
		}
		await cdp.click(more.x, more.y);
		await sleep(400);
	}
	return null;
}

function rowAt(cdp, title) {
	return cdp.evaluate(`(() => {
		const row = [...document.querySelectorAll('.monaco-list-row')].find(r => r.textContent.startsWith(${JSON.stringify(title)}));
		if (!row) return null;
		const b = row.getBoundingClientRect();
		return { x: Math.round(b.x + Math.min(120, b.width / 2)), y: Math.round(b.y + b.height / 2) };
	})()`);
}

export function load() {
	return execSync('uptime').toString().trim().replace(/.*load averages?: /, '');
}

/** Waits until the 1-minute load is at or below $MAXLOAD (14): every timed sample starts below it. */
export async function waitLoad(max = Number(process.env.MAXLOAD ?? 14)) {
	for (; ;) {
		const one = Number(load().split(/\s+/)[0]);
		if (one <= max) {
			return one;
		}
		console.log(`load ${one} > ${max}, waiting`);
		await sleep(30000);
	}
}

/** The result with the load before and after its sample (null stays null). */
export function withLoad(result, before) {
	return result ? { ...result, loadBefore: before, loadAfter: load() } : null;
}

export function stats(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	return { n: sorted.length, median: Math.round(median * 10) / 10, min: Math.round(sorted[0] * 10) / 10, max: Math.round(sorted.at(-1) * 10) / 10 };
}
