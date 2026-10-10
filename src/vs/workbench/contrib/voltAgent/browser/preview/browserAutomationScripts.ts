/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IPageExpectation, IPageLocator } from '../../../../services/voltRuntime/common/tools/pageModel.js';

/**
 * Scripts the in-app browser runs inside the page for the agent's `browser_*` tools. Element
 * refs (e0, e1…) live in `window.__voltAgent`, stable per element for the life of the document,
 * so a ref from an earlier snapshot still names the same node after the page re-renders around it.
 * The same object counts DOM mutations and fetch/XHR requests, so an action can tell what it did
 * and when the page has settled.
 */

const RUNTIME = `
const S = window.__voltAgent || (window.__voltAgent = { next: 0, refs: new Map(), ids: new WeakMap() });
if (!S.doc) { S.doc = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
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
if (!S.mo && typeof MutationObserver === 'function' && document.documentElement) {
	// Style-only changes are animations far more often than state; they do not count.
	S.mut = 0;
	S.lastMut = performance.now();
	S.mo = new MutationObserver(records => {
		let counted = 0;
		for (const r of records) {
			if (r.type === 'attributes' && r.attributeName === 'style') { continue; }
			counted++;
		}
		if (counted) { S.mut += counted; S.lastMut = performance.now(); }
	});
	S.mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
}
if (!S.dialogs) {
	// Record native dialogs (and let them run as before), so an action can say it opened one.
	S.dialogs = [];
	S.dialogN = 0;
	for (const kind of ['alert', 'confirm', 'prompt']) {
		const original = window[kind];
		if (typeof original === 'function') {
			window[kind] = function (message) {
				S.dialogs.push({ n: ++S.dialogN, text: kind + ': ' + String(message === undefined ? '' : message) });
				if (S.dialogs.length > 10) { S.dialogs.shift(); }
				return original.apply(this, arguments);
			};
		}
	}
}
if (!S.net) {
	// Failed fetch/XHR calls from the first agent action on; earlier ones show in resource timing and the console.
	S.net = [];
	S.req = 0;
	S.open = new Map();
	S.openId = 0;
	const note = entry => { S.net.push(entry); if (S.net.length > 200) { S.net.shift(); } };
	const begin = () => { const id = ++S.openId; S.req++; S.open.set(id, performance.now()); return id; };
	const end = id => { S.open.delete(id); };
	try {
		const original = window.fetch;
		if (typeof original === 'function') {
			window.fetch = function (input, init) {
				const url = String((input && input.url) || input);
				const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
				const t0 = performance.now();
				const id = begin();
				return original.apply(this, arguments).then(response => {
					end(id);
					if (!response.ok) { note({ kind: 'fetch', method, url, status: response.status, ms: Math.round(performance.now() - t0) }); }
					return response;
				}, err => {
					end(id);
					note({ kind: 'fetch', method, url, error: String((err && err.message) || err), ms: Math.round(performance.now() - t0) });
					throw err;
				});
			};
		}
		const open = XMLHttpRequest.prototype.open;
		const send = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.open = function (method, url) { this.__volt = { method: String(method || 'GET').toUpperCase(), url: String(url) }; return open.apply(this, arguments); };
		XMLHttpRequest.prototype.send = function () {
			const info = this.__volt;
			const t0 = performance.now();
			if (info) {
				const id = begin();
				this.addEventListener('loadend', () => {
					end(id);
					if (this.status === 0 || this.status >= 400) { note({ kind: 'xhr', method: info.method, url: info.url, status: this.status || undefined, error: this.status ? undefined : 'network error', ms: Math.round(performance.now() - t0) }); }
				});
			}
			return send.apply(this, arguments);
		};
	} catch { }
}
// Requests open for more than 8s are streams or long polls: they never settle, so they do not count.
const inflight = () => { const now = performance.now(); let n = 0; for (const t0 of S.open.values()) { if (now - t0 < 8000) { n++; } } return n; };
const probe = () => {
	const a = document.activeElement;
	return { doc: S.doc, url: location.href, mut: S.mut || 0, req: S.req || 0, inflight: inflight(), focus: a && a !== document.body && a !== document.documentElement ? refOf(a) : '', dialogs: S.dialogs.slice(-5) };
};
`;

