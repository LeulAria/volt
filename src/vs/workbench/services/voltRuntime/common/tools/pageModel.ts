/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The agent's model of a page in the in-app browser: the accessibility tree flattened in document
 * order, rendered compactly, and diffed against what the agent saw last so an action reports only
 * what it changed. Pure: the page scripts collect the nodes, this decides what the model reads.
 */

/** One node of the page's role tree, in document order. */
export interface IPageNode {
	/** Elements carry a ref (`e12`), stable for the life of the document. Text runs do not. */
	readonly ref?: string;
	readonly role: string;
	readonly name?: string;
	/** Depth in the role tree: wrappers without a role are flattened away. */
	readonly depth: number;
	/** Ref of the nearest ancestor node with one (`root` at the top). */
	readonly parent?: string;
	readonly level?: number;
	readonly value?: string;
	readonly url?: string;
	readonly states?: readonly string[];
}

export interface IPageView {
	/** A new id for every document: refs from another document name nothing here. */
	readonly doc: string;
	readonly url: string;
	readonly title: string;
	readonly nodes: readonly IPageNode[];
	readonly truncated?: boolean;
}

export interface IPageNodeChange {
	readonly before: IPageNode;
	readonly after: IPageNode;
}

export interface IPageDiff {
	/** New nodes, in document order. */
	readonly added: readonly IPageNode[];
	/** Nodes that went away, outermost only (their descendants went with them). */
	readonly removed: readonly IPageNode[];
	readonly changed: readonly IPageNodeChange[];
	readonly unchanged: number;
}

/** `button "Save" [disabled] [ref=e12]`, `textbox "Email" [ref=e3]: "a@b.co"`, `text: Saved`. */
export function formatPageNode(node: IPageNode): string {
	if (node.role === 'text') {
		return `text: ${node.name ?? ''}`;
	}
	let line = node.role;
	if (node.name) {
		line += ` ${JSON.stringify(node.name)}`;
	}
	if (node.level) {
		line += ` [level=${node.level}]`;
	}
	for (const state of node.states ?? []) {
		line += ` [${state}]`;
	}
	if (node.ref) {
		line += ` [ref=${node.ref}]`;
	}
	if (node.url) {
		line += ` -> ${node.url}`;
	}
	if (node.value !== undefined && node.value !== '') {
		line += `: ${JSON.stringify(node.value)}`;
	}
	return line;
}

/** Roles that come in long runs of look-alikes: table rows, list items, options, feed cards, links. */
const FOLDABLE = new Set(['row', 'listitem', 'option', 'article', 'treeitem', 'menuitem', 'link', 'gridcell', 'tab', 'radio', 'checkbox']);
/** A run of at least this many like siblings shows its first `FOLD_HEAD` and last `FOLD_TAIL` only. */
const FOLD_MIN = 14;
const FOLD_HEAD = 8;
const FOLD_TAIL = 2;

interface IFoldPlan {
	/** Nodes left out (a folded sibling and everything under it). */
	readonly hidden: Uint8Array;
	/** At the first folded sibling of a run: the line that stands in for the run. */
	readonly markers: Map<number, string>;
}

function plural(role: string, count: number): string {
	return count === 1 ? role : role.endsWith('x') ? `${role}es` : `${role}s`;
}

/**
 * Which nodes to fold: runs of `FOLD_MIN`+ siblings with the same role keep their head and tail,
 * and the middle becomes one line saying how many were left out. A 300-row table reads as ten
 * rows and a count; the rows are still on the page for locators, diffs and selectors.
 */
