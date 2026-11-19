// Analysis aid (not a result): the animations running in the test window right now, grouped by name and target
// class, with the properties they animate and whether the target is on screen. Main-thread animations (anything but
// transform/opacity/filter) restyle and repaint their element every frame they change.
//   node anims.mjs            (exp.mjs runs it as the variant `census`)
import { cdp } from './lib.mjs';

export const CENSUS = `(() => {
	const groups = new Map();
	const vw = innerWidth, vh = innerHeight;
	for (const a of document.getAnimations()) {
		if (a.playState !== 'running') { continue; }
		const t = a.effect?.target;
		if (!t) { continue; }
		const r = t.getBoundingClientRect();
		const onScreen = !!t.isConnected && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && t.checkVisibility?.({ checkVisibilityCSS: true, opacityProperty: true }) !== false;
		const props = [...new Set((a.effect.getKeyframes?.() ?? []).flatMap(k => Object.keys(k).filter(p => !['offset', 'easing', 'composite', 'computedOffset'].includes(p))))].join(',');
		const timing = a.effect.getTiming?.() ?? {};
		const key = (a.animationName ?? a.transitionProperty ?? a.constructor.name) + ' ' + (t.tagName.toLowerCase() + '.' + [...t.classList].slice(0, 3).join('.')) + ' [' + props + '] ' + (timing.duration ?? '') + 'ms ' + (timing.easing ?? '');
		const g = groups.get(key) ?? { n: 0, onScreen: 0 };
		g.n++;
		if (onScreen) { g.onScreen++; }
		groups.set(key, g);
	}
	return [...groups].sort((a, b) => b[1].onScreen - a[1].onScreen || b[1].n - a[1].n).map(([k, g]) => g.onScreen + '/' + g.n + '  ' + k);
})()`;

if (import.meta.url === `file://${process.argv[1]}`) {
	const c = await cdp();
	console.log((await c.evaluate(CENSUS)).join('\n'));
	c.close();
}