/** How the page reads to a screen reader: roles, names and states, as Volt's snapshot and locators see it. */
const A11Y = `
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
/** Visible itself and inside no hidden ancestor (a closed menu, a collapsed panel). */
const shown = el => {
	for (let n = el; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host)) {
		if (!visible(n)) { return false; }
	}
	return true;
};
const clickable = el => {
	if (el.hasAttribute('onclick') || (el.tabIndex >= 0 && el.hasAttribute('tabindex'))) { return true; }
	const style = getComputedStyle(el);
	if (style.cursor !== 'pointer') { return false; }
	const parent = el.parentElement;
	return !parent || getComputedStyle(parent).cursor !== 'pointer';
};
const roleOf = el => {
	let role = (el.getAttribute('role') || '').split(/\\s+/)[0] || implicitRole(el);
	if (role === 'presentation' || role === 'none') { role = undefined; }
	if (!role && clickable(el)) { role = 'button'; }
	return role;
};
const isDisabled = el => !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || (el.closest && el.closest('fieldset[disabled]') && el.matches('input, select, textarea, button')));
const isChecked = el => {
	const aria = el.getAttribute('aria-checked');
	if (aria) { return aria === 'true' ? true : aria === 'mixed' ? 'mixed' : false; }
	return !!el.checked;
};
const statesOf = (el, role) => {
	const states = [];
	if (isDisabled(el)) { states.push('disabled'); }
	const pressed = el.getAttribute('aria-pressed');
	if (pressed === 'true') { states.push('pressed'); } else if (pressed === 'false') { states.push('released'); }
	if (role === 'checkbox' || role === 'radio' || role === 'switch' || el.hasAttribute('aria-checked')) {
		const checked = isChecked(el);
		states.push(checked === true ? 'checked' : checked === 'mixed' ? 'mixed' : 'unchecked');
	}
	const expanded = el.getAttribute('aria-expanded');
	if (expanded) { states.push(expanded === 'true' ? 'expanded' : 'collapsed'); }
	if (el.getAttribute('aria-selected') === 'true' || (role === 'option' && el.selected)) { states.push('selected'); }
	if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') { states.push('current'); }
	if (el.required || el.getAttribute('aria-required') === 'true') { states.push('required'); }
	if (el.getAttribute('aria-invalid') === 'true') { states.push('invalid'); }
	if (document.activeElement === el) { states.push('focused'); }
	return states;
};
const isSecret = el => el.tagName.toLowerCase() === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'password';
const valueOf = el => {
	if (el.isContentEditable) { return el.innerText; }
	if (el.tagName.toLowerCase() === 'select') { return el.selectedOptions && el.selectedOptions.length ? [...el.selectedOptions].map(o => o.label).join(', ') : ''; }
	return 'value' in el ? String(el.value === undefined || el.value === null ? '' : el.value) : '';
};
/** Values read into the model never include what was typed into a password field. */
const shownValue = el => { const v = valueOf(el); return isSecret(el) && v ? '•'.repeat(Math.min(8, v.length)) : v; };
`;

/**
 * Finds elements by meaning: role + accessible name, visible text, form label, placeholder or CSS
 * selector, optionally inside the row/card/form/dialog of another element. Among matches it keeps
 * the best tier (exact over prefix over substring), drops a match nested in another, and reports
 * the rest as ambiguous instead of guessing.
 */
