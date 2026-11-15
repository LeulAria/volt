// Check (not a timing): in a running arm with a streaming chat on screen, that the fade spans' colour steps share one
// clock and how many frames a second change any span's colour. Prints, over 3 s: frames, frames in which a span's
// computed colour changed, and the spans' step phases ((startTime + delay) mod step, expected near 0 or near a step).
//   node fadecheck.mjs
import { cdp } from './lib.mjs';
const c = await cdp();
console.log(await c.evaluate(`new Promise(resolve => {
	const S = 1000 / 60; const colors = new Map(); let frames = 0, changed = 0, spansSeen = 0; const phases = [];
	const t0 = performance.now();
	const tick = () => {
		frames++;
		let any = false;
		for (const span of document.querySelectorAll('.volt-agent-fresh-text')) {
			const col = getComputedStyle(span).color;
			if (!colors.has(span)) {
				spansSeen++;
				const a = span.getAnimations()[0];
				if (a && a.startTime !== null) { const p = (((a.startTime + parseFloat(span.style.animationDelay)) % S) + S) % S; phases.push(Math.round(Math.min(p, S - p) * 100) / 100); }
			} else if (colors.get(span) !== col) { any = true; }
			colors.set(span, col);
		}
		if (any) { changed++; }
		if (performance.now() - t0 < 3000) { requestAnimationFrame(tick); } else { phases.sort((a, b) => a - b); resolve(JSON.stringify({ frames, framesWithColourChange: changed, spansSeen, phaseMedian: phases[phases.length >> 1], phaseMax: phases.at(-1), easing: document.querySelector('.volt-agent-fresh-text')?.style.animationTimingFunction.slice(0, 40) })); }
	};
	requestAnimationFrame(tick);
})`));
c.close();