function foldPlan(nodes: readonly IPageNode[]): IFoldPlan {
	const n = nodes.length;
	const hidden = new Uint8Array(n);
	const markers = new Map<number, string>();
	// Where each node's subtree ends (exclusive): nodes are in document order with their depth.
	const end = new Int32Array(n);
	const open: number[] = [];
	for (let i = 0; i < n; i++) {
		while (open.length && nodes[open[open.length - 1]].depth >= nodes[i].depth) {
			end[open.pop()!] = i;
		}
		open.push(i);
	}
	while (open.length) {
		end[open.pop()!] = n;
	}
	const siblings = new Map<string, number[]>();
	for (let i = 0; i < n; i++) {
		const key = `${nodes[i].parent ?? ''}@${nodes[i].depth}`;
		let group = siblings.get(key);
		if (!group) {
			siblings.set(key, group = []);
		}
		group.push(i);
	}
	for (const group of siblings.values()) {
		let start = 0;
		for (let k = 1; k <= group.length; k++) {
			if (k < group.length && nodes[group[k]].role === nodes[group[start]].role) {
				continue;
			}
			const run = group.slice(start, k);
			const role = nodes[run[0]].role;
			if (run.length >= FOLD_MIN && FOLDABLE.has(role)) {
				const folded = run.slice(FOLD_HEAD, run.length - FOLD_TAIL);
				for (const index of folded) {
					hidden.fill(1, index, end[index]);
				}
				markers.set(folded[0], `…${folded.length} more ${plural(role, folded.length)} like these (folded: act on them by their text, or browser_snapshot with a selector or unfold: true)`);
			}
			start = k;
		}
	}
	return { hidden, markers };
}

/** Indented outline lines for nodes in document order, with long runs folded unless `unfold`. */
function outline(nodes: readonly IPageNode[], unfold: boolean | undefined, prefix = '', base = 0): string[] {
	const plan = unfold ? undefined : foldPlan(nodes);
	const lines: string[] = [];
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		const indent = '  '.repeat(Math.max(0, node.depth - base));
		const marker = plan?.markers.get(i);
		if (marker) {
			lines.push(`${prefix}${indent}- ${marker}`);
		}
		if (plan?.hidden[i]) {
			continue;
		}
		const parent = i + 1 < nodes.length && nodes[i + 1].depth > node.depth && nodes[i + 1].parent === node.ref;
		lines.push(`${prefix}${indent}- ${formatPageNode(node)}${parent ? ':' : ''}`);
	}
	return lines;
}

/** The whole page as an indented outline, one node per line (Playwright's aria snapshot shape). */
export function renderPage(view: IPageView, options?: { readonly unfold?: boolean }): string[] {
	const lines = outline(view.nodes, options?.unfold);
	if (!lines.length) {
		lines.push('- (the page shows nothing yet)');
	}
	if (view.truncated) {
		lines.push(`# stopped at ${view.nodes.length} nodes: pass a selector to browser_snapshot to read the rest`);
	}
	return lines;
}

/** Ref'd nodes by ref; text runs by where they sit and what they say (repeats counted). */
function keyed(nodes: readonly IPageNode[]): Map<string, IPageNode> {
	const map = new Map<string, IPageNode>();
	const seen = new Map<string, number>();
	for (const node of nodes) {
		if (node.ref) {
			map.set(`#${node.ref}`, node);
			continue;
		}
		const base = `${node.parent ?? ''}|${node.role}|${node.name ?? ''}`;
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		map.set(`${base}|${n}`, node);
	}
	return map;
}

function signature(node: IPageNode): string {
	return JSON.stringify([node.role, node.name ?? '', node.value ?? '', node.states ?? [], node.level ?? 0, node.url ?? '']);
}

/** What changed between two views of the same document. Refs are stable, so moves are not changes. */
export function diffPage(before: IPageView, after: IPageView): IPageDiff {
	const old = keyed(before.nodes);
	const added: IPageNode[] = [];
	const changed: IPageNodeChange[] = [];
	let unchanged = 0;
	for (const [key, node] of keyed(after.nodes)) {
		const previous = old.get(key);
		if (!previous) {
			added.push(node);
			continue;
		}
		old.delete(key);
		if (signature(previous) === signature(node)) {
			unchanged++;
		} else {
			changed.push({ before: previous, after: node });
		}
	}
	const gone = new Set<string>();
	for (const node of old.values()) {
		if (node.ref) {
			gone.add(node.ref);
		}
	}
	const removed = [...old.values()].filter(node => !node.parent || !gone.has(node.parent));
	return { added, removed, changed, unchanged };
}

