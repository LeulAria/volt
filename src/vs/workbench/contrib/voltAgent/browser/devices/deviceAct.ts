/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { VoltDeviceButton } from '../../../../../platform/voltDevices/common/voltDevices.js';
import { checkOnDevice, deviceView, IDeviceElement, IDeviceScreen, locateOnDevice } from '../../../../services/voltRuntime/common/tools/deviceUi.js';
import { describeExpectation, describeLocator, diffPage, IActStep, IPageExpectation, IPageLocator, isActingStep } from '../../../../services/voltRuntime/common/tools/pageModel.js';
import type { ActFailure, IActRunResult, IActStepResult } from '../preview/browserAct.js';

/**
 * Runs `device_act` steps on a simulator or emulator: each step finds its element in the screen's
 * accessibility tree (by text, role + name, label, id or ref, waiting for it to show), taps or
 * types at its center, reads the tree again, reports what changed, and checks its postcondition.
 * No screenshots and no guessed coordinates.
 */

/** The device the steps run on. Boxes and input are in the device's input units. */
export interface IDeviceDriver {
	readonly platform: 'android' | 'ios' | 'desktop';
	/** The screen's accessibility tree now. */
	read(): Promise<IDeviceScreen>;
	tap(x: number, y: number): Promise<void>;
	swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
	type(text: string): Promise<void>;
	/** Deletes `count` characters at the end of the focused field. */
	clear(count: number): Promise<void>;
	press(button: VoltDeviceButton): Promise<void>;
	launch(app: string): Promise<void>;
	/**
	 * Desktop: presses the element through accessibility (no mouse, works behind other windows).
	 * False when the app does not support it; the runner clicks its center instead.
	 */
	activate?(element: IDeviceElement): Promise<boolean>;
	/** Desktop: sets a field's value directly. False when the field does not take one. */
	setText?(element: IDeviceElement, text: string): Promise<boolean>;
	/** Desktop: a key chord such as "cmd+s" or "shift+tab". */
	key?(combo: string): Promise<void>;
	/** Desktop: picks a menu bar item by its path. */
	menu?(path: readonly string[]): Promise<void>;
}

/** After input, the screen needs a moment before its tree says what the input did. */
const SETTLE_MS = 350;
/** With a fast reader: the first look after input, then re-reads until two in a row match. */
const SETTLE_FIRST_MS = 120;
const SETTLE_STEP_MS = 90;
const SETTLE_MAX_MS = 2000;
/** How long a screen that has not changed at all after input gets before that counts as no effect. */
const NO_CHANGE_MS = 900;
/** Reads slower than this come from `uiautomator dump`: settle with one read after a fixed pause. */
const FAST_READ_MS = 400;
const LOCATE_TIMEOUT_MS = 5000;
const EXPECT_TIMEOUT_MS = 6000;
const SCROLL_TRIES = 10;

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

function label(element: IDeviceElement): string {
	return `${element.role} ${JSON.stringify(element.name ?? '')}${element.ref ? ` [ref=${element.ref}]` : ''}`;
}

function center(element: IDeviceElement): { x: number; y: number } {
	const [x, y, w, h] = element.box;
	return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
}

/** What changed on screen between two reads, in a few words. */
export function describeScreenChange(before: IDeviceScreen, after: IDeviceScreen): string {
	if (before.app !== after.app) {
		return `now in ${after.app || 'another app'}`;
	}
	const diff = diffPage(deviceView(before), deviceView(after));
	const parts: string[] = [];
	if (diff.added.length) {
		parts.push(`${diff.added.length} added`);
	}
	if (diff.removed.length) {
		parts.push(`${diff.removed.length} removed`);
	}
	if (diff.changed.length) {
		parts.push(`${diff.changed.length} changed`);
	}
	return parts.length ? `screen: ${parts.join(', ')}` : 'nothing on screen changed';
}

/** What a screen shows, to tell whether it is still moving. */
function signature(screen: IDeviceScreen): string {
	return `${screen.app}|${screen.elements.map(element => `${element.role}:${element.name ?? ''}:${element.value ?? ''}:${element.states?.join(',') ?? ''}:${element.box.join(',')}`).join('|')}`;
}

const KEYS: Record<string, VoltDeviceButton> = {
	enter: 'enter', return: 'enter', back: 'back', escape: 'back', esc: 'back', home: 'home', backspace: 'delete', delete: 'delete',
	tab: 'appSwitch', appswitch: 'appSwitch', recents: 'appSwitch', lock: 'lock', power: 'lock', volumeup: 'volumeUp', volumedown: 'volumeDown', siri: 'siri',
};

