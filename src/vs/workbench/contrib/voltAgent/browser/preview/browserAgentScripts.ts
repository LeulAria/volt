/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IBrowserAssertion, IBrowserLocator } from '../../../../services/voltRuntime/common/tools/browserRun.js';
import { ROLE_HELPERS, RUNTIME } from './browserAutomationScripts.js';

/**
 * Page scripts behind `browser_run`, `browser_audit` and `browser_status`: semantic locators
 * (role + name, label, text, placeholder, test id, CSS), one-shot assertion checks the host polls,
 * and accessibility / layout / performance audits. They share the snapshot's role and name rules,
 * so a locator finds exactly what `browser_snapshot` shows, and they hand back refs from the same
 * table, so a ref from either keeps working.
 */
const LOCATE = `
const roleOf = el => {
	let r = (el.getAttribute('role') || '').split(' ')[0] || implicitRole(el);
	if (r === 'presentation' || r === 'none') { r = undefined; }
	if (!r && clickable(el)) { r = 'button'; }
	return r;
};
const norm = v => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim().toLowerCase();
const matcher = (want, exact) => {
	if (want === undefined || want === null) { return () => true; }
	const w = String(want);
	if (w.length > 2 && w[0] === '/' && w.lastIndexOf('/') > 0) {
		const end = w.lastIndexOf('/');
		try { const re = new RegExp(w.slice(1, end), w.slice(end + 1)); return v => re.test(String(v == null ? '' : v)); } catch { }
	}
	const n = norm(w);
	return exact ? v => norm(v) === n : v => norm(v).includes(n);
};
const shown = el => {
	if (!visible(el)) { return false; }
	for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
		const s = getComputedStyle(n);
		if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) { return false; }
	}
	return true;
};
const allElements = () => {
	const out = [];
	const collect = root => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) { collect(el.shadowRoot); } } };
	collect(document);
	return out;
};
const CONTROL = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton']);
const ownText = el => (el.innerText !== undefined ? el.innerText : el.textContent) || '';
const describe = el => {
	const role = roleOf(el);
	const name = role ? nameOf(el, role) : clean(ownText(el), 60);
	return (role || el.tagName.toLowerCase()) + (name ? ' "' + clean(name, 60) + '"' : '') + ' (ref ' + refOf(el) + ')';
};
const candidatesFor = (L) => {
	const exact = L.exact === true;
	let found = [];
	if (L.ref) {
		const el = byRef(L.ref);
		return { list: el ? [el] : [], stale: !el };
	}
	if (L.selector) {
		try { found = [...document.querySelectorAll(L.selector)]; } catch (e) { return { error: 'Invalid CSS selector ' + JSON.stringify(L.selector) }; }
	} else if (L.testId) {
		const v = CSS.escape(L.testId);
		found = [...document.querySelectorAll('[data-testid="' + v + '"],[data-test-id="' + v + '"],[data-test="' + v + '"],[data-qa="' + v + '"]')];
	} else if (L.role) {
		const want = L.role.toLowerCase();
		const name = matcher(L.name, exact);
		found = allElements().filter(el => roleOf(el) === want && name(nameOf(el, want) || el.getAttribute('title') || ''));
	} else if (L.label) {
		const name = matcher(L.label, exact);
		found = allElements().filter(el => {
			const role = roleOf(el);
			if (!role || !(CONTROL.has(role) || el.isContentEditable)) { return false; }
			const id = el.getAttribute('id');
			const label = (id && document.querySelector('label[for="' + CSS.escape(id) + '"]')) || el.closest('label');
			return name(el.getAttribute('aria-label') || labelledBy(el) || (label ? label.innerText : '') || '') || (!!label && name(label.innerText));
		});
	} else if (L.placeholder) {
		const name = matcher(L.placeholder, exact);
		found = [...document.querySelectorAll('[placeholder]')].filter(el => name(el.getAttribute('placeholder')));
	} else if (L.text) {
		const name = matcher(L.text, exact);
		const hits = allElements().filter(el => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HTML', 'HEAD', 'BODY'].includes(el.tagName) && name(ownText(el)));
		const set = new Set(hits);
		found = hits.filter(el => ![...el.querySelectorAll('*')].some(child => set.has(child)));
	} else {
		return { error: 'Empty locator: give ref, role (+ name), label, placeholder, text, testId or selector.' };
	}
	return { list: found };
};
const locate = (L, wantVisible) => {
	const got = candidatesFor(L);
	if (got.error || got.stale) { return got; }
	let list = got.list;
	if (wantVisible !== false) { list = list.filter(shown); }
	if (list.length > 1 && !L.exact && (L.name || L.text || L.label)) {
		const want = norm(L.name || L.text || L.label);
		const exactHits = list.filter(el => norm(L.role ? nameOf(el, L.role) : L.label ? (el.getAttribute('aria-label') || nameOf(el, roleOf(el))) : ownText(el)) === want);
		if (exactHits.length >= 1) { list = exactHits; }
	}
	return { list, total: got.list.length };
};
const pick = (L, wantVisible) => {
	const got = locate(L, wantVisible);
	if (got.error) { return { error: got.error }; }
	if (got.stale) { return { error: 'Ref ' + L.ref + ' is not on the page anymore; use a locator (role/name, label, text) or take a new snapshot.' }; }
	let list = got.list;
	if (typeof L.nth === 'number') {
		const i = L.nth < 0 ? list.length + L.nth : L.nth;
		list = list[i] ? [list[i]] : [];
	}
	if (!list.length) {
		const hidden = got.total > 0 ? ' (' + got.total + ' match' + (got.total > 1 ? 'es' : '') + ' but hidden)' : '';
		let near = [];
		if (L.role) {
			near = allElements().filter(el => roleOf(el) === L.role.toLowerCase() && shown(el)).slice(0, 8).map(describe);
		} else if (L.label || L.placeholder) {
			near = allElements().filter(el => { const r = roleOf(el); return r && CONTROL.has(r) && shown(el); }).slice(0, 8).map(describe);
		}
		return { error: 'No element matches' + hidden + '.' + (near.length ? ' Similar elements: ' + near.join('; ') : ''), count: 0 };
	}
	if (list.length > 1) {
		return { error: list.length + ' elements match; add exact: true, nth, or a more specific locator. Matches: ' + list.slice(0, 8).map(describe).join('; '), count: list.length };
	}
	const el = list[0];
	return { ref: refOf(el), count: 1, label: describe(el) };
};
`;