function describeChange(change: IPageNodeChange): string {
	const { before, after } = change;
	const parts: string[] = [];
	if ((before.name ?? '') !== (after.name ?? '')) {
		parts.push(`name was ${JSON.stringify(before.name ?? '')}`);
	}
	if ((before.value ?? '') !== (after.value ?? '')) {
		parts.push(before.value ? `value was ${JSON.stringify(before.value)}` : 'was empty');
	}
	const was = before.states ?? [];
	const now = after.states ?? [];
	const lost = was.filter(state => !now.includes(state));
	const gained = now.filter(state => !was.includes(state));
	if (lost.length || gained.length) {
		parts.push(lost.length ? `was ${lost.join(', ')}` : `newly ${gained.join(', ')}`);
	}
	if ((before.url ?? '') !== (after.url ?? '')) {
		parts.push(`url was ${before.url ?? '(none)'}`);
	}
	return parts.length ? ` (${parts.join('; ')})` : '';
}

const MAX_REMOVED_LISTED = 24;
const MAX_CHANGED_LISTED = 40;

/** The diff as lines the model reads: changed in place, added with their container, removed in brief. */
export function formatPageDiff(diff: IPageDiff, after: IPageView): string[] {
	const lines: string[] = [];
	const byRef = new Map<string, IPageNode>();
	for (const node of after.nodes) {
		if (node.ref) {
			byRef.set(node.ref, node);
		}
	}
	for (const change of diff.changed.slice(0, MAX_CHANGED_LISTED)) {
		lines.push(`~ ${formatPageNode(change.after)}${describeChange(change)}`);
	}
	if (diff.changed.length > MAX_CHANGED_LISTED) {
		lines.push(`~ …${diff.changed.length - MAX_CHANGED_LISTED} more changed`);
	}
	if (diff.added.length) {
		// Added nodes in runs under the container they appeared in; long runs fold like the full page.
		const addedRefs = new Set(diff.added.map(node => node.ref).filter((ref): ref is string => !!ref));
		let run: IPageNode[] = [];
		let context: string | undefined;
		const flush = () => {
			if (run.length) {
				lines.push(...outline(run, false, '+   ', run[0].depth));
				run = [];
			}
		};
		for (const node of diff.added) {
			const top = !node.parent || !addedRefs.has(node.parent);
			if (top) {
				const container = node.parent && node.parent !== 'root' ? byRef.get(node.parent) : undefined;
				const where = container ? `in ${formatPageNode(container)}` : 'at the top level';
				if (where !== context || (run.length && node.depth !== run[0].depth)) {
					flush();
					if (where !== context) {
						lines.push(`+ ${where}:`);
						context = where;
					}
				}
			}
			run.push(node);
		}
		flush();
	}
	if (diff.removed.length) {
		const listed = diff.removed.slice(0, MAX_REMOVED_LISTED).map(formatPageNode);
		const more = diff.removed.length - listed.length;
		lines.push(`- removed: ${listed.join('; ')}${more > 0 ? `; …${more} more` : ''}`);
	}
	return lines;
}

export type PageObservationKind = 'full' | 'diff' | 'same';

export interface IPageObservation {
	readonly kind: PageObservationKind;
	readonly lines: readonly string[];
}

/**
 * What the agent should read after an action: the whole page when it has not seen this document,
 * only the changes when it has, and the whole page again when the changes are most of it.
 */
export function observePage(previous: IPageView | undefined, next: IPageView, force?: 'full', unfold?: boolean): IPageObservation {
	const page = () => renderPage(next, { unfold });
	const full = (lines = page()): IPageObservation => ({ kind: 'full', lines: ['- Page Snapshot:', '```yaml', ...lines, '```'] });
	if (force === 'full' || !previous || previous.doc !== next.doc) {
		return full();
	}
	const diff = diffPage(previous, next);
	if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
		return { kind: 'same', lines: ['- Page: unchanged since your last view of it.'] };
	}
	const changes = formatPageDiff(diff, next);
	if (changes.length > 40) {
		const whole = page();
		if (changes.length > whole.length * 0.6) {
			return full(whole);
		}
	}
	return {
		kind: 'diff',
		lines: [`- Page changes since your last view (${diff.unchanged} nodes unchanged; + added, ~ changed, - removed):`, '```yaml', ...changes, '```'],
	};
}

