// The floor: an empty window of Volt's own Electron (no Volt code). One 1600 x 1000 window with a static page.
// FLOOR_PAGE=blank (default: one line of text) | text (a screen of static text, as a transcript at rest).
// FLOOR_SWITCHES=a,b appends Chromium switches (e.g. ui-disable-partial-swap, which Volt sets on macOS).
// FLOOR_WINDOW=volt makes the window transparent with vibrancy and a hidden title bar, as Volt's agent window.
const { app, BrowserWindow } = require('electron');
for (const s of (process.env.FLOOR_SWITCHES ?? '').split(',').filter(Boolean)) { app.commandLine.appendSwitch(s); }
const volt = process.env.FLOOR_WINDOW === 'volt';
app.whenReady().then(() => {
	const w = new BrowserWindow({ x: 40, y: 40, width: 1600, height: 1000, ...(volt ? { transparent: true, vibrancy: 'sidebar', visualEffectState: 'active', titleBarStyle: 'hidden', backgroundColor: '#00000000' } : {}), webPreferences: { sandbox: true, contextIsolation: true } });
	const body = process.env.FLOOR_PAGE === 'text'
		? Array.from({ length: 60 }, (_, i) => `<p>Line ${i}: the quick brown fox jumps over the lazy dog, static text at rest.</p>`).join('')
		: '<p>empty window</p>';
	w.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><meta charset=utf-8><title>floor</title><body style="font: 13px -apple-system${volt ? '; background: transparent' : ''}">${body}</body>`));
});
app.on('window-all-closed', () => app.quit());
