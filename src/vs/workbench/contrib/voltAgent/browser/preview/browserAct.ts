/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { actionEffect, describeEffect, describeExpectation, describeLocator, describeStep, hadNoEffect, IActionEffect, IActStep, IPageExpectation, IPageLocator, IPageNode, IPageProbe, IPageView, isActingStep, observePage, renderPage } from '../../../../services/voltRuntime/common/tools/pageModel.js';
import { clickFallbackScript, expectScript, focusScript, IExpectResult, ILocateResult, locateScript, PROBE_SCRIPT, quietScript, readStateScript, scrollScript, selectOptionScript, setValueScript, targetScript } from './browserAutomationScripts.js';

/**
 * Runs `browser_act` steps: each one resolves its target by meaning (waiting for it to appear and
 * become usable), acts, waits for the page to go quiet, measures what changed, and checks its
 * postcondition. It stops at the first failure with a reason the model can act on, and never
 * repeats an action whose outcome it could not confirm.
 */

/** The page the steps run in: the chat's browser tab, or a test page. */
export interface IActDriver {
	/** Runs a script in the page; undefined when it did not answer in time (busy, or the document went away). */
	run<T>(code: string, timeoutMs: number): Promise<T | undefined>;
	/** Trusted mouse and keyboard input is available (otherwise clicks go through `element.click()`). */
	canSendInput(): boolean;
	click(x: number, y: number, button: 'left' | 'right' | 'middle', double: boolean): void;
	move(x: number, y: number): void;
	/** A key or chord, e.g. "Enter", "Meta+a". */
	press(combo: string): void;
	/** Inserts text at the focus like typing (one input event). False when unsupported. */
	insertText(text: string): Promise<boolean>;
	isLoading(): boolean;
	waitForLoad(timeoutMs: number, token: CancellationToken): Promise<boolean>;
	navigate(url: string, token: CancellationToken): Promise<boolean>;
	history(action: 'back' | 'reload', token: CancellationToken): Promise<void>;
}

export type ActFailure =
	| 'NOT_FOUND'
	| 'AMBIGUOUS'
	| 'STALE_REF'
	| 'DISABLED'
	| 'NOT_EDITABLE'
	| 'VERIFY_FAILED'
	| 'PAGE_UNRESPONSIVE'
	| 'NAVIGATION_TIMEOUT'
	| 'BUSY'
	| 'CANCELLED';

export interface IActStepResult {
	readonly index: number;
	readonly step: IActStep;
	readonly status: 'ok' | 'failed' | 'skipped';
	readonly code?: ActFailure;
	/** What happened, for the model: the effect, notes, or why it failed. */
	readonly detail: string;
	readonly effect?: IActionEffect;
	readonly ms: number;
	/** The step typed into a password field. */
	readonly secret?: boolean;
}

export interface IActRunResult {
	readonly results: readonly IActStepResult[];
	readonly ok: boolean;
	readonly ms: number;
}

/** DOM quiet this long, and no request open, means the page is done reacting. */
export const SETTLE_QUIET_MS = 50;
/** Input needs a moment to reach the page before quiet means anything. */
const SETTLE_MIN_MS = 20;
const SETTLE_MAX_MS = 3000;
const LOCATE_TIMEOUT_MS = 3000;
const EXPECT_TIMEOUT_MS = 5000;
const ENABLE_WAIT_MS = 2000;
const POLL_MS = 40;
const SCRIPT_MS = 5000;

class StepError extends Error {
	constructor(readonly code: ActFailure, message: string) {
		super(message);
	}
}

function cancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new StepError('CANCELLED', 'cancelled');
	}
}

/** Reads the page's counters before an action. */
export function probe(driver: IActDriver): Promise<IPageProbe | undefined> {
	return driver.run<IPageProbe>(PROBE_SCRIPT, 3000);
}

