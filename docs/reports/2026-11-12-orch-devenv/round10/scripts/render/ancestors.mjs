// Paint-relevant computed style of each ancestor of the newest streamed text, up to the thread scroller.
import { cdp } from './lib.mjs';
const c = await cdp();
const r = await Promise.race([c.evaluate(`(() => {
	const f = [...document.querySelectorAll('.volt-agent-fresh-text')].filter(e => e.offsetParent).at(-1) || [...document.querySelectorAll('.volt-agent-thread-inner p')].filter(e => e.offsetParent).at(-1);
	const out = [];
	for (let e = f; e && !e.classList.contains('volt-agent-thread-scroll'); e = e.parentElement) {
		const s = getComputedStyle(e); const r = e.getBoundingClientRect();
		const keep = {};
		for (const p of ['backgroundColor', 'backgroundImage', 'borderTopWidth', 'borderLeftWidth', 'borderRadius', 'boxShadow', 'maskImage', 'outlineStyle', 'filter', 'contain', 'willChange', 'overflow', 'display', 'position', 'transform', 'opacity', 'contentVisibility', 'isolation']) {
			const v = s[p]; if (v && !['none', 'normal', 'visible', 'rgba(0, 0, 0, 0)', '0px', 'static', 'auto', '1', 'block'].includes(v)) keep[p] = v.slice(0, 60);
		}
		out.push(e.tagName.toLowerCase() + '.' + String(e.className).split(' ').slice(0, 4).join('.') + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + JSON.stringify(keep));
	}
	return out.join('\\n');
})()`), new Promise(r => setTimeout(() => r('timeout'), 8000))]);
console.log(r); c.close(); process.exit(0);
