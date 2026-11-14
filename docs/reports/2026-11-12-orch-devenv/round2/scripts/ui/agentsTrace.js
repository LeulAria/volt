// Installed in the workbench over CDP: every animation frame, reads what the chat says about its
// subagents in each place (transcript rows, the composer's agents chip, the "N subagents running" card,
// the dock's Subagents heading, the status chip) and records a line each time any of them changes.
// `window.__voltAgentsTrace` = [{ t (ms since install), rows, chip, card, dock, status }].
(() => {
	if (window.__voltAgentsTraceStop) {
		window.__voltAgentsTraceStop();
	}
	const t0 = performance.now();
	const out = window.__voltAgentsTrace = [];
	const editor = () => document.querySelector('.volt-agent-editor:not(.browser-hosted)');
	const shown = el => !!el && el.getClientRects().length > 0 && !el.closest('.hidden');
	const txt = el => shown(el) ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
	let last = '';
	let running = true;
	const tick = () => {
		const ed = editor();
		if (ed) {
			const rows = [...([...ed.querySelectorAll('.volt-agent-turn.agent')].at(-1)?.querySelectorAll('.volt-tr-subagent') ?? [])]
				.map(r => (r.className.match(/state-(\w+)/) || [])[1]).join(',');
			const chips = [...ed.querySelectorAll('.volt-agent-composer-chips .volt-agent-composer-chip')].filter(shown);
			const chip = chips.filter(c => !c.classList.contains('status')).map(txt).join(' | ');
			const status = chips.filter(c => c.classList.contains('status')).map(txt).join(' | ');
			const card = txt(ed.querySelector('.volt-agent-agents-card .volt-agent-work-toggle'));
			const dockHead = [...document.querySelectorAll('.volt-agent-quick-open-body .label')].map(txt).find(s => /subagent/i.test(s)) || '';
			const line = { rows, chip, card, dock: dockHead, status };
			const key = JSON.stringify(line);
			if (key !== last) {
				last = key;
				out.push({ t: Math.round(performance.now() - t0), ...line });
			}
		}
		if (running) {
			requestAnimationFrame(tick);
		}
	};
	window.__voltAgentsTraceStop = () => { running = false; };
	requestAnimationFrame(tick);
	return 'installed';
})();