/**
 * After input: waits until the DOM is quiet and no request is open (up to `maxMs`), following a
 * navigation if the input started one, and returns the counters then.
 */
export async function settle(driver: IActDriver, token: CancellationToken, maxMs = SETTLE_MAX_MS): Promise<IPageProbe | undefined> {
	await timeout(10);
	if (driver.isLoading()) {
		await driver.waitForLoad(15_000, token);
	}
	let after = await driver.run<IPageProbe>(quietScript(SETTLE_QUIET_MS, maxMs, SETTLE_MIN_MS), maxMs + 2000).catch(() => undefined);
	if (token.isCancellationRequested) {
		return after;
	}
	if (!after || driver.isLoading()) {
		// The document went away while we waited: a navigation. Wait for the new one.
		await driver.waitForLoad(15_000, token);
		after = await driver.run<IPageProbe>(quietScript(SETTLE_QUIET_MS, 1500, 0), 3500).catch(() => undefined) ?? after;
	}
	return after;
}

function locateFailure(locator: IPageLocator, result: ILocateResult | undefined, waitedMs: number): StepError {
	const what = describeLocator(locator);
	if (!result) {
		return new StepError('PAGE_UNRESPONSIVE', `the page did not answer while looking for ${what}`);
	}
	switch (result.error) {
		case 'stale':
			return new StepError('STALE_REF', `${locator.ref} is not on the page anymore (it re-rendered or navigated); target it by role/name/text instead, or take a new snapshot`);
		case 'ambiguous': {
			const options = (result.candidates ?? []).map(c => `${c.ref} ${c.role} ${JSON.stringify(c.name)}${c.near ? ` in ${c.near}` : ''}`).join('; ');
			return new StepError('AMBIGUOUS', `${result.count} elements match ${what}: ${options}. Use one of these refs, add "within", "exact" or "nth"`);
		}
		case 'nth':
			return new StepError('NOT_FOUND', `${what}: only ${result.count} equally good matches`);
		case 'selector':
			return new StepError('NOT_FOUND', `${what}: the CSS selector is invalid`);
		case 'not-within':
			return new StepError('NOT_FOUND', `${what} is not inside ${describeLocator(locator.within!)}`);
	}
	if (result.error?.startsWith('within-')) {
		const inner = result.error.slice('within-'.length);
		return new StepError(inner === 'ambiguous' ? 'AMBIGUOUS' : 'NOT_FOUND', `the container ${describeLocator(locator.within!)} ${inner === 'ambiguous' ? `matches ${result.count} elements${result.candidates?.length ? `: ${result.candidates.map(c => `${c.ref} ${c.role} ${JSON.stringify(c.name)}`).join('; ')}` : ''}` : 'was not found'}`);
	}
	const hidden = result.hidden ? ` (${result.hidden} hidden match${result.hidden === 1 ? '' : 'es'}: open the menu, tab or section that holds it first)` : '';
	return new StepError('NOT_FOUND', `no visible element matches ${what} after ${(waitedMs / 1000).toFixed(1)}s${hidden}`);
}

/** Finds the step's element, waiting for it to appear. Ambiguity fails at once: waiting will not fix it. */
async function resolve(driver: IActDriver, locator: IPageLocator, timeoutMs: number, token: CancellationToken): Promise<ILocateResult & { readonly ref: string }> {
	const started = Date.now();
	for (; ;) {
		cancelled(token);
		const result = await driver.run<ILocateResult>(locateScript(locator), SCRIPT_MS).catch(() => undefined);
		if (result?.ref) {
			return result as ILocateResult & { readonly ref: string };
		}
		const final = result?.error === 'ambiguous' || result?.error === 'stale' || result?.error === 'selector' || result?.error === 'not-within' || result?.error === 'within-ambiguous';
		if (final || Date.now() - started >= timeoutMs) {
			throw locateFailure(locator, result, Date.now() - started);
		}
		await timeout(POLL_MS);
	}
}

