// Installed in the workbench over CDP: every animation frame, finds the visible elements in the chat
// whose own text is one of LABELS, and records every frame where two of them overlap, with their
// classes, rects, opacity and the chain of row classes up to the thread. `window.__voltLabelHits`.
(() => {
	const LABELS = /^(ToolSearch|Thinking|Thought|Planning next moves|Waiting|Worked for)/;
	if (window.__voltLabelStop) {
		window.__voltLabelStop();
	}
	window.__voltLabelHits = [];
	window.__voltLabelSeen = new Set();
	let running = true;
	const ownText = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
	const chain = el => {
		const out = [];
		for (let e = el; e && !e.classList?.contains('volt-agent-editor'); e = e.parentElement) {
			if (e.classList?.length) {
				out.push([...e.classList].slice(0, 2).join('.'));
			}
		}
		return out.slice(0, 6).join(' < ');
	};
	const visible = el => {
		for (let e = el; e; e = e.parentElement) {
			const s = getComputedStyle(e);
			if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) {
				return false;
			}
		}
		return true;
	};
	const tick = () => {
		const editor = document.querySelector('.volt-agent-editor:not(.browser-hosted)');
		if (editor) {
			const found = [];
			for (const el of editor.querySelectorAll('span, div')) {
				const text = ownText(el);
				if (text && LABELS.test(text)) {
					const r = el.getBoundingClientRect();
					if (r.width && r.height && visible(el)) {
						found.push({ el, text, r });
						window.__voltLabelSeen.add(`${text.slice(0, 24)} :: ${chain(el)}`);
					}
				}
			}
			for (let i = 0; i < found.length; i++) {
				for (let j = i + 1; j < found.length; j++) {
					const a = found[i].r;
					const b = found[j].r;
					if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) {
						if (window.__voltLabelHits.length < 200) {
							window.__voltLabelHits.push({ t: Math.round(performance.now()), a: found[i].text, b: found[j].text, ac: chain(found[i].el), bc: chain(found[j].el), ar: [a.x, a.y, a.width, a.height].map(Math.round), br: [b.x, b.y, b.width, b.height].map(Math.round) });
						}
					}
				}
			}
		}
		if (running) {
			requestAnimationFrame(tick);
		}
	};
	window.__voltLabelStop = () => { running = false; };
	requestAnimationFrame(tick);
	return 'installed';
})();