function failure(locator: IPageLocator, result: ReturnType<typeof locateOnDevice>, waited: number): StepError {
	const what = describeLocator(locator);
	if (!('error' in result)) {
		return new StepError('NOT_FOUND', what);
	}
	switch (result.error) {
		case 'stale':
			return new StepError('STALE_REF', `${locator.ref} is not on screen anymore; target it by text or role/name`);
		case 'ambiguous':
		case 'within-ambiguous':
			return new StepError('AMBIGUOUS', `${result.count} elements match ${result.error === 'within-ambiguous' ? `the container ${describeLocator(locator.within!)}` : what}: ${(result.candidates ?? []).map(c => `${c.ref ?? c.role} ${c.role} ${JSON.stringify(c.name ?? '')}`).join('; ')}. Use a ref, "within", "exact" or "nth"`);
		case 'nth':
			return new StepError('NOT_FOUND', `${what}: only ${result.count} equally good matches`);
	}
	return new StepError('NOT_FOUND', `nothing on screen matches ${what} after ${(waited / 1000).toFixed(1)}s (if it is further down a list, use {"action":"scroll","until":…})`);
}

/** Runs device steps in order, with the same stop/skip rules and result shape as `browser_act`. */
export class DeviceActRunner {

	private screen: IDeviceScreen | undefined;
	/** The step that just ran typed into a password field. */
	private typedSecret = false;

	constructor(private readonly driver: IDeviceDriver, private readonly token: CancellationToken) { }

	/** The last screen read: the agent sees it at the end of the run. */
	get last(): IDeviceScreen | undefined {
		return this.screen;
	}

	/** How long the last read took: fast readers allow settling by comparing reads. */
	private readMs = Number.POSITIVE_INFINITY;

	private async read(): Promise<IDeviceScreen> {
		cancelled(this.token);
		const started = Date.now();
		this.screen = await this.driver.read();
		this.readMs = Date.now() - started;
		return this.screen;
	}

	private async current(): Promise<IDeviceScreen> {
		return this.screen ?? this.read();
	}

	/**
	 * Waits for the screen to react to input and stop changing (a new screen opening, a list
	 * loading), then returns it. A screen that has not changed at all yet gets up to
	 * `NO_CHANGE_MS` to start: opening another screen takes a few hundred ms before anything shows.
	 */
	private async afterInput(): Promise<IDeviceScreen> {
		const before = this.screen ? signature(this.screen) : undefined;
		if (this.readMs > FAST_READ_MS) {
			await timeout(SETTLE_MS);
			return this.read();
		}
		const started = Date.now();
		await timeout(SETTLE_FIRST_MS);
		let previous = signature(await this.read());
		while (Date.now() - started < SETTLE_MAX_MS) {
			await timeout(SETTLE_STEP_MS);
			const next = signature(await this.read());
			const unchanged = next === before;
			if (next === previous && (!unchanged || Date.now() - started >= NO_CHANGE_MS)) {
				break;
			}
			previous = next;
		}
		return this.screen!;
	}

	private async find(locator: IPageLocator, timeoutMs: number): Promise<IDeviceElement> {
		const started = Date.now();
		let screen = await this.current();
		for (; ;) {
			const result = locateOnDevice(screen.elements, locator);
			if (!('error' in result)) {
				return result.element;
			}
			if (result.error === 'ambiguous' || result.error === 'within-ambiguous' || result.error === 'stale' || Date.now() - started >= timeoutMs) {
				throw failure(locator, result, Date.now() - started);
			}
			screen = await this.read();
		}
	}

	private async waitFor(expectation: IPageExpectation, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
		const started = Date.now();
		let screen = await this.current();
		for (; ;) {
			const met = checkOnDevice(screen, expectation);
			if (met.ok || Date.now() - started >= timeoutMs) {
				return met;
			}
			await timeout(200);
			screen = await this.read();
		}
	}

	private async tapOn(element: IDeviceElement): Promise<string> {
		if (element.states?.includes('disabled')) {
			throw new StepError('DISABLED', `${label(element)} is disabled`);
		}
		const before = await this.current();
		if (!element.handle || !this.driver.activate || !await this.driver.activate(element).catch(() => false)) {
			const at = center(element);
			await this.driver.tap(at.x, at.y);
		}
		return describeScreenChange(before, await this.afterInput());
	}