interface IElementState {
	readonly checked?: boolean | 'mixed';
	readonly value?: string;
	readonly shown?: string;
	readonly disabled?: boolean;
	readonly secret?: boolean;
	readonly error?: string;
}

function readState(driver: IActDriver, ref: string): Promise<IElementState | undefined> {
	return driver.run<IElementState>(readStateScript(ref), 3000).catch(() => undefined);
}

/** Buttons are often disabled until the form above them is valid: give the page a moment. */
async function waitEnabled(driver: IActDriver, located: ILocateResult & { readonly ref: string }, timeoutMs: number, token: CancellationToken): Promise<void> {
	if (!located.disabled) {
		return;
	}
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		cancelled(token);
		await timeout(POLL_MS);
		const state = await readState(driver, located.ref);
		if (state && !state.disabled) {
			return;
		}
	}
	throw new StepError('DISABLED', `${located.role} ${JSON.stringify(located.name ?? '')} [ref=${located.ref}] is disabled (a required field may be empty or invalid)`);
}

/** Polls a postcondition until it holds or the time runs out. */
export async function waitFor(driver: IActDriver, expectation: IPageExpectation, timeoutMs: number, token: CancellationToken): Promise<IExpectResult> {
	const started = Date.now();
	let last: IExpectResult | undefined;
	for (; ;) {
		cancelled(token);
		last = await driver.run<IExpectResult>(expectScript(expectation), SCRIPT_MS).catch(() => undefined) ?? last;
		if (last?.ok) {
			return last;
		}
		if (Date.now() - started >= timeoutMs) {
			return last ?? { ok: false, detail: 'the page did not answer' };
		}
		await timeout(POLL_MS);
	}
}

interface IClickOutcome {
	readonly effect?: IActionEffect;
	readonly notes: string[];
}

async function clickRef(driver: IActDriver, ref: string, step: Pick<IActStep, 'button' | 'double'>, token: CancellationToken): Promise<IClickOutcome> {
	const notes: string[] = [];
	let hit = await driver.run<{ x: number; y: number; covered?: string; error?: string }>(targetScript(ref), SCRIPT_MS);
	if (!hit || hit.error) {
		throw new StepError(hit ? 'STALE_REF' : 'PAGE_UNRESPONSIVE', hit ? `${ref} went away before the click` : 'the page did not answer');
	}
	if (hit.covered) {
		// An overlay may be animating away: give it a moment before clicking through it.
		const started = Date.now();
		while (hit?.covered && Date.now() - started < 600) {
			await timeout(POLL_MS);
			hit = await driver.run<{ x: number; y: number; covered?: string; error?: string }>(targetScript(ref), SCRIPT_MS) ?? hit;
		}
	}
	const before = await probe(driver);
	cancelled(token);
	if (hit?.covered || !driver.canSendInput()) {
		await driver.run(clickFallbackScript(ref), SCRIPT_MS);
		if (hit?.covered) {
			notes.push(`covered by \`${hit.covered}\`, so it was clicked directly`);
		}
	} else {
		driver.click(hit!.x, hit!.y, step.button ?? 'left', !!step.double);
	}
	const after = await settle(driver, token);
	return { effect: actionEffect(before, after), notes };
}

function masked(text: string): string {
	return `${'•'.repeat(Math.min(8, Math.max(1, text.length)))} (${text.length} chars, hidden)`;
}

