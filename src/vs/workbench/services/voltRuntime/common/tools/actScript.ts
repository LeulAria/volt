/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IActStep, IPageExpectation, IPageLocator, MAX_ACT_STEPS, PageElementState, REF_RE } from './pageModel.js';

/**
 * The step script `browser_act`, `device_act` and `desktop_act` take as `script`: one step per
 * line, a few words each, so the model spends a quarter of the output tokens a JSON step list
 * costs (and a model turn is mostly the time it takes to write the call).
 *
 *   goto http://localhost:3000/login
 *   type "Email" ada@example.com
 *   type "Password" ${password}
 *   check "Remember me"
 *   click button "Sign in" => "Welcome back" and url /dashboard
 *   click button "Delete" in "Project A"
 *   submit "Search" lamp            (type, then Enter)
 *   select "Country" Germany
 *   scroll down until "Display"
 *   wait gone "Loading"
 *   expect count listitem in "Todos" 2
 *   ? click "Accept cookies"        (optional: keep going if it is not there)
 *   run login email=ada@example.com (a saved flow)
 */

const ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'tab', 'menuitem', 'treeitem', 'listitem', 'row', 'cell', 'heading', 'img', 'dialog', 'alertdialog', 'list', 'table', 'navigation', 'form', 'region', 'menu', 'tablist', 'text', 'group', 'alert', 'status', 'banner', 'main', 'article']);
const STATES = new Set<string>(['visible', 'hidden', 'enabled', 'disabled', 'checked', 'unchecked', 'focused', 'expanded', 'collapsed', 'selected']);

class ScriptError extends Error { }

/** Reads one line left to right: words, quoted strings, targets. */
class Cursor {
	at = 0;

	constructor(readonly text: string) { }

	get done(): boolean {
		this.ws();
		return this.at >= this.text.length;
	}

	ws(): void {
		while (this.at < this.text.length && /\s/.test(this.text[this.at])) {
			this.at++;
		}
	}

