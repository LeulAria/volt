// Round 5 launch: the Electron floor. A stub app (Volt's own Electron, this file as its main) that opens one window at
// `ready`, so the rig can time how soon any Electron app of this build can show a window on this Mac.
// FLOOR_MODE: browser (BrowserWindow, plain options), volt (BrowserWindow with the launch window's options), base
// (BaseWindow: no web contents of its own). Appends one JSON line per launch to $FLOOR_LOG.
import { app, BaseWindow, BrowserWindow } from 'electron';
import { appendFileSync } from 'node:fs';
const mode = process.env.FLOOR_MODE || 'browser';
const t = { mode, first: Date.now(), origin: Math.round(performance.timeOrigin) };
app.setPath('userData', process.env.HOME + '/.volt-r5/launch/ud/floor');
app.once('ready', () => {
	t.ready = Date.now();
	const plain = { width: 1600, height: 1000, backgroundColor: '#181818', titleBarStyle: 'hidden', show: true };
	const volt = { ...plain, minWidth: 400, minHeight: 270, title: 'VOLT', experimentalDarkMode: true, acceptFirstMouse: true, titleBarOverlay: true, webPreferences: { sandbox: true } };
	globalThis.__w = mode === 'base' ? new BaseWindow(plain) : new BrowserWindow(mode === 'volt' ? volt : plain);
	t.window = Date.now();
	appendFileSync(process.env.FLOOR_LOG, JSON.stringify(t) + '\n');
	setTimeout(() => app.exit(0), 1500);
});