async function runStep(driver: IActDriver, step: IActStep, token: CancellationToken): Promise<{ detail: string; effect?: IActionEffect; secret?: boolean }> {
	const locateMs = step.timeoutMs ?? LOCATE_TIMEOUT_MS;
	switch (step.action) {
		case 'navigate': {
			const before = await probe(driver);
			const loaded = await driver.navigate(step.url!, token);
			cancelled(token);
			const after = await settle(driver, token, 1500);
			const effect = actionEffect(before, after);
			if (!loaded) {
				throw new StepError('NAVIGATION_TIMEOUT', `${step.url} was still loading after 20s`);
			}
			return { detail: after ? `loaded ${after.url}` : 'loaded', effect };
		}
		case 'back':
		case 'reload': {
			const before = await probe(driver);
			await driver.history(step.action, token);
			const after = await settle(driver, token, 1500);
			return { detail: after ? `at ${after.url}` : 'done', effect: actionEffect(before, after) };
		}
		case 'click': {
			const located = await resolve(driver, step.target!, locateMs, token);
			await waitEnabled(driver, located, Math.min(locateMs, ENABLE_WAIT_MS), token);
			const { effect, notes } = await clickRef(driver, located.ref, step, token);
			return { detail: [`${located.role} ${JSON.stringify(located.name ?? '')} [ref=${located.ref}]`, describeEffect(effect), ...notes].join(' · '), effect };
		}
		case 'hover': {
			const located = await resolve(driver, step.target!, locateMs, token);
			const hit = await driver.run<{ x: number; y: number; error?: string }>(targetScript(located.ref), SCRIPT_MS);
			if (!hit || hit.error) {
				throw new StepError('STALE_REF', `${located.ref} went away`);
			}
			const before = await probe(driver);
			driver.move(hit.x, hit.y);
			const effect = actionEffect(before, await settle(driver, token));
			return { detail: `${located.role} ${JSON.stringify(located.name ?? '')} [ref=${located.ref}] · ${describeEffect(effect)}`, effect };
		}
		case 'type': {
			const located = await resolve(driver, step.target!, locateMs, token);
			await waitEnabled(driver, located, Math.min(locateMs, ENABLE_WAIT_MS), token);
			const clear = step.clear !== false;
			const text = step.text ?? '';
			const focus = await driver.run<{ error?: string; focused?: boolean; editable?: boolean }>(focusScript(located.ref, clear), SCRIPT_MS);
			if (!focus || focus.error) {
				throw new StepError(focus ? 'STALE_REF' : 'PAGE_UNRESPONSIVE', `${located.ref} went away before typing`);
			}
			if (!focus.editable) {
				throw new StepError('NOT_EDITABLE', `${located.role} ${JSON.stringify(located.name ?? '')} [ref=${located.ref}] does not take text`);
			}
			const before = await probe(driver);
			if (!await driver.insertText(text).catch(() => false)) {
				await driver.run(setValueScript(located.ref, text, clear), SCRIPT_MS);
			}
			let state = await readState(driver, located.ref);
			if (text && state && !state.error && !state.value) {
				// Some inputs ignore inserted text; set the value the way frameworks listen for.
				await driver.run(setValueScript(located.ref, text, clear), SCRIPT_MS);
				state = await readState(driver, located.ref);
			}
			if (step.submit) {
				driver.press('Enter');
			}
			const effect = actionEffect(before, await settle(driver, token));
			const secret = located.secret || state?.secret;
			const shown = secret ? masked(text) : JSON.stringify(text);
			const notes: string[] = [];
			if (text && state && !state.error && !state.value) {
				throw new StepError('VERIFY_FAILED', `typed ${shown} into ${located.role} ${JSON.stringify(located.name ?? '')} [ref=${located.ref}], but it is still empty`);
			}
			if (!secret && state?.value !== undefined && !state.error && (clear ? state.value !== text : !state.value.endsWith(text))) {
				notes.push(`the field now reads ${JSON.stringify(state.shown ?? state.value)} (the page reformatted it)`);
			}
			// The agent knows what it typed: name the field, not the text.
			return { detail: [`→ ${located.role} ${JSON.stringify(located.name ?? '')} [ref=${located.ref}]`, step.submit ? `submitted · ${describeEffect(effect)}` : undefined, ...notes].filter(Boolean).join(' · '), effect, secret: !!secret };
		}
		case 'press': {
			let where = '';
			if (step.target) {
				const located = await resolve(driver, step.target, locateMs, token);
				await driver.run(focusScript(located.ref, false), SCRIPT_MS);
				where = `in ${located.role} ${JSON.stringify(located.name ?? '')} [ref=${located.ref}] · `;
			}
			const before = await probe(driver);
			driver.press(step.key!);
			const effect = actionEffect(before, await settle(driver, token));
			return { detail: `${where}${describeEffect(effect)}`, effect };
		}
		case 'select': {
			const located = await resolve(driver, step.target!, locateMs, token);
			const before = await probe(driver);
			const picked = await driver.run<{ error?: string; picked?: string[] }>(selectOptionScript(located.ref, step.values!), SCRIPT_MS);
			if (picked && !picked.error) {
				const effect = actionEffect(before, await settle(driver, token));
				if (!picked.picked?.length) {
					throw new StepError('NOT_FOUND', `${located.role} ${JSON.stringify(located.name ?? '')} [ref=${located.ref}] has no option ${step.values!.map(v => JSON.stringify(v)).join(' or ')}`);
				}
				return { detail: `${picked.picked.join(', ')} in ${located.role} ${JSON.stringify(located.name ?? '')} [ref=${located.ref}]`, effect };
			}
			// A custom dropdown: open it, then click each option.
			const opened = await clickRef(driver, located.ref, {}, token);
			const chosen: string[] = [];
			let effect = opened.effect;
			for (const value of step.values!) {
				let option: ILocateResult & { readonly ref: string };
				try {
					option = await resolve(driver, { role: 'option', name: value }, Math.min(locateMs, 2000), token);
				} catch {
					option = await resolve(driver, { text: value, exact: true }, 1000, token);
				}
				effect = (await clickRef(driver, option.ref, {}, token)).effect ?? effect;
				chosen.push(option.name ?? value);
			}
			return { detail: `${chosen.join(', ')} in ${located.role} ${JSON.stringify(located.name ?? '')} [ref=${located.ref}] (custom dropdown)`, effect };
		}
		case 'check':
		case 'uncheck': {
			const want = step.action === 'check';
			const located = await resolve(driver, step.target!, locateMs, token);
			const label = `${located.role} ${JSON.stringify(located.name ?? '')} [ref=${located.ref}]`;
			const now = await readState(driver, located.ref);
			if (now && (now.checked === true) === want) {
				return { detail: `${label} was already ${want ? 'checked' : 'unchecked'}` };
			}
			await waitEnabled(driver, located, Math.min(locateMs, ENABLE_WAIT_MS), token);
			const outcome = await clickRef(driver, located.ref, {}, token);
			let state = await readState(driver, located.ref);
			if (state && !state.error && (state.checked === true) !== want) {
				// The mouse missed the real control (a styled label, a hidden input): toggle it directly.
				await driver.run(clickFallbackScript(located.ref), SCRIPT_MS);
				await settle(driver, token);
				state = await readState(driver, located.ref);
			}
			if (state && !state.error && (state.checked === true) !== want) {
				throw new StepError('VERIFY_FAILED', `${label} is still ${state.checked === true ? 'checked' : 'unchecked'} after clicking it`);
			}
			return { detail: `${label} · now ${want ? 'checked' : 'unchecked'}`, effect: outcome.effect };
		}
		case 'scroll': {
			let ref: string | undefined;
			if (step.target) {
				ref = (await resolve(driver, step.target, locateMs, token)).ref;
			}
			if (step.until) {
				// Lazy lists and infinite feeds render more as they scroll: scroll until the target exists.
				for (let i = 0; i <= 10; i++) {
					cancelled(token);
					const found = await driver.run<ILocateResult>(locateScript(step.until), SCRIPT_MS).catch(() => undefined);
					if (found?.ref) {
						await driver.run(targetScript(found.ref), SCRIPT_MS);
						return { detail: `${found.role} ${JSON.stringify(found.name ?? '')} [ref=${found.ref}] is in view${i ? ` after ${i} scroll${i === 1 ? '' : 's'}` : ''}` };
					}
					if (found?.error === 'ambiguous' || i === 10) {
						throw locateFailure(step.until, found, 0);
					}
					const moved = await driver.run<{ scrollY?: number; error?: string }>(scrollScript(ref, step.deltaX ?? 0, step.deltaY ?? 600), SCRIPT_MS);
					const at = await probe(driver);
					await settle(driver, token, 1500);
					const after = await driver.run<{ scrollY?: number }>(scrollScript(ref, 0, 0), SCRIPT_MS);
					if (moved?.scrollY !== undefined && after?.scrollY === moved.scrollY && at && (await probe(driver))?.mut === at.mut && i > 0) {
						throw new StepError('NOT_FOUND', `reached the end of the page without finding ${describeLocator(step.until)}`);
					}
				}
			}
			const dy = step.deltaY ?? (ref ? 0 : 600);
			const before = await probe(driver);
			const scrolled = await driver.run<{ scrollY?: number; error?: string }>(scrollScript(ref, step.deltaX ?? 0, dy), SCRIPT_MS);
			if (scrolled?.error) {
				throw new StepError('STALE_REF', `${ref} went away`);
			}
			const effect = actionEffect(before, await settle(driver, token, 1000));
			return { detail: `scrollY ${scrolled?.scrollY ?? '?'}`, effect };
		}
		case 'wait': {
			if (step.expect) {
				const met = await waitFor(driver, step.expect, step.timeoutMs ?? 10_000, token);
				if (!met.ok) {
					throw new StepError('VERIFY_FAILED', `${describeExpectation(step.expect)} did not happen in ${((step.timeoutMs ?? 10_000) / 1000).toFixed(1)}s: ${met.detail}`);
				}
				return { detail: 'met' };
			}
			await timeout(Math.max(0, step.ms ?? 0));
			return { detail: `waited ${step.ms ?? 0}ms` };
		}
		case 'expect': {
			const met = await waitFor(driver, step.expect!, step.timeoutMs ?? EXPECT_TIMEOUT_MS, token);
			if (!met.ok) {
				throw new StepError('VERIFY_FAILED', met.detail);
			}
			return { detail: 'holds' };
		}
		case 'flow':
			// The tool expands flows into their steps before running them.
			throw new StepError('NOT_FOUND', `flow ${step.flow} was not expanded`);
		case 'menu':
			throw new StepError('NOT_FOUND', 'menu is for desktop apps (desktop_act); on a web page click the menu instead');
	}
}

