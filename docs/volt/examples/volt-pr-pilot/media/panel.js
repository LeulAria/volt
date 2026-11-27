// PR Pilot's webview: one script for its three views (panel, checks, notes). The extension owns
// the state and posts it; buttons post actions back.
//
// It is drawn with the Volt kit, the classes Volt puts into every plugin webview (volt-section,
// volt-row, volt-button, volt-icon-button, ...: docs/volt/plugin-ui.md §5), so it looks like the
// rest of Volt and follows the theme. No boxes inside boxes: the placement is the card.

(function () {
	const vscode = acquireVsCodeApi();
	const kind = document.body.dataset.kind;
	const root = document.getElementById('root');
	let state;
	let notesTimer;

	// Lucide icons (Aria Icons' lucide set): 1px outlines in the text colour, like Volt's own
	// (stroke-width 1.5 on the 24-unit grid, drawn at 16px).
	const ICONS = {
		refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
		external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
		link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
		panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
		model: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
	};

	const el = (tag, className, text) => {
		const node = document.createElement(tag);
		if (className) { node.className = className; }
		if (text !== undefined) { node.textContent = text; }
		return node;
	};
	const icon = name => {
		const span = el('span', 'volt-icon');
		span.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
		return span;
	};
	const post = (type, extra) => vscode.postMessage({ type, ...extra });
	const button = (label, type, look) => {
		const node = el('button', `volt-button ${look || ''}`.trim(), label);
		node.type = 'button';
		node.addEventListener('click', () => post(type));
		return node;
	};
	const iconButton = (name, title, type, extra) => {
		const node = el('button', 'volt-icon-button');
		node.type = 'button';
		node.title = title;
		node.setAttribute('aria-label', title);
		node.append(icon(name));
		node.addEventListener('click', () => post(type, extra));
		return node;
	};
	const section = (title, tools) => {
		const node = el('section', 'volt-section');
		const header = el('header', 'volt-section-header');
		header.append(el('span', 'volt-title', title));
		if (tools && tools.length) {
			const bar = el('div', 'volt-toolbar');
			bar.append(...tools);
			header.append(bar);
		}
		node.append(header);
		return node;
	};

	const FAILED = ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ERROR', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
	const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];
	const checkTone = check => FAILED.includes(check.conclusion) ? 'error' : PASSED.includes(check.conclusion) ? 'success' : 'warning';
	const STATE_TONE = { OPEN: 'success', MERGED: 'info', CLOSED: 'error' };

	function renderPr(parent) {
		const pr = state.pr;
		const tools = [iconButton('refresh', 'Refresh', 'refresh')];
		if (pr) { tools.push(iconButton('external', 'Open on GitHub', 'open', { url: pr.url })); }
		tools.push(iconButton('link', 'Link another pull request', 'link'));
		const node = section('Pull request', tools);
		if (!pr) {
			const empty = el('div', 'volt-empty');
			empty.append(el('span', '', state.loading ? 'Reading…' : (state.error || 'No pull request for this chat yet.')));
			const actions = el('div', 'volt-actions');
			actions.append(button('Link a pull request', 'link', 'small'));
			empty.append(actions);
			node.append(empty);
		} else {
			const row = el('button', 'volt-row two-line');
			row.type = 'button';
			row.title = pr.url;
			row.addEventListener('click', () => post('open', { url: pr.url }));
			const main = el('span', 'volt-row-main');
			main.append(el('span', 'volt-row-label', `#${pr.number} ${pr.title}`));
			const details = [pr.branch, pr.review ? pr.review.toLowerCase().replace(/_/g, ' ') : ''].filter(Boolean).join(' · ');
			if (details) { main.append(el('span', 'volt-row-description', details)); }
			row.append(main, el('span', `volt-badge ${STATE_TONE[pr.state] || ''}`.trim(), pr.state.toLowerCase()));
			node.append(row);
		}
		parent.append(node);
	}

	function renderChecks(parent, compact) {
		const checks = state.checks || [];
		const failing = checks.filter(c => checkTone(c) === 'error').length;
		const passing = checks.filter(c => checkTone(c) === 'success').length;
		const tools = compact ? [iconButton('panel', 'Open PR & CI', 'showPanel'), iconButton('refresh', 'Refresh', 'refresh')] : [];
		// In its own view Volt titles it "Checks" already: the header line is just the count.
		const count = checks.length ? `${passing} of ${checks.length} passed` : '';
		const node = section(compact ? count : (count ? `Checks · ${count}` : 'Checks'), tools);
		if (!state.pr || !checks.length) {
			node.append(el('div', 'volt-empty', !state.pr ? 'Checks show once the chat has a pull request.' : 'No checks ran on this pull request.'));
		} else {
			const list = el('ul', 'volt-list');
			for (const check of checks) {
				const tone = checkTone(check);
				const item = el('li');
				const row = el(check.url ? 'button' : 'div', 'volt-row');
				if (check.url) {
					row.type = 'button';
					row.title = check.url;
					row.addEventListener('click', () => post('open', { url: check.url }));
				}
				row.append(el('span', `volt-dot ${tone}`));
				row.append(el('span', 'volt-row-label volt-row-main', check.workflow ? `${check.workflow} / ${check.name}` : check.name));
				row.append(el('span', `volt-row-meta${tone === 'error' ? ' volt-tone-error' : ''}`, (check.conclusion || check.status || 'queued').toLowerCase().replace(/_/g, ' ')));
				item.append(row);
				list.append(item);
			}
			node.append(list);
		}
		if (failing) {
			const actions = el('div', 'volt-section-body');
			const bar = el('div', 'volt-actions');
			bar.append(button(`Ask the agent to fix ${failing === 1 ? 'it' : `all ${failing}`}`, 'fix', 'primary small'));
			actions.append(bar);
			node.append(actions);
		}
		parent.append(node);
	}

	function renderReview(parent) {
		const node = section('Review');
		const model = state.reviewModel;
		const row = el('button', 'volt-row');
		row.type = 'button';
		row.title = 'Pick the model reviews start on (Volt\'s model picker)';
		row.addEventListener('click', () => post('pickModel'));
		row.append(icon('model'), el('span', 'volt-row-label volt-row-main', 'Review model'), el('span', 'volt-row-meta', model ? model.label : 'Not set'));
		node.append(row);
		const body = el('div', 'volt-section-body');
		const bar = el('div', 'volt-actions');
		const ask = button('Ask to review', 'review', 'small');
		ask.disabled = !state.pr;
		bar.append(ask);
		body.append(bar);
		node.append(body);
		parent.append(node);
	}

	function renderNotes(parent) {
		const wrap = el('div', 'notes');
		const area = el('textarea', 'volt-textarea');
		area.placeholder = state.chat ? `Notes for ${state.chat.title || 'this chat'}. Saved by PR Pilot.` : 'Open a chat to keep notes for it.';
		area.disabled = !state.chat;
		area.value = state.notes || '';
		area.addEventListener('input', () => {
			clearTimeout(notesTimer);
			notesTimer = setTimeout(() => post('saveNotes', { text: area.value }), 400);
		});
		wrap.append(area);
		parent.append(wrap);
	}

	function render() {
		if (!state) {
			root.replaceChildren(el('div', 'volt-empty', 'Loading…'));
			return;
		}
		// Keep the notes field while the user types in it.
		if (kind === 'notes' && document.activeElement && document.activeElement.tagName === 'TEXTAREA') {
			return;
		}
		root.replaceChildren();
		if (kind === 'panel') {
			renderPr(root);
			renderChecks(root, false);
			renderReview(root);
		} else if (kind === 'checks') {
			renderChecks(root, true);
		} else {
			renderNotes(root);
		}
		vscode.setState({ state });
	}

	window.addEventListener('message', event => {
		if (event.data && event.data.type === 'state') {
			state = event.data.state;
			render();
		}
	});
	const saved = vscode.getState();
	state = saved && saved.state;
	render();
	post('ready');
}());