const LOCATE = `
const norm = s => String(s === undefined || s === null ? '' : s).replace(/\\s+/g, ' ').trim().toLowerCase();
const CONTAINER = 'tr,[role=row],li,[role=listitem],[role=option],article,[role=article],section,form,dialog,[role=dialog],[role=alertdialog],fieldset,[role=group],[role=region],[role=tabpanel],[role=gridcell],td,[role=cell]';
const PROMOTE = 'a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=treeitem],[role=combobox],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
const FIELD_ROLES = ['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'checkbox', 'radio', 'switch', 'listbox'];
const isField = el => {
	const tag = el.tagName.toLowerCase();
	if (tag === 'input') { return (el.getAttribute('type') || '').toLowerCase() !== 'hidden'; }
	return tag === 'textarea' || tag === 'select' || (el.isContentEditable && el.getAttribute('contenteditable') !== null) || FIELD_ROLES.includes(el.getAttribute('role') || '');
};
const allIn = root => {
	const out = [];
	const visit = r => { for (const el of r.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) { visit(el.shadowRoot); } } };
	visit(root);
	return out;
};
const tier = (have, wanted, exact) => {
	if (!wanted) { return 3; }
	const h = norm(have);
	if (!h) { return 0; }
	if (h === wanted) { return 3; }
	if (exact) { return 0; }
	if (h.startsWith(wanted)) { return 2; }
	return h.includes(wanted) ? 1 : 0;
};
const roleFits = (role, wanted) => role === wanted || (wanted === 'textbox' && role === 'searchbox');
const nearOf = el => {
	const c = el.parentElement && el.parentElement.closest('dialog,[role=dialog],[role=alertdialog],form,tr,[role=row],li,article,section,nav,header,footer,aside,main,table');
	if (!c) { return ''; }
	const role = roleOf(c) || c.tagName.toLowerCase();
	const heading = c.querySelector('h1,h2,h3,h4,h5,h6,legend,caption,th');
	const name = clean(c.getAttribute('aria-label') || labelledBy(c) || (role === 'row' || role === 'listitem' ? c.innerText : '') || (heading ? heading.textContent : ''), 50);
	return role + (name ? ' ' + JSON.stringify(name) : '');
};
const describeEl = el => { const role = roleOf(el) || el.tagName.toLowerCase(); return { ref: refOf(el), role, name: nameOf(el, role) || clean(el.innerText, 60), near: nearOf(el) }; };
const docOrder = (a, b) => a === b ? 0 : (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
const search = (L, scope) => {
	const exact = !!L.exact;
	const found = new Map();
	let hidden = 0;
	const consider = (el, score) => {
		if (score <= 0 || (scope && !scope.contains(el))) { return; }
		if (!shown(el)) { hidden++; return; }
		if (score > (found.get(el) || 0)) { found.set(el, score); }
	};
	const pool = () => scope ? [scope, ...allIn(scope)] : allIn(document);
	if (L.selector) {
		let list;
		try { list = [...(scope || document).querySelectorAll(L.selector)]; } catch { return { error: 'selector' }; }
		const want = norm(L.name || L.text);
		for (const el of list) { consider(el, want ? Math.max(tier(nameOf(el, roleOf(el)), want, exact), tier(el.innerText, want, exact)) : 3); }
	} else if (L.label || L.placeholder) {
		const want = norm(L.label || L.placeholder);
		for (const el of pool()) {
			if (!isField(el)) { continue; }
			consider(el, L.label ? Math.max(tier(nameOf(el, roleOf(el)), want, exact), tier(el.getAttribute('placeholder'), want, true)) : tier(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'), want, exact));
		}
	} else if (L.role) {
		const want = norm(L.name);
		for (const el of pool()) {
			const role = roleOf(el);
			if (role && roleFits(role, L.role)) { consider(el, tier(nameOf(el, role), want, exact)); }
		}
	} else if (L.text) {
		const want = norm(L.text);
		for (const el of pool()) {
			const role = roleOf(el);
			if (role && INTERACTIVE.has(role)) { consider(el, tier(nameOf(el, role), want, exact)); }
		}
		const root = scope || document.body || document.documentElement;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (!norm(n.data).includes(want)) {
				continue;
			}
			const parent = n.parentElement;
			if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(parent.tagName)) { continue; }
			const target = parent.closest(PROMOTE) || parent;
			consider(target, tier(parent.innerText, want, exact) || (exact ? 0 : 1));
		}
	}
	return { found, hidden };
};
const locate = (L, depth) => {
	// "within": the innermost row, item, card, form or dialog around that element that holds a match.
	let scopes = [undefined];
	if (L.within) {
		if ((depth || 0) > 2) { return { error: 'within' }; }
		const w = locate(L.within, (depth || 0) + 1);
		if (w.error) { return { error: 'within-' + w.error, candidates: w.candidates, count: w.count, hidden: w.hidden }; }
		scopes = [];
		for (let n = w.el; n && n.nodeType === 1; n = n.parentElement) {
			if (n === w.el || n.matches(CONTAINER)) { scopes.push(n); }
		}
	}
	if (L.ref) {
		const el = byRef(L.ref);
		if (!el) { return { error: 'stale' }; }
		if (scopes[0] && !scopes.some(scope => scope.contains(el))) { return { error: 'not-within' }; }
		return { el, count: 1, matches: 1 };
	}
	let result = { found: new Map(), hidden: 0 };
	for (const scope of scopes) {
		result = search(L, scope);
		if (result.error || result.found.size) { break; }
	}
	if (result.error) { return { error: result.error }; }
	const found = result.found;
	if (!found.size) { return { error: 'not-found', hidden: result.hidden }; }
	const entries = [...found.entries()];
	const best = Math.max(...entries.map(e => e[1]));
	let top = entries.filter(e => e[1] === best).map(e => e[0]);
	// A match nested in another is the same target: keep the interactive one, else the outer one.
	const nested = top.filter(el => !top.some(o => o !== el && ((o.contains(el) && !el.matches(PROMOTE)) || (el.contains(o) && o.matches(PROMOTE)))));
	top = (nested.length ? nested : top).sort(docOrder);
	if (L.nth !== undefined && L.nth !== null) {
		const i = L.nth < 0 ? top.length + L.nth : L.nth;
		if (i < 0 || i >= top.length) { return { error: 'nth', count: top.length, matches: entries.length }; }
		return { el: top[i], count: top.length, matches: entries.length };
	}
	if (top.length > 1) {
		return { error: 'ambiguous', count: top.length, matches: entries.length, candidates: top.slice(0, 6).map(describeEl) };
	}
	return { el: top[0], count: 1, matches: entries.length };
};
`;