/**
 * Runs the steps in order. A failed step stops the run (unless `optional`); the steps after it are
 * skipped. An acting step that leaves requests open stops the next acting step too, so a submit
 * whose outcome is unknown is never followed blindly.
 */
export async function runActSteps(driver: IActDriver, steps: readonly IActStep[], token: CancellationToken): Promise<IActRunResult> {
	const started = Date.now();
	const results: IActStepResult[] = [];
	let stopped: string | undefined;
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		if (stopped) {
			results.push({ index: i, step, status: 'skipped', detail: stopped, ms: 0 });
			continue;
		}
		const stepStarted = Date.now();
		try {
			cancelled(token);
			const { detail, effect, secret } = await runStep(driver, step, token);
			let line = detail;
			if (step.expect && step.action !== 'wait' && step.action !== 'expect') {
				const met = await waitFor(driver, step.expect, step.timeoutMs ?? EXPECT_TIMEOUT_MS, token);
				if (!met.ok) {
					throw new StepError('VERIFY_FAILED', `${detail} · but expected ${describeExpectation(step.expect)}: ${met.detail}`);
				}
				line += ` · verified ${describeExpectation(step.expect)}`;
			} else if (effect && isActingStep(step) && step.action !== 'scroll' && hadNoEffect(effect)) {
				line += ' · warning: nothing on the page reacted';
			}
			results.push({ index: i, step, status: 'ok', detail: line, effect, ms: Date.now() - stepStarted, secret });
			const next = steps[i + 1];
			if (effect && !effect.settled && effect.pending > 0 && next && isActingStep(next) && !step.expect) {
				stopped = `step ${i + 1} left ${effect.pending} request${effect.pending === 1 ? '' : 's'} open; check the page before continuing`;
			}
		} catch (err) {
			const code: ActFailure = err instanceof StepError ? err.code : 'PAGE_UNRESPONSIVE';
			const detail = err instanceof Error ? err.message : String(err);
			results.push({ index: i, step, status: 'failed', code, detail, ms: Date.now() - stepStarted });
			if (code === 'CANCELLED') {
				stopped = 'cancelled';
			} else if (!step.optional) {
				stopped = `step ${i + 1} failed`;
			}
		}
	}
	const ok = results.every(result => result.status === 'ok' || (result.status === 'failed' && result.step.optional));
	return { results, ok, ms: Date.now() - started };
}

