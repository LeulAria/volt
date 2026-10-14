/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LcsDiff } from '../../../../../base/common/diff/diff.js';
import { IVoltEmulation, IVoltMockRoute, parseEmulation, parseMockRoutes } from '../../../../../platform/voltBrowser/common/browserAgent.js';

/**
 * `browser_run`: a test script for the in-app browser in one tool call. Benchmarks showed every
 * extra model turn re-reads the whole context (Grok on cursor-agent: ~14k tokens a turn before any
 * work), so driving a page one action per call is what makes browser work slow and expensive. Steps
 * name targets semantically (role + name, label, text…), assertions wait for the page on their own,
 * and the result is a compact pass/fail log plus what changed on the page.
 */

/** Finds one element. Exactly one way of finding it is used, in this order. */
export interface IBrowserLocator {
	readonly ref?: string;
	readonly role?: string;
	readonly name?: string;
	readonly label?: string;
	readonly placeholder?: string;
	readonly text?: string;
	readonly testId?: string;
	readonly selector?: string;
	/** Whole-string (case-insensitive) match instead of contains. */
	readonly exact?: boolean;
	/** Pick one of several matches (0-based; -1 is the last). */
	readonly nth?: number;
}

export type BrowserExpectation =
	| 'visible' | 'hidden' | 'text' | 'value' | 'count' | 'checked' | 'unchecked' | 'enabled' | 'disabled' | 'focused'
	| 'attribute' | 'css' | 'url' | 'title' | 'no_overflow' | 'no_console_errors' | 'no_failed_requests';

export const BROWSER_EXPECTATIONS: readonly BrowserExpectation[] = ['visible', 'hidden', 'text', 'value', 'count', 'checked', 'unchecked', 'enabled', 'disabled', 'focused', 'attribute', 'css', 'url', 'title', 'no_overflow', 'no_console_errors', 'no_failed_requests'];

/** Checked by the host, not the page. */
export const HOST_EXPECTATIONS: ReadonlySet<BrowserExpectation> = new Set(['no_console_errors', 'no_failed_requests']);

export interface IBrowserAssertion {
	readonly expect: BrowserExpectation;
	readonly target?: IBrowserLocator;
	/** Expected text/value/url/title (contains by default), a count (or { min, max }), or an attribute/CSS value. */
	readonly value?: string | number | { readonly min?: number; readonly max?: number };
	readonly match?: 'contains' | 'equals' | 'regex';
	/** Attribute name or CSS property, for `attribute` and `css`. */
	readonly name?: string;
}

export type BrowserRunAction =
	| 'navigate' | 'click' | 'dblclick' | 'type' | 'fill' | 'press' | 'hover' | 'select' | 'check' | 'uncheck' | 'scroll'
	| 'wait' | 'resize' | 'reload' | 'back' | 'evaluate' | 'screenshot' | 'snapshot' | 'assert' | 'mock' | 'emulate' | 'audit';

export const BROWSER_RUN_ACTIONS: readonly BrowserRunAction[] = ['navigate', 'click', 'dblclick', 'type', 'fill', 'press', 'hover', 'select', 'check', 'uncheck', 'scroll', 'wait', 'resize', 'reload', 'back', 'evaluate', 'screenshot', 'snapshot', 'assert', 'mock', 'emulate', 'audit'];

/** Actions that change the page; read-only modes ask before running a script with any of them on a non-local page. */
export const MUTATING_RUN_ACTIONS: ReadonlySet<BrowserRunAction> = new Set(['click', 'dblclick', 'type', 'fill', 'press', 'select', 'check', 'uncheck', 'evaluate', 'mock', 'emulate']);

export type BrowserAuditCheck = 'a11y' | 'layout' | 'perf';