/**
 * The page's role tree, flattened in document order (see `IPageNode`). Wrappers without a role
 * are flattened; hidden nodes and empty text are dropped. `items` also lists the interactive
 * elements with their boxes, for the screenshot's element list.
 */
export function snapshotScript(options: { selector?: string; interactive?: boolean; items?: boolean } = {}): string {
	return `(() => {
${RUNTIME}
${A11Y}
const MAX_NODES = 2000;
const SELECTOR = ${JSON.stringify(options.selector ?? null)};
const ONLY_INTERACTIVE = ${options.interactive === true};
const WITH_ITEMS = ${options.items === true};
const nodes = [];
const items = [];
const directText = el => {
	let text = '';
	for (const node of el.childNodes) {
		if (node.nodeType === 3) { text += node.textContent; }
	}
	return clean(text, 160);
};
const walk = (el, depth, parent) => {
	if (nodes.length >= MAX_NODES || !(el instanceof Element)) { return; }
	const tag = el.tagName.toLowerCase();
	if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'head' || tag === 'meta' || tag === 'link') { return; }
	if (!visible(el)) { return; }
	const role = roleOf(el);
	const include = role && (INTERACTIVE.has(role) || (!ONLY_INTERACTIVE && LANDMARK.has(role)));
	let node;
	if (include) {
		node = { role, ref: refOf(el), depth, parent };
		const name = nameOf(el, role);
		if (name) { node.name = name; }
		const states = statesOf(el, role);
		if (states.length) { node.states = states; }
		if (role === 'heading') { node.level = Number(el.getAttribute('aria-level')) || Number(tag.slice(1)) || undefined; }
		if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || role === 'slider' || role === 'combobox') {
			const value = shownValue(el);
			if (value !== '' && value !== node.name) { node.value = clean(value, 200); }
		}
		if (role === 'link' && el.getAttribute('href')) { node.url = el.getAttribute('href').slice(0, 200); }
		if (WITH_ITEMS && INTERACTIVE.has(role)) {
			const r = el.getBoundingClientRect();
			items.push({ ref: node.ref, role, name: node.name || '', box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], states: node.states, value: node.value });
		}
		nodes.push(node);
	}
	const childDepth = node ? depth + 1 : depth;
	const childParent = node ? node.ref : parent;
	const leaf = node && (INTERACTIVE.has(role) || role === 'heading' || role === 'img');
	if (!leaf) {
		const text = ONLY_INTERACTIVE ? '' : directText(el);
		if (text && (!node || text !== node.name)) {
			nodes.push({ role: 'text', name: text, depth: childDepth, parent: childParent });
		}
		for (const child of el.children) { walk(child, childDepth, childParent); }
		if (el.shadowRoot) { for (const child of el.shadowRoot.children) { walk(child, childDepth, childParent); } }
	}
	if (tag === 'iframe') { nodes.push({ role: 'iframe', name: clean(el.getAttribute('title') || el.src), ref: refOf(el), depth: childDepth, parent: childParent }); }
};
let scope = document.body;
if (SELECTOR) {
	try { scope = document.querySelector(SELECTOR); } catch { scope = null; }
	if (!scope) { return { doc: S.doc, url: location.href, title: document.title, nodes: [], error: 'selector' }; }
}
if (scope) { walk(scope, 0, 'root'); }
const doc = document.scrollingElement || document.documentElement;
return {
	doc: S.doc,
	url: location.href,
	title: document.title,
	nodes,
	truncated: nodes.length >= MAX_NODES || undefined,
	items: WITH_ITEMS ? items : undefined,
	viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(doc.scrollTop), scrollHeight: doc.scrollHeight, scrollWidth: doc.scrollWidth },
};
})()`;
}

