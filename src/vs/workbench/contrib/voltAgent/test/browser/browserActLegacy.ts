/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The page snapshot Volt's browser tools returned before `browser_act` (commit 3f06d263), kept
 * verbatim as the benchmark's baseline: every action used to return this whole YAML tree.
 * Its refs live in a separate `window.__voltLegacy` so it does not disturb the current runtime.
 */

const RUNTIME = `
const S = window.__voltLegacy || (window.__voltLegacy = { next: 0, refs: new Map(), ids: new WeakMap() });
const refOf = el => {
	let id = S.ids.get(el);
	if (!id) {
		id = 'e' + (S.next++);
		S.ids.set(el, id);
		S.refs.set(id, new WeakRef(el));
	}
	return id;
};
const byRef = ref => {
	const weak = S.refs.get(String(ref || '').trim());
	const el = weak && weak.deref();
	return el && el.isConnected ? el : undefined;
};
// (the fetch/XHR recorder of the original runtime is left out: it does not change the snapshot)
`;

/**
 * An accessibility snapshot in the YAML shape Cursor shows (role, name, ref, states, children).
 * Wrappers without a role are flattened; hidden nodes and empty text are dropped.
 */
function legacySnapshotScript(options: { selector?: string; interactive?: boolean; items?: boolean } = {}): string {
	return `(() => {
${RUNTIME}
const MAX_NODES = 600;
const SELECTOR = ${JSON.stringify(options.selector ?? null)};
const ONLY_INTERACTIVE = ${options.interactive === true};
const WITH_ITEMS = ${options.items === true};
const items = [];
let count = 0;
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem']);
const LANDMARK = new Set(['heading', 'img', 'navigation', 'main', 'banner', 'contentinfo', 'form', 'dialog', 'alertdialog', 'alert', 'status', 'list', 'listitem', 'table', 'row', 'cell', 'columnheader', 'rowheader', 'region', 'group', 'radiogroup', 'tablist', 'tabpanel', 'menu', 'menubar', 'toolbar', 'grid', 'gridcell', 'article', 'complementary', 'progressbar', 'meter', 'separator']);
const implicitRole = el => {
	const tag = el.tagName.toLowerCase();
	const type = (el.getAttribute('type') || '').toLowerCase();
	switch (tag) {
		case 'a': return el.hasAttribute('href') ? 'link' : undefined;
		case 'button': case 'summary': return 'button';
		case 'input':
			if (type === 'hidden') { return undefined; }
			if (['button', 'submit', 'reset', 'image'].includes(type)) { return 'button'; }
			if (type === 'checkbox') { return 'checkbox'; }
			if (type === 'radio') { return 'radio'; }
			if (type === 'range') { return 'slider'; }
			if (type === 'number') { return 'spinbutton'; }
			if (type === 'search') { return 'searchbox'; }
			return 'textbox';
		case 'textarea': return 'textbox';
		case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
		case 'option': return 'option';
		case 'img': return el.getAttribute('alt') === '' ? undefined : 'img';
		case 'svg': return el.getAttribute('aria-label') || el.querySelector(':scope > title') ? 'img' : undefined;
		case 'canvas': return 'img';
		case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
		case 'nav': return 'navigation';
		case 'main': return 'main';
		case 'header': return el.closest('article, aside, main, nav, section') ? undefined : 'banner';
		case 'footer': return el.closest('article, aside, main, nav, section') ? undefined : 'contentinfo';
		case 'form': return 'form';
		case 'dialog': return 'dialog';
		case 'ul': case 'ol': case 'menu': return 'list';
		case 'li': return 'listitem';
		case 'table': return 'table';
		case 'tr': return 'row';
		case 'td': return 'cell';
		case 'th': return 'columnheader';
		case 'aside': return 'complementary';
		case 'article': return 'article';
		case 'progress': return 'progressbar';
		case 'meter': return 'meter';
		case 'hr': return 'separator';
		case 'fieldset': return 'group';
	}
	if (el.isContentEditable && el.getAttribute('contenteditable') !== null) { return 'textbox'; }
	return undefined;
};
const clean = (text, max = 100) => {
	const t = String(text || '').replace(/\\s+/g, ' ').trim();
	return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
const labelledBy = el => {
	const ids = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
	return ids.map(id => document.getElementById(id)).filter(Boolean).map(n => n.innerText || n.textContent).join(' ');
};
const nameOf = (el, role) => {
	const aria = el.getAttribute('aria-label') || labelledBy(el);
	if (aria) { return clean(aria); }
	const tag = el.tagName.toLowerCase();
	if (tag === 'input' || tag === 'textarea' || tag === 'select') {
		const id = el.getAttribute('id');
		const label = (id && document.querySelector('label[for="' + CSS.escape(id) + '"]')) || el.closest('label');
		if (label) { return clean(label.innerText); }
		if (['button', 'submit', 'reset'].includes((el.getAttribute('type') || '').toLowerCase())) { return clean(el.value); }
		return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name'));
	}
	if (tag === 'img' || tag === 'area') { return clean(el.getAttribute('alt') || el.getAttribute('title')); }
	if (tag === 'svg') { const t = el.querySelector(':scope > title'); return clean(t ? t.textContent : ''); }
	if (role && (INTERACTIVE.has(role) || role === 'heading' || role === 'cell' || role === 'columnheader' || role === 'listitem' || role === 'option' || role === 'tab')) {
		return clean(el.innerText || el.textContent || el.getAttribute('title'), role === 'listitem' || role === 'cell' ? 80 : 100);
	}
	return clean(el.getAttribute('title'));
};
const visible = el => {
	if (el.hidden || el.getAttribute('aria-hidden') === 'true') { return false; }
	const style = getComputedStyle(el);
	if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') { return false; }
	if (parseFloat(style.opacity) === 0 && !el.matches('input, select, textarea, button')) { return false; }
	const r = el.getBoundingClientRect();
	return r.width > 0 || r.height > 0 || style.display === 'contents';
};
const clickable = el => {
	if (el.hasAttribute('onclick') || (el.tabIndex >= 0 && el.hasAttribute('tabindex'))) { return true; }
	const style = getComputedStyle(el);
	if (style.cursor !== 'pointer') { return false; }
	const parent = el.parentElement;
	return !parent || getComputedStyle(parent).cursor !== 'pointer';
};
const statesOf = (el, role) => {
	const states = [];
	if (el.disabled || el.getAttribute('aria-disabled') === 'true') { states.push('disabled'); }
	const pressed = el.getAttribute('aria-pressed');
	if (pressed === 'true') { states.push('pressed'); } else if (pressed === 'false') { states.push('released'); }
	if (role === 'checkbox' || role === 'radio' || role === 'switch' || el.hasAttribute('aria-checked')) {
		const checked = el.getAttribute('aria-checked') || (el.checked ? 'true' : 'false');
		states.push(checked === 'true' ? 'checked' : checked === 'mixed' ? 'mixed' : 'unchecked');
	}
	const expanded = el.getAttribute('aria-expanded');
	if (expanded) { states.push(expanded === 'true' ? 'expanded' : 'collapsed'); }
	if (el.getAttribute('aria-selected') === 'true' || (role === 'option' && el.selected)) { states.push('selected'); }
	if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') { states.push('current'); }
	if (el.required || el.getAttribute('aria-required') === 'true') { states.push('required'); }
	if (document.activeElement === el) { states.push('focused'); }
	return states;
};
const directText = el => {
	let text = '';
	for (const node of el.childNodes) {
		if (node.nodeType === 3) { text += node.textContent; }
	}
	return clean(text, 160);
};
const walk = (el, out) => {
	if (count >= MAX_NODES || !(el instanceof Element)) { return; }
	const tag = el.tagName.toLowerCase();
	if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'head' || tag === 'meta' || tag === 'link') { return; }
	if (!visible(el)) { return; }
	let role = (el.getAttribute('role') || '').split(/\\s+/)[0] || implicitRole(el);
	if (role === 'presentation' || role === 'none') { role = undefined; }
	if (!role && clickable(el)) { role = 'button'; }
	const include = role && (INTERACTIVE.has(role) || (!ONLY_INTERACTIVE && LANDMARK.has(role)));
	const node = include ? { role, name: nameOf(el, role), ref: refOf(el), children: [] } : undefined;
	if (node) {
		count++;
		const states = statesOf(el, role);
		if (states.length) { node.states = states; }
		if (INTERACTIVE.has(role)) {
			const r = el.getBoundingClientRect();
			node.box = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
		}
		if (role === 'heading') { node.level = Number(el.getAttribute('aria-level')) || Number(tag.slice(1)) || undefined; }
		if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || role === 'slider' || role === 'combobox') {
			const value = el.isContentEditable ? el.innerText : el.value;
			if (value !== undefined && value !== '' && (tag !== 'select')) { node.value = clean(value, 200); }
			if (tag === 'select' && el.selectedOptions && el.selectedOptions.length) { node.value = clean([...el.selectedOptions].map(o => o.label).join(', ')); }
		}
		if (role === 'link' && el.getAttribute('href')) { node.url = el.getAttribute('href').slice(0, 200); }
		if (WITH_ITEMS && INTERACTIVE.has(role)) { items.push({ ref: node.ref, role, name: node.name, box: node.box, states: node.states, value: node.value }); }
		out.push(node);
	}
	const target = node ? node.children : out;
	const leaf = node && (INTERACTIVE.has(role) || role === 'heading' || role === 'img');
	if (!leaf) {
		const text = ONLY_INTERACTIVE ? '' : directText(el);
		if (text && (!node || text !== node.name)) {
			target.push({ role: 'text', name: text });
			count++;
		}
		for (const child of el.children) { walk(child, target); }
		if (el.shadowRoot) { for (const child of el.shadowRoot.children) { walk(child, target); } }
	}
	if (tag === 'iframe') { target.push({ role: 'iframe', name: clean(el.getAttribute('title') || el.src), ref: refOf(el) }); }
};
const root = { role: 'document', name: clean(document.title), ref: 'root', children: [] };
let scope = document.body;
if (SELECTOR) {
	try { scope = document.querySelector(SELECTOR); } catch { scope = null; }
	if (!scope) { return { url: location.href, title: document.title, yaml: '# no element matches ' + JSON.stringify(SELECTOR), error: 'selector' }; }
	root.role = 'subtree';
	root.name = SELECTOR;
}
if (scope) { walk(scope, root.children); }
const q = v => /^[\\w .,!?()'/&+#@%-]*$/.test(v) && !/^[\\s-]|:\\s|\\s$/.test(v) && v !== '' ? v : JSON.stringify(v);
const lines = [];
const emit = (node, depth) => {
	const pad = '  '.repeat(depth);
	lines.push(pad + '- role: ' + node.role);
	if (node.name) { lines.push(pad + '  name: ' + q(node.name)); }
	if (node.ref) { lines.push(pad + '  ref: ' + node.ref); }
	if (node.level) { lines.push(pad + '  level: ' + node.level); }
	if (node.box) { lines.push(pad + '  box: [' + node.box.join(', ') + ']'); }
	if (node.value !== undefined) { lines.push(pad + '  value: ' + q(node.value)); }
	if (node.url) { lines.push(pad + '  url: ' + q(node.url)); }
	if (node.states) { lines.push(pad + '  states: [' + node.states.join(', ') + ']'); }
	if (node.children && node.children.length) {
		lines.push(pad + '  children:');
		for (const child of node.children) { emit(child, depth + 2); }
	}
};
emit(root, 0);
if (count >= MAX_NODES) { lines.push('# snapshot truncated at ' + MAX_NODES + ' nodes'); }
const doc = document.scrollingElement || document.documentElement;
return {
	url: location.href,
	title: document.title,
	yaml: lines.join('\\n'),
	items: WITH_ITEMS ? items : undefined,
	viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(doc.scrollTop), scrollHeight: doc.scrollHeight, scrollWidth: doc.scrollWidth },
};
})()`;
}

/** The full-page snapshot every action returns. */
export const LEGACY_SNAPSHOT_SCRIPT = legacySnapshotScript();