	peek(): string {
		this.ws();
		// allow-any-unicode-next-line
		const m = /^[^\s"'\u201c\u201d\u2018\u2019]+/.exec(this.text.slice(this.at));
		return m ? m[0] : '';
	}

	word(): string {
		const w = this.peek();
		this.at += w.length;
		return w;
	}

	isQuote(): boolean {
		this.ws();
		// allow-any-unicode-next-line
		return /^["'\u201c\u2018]/.test(this.text.slice(this.at));
	}

	quoted(): string | undefined {
		if (!this.isQuote()) {
			return undefined;
		}
		const open = this.text[this.at];
		// allow-any-unicode-next-line
		const close = open === '“' ? '”' : open === '‘' ? '’' : open;
		let out = '';
		let i = this.at + 1;
		for (; i < this.text.length; i++) {
			const c = this.text[i];
			if (c === '\\' && i + 1 < this.text.length) {
				out += this.text[++i];
			} else if (c === close) {
				this.at = i + 1;
				return out;
			} else {
				out += c;
			}
		}
		throw new ScriptError(`unclosed quote in ${JSON.stringify(this.text)}`);
	}

	/** The rest of the line, unquoted when it is one quoted string. */
	rest(): string {
		this.ws();
		const rest = this.text.slice(this.at).trim();
		this.at = this.text.length;
		// allow-any-unicode-next-line
		const m = /^(["'\u201c\u2018])(.*)(["'\u201d\u2019])$/s.exec(rest);
		return m && !m[2].includes(m[1]) ? m[2] : rest;
	}

	/** Runs `fn`; when it throws, puts the cursor back and returns undefined. */
	attempt<T>(fn: () => T): T | undefined {
		const at = this.at;
		try {
			return fn();
		} catch (err) {
			if (!(err instanceof ScriptError)) {
				throw err;
			}
			this.at = at;
			return undefined;
		}
	}
}

/**
 * A target: a ref (`e12`), `"visible text"`, `button "Save"` (role + name), a bare role, `label "Email"`,
 * `placeholder "Search"`, `css "…"`, `id "…"`, then any of `in <target>`, `#2` (nth), `exact`.
 * `bare` decides what a lone quoted string means for this verb (text to click, or a field's label).
 */
function target(c: Cursor, bare: 'text' | 'label', depth = 0): IPageLocator {
	let locator: IPageLocator;
	const quoted = c.quoted();
	if (quoted !== undefined) {
		locator = bare === 'label' ? { label: quoted } : { text: quoted };
	} else {
		const w = c.peek();
		const lower = w.toLowerCase();
		if (REF_RE.test(w)) {
			c.word();
			locator = { ref: w };
		} else if (ROLES.has(lower)) {
			c.word();
			const name = c.quoted();
			locator = name !== undefined ? { role: lower, name } : { role: lower };
		} else if (lower === 'label' || lower === 'placeholder' || lower === 'css' || lower === 'id' || lower === 'text') {
			c.word();
			const value = c.quoted() ?? c.word();
			if (!value) {
				throw new ScriptError(`${lower} needs a value`);
			}
			locator = lower === 'label' ? { label: value } : lower === 'placeholder' ? { placeholder: value } : lower === 'text' ? { text: value } : { selector: value };
		} else if (lower.startsWith('css=')) {
			c.word();
			locator = { selector: w.slice(4) };
		} else {
			throw new ScriptError(`expected a target (a ref like e12, "text", or a role like button "Save") at ${JSON.stringify(c.text.slice(c.at, c.at + 30) || 'the end')}`);
		}
	}
	for (; ;) {
		const w = c.peek().toLowerCase();
		if ((w === 'in' || w === 'within') && depth < 2) {
			const within = c.attempt(() => {
				c.word();
				return target(c, 'text', depth + 1);
			});
			if (!within) {
				break;
			}
			locator = { ...locator, within };
		} else if (/^#-?\d+$/.test(w) && depth === 0) {
			// nth and exact belong to the target being acted on, also when they follow its container.
			c.word();
			locator = { ...locator, nth: Number(w.slice(1)) };
		} else if (w === 'exact' && depth === 0) {
			c.word();
			locator = { ...locator, exact: true };
		} else {
			break;
		}
	}
	return locator;
}

function duration(value: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)(ms|s)$/i.exec(value);
	return m ? Math.round(Number(m[1]) * (m[2].toLowerCase() === 's' ? 1000 : 1)) : undefined;
}

/** `"Saved"`, `gone "Saving"`, `url /dashboard`, `title "Home"`, `count listitem 3`, `<target> checked`, `<target> = "value"`, joined by `and`. */
function expectation(c: Cursor): IPageExpectation {
	let out: { -readonly [K in keyof IPageExpectation]: IPageExpectation[K] } = {};
	const merge = (part: IPageExpectation) => {
		for (const key of Object.keys(part) as (keyof IPageExpectation)[]) {
			if (out[key] !== undefined) {
				throw new ScriptError(`two ${key} conditions in one expectation; use two expect lines`);
			}
		}
		out = { ...out, ...part };
	};
	for (; ;) {
		const w = c.peek().toLowerCase();
		if (w === 'gone' || w === 'no' || w === 'not') {
			c.word();
			const text = c.quoted();
			if (text === undefined) {
				throw new ScriptError(`${w} needs "text"`);
			}
			merge({ textGone: text });
		} else if (w === 'url') {
			c.word();
			merge({ url: c.quoted() ?? c.word() });
		} else if (w === 'title') {
			c.word();
			merge({ title: c.quoted() ?? c.word() });
		} else if (w === 'count') {
			c.word();
			const t = target(c, 'text');
			const n = Number(c.word());
			if (!Number.isInteger(n)) {
				throw new ScriptError('count needs a number after its target, e.g. count listitem 3');
			}
			merge({ target: t, count: n });
		} else {
			const t = target(c, 'text');
			const next = c.peek().toLowerCase();
			if (STATES.has(next)) {
				c.word();
				merge({ target: t, state: next as PageElementState });
			} else if (next === '=' || next === 'is' || next === 'value') {
				c.word();
				merge({ target: t, value: c.quoted() ?? c.word() });
			} else if (t.text !== undefined && Object.keys(t).length === 1) {
				// A bare "string": that text shows anywhere on the page.
				merge({ text: t.text });
			} else {
				merge({ target: t, state: 'visible' });
			}
		}
		if (c.peek().toLowerCase() !== 'and') {
			break;
		}
		c.word();
	}
	if (!c.done) {
		throw new ScriptError(`unexpected ${JSON.stringify(c.text.slice(c.at).trim())} after the expectation`);
	}
	return out;
}

/** Splits `action => expectation` at the first arrow outside quotes. */
function splitArrow(line: string): [string, string | undefined] {
	let quote = '';
	for (let i = 0; i < line.length - 1; i++) {
		const ch = line[i];
		if (quote) {
			if (ch === '\\') {
				i++;
			} else if (ch === quote) {
				quote = '';
			}
			// allow-any-unicode-next-line
		} else if (ch === '"' || ch === '\'' || ch === '“' || ch === '‘') {
			// allow-any-unicode-next-line
			quote = ch === '“' ? '”' : ch === '‘' ? '’' : ch;
		} else if (ch === '=' && line[i + 1] === '>') {
			return [line.slice(0, i), line.slice(i + 2)];
		}
	}
	return [line, undefined];
}

const VERBS: Readonly<Record<string, string>> = {
	goto: 'navigate', open: 'navigate', navigate: 'navigate', visit: 'navigate', launch: 'navigate',
	click: 'click', tap: 'click', dblclick: 'dblclick', doubleclick: 'dblclick', rclick: 'rclick', rightclick: 'rclick',
	type: 'type', fill: 'type', enter: 'type', submit: 'submit',
	press: 'press', key: 'press',
	select: 'select', choose: 'select', pick: 'select',
	check: 'check', uncheck: 'uncheck', hover: 'hover', scroll: 'scroll', swipe: 'scroll',
	wait: 'wait', expect: 'expect', assert: 'expect', verify: 'expect',
	back: 'back', reload: 'reload', refresh: 'reload', run: 'flow', flow: 'flow', menu: 'menu',
};

function parseLine(line: string): IActStep {
	let optional = false;
	let text = line.trim();
	if (text.startsWith('?')) {
		optional = true;
		text = text.slice(1);
	} else if (/^try\s/i.test(text)) {
		optional = true;
		text = text.slice(3);
	}
	const [act, arrow] = splitArrow(text);
	const c = new Cursor(act);
	const verbWord = c.word().toLowerCase();
	const verb = VERBS[verbWord];
	if (!verb) {
		throw new ScriptError(`unknown step ${JSON.stringify(verbWord)}: use goto, click, type, submit, press, select, check, uncheck, hover, scroll, wait, expect, back, reload or run`);
	}
	const extra: { -readonly [K in keyof IActStep]?: IActStep[K] } = optional ? { optional } : {};
	if (arrow !== undefined) {
		extra.expect = expectation(new Cursor(arrow));
	}
	switch (verb) {
		case 'navigate': {
			const url = c.rest();
			if (!url) {
				throw new ScriptError('goto needs a URL (or an app id on devices)');
			}
			return { action: 'navigate', url, ...extra };
		}
		case 'click':
		case 'dblclick':
		case 'rclick':
		case 'hover': {
			const t = target(c, 'text');
			if (!c.done) {
				throw new ScriptError(`unexpected ${JSON.stringify(c.text.slice(c.at).trim())} after the target`);
			}
			if (verb === 'hover') {
				return { action: 'hover', target: t, ...extra };
			}
			return { action: 'click', target: t, ...(verb === 'dblclick' ? { double: true } : verb === 'rclick' ? { button: 'right' as const } : {}), ...extra };
		}
		case 'type':
		case 'submit': {
			const t = target(c, 'label');
			const value = c.rest();
			return { action: 'type', target: t, text: value, ...(verb === 'submit' ? { submit: true } : {}), ...extra };
		}
		case 'press': {
			const key = c.word();
			if (!key) {
				throw new ScriptError('press needs a key, e.g. press Enter');
			}
			let t: IPageLocator | undefined;
			if (c.peek().toLowerCase() === 'in') {
				c.word();
				t = target(c, 'label');
			}
			return { action: 'press', key, ...(t ? { target: t } : {}), ...extra };
		}
		case 'select': {
			const t = target(c, 'label');
			const values: string[] = [];
			while (c.isQuote()) {
				values.push(c.quoted()!);
			}
			if (!values.length) {
				const rest = c.rest();
				if (rest) {
					values.push(rest);
				}
			}
			if (!values.length) {
				throw new ScriptError('select needs a value, e.g. select "Country" Germany');
			}
			return { action: 'select', target: t, values, ...extra };
		}
		case 'check':
		case 'uncheck':
			return { action: verb, target: target(c, 'label'), ...extra };
		case 'scroll': {
			let dir = 'down';
			let t: IPageLocator | undefined;
			let amount: number | undefined;
			let until: IPageLocator | undefined;
			while (!c.done) {
				const w = c.peek().toLowerCase();
				if (w === 'up' || w === 'down' || w === 'left' || w === 'right') {
					dir = c.word().toLowerCase();
				} else if (w === 'until' || w === 'to') {
					c.word();
					until = target(c, 'text');
				} else if (/^\d+$/.test(w)) {
					amount = Number(c.word());
				} else {
					t = target(c, 'text');
				}
			}
			const size = amount ?? 600;
			const sign = dir === 'up' || dir === 'left' ? -1 : 1;
			const horizontal = dir === 'left' || dir === 'right';
			return { action: 'scroll', ...(horizontal ? { deltaX: sign * size } : { deltaY: sign * size }), ...(t ? { target: t } : {}), ...(until ? { until } : {}), ...extra };
		}
		case 'wait': {
			const ms = duration(c.peek());
			if (ms !== undefined) {
				c.word();
				return { action: 'wait', ms: Math.min(30_000, ms), ...extra };
			}
			const e = expectation(c);
			return { action: 'wait', expect: e, timeoutMs: 10_000, ...extra };
		}
		case 'expect':
			return { action: 'expect', expect: expectation(c), ...extra };
		case 'back':
		case 'reload':
			return { action: verb, ...extra };
		case 'menu': {
			// menu File > Export > "PDF…"
			// allow-any-unicode-next-line
			const path = c.rest().split('>').map(part => part.trim().replace(/^(["'\u201c\u2018])(.*)(["'\u201d\u2019])$/s, '$2')).filter(Boolean);
			if (!path.length) {
				throw new ScriptError('menu needs a path, e.g. menu File > Save As…');
			}
			return { action: 'menu', values: path, ...extra };
		}
		case 'flow': {
			const name = c.word();
			if (!name) {
				throw new ScriptError('run needs a flow name');
			}
			const vars: Record<string, string> = {};
			while (!c.done) {
				const pair = /^([\w-]+)=(.*)$/s.exec(c.peek());
				if (!pair) {
					throw new ScriptError(`run ${name}: pass values as name=value`);
				}
				c.word();
				vars[pair[1]] = c.isQuote() && pair[2] === '' ? c.quoted()! : pair[2];
			}
			return { action: 'flow', flow: name, ...(Object.keys(vars).length ? { vars } : {}), ...extra };
		}
	}
	throw new ScriptError(`unknown step ${verbWord}`);
}

/** Replaces `${name}` with `vars[name]`; a missing value is an error, so a flow never types the placeholder. */
export function fillVars(script: string, vars: Readonly<Record<string, string>> | undefined): string | { readonly error: string } {
	const missing = new Set<string>();
	const filled = script.replace(/\$\{([\w-]+)\}/g, (whole, name: string) => {
		const value = vars?.[name];
		if (value === undefined) {
			missing.add(name);
			return whole;
		}
		return value;
	});
	return missing.size ? { error: `missing value${missing.size > 1 ? 's' : ''} for ${[...missing].map(name => `\${${name}}`).join(', ')}: pass vars` } : filled;
}

/**
 * One step per line; `;` also separates steps on one line when a step word follows it and it is
 * not inside quotes (`type "Name" Ada; click "Next"`). Text with `; click` in it must be quoted.
 */
function splitSteps(script: string): string[] {
	const out: string[] = [];
	let quote = '';
	let start = 0;
	for (let i = 0; i < script.length; i++) {
		const ch = script[i];
		if (quote) {
			if (ch === '\\') {
				i++;
			} else if (ch === quote || ch === '\n') {
				quote = '';
			}
			continue;
		}
		// allow-any-unicode-next-line
		if (ch === '"' || ch === '“' || ch === '‘') {
			// allow-any-unicode-next-line
			quote = ch === '“' ? '”' : ch === '‘' ? '’' : ch;
		} else if (ch === '\n') {
			out.push(script.slice(start, i));
			start = i + 1;
		} else if (ch === ';') {
			const next = /^\s*(\??\s*[a-z]+)/i.exec(script.slice(i + 1));
			const word = next?.[1].replace(/^\?\s*/, '').toLowerCase();
			if (word && (VERBS[word] || word === 'try')) {
				out.push(script.slice(start, i));
				start = i + 1;
			}
		}
	}
	out.push(script.slice(start));
	return out.map(line => line.replace(/\r$/, ''));
}

/** Parses a step script into steps (see the format above). Errors name the line. */
export function parseActScript(script: string, vars?: Readonly<Record<string, string>>): { readonly steps: readonly IActStep[] } | { readonly error: string } {
	const filled = fillVars(script, vars);
	if (typeof filled !== 'string') {
		return filled;
	}
	const steps: IActStep[] = [];
	const lines = splitSteps(filled);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line || line.startsWith('#') || line.startsWith('//')) {
			continue;
		}
		try {
			steps.push(parseLine(line));
		} catch (err) {
			if (err instanceof ScriptError) {
				return { error: `Line ${JSON.stringify(line)}: ${err.message}` };
			}
			throw err;
		}
	}
	if (!steps.length) {
		return { error: 'The script has no steps.' };
	}
	if (steps.length > MAX_ACT_STEPS) {
		return { error: `At most ${MAX_ACT_STEPS} steps per call; split the script or save parts as flows.` };
	}
	return { steps };
}

function q(value: string): string {
	return JSON.stringify(value);
}

/** A locator in script form. */
export function formatTarget(locator: IPageLocator, bare: 'text' | 'label' = 'text'): string {
	let out: string;
	if (locator.ref) {
		out = locator.ref;
	} else if (locator.role) {
		out = locator.name !== undefined ? `${locator.role} ${q(locator.name)}` : locator.role;
	} else if (locator.label !== undefined) {
		out = bare === 'label' ? q(locator.label) : `label ${q(locator.label)}`;
	} else if (locator.text !== undefined) {
		out = bare === 'text' ? q(locator.text) : `text ${q(locator.text)}`;
	} else if (locator.placeholder !== undefined) {
		out = `placeholder ${q(locator.placeholder)}`;
	} else {
		out = `css ${q(locator.selector ?? '')}`;
	}
	if (locator.within) {
		out += ` in ${formatTarget(locator.within)}`;
	}
	if (locator.nth !== undefined) {
		out += ` #${locator.nth}`;
	}
	if (locator.exact) {
		out += ' exact';
	}
	return out;
}

function formatExpectation(e: IPageExpectation): string {
	const parts: string[] = [];
	if (e.text !== undefined) {
		parts.push(q(e.text));
	}
	if (e.textGone !== undefined) {
		parts.push(`gone ${q(e.textGone)}`);
	}
	if (e.url !== undefined) {
		parts.push(`url ${q(e.url)}`);
	}
	if (e.title !== undefined) {
		parts.push(`title ${q(e.title)}`);
	}
	if (e.target) {
		if (e.count !== undefined) {
			parts.push(`count ${formatTarget(e.target)} ${e.count}`);
		} else if (e.value !== undefined) {
			parts.push(`${formatTarget(e.target)} = ${q(e.value)}`);
		} else {
			parts.push(`${formatTarget(e.target)} ${e.state ?? 'visible'}`);
		}
	}
	return parts.join(' and ');
}

/** Steps back to a script (to save JSON steps as a readable flow). */
export function formatActScript(steps: readonly IActStep[]): string {
	return steps.map(step => {
		const head = step.optional ? '? ' : '';
		const arrow = step.expect && step.action !== 'wait' && step.action !== 'expect' ? ` => ${formatExpectation(step.expect)}` : '';
		switch (step.action) {
			case 'navigate': return `${head}goto ${step.url}${arrow}`;
			case 'click': return `${head}${step.double ? 'dblclick' : step.button === 'right' ? 'rclick' : 'click'} ${formatTarget(step.target!)}${arrow}`;
			case 'hover': return `${head}hover ${formatTarget(step.target!)}${arrow}`;
			case 'type': return `${head}${step.submit ? 'submit' : 'type'} ${formatTarget(step.target!, 'label')} ${step.text ?? ''}${arrow}`;
			case 'press': return `${head}press ${step.key}${step.target ? ` in ${formatTarget(step.target, 'label')}` : ''}${arrow}`;
			case 'select': return `${head}select ${formatTarget(step.target!, 'label')} ${step.values!.map(q).join(' ')}${arrow}`;
			case 'check':
			case 'uncheck': return `${head}${step.action} ${formatTarget(step.target!, 'label')}${arrow}`;
			case 'scroll': {
				const dir = step.deltaX ? (step.deltaX < 0 ? 'left' : 'right') : (step.deltaY ?? 600) < 0 ? 'up' : 'down';
				return `${head}scroll${step.target ? ` ${formatTarget(step.target)}` : ''} ${dir}${step.until ? ` until ${formatTarget(step.until)}` : ''}${arrow}`;
			}
			case 'wait': return `${head}wait ${step.expect ? formatExpectation(step.expect) : `${step.ms ?? 0}ms`}`;
			case 'expect': return `${head}expect ${formatExpectation(step.expect!)}`;
			case 'back':
			case 'reload': return `${head}${step.action}${arrow}`;
			case 'flow': return `${head}run ${step.flow}${Object.entries(step.vars ?? {}).map(([key, value]) => ` ${key}=${value}`).join('')}`;
			case 'menu': return `${head}menu ${step.values!.join(' > ')}${arrow}`;
		}
	}).join('\n');
}