/** The run as lines: a header, then one line per step. */
function verbOf(step: IActStep): string {
	return step.action === 'click' ? (step.double ? 'dblclick' : step.button === 'right' ? 'rclick' : 'click') : step.action === 'type' && step.submit ? 'submit' : step.action;
}

/**
 * The run as lines: a header, then one line per step (what it acted on and what that did).
 * `brief`: a run that passed is one line, with the conditions it verified.
 */
export function formatActRun(run: IActRunResult, tool = 'browser_act', options?: { readonly brief?: boolean }): string[] {
	const done = run.results.filter(result => result.status === 'ok').length;
	const failed = run.results.find(result => result.status === 'failed' && !result.step.optional);
	const seconds = `${(run.ms / 1000).toFixed(1)}s`;
	if (!failed && options?.brief) {
		const verified = run.results.filter(result => result.status === 'ok' && result.step.expect).map(result => describeExpectation(result.step.expect!));
		return [`### ${tool}: ${done}/${run.results.length} steps ok in ${seconds}${verified.length ? `; verified ${verified.join('; ')}` : ''}`];
	}
	const header = failed
		? `### ${tool}: stopped at step ${failed.index + 1} of ${run.results.length} (${failed.code}) after ${seconds}`
		: `### ${tool}: ${done}/${run.results.length} steps ok in ${seconds}`;
	const lines = [header];
	for (const result of run.results) {
		const slow = result.ms >= 1500 ? ` (${(result.ms / 1000).toFixed(1)}s)` : '';
		if (result.status === 'ok') {
			lines.push(`${result.index + 1}. ok ${verbOf(result.step)} ${result.detail}${slow}`);
		} else {
			const mark = result.status === 'skipped' ? 'skipped' : `FAILED ${result.code}${result.step.optional ? ' (optional)' : ''}`;
			lines.push(`${result.index + 1}. ${mark} · ${describeStep(result.step)}${result.status === 'skipped' ? '' : ` · ${result.detail}`}${slow}`);
		}
	}
	if (failed) {
		lines.push(`Steps before the failure ran and stay done; do not repeat them. Fix the failed step from the ${tool.startsWith('browser') ? 'page' : 'screen'} state below and continue from there.`);
	}
	return lines;
}