/** Resolves a locator to one element's ref, or an error naming what matched instead. */
export function locateScript(locator: IBrowserLocator): string {
	return `(() => {
${RUNTIME}
${ROLE_HELPERS}
${LOCATE}
return pick(${JSON.stringify(locator)}, true);
})()`;
}

/** Evaluates one assertion now: `{ ok, actual }`. The host polls it until it holds or times out. */
export function assertScript(assertion: IBrowserAssertion): string {
	return `(() => {
${RUNTIME}
${ROLE_HELPERS}
${LOCATE}
const A = ${JSON.stringify(assertion)};
const textMatch = (actual) => {
	const v = A.value;
	if (v === undefined || v === null) { return norm(actual).length > 0; }
	const m = A.match === 'equals' ? matcher(v, true) : A.match === 'regex' ? matcher('/' + v + '/', false) : matcher(v, false);
	return m(actual);
};
const one = () => {
	if (!A.target) { return { error: 'This assertion needs a target.' }; }
	const got = pick(A.target, true);
	if (got.error) { return { error: got.error }; }
	return { el: byRef(got.ref), label: got.label };
};
const val = el => el.isContentEditable ? el.innerText : ('value' in el ? el.value : (el.innerText || ''));
switch (A.expect) {
	case 'visible': {
		if (!A.target) { return { ok: false, actual: 'no target' }; }
		const got = locate(A.target, true);
		if (got.error || got.stale) { return { ok: false, actual: got.error || 'stale ref' }; }
		return { ok: got.list.length > 0, actual: got.list.length ? got.list.length + ' visible' : (got.total ? got.total + ' present but hidden' : 'not on the page') };
	}
	case 'hidden': {
		if (!A.target) { return { ok: false, actual: 'no target' }; }
		const got = locate(A.target, true);
		if (got.error) { return { ok: false, actual: got.error }; }
		return { ok: !got.stale && got.list.length === 0, actual: got.stale ? 'gone' : got.list.length + ' visible' };
	}
	case 'count': {
		const got = A.target ? locate(A.target, true) : { list: [] };
		if (got.error) { return { ok: false, actual: got.error }; }
		const n = got.stale ? 0 : got.list.length;
		const v = A.value;
		const ok = typeof v === 'number' ? n === v : v && typeof v === 'object' ? (v.min === undefined || n >= v.min) && (v.max === undefined || n <= v.max) : n > 0;
		return { ok, actual: String(n) };
	}
	case 'text': {
		if (!A.target) { const t = document.body ? document.body.innerText : ''; return { ok: textMatch(t), actual: clean(t, 300) }; }
		const got = one(); if (got.error) { return { ok: false, actual: got.error }; }
		const t = ownText(got.el) || val(got.el);
		return { ok: textMatch(t), actual: clean(t, 300) };
	}
	case 'value': {
		const got = one(); if (got.error) { return { ok: false, actual: got.error }; }
		const t = val(got.el);
		return { ok: textMatch(t), actual: clean(t, 300) };
	}
	case 'checked': case 'unchecked': {
		const got = one(); if (got.error) { return { ok: false, actual: got.error }; }
		const c = got.el.getAttribute('aria-checked') === 'true' || !!got.el.checked;
		return { ok: A.expect === 'checked' ? c : !c, actual: c ? 'checked' : 'unchecked' };
	}
	case 'enabled': case 'disabled': {
		const got = one(); if (got.error) { return { ok: false, actual: got.error }; }
		const d = !!got.el.disabled || got.el.getAttribute('aria-disabled') === 'true';
		return { ok: A.expect === 'disabled' ? d : !d, actual: d ? 'disabled' : 'enabled' };
	}
	case 'focused': {
		const got = one(); if (got.error) { return { ok: false, actual: got.error }; }
		const a = document.activeElement;
		return { ok: a === got.el || got.el.contains(a), actual: a ? describe(a) : 'nothing focused' };
	}
	case 'attribute': {
		const got = one(); if (got.error) { return { ok: false, actual: got.error }; }
		if (!A.name) { return { ok: false, actual: 'attribute needs name' }; }
		const has = got.el.getAttribute(A.name);
		return { ok: has !== null && (A.value === undefined || A.value === null || textMatch(has)), actual: has === null ? A.name + ' absent' : A.name + '=' + clean(has, 200) };
	}
	case 'css': {
		const got = one(); if (got.error) { return { ok: false, actual: got.error }; }
		if (!A.name) { return { ok: false, actual: 'css needs name (a property)' }; }
		const actual = getComputedStyle(got.el).getPropertyValue(A.name);
		return { ok: A.value === undefined || A.value === null ? !!actual : textMatch(actual), actual: A.name + ': ' + actual };
	}
	case 'url': return { ok: textMatch(location.href), actual: location.href };
	case 'title': return { ok: textMatch(document.title), actual: document.title };
	case 'no_overflow': {
		const doc = document.scrollingElement || document.documentElement;
		return { ok: doc.scrollWidth <= innerWidth + 1, actual: 'content ' + doc.scrollWidth + 'px wide in a ' + innerWidth + 'px viewport' };
	}
	default: return { ok: false, actual: 'Unknown expectation ' + JSON.stringify(A.expect) };
}
})()`;
}

