// Idle and one-running-agent memory/CPU of T3 Code (Nightly), Cursor and Volt 0.0.6, each as a
// SEPARATE instance with its own profile (never the user's running apps or data), interleaved.
//   node memrig.mjs <rounds=2>
// - Volt: a `ditto` copy of /Applications/Volt.app in /tmp/vcmp/Volt006.app (release 0.0.6, not this
//   branch), --user-data-dir /tmp/vcmp/m-volt-ud; its launchd agent server is outside the app's
//   process tree and is matched by the profile path.
// - T3 Code: the installed app with HOME=/tmp/vcmp/m-t3-home (T3 derives both its Electron profile and
//   ~/.t3 from the home folder); ~/.claude is linked in so its Claude Code is logged in.
// - Cursor: the installed app with --user-data-dir/--extensions-dir in /tmp. Idle only: a fresh
//   profile is logged out, and copying the user's Cursor login is off limits.
// "Running": a no-tool prompt that streams for ~20-30 s ("write a 1200-word story"), Haiku 5.5.
import { execFileSync, execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CMP_DATA ?? join(here, '../../data/cmp');
const rounds = Number(process.argv[2] ?? 2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STORY = 'Write a 1200-word short story about a lighthouse keeper. Do not use any tools.';
const env0 = { ...process.env };
for (const k of Object.keys(env0)) { if (/^CLAUDE|^ELECTRON_RUN_AS_NODE$/.test(k)) { delete env0[k]; } }

function mem(label, pid, extra) {
	const args = [join(here, 'mem.mjs'), label, String(pid), '--window', '8', '--samples', '3', ...(extra ? ['--extra', extra] : [])];
	const line = execFileSync('node', args, { encoding: 'utf8' }).trim();
	appendFileSync(join(DATA, 'memory.jsonl'), line + '\n');
	console.log(line.slice(0, 300));
	return JSON.parse(line);
}

async function cdpEval(port, expression, opts = {}) {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	const page = targets.find(t => t.type === 'page' && (opts.match ? opts.match.test(t.url) : true) && t.title) ?? targets.find(t => t.type === 'page');
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise(r => ws.addEventListener('open', r, { once: true }));
	let id = 0; const P = new Map();
	ws.addEventListener('message', e => { const m = JSON.parse(e.data); P.get(m.id)?.(m); });
	const send = (method, params = {}) => new Promise(r => { const i = ++id; P.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
	const value = expression ? (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value : undefined;
	return { value, send, close: () => ws.close() };
}

async function waitPort(port, ms = 90_000) {
	const t = Date.now();
	while (Date.now() - t < ms) {
		try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok && (await r.json()).some(x => x.type === 'page' && x.title)) { return true; } } catch { }
		await sleep(1000);
	}
	return false;
}

function killTree(pid) {
	try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { } }
}

async function volt(round) {
	const app = '/tmp/vcmp/Volt006.app';
	if (!existsSync(app)) { execSync(`ditto /Applications/Volt.app ${app}`); }
	const ud = '/tmp/vcmp/m-volt-ud';
	mkdirSync(join(ud, 'User'), { recursive: true });
	writeFileSync(join(ud, 'User', 'settings.json'), JSON.stringify({ 'volt.agent.defaultModel': 'agent:seed-claude-code:claude-haiku-5-5', 'window.dialogStyle': 'custom', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'security.workspace.trust.enabled': false }));
	// The release bundle's executable keeps Electron's name.
	const p = spawn(`${app}/Contents/MacOS/Electron`,['--user-data-dir', ud, '--remote-debugging-port=9942', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--folder-uri', 'file:///tmp/vcmp/w/t0'], { env: env0, detached: true, stdio: 'ignore' });
	await waitPort(9942);
	await sleep(45_000);
	const idle = mem(`volt-0.0.6 idle r${round}`, p.pid, ud.replace(/\//g, '\\/'));
	// One running agent: type the story prompt into the composer.
	const c = await cdpEval(9942, `(() => { const e = [...document.querySelectorAll('[aria-label]')].find(e => e.offsetParent && /^New (Chat|Agent)/.test(e.getAttribute('aria-label'))); e?.click(); return !!e; })()`, { match: /workbench/ });
	await sleep(2000);
	await c.send('Runtime.evaluate', { expression: `(() => { const t = [...document.querySelectorAll('textarea.inputarea')].filter(e => e.offsetParent).at(-1); t?.focus(); return !!t; })()` });
	await c.send('Input.insertText', { text: STORY });
	await sleep(300);
	for (const type of ['keyDown', 'keyUp']) { await c.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }); }
	await sleep(5000);
	const running = mem(`volt-0.0.6 running r${round}`, p.pid, ud.replace(/\//g, '\\/'));
	const shot = await c.send('Page.captureScreenshot', { format: 'png' });
	writeFileSync(join(DATA, 'raw', `mem-volt-r${round}.png`), Buffer.from(shot.result.data, 'base64'));
	await sleep(25_000);
	// Quit: Cmd+Q (saves state), then the agent server of this profile.
	await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, modifiers: 4 });
	c.close();
	await sleep(5000);
	killTree(p.pid);
	stopProfileProcesses(ud);
	return { idle, running };
}

function stopProfileProcesses(match) {
	const rows = execSync('ps -axo pid=,command=').toString().split('\n').filter(l => l.includes(match) && !l.includes('memrig.mjs') && !l.includes('mem.mjs'));
	for (const l of rows) { const pid = Number(l.trim().split(/\s+/)[0]); try { process.kill(pid, 'SIGTERM'); } catch { } }
	// A launchd agent server registered for this profile: boot it out and remove its plist.
	const plists = execSync(`grep -l '${match}' ~/Library/LaunchAgents/com.volt.agent-server.*.plist 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean);
	for (const plist of plists) {
		const label = plist.replace(/^.*\//, '').replace(/\.plist$/, '');
		try { execSync(`launchctl bootout gui/$(id -u)/${label}`); } catch { }
		execSync(`rm -f '${plist}'`);
		console.log('removed launchd agent server', label);
	}
}

async function t3(round) {
	const home = '/tmp/vcmp/m-t3-home';
	mkdirSync(home, { recursive: true });
	for (const f of ['.claude', '.claude.json', '.local', '.npm', '.config']) {
		if (!existsSync(join(home, f)) && existsSync(join(process.env.HOME, f))) { symlinkSync(join(process.env.HOME, f), join(home, f)); }
	}
	const appBin = '/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)';
	const p = spawn(appBin, ['--remote-debugging-port=9943'], { env: { ...env0, HOME: home, T3CODE_TELEMETRY_ENABLED: 'false', T3CODE_DISABLE_AUTO_UPDATE: '1' }, detached: true, stdio: 'ignore' });
	await waitPort(9943);
	await sleep(45_000);
	const idle = mem(`t3-nightly idle r${round}`, p.pid, home.replace(/\//g, '\\/'));
	// One running agent through its own server: token for that base dir, then launch a thread.
	let running;
	try {
		const runtime = JSON.parse(readFileSync(join(home, '.t3', 'userdata', 'server-runtime.json'), 'utf8'));
		const bin = '/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs';
		const token = execFileSync(appBin, [bin, 'auth', 'session', 'issue', '--base-dir', join(home, '.t3'), '--token-only'], { env: { ...env0, HOME: home, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }).trim();
		writeFileSync('/tmp/vcmp/m-t3-token.txt', token);
		spawn('node', [join(here, 't3send.mjs'), String(runtime.port), '/tmp/vcmp/m-t3-token.txt', '/tmp/vcmp/w/t0', STORY], { stdio: 'ignore', detached: true }).unref();
		await sleep(8000);
		running = mem(`t3-nightly running r${round}`, p.pid, home.replace(/\//g, '\\/'));
	} catch (err) {
		console.log('t3 running measure failed', String(err).slice(0, 300));
	}
	await sleep(20_000);
	killTree(p.pid);
	await sleep(3000);
	stopProfileProcesses(home);
	return { idle, running };
}

async function cursor(round) {
	const ud = '/tmp/vcmp/m-cursor-ud';
	mkdirSync(ud, { recursive: true });
	const p = spawn('/Applications/Cursor.app/Contents/MacOS/Cursor', ['--user-data-dir', ud, '--extensions-dir', `${ud}/ext`, '--remote-debugging-port=9944', '/tmp/vcmp/w/t0'], { env: env0, detached: true, stdio: 'ignore' });
	await waitPort(9944);
	await sleep(45_000);
	const idle = mem(`cursor idle r${round}`, p.pid, ud.replace(/\//g, '\\/'));
	killTree(p.pid);
	await sleep(3000);
	stopProfileProcesses(ud);
	return { idle };
}

mkdirSync(join(DATA, 'raw'), { recursive: true });
const order = [volt, t3, cursor];
for (let r = 1; r <= rounds; r++) {
	const seq = r % 2 ? order : [...order].reverse();
	for (const f of seq) {
		try { await f(r); } catch (err) { console.log(f.name, 'failed', String(err).slice(0, 400)); }
		await sleep(5000);
	}
}
console.log('memrig done');
