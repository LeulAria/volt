/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { raceTimeout, timeout } from '../../../../../base/common/async.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatActScript, parseActScript } from '../../../../services/voltRuntime/common/tools/actScript.js';
import { describeLocator, IActStep, IPageLocator, IPageView, parseActSteps } from '../../../../services/voltRuntime/common/tools/pageModel.js';
import { formatActRun, formatFlowRuns, IActDriver, IFlowRun, IPageSnapshotBase, pageStateLines, runActSteps, settle } from '../../browser/preview/browserAct.js';
import { expectScript, IExpectResult, ILocateResult, locateScript, selectOptionScript, setValueScript, SNAPSHOT_SCRIPT, focusScript, targetScript } from '../../browser/preview/browserAutomationScripts.js';
import { CATALOG_PAGE, LOGIN_PAGE, SETTINGS_PAGE, TODO_PAGE, TRICKY_PAGE, WIZARD_PAGE } from './browserActFixtures.js';
import { LEGACY_SNAPSHOT_SCRIPT } from './browserActLegacy.js';

type FrameWindow = Window & typeof globalThis & { eval(code: string): unknown };

/**
 * The page inside an iframe, driven the way the in-app browser drives a webview: scripts run in
 * the page's own global scope, results cross as JSON, and input arrives as DOM events with the
 * browser's default actions (focus on mousedown, activation on click, implicit form submit).
 */
class FrameDriver implements IActDriver {
	constructor(readonly frame: HTMLIFrameElement) { }

	private get win(): FrameWindow {
		return this.frame.contentWindow as FrameWindow;
	}

	private get doc(): Document {
		return this.frame.contentDocument!;
	}

	async run<T>(code: string, ms: number): Promise<T | undefined> {
		try {
			const value = await raceTimeout(Promise.resolve(this.win.eval(code)), ms);
			return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as T;
		} catch {
			return undefined;
		}
	}

	canSendInput(): boolean {
		return true;
	}

