// Exploratory: for each element matching `selector` and its ancestors, the computed styles that make the compositor
// give a layer its own render surface (mask, opacity, filter, blend, isolation, clip-path, transform, will-change),
// with the element's size.
//   node styleprobe.mjs '.volt-agent-thread-scroll' ['.volt-grid-auxiliarybar' ...]
import { cdp } from './lib.mjs';

const selectors = process.argv.slice(2);
const c = await cdp();
const script = `(() => {
	const props = ['maskImage', 'webkitMaskImage', 'opacity', 'filter', 'backdropFilter', 'isolation', 'mixBlendMode', 'willChange', 'transform', 'clipPath', 'contain', 'overflow', 'position', 'borderRadius'];
	const defaults = { maskImage: 'none', webkitMaskImage: 'none', opacity: '1', filter: 'none', backdropFilter: 'none', isolation: 'auto', mixBlendMode: 'normal', willChange: 'auto', transform: 'none', clipPath: 'none', contain: 'none', overflow: 'visible', position: 'static', borderRadius: '0px' };
	const out = [];
	for (const selector of ${JSON.stringify(selectors)}) {
		for (const start of document.querySelectorAll(selector)) {
			if (!start.offsetParent && start.tagName !== 'BODY') { continue; }
			out.push('== ' + selector);
			let e = start;
			while (e && e !== document.body) {
				const s = getComputedStyle(e);
				const r = e.getBoundingClientRect();
				const odd = props.filter(p => s[p] !== defaults[p]).map(p => p + '=' + String(s[p]).slice(0, 60));
				out.push('   ' + e.tagName.toLowerCase() + '.' + String(e.className).split(' ').slice(0, 3).join('.') + ' [' + Math.round(r.width) + 'x' + Math.round(r.height) + '] ' + odd.join(' '));
				e = e.parentElement;
			}
		}
	}
	return out.join('\\n');
})()`;
console.log(await c.evaluate(script));
c.close();