//#region Locators, expectations and steps (`browser_act`)

/** Finds an element by meaning instead of by a ref from an earlier snapshot. */
export interface IPageLocator {
	readonly ref?: string;
	readonly role?: string;
	readonly name?: string;
	readonly text?: string;
	readonly label?: string;
	readonly placeholder?: string;
	readonly selector?: string;
	/** Among several equally good matches, pick this one (0-based, negative counts from the end). */
	readonly nth?: number;
	/** Name, text or label must match in full (case and spacing ignored) instead of as a part. */
	readonly exact?: boolean;
	/** Only inside the container (row, list item, card, form, dialog) of this element. */
	readonly within?: IPageLocator;
}

/** Refs from the browser (`e12`), a device screen (`d4`) and the desktop (`a7`). */
export const REF_RE = /^[eda]\d+$/;

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * A locator from what the agent wrote: `"e12"` (a ref), `"Sign in"` (visible text), or an object
 * with ref / role + name / text / label / placeholder / selector, nth, exact and within.
 */
export function parseLocator(value: unknown, depth = 0): IPageLocator | undefined {
	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) {
			return undefined;
		}
		return REF_RE.test(text) ? { ref: text } : { text };
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const locator: IPageLocator = {
		ref: str(raw.ref),
		role: str(raw.role)?.toLowerCase(),
		name: str(raw.name),
		text: str(raw.text),
		label: str(raw.label),
		placeholder: str(raw.placeholder),
		selector: str(raw.selector),
		nth: num(raw.nth) !== undefined ? Math.trunc(num(raw.nth)!) : undefined,
		exact: raw.exact === true ? true : undefined,
		within: depth < 2 ? parseLocator(raw.within, depth + 1) : undefined,
	};
	if (!locator.ref && !locator.role && !locator.text && !locator.label && !locator.placeholder && !locator.selector) {
		// A bare name means visible text.
		return locator.name ? compact({ ...locator, text: locator.name, name: undefined }) : undefined;
	}
	return compact(locator);
}

function compact<T extends object>(value: T): T {
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) {
			out[key] = item;
		}
	}
	return out as T;
}

/** How a locator reads in a result line: `button "Save"`, `text "Sign in"`, `e12`. */
export function describeLocator(locator: IPageLocator): string {
	const parts: string[] = [];
	if (locator.ref) {
		parts.push(locator.ref);
	}
	if (locator.role) {
		parts.push(locator.name ? `${locator.role} ${JSON.stringify(locator.name)}` : locator.role);
	}
	if (locator.text) {
		parts.push(`text ${JSON.stringify(locator.text)}`);
	}
	if (locator.label) {
		parts.push(`label ${JSON.stringify(locator.label)}`);
	}
	if (locator.placeholder) {
		parts.push(`placeholder ${JSON.stringify(locator.placeholder)}`);
	}
	if (locator.selector) {
		parts.push(`selector ${JSON.stringify(locator.selector)}`);
	}
	if (locator.nth !== undefined) {
		parts.push(`#${locator.nth}`);
	}
	if (locator.within) {
		parts.push(`within ${describeLocator(locator.within)}`);
	}
	return parts.join(' ') || '(no target)';
}

export type PageElementState = 'visible' | 'hidden' | 'enabled' | 'disabled' | 'checked' | 'unchecked' | 'focused' | 'expanded' | 'collapsed' | 'selected';

const ELEMENT_STATES: readonly PageElementState[] = ['visible', 'hidden', 'enabled', 'disabled', 'checked', 'unchecked', 'focused', 'expanded', 'collapsed', 'selected'];

