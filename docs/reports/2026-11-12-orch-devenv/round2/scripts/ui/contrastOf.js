// Contrast ratio of the first element matching window.__voltContrastSel over the window's painted background
// (the chat composites onto --volt-agent-window-bg-base; every ancestor background is layered on it).
(() => {
	const el = document.querySelector(window.__voltContrastSel);
	if (!el) { return null; }
	const probe = document.createElement('div');
	document.body.appendChild(probe);
	const rgba = c => { probe.style.color = ''; probe.style.color = c; const m = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number); return getComputedStyle(probe).color.startsWith('color(') ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
	const over = (t, u) => [0, 1, 2].map(i => t[i] * t[3] + u[i] * (1 - t[3])).concat(1);
	const wb = document.querySelector('.monaco-workbench');
	let bg = rgba(getComputedStyle(wb).getPropertyValue('--volt-agent-window-bg-base').trim() || '#141414');
	const chain = [];
	for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { chain.push(rgba(c)); } }
	for (let i = chain.length - 1; i >= 0; i--) { bg = over(chain[i], bg); }
	const fg = over(rgba(getComputedStyle(el).color), bg);
	probe.remove();
	const lum = c => 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
	function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
	const a = lum(fg), b = lum(bg);
	return Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100;
})()
