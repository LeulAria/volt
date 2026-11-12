// In the workbench over CDP: every visible control in the agent window (chat, composer, side
// toolbar, open menus) without an accessible name, and every one that cannot be reached by Tab.
(() => {
	const scope = document.querySelector('.volt-agent-editor:not(.browser-hosted)')?.closest('.part') ?? document.body;
	const roots = [scope, ...document.querySelectorAll('.context-view, .volt-agent-tooltip:not(.hidden)')];
	const controls = new Set();
	for (const root of roots) {
		for (const el of root.querySelectorAll('button, [role=button], a[href], [role=menuitem], [role=option], [role=checkbox], [role=tab], input, textarea')) {
			controls.add(el);
		}
	}
	const visible = el => {
		const r = el.getBoundingClientRect();
		if (!r.width || !r.height) {
			return false;
		}
		for (let e = el; e; e = e.parentElement) {
			const s = getComputedStyle(e);
			if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) {
				return false;
			}
		}
		return true;
	};
	const name = el => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
	const describe = el => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join('.')}`;
	const unnamed = [];
	const unreachable = [];
	for (const el of controls) {
		if (!visible(el)) {
			continue;
		}
		if (!name(el)) {
			unnamed.push(describe(el));
		}
		const inList = el.closest('.monaco-list');
		if (el.tabIndex < 0 && !inList && !el.closest('.monaco-editor')) {
			unreachable.push(`${describe(el)} "${name(el).slice(0, 30)}"`);
		}
	}
	return { controls: controls.size, unnamed, unreachable };
})();