export interface IAuditFinding {
	readonly rule: string;
	readonly severity: 'error' | 'warning' | 'info';
	readonly message: string;
	readonly ref?: string;
	readonly selector?: string;
}

export interface IAuditPage {
	readonly url: string;
	readonly width: number;
	readonly height: number;
	readonly findings: IAuditFinding[];
	readonly overflow?: { readonly scrollWidth: number; readonly culprits: { ref: string; selector: string; right: number; width: number; why: string }[] };
	readonly perf?: Record<string, number | string | undefined>;
}

/** Accessibility, layout and performance findings for the current page (or a subtree). */
export function auditScript(options: { checks: readonly string[]; scope?: string }): string {
	return `(async () => {
${RUNTIME}
${ROLE_HELPERS}
${LOCATE}
const CHECKS = new Set(${JSON.stringify(options.checks)});
const SCOPE = ${JSON.stringify(options.scope ?? null)};
const root = SCOPE ? document.querySelector(SCOPE) : document.body;
if (!root) { return { error: 'No element matches ' + SCOPE }; }
const findings = [];
const add = (rule, severity, message, el) => { if (findings.length < 120) { findings.push({ rule, severity, message, ref: el ? refOf(el) : undefined, selector: el ? cssPath(el) : undefined }); } };
function cssPath(el) {
	if (el.id) { return '#' + CSS.escape(el.id); }
	const parts = [];
	for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
		let part = n.tagName.toLowerCase();
		if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
		const cls = typeof n.className === 'string' ? n.className.trim().split(' ').filter(Boolean)[0] : '';
		if (cls) { part += '.' + CSS.escape(cls); }
		parts.unshift(part);
	}
	return parts.join(' > ');
}
const els = [...root.querySelectorAll('*')].filter(el => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK'].includes(el.tagName));
const parse = c => { const m = String(c).match(/[\\d.]+/g) || []; return m.map(Number); };
const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
// The same colour moved toward black (light backgrounds) or white (dark ones) just far enough to pass.
const passing = (fg, bg, need) => { const toward = lum(bg) > 0.18 ? [0, 0, 0] : [255, 255, 255]; for (let t = 0.02; t < 1; t += 0.02) { const c = fg.map((v, i) => v + (toward[i] - v) * t); if (ratio(c, bg) >= need + 0.05) { return hex(c); } } return hex(toward); };
const bgOf = el => {
	for (let n = el; n; n = n.parentElement) {
		const s = getComputedStyle(n);
		if (s.backgroundImage && s.backgroundImage !== 'none') { return null; }
		const c = parse(s.backgroundColor);
		if (c.length >= 3 && (c.length < 4 || c[3] > 0.5)) { return c.slice(0, 3); }
	}
	return [255, 255, 255];
};
const out = { url: location.href, width: innerWidth, height: innerHeight, findings };
if (CHECKS.has('a11y')) {
	if (!document.documentElement.getAttribute('lang')) { add('lang', 'warning', 'The <html> element has no lang attribute (screen readers guess the language).'); }
	if (!document.title.trim()) { add('title', 'warning', 'The document has no <title>.'); }
	const ids = new Map();
	let lastLevel = 0, sawH1 = false, contrastCount = 0;
	for (const el of els) {
		if (el.id) { ids.set(el.id, (ids.get(el.id) || 0) + 1); }
		if (!shown(el)) { continue; }
		const role = roleOf(el);
		const tag = el.tagName.toLowerCase();
		if (role && INTERACTIVE.has(role)) {
			const name = nameOf(el, role) || clean(el.getAttribute('title'));
			const isField = CONTROL.has(role) || el.isContentEditable;
			if (!name) {
				add('name', 'error', (isField ? 'Form field' : role) + ' has no accessible name' + (tag === 'button' && el.querySelector('svg') ? ' (icon-only button: add aria-label)' : '') + '.', el);
			} else if (isField && !el.getAttribute('aria-label') && !labelledBy(el)) {
				const id = el.getAttribute('id');
				const label = (id && document.querySelector('label[for="' + CSS.escape(id) + '"]')) || el.closest('label');
				if (!label && el.getAttribute('placeholder')) { add('label', 'warning', 'Field "' + clean(el.getAttribute('placeholder'), 40) + '" is labelled only by its placeholder, which disappears while typing; add a <label>.', el); }
			}
			const r = el.getBoundingClientRect();
			if ((r.width < 24 || r.height < 24) && tag !== 'a' && r.width > 0) { add('target-size', 'info', role + ' "' + clean(name, 30) + '" is ' + Math.round(r.width) + '×' + Math.round(r.height) + 'px; 24×24 is the minimum target size (WCAG 2.5.8).', el); }
		}
		if (tag === 'img' && !el.hasAttribute('alt')) { add('alt', 'error', 'Image without alt text: ' + clean(el.getAttribute('src'), 60), el); }
		if (role === 'heading') {
			const level = Number(el.getAttribute('aria-level')) || Number(tag.slice(1)) || 2;
			if (level === 1) { sawH1 = true; }
			if (lastLevel && level > lastLevel + 1) { add('heading-order', 'info', 'Heading level jumps from h' + lastLevel + ' to h' + level + '.', el); }
			lastLevel = level;
		}
		const tabindex = Number(el.getAttribute('tabindex'));
		if (tabindex > 0) { add('tabindex', 'warning', 'tabindex=' + tabindex + ' changes the natural focus order.', el); }
		const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
		if (hasText && contrastCount < 25) {
			const s = getComputedStyle(el);
			const fg = parse(s.color);
			const bg = bgOf(el);
			if (bg && fg.length >= 3 && (fg.length < 4 || fg[3] > 0.5)) {
				const size = parseFloat(s.fontSize);
				const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
				const need = large ? 3 : 4.5;
				const got = ratio(fg.slice(0, 3), bg);
				if (got < need) { contrastCount++; add('contrast', 'error', 'Text "' + clean(el.textContent, 40) + '" has contrast ' + got.toFixed(2) + ':1 (' + hex(fg.slice(0, 3)) + ' on ' + hex(bg) + '); needs ' + need + ':1. Nearest passing colour: ' + passing(fg.slice(0, 3), bg, need) + '.', el); }
			}
		}
		const hint = ((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '')).toLowerCase();
		if (/(^|[ _-])(message|error|alert|status|toast|notice|feedback)([ _-]|$)/.test(hint) && !el.closest('[role=alert],[role=status],[aria-live]') && !['button', 'a', 'input'].includes(tag)) {
			add('live-region', 'warning', 'Looks like a status/error message area but is not announced to screen readers (add role="status", role="alert" or aria-live).', el);
		}
	}
	for (const [id, n] of ids) { if (n > 1) { add('duplicate-id', 'warning', 'id "' + id + '" is used ' + n + ' times.'); } }
	if (!sawH1 && !SCOPE) { add('heading-order', 'info', 'The page has no h1.'); }
}
if (CHECKS.has('layout')) {
	const doc = document.scrollingElement || document.documentElement;
	if (doc.scrollWidth > innerWidth + 1) {
		const over = els.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed'; });
		const set = new Set(over);
		const roots = over.filter(el => !set.has(el.parentElement));
		const culprits = roots.slice(0, 6).map(el => {
			const s = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			const why = [];
			if (s.minWidth && s.minWidth !== '0px' && s.minWidth !== 'auto') { why.push('min-width: ' + s.minWidth); }
			if (/px$/.test(el.style.width || '') || (s.width && parseFloat(s.width) > innerWidth)) { why.push('width: ' + s.width); }
			if (s.whiteSpace === 'nowrap' || s.whiteSpace === 'pre') { why.push('white-space: ' + s.whiteSpace); }
			if (s.flexShrink === '0') { why.push('flex-shrink: 0'); }
			if (s.display.includes('grid') && /px/.test(s.gridTemplateColumns)) { why.push('grid-template-columns: ' + s.gridTemplateColumns.slice(0, 60)); }
			const kids = [...el.children].filter(c => set.has(c)).length;
			if (!why.length && kids) { why.push(kids + ' child element(s) overflow'); }
			return { ref: refOf(el), selector: cssPath(el), right: Math.round(r.right), width: Math.round(r.width), why: why.join(', ') || 'content wider than the viewport' };
		});
		out.overflow = { scrollWidth: doc.scrollWidth, culprits };
		add('overflow', 'error', 'Page is ' + doc.scrollWidth + 'px wide in a ' + innerWidth + 'px viewport (horizontal scroll).');
	}
	for (const el of els) {
		const s = getComputedStyle(el);
		if ((s.overflowX === 'hidden' || s.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && shown(el) && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) {
			add('clipped-text', 'info', 'Text "' + clean(el.textContent, 40) + '" is cut off (' + el.scrollWidth + 'px of content in ' + el.clientWidth + 'px).', el);
		}
	}
}
if (CHECKS.has('perf')) {
	const nav = performance.getEntriesByType('navigation')[0];
	const observe = type => new Promise(resolve => { try { new PerformanceObserver(list => resolve(list.getEntries())).observe({ type, buffered: true }); } catch { resolve([]); } setTimeout(() => resolve([]), 150); });
	const [lcp, shifts, longtasks] = await Promise.all([observe('largest-contentful-paint'), observe('layout-shift'), observe('longtask')]);
	const resources = performance.getEntriesByType('resource');
	const bytes = resources.reduce((sum, e) => sum + (e.transferSize || 0), 0) + (nav ? nav.transferSize || 0 : 0);
	out.perf = {
		ttfbMs: nav ? Math.round(nav.responseStart) : undefined,
		domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : undefined,
		loadMs: nav ? Math.round(nav.loadEventEnd) : undefined,
		lcpMs: lcp.length ? Math.round(lcp[lcp.length - 1].startTime) : undefined,
		cls: shifts.length ? Number(shifts.filter(e => !e.hadRecentInput).reduce((s, e) => s + e.value, 0).toFixed(3)) : 0,
		longTasks: longtasks.length,
		domNodes: document.getElementsByTagName('*').length,
		requests: resources.length + 1,
		transferKB: Math.round(bytes / 1024),
		jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : undefined,
	};
	if (out.perf.lcpMs > 2500) { add('lcp', 'warning', 'Largest contentful paint at ' + out.perf.lcpMs + ' ms (good is under 2500).'); }
	if (out.perf.cls > 0.1) { add('cls', 'warning', 'Cumulative layout shift ' + out.perf.cls + ' (good is under 0.1).'); }
	if (out.perf.domNodes > 1500) { add('dom-size', 'info', out.perf.domNodes + ' DOM elements (large DOMs slow every update).'); }
}
return out;
})()`;
}