/** The full-page snapshot every action reads. */
export const SNAPSHOT_SCRIPT = snapshotScript();

/** The page's counters (document, URL, mutations, requests, focus), before an action. */
export const PROBE_SCRIPT = `(() => {
${RUNTIME}
return probe();
})()`;

/**
 * Waits at least `minMs` (input still on its way to the page), then until the DOM has been quiet
 * for `quietMs` and no fetch/XHR is open, up to `maxMs`, and reads the counters again.
 * `quiet: false` means the page was still busy when the time ran out.
 */
export function quietScript(quietMs: number, maxMs: number, minMs = 0): string {
	return `(async () => {
${RUNTIME}
const QUIET = ${Math.max(0, Math.round(quietMs))};
const MAX = ${Math.max(0, Math.round(maxMs))};
const MIN = ${Math.max(0, Math.round(minMs))};
const start = performance.now();
let quiet = false;
while (true) {
	const now = performance.now();
	if (now - start >= MIN && inflight() === 0 && now - (S.lastMut || 0) >= QUIET) { quiet = true; break; }
	if (now - start >= MAX) { break; }
	await new Promise(r => setTimeout(r, 20));
}
return Object.assign(probe(), { quiet, waited: Math.round(performance.now() - start) });
})()`;
}

export interface ILocateResult {
	readonly ref?: string;
	readonly role?: string;
	readonly name?: string;
	/** Equally good matches (1 when unique). */
	readonly count?: number;
	/** Visible matches of any quality. */
	readonly matches?: number;
	/** Matches that exist but are hidden. */
	readonly hidden?: number;
	/** A password field: never echo what goes in. */
	readonly secret?: boolean;
	readonly disabled?: boolean;
	readonly error?: 'not-found' | 'ambiguous' | 'stale' | 'selector' | 'nth' | 'not-within' | 'within' | `within-${string}`;
	readonly candidates?: readonly { readonly ref: string; readonly role: string; readonly name: string; readonly near: string }[];
}