	private async step(step: IActStep): Promise<string> {
		const locateMs = step.timeoutMs ?? LOCATE_TIMEOUT_MS;
		switch (step.action) {
			case 'navigate': {
				const before = await this.current();
				await this.driver.launch(step.url!);
				await timeout(700);
				return `launched ${step.url} · ${describeScreenChange(before, await this.read())}`;
			}
			case 'back':
			case 'reload': {
				if (step.action === 'reload') {
					throw new StepError('NOT_FOUND', 'reload is for web pages; relaunch the app with navigate');
				}
				const before = await this.current();
				await this.driver.press('back');
				return describeScreenChange(before, await this.afterInput());
			}
			case 'click': {
				const element = await this.find(step.target!, locateMs);
				return `${label(element)} · ${await this.tapOn(element)}`;
			}
			case 'hover':
				throw new StepError('NOT_FOUND', 'touch screens have no hover; tap instead');
			case 'check':
			case 'uncheck': {
				const want = step.action === 'check';
				const element = await this.find(step.target!, locateMs);
				const states = element.states ?? [];
				if (states.includes(want ? 'checked' : 'unchecked')) {
					return `${label(element)} was already ${want ? 'checked' : 'unchecked'}`;
				}
				const effect = await this.tapOn(element);
				const now = locateOnDevice(this.screen!.elements, element.ref ? { ref: element.ref } : step.target!);
				if (!('error' in now) && now.element.states?.includes(want ? 'unchecked' : 'checked')) {
					throw new StepError('VERIFY_FAILED', `${label(element)} is still ${want ? 'unchecked' : 'checked'} after tapping it`);
				}
				return `${label(element)} · ${effect} · now ${want ? 'checked' : 'unchecked'}`;
			}
			case 'type': {
				const element = await this.find(step.target!, locateMs);
				if (!element.editable) {
					throw new StepError('NOT_EDITABLE', `${label(element)} does not take text`);
				}
				const before = await this.current();
				const text = step.text ?? '';
				this.typedSecret = !!element.secret;
				const field = () => {
					const found = locateOnDevice(this.screen!.elements, element.ref ? { ref: element.ref } : step.target!);
					return 'error' in found ? undefined : found.element;
				};
				// Keys sent before the field has focus (an opening screen, a keyboard coming up) are lost:
				// focus it, wait until the tree says it is focused, type, and check what the field holds.
				const typeOnce = async () => {
					const now = field() ?? element;
					if (!now.states?.includes('focused')) {
						// Tap near the right edge: the cursor lands at the end of what is there.
						const [x, y, w, h] = now.box;
						await this.driver.tap(Math.round(x + Math.max(w / 2, w - 12)), Math.round(y + h / 2));
						const started = Date.now();
						while (Date.now() - started < 1500 && !field()?.states?.includes('focused')) {
							await timeout(this.readMs > FAST_READ_MS ? 250 : 60);
							await this.read();
						}
					}
					const current = field()?.value ?? now.value;
					if (step.clear !== false && current && !now.secret) {
						await this.driver.clear(current.length);
					} else if (step.clear !== false && now.secret) {
						await this.driver.clear(64);
					}
					if (text) {
						await this.driver.type(text);
					}
					await this.afterInput();
				};
				const landed = () => element.secret || !text || (field()?.value ?? '').includes(text);
				// The desktop sets a field's value directly when it can (exact, and no keyboard focus needed).
				const direct = !!element.handle && !!this.driver.setText && step.clear !== false && !element.secret && await this.driver.setText(element, text).catch(() => false);
				if (direct) {
					await this.afterInput();
				}
				if (!direct || !landed()) {
					await typeOnce();
				}
				if (!landed()) {
					await typeOnce();
					if (!landed()) {
						throw new StepError('VERIFY_FAILED', `typed ${JSON.stringify(text)} into ${label(element)} twice, but it reads ${JSON.stringify(field()?.value ?? '')}`);
					}
				}
				if (step.submit) {
					await this.driver.press('enter');
					await this.afterInput();
				}
				return [`→ ${label(element)}`, describeScreenChange(before, this.screen!)].join(' · ');
			}
			case 'press': {
				if (this.driver.key) {
					// The desktop takes any chord.
					if (step.target) {
						await this.tapOn(await this.find(step.target, locateMs));
					}
					const before = await this.current();
					await this.driver.key(step.key!);
					return describeScreenChange(before, await this.afterInput());
				}
				const button = KEYS[step.key!.toLowerCase().replace(/[\s_-]/g, '')];
				if (!button) {
					throw new StepError('NOT_FOUND', `no device button for ${JSON.stringify(step.key)}; use enter, back, home, delete, appSwitch, lock, volumeUp or volumeDown`);
				}
				if (step.target) {
					const element = await this.find(step.target, locateMs);
					const at = center(element);
					await this.driver.tap(at.x, at.y);
					await timeout(200);
				}
				const before = await this.current();
				await this.driver.press(button);
				return describeScreenChange(before, await this.afterInput());
			}
			case 'select': {
				const element = await this.find(step.target!, locateMs);
				await this.tapOn(element);
				const picked: string[] = [];
				for (const value of step.values!) {
					const option = await this.find({ text: value, exact: true }, 3000).catch(() => this.find({ text: value }, 1000));
					await this.tapOn(option);
					picked.push(option.name ?? value);
				}
				return `${picked.join(', ')} in ${label(element)}`;
			}
			case 'scroll': {
				const screen = await this.current();
				let box: readonly [number, number, number, number] = [0, 0, screen.width, screen.height];
				if (step.target) {
					box = (await this.find(step.target, locateMs)).box;
				} else {
					// The largest scrollable area on screen, else the whole screen.
					const area = screen.elements.filter(element => element.scrollable).sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
					if (area) {
						box = area.box;
					}
				}
				const [x, y, w, h] = box;
				const horizontal = !!step.deltaX && !step.deltaY;
				const forward = horizontal ? (step.deltaX ?? 0) > 0 : (step.deltaY ?? 600) >= 0;
				const swipe = async () => {
					// Content moves opposite to the finger: to see what is below, swipe up.
					if (horizontal) {
						const [from, to] = forward ? [x + w * 0.8, x + w * 0.2] : [x + w * 0.2, x + w * 0.8];
						await this.driver.swipe(Math.round(from), Math.round(y + h / 2), Math.round(to), Math.round(y + h / 2), 300);
					} else {
						const [from, to] = forward ? [y + h * 0.75, y + h * 0.3] : [y + h * 0.3, y + h * 0.75];
						await this.driver.swipe(Math.round(x + w / 2), Math.round(from), Math.round(x + w / 2), Math.round(to), 300);
					}
				};
				if (!step.until) {
					const before = await this.current();
					await swipe();
					return describeScreenChange(before, await this.afterInput());
				}
				for (let i = 0; i <= SCROLL_TRIES; i++) {
					const found = locateOnDevice((await this.current()).elements, step.until);
					if (!('error' in found)) {
						return `${label(found.element)} is on screen${i ? ` after ${i} swipe${i === 1 ? '' : 's'}` : ''}`;
					}
					if (found.error === 'ambiguous') {
						throw failure(step.until, found, 0);
					}
					if (i === SCROLL_TRIES) {
						break;
					}
					const before = (await this.current()).elements.map(element => element.ref ?? element.name).join('|');
					await swipe();
					const after = await this.afterInput();
					if (after.elements.map(element => element.ref ?? element.name).join('|') === before) {
						throw new StepError('NOT_FOUND', `reached the ${forward ? 'end' : 'start'} without finding ${describeLocator(step.until)}`);
					}
				}
				throw new StepError('NOT_FOUND', `${describeLocator(step.until)} did not show after ${SCROLL_TRIES} swipes`);
			}
			case 'wait': {
				if (step.expect) {
					const met = await this.waitFor(step.expect, step.timeoutMs ?? 10_000);
					if (!met.ok) {
						throw new StepError('VERIFY_FAILED', `${describeExpectation(step.expect)} did not happen: ${met.detail}`);
					}
					return 'met';
				}
				await timeout(Math.min(30_000, step.ms ?? 0));
				this.screen = undefined;
				return `waited ${step.ms ?? 0}ms`;
			}
			case 'expect': {
				const met = await this.waitFor(step.expect!, step.timeoutMs ?? EXPECT_TIMEOUT_MS);
				if (!met.ok) {
					throw new StepError('VERIFY_FAILED', met.detail);
				}
				return 'holds';
			}
			case 'flow':
				// The tool expands flows into their steps before running them.
				throw new StepError('NOT_FOUND', `flow ${step.flow} was not expanded`);
			case 'menu': {
				if (!this.driver.menu) {
					throw new StepError('NOT_FOUND', 'menu is for desktop apps');
				}
				const before = await this.current();
				try {
					await this.driver.menu(step.values!);
				} catch (err) {
					throw new StepError('NOT_FOUND', err instanceof Error ? err.message : String(err));
				}
				return `${step.values!.join(' > ')} · ${describeScreenChange(before, await this.afterInput())}`;
			}
		}
	}

	async run(steps: readonly IActStep[]): Promise<IActRunResult> {
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
			this.typedSecret = false;
			try {
				let detail = await this.step(step);
				if (step.expect && isActingStep(step)) {
					const met = await this.waitFor(step.expect, step.timeoutMs ?? EXPECT_TIMEOUT_MS);
					if (!met.ok) {
						throw new StepError('VERIFY_FAILED', `${detail} · but expected ${describeExpectation(step.expect)}: ${met.detail}`);
					}
					detail += ` · verified ${describeExpectation(step.expect)}`;
				} else if (isActingStep(step) && detail.endsWith('nothing on screen changed') && step.action !== 'scroll') {
					detail += ' · warning: nothing on screen reacted';
				}
				results.push({ index: i, step, status: 'ok', detail, ms: Date.now() - stepStarted, secret: this.typedSecret || undefined });
			} catch (err) {
				const code: ActFailure = err instanceof StepError ? err.code : 'PAGE_UNRESPONSIVE';
				results.push({ index: i, step, status: 'failed', code, detail: err instanceof Error ? err.message : String(err), ms: Date.now() - stepStarted });
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
}