export interface IPageStatus {
	readonly url: string;
	readonly title: string;
	readonly readyState: string;
	readonly viewport: { width: number; height: number; scrollY: number; scrollHeight: number; scrollWidth: number };
	readonly focused?: string;
	readonly dialogs: string[];
	readonly interactive: number;
	readonly forms: number;
	readonly failedRequests: number;
}

export const STATUS_SCRIPT = `(() => {
${RUNTIME}
${ROLE_HELPERS}
${LOCATE}
const doc = document.scrollingElement || document.documentElement;
const dialogs = [...document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]')].filter(shown).slice(0, 4).map(describe);
const a = document.activeElement;
return {
	url: location.href,
	title: document.title,
	readyState: document.readyState,
	viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(doc.scrollTop), scrollHeight: doc.scrollHeight, scrollWidth: doc.scrollWidth },
	focused: a && a !== document.body ? describe(a) : undefined,
	dialogs,
	interactive: allElements().filter(el => { const r = roleOf(el); return r && INTERACTIVE.has(r) && shown(el); }).length,
	forms: document.forms.length,
	failedRequests: S.net.length,
};
})()`;

/** How many fetch/XHR failures the page recorded so far (to report only the ones a run caused). */
export const NET_MARK_SCRIPT = `(() => {
${RUNTIME}
return S.net.length;
})()`;

export function netSinceScript(mark: number): string {
	return `(() => {
${RUNTIME}
return S.net.slice(${Math.max(0, Math.floor(mark))});
})()`;
}