/** Resolves a locator to one element's ref (see `LOCATE`). */
export function locateScript(locator: IPageLocator): string {
	return `(() => {
${RUNTIME}
${A11Y}
${LOCATE}
const r = locate(${JSON.stringify(locator)}, 0);
if (r.error) { return { error: r.error, count: r.count, matches: r.matches, hidden: r.hidden, candidates: r.candidates }; }
const role = roleOf(r.el) || r.el.tagName.toLowerCase();
return { ref: refOf(r.el), role, name: nameOf(r.el, role) || clean(r.el.innerText, 60), count: r.count, matches: r.matches, secret: isSecret(r.el), disabled: isDisabled(r.el) };
})()`;
}

export interface IExpectResult {
	readonly ok: boolean;
	/** Why it does not hold yet, as the page is now. */
	readonly detail: string;
}

/** Checks a postcondition once (the caller polls until it holds or the time runs out). */
export function expectScript(expectation: IPageExpectation): string {
	return `(() => {
${RUNTIME}
${A11Y}
${LOCATE}
const E = ${JSON.stringify(expectation)};
const fails = [];
const matches = (value, pattern) => {
	const m = /^\\/(.+)\\/([a-z]*)$/.exec(pattern);
	if (m) { try { return new RegExp(m[1], m[2]).test(value); } catch { } }
	return value.includes(pattern);
};
if (E.url && !matches(location.href, E.url)) { fails.push('url is ' + location.href); }
if (E.title && !norm(document.title).includes(norm(E.title))) { fails.push('title is ' + JSON.stringify(document.title)); }
if (E.text || E.textGone) {
	const body = norm(document.body ? document.body.innerText : '');
	if (E.text && !body.includes(norm(E.text))) { fails.push(JSON.stringify(E.text) + ' is not on the page'); }
	if (E.textGone && body.includes(norm(E.textGone))) { fails.push(JSON.stringify(E.textGone) + ' is still on the page'); }
}
if (E.target) {
	const r = locate(E.target, 0);
	const state = E.state || (E.value === undefined && E.count === undefined ? 'visible' : undefined);
	if (E.count !== undefined) {
		const n = r.error === 'not-found' ? 0 : (r.matches || r.count || 0);
		if (n !== E.count) { fails.push(n + ' matching elements, not ' + E.count); }
	}
	if (state === 'hidden') {
		if (!r.error || r.error === 'ambiguous') { fails.push('it is visible'); }
	} else if (state || E.value !== undefined) {
		if (r.error) {
			fails.push(r.error === 'ambiguous' ? r.count + ' elements match; make the target unique' : r.error === 'not-found' ? 'no visible element matches' + (r.hidden ? ' (' + r.hidden + ' hidden)' : '') : r.error === 'stale' ? 'the ref is gone' : r.error);
		} else {
			const el = r.el;
			const a = document.activeElement;
			const flag = {
				visible: true,
				enabled: !isDisabled(el),
				disabled: isDisabled(el),
				checked: isChecked(el) === true,
				unchecked: isChecked(el) === false,
				focused: !!a && (a === el || el.contains(a)),
				expanded: el.getAttribute('aria-expanded') === 'true' || (el.tagName.toLowerCase() === 'details' && el.open),
				collapsed: el.getAttribute('aria-expanded') === 'false' || (el.tagName.toLowerCase() === 'details' && !el.open),
				selected: el.getAttribute('aria-selected') === 'true' || !!el.selected,
			};
			if (state && !flag[state]) { fails.push('it is not ' + state + ' (' + (statesOf(el, roleOf(el)).join(', ') || 'no states') + ')'); }
			if (E.value !== undefined) {
				const v = valueOf(el);
				const have = el.isContentEditable || !('value' in el) ? norm(v || el.innerText) : String(v).trim();
				const want = el.isContentEditable || !('value' in el) ? norm(E.value) : E.value.trim();
				if (have !== want) { fails.push('its value is ' + JSON.stringify(isSecret(el) ? shownValue(el) : clean(v, 120))); }
			}
		}
	}
}
return { ok: !fails.length, detail: fails.join('; ') };
})()`;
}

