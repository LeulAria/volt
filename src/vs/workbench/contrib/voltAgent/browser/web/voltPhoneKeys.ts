/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The row of keys a phone's keyboard lacks (Esc, Tab, Ctrl, arrows, …), shown right above the
// on-screen keyboard while a terminal or a file's editor has focus, like Blink's or VS Code for
// iPad's. A hardware keyboard brings up no on-screen keyboard, so the row never shows with one.

import './media/voltPhoneKeys.css';
import { $, addDisposableListener, append, getClientArea, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Gesture } from '../../../../../base/browser/touch.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { setWorkbenchLayoutInset } from '../../../../browser/layoutInsets.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { ITerminalContribution, ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { voltButtonClasses } from '../chrome/voltButton.js';
import { AgentTerminalsEditorInput } from '../terminals/agentTerminalsEditor.js';
import { onVoltShellMessage, postToVoltShell, voltShell } from './voltShellBridge.js';

/** The row's height; the layout keeps the workbench above it. */
const BAR_HEIGHT = 44;

/** Less of the page than this covered is a browser's toolbar or a hardware keyboard's shortcut bar, not a keyboard. */
const KEYBOARD_MIN_HEIGHT = 120;

/** A finger that moves more than this is scrolling the row, not pressing a key. */
const TAP_SLOP = 10;

/** Holding an arrow repeats it, after this long and then this often. */
const REPEAT_DELAY = 400;
const REPEAT_INTERVAL = 60;

/** A second tap on Ctrl or Alt this soon after the first locks it. */
const LOCK_TAP_WINDOW = 400;

const INSET_SOURCE = 'voltPhoneKeys';
const TRIGGER_SOURCE = 'voltPhoneKeys';

type Modifier = 'ctrl' | 'alt';
type ModifierState = 'off' | 'once' | 'locked';

type KeyTarget =
	| { readonly kind: 'terminal'; readonly instance: ITerminalInstance }
	| { readonly kind: 'editor'; readonly editor: ICodeEditor };

interface IKeySpec {
	readonly id: string;
	readonly label: string;
	/** Read out instead of the label (arrows, symbols). */
	readonly title?: string;
	readonly icon?: ThemeIcon;
	readonly repeat?: boolean;
	/** Starts a group: a little more room before it. */
	readonly group?: boolean;
}

const ARROW_KEYS: readonly IKeySpec[] = [
	{ id: 'left', label: '←', title: localize('voltPhoneKeys.left', "Left Arrow"), repeat: true, group: true },
	{ id: 'up', label: '↑', title: localize('voltPhoneKeys.up', "Up Arrow"), repeat: true },
	{ id: 'down', label: '↓', title: localize('voltPhoneKeys.down', "Down Arrow"), repeat: true },
	{ id: 'right', label: '→', title: localize('voltPhoneKeys.right', "Right Arrow"), repeat: true },
];

const TERMINAL_KEYS: readonly IKeySpec[] = [
	{ id: 'esc', label: localize('voltPhoneKeys.esc', "Esc"), title: localize('voltPhoneKeys.escape', "Escape") },
	{ id: 'tab', label: localize('voltPhoneKeys.tab', "Tab") },
	{ id: 'ctrl', label: localize('voltPhoneKeys.ctrl', "Ctrl"), title: localize('voltPhoneKeys.control', "Control") },
	{ id: 'alt', label: localize('voltPhoneKeys.alt', "Alt") },
	...ARROW_KEYS,
	{ id: '|', label: '|', title: localize('voltPhoneKeys.pipe', "Vertical Bar"), group: true },
	{ id: '~', label: '~', title: localize('voltPhoneKeys.tilde', "Tilde") },
	{ id: '/', label: '/', title: localize('voltPhoneKeys.slash', "Slash") },
	{ id: '-', label: '-', title: localize('voltPhoneKeys.hyphen', "Hyphen") },
	{ id: 'home', label: localize('voltPhoneKeys.home', "Home"), group: true },
	{ id: 'end', label: localize('voltPhoneKeys.end', "End") },
	{ id: 'pageUp', label: localize('voltPhoneKeys.pgUp', "PgUp"), title: localize('voltPhoneKeys.pageUp', "Page Up"), repeat: true },
	{ id: 'pageDown', label: localize('voltPhoneKeys.pgDn', "PgDn"), title: localize('voltPhoneKeys.pageDown', "Page Down"), repeat: true },
	{ id: 'paste', label: localize('voltPhoneKeys.paste', "Paste"), icon: Codicon.clippy, group: true },
];

const EDITOR_KEYS: readonly IKeySpec[] = [
	{ id: 'tab', label: localize('voltPhoneKeys.tab', "Tab") },
	{ id: 'outdent', label: '⇧Tab', title: localize('voltPhoneKeys.outdent', "Outdent") },
	...ARROW_KEYS,
	{ id: 'undo', label: localize('voltPhoneKeys.undo', "Undo"), icon: Codicon.discard, group: true },
	{ id: 'redo', label: localize('voltPhoneKeys.redo', "Redo"), icon: Codicon.redo },
	{ id: 'find', label: localize('voltPhoneKeys.find', "Find"), icon: Codicon.search },
	{ id: 'save', label: localize('voltPhoneKeys.save', "Save"), icon: Codicon.save },
	{ id: 'comment', label: '//', title: localize('voltPhoneKeys.comment', "Toggle Line Comment") },
	{ id: 'esc', label: localize('voltPhoneKeys.esc', "Esc"), title: localize('voltPhoneKeys.escape', "Escape"), group: true },
];

/** The editor command each editor key runs on the focused editor. */
const EDITOR_COMMANDS: Readonly<Record<string, string>> = {
	tab: 'tab',
	outdent: 'outdent',
	left: 'cursorLeft',
	up: 'cursorUp',
	down: 'cursorDown',
	right: 'cursorRight',
	undo: 'undo',
	redo: 'redo',
	find: 'actions.find',
	comment: 'editor.action.commentLine',
};

/** The terminal's paste (its multi-line warning, bracketed paste), by id so this file needn't load it. */
interface ITerminalPaste extends ITerminalContribution {
	paste(): Promise<void>;
}

class VoltPhoneKeysContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltPhoneKeys';

	private readonly root: HTMLElement;
	private readonly bar: HTMLElement;
	private readonly terminalRow: HTMLElement;
	private readonly editorRow: HTMLElement;
	private readonly modifierKeys = new Map<Modifier, HTMLElement>();
	private readonly modifiers: Record<Modifier, ModifierState> = { ctrl: 'off', alt: 'off' };
	private readonly modifierTappedAt: Record<Modifier, number> = { ctrl: 0, alt: 0 };
	private readonly touchQuery: MediaQueryList;
	private readonly scheduler: RunOnceScheduler;
	/** What the phone app last said about its keyboard. */
	private shellKeyboard = false;
	private target: KeyTarget | undefined;
	/** Ends the key being held (its repeat). */
	private endPress: (() => void) | undefined;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IEditorService private readonly editorService: IEditorService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super();
		this.root = layoutService.mainContainer;
		const doc = this.root.ownerDocument;
		const win = getWindow(this.root);
		this.scheduler = this._register(new RunOnceScheduler(() => this.update(), 0));

		this.bar = append(this.root, $('.volt-phone-keys.hidden'));
		this.bar.setAttribute('role', 'toolbar');
		this.bar.setAttribute('aria-label', localize('voltPhoneKeys.label', "Keys"));
		this._register(toDisposable(() => this.bar.remove()));
		// The row scrolls natively; VS Code's touch gestures would take the touches for themselves.
		this._register(Gesture.ignoreTarget(this.bar));
		this.terminalRow = this.createRow(TERMINAL_KEYS);
		this.editorRow = this.createRow(EDITOR_KEYS);

		const schedule = () => this.scheduler.schedule();
		this.touchQuery = win.matchMedia('(hover: none), (pointer: coarse)');
		this._register(addDisposableListener(this.touchQuery, 'change', schedule));
		this._register(addDisposableListener(doc, 'focusin', schedule, true));
		this._register(addDisposableListener(doc, 'focusout', schedule, true));
		this._register(addDisposableListener(win, 'resize', schedule));
		const viewport = win.visualViewport;
		if (viewport) {
			// A browser's keyboard shrinks the visual viewport, and the visible part scrolls with the caret.
			this._register(addDisposableListener(viewport, 'resize', schedule));
			this._register(addDisposableListener(viewport, 'scroll', schedule));
		}
		if (voltShell) {
			this._register(onVoltShellMessage(message => {
				if (message.type === 'keyboard') {
					this.shellKeyboard = message.visible && message.height >= KEYBOARD_MIN_HEIGHT;
					schedule();
				}
			}));
		}

		// Ctrl or Alt waiting: the next letter from the phone's keyboard goes to the terminal with it.
		this._register(addDisposableListener(win, 'keydown', e => this.onKeyDown(e), true));
		this._register(addDisposableListener(win, 'beforeinput', e => this.onBeforeInput(e as InputEvent), true));

		this._register(toDisposable(() => {
			this.endPress?.();
			setWorkbenchLayoutInset(INSET_SOURCE, undefined);
		}));
	}

	//#region Showing

	private update(): void {
		const target = this.keyboardUp() ? this.focusedTarget() : undefined;
		if (target?.kind !== this.target?.kind || (target?.kind === 'terminal' && this.target?.kind === 'terminal' && target.instance !== this.target.instance)) {
			this.endPress?.();
			this.resetModifiers();
		}
		this.target = target;
		this.bar.classList.toggle('hidden', !target);
		this.terminalRow.classList.toggle('hidden', target?.kind !== 'terminal');
		this.editorRow.classList.toggle('hidden', target?.kind !== 'editor');
		this.root.classList.toggle('volt-phone-keys-shown', !!target);
		if (!target) {
			setWorkbenchLayoutInset(INSET_SOURCE, undefined);
			return;
		}
		// Right above the keyboard. In the phone app the page already ends there. In a browser the
		// keyboard covers the page's bottom: the layout measures iOS's page without it (the visual
		// viewport) but Android's with it, so the room kept is whatever its measure has below the row's
		// top, and the prompt or the cursor's line sits just above the row.
		const win = getWindow(this.root);
		const viewport = win.visualViewport;
		const visibleBottom = viewport ? viewport.offsetTop + viewport.height : win.innerHeight;
		const top = Math.max(0, Math.round(visibleBottom - BAR_HEIGHT));
		this.bar.style.top = `${top}px`;
		const page = getClientArea(this.root.parentElement ?? this.root.ownerDocument.body);
		setWorkbenchLayoutInset(INSET_SOURCE, { bottom: Math.max(BAR_HEIGHT, page.height - top) });
	}

	private keyboardUp(): boolean {
		if (voltShell) {
			return this.shellKeyboard;
		}
		const win = getWindow(this.root);
		const viewport = win.visualViewport;
		return this.touchQuery.matches && !!viewport && win.innerHeight - viewport.height * viewport.scale > KEYBOARD_MIN_HEIGHT;
	}

	/** A terminal or a file's editor with focus; the chat's composer and other inputs get no keys. */
	private focusedTarget(): KeyTarget | undefined {
		const active = this.root.ownerDocument.activeElement;
		if (isHTMLElement(active) && active.closest('.xterm')) {
			const instance = this.terminalOf(active);
			return instance ? { kind: 'terminal', instance } : undefined;
		}
		const editor = this.codeEditorService.getFocusedCodeEditor();
		return editor && !editor.isSimpleWidget && editor.hasModel() ? { kind: 'editor', editor } : undefined;
	}

	private terminalOf(element: HTMLElement): ITerminalInstance | undefined {
		const owns = (instance: ITerminalInstance) => !!instance.xterm?.raw.element?.contains(element);
		const found = this.terminalService.instances.find(owns);
		if (found) {
			return found;
		}
		// The chat's Terminals tab holds its own instances.
		for (const editor of this.editorService.editors) {
			if (editor instanceof AgentTerminalsEditorInput) {
				const instance = editor.instances.find(owns);
				if (instance) {
					return instance;
				}
			}
		}
		return undefined;
	}

	//#endregion

	//#region Keys

	private createRow(keys: readonly IKeySpec[]): HTMLElement {
		const row = append(this.bar, $('.volt-phone-keys-row.hidden'));
		for (const spec of keys) {
			this.createKey(row, spec);
		}
		return row;
	}

	private createKey(row: HTMLElement, spec: IKeySpec): void {
		const key = append(row, $('button.volt-phone-key')) as HTMLButtonElement;
		key.classList.add(...voltButtonClasses('secondary'));
		key.type = 'button';
		// Never focused: the keyboard stays up and the terminal or editor keeps the caret.
		key.tabIndex = -1;
		key.setAttribute('aria-label', spec.title ?? spec.label);
		key.classList.toggle('volt-phone-key-group', !!spec.group);
		if (spec.icon) {
			append(key, $('span.volt-phone-key-icon')).classList.add(...ThemeIcon.asClassNameArray(spec.icon));
		} else {
			key.textContent = spec.label;
		}
		if (spec.id === 'ctrl' || spec.id === 'alt') {
			this.modifierKeys.set(spec.id, key);
			key.setAttribute('aria-pressed', 'false');
		}

		let firedAt = 0;
		const fire = () => {
			firedAt = Date.now();
			this.press(spec.id);
		};
		this._register(addDisposableListener(key, 'pointerdown', (e: PointerEvent) => {
			// Keeps focus where it is (a mouse or pen; a finger's tap is stopped at touchend).
			e.preventDefault();
			if (!e.isPrimary) {
				return;
			}
			this.endPress?.();
			const win = getWindow(key);
			const startX = e.clientX;
			const startY = e.clientY;
			let repeated = false;
			let timer: number | undefined;
			if (spec.repeat) {
				timer = win.setTimeout(() => {
					repeated = true;
					fire();
					timer = win.setInterval(fire, REPEAT_INTERVAL);
				}, REPEAT_DELAY);
			}
			key.classList.add('pressed');
			const listeners: { dispose(): void }[] = [];
			const end = () => {
				win.clearTimeout(timer);
				win.clearInterval(timer);
				key.classList.remove('pressed');
				listeners.forEach(listener => listener.dispose());
				if (this.endPress === end) {
					this.endPress = undefined;
				}
			};
			this.endPress = end;
			listeners.push(
				addDisposableListener(key, 'pointermove', (move: PointerEvent) => {
					if (move.pointerId === e.pointerId && Math.hypot(move.clientX - startX, move.clientY - startY) > TAP_SLOP) {
						end();
					}
				}),
				addDisposableListener(key, 'pointerup', (up: PointerEvent) => {
					if (up.pointerId === e.pointerId) {
						end();
						if (!repeated) {
							fire();
						}
					}
				}),
				// The row started scrolling.
				addDisposableListener(key, 'pointercancel', end),
			);
		}));
		// A finger's tap would go on to the mouse events and a click, which move focus to the key.
		this._register(addDisposableListener(key, 'touchend', (e: TouchEvent) => {
			if (Date.now() - firedAt < 500 && e.cancelable) {
				e.preventDefault();
			}
		}));
		this._register(addDisposableListener(key, 'mousedown', e => e.preventDefault()));
		// A screen reader's activation comes as a click alone.
		this._register(addDisposableListener(key, 'click', () => {
			if (Date.now() - firedAt > 500) {
				fire();
			}
		}));
	}

	private press(id: string): void {
		const target = this.target;
		if (!target) {
			return;
		}
		postToVoltShell({ type: 'haptic', style: 'light' });
		if (target.kind === 'terminal') {
			this.pressTerminalKey(target.instance, id);
		} else {
			this.pressEditorKey(target.editor, id);
		}
	}

	private pressEditorKey(editor: ICodeEditor, id: string): void {
		const command = EDITOR_COMMANDS[id];
		if (command) {
			editor.trigger(TRIGGER_SOURCE, command, null);
		} else if (id === 'save') {
			void this.commandService.executeCommand('workbench.action.files.save');
		} else if (id === 'esc') {
			// What Escape is bound to where focus is: the find widget, suggestions, extra cursors.
			const doc = this.root.ownerDocument;
			const element = (doc.activeElement as HTMLElement | null) ?? doc.body;
			for (const type of ['keydown', 'keyup']) {
				element.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
			}
		}
	}

	private pressTerminalKey(instance: ITerminalInstance, id: string): void {
		if (id === 'ctrl' || id === 'alt') {
			this.tapModifier(id);
			return;
		}
		if (id === 'paste') {
			void this.paste(instance);
			return;
		}
		const ctrl = this.modifiers.ctrl !== 'off';
		const alt = this.modifiers.alt !== 'off';
		// xterm's modifier parameter: 1 + 2 for Alt + 4 for Ctrl.
		const modifier = 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0);
		const application = !!instance.xterm?.raw.modes.applicationCursorKeysMode;
		let data: string;
		switch (id) {
			case 'esc': data = '\x1b'; break;
			case 'tab': data = alt ? '\x1b\t' : '\t'; break;
			case 'up': data = cursorSequence('A', modifier, application); break;
			case 'down': data = cursorSequence('B', modifier, application); break;
			case 'right': data = cursorSequence('C', modifier, application); break;
			case 'left': data = cursorSequence('D', modifier, application); break;
			case 'home': data = cursorSequence('H', modifier, application); break;
			case 'end': data = cursorSequence('F', modifier, application); break;
			case 'pageUp': data = modifier > 1 ? `\x1b[5;${modifier}~` : '\x1b[5~'; break;
			case 'pageDown': data = modifier > 1 ? `\x1b[6;${modifier}~` : '\x1b[6~'; break;
			default: data = this.withModifiers(id); break;
		}
		this.consumeModifiers();
		sendToTerminal(instance, data);
	}

	private async paste(instance: ITerminalInstance): Promise<void> {
		const contribution = instance.getContribution<ITerminalPaste>('terminal.clipboard');
		if (contribution) {
			await contribution.paste();
			return;
		}
		const text = await this.clipboardService.readText();
		if (text) {
			instance.xterm?.raw.paste(text);
		}
	}

	//#endregion

	//#region Ctrl and Alt

	/** One tap: for the next key. Two quick taps: until tapped again. */
	private tapModifier(modifier: Modifier): void {
		const now = Date.now();
		const state = this.modifiers[modifier];
		this.modifiers[modifier] = state === 'off' ? 'once' : state === 'once' && now - this.modifierTappedAt[modifier] < LOCK_TAP_WINDOW ? 'locked' : 'off';
		this.modifierTappedAt[modifier] = now;
		this.renderModifiers();
	}

	private modifierWaiting(): boolean {
		return this.modifiers.ctrl !== 'off' || this.modifiers.alt !== 'off';
	}

	/** A typed character as Ctrl and Alt make it: its control character, after an ESC. */
	private withModifiers(text: string): string {
		let data = text;
		if (this.modifiers.ctrl !== 'off') {
			data = (controlCharacter(text[0]) ?? text[0]) + text.slice(1);
		}
		return this.modifiers.alt !== 'off' ? `\x1b${data}` : data;
	}

	private consumeModifiers(): void {
		let changed = false;
		for (const modifier of ['ctrl', 'alt'] as const) {
			if (this.modifiers[modifier] === 'once') {
				this.modifiers[modifier] = 'off';
				changed = true;
			}
		}
		if (changed) {
			this.renderModifiers();
		}
	}

	private resetModifiers(): void {
		this.modifiers.ctrl = 'off';
		this.modifiers.alt = 'off';
		this.renderModifiers();
	}

	private renderModifiers(): void {
		for (const [modifier, key] of this.modifierKeys) {
			const state = this.modifiers[modifier];
			key.classList.toggle('active', state !== 'off');
			key.classList.toggle('locked', state === 'locked');
			key.setAttribute('aria-pressed', String(state !== 'off'));
		}
	}

	/** A letter from the phone's keyboard (iOS sends its keydown). */
	private onKeyDown(e: KeyboardEvent): void {
		const instance = this.waitingTerminal(e.target);
		if (!instance || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) {
			return;
		}
		e.preventDefault();
		e.stopImmediatePropagation();
		const data = this.withModifiers(e.key);
		this.consumeModifiers();
		sendToTerminal(instance, data);
	}

	/** A letter from a keyboard that only says what it inserts (Android's keydown has no key). */
	private onBeforeInput(e: InputEvent): void {
		const instance = this.waitingTerminal(e.target);
		if (!instance || e.inputType !== 'insertText' || !e.data || !e.cancelable) {
			return;
		}
		e.preventDefault();
		e.stopImmediatePropagation();
		const data = this.withModifiers(e.data);
		this.consumeModifiers();
		sendToTerminal(instance, data);
	}

	private waitingTerminal(eventTarget: EventTarget | null): ITerminalInstance | undefined {
		const target = this.target;
		if (target?.kind !== 'terminal' || !this.modifierWaiting() || !isHTMLElement(eventTarget) || !target.instance.xterm?.raw.element?.contains(eventTarget)) {
			return undefined;
		}
		return target.instance;
	}

	//#endregion
}

