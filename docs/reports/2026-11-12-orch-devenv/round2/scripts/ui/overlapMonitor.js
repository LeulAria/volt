// Installed in the workbench over CDP (cdp.mjs evalf): every animation frame, finds siblings in the
// chat transcript whose boxes overlap (blocks and absolutely placed layers; not inline runs or SVG) and records the first time
// each pair is seen, with both texts and rects. Read back with `window.__voltOverlaps`.
(() => {
	if (window.__voltOverlapStop) {
		window.__voltOverlapStop();
	}
	const seen = new Map();
	window.__voltOverlaps = [];
	let frames = 0;
	let running = true;
	const label = el => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent || '').trim().slice(0, 40)}"`;
	const check = () => {
		frames++;
		const roots = document.querySelectorAll('.volt-agent-editor:not(.browser-hosted) .volt-agent-thread-inner');
		for (const root of roots) {
			const walk = (parent, depth) => {
				if (depth > 7) {
					return;
				}
				const kids = [...parent.children].filter(el => {
					if (el instanceof SVGElement) {
						return false;
					}
					const style = getComputedStyle(el);
					// Inline runs of one paragraph wrap into each other's boxes: only boxes count.
					return style.display !== 'inline' && style.display !== 'none' && style.display !== 'contents' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
				});
				const boxes = kids.map(el => ({ el, r: el.getBoundingClientRect() })).filter(b => b.r.height > 0 && b.r.width > 0);
				for (let i = 0; i < boxes.length; i++) {
					for (let j = i + 1; j < boxes.length; j++) {
						const a = boxes[i].r;
						const b = boxes[j].r;
						const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
						const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
						if (overlapX > 2 && overlapY > 2) {
							const key = `${label(boxes[i].el)}|${label(boxes[j].el)}`;
							if (!seen.has(key)) {
								seen.set(key, true);
								window.__voltOverlaps.push({ frame: frames, t: Math.round(performance.now()), a: label(boxes[i].el), b: label(boxes[j].el), ar: [a.x, a.y, a.width, a.height].map(Math.round), br: [b.x, b.y, b.width, b.height].map(Math.round), overlapY: Math.round(overlapY) });
							}
						}
					}
				}
				for (const kid of kids) {
					walk(kid, depth + 1);
				}
			};
			walk(root, 0);
		}
		if (running) {
			requestAnimationFrame(check);
		}
	};
	window.__voltOverlapStop = () => { running = false; };
	requestAnimationFrame(check);
	return 'installed';
})();