export interface IFlowRun {
	readonly label: string;
	readonly run: IActRunResult;
}

/** Several saved flows run in one call: a line each, and the failing step of the ones that failed. */
export function formatFlowRuns(runs: readonly IFlowRun[], tool: string): string[] {
	const failed = runs.filter(entry => !entry.run.ok);
	const ms = runs.reduce((sum, entry) => sum + entry.run.ms, 0);
	const lines = [`### ${tool}: ${runs.length} flow${runs.length === 1 ? '' : 's'}, ${runs.length - failed.length} passed${failed.length ? `, ${failed.length} failed` : ''} in ${(ms / 1000).toFixed(1)}s`];
	for (const { label, run } of runs) {
		if (run.ok) {
			lines.push(`- ${label}: ok (${run.results.length} steps, ${(run.ms / 1000).toFixed(1)}s)`);
			continue;
		}
		const step = run.results.find(result => result.status === 'failed' && !result.step.optional)!;
		lines.push(`- ${label}: FAILED at step ${step.index + 1} (${step.code}) ${describeStep(step.step)}: ${step.detail}`);
	}
	return lines;
}

/**
 * Whether a passing run can be saved as a flow: text typed into a password field must come from
 * `vars` (`${password}`), never be written into the flow file.
 */
export function unsafeToSave(run: IActRunResult, vars: Readonly<Record<string, string>> | undefined): string | undefined {
	const values = new Set(Object.values(vars ?? {}));
	const leaked = run.results.find(result => result.secret && result.step.text && !values.has(result.step.text));
	return leaked ? `step ${leaked.index + 1} types a password; write it as \${password} and pass "vars": {"password": "…"} so the flow file does not store it` : undefined;
}