/** A postcondition the page must meet. All the given parts must hold. */
export interface IPageExpectation {
	/** Text in the URL, or `/regex/flags`. */
	readonly url?: string;
	readonly title?: string;
	/** Visible text on the page (case and spacing ignored). */
	readonly text?: string;
	readonly textGone?: string;
	readonly target?: IPageLocator;
	/** With `target`: the element's state. Default `visible`. */
	readonly state?: PageElementState;
	/** With `target`: its value (inputs) or text, in full. */
	readonly value?: string;
	/** With `target`: how many visible elements match. */
	readonly count?: number;
}

export function parseExpectation(value: unknown): IPageExpectation | string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === 'string') {
		return value.trim() ? { text: value.trim() } : undefined;
	}
	if (typeof value !== 'object' || Array.isArray(value)) {
		return 'expect must be an object like {"text": "Saved"} or {"url": "/dashboard"}';
	}
	const raw = value as Record<string, unknown>;
	const state = str(raw.state)?.toLowerCase();
	if (state && !(ELEMENT_STATES as readonly string[]).includes(state)) {
		return `expect.state must be one of ${ELEMENT_STATES.join(', ')}`;
	}
	const target = parseLocator(raw.target ?? raw.ref);
	const expectation: IPageExpectation = compact({
		url: str(raw.url),
		title: str(raw.title),
		text: str(raw.text),
		textGone: str(raw.textGone ?? raw.text_gone),
		target,
		state: state as PageElementState | undefined,
		value: typeof raw.value === 'string' ? raw.value : undefined,
		count: num(raw.count),
	});
	if ((expectation.state || expectation.value !== undefined || expectation.count !== undefined) && !target) {
		return 'expect.state, expect.value and expect.count need expect.target';
	}
	if (!expectation.url && !expectation.title && !expectation.text && !expectation.textGone && !expectation.target) {
		return 'expect needs url, title, text, textGone or target';
	}
	return expectation;
}

export function describeExpectation(expectation: IPageExpectation): string {
	const parts: string[] = [];
	if (expectation.url) {
		parts.push(`url ~ ${JSON.stringify(expectation.url)}`);
	}
	if (expectation.title) {
		parts.push(`title ~ ${JSON.stringify(expectation.title)}`);
	}
	if (expectation.text) {
		parts.push(`text ${JSON.stringify(expectation.text)}`);
	}
	if (expectation.textGone) {
		parts.push(`no text ${JSON.stringify(expectation.textGone)}`);
	}
	if (expectation.target) {
		const what = [expectation.count !== undefined ? `count ${expectation.count}` : undefined, expectation.value !== undefined ? `value ${JSON.stringify(expectation.value)}` : undefined, expectation.state ?? (expectation.count === undefined && expectation.value === undefined ? 'visible' : undefined)].filter(Boolean).join(', ');
		parts.push(`${describeLocator(expectation.target)} ${what}`);
	}
	return parts.join(' and ');
}

export type ActStepAction = 'navigate' | 'click' | 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'hover' | 'scroll' | 'wait' | 'expect' | 'back' | 'reload' | 'flow' | 'menu';

const ACTION_ALIASES: Readonly<Record<string, ActStepAction>> = {
	goto: 'navigate', open: 'navigate', visit: 'navigate',
	tap: 'click', dblclick: 'click', double_click: 'click', doubleclick: 'click', right_click: 'click',
	fill: 'type', input: 'type', enter: 'type',
	key: 'press', press_key: 'press', keypress: 'press',
	select_option: 'select', choose: 'select',
	assert: 'expect', verify: 'expect', wait_for: 'wait', sleep: 'wait',
	go_back: 'back', navigate_back: 'back', refresh: 'reload',
};