/** An element's checked state, value and disabled flag, to verify what a step did to it. */
export function readStateScript(ref: string): string {
	return `(() => {
${RUNTIME}
${A11Y}
const el = byRef(${JSON.stringify(ref)});
if (!el) { return { error: 'stale' }; }
return { checked: isChecked(el), value: valueOf(el), shown: clean(shownValue(el), 200), disabled: isDisabled(el), secret: isSecret(el) };
})()`;
}

/** The element's box in viewport CSS px after scrolling it into view, for element screenshots. */
export function rectScript(ref: string): string {
	return `(() => {
${RUNTIME}
const el = byRef(${JSON.stringify(ref)});
if (!el) { return { error: 'stale' }; }
const r0 = el.getBoundingClientRect();
if (r0.top < 0 || r0.left < 0 || r0.bottom > innerHeight || r0.right > innerWidth) {
	el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
}
const r = el.getBoundingClientRect();
return { x: Math.max(0, r.left), y: Math.max(0, r.top), w: Math.min(innerWidth, r.right) - Math.max(0, r.left), h: Math.min(innerHeight, r.bottom) - Math.max(0, r.top), viewportWidth: innerWidth };
})()`;
}

export interface INetworkEntry {
	readonly url: string;
	readonly type: string;
	readonly status?: number;
	readonly error?: string;
	readonly method?: string;
	readonly ms: number;
	readonly bytes?: number;
}

/** Requests since the page loaded (resource timing, with HTTP status where the browser reports it) plus recorded fetch/XHR failures. */
export const NETWORK_SCRIPT = `(() => {
${RUNTIME}
const entries = [];
const nav = performance.getEntriesByType('navigation')[0];
if (nav) { entries.push({ url: nav.name, type: 'document', status: nav.responseStatus || undefined, ms: Math.round(nav.duration), bytes: nav.transferSize || nav.encodedBodySize || undefined }); }
for (const e of performance.getEntriesByType('resource')) {
	entries.push({ url: e.name, type: e.initiatorType || 'other', status: e.responseStatus || undefined, ms: Math.round(e.duration), bytes: e.transferSize || e.encodedBodySize || undefined });
}
return { entries: entries.slice(-400), failures: S.net.slice() };
})()`;

/** Scrolls the ref's element into view and returns its center, and whether that point really hits it. */
export function targetScript(ref: string): string {
	return `(() => {
${RUNTIME}
const el = byRef(${JSON.stringify(ref)});
if (!el) { return { error: 'stale' }; }
const r0 = el.getBoundingClientRect();
if (r0.top < 0 || r0.left < 0 || r0.bottom > innerHeight || r0.right > innerWidth) {
	el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
}
const r = el.getBoundingClientRect();
const x = Math.round(r.left + r.width / 2);
const y = Math.round(r.top + Math.min(r.height / 2, Math.max(1, r.height - 1)));
const hit = document.elementFromPoint(x, y);
const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el) && !(hit.tagName === 'LABEL' && (hit.control === el || hit.contains(el)));
const describe = n => n ? n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') : '';
return { x, y, width: r.width, height: r.height, covered: covered ? describe(hit) : undefined, disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'), tag: el.tagName.toLowerCase() };
})()`;
}

export function focusScript(ref: string, clear: boolean): string {
	return `(() => {
${RUNTIME}
const el = byRef(${JSON.stringify(ref)});
if (!el) { return { error: 'stale' }; }
el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
el.focus();
if (${clear}) {
	if ('value' in el && typeof el.select === 'function') {
		el.select();
	} else if (el.isContentEditable) {
		const range = document.createRange();
		range.selectNodeContents(el);
		const sel = getSelection();
		sel.removeAllRanges();
		sel.addRange(range);
	}
}
return { focused: document.activeElement === el || el.contains(document.activeElement), editable: el.isContentEditable || 'value' in el };
})()`;
}

