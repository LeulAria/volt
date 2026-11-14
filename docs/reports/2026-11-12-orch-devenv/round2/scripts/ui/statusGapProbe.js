// In the workbench over CDP: a status line switching from a long phrase to a short one, as
// renderStatusLine paints it, then the timer after it. Reports the gap between the shown phrase and
// the timer once the 420 ms swap is over (no redraw in between, as while the model thinks quietly).
(async () => {
	const host = document.querySelector('.volt-agent-editor:not(.browser-hosted) .volt-agent-thread-inner');
	const tail = document.createElement('div');
	tail.className = 'volt-tr-tail';
	const swap = document.createElement('div');
	swap.className = 'volt-agent-status-swap is-switching';
	for (const [text, role] of [['Planning next moves', 'out'], ['Thinking', 'in']]) {
		const motion = document.createElement('span');
		motion.className = `volt-agent-status-motion phrase-${role}`;
		if (role === 'out') {
			// What agentEditor.ts renderStatusLine does with the outgoing phrase (after the fix).
			if (window.__voltProbeRemoveOut) {
				motion.addEventListener('animationend', e => { if (e.target === motion) { motion.remove(); } }, { once: true });
			}
		}
		const status = document.createElement('span');
		status.className = 'volt-agent-activity-progress shimmer';
		status.textContent = text;
		motion.appendChild(status);
		swap.appendChild(motion);
	}
	const elapsed = document.createElement('span');
	elapsed.className = 'volt-tr-elapsed';
	elapsed.textContent = '5s';
	tail.append(swap, elapsed);
	host.appendChild(tail);
	await new Promise(r => setTimeout(r, 700));
	const shown = swap.querySelector('.phrase-in .volt-agent-activity-progress').getBoundingClientRect();
	const gap = Math.round(elapsed.getBoundingClientRect().left - shown.right);
	if (!window.__voltProbeKeep) {
		tail.remove();
	} else {
		tail.id = 'v2ui-gap';
	}
	return { gapPx: gap, rect: tail.getBoundingClientRect().toJSON() };
})();