const ACTIONS: readonly ActStepAction[] = ['navigate', 'click', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll', 'wait', 'expect', 'back', 'reload', 'flow', 'menu'];

export interface IActStep {
	readonly action: ActStepAction;
	readonly target?: IPageLocator;
	readonly url?: string;
	readonly text?: string;
	readonly key?: string;
	readonly values?: readonly string[];
	readonly submit?: boolean;
	readonly clear?: boolean;
	readonly double?: boolean;
	readonly button?: 'left' | 'right' | 'middle';
	readonly deltaX?: number;
	readonly deltaY?: number;
	/** scroll: keep scrolling (up to 10 times) until this element shows. */
	readonly until?: IPageLocator;
	readonly ms?: number;
	/** Checked after the step; the step fails when it does not hold in time. */
	readonly expect?: IPageExpectation;
	/** How long to wait for the target to appear and become usable, and for `expect`. */
	readonly timeoutMs?: number;
	/** Keep going when this step fails. */
	readonly optional?: boolean;
	/** flow: the saved flow to run here, and the values of its `${name}` placeholders. */
	readonly flow?: string;
	readonly vars?: Readonly<Record<string, string>>;
}

export const MAX_ACT_STEPS = 30;

/** Steps that change the page (as opposed to waiting and checking). */
export function isActingStep(step: IActStep): boolean {
	return step.action !== 'wait' && step.action !== 'expect';
}

/** Validates the agent's steps up front, so a typo fails before anything runs. */
export function parseActSteps(value: unknown): { readonly steps: readonly IActStep[] } | { readonly error: string } {
	if (!Array.isArray(value) || !value.length) {
		return { error: 'browser_act needs `steps`: a non-empty array like [{"action":"click","target":{"role":"button","name":"Save"}}].' };
	}
	if (value.length > MAX_ACT_STEPS) {
		return { error: `browser_act runs at most ${MAX_ACT_STEPS} steps per call; split the task.` };
	}
	const steps: IActStep[] = [];
	for (let i = 0; i < value.length; i++) {
		const parsed = parseStep(value[i]);
		if (typeof parsed === 'string') {
			return { error: `Step ${i + 1}: ${parsed}` };
		}
		steps.push(parsed);
	}
	return { steps };
}

function parseStep(value: unknown): IActStep | string {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return 'each step is an object with an `action`.';
	}
	const raw = value as Record<string, unknown>;
	const name = str(raw.action)?.toLowerCase().replace(/[\s-]+/g, '_') ?? '';
	const action = (ACTIONS as readonly string[]).includes(name) ? name as ActStepAction : ACTION_ALIASES[name];
	if (!action) {
		return `unknown action ${JSON.stringify(raw.action ?? '')}; use one of ${ACTIONS.join(', ')}.`;
	}
	const target = parseLocator(raw.target ?? raw.ref ?? raw.element_ref);
	const expectation = parseExpectation(raw.expect);
	if (typeof expectation === 'string') {
		return expectation;
	}
	const values = Array.isArray(raw.values) ? raw.values.map(item => String(item)) : typeof raw.value === 'string' ? [raw.value] : undefined;
	const button = raw.button === 'right' || raw.button === 'middle' ? raw.button : name === 'right_click' ? 'right' : undefined;
	const step: IActStep = compact({
		action,
		target,
		url: str(raw.url),
		text: typeof raw.text === 'string' ? raw.text : typeof raw.value === 'string' && action === 'type' ? raw.value : undefined,
		key: str(raw.key),
		values: action === 'select' ? values : action === 'menu' ? (Array.isArray(raw.path) ? raw.path.map(item => String(item)) : typeof raw.path === 'string' ? raw.path.split('>').map(item => item.trim()).filter(Boolean) : values) : undefined,
		submit: raw.submit === true ? true : undefined,
		clear: raw.clear === false ? false : undefined,
		double: raw.double === true || raw.doubleClick === true || name === 'dblclick' || name === 'double_click' || name === 'doubleclick' ? true : undefined,
		button,
		deltaY: num(raw.deltaY ?? raw.dy) ?? (raw.direction === 'up' ? -600 : raw.direction === 'down' ? 600 : undefined),
		deltaX: num(raw.deltaX ?? raw.dx) ?? (raw.direction === 'left' ? -600 : raw.direction === 'right' ? 600 : undefined),
		until: parseLocator(raw.until),
		ms: num(raw.ms) ?? (num(raw.seconds) !== undefined ? num(raw.seconds)! * 1000 : undefined),
		expect: expectation,
		timeoutMs: num(raw.timeoutMs ?? raw.timeout_ms) !== undefined ? Math.max(0, Math.min(30_000, num(raw.timeoutMs ?? raw.timeout_ms)!)) : undefined,
		optional: raw.optional === true ? true : undefined,
		flow: action === 'flow' ? str(raw.flow ?? raw.name) : undefined,
		vars: action === 'flow' && raw.vars && typeof raw.vars === 'object' ? Object.fromEntries(Object.entries(raw.vars as Record<string, unknown>).map(([key, value]) => [key, String(value)])) : undefined,
	});
	switch (action) {
		case 'flow':
			return step.flow ? step : 'flow needs `flow` (the saved flow\'s name).';
		case 'menu':
			return step.values?.length ? step : 'menu needs `path`, e.g. ["File", "Save As…"].';
		case 'navigate':
			return step.url ? step : 'navigate needs `url`.';
		case 'click':
		case 'hover':
		case 'check':
		case 'uncheck':
			return step.target ? step : `${action} needs \`target\` (a ref like "e12", visible text, or {"role":"button","name":"Save"}).`;
		case 'type':
			return !step.target ? 'type needs `target` (e.g. {"label":"Email"}).' : step.text === undefined ? 'type needs `text`.' : step;
		case 'select':
			return !step.target ? 'select needs `target`.' : !step.values?.length ? 'select needs `values` (option labels or values).' : step;
		case 'press':
			return step.key ? step : 'press needs `key` (e.g. "Enter", "Escape", "Meta+a").';
		case 'wait': {
			// A wait with a condition is an expectation that may take a while.
			const condition = parseExpectation(compact({ url: raw.url, title: raw.title, text: raw.text, textGone: raw.textGone ?? raw.text_gone, target: raw.target, state: raw.state, value: raw.value, count: raw.count }));
			if (typeof condition === 'string') {
				return step.ms !== undefined ? { ...step, text: undefined, url: undefined, target: undefined } : 'wait needs `ms`, or a condition (text, textGone, url, target + state).';
			}
			return condition ? { action, expect: condition, timeoutMs: step.timeoutMs ?? 10_000, optional: step.optional } : step.ms !== undefined ? { action, ms: Math.min(30_000, step.ms), optional: step.optional } : 'wait needs `ms`, or a condition (text, textGone, url, target + state).';
		}
		case 'expect': {
			const condition = expectation ?? parseExpectation(compact({ url: raw.url, title: raw.title, text: raw.text, textGone: raw.textGone ?? raw.text_gone, target: raw.target ?? raw.ref, state: raw.state, value: raw.value, count: raw.count }));
			if (typeof condition === 'string' || !condition) {
				return condition ?? 'expect needs a condition: url, title, text, textGone, or target with state/value/count.';
			}
			return { action, expect: condition, timeoutMs: step.timeoutMs, optional: step.optional };
		}
	}
	return step;
}