export interface IBrowserRunStep {
	readonly action: BrowserRunAction;
	readonly target?: IBrowserLocator;
	readonly url?: string;
	readonly text?: string;
	readonly key?: string;
	readonly values?: readonly string[];
	readonly submit?: boolean;
	readonly clear?: boolean;
	readonly deltaY?: number;
	readonly deltaX?: number;
	readonly ms?: number;
	readonly width?: number;
	readonly height?: number;
	readonly reset?: boolean;
	readonly expression?: string;
	readonly assertion?: IBrowserAssertion;
	/** `mock`: the routes that replace the active ones (empty clears them). */
	readonly routes?: readonly IVoltMockRoute[];
	/** `emulate`: conditions to apply; with `reset`, applied after clearing earlier ones. */
	readonly emulation?: IVoltEmulation;
	/** `mock` / `emulate`: reload the page afterwards so requests made at load see the change. */
	readonly reloadAfter?: boolean;
	/** `audit`: what to check (default a11y), the CSS scope, and the widths for layout. */
	readonly checks?: readonly BrowserAuditCheck[];
	readonly scope?: string;
	readonly widths?: readonly number[];
	/** Assertions and `wait`: how long to keep checking (default 5000, max 30000). */
	readonly timeoutMs: number;
	/** A failing step does not stop the run. */
	readonly optional?: boolean;
	/** Free text the agent gave the step, echoed in the log. */
	readonly note?: string;
}

const LOCATOR_KEYS = ['ref', 'role', 'name', 'label', 'placeholder', 'text', 'testId', 'selector', 'exact', 'nth'] as const;

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * `{ role: 'button', name: 'Add' }`, `{ label: 'Email' }`, `"e12"`, `"@e12"`, `"#id"` / `".class"`
 * (CSS), `"text=Add"`, `"role=button[name=Add]"`, `"label=Email"`, `"placeholder=…"`, `"testid=…"`.
 */