/** What `snapshotScript` returns (see `IPageNode`). */
export interface IPageSnapshotBase {
	readonly doc: string;
	readonly url: string;
	readonly title: string;
	readonly nodes: readonly IPageNode[];
	readonly truncated?: boolean;
	readonly error?: string;
	readonly viewport?: { readonly width: number; readonly height: number; readonly scrollY: number; readonly scrollHeight: number; readonly scrollWidth: number };
}

export interface IPageStateOptions {
	/** The page as the agent last read it. */
	readonly previous?: IPageView;
	/** `auto`: changes since `previous` (the whole page on a new document); `full`; `none`: no tree. */
	readonly observe: 'auto' | 'full' | 'none';
	/** A snapshot of part of the page (selector, interactive only): shown whole, not remembered. */
	readonly partial?: boolean;
	readonly fixedViewport?: boolean;
	/** New console errors and warnings, already formatted. */
	readonly console?: readonly string[];
	/** Show long runs of rows and items in full instead of folded. */
	readonly unfold?: boolean;
}

/**
 * The page state lines every browser tool ends with, and the view to remember as what the agent
 * has now seen (undefined when this result does not change that).
 */
export function pageStateLines(snap: IPageSnapshotBase, options: IPageStateOptions): { readonly lines: string[]; readonly page?: IPageView } {
	const lines = [`- Page URL: ${snap.url}`, `- Page Title: ${snap.title || '(untitled)'}`];
	if (snap.viewport) {
		const overflow = snap.viewport.scrollWidth > snap.viewport.width + 1 ? ` (content is ${snap.viewport.scrollWidth}px wide: horizontal overflow)` : '';
		lines.push(`- Viewport: ${snap.viewport.width}×${snap.viewport.height}${options.fixedViewport ? ' (fixed)' : ''}, scrolled ${snap.viewport.scrollY}/${Math.max(0, snap.viewport.scrollHeight - snap.viewport.height)}${overflow}`);
	}
	if (options.console?.length) {
		lines.push('- New console errors/warnings:', ...options.console.map(line => `  ${line}`));
	}
	if (options.observe === 'none') {
		return { lines };
	}
	if (snap.error === 'selector') {
		lines.push('- No element matches that selector.');
		return { lines };
	}
	const page: IPageView = { doc: snap.doc, url: snap.url, title: snap.title, nodes: snap.nodes ?? [], truncated: snap.truncated };
	if (options.partial) {
		lines.push('- Page Snapshot (part):', '```yaml', ...renderPage(page, { unfold: options.unfold }), '```');
		return { lines };
	}
	lines.push(...observePage(options.previous, page, options.observe === 'full' ? 'full' : undefined, options.unfold).lines);
	return { lines, page };
}