/** Fallback when the webview cannot insert text natively. */
export function setValueScript(ref: string, text: string, clear: boolean): string {
	return `(() => {
${RUNTIME}
const el = byRef(${JSON.stringify(ref)});
if (!el) { return { error: 'stale' }; }
const text = ${JSON.stringify(text)};
if (el.isContentEditable) {
	document.execCommand(${clear} ? 'insertText' : 'insertText', false, text);
} else {
	const proto = Object.getPrototypeOf(el);
	const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
	const next = ${clear} ? text : (el.value || '') + text;
	setter ? setter.call(el, next) : (el.value = next);
	el.dispatchEvent(new Event('input', { bubbles: true }));
	el.dispatchEvent(new Event('change', { bubbles: true }));
}
return { ok: true };
})()`;
}

export function clickFallbackScript(ref: string): string {
	return `(() => {
${RUNTIME}
const el = byRef(${JSON.stringify(ref)});
if (!el) { return { error: 'stale' }; }
el.click();
return { ok: true };
})()`;
}

export function selectOptionScript(ref: string, values: readonly string[]): string {
	return `(() => {
${RUNTIME}
const el = byRef(${JSON.stringify(ref)});
if (!el) { return { error: 'stale' }; }
if (el.tagName.toLowerCase() !== 'select') { return { error: 'not a select' }; }
const wanted = ${JSON.stringify(values)};
const lower = wanted.map(v => String(v).trim().toLowerCase());
const hit = option => wanted.includes(option.value) || wanted.includes(option.label) || wanted.includes(option.text.trim()) || lower.includes(option.label.trim().toLowerCase());
const picked = [];
if (el.multiple) {
	for (const option of el.options) {
		option.selected = hit(option);
		if (option.selected) { picked.push(option.label); }
	}
} else {
	// Deselecting the current option of a single select re-selects the first one, so pick by index.
	const option = [...el.options].find(hit);
	if (option) {
		el.selectedIndex = option.index;
		picked.push(option.label);
	}
}
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return { picked };
})()`;
}

export function scrollScript(ref: string | undefined, deltaX: number, deltaY: number): string {
	return `(() => {
${RUNTIME}
const el = ${ref ? `byRef(${JSON.stringify(ref)})` : 'undefined'};
if (${JSON.stringify(!!ref)} && !el) { return { error: 'stale' }; }
const target = el || document.scrollingElement || document.documentElement;
target.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: 'instant' });
return { scrollY: Math.round((document.scrollingElement || document.documentElement).scrollTop) };
})()`;
}

export function textPresentScript(text: string): string {
	return `(() => (document.body ? document.body.innerText : '').includes(${JSON.stringify(text)}))()`;
}

/** Runs an expression or a `(el) => …` function the agent wrote and returns its JSON. */
export function evaluateScript(expression: string, ref: string | undefined): string {
	const trimmed = expression.trim();
	const isFunction = /^(async\s+)?(\([^)]*\)|[\w$]+)\s*=>/.test(trimmed) || /^(async\s+)?function\b/.test(trimmed);
	const body = isFunction ? `(${trimmed})(el)` : `(${trimmed})`;
	return `(async () => {
${RUNTIME}
const el = ${ref ? `byRef(${JSON.stringify(ref)})` : 'undefined'};
try {
	const value = await ${body};
	let json;
	try { json = JSON.stringify(value, (k, v) => v instanceof Element ? '<' + v.tagName.toLowerCase() + '>' : v, 2); } catch { json = String(value); }
	return { value: json === undefined ? 'undefined' : json };
} catch (err) {
	return { error: String(err && err.stack || err) };
}
})()`;
}