/** One line per step for the result: what it did, to what. */
export function describeStep(step: IActStep): string {
	switch (step.action) {
		case 'navigate': return `navigate ${step.url}`;
		case 'click': return `${step.double ? 'double-click' : step.button === 'right' ? 'right-click' : 'click'} ${describeLocator(step.target!)}`;
		case 'type': return `type into ${describeLocator(step.target!)}`;
		case 'press': return `press ${step.key}${step.target ? ` in ${describeLocator(step.target)}` : ''}`;
		case 'select': return `select ${step.values!.map(value => JSON.stringify(value)).join(', ')} in ${describeLocator(step.target!)}`;
		case 'check': return `check ${describeLocator(step.target!)}`;
		case 'uncheck': return `uncheck ${describeLocator(step.target!)}`;
		case 'hover': return `hover ${describeLocator(step.target!)}`;
		case 'scroll': return step.until ? `scroll ${step.deltaY !== undefined && step.deltaY < 0 ? 'up' : step.deltaX ? (step.deltaX < 0 ? 'left' : 'right') : 'down'} until ${describeLocator(step.until)}` : `scroll ${step.target ? describeLocator(step.target) : 'page'} by ${step.deltaX && !step.deltaY ? `x ${step.deltaX}` : step.deltaY ?? 600}`;
		case 'wait': return step.expect ? `wait for ${describeExpectation(step.expect)}` : `wait ${step.ms}ms`;
		case 'expect': return `expect ${describeExpectation(step.expect!)}`;
		case 'back': return 'go back';
		case 'reload': return 'reload';
		case 'flow': return `run flow ${step.flow}`;
		case 'menu': return `menu ${step.values!.join(' > ')}`;
	}
}

