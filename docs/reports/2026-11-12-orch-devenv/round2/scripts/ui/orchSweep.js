// Installed in the workbench over CDP (cdp.mjs evalf): every animation frame, checks the orchestration UI
// (subagent rows and groups, the agents/queue card, the Tasks card, waiting and notification rows, the
// composer status chip, the lineage dock) for pixel defects and records each one the first time it is seen:
//  - clip: a text box whose content is wider/taller than its box (and whether it ellipsizes or is cut);
//  - overlap: two visible sibling boxes that overlap by more than 1 px;
//  - contrast: text whose colour over its painted background is under 4.5:1 (3:1 for 18px+ / 600+);
//  - align: an icon and the text beside it whose vertical centres differ by more than 1.5 px;
//  - jump: a row that moved vertically by more than 2 px between frames with no scroll.
// Read back with `window.__voltSweep` (array) and stop with `window.__voltSweepStop()`.
(() => {
	if (window.__voltSweepStop) {
		window.__voltSweepStop();
	}
	const ROOTS = [
		'.volt-subagent-group', '.volt-subagent-row', '.volt-agent-agents-card', '.volt-agent-work-section',
		'.volt-agent-tasks-card', '.volt-agent-tasks-panel', '.volt-agent-job-wait', '.volt-agent-notification-row',
		'.volt-tr-subagents', '.volt-agent-composer-chips', '.volt-agent-lineage', '.volt-agent-subagent-of',
		'.volt-agent-thread-inner > .volt-agent-turn.agent:last-child .volt-tr-group', '.volt-watched-task-card',
		'.volt-agent-quick-open-body',
	];
	const seen = new Set();
	const out = window.__voltSweep = [];
	const record = (kind, key, data) => {
		const k = kind + '|' + key;
		if (!seen.has(k)) {
			seen.add(k);
			out.push({ kind, t: Math.round(performance.now()), ...data });
		}
	};
	const label = el => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join('.')}`;
	const text = el => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
	const visible = el => {
		for (let e = el; e && e !== document.body; e = e.parentElement) {
			const s = getComputedStyle(e);
			if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) {
				return false;
			}
		}
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
	};
	const parse = c => {
		let m = c.match(/rgba?\(([^)]+)\)/);
		if (m) {
			const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
			return [p[0], p[1], p[2], p[3] ?? 1];
		}
		m = c.match(/color\(srgb ([^)]+)\)/);
		if (m) {
			const p = m[1].split(/[ /]+/).filter(Boolean).map(Number);
			return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
		}
		return null;
	};
	const over = (top, under) => {
		const a = top[3];
		return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
	};
	const base = () => {
		const wb = document.querySelector('.monaco-workbench');
		const v = getComputedStyle(wb).getPropertyValue('--volt-agent-window-bg-base').trim();
		const d = document.createElement('div');
		d.style.color = v || (wb.classList.contains('vs') ? '#f8f8f8' : '#141414');
		document.body.appendChild(d);
		const c = parse(getComputedStyle(d).color);
		d.remove();
		return c;
	};
	const bgOf = el => {
		const chain = [];
		for (let e = el; e; e = e.parentElement) {
			const c = parse(getComputedStyle(e).backgroundColor);
			if (c && c[3] > 0) {
				chain.push(c);
			}
		}
		let bg = base();
		for (let i = chain.length - 1; i >= 0; i--) {
			bg = over(chain[i], bg);
		}
		return bg;
	};
	const lum = c => {
		const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
		return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
	};
	const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
	const ownText = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
	const lastTops = new Map();
	let lastScroll = new Map();
	let running = true;
	const check = () => {
		const roots = new Set();
		for (const sel of ROOTS) {
			document.querySelectorAll(sel).forEach(e => { if (!e.closest('.browser-hosted') && visible(e)) { roots.add(e); } });
		}
		const scrolls = new Map([...document.querySelectorAll('.volt-agent-thread, .monaco-scrollable-element')].map(s => [s, s.scrollTop]));
		const scrolled = [...scrolls].some(([s, v]) => lastScroll.has(s) && lastScroll.get(s) !== v);
		lastScroll = scrolls;
		for (const root of roots) {
			for (const el of [root, ...root.querySelectorAll('*')]) {
				if (el instanceof SVGElement || !visible(el)) {
					continue;
				}
				const s = getComputedStyle(el);
				const r = el.getBoundingClientRect();
				if (ownText(el)) {
					if (el.scrollWidth > el.clientWidth + 1 && s.overflowX !== 'visible') {
						record('clip', label(el) + text(el), { el: label(el), text: text(el), box: el.clientWidth, content: el.scrollWidth, ellipsis: s.textOverflow === 'ellipsis' });
					}
					if (el.scrollHeight > el.clientHeight + 2 && s.overflowY !== 'visible' && s.display !== 'inline') {
						record('vclip', label(el) + text(el), { el: label(el), text: text(el), box: el.clientHeight, content: el.scrollHeight });
					}
					const fg = parse(s.color);
					if (fg) {
						const bg = bgOf(el);
						const opacity = (() => { let o = 1; for (let e = el; e; e = e.parentElement) { o *= Number(getComputedStyle(e).opacity); } return o; })();
						const eff = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
						const cr = ratio(eff, bg);
						const big = parseFloat(s.fontSize) >= 18 || (parseFloat(s.fontSize) >= 14 && Number(s.fontWeight) >= 700);
						if (cr < (big ? 3 : 4.5)) {
							record('contrast', label(el) + text(el), { el: label(el), text: text(el), ratio: Math.round(cr * 100) / 100, fg: s.color, opacity: Math.round(opacity * 100) / 100, bg: bg.map(Math.round).join(',') });
						}
					}
				}
				// Siblings that overlap.
				const kids = [...el.children].filter(k => !(k instanceof SVGElement) && visible(k) && getComputedStyle(k).position !== 'absolute' && getComputedStyle(k).display !== 'inline');
				for (let i = 0; i < kids.length; i++) {
					const a = kids[i].getBoundingClientRect();
					for (let j = i + 1; j < kids.length; j++) {
						const b = kids[j].getBoundingClientRect();
						const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
						const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
						if (w > 1 && h > 1) {
							record('overlap', label(kids[i]) + label(kids[j]) + text(el), { a: label(kids[i]) + ' "' + text(kids[i]) + '"', b: label(kids[j]) + ' "' + text(kids[j]) + '"', w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10 });
						}
					}
				}
				// An icon next to text in a flex row.
				if (s.display.includes('flex') && s.flexDirection.startsWith('row') && s.alignItems === 'center') {
					const icon = [...el.children].find(k => k.classList.contains('codicon') || k.querySelector?.(':scope > .codicon'));
					const txt = [...el.children].find(k => k !== icon && ownText(k));
					if (icon && txt && visible(icon) && visible(txt)) {
						const ir = icon.getBoundingClientRect(), tr = txt.getBoundingClientRect();
						const d = (ir.top + ir.height / 2) - (tr.top + tr.height / 2);
						if (Math.abs(d) > 1.5) {
							record('align', label(el) + text(el), { el: label(el), text: text(el), delta: Math.round(d * 10) / 10 });
						}
					}
				}
				if (el === root && /row|group-head/.test(el.className) && !scrolled) {
					const prev = lastTops.get(el);
					if (prev !== undefined && Math.abs(prev - r.top) > 2) {
						record('jump', label(el) + text(el) + Math.round(r.top), { el: label(el), text: text(el), from: Math.round(prev), to: Math.round(r.top) });
					}
					lastTops.set(el, r.top);
				}
			}
		}
		if (running) {
			requestAnimationFrame(check);
		}
	};
	window.__voltSweepStop = () => { running = false; };
	requestAnimationFrame(check);
	return 'installed';
})();