/** As typed: through xterm's input, so it scrolls to the prompt and reaches the shell like a key. */
function sendToTerminal(instance: ITerminalInstance, data: string): void {
	if (instance.xterm) {
		instance.xterm.raw.input(data, true);
	} else {
		void instance.sendText(data, false);
	}
}

/** An arrow, Home or End with xterm's encoding: `CSI 1;m X` with modifiers, `SS3 X` in application cursor mode. */
function cursorSequence(final: string, modifier: number, application: boolean): string {
	if (modifier > 1) {
		return `\x1b[1;${modifier}${final}`;
	}
	return application ? `\x1bO${final}` : `\x1b[${final}`;
}

/** Ctrl and a key, as a terminal sends it (Ctrl+C is ETX), or undefined when it has none. */
function controlCharacter(char: string): string | undefined {
	const code = char.toUpperCase().charCodeAt(0);
	// @, A to Z, [, \, ], ^ and _.
	if (code >= 64 && code <= 95) {
		return String.fromCharCode(code - 64);
	}
	switch (char) {
		case ' ': case '2': return '\x00';
		case '3': return '\x1b';
		case '4': case '|': return '\x1c';
		case '5': return '\x1d';
		case '6': case '~': return '\x1e';
		case '7': case '/': case '-': return '\x1f';
		case '8': case '?': return '\x7f';
		default: return undefined;
	}
}

registerWorkbenchContribution2(VoltPhoneKeysContribution.ID, VoltPhoneKeysContribution, WorkbenchPhase.AfterRestored);