//#endregion

//#region Action effects

/** Page counters read before and after an action, to tell what it did. */
export interface IPageProbe {
	readonly doc: string;
	readonly url: string;
	/** DOM mutations since the page's first agent call (style-only changes excluded). */
	readonly mut: number;
	/** fetch/XHR requests started. */
	readonly req: number;
	/** fetch/XHR requests not finished yet. */
	readonly inflight?: number;
	/** Ref of the focused element, '' for none. */
	readonly focus: string;
	/** True when the DOM had been quiet for the settle window and nothing was in flight. */
	readonly quiet?: boolean;
	/** Native dialogs (alert/confirm/prompt) the page opened, numbered from its first agent call. */
	readonly dialogs?: readonly { readonly n: number; readonly text: string }[];
}

export interface IActionEffect {
	readonly navigated: boolean;
	readonly urlChanged: boolean;
	readonly url: string;
	readonly mutations: number;
	readonly requests: number;
	readonly pending: number;
	readonly focusChanged: boolean;
	readonly settled: boolean;
	readonly dialogs: readonly string[];
}

export function actionEffect(before: IPageProbe | undefined, after: IPageProbe | undefined): IActionEffect | undefined {
	if (!before || !after) {
		return undefined;
	}
	const navigated = before.doc !== after.doc;
	return {
		navigated,
		urlChanged: before.url !== after.url,
		url: after.url,
		mutations: navigated ? 0 : Math.max(0, after.mut - before.mut),
		requests: navigated ? 0 : Math.max(0, after.req - before.req),
		pending: after.inflight ?? 0,
		focusChanged: before.focus !== after.focus,
		settled: after.quiet !== false,
		dialogs: navigated ? [] : (after.dialogs ?? []).filter(dialog => dialog.n > lastDialog(before)).map(dialog => dialog.text),
	};
}

function lastDialog(probe: IPageProbe): number {
	const dialogs = probe.dialogs ?? [];
	return dialogs.length ? dialogs[dialogs.length - 1].n : 0;
}

/** True when the action left no trace: no navigation, DOM change, request or focus move. */
export function hadNoEffect(effect: IActionEffect): boolean {
	return !effect.navigated && !effect.urlChanged && effect.mutations === 0 && effect.requests === 0 && !effect.focusChanged && !effect.dialogs.length;
}

function pathOf(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.pathname}${parsed.search}${parsed.hash}` || url;
	} catch {
		return url;
	}
}

export function describeEffect(effect: IActionEffect | undefined): string {
	if (!effect) {
		return 'effect unknown (the page did not answer)';
	}
	const parts: string[] = [];
	if (effect.navigated) {
		parts.push(`loaded ${pathOf(effect.url)}`);
	} else if (effect.urlChanged) {
		parts.push(`url → ${pathOf(effect.url)}`);
	}
	if (effect.mutations) {
		parts.push(`${effect.mutations} DOM change${effect.mutations === 1 ? '' : 's'}`);
	}
	if (effect.requests) {
		parts.push(`${effect.requests} request${effect.requests === 1 ? '' : 's'}`);
	}
	if (effect.pending) {
		parts.push(`${effect.pending} still pending`);
	}
	for (const dialog of effect.dialogs) {
		parts.push(`page dialog: ${JSON.stringify(dialog.slice(0, 120))}`);
	}
	if (!parts.length) {
		return effect.focusChanged ? 'focus moved' : 'no visible effect';
	}
	return parts.join(', ');
}

//#endregion
