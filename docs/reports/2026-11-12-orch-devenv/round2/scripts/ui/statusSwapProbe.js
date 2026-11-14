// In the workbench over CDP: builds a live status line switching "ToolSearch" -> "Thinking" with the
// real stylesheet (inside the chat's .volt-tr-tail), pauses its animation at every 20 ms of the
// 420 ms swap and measures how much the outgoing and incoming phrases overlap (px) and how visible
// both are then. Returns the worst overlap and the frames where both are visible and overlapping.
(() => {
	const host = document.querySelector('.volt-agent-editor:not(.browser-hosted) .volt-agent-thread-body') ?? document.querySelector('.volt-agent-editor-main');
	const tail = document.createElement('div');
	tail.className = 'volt-tr-tail';
	tail.style.cssText = 'position: fixed; left: 10px; top: 10px; z-index: -1;';
	const swap = document.createElement('div');
	swap.className = 'volt-agent-status-swap is-switching';
	const phrase = (text, role) => {
		const motion = document.createElement('span');
		motion.className = `volt-agent-status-motion phrase-${role}`;
		const status = document.createElement('span');
		status.className = 'volt-agent-activity-progress shimmer';
		status.textContent = text;
		motion.appendChild(status);
		swap.appendChild(motion);
		return motion;
	};
	const out = phrase('ToolSearch', 'out');
	const into = phrase('Thinking', 'in');
	tail.appendChild(swap);
	host.appendChild(tail);
	const frames = [];
	for (let t = 0; t <= 420; t += 20) {
		for (const el of [out, into]) {
			el.style.animationPlayState = 'paused';
			el.style.animationDelay = `${-t}ms`;
		}
		const a = out.getBoundingClientRect();
		const b = into.getBoundingClientRect();
		const overlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
		frames.push({ t, overlap: Math.round(overlap * 10) / 10, outOpacity: Number(getComputedStyle(out).opacity).toFixed(2), inOpacity: Number(getComputedStyle(into).opacity).toFixed(2) });
	}
	tail.remove();
	const bothVisible = frames.filter(f => f.overlap > 0.5 && f.outOpacity > 0.1 && f.inOpacity > 0.1);
	return { lineHeight: getComputedStyle(swap).height, worstOverlapPx: Math.max(...frames.map(f => f.overlap)), framesWithBothVisibleAndOverlapping: bothVisible.length, of: frames.length, sample: bothVisible.slice(0, 6) };
})();