export function parseLocator(value: unknown): IBrowserLocator | undefined {
	if (typeof value === 'string') {
		const raw = value.trim();
		if (!raw) {
			return undefined;
		}
		const ref = /^@?(?:ref=)?(e\d+)$/.exec(raw);
		if (ref) {
			return { ref: ref[1] };
		}
		const role = /^role=([a-z]+)(?:\[name=(?:"([^"]*)"|'([^']*)'|([^\]]*))\])?$/i.exec(raw);
		if (role) {
			const name = role[2] ?? role[3] ?? role[4];
			return name !== undefined ? { role: role[1].toLowerCase(), name } : { role: role[1].toLowerCase() };
		}
		const keyed = /^(text|label|placeholder|testid|css|selector)=(.+)$/i.exec(raw);
		if (keyed) {
			const v = keyed[2].replace(/^["']|["']$/g, '');
			switch (keyed[1].toLowerCase()) {
				case 'text': return { text: v };
				case 'label': return { label: v };
				case 'placeholder': return { placeholder: v };
				case 'testid': return { testId: v };
				default: return { selector: v };
			}
		}
		return { selector: raw };
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const input = value as Record<string, unknown>;
	const out: { -readonly [K in keyof IBrowserLocator]: IBrowserLocator[K] } = {};
	const ref = str(input.ref);
	if (ref) {
		out.ref = ref.replace(/^@|^ref=/, '');
	}
	for (const key of ['role', 'name', 'label', 'placeholder', 'text', 'selector'] as const) {
		const v = str(input[key]);
		if (v !== undefined) {
			out[key] = key === 'role' ? v.toLowerCase() : v;
		}
	}
	const testId = str(input.testId ?? input.test_id ?? input.testid);
	if (testId) {
		out.testId = testId;
	}
	if (input.exact === true) {
		out.exact = true;
	}
	const nth = num(input.nth);
	if (nth !== undefined) {
		out.nth = Math.trunc(nth);
	}
	// A bare `name` means "something called X": prefer a role match the agent did not spell out.
	if (out.name && !out.role && !out.ref && !out.label && !out.text && !out.selector && !out.testId && !out.placeholder) {
		out.text = out.name;
		delete out.name;
	}
	return Object.keys(out).some(key => key !== 'exact' && key !== 'nth') ? out : undefined;
}

export function describeLocator(locator: IBrowserLocator | undefined): string {
	if (!locator) {
		return 'page';
	}
	if (locator.ref) {
		return locator.ref;
	}
	const extra = `${locator.exact ? ', exact' : ''}${locator.nth !== undefined ? `, nth ${locator.nth}` : ''}`;
	if (locator.role) {
		return `${locator.role}${locator.name ? ` "${locator.name}"` : ''}${extra}`;
	}
	for (const key of ['label', 'placeholder', 'text', 'testId', 'selector'] as const) {
		if (locator[key]) {
			return `${key} "${locator[key]}"${extra}`;
		}
	}
	return 'element';
}

function locatorFrom(step: Record<string, unknown>): IBrowserLocator | undefined {
	const direct = parseLocator(step.target ?? step.locator ?? step.element_locator);
	if (direct) {
		// `nth` / `exact` written next to the target instead of inside it.
		const nth = num(step.nth);
		return {
			...direct,
			...(direct.nth === undefined && nth !== undefined ? { nth: Math.trunc(nth) } : {}),
			...(direct.exact === undefined && step.exact === true ? { exact: true } : {}),
		};
	}
	// Flattened form: { action: 'click', role: 'button', name: 'Add' } or { action: 'click', ref: 'e3' }.
	const flat: Record<string, unknown> = {};
	for (const key of LOCATOR_KEYS) {
		if (step[key] !== undefined) {
			flat[key] = step[key];
		}
	}
	if (step.testid !== undefined || step.test_id !== undefined) {
		flat.testId = step.testid ?? step.test_id;
	}
	return parseLocator(flat);
}

const ACTION_ALIASES: Readonly<Record<string, BrowserRunAction>> = {
	goto: 'navigate', open: 'navigate', visit: 'navigate', double_click: 'dblclick', doubleclick: 'dblclick',
	tap: 'click', input: 'type', select_option: 'select', press_key: 'press', key: 'press', sleep: 'wait',
	wait_for: 'assert', expect: 'assert', verify: 'assert', check_box: 'check', viewport: 'resize', eval: 'evaluate', js: 'evaluate',
	refresh: 'reload', go_back: 'back', route: 'mock', mock_route: 'mock', intercept: 'mock', unmock: 'mock', clear_mocks: 'mock',
	emulation: 'emulate', a11y: 'audit',
};

function actionOf(step: Record<string, unknown>): BrowserRunAction | undefined {
	const raw = str(step.action ?? step.do ?? step.type_of ?? step.step)?.toLowerCase().replace(/^browser_/, '');
	if (raw) {
		const action = ACTION_ALIASES[raw] ?? raw;
		return (BROWSER_RUN_ACTIONS as readonly string[]).includes(action) ? action as BrowserRunAction : undefined;
	}
	// Shorthand: { click: {role…} }, { navigate: "http://…" }, { assert: {…} }.
	for (const key of Object.keys(step)) {
		const action = ACTION_ALIASES[key] ?? key;
		if ((BROWSER_RUN_ACTIONS as readonly string[]).includes(action)) {
			return action as BrowserRunAction;
		}
	}
	return undefined;
}

function expectationOf(raw: unknown): BrowserExpectation | undefined {
	const value = str(raw)?.toLowerCase().replace(/[\s-]+/g, '_');
	if (!value) {
		return undefined;
	}
	const aliases: Record<string, BrowserExpectation> = {
		shown: 'visible', present: 'visible', exists: 'visible', gone: 'hidden', not_visible: 'hidden', absent: 'hidden',
		contains_text: 'text', has_text: 'text', text_contains: 'text', has_value: 'value', url_contains: 'url',
		no_errors: 'no_console_errors', console_clean: 'no_console_errors', no_horizontal_scroll: 'no_overflow',
	};
	const expectation = aliases[value] ?? value;
	return (BROWSER_EXPECTATIONS as readonly string[]).includes(expectation) ? expectation as BrowserExpectation : undefined;
}

function assertionFrom(step: Record<string, unknown>, target: IBrowserLocator | undefined): IBrowserAssertion | string {
	const nested = step.assert && typeof step.assert === 'object' ? step.assert as Record<string, unknown> : undefined;
	const source = nested ?? step;
	let expectation = expectationOf(source.expect ?? source.state ?? source.condition ?? source.check);
	const nestedTarget = nested ? locatorFrom(nested) : undefined;
	const goal = nestedTarget ?? target;
	let value = source.value ?? source.equals ?? source.contains ?? source.matches ?? source.count;
	const match: IBrowserAssertion['match'] =source.match === 'equals' || source.match === 'regex' ? source.match : source.equals !== undefined ? 'equals' : source.matches !== undefined ? 'regex' : undefined;
	if (!expectation) {
		// Infer from what was given: { text: "Saved" } with no target means "page shows Saved".
		if (source.count !== undefined) {
			expectation = 'count';
		} else if (source.url !== undefined && !goal) {
			expectation = 'url';
			value = source.url;
		} else if (source.title !== undefined) {
			expectation = 'title';
			value = source.title;
		} else if (!goal && typeof source.text === 'string') {
			expectation = 'text';
			value = source.text;
		} else if (goal && value !== undefined) {
			expectation = 'text';
		} else if (goal) {
			expectation = 'visible';
		}
	}
	if (!expectation) {
		return `assert needs \`expect\` (one of ${BROWSER_EXPECTATIONS.join(', ')})`;
	}
	if (expectation === 'text' && !goal && value === undefined && typeof source.text === 'string') {
		value = source.text;
	}
	const needsTarget = !['url', 'title', 'no_overflow', 'no_console_errors', 'no_failed_requests', 'text', 'count'].includes(expectation);
	if (needsTarget && !goal) {
		return `assert ${expectation} needs a \`target\``;
	}
	if (value !== undefined && typeof value !== 'string' && typeof value !== 'number' && !(value && typeof value === 'object')) {
		value = String(value);
	}
	return {
		expect: expectation,
		target: goal,
		value: value as IBrowserAssertion['value'],
		match,
		name: str(source.name_attr ?? source.attribute ?? source.property ?? (expectation === 'attribute' || expectation === 'css' ? source.name : undefined)),
	};
}

/** Agent steps → validated steps. Bad steps are reported by index; nothing runs if any step is invalid. */
export function parseRunSteps(input: unknown): { steps: IBrowserRunStep[]; errors: string[] } {
	const steps: IBrowserRunStep[] = [];
	const errors: string[] = [];
	const list = Array.isArray(input) ? input : [];
	if (!list.length) {
		return { steps, errors: ['`steps` must be a non-empty array, e.g. [{ "action": "click", "target": { "role": "button", "name": "Add" } }]'] };
	}
	if (list.length > 60) {
		errors.push('At most 60 steps per run; split the script.');
	}
	list.slice(0, 60).forEach((raw, index) => {
		const where = `step ${index + 1}`;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			errors.push(`${where}: must be an object with an \`action\``);
			return;
		}
		let step = raw as Record<string, unknown>;
		const action = actionOf(step);
		const clearing = /^(unmock|clear_mocks)$/i.test(String(step.action ?? Object.keys(step)[0] ?? ''));
		if (!action) {
			errors.push(`${where}: unknown action ${JSON.stringify(step.action ?? Object.keys(step)[0])} (use ${BROWSER_RUN_ACTIONS.join(', ')})`);
			return;
		}
		// Shorthand { click: { role: 'button' } } / { navigate: 'http://…' } → flatten.
		const short = step[action];
		if (step.action === undefined && short !== undefined && action !== 'assert') {
			step = action === 'mock' && Array.isArray(short) ? { ...step, routes: short } : typeof short === 'object' && short && !Array.isArray(short) ? { ...step, ...short as Record<string, unknown> } : { ...step, [action === 'navigate' ? 'url' : action === 'press' ? 'key' : action === 'evaluate' ? 'expression' : action === 'wait' ? 'ms' : 'target']: short };
		}
		const target = locatorFrom(step);
		const timeoutMs = Math.max(0, Math.min(30000, num(step.timeout_ms ?? step.timeoutMs) ?? (num(step.timeout) !== undefined ? num(step.timeout)! * (num(step.timeout)! < 100 ? 1000 : 1) : 5000)));
		const base = { action, target, timeoutMs, optional: step.optional === true || step.continue_on_failure === true ? true : undefined, note: str(step.note ?? step.description ?? step.why) };
		switch (action) {
			case 'navigate': {
				const url = str(step.url ?? step.href);
				if (!url) {
					errors.push(`${where}: navigate needs a \`url\``);
					return;
				}
				steps.push({ ...base, url });
				return;
			}
			case 'click': case 'dblclick': case 'hover': case 'check': case 'uncheck':
				if (!target) {
					errors.push(`${where}: ${action} needs a \`target\` (e.g. { "role": "button", "name": "Save" } or a ref)`);
					return;
				}
				steps.push(base);
				return;
			case 'type': case 'fill': {
				const text = typeof step.text === 'string' ? step.text : typeof step.value === 'string' ? step.value : typeof step.value === 'number' ? String(step.value) : undefined;
				if (!target || text === undefined) {
					errors.push(`${where}: ${action} needs a \`target\` and \`text\``);
					return;
				}
				steps.push({ ...base, text, submit: step.submit === true || step.enter === true, clear: action === 'fill' ? true : step.clear !== false });
				return;
			}
			case 'press': {
				const key = str(step.key ?? step.keys ?? step.text);
				if (!key) {
					errors.push(`${where}: press needs a \`key\` such as "Enter" or "Meta+a"`);
					return;
				}
				steps.push({ ...base, key });
				return;
			}
			case 'select': {
				const values = Array.isArray(step.values) ? step.values.map(String) : step.value !== undefined ? [String(step.value)] : step.option !== undefined ? [String(step.option)] : [];
				if (!target || !values.length) {
					errors.push(`${where}: select needs a \`target\` and \`values\``);
					return;
				}
				steps.push({ ...base, values });
				return;
			}
			case 'scroll':
				steps.push({ ...base, deltaY: num(step.deltaY ?? step.delta_y ?? step.y) ?? (target ? 0 : 600), deltaX: num(step.deltaX ?? step.delta_x ?? step.x) ?? 0 });
				return;
			case 'wait': {
				const ms = num(step.ms) ?? (num(step.seconds) !== undefined ? num(step.seconds)! * 1000 : undefined) ?? 500;
				steps.push({ ...base, ms: Math.max(0, Math.min(30000, ms)) });
				return;
			}
			case 'resize': {
				const width = num(step.width);
				const height = num(step.height) ?? (width !== undefined ? (width <= 480 ? 844 : width <= 1024 ? 1024 : 800) : undefined);
				const reset = step.reset === true || width === undefined;
				steps.push({ ...base, width: reset ? undefined : width, height: reset ? undefined : height, reset });
				return;
			}
			case 'evaluate': {
				const expression = str(step.expression ?? step.script ?? step.js ?? step.code);
				if (!expression) {
					errors.push(`${where}: evaluate needs an \`expression\``);
					return;
				}
				steps.push({ ...base, expression });
				return;
			}
			case 'assert': {
				const assertion = assertionFrom(step, target);
				if (typeof assertion === 'string') {
					errors.push(`${where}: ${assertion}`);
					return;
				}
				steps.push({ ...base, target: assertion.target, assertion });
				return;
			}
			case 'mock': {
				// { mock: { url, status, json } }, { action: 'mock', routes: [...] }, or { unmock: true } / clear: true.
				const clear = clearing || step.clear === true;
				const given = step.routes ?? (step.url !== undefined || step.path !== undefined || step.pattern !== undefined ? [step] : undefined);
				if (!clear && given === undefined) {
					errors.push(`${where}: mock needs \`routes\` (e.g. [{"url":"/api/stats","status":500}]) or clear: true`);
					return;
				}
				const parsed = given === undefined ? { routes: [], errors: [] } : parseMockRoutes(given);
				if (parsed.errors.length) {
					errors.push(...parsed.errors.map(error => `${where}: ${error}`));
					return;
				}
				steps.push({ ...base, target: undefined, routes: parsed.routes, reloadAfter: step.reload === true });
				return;
			}
			case 'emulate': {
				const parsed = parseEmulation(step);
				if (parsed.errors.length) {
					errors.push(...parsed.errors.map(error => `${where}: ${error}`));
					return;
				}
				if (!Object.keys(parsed.emulation).length && step.reset !== true) {
					errors.push(`${where}: emulate needs network, color_scheme, reduced_motion, cpu_slowdown, timezone or locale (or reset: true)`);
					return;
				}
				steps.push({ ...base, target: undefined, emulation: parsed.emulation, reset: step.reset === true, reloadAfter: step.reload === true });
				return;
			}
			case 'audit': {
				const wanted = (Array.isArray(step.checks) ? step.checks : typeof step.checks === 'string' ? [step.checks] : []).map(check => String(check).toLowerCase());
				const checks = wanted.filter((check): check is BrowserAuditCheck => check === 'a11y' || check === 'layout' || check === 'perf');
				const widths = (Array.isArray(step.widths) ? step.widths : []).map(Number).filter(width => Number.isFinite(width) && width >= 200 && width <= 3840).slice(0, 6);
				steps.push({ ...base, target: undefined, checks: checks.length ? checks : widths.length ? ['layout'] : ['a11y'], scope: str(step.scope ?? step.selector), widths });
				return;
			}
			default:
				steps.push(base);
		}
	});
	return { steps, errors };
}

export interface IBrowserStepOutcome {
	readonly ok: boolean;
	readonly line: string;
	readonly ms: number;
	readonly skipped?: boolean;
}

export function describeStep(step: IBrowserRunStep): string {
	const target = step.target ? ` ${describeLocator(step.target)}` : '';
	switch (step.action) {
		case 'navigate': return `navigate ${step.url}`;
		case 'type': case 'fill': return `${step.action}${target} ${JSON.stringify(step.text!.length > 60 ? `${step.text!.slice(0, 57)}…` : step.text)}${step.submit ? ' + Enter' : ''}`;
		case 'press': return `press ${step.key}`;
		case 'select': return `select${target} ${step.values!.join(', ')}`;
		case 'scroll': return `scroll${target} ${step.deltaY ?? 0}`;
		case 'wait': return `wait ${step.ms} ms`;
		case 'resize': return step.reset ? 'resize to fill the pane' : `resize ${step.width}×${step.height}`;
		case 'evaluate': return `evaluate ${step.expression!.length > 60 ? `${step.expression!.slice(0, 57)}…` : step.expression}`;
		case 'mock': return step.routes!.length ? `mock ${step.routes!.map(route => `${route.method ? `${route.method} ` : ''}${route.url} → ${route.abort ? 'network error' : route.status}${route.delayMs ? ` after ${route.delayMs} ms` : ''}`).join('; ')}${step.reloadAfter ? ', then reload' : ''}` : `clear mocks${step.reloadAfter ? ', then reload' : ''}`;
		case 'emulate': {
			const parts = Object.entries(step.emulation ?? {}).map(([key, value]) => `${key}=${value}`);
			return `emulate ${step.reset ? `reset${parts.length ? ', ' : ''}` : ''}${parts.join(', ')}${step.reloadAfter ? ', then reload' : ''}`;
		}
		case 'audit': return `audit ${step.checks!.join('+')}${step.scope ? ` in ${step.scope}` : ''}${step.widths?.length ? ` at ${step.widths.join('/')}px` : ''}`;
		case 'assert': {
			const a = step.assertion!;
			const value = a.value === undefined ? '' : typeof a.value === 'object' ? ` ${JSON.stringify(a.value)}` : ` ${a.match === 'equals' ? '= ' : a.match === 'regex' ? '~ ' : ''}${JSON.stringify(a.value)}`;
			return `assert ${a.target ? `${describeLocator(a.target)} ` : ''}${a.expect}${a.name ? ` ${a.name}` : ''}${value}`;
		}
		default: return `${step.action}${target}`;
	}
}

export function formatRunLog(outcomes: readonly IBrowserStepOutcome[], totalSteps: number, ms: number): string[] {
	const failed = outcomes.filter(o => !o.ok && !o.skipped).length;
	const passed = outcomes.filter(o => o.ok).length;
	const notRun = totalSteps - outcomes.length;
	const head = `### Run: ${totalSteps} step${totalSteps === 1 ? '' : 's'}, ${passed} passed${failed ? `, ${failed} failed` : ''}${notRun ? `, ${notRun} not run` : ''} (${(ms / 1000).toFixed(1)}s)`;
	return [head, ...outcomes.map((o, i) => `${i + 1}. ${o.skipped ? '–' : o.ok ? '✓' : '✗'} ${o.line}${o.ms >= 300 ? ` (${(o.ms / 1000).toFixed(1)}s)` : ''}`)];
}

/**
 * What changed between two snapshots of the same document, as a unified diff of the snapshot
 * lines with the nearest enclosing node above each change. Undefined when a diff would not be
 * clearly smaller than the snapshot itself (the caller then sends the whole snapshot).
 */
export function diffSnapshots(before: string, after: string, maxLines = 120): { text: string; added: number; removed: number } | undefined {
	const a = before.split('\n');
	const b = after.split('\n');
	if (before === after) {
		return { text: '(no change)', added: 0, removed: 0 };
	}
	const changes = new LcsDiff({ getElements: () => a }, { getElements: () => b }).ComputeDiff(false).changes;
	const out: string[] = [];
	let added = 0;
	let removed = 0;
	const indent = (line: string) => line.length - line.trimStart().length;
	for (const change of changes) {
		// The enclosing node: the nearest earlier "- role:" line that is less indented than the change.
		const anchorIndex = change.modifiedStart - 1;
		const firstChanged = change.modifiedLength ? b[change.modifiedStart] : a[change.originalStart];
		const depth = firstChanged !== undefined ? indent(firstChanged) : 0;
		let context: string | undefined;
		for (let i = Math.min(anchorIndex, b.length - 1); i >= 0; i--) {
			const line = b[i];
			if (/^\s*- role: /.test(line) && indent(line) < depth) {
				const next = b[i + 1] ?? '';
				const ref = b.slice(i + 1, i + 4).find(l => /^\s*ref: /.test(l));
				const name = /^\s*name: /.test(next) ? next.trim().slice(6).replace(/^"|"$/g, '') : undefined;
				context = `${line.trim().slice(8)}${name ? ` "${name}"` : ''}${ref ? ` (${ref.trim().slice(5)})` : ''}`;
				break;
			}
		}
		out.push(`@@ in ${context ?? 'document'}`);
		for (let i = 0; i < change.originalLength; i++) {
			out.push(`-${a[change.originalStart + i]}`);
			removed++;
		}
		for (let i = 0; i < change.modifiedLength; i++) {
			out.push(`+${b[change.modifiedStart + i]}`);
			added++;
		}
	}
	if (out.length > maxLines || out.length > b.length * 0.6) {
		return undefined;
	}
	return { text: out.join('\n'), added, removed };
}
