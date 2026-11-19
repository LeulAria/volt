// The floor: an empty window of Volt's own Electron (no Volt code). One 1600 x 1000 window with a static page.
// FLOOR_PAGE=blank (default: one line of text) | text (a screen of static text, as a transcript at rest).
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
	const w = new BrowserWindow({ x: 40, y: 40, width: 1600, height: 1000, webPreferences: { sandbox: true, contextIsolation: true } });
	const body = process.env.FLOOR_PAGE === 'text'
		? Array.from({ length: 60 }, (_, i) => `<p>Line ${i}: the quick brown fox jumps over the lazy dog, static text at rest.</p>`).join('')
		: '<p>empty window</p>';
	w.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><meta charset=utf-8><title>floor</title><body style="font: 13px -apple-system">${body}</body>`));
});
app.on('window-all-closed', () => app.quit());