	click(x: number, y: number, button: 'left' | 'right' | 'middle', double: boolean): void {
		const el = this.doc.elementFromPoint(x, y) as HTMLElement | null;
		if (!el) {
			return;
		}
		const init: MouseEventInit = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: button === 'right' ? 2 : button === 'middle' ? 1 : 0, view: this.win };
		el.dispatchEvent(new this.win.MouseEvent('mousedown', init));
		el.closest<HTMLElement>('input,select,textarea,button,a[href],[tabindex],[contenteditable]')?.focus();
		el.dispatchEvent(new this.win.MouseEvent('mouseup', init));
		if (button === 'left') {
			el.click();
		} else {
			el.dispatchEvent(new this.win.MouseEvent('contextmenu', init));
		}
		if (double) {
			el.dispatchEvent(new this.win.MouseEvent('dblclick', init));
		}
	}

	move(x: number, y: number): void {
		const el = this.doc.elementFromPoint(x, y);
		el?.dispatchEvent(new this.win.MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
		el?.dispatchEvent(new this.win.MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
	}

	press(combo: string): void {
		const key = combo.split('+').pop() ?? combo;
		const target = (this.doc.activeElement ?? this.doc.body) as HTMLElement;
		const down = new this.win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
		target.dispatchEvent(down);
		if (key === 'Enter' && !down.defaultPrevented && target instanceof this.win.HTMLInputElement && target.form) {
			target.form.requestSubmit();
		}
		target.dispatchEvent(new this.win.KeyboardEvent('keyup', { key, bubbles: true }));
	}

	async insertText(text: string): Promise<boolean> {
		return this.doc.execCommand('insertText', false, text);
	}

	isLoading(): boolean {
		return false;
	}

	async waitForLoad(): Promise<boolean> {
		return true;
	}

	async navigate(): Promise<boolean> {
		return true;
	}

	async history(): Promise<void> { }
}

async function load(frame: HTMLIFrameElement, html: string): Promise<FrameDriver> {
	await new Promise<void>(resolve => {
		frame.onload = () => resolve();
		frame.srcdoc = html;
	});
	await timeout(30);
	return new FrameDriver(frame);
}

function fromScript(script: string): readonly IActStep[] {
	const parsed = parseActScript(script);
	if ('error' in parsed) {
		throw new Error(parsed.error);
	}
	return parsed.steps;
}

function act(steps: unknown[]): readonly IActStep[] {
	const parsed = parseActSteps(steps);
	if ('error' in parsed) {
		throw new Error(parsed.error);
	}
	return parsed.steps;
}

//#region Benchmark harness

/** ~4 characters per token: the usual estimate for English, code and JSON. */
function tokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Anthropic's estimate for an image: width × height / 750 tokens; a 1024×768 screenshot is ~1,049. */
const SCREENSHOT_TOKENS = Math.round(1024 * 768 / 750);

/**
 * How long a model turn takes, as stated assumptions (the same for every protocol): time to the
 * first token, prefill of the input that is new since the last turn (the rest is cached), the
 * reasoning the model writes before a call, and decoding the call itself.
 */
const MODEL = {
	ttftMs: 700,
	prefillMsPerToken: 0.2,
	decodeMsPerToken: 12.5,
	reasoningTokens: 25,
	finalAnswerTokens: 20,
};

interface ICall {
	readonly tool: string;
	/** What the model writes to make the call (the tool input). */
	readonly args: string;
	/** What comes back to the model. */
	readonly text: string;
	readonly imageTokens?: number;
	readonly ms: number;
}

interface IProtocolResult {
	readonly calls: ICall[];
	readonly correct: boolean;
	readonly failures: string[];
}

interface ITask {
	readonly name: string;
	/** The name it is saved under as a flow. */
	readonly flow: string;
	readonly html: string;
	/** The flow as `browser_act` calls: one array per call (a careful agent reads each new page first). */
	readonly acts: readonly (readonly unknown[])[];
	/** Checked in the page at the end: did the task really get done. */
	readonly done: string;
}

const TASKS: readonly ITask[] = [
	{
		name: 'Sign in',
		flow: 'sign-in',
		html: LOGIN_PAGE,
		acts: [[
			{ action: 'type', target: { label: 'Email' }, text: 'ada@example.com' },
			{ action: 'type', target: { label: 'Password' }, text: 'correct horse' },
			{ action: 'check', target: { label: 'Remember me' } },
			{ action: 'click', target: { role: 'button', name: 'Sign in' }, expect: { text: 'Welcome back, Ada' } },
		]],
		done: `document.body.innerText.includes('Welcome back, Ada') && location.hash === '#/dashboard'`,
	},
	{
		name: 'Todos',
		flow: 'todos',
		html: TODO_PAGE,
		acts: [[
			{ action: 'type', target: { placeholder: 'What needs to be done?' }, text: 'Buy milk', submit: true },
			{ action: 'type', target: { placeholder: 'What needs to be done?' }, text: 'Walk dog', submit: true },
			{ action: 'type', target: { placeholder: 'What needs to be done?' }, text: 'Write report', submit: true },
			{ action: 'check', target: { role: 'checkbox', within: { text: 'Walk dog' } } },
			{ action: 'click', target: { role: 'button', name: 'Delete', within: { text: 'Buy milk' } } },
			{ action: 'expect', text: '1 item left' },
			{ action: 'expect', target: { role: 'listitem', within: { role: 'list', name: 'Todos' } }, count: 2 },
		]],
		done: `document.getElementById('count').textContent === '1 item left' && [...document.querySelectorAll('.todo-list li')].map(li => li.innerText.replace('×', '').trim()).join('|') === 'Walk dog|Write report' && document.querySelector('.todo-list li.done') !== null`,
	},
	{
		name: 'Settings + dialog',
		flow: 'settings',
		html: SETTINGS_PAGE,
		acts: [[
			{ action: 'check', target: { role: 'switch', name: 'Email notifications' } },
			{ action: 'select', target: { role: 'combobox', name: 'Theme' }, values: ['Dark'] },
			{ action: 'click', target: { role: 'button', name: 'Save changes' } },
		], [
			{ action: 'click', target: { role: 'button', name: 'Save', within: { role: 'dialog' } }, expect: { text: 'Settings saved' } },
		]],
		done: `document.querySelector('[aria-label="Email notifications"]').getAttribute('aria-checked') === 'true' && document.getElementById('theme').textContent === 'Dark' && document.getElementById('toast').textContent === 'Settings saved'`,
	},
	{
		name: 'Catalog (300 rows)',
		flow: 'catalog',
		html: CATALOG_PAGE,
		acts: [[
			{ action: 'type', target: { role: 'searchbox', name: 'Search products' }, text: 'lamp' },
			{ action: 'expect', text: 'Showing 3 of 300' },
			{ action: 'click', target: { role: 'button', name: 'Details', within: { text: 'Desk Lamp', exact: true } } },
			{ action: 'expect', text: 'Desk Lamp — $49' },
		]],
		done: `document.getElementById('details').innerText.includes('Desk Lamp — $49') && document.getElementById('shown').textContent === 'Showing 3 of 300'`,
	},
	{
		name: 'Signup wizard (3 steps)',
		flow: 'signup',
		html: WIZARD_PAGE,
		acts: [[
			{ action: 'type', target: { label: 'Full name' }, text: 'Ada Lovelace' },
			{ action: 'type', target: { label: 'Work email' }, text: 'ada@example.com' },
			{ action: 'click', target: { role: 'button', name: 'Next' }, expect: { text: 'Step 2 of 3' } },
		], [
			{ action: 'select', target: { label: 'Country' }, values: ['Germany'] },
			{ action: 'check', target: { role: 'radio', name: 'Pro' } },
			{ action: 'click', target: { role: 'button', name: 'Next' }, expect: { text: 'Step 3 of 3' } },
		], [
			{ action: 'check', target: { label: 'I agree to the Terms' } },
			{ action: 'click', target: { role: 'button', name: 'Create account' }, expect: { text: 'Account created for Ada Lovelace' } },
		]],
		done: `document.getElementById('result').textContent === 'Account created for Ada Lovelace (Pro, Germany)'`,
	},
];

interface ILegacySnapshot {
	readonly url: string;
	readonly title: string;
	readonly yaml: string;
	readonly viewport?: { width: number; height: number; scrollY: number; scrollHeight: number };
}

/** The page state Volt's single-step tools returned before this change: the whole YAML tree, every time. */
async function legacyPageState(driver: FrameDriver): Promise<string> {
	const snap = await driver.run<ILegacySnapshot>(LEGACY_SNAPSHOT_SCRIPT, 10_000);
	if (!snap) {
		return '### Page state\n- The page did not answer (still loading or busy).';
	}
	const lines = ['### Page state', `- Page URL: ${snap.url}`, `- Page Title: ${snap.title || '(untitled)'}`];
	if (snap.viewport) {
		lines.push(`- Viewport: ${snap.viewport.width}×${snap.viewport.height}, scrolled ${snap.viewport.scrollY}/${Math.max(0, snap.viewport.scrollHeight - snap.viewport.height)}`);
	}
	lines.push('- Page Snapshot:', '```yaml', snap.yaml, '```');
	return lines.join('\n');
}

/** The page state lines the current tools return, remembering what the agent has seen. */
class Observer {
	private seen: IPageView | undefined;
	constructor(private readonly driver: FrameDriver) { }
	async state(observe: 'auto' | 'full'): Promise<string> {
		const snap = await this.driver.run<IPageSnapshotBase>(SNAPSHOT_SCRIPT, 10_000);
		if (!snap) {
			return '### Page state\n- The page did not answer (still loading or busy).';
		}
		const result = pageStateLines(snap, { previous: this.seen, observe });
		if (result.page) {
			this.seen = result.page;
		}
		return ['### Page state', ...result.lines].join('\n');
	}
}

async function findRef(driver: FrameDriver, locator: IPageLocator): Promise<string | undefined> {
	return (await driver.run<ILocateResult>(locateScript(locator), 5000))?.ref;
}

async function holds(driver: FrameDriver, step: IActStep): Promise<boolean> {
	return !!step.expect && !!(await driver.run<IExpectResult>(expectScript(step.expect), 5000))?.ok;
}

/**
 * An agent on Volt's single-step tools, as before this change: it reads the page, then makes one
 * call per click or keystroke, each answered with the full page after a fixed 100 ms settle. When
 * the page has not caught up (the element it needs, or the result it expects, is not in an answer
 * yet) it calls browser_wait_for, which also answers with the full page.
 * `modern` swaps in today's answers (effect + changes only) and quiet-based settle, as an ablation.
 */
async function runClassic(driver: FrameDriver, task: ITask, modern: boolean): Promise<IProtocolResult> {
	const calls: ICall[] = [];
	const failures: string[] = [];
	const observer = new Observer(driver);
	/** Elements the agent has seen in some answer (it can act on their refs), with their states then. */
	const seen = new Map<string, readonly string[]>();
	/** The page text when the last answer was taken: what the agent knows has happened. */
	let lastBody = '';
	const answer = async (tool: string, args: object, header: string[], started: number) => {
		const state = modern ? await observer.state('auto') : await legacyPageState(driver);
		const ms = Date.now() - started;
		calls.push({ tool, args: JSON.stringify(args), text: [...header, '', state].join('\n'), ms });
		const now = await driver.run<IPageSnapshotBase>(SNAPSHOT_SCRIPT, 10_000);
		for (const node of now?.nodes ?? []) {
			if (node.ref) {
				seen.set(node.ref, node.states ?? []);
			}
		}
		lastBody = await driver.run<string>('document.body.innerText', 5000) ?? '';
	};
	const settleAfter = async () => {
		if (modern) {
			await settle(driver, CancellationToken.None);
		} else {
			// Volt's settle before this change: a fixed beat, then one more.
			await timeout(60);
			await timeout(40);
		}
	};
	const waitFor = async (what: string, check: () => Promise<boolean>) => {
		const started = Date.now();
		const deadline = started + 10_000;
		while (!await check() && Date.now() < deadline) {
			await timeout(100);
		}
		await answer('browser_wait_for', { text: what }, ['### Action: wait for', `- Text: ${JSON.stringify(what)}`], started);
	};
	/** The ref the agent reads off an answer; when the element is not in one yet, it waits (one more call). */
	const refFor = async (locator: IPageLocator): Promise<string | undefined> => {
		let ref = await findRef(driver, locator);
		if (!ref || !seen.has(ref)) {
			await waitFor(locator.name ?? locator.label ?? locator.text ?? locator.placeholder ?? '', async () => !!(ref = await findRef(driver, locator)));
		}
		return ref;
	};
	const click = async (ref: string, element: string, started: number) => {
		const hit = await driver.run<{ x: number; y: number }>(targetScript(ref), 5000);
		driver.click(hit!.x, hit!.y, 'left', false);
		await settleAfter();
		await answer('browser_click', { element, ref }, ['### Action: click', `- Element: ${element}`, `- Ref: ${ref}`, '- Click type: single-click', '- Button: left'], started);
	};

	let started = Date.now();
	await answer('browser_snapshot', {}, [], started);
	for (const step of task.acts.flat().map(raw => act([raw])[0])) {
		started = Date.now();
		const element = describeLocator(step.target ?? {});
		switch (step.action) {
			case 'type': {
				const ref = await refFor(step.target!);
				if (!ref) { failures.push(`no ${element}`); break; }
				await driver.run(focusScript(ref, true), 5000);
				if (!await driver.insertText(step.text ?? '')) {
					await driver.run(setValueScript(ref, step.text ?? '', true), 5000);
				}
				if (step.submit) {
					driver.press('Enter');
				}
				await settleAfter();
				await answer('browser_type', { element, ref, text: step.text, ...(step.submit ? { submit: true } : {}) }, ['### Action: type', `- Element: ${element}`, `- Ref: ${ref}`, `- Text: ${JSON.stringify(step.text)}`, ...(step.submit ? ['- Submitted: yes'] : [])], started);
				break;
			}
			case 'click':
			case 'check': {
				const ref = await refFor(step.target!);
				if (!ref) { failures.push(`no ${element}`); break; }
				if (step.action === 'check' && seen.get(ref)?.includes('checked')) {
					break; // the agent sees it is already checked
				}
				await click(ref, element, started);
				break;
			}
			case 'select': {
				const ref = await refFor(step.target!);
				if (!ref) { failures.push(`no ${element}`); break; }
				const picked = await driver.run<{ error?: string }>(selectOptionScript(ref, step.values!), 5000);
				if (picked?.error) {
					// A custom dropdown: click it open, then click the option (two calls).
					await click(ref, element, started);
					started = Date.now();
					const option = await refFor({ role: 'option', name: step.values![0] });
					await click(option!, `option ${step.values![0]}`, started);
				} else {
					await settleAfter();
					await answer('browser_select_option', { element, ref, values: step.values }, ['### Action: select option', `- Element: ${element}`, `- Ref: ${ref}`, `- Selected: ${step.values!.join(', ')}`], started);
				}
				break;
			}
		}
		// The agent checks the expected result against the answers it got; until it shows, it waits.
		const expected = step.expect;
		if (expected) {
			// Text it can look for in the last answer; other conditions (counts, states) it reads off the tree.
			const known = expected.text ? lastBody.includes(expected.text) : await holds(driver, step);
			if (!known) {
				await waitFor(expected.text ?? JSON.stringify(expected), () => holds(driver, step));
			}
		}
	}
	const correct = !!await driver.run<boolean>(`(() => { try { return !!(${task.done}); } catch { return false; } })()`, 5000);
	return { calls, correct, failures };
}

/**
 * The screenshot-and-coordinates loop that pixel computer-use agents run (Anthropic's computer-use
 * tool, Codex computer use): every action is a turn answered with a fresh screenshot, a field is
 * clicked before it is typed into, and a result that has not rendered yet costs another screenshot.
 * Simulated with perfect aim (every click lands where the element is), which flatters it: real
 * pixel agents also misclick and re-try.
 */
async function runPixel(driver: FrameDriver, task: ITask): Promise<IProtocolResult> {
	const calls: ICall[] = [];
	const failures: string[] = [];
	const seen = new Map<string, readonly string[]>();
	let lastBody = '';
	const screenshot = async (args: object, started: number) => {
		// The loop's screenshot after an action (Volt's old fixed settle, the shortest common one).
		await timeout(100);
		calls.push({ tool: 'computer', args: JSON.stringify(args), text: '(screenshot)', imageTokens: SCREENSHOT_TOKENS, ms: Date.now() - started });
		const now = await driver.run<IPageSnapshotBase>(SNAPSHOT_SCRIPT, 10_000);
		for (const node of now?.nodes ?? []) {
			if (node.ref) {
				seen.set(node.ref, node.states ?? []);
			}
		}
		lastBody = await driver.run<string>('document.body.innerText', 5000) ?? '';
	};
	const waitShot = async (check: () => Promise<boolean>) => {
		const started = Date.now();
		while (!await check() && Date.now() - started < 10_000) {
			await timeout(100);
		}
		await screenshot({ action: 'wait', duration: 1 }, started);
	};
	/** Where the agent sees the element; when no screenshot showed it yet, it takes another. */
	const pointAt = async (locator: IPageLocator): Promise<{ x: number; y: number; ref: string } | undefined> => {
		let ref = await findRef(driver, locator);
		if (!ref || !seen.has(ref)) {
			await waitShot(async () => !!(ref = await findRef(driver, locator)));
		}
		const hit = ref ? await driver.run<{ x: number; y: number }>(targetScript(ref), 5000) : undefined;
		return hit && ref ? { ...hit, ref } : undefined;
	};
	const clickAt = async (at: { x: number; y: number }, started: number) => {
		driver.click(at.x, at.y, 'left', false);
		await screenshot({ action: 'left_click', coordinate: [at.x, at.y] }, started);
	};
	let started = Date.now();
	await screenshot({ action: 'screenshot' }, started);
	for (const step of task.acts.flat().map(raw => act([raw])[0])) {
		started = Date.now();
		switch (step.action) {
			case 'type': {
				const at = await pointAt(step.target!);
				if (!at) { failures.push('no field'); break; }
				await clickAt(at, started);
				started = Date.now();
				await driver.run(focusScript(at.ref, true), 5000);
				if (!await driver.insertText(step.text ?? '')) {
					await driver.run(setValueScript(at.ref, step.text ?? '', true), 5000);
				}
				if (step.submit) {
					driver.press('Enter');
				}
				await screenshot({ action: 'type', text: `${step.text}${step.submit ? '\n' : ''}` }, started);
				break;
			}
			case 'click':
			case 'check': {
				const at = await pointAt(step.target!);
				if (!at) { failures.push('no target'); break; }
				if (step.action === 'check' && seen.get(at.ref)?.includes('checked')) {
					break;
				}
				await clickAt(at, started);
				break;
			}
			case 'select': {
				// Open the dropdown, then pick the option: by its row in a custom list, by typing its name in a native one.
				const at = await pointAt(step.target!);
				if (!at) { failures.push('no dropdown'); break; }
				const native = await driver.run<{ error?: string }>(selectOptionScript(at.ref, step.values!), 5000);
				await clickAt(at, started);
				started = Date.now();
				if (native?.error) {
					const option = await pointAt({ role: 'option', name: step.values![0] });
					await clickAt(option!, started);
				} else {
					await screenshot({ action: 'type', text: `${step.values![0]}\n` }, started);
				}
				break;
			}
		}
		const expected = step.expect;
		if (expected) {
			const known = expected.text ? lastBody.includes(expected.text) : await holds(driver, step);
			if (!known) {
				await waitShot(() => holds(driver, step));
			}
		}
	}
	const correct = !!await driver.run<boolean>(`(() => { try { return !!(${task.done}); } catch { return false; } })()`, 5000);
	return { calls, correct, failures };
}

/**
 * An agent on `browser_act`: it reads the page once, then runs each page's steps in one call,
 * reading what changed in between. `form`: JSON steps or the step script (the last call reports
 * only failures; the ones before show the next page).
 */
async function runAct(driver: FrameDriver, task: ITask, form: 'json' | 'script', observe: 'auto' | 'full' = 'auto'): Promise<IProtocolResult> {
	const calls: ICall[] = [];
	const failures: string[] = [];
	const observer = new Observer(driver);
	let started = Date.now();
	calls.push({ tool: 'browser_snapshot', args: '{}', text: await observer.state('full'), ms: Date.now() - started });
	for (let i = 0; i < task.acts.length; i++) {
		const json = act([...task.acts[i]]);
		const script = formatActScript(json);
		// The script form runs from the script the model would write, parsed like the tool parses it.
		const steps = form === 'script' ? fromScript(script) : json;
		const last = i === task.acts.length - 1;
		started = Date.now();
		const run = await runActSteps(driver, steps, CancellationToken.None);
		if (!run.ok) {
			failures.push(formatActRun(run).join('\n'));
		}
		const brief = form === 'script' && last && run.ok;
		const args = form === 'json' ? JSON.stringify({ steps: task.acts[i] }) : JSON.stringify({ script, ...(last ? { observe: 'on_failure' } : {}) });
		const state = brief ? '' : await observer.state(observe);
		calls.push({ tool: 'browser_act', args, text: [...formatActRun(run, 'browser_act', { brief }), ...(state ? ['', state] : [])].join('\n'), ms: Date.now() - started });
	}
	const correct = !!await driver.run<boolean>(`(() => { try { return !!(${task.done}); } catch { return false; } })()`, 5000);
	return { calls, correct, failures };
}

/** An agent that wrote the page: the whole flow as one script, saved as a flow, the page only on failure. */
async function runKnown(driver: FrameDriver, task: ITask): Promise<IProtocolResult> {
	const started = Date.now();
	const script = formatActScript(act(task.acts.flat()));
	const run = await runActSteps(driver, fromScript(script), CancellationToken.None);
	const snap = await driver.run<IPageSnapshotBase>(SNAPSHOT_SCRIPT, 10_000);
	const state = run.ok ? '' : ['### Page state', ...pageStateLines(snap!, { observe: 'auto' }).lines].join('\n');
	const text = [...formatActRun(run, 'browser_act', { brief: run.ok }), `- Saved as flow ${task.flow} (.volt/flows/${task.flow}.flow): re-run it with {"run": "${task.flow}"}.`, ...(state ? ['', state] : [])].join('\n');
	const args = JSON.stringify({ script, observe: 'on_failure', save: task.flow });
	const correct = !!await driver.run<boolean>(`(() => { try { return !!(${task.done}); } catch { return false; } })()`, 5000);
	return { calls: [{ tool: 'browser_act', args, text, ms: Date.now() - started }], correct, failures: run.ok ? [] : [formatActRun(run).join('\n')] };
}

interface IScore {
	readonly turns: number;
	/** Tokens the model writes: its tool inputs plus the reasoning before each call. */
	readonly outTokens: number;
	/** Tokens the tools return (text, and screenshots as image tokens). */
	readonly resultTokens: number;
	/** Context tokens re-read across the turns (each turn reads everything before it; the fixed system prompt is left out). */
	readonly contextTokens: number;
	readonly pageMs: number;
	readonly modelMs: number;
}

/** Turns, tokens and time of a protocol's calls, with one more turn that reads the last result and answers. */
function score(calls: readonly ICall[]): IScore {
	let context = 0;
	let contextTokens = 0;
	let modelMs = 0;
	let outTokens = 0;
	let resultTokens = 0;
	let fresh = 0;
	for (const call of calls) {
		const out = tokens(call.args) + MODEL.reasoningTokens;
		modelMs += MODEL.ttftMs + fresh * MODEL.prefillMsPerToken + out * MODEL.decodeMsPerToken;
		contextTokens += context;
		const result = tokens(call.text) + (call.imageTokens ?? 0);
		context += out + result;
		outTokens += out;
		resultTokens += result;
		fresh = result;
	}
	modelMs += MODEL.ttftMs + fresh * MODEL.prefillMsPerToken + MODEL.finalAnswerTokens * MODEL.decodeMsPerToken;
	contextTokens += context;
	return { turns: calls.length + 1, outTokens: outTokens + MODEL.finalAnswerTokens, resultTokens, contextTokens, pageMs: calls.reduce((sum, call) => sum + call.ms, 0), modelMs };
}

function add(a: IScore, b: IScore): IScore {
	return { turns: a.turns + b.turns, outTokens: a.outTokens + b.outTokens, resultTokens: a.resultTokens + b.resultTokens, contextTokens: a.contextTokens + b.contextTokens, pageMs: a.pageMs + b.pageMs, modelMs: a.modelMs + b.modelMs };
}

const ZERO: IScore = { turns: 0, outTokens: 0, resultTokens: 0, contextTokens: 0, pageMs: 0, modelMs: 0 };

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function times(base: number, value: number): string {
	return `${(base / Math.max(1, value)).toFixed(base / Math.max(1, value) >= 10 ? 0 : 1)}×`;
}

//#endregion

suite('Browser act', function () {

	this.timeout(120_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let frame: HTMLIFrameElement;

	setup(() => {
		frame = mainWindow.document.createElement('iframe');
		frame.style.cssText = 'position:fixed;left:0;top:0;width:1024px;height:768px;border:0;background:#fff;z-index:99999';
		mainWindow.document.body.appendChild(frame);
	});

	teardown(() => {
		frame.remove();
	});

	test('each fixture task completes and verifies through browser_act', async () => {
		for (const task of TASKS) {
			const driver = await load(frame, task.html);
			const result = await runAct(driver, task, 'script');
			assert.deepStrictEqual(result.failures, [], `${task.name}:\n${result.failures.join('\n')}`);
			assert.ok(result.correct, `${task.name}: the page did not reach the done state`);
		}
	});

	test('ambiguous targets fail with candidates instead of guessing; "within" picks the row', async () => {
		const driver = await load(frame, TRICKY_PAGE);
		const ambiguous = await runActSteps(driver, act([{ action: 'click', target: { role: 'button', name: 'Delete' } }]), CancellationToken.None);
		assert.strictEqual(ambiguous.ok, false);
		assert.strictEqual(ambiguous.results[0].code, 'AMBIGUOUS');
		assert.match(ambiguous.results[0].detail, /2 elements match .*Project A.*Project B/s);
		assert.strictEqual(await driver.run<number>(`document.querySelectorAll('main li').length`, 1000), 2, 'nothing was clicked');

		const scoped = await runActSteps(driver, act([{ action: 'click', target: { role: 'button', name: 'Delete', within: { text: 'Project B' } } }]), CancellationToken.None);
		assert.ok(scoped.ok, formatActRun(scoped).join('\n'));
		assert.strictEqual(await driver.run<string>(`document.querySelector('main ul').innerText.trim()`, 1000), 'Project A Delete');
	});

	test('waits for an element that renders late, and reports what the click did', async () => {
		const driver = await load(frame, TRICKY_PAGE);
		const run = await runActSteps(driver, act([
			{ action: 'click', target: 'Load more' },
			{ action: 'click', target: { role: 'button', name: 'Late button' }, expect: { text: 'late clicked' } },
		]), CancellationToken.None);
		assert.ok(run.ok, formatActRun(run).join('\n'));
		assert.match(run.results[1].detail, /DOM change/);
	});

	test('a click that does nothing is flagged; a failed expectation stops the run and skips the rest', async () => {
		const driver = await load(frame, TRICKY_PAGE);
		const run = await runActSteps(driver, act([
			{ action: 'click', target: { text: 'Just some text.' } },
			{ action: 'expect', text: 'Never shown', timeoutMs: 300 },
			{ action: 'click', target: 'Covered button' },
		]), CancellationToken.None);
		assert.match(run.results[0].detail, /nothing on the page reacted/);
		assert.strictEqual(run.results[1].code, 'VERIFY_FAILED');
		assert.strictEqual(run.results[2].status, 'skipped');
		assert.strictEqual(await driver.run<string>(`document.getElementById('covered-count').textContent`, 1000), '0');
	});

	test('a click through an overlay that stays goes to the element directly, and says so', async () => {
		const driver = await load(frame, TRICKY_PAGE);
		await driver.run(`(() => { const o = document.createElement('div'); o.id = 'overlay'; document.body.appendChild(o); })()`, 1000);
		const run = await runActSteps(driver, act([{ action: 'click', target: 'Covered button' }]), CancellationToken.None);
		assert.ok(run.ok);
		assert.match(run.results[0].detail, /covered by `div#overlay`/);
		assert.strictEqual(await driver.run<string>(`document.getElementById('covered-count').textContent`, 1000), '1');
	});

	test('check is idempotent, stale refs fail clearly, and passwords never come back', async () => {
		const driver = await load(frame, TRICKY_PAGE);
		const run = await runActSteps(driver, act([
			{ action: 'check', target: { label: 'Already agreed' } },
			{ action: 'type', target: { label: 'Password' }, text: 'hunter2-very-secret' },
		]), CancellationToken.None);
		assert.ok(run.ok, formatActRun(run).join('\n'));
		assert.match(run.results[0].detail, /already checked/);
		const text = formatActRun(run).join('\n');
		assert.ok(!text.includes('hunter2'), text);
		const snapshot = await new Observer(driver).state('full');
		assert.ok(!snapshot.includes('hunter2'), snapshot);

		const ref = await findRef(driver, { role: 'button', name: 'Delete', within: { text: 'Project A' } });
		await driver.run(`document.querySelector('main li').remove()`, 1000);
		const stale = await runActSteps(driver, act([{ action: 'click', target: ref }]), CancellationToken.None);
		assert.strictEqual(stale.results[0].code, 'STALE_REF');
	});

	test('a submit that leaves a request open stops the next action', async () => {
		const driver = await load(frame, TRICKY_PAGE);
		const run = await runActSteps(driver, act([
			{ action: 'click', target: 'Slow save' },
			{ action: 'click', target: 'Covered button' },
		]), CancellationToken.None);
		assert.match(run.results[0].detail, /still pending/);
		assert.strictEqual(run.results[1].status, 'skipped');
		assert.match(run.results[1].detail, /left 1 request open/);
	});

	test('benchmark: browser_act against the single-step tools', async () => {
		const protocols: { readonly key: string; readonly label: string; readonly run: (task: ITask) => Promise<IProtocolResult> }[] = [
			{ key: 'P', label: 'Screenshot + click loop (pixel computer use, perfect aim)', run: async task => runPixel(await load(frame, task.html), task) },
			{ key: 'A', label: 'Volt before: single-step tools, full YAML', run: async task => runClassic(await load(frame, task.html), task, false) },
			{ key: 'B', label: 'Ablation: single-step tools + compact diffs', run: async task => runClassic(await load(frame, task.html), task, true) },
			{ key: 'D', label: 'browser_act, JSON steps, reads the page first', run: async task => runAct(await load(frame, task.html), task, 'json') },
			{ key: 'S', label: 'browser_act, script, reads the page first', run: async task => runAct(await load(frame, task.html), task, 'script') },
			{ key: 'E', label: 'browser_act, script, agent wrote the page (1 call)', run: async task => runKnown(await load(frame, task.html), task) },
		];
		const totals = new Map<string, IScore>();
		const lines = ['', '#### Per task: model turns · tokens returned · modeled wall time', '', `| Task | ${protocols.map(p => p.key).join(' | ')} |`, `|---|${protocols.map(() => '---:').join('|')}|`];
		for (const task of TASKS) {
			const cells: string[] = [];
			for (const protocol of protocols) {
				const result = await protocol.run(task);
				assert.ok(result.correct, `${task.name} (${protocol.key}): the page did not reach the done state\n${result.failures.join('\n')}`);
				const s = score(result.calls);
				totals.set(protocol.key, add(totals.get(protocol.key) ?? ZERO, s));
				cells.push(`${s.turns} · ${s.resultTokens} · ${seconds(s.pageMs + s.modelMs)}`);
			}
			lines.push(`| ${task.name} | ${cells.join(' | ')} |`);
		}

		// After an edit: re-verify all five flows. The single-step and pixel agents do every task again;
		// with saved flows it is one call that runs them all (each flow opens its page first).
		const reverifyStarted = Date.now();
		const runs: IFlowRun[] = [];
		let reverifyCorrect = true;
		for (const task of TASKS) {
			const driver = await load(frame, task.html);
			const run = await runActSteps(driver, act(task.acts.flat()), CancellationToken.None);
			runs.push({ label: task.flow, run });
			reverifyCorrect &&= run.ok && !!await driver.run<boolean>(`(() => { try { return !!(${task.done}); } catch { return false; } })()`, 5000);
		}
		assert.ok(reverifyCorrect, formatFlowRuns(runs, 'browser_act').join('\n'));
		const reverify = score([{ tool: 'browser_act', args: JSON.stringify({ run: TASKS.map(task => task.flow) }), text: formatFlowRuns(runs, 'browser_act').join('\n'), ms: Date.now() - reverifyStarted }]);

		const p = totals.get('P')!;
		const a = totals.get('A')!;
		lines.push('', `#### All ${TASKS.length} tasks (model: ${MODEL.ttftMs} ms to first token, ${MODEL.prefillMsPerToken} ms per new input token, ${MODEL.decodeMsPerToken} ms per output token, ${MODEL.reasoningTokens} reasoning tokens per call; page time measured)`, '');
		lines.push('| Protocol | Turns | Tokens written | Tokens returned | Context re-read | Page | Model | Wall time | vs pixel loop | vs Volt before |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
		const show = (label: string, s: IScore) => {
			const wall = s.pageMs + s.modelMs;
			lines.push(`| ${label} | ${s.turns} | ${s.outTokens} | ${s.resultTokens} | ${s.contextTokens} | ${seconds(s.pageMs)} | ${seconds(s.modelMs)} | ${seconds(wall)} | ${times(p.pageMs + p.modelMs, wall)} faster, ${times(p.resultTokens, s.resultTokens)} fewer tokens | ${times(a.pageMs + a.modelMs, wall)} faster, ${times(a.resultTokens, s.resultTokens)} fewer tokens |`);
		};
		for (const protocol of protocols) {
			show(`${protocol.key}. ${protocol.label}`, totals.get(protocol.key)!);
		}
		show('R. Re-verify all 5 after an edit: run saved flows (1 call)', reverify);
		console.log(lines.join('\n'));

		const e = totals.get('E')!;
		assert.ok(e.turns * 3 < a.turns && e.resultTokens * 50 < a.resultTokens, 'browser_act should need far fewer turns and tokens than the single-step tools');
		assert.ok(reverify.resultTokens * 100 < a.resultTokens, 're-verifying with flows should return a hundredth of the tokens');
	});
});
