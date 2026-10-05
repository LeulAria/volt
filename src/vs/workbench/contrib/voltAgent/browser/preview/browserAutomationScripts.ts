/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Scripts the in-app browser runs inside the page for the agent's `browser_*` tools. Element
 * refs (e0, e1…) live in `window.__voltAgent`, stable per element for the life of the document,
 * so a ref from an earlier snapshot still names the same node after the page re-renders around it.
 */

const RUNTIME = `
const S = window.__voltAgent || (window.__voltAgent = { next: 0, refs: new Map(), ids: new WeakMap() });
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
if (!S.net) {
	// Failed fetch/XHR calls from the first agent action on; earlier ones show in resource timing and the console.
	S.net = [];
	const note = entry => { S.net.push(entry); if (S.net.length > 200) { S.net.shift(); } };
	try {
		const original = window.fetch;
		if (typeof original === 'function') {
			window.fetch = function (input, init) {
				const url = String((input && input.url) || input);
				const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
				const t0 = performance.now();
				return original.apply(this, arguments).then(response => {
					if (!response.ok) { note({ kind: 'fetch', method, url, status: response.status, ms: Math.round(performance.now() - t0) }); }
					return response;
				}, err => {
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
				this.addEventListener('loadend', () => {
					if (this.status === 0 || this.status >= 400) { note({ kind: 'xhr', method: info.method, url: info.url, status: this.status || undefined, error: this.status ? undefined : 'network error', ms: Math.round(performance.now() - t0) }); }
				});
			}
			return send.apply(this, arguments);
		};
	} catch { }
}
`;

/**
 * An accessibility snapshot in the YAML shape Cursor shows (role, name, ref, states, children).
 * Wrappers without a role are flattened; hidden nodes and empty text are dropped.
 */
export function snapshotScript(options: { selector?: string; interactive?: boolean } = {}): string {
	return `(() => {
${RUNTIME}
const MAX_NODES = 600;
const SELECTOR = ${JSON.stringify(options.selector ?? null)};
const ONLY_INTERACTIVE = ${options.interactive === true};
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
		if (role === 'heading') { node.level = Number(el.getAttribute('aria-level')) || Number(tag.slice(1)) || undefined; }
		if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || role === 'slider' || role === 'combobox') {
			const value = el.isContentEditable ? el.innerText : el.value;
			if (value !== undefined && value !== '' && (tag !== 'select')) { node.value = clean(value, 200); }
			if (tag === 'select' && el.selectedOptions && el.selectedOptions.length) { node.value = clean([...el.selectedOptions].map(o => o.label).join(', ')); }
		}
		if (role === 'link' && el.getAttribute('href')) { node.url = el.getAttribute('href').slice(0, 200); }
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
	viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(doc.scrollTop), scrollHeight: doc.scrollHeight, scrollWidth: doc.scrollWidth },
};
})()`;
}

/** The full-page snapshot every action returns. */
export const SNAPSHOT_SCRIPT = snapshotScript();

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
const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el);
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
const picked = [];
for (const option of el.options) {
	const hit = wanted.includes(option.value) || wanted.includes(option.label) || wanted.includes(option.text.trim());
	option.selected = hit && (el.multiple || picked.length === 0);
	if (option.selected) { picked.push(option.label); }
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
