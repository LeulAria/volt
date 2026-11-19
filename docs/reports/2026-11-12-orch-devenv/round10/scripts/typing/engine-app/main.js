// A bare Electron window for engine.mjs: one page with a textarea and switchable frame loads. No Volt code.
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(() => {
	const win = new BrowserWindow({ x: 0, y: 0, width: 1600, height: 1000, show: true, backgroundColor: '#1e1e1e' });
	win.loadFile(path.join(__dirname, 'page.html'));
});
app.on('window-all-closed', () => app.quit());
