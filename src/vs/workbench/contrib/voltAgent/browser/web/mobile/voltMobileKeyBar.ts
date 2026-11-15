/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The keys a phone's keyboard does not have, on a bar riding on top of it while code or a terminal
// has focus: Esc, Tab, Ctrl, Alt, Shift, the arrows, the symbols code is made of, undo, the command
// palette, and a key that puts the keyboard away. Keys go through the workbench's own paths: in an
// editor a named key or a chord is dispatched as that keybinding (so Shift+Right selects, Tab indents
// and every extension's keybinding works) and a symbol is typed (so brackets auto-close); in a terminal
// they are the escape sequences a real keyboard sends. Ctrl, Alt and Shift latch for the next key,
// on the bar or the keyboard; a double tap locks them. `volt.mobile.keyBar.keys` lists the keys.

import { $, addDisposableListener, append, getActiveElement, getWindow, isHTMLElement } from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { voltHaptic } from '../../../../../../base/browser/ui/voltMobile/voltTouchFeedback.js';
import { VoltViewport } from '../../../../../../base/browser/ui/voltMobile/voltViewport.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { OperatingSystem, OS } from '../../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { ICodeEditor } from '../../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../../../editor/common/config/editorOptions.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../../platform/configuration/common/configurationRegistry.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { Registry } from '../../../../../../platform/registry/common/platform.js';
import { ITerminalInstance, ITerminalService } from '../../../../terminal/browser/terminal.js';

export const KEY_BAR_ENABLED_SETTING = 'volt.mobile.keyBar.enabled';
export const KEY_BAR_KEYS_SETTING = 'volt.mobile.keyBar.keys';

export const DEFAULT_KEY_BAR_KEYS: readonly string[] = [
	'esc', 'tab', 'ctrl', 'alt', 'shift', 'left', 'down', 'up', 'right',
	'{', '}', '(', ')', '[', ']', '<', '>', '=', ';', ':', '"', '\'', '`', '/', '\\', '|', '&', '!', '-', '_', '+', '*', '$', '#', '%',
	'home', 'end', 'undo', 'redo', 'commands',
];

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.mobile',
	title: localize('voltMobile.configTitle', "Volt on Phones"),
	type: 'object',
	properties: {
		[KEY_BAR_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltMobile.keyBar.enabled', "Show a bar of programming keys above the on-screen keyboard while an editor or a terminal has focus."),
		},
		[KEY_BAR_KEYS_SETTING]: {
			type: 'array',
			items: { type: 'string' },
			default: DEFAULT_KEY_BAR_KEYS,
			markdownDescription: localize('voltMobile.keyBar.keys', "The keys on the bar above the on-screen keyboard, left to right. Named keys: `esc`, `tab`, `ctrl`, `alt`, `shift`, `left`, `right`, `up`, `down`, `home`, `end`, `pageup`, `pagedown`, `undo`, `redo`, `commands` (the Command Palette). `command:<id>` runs a command. Anything else is typed as written."),
		},
	},
});

export type KeyBarModifier = 'ctrl' | 'alt' | 'shift';
export type KeyBarNamedKey = 'esc' | 'tab' | 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'pageup' | 'pagedown';

export type KeyBarKey =
	| { readonly kind: 'modifier'; readonly modifier: KeyBarModifier; readonly label: string }
	| { readonly kind: 'key'; readonly key: KeyBarNamedKey; readonly label: string; readonly icon?: ThemeIcon }
	| { readonly kind: 'text'; readonly text: string; readonly label: string }
	| { readonly kind: 'command'; readonly command: string; readonly label: string; readonly icon?: ThemeIcon; readonly editorOnly?: boolean };

export interface IKeyBarModifiers {
	readonly ctrl: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
}

const NAMED_KEYS: Record<KeyBarNamedKey, { readonly label: string; readonly icon?: ThemeIcon }> = {
	esc: { label: 'esc' },
	tab: { label: 'tab' },
	left: { label: localize('voltKeyBar.left', "Left"), icon: Codicon.arrowLeft },
	right: { label: localize('voltKeyBar.right', "Right"), icon: Codicon.arrowRight },
	up: { label: localize('voltKeyBar.up', "Up"), icon: Codicon.arrowUp },
	down: { label: localize('voltKeyBar.down', "Down"), icon: Codicon.arrowDown },
	home: { label: 'home' },
	end: { label: 'end' },
	pageup: { label: 'pgup' },
	pagedown: { label: 'pgdn' },
};

/** Arrows, Home/End and Page keys repeat while held. */
const REPEATING = new Set<KeyBarNamedKey>(['left', 'right', 'up', 'down', 'pageup', 'pagedown']);

/** What one entry of `volt.mobile.keyBar.keys` stands for; undefined for an empty one. */
export function parseKeyBarKey(token: string): KeyBarKey | undefined {
	if (typeof token !== 'string' || token.length === 0) {
		return undefined;
	}
	const name = token.toLowerCase();
	if (name === 'ctrl' || name === 'alt' || name === 'shift') {
		return { kind: 'modifier', modifier: name, label: name === 'shift' ? '⇧' : name };
	}
	if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, name)) {
		const key = name as KeyBarNamedKey;
		return { kind: 'key', key, ...NAMED_KEYS[key] };
	}
	switch (name) {
		case 'undo': return { kind: 'command', command: 'undo', label: localize('voltKeyBar.undo', "Undo"), icon: Codicon.discard, editorOnly: true };
		case 'redo': return { kind: 'command', command: 'redo', label: localize('voltKeyBar.redo', "Redo"), icon: Codicon.redo, editorOnly: true };
		case 'commands': return { kind: 'command', command: 'workbench.action.showCommands', label: localize('voltKeyBar.commands', "Command Palette"), icon: Codicon.symbolKeyword };
	}
	if (name.startsWith('command:') && token.length > 'command:'.length) {
		const command = token.slice('command:'.length);
		return { kind: 'command', command, label: command };
	}
	return { kind: 'text', text: token, label: token };
}

/** The keybinding label (`ctrl+shift+left`) a key and the latched modifiers make in an editor. */
export function editorKeybindingLabel(key: KeyBarNamedKey | string, modifiers: IKeyBarModifiers, os: OperatingSystem = OS): string {
	const parts: string[] = [];
	// The bar's Ctrl is the platform's primary modifier: Cmd+S saves on an iPad, Ctrl+S on a phone.
	if (modifiers.ctrl) {
		parts.push(os === OperatingSystem.Macintosh ? 'cmd' : 'ctrl');
	}
	if (modifiers.shift) {
		parts.push('shift');
	}
	if (modifiers.alt) {
		parts.push('alt');
	}
	parts.push(key === 'esc' ? 'escape' : key.toLowerCase());
	return parts.join('+');
}

const CSI_FINAL: Partial<Record<KeyBarNamedKey, string>> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
const TILDE_CODE: Partial<Record<KeyBarNamedKey, number>> = { pageup: 5, pagedown: 6 };

/**
 * What a terminal receives for a key and the latched modifiers, as an xterm-compatible keyboard sends it.
 * @param applicationCursor the program asked for application cursor keys (vim, less): unmodified arrows send `ESC O`.
 */
export function terminalSequence(key: KeyBarKey, modifiers: IKeyBarModifiers, applicationCursor = false): string | undefined {
	if (key.kind === 'text') {
		return terminalText(key.text, modifiers);
	}
	if (key.kind !== 'key') {
		return undefined;
	}
	// xterm's modifier parameter: 1 + Shift 1 + Alt 2 + Ctrl 4.
	const param = 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
	switch (key.key) {
		case 'esc': return '\x1b';
		case 'tab': return modifiers.shift ? '\x1b[Z' : '\t';
	}
	const final = CSI_FINAL[key.key];
	if (final) {
		if (param === 1) {
			return applicationCursor ? `\x1bO${final}` : `\x1b[${final}`;
		}
		return `\x1b[1;${param}${final}`;
	}
	const code = TILDE_CODE[key.key];
	if (code !== undefined) {
		return param === 1 ? `\x1b[${code}~` : `\x1b[${code};${param}~`;
	}
	return undefined;
}

/** Text typed with the latched modifiers: Ctrl makes a control character, Alt an Esc prefix. */
export function terminalText(text: string, modifiers: IKeyBarModifiers): string {
	let out = modifiers.shift ? text.toUpperCase() : text;
	if (modifiers.ctrl && out.length === 1) {
		out = controlCharacter(out) ?? out;
	}
	return modifiers.alt ? `\x1b${out}` : out;
}

function controlCharacter(char: string): string | undefined {
	if (char === ' ' || char === '@' || char === '2') {
		return '\x00';
	}
	if (char === '?') {
		return '\x7f';
	}
	const code = char.toUpperCase().charCodeAt(0);
	// A-Z, then [ \ ] ^ _ (0x5B-0x5F): Ctrl clears the top bits.
	if (code >= 0x40 && code <= 0x5F) {
		return String.fromCharCode(code & 0x1F);
	}
	return undefined;
}

const enum LatchState {
	Off,
	/** For the next key only. */
	Once,
	/** Until tapped again. */
	Locked,
}

type KeyBarTarget =
	| { readonly kind: 'editor'; readonly editor: ICodeEditor; readonly element: HTMLElement }
	| { readonly kind: 'terminal'; readonly instance: ITerminalInstance | undefined; readonly element: HTMLElement };

const DOUBLE_TAP_MS = 320;
const REPEAT_DELAY_MS = 420;
const REPEAT_INTERVAL_MS = 55;

export class VoltMobileKeyBar extends Disposable {

	private readonly element: HTMLElement;
	private readonly row: HTMLElement;
	private readonly rendered = this._register(new DisposableStore());
	private readonly latches = new Map<KeyBarModifier, LatchState>();
	private readonly latchButtons = new Map<KeyBarModifier, HTMLElement>();
	private readonly lastLatchTap = new Map<KeyBarModifier, number>();
	private target: KeyBarTarget | undefined;
	private visible = false;
	private frame: number | undefined;
	private repeat: { timer: ReturnType<typeof setTimeout> | undefined; interval: number | undefined; fired: boolean } | undefined;

	constructor(
		private readonly root: HTMLElement,
		private readonly viewport: VoltViewport,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ICommandService private readonly commandService: ICommandService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();
		const win = getWindow(root);
		this.element = append(root, $('.volt-keybar.volt-no-long-press.hidden'));
		this.element.setAttribute('role', 'toolbar');
		this.element.setAttribute('aria-label', localize('voltKeyBar', "Programming Keys"));
		this._register(toDisposable(() => this.element.remove()));
		this.row = append(this.element, $('.volt-keybar-keys'));
		const hide = this.renderButton(this.element, localize('voltKeyBar.hide', "Hide Keyboard"), Codicon.chevronDown);
		hide.classList.add('volt-keybar-hide');
		this._register(addDisposableListener(hide, 'click', () => this.hideKeyboard()));

		// The field under the keyboard keeps focus: a key never takes it.
		for (const type of ['pointerdown', 'mousedown']) {
			this._register(addDisposableListener(this.element, type, e => e.preventDefault()));
		}

		this.render();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(KEY_BAR_KEYS_SETTING)) {
				this.render();
			}
			if (e.affectsConfiguration(KEY_BAR_ENABLED_SETTING)) {
				this.schedule();
			}
		}));
		this._register(viewport.onDidChange(() => this.schedule()));
		this._register(addDisposableListener(win.document, 'focusin', () => this.schedule()));
		this._register(addDisposableListener(win.document, 'focusout', () => this.schedule()));
		// A latched modifier applies to the next key typed on the keyboard too.
		this._register(addDisposableListener(win, 'keydown', e => this.onKeyboardKey(e), true));
		this._register(addDisposableListener(win, 'beforeinput', e => this.onKeyboardInput(e as InputEvent), true));
		this._register(toDisposable(() => {
			this.stopRepeat();
			if (this.frame !== undefined) {
				win.cancelAnimationFrame(this.frame);
			}
			viewport.setAccessoryBar(0);
		}));
		this.schedule();
	}

	private schedule(): void {
		if (this.frame === undefined) {
			this.frame = getWindow(this.root).requestAnimationFrame(() => {
				this.frame = undefined;
				this.update();
			});
		}
	}

	private update(): void {
		const enabled = this.configurationService.getValue<boolean>(KEY_BAR_ENABLED_SETTING) !== false;
		this.target = enabled && this.viewport.state.keyboardOpen ? this.findTarget() : undefined;
		const visible = !!this.target;
		this.element.classList.toggle('terminal', this.target?.kind === 'terminal');
		if (visible !== this.visible) {
			this.visible = visible;
			this.element.classList.toggle('hidden', !visible);
			if (!visible) {
				this.clearLatches(true);
				this.stopRepeat();
			}
		}
		this.viewport.setAccessoryBar(visible ? this.element.offsetHeight : 0);
	}

	private findTarget(): KeyBarTarget | undefined {
		const active = getActiveElement();
		if (!isHTMLElement(active) || !this.root.contains(active)) {
			return undefined;
		}
		const xterm = active.closest<HTMLElement>('.xterm');
		if (xterm) {
			const instance = this.terminalService.instances.find(i => i.domElement?.contains(xterm)) ?? this.terminalService.activeInstance;
			return { kind: 'terminal', instance, element: active };
		}
		const editor = this.codeEditorService.getFocusedCodeEditor();
		// Code, not one-line inputs that happen to be editors (the commit message box keeps its own keys).
		if (editor && !editor.isSimpleWidget && editor.getDomNode()?.contains(active) && !editor.getOption(EditorOption.readOnly)) {
			return { kind: 'editor', editor, element: active };
		}
		return undefined;
	}

	private render(): void {
		this.rendered.clear();
		this.latchButtons.clear();
		this.row.replaceChildren();
		const tokens = this.configurationService.getValue<unknown>(KEY_BAR_KEYS_SETTING);
		const list = Array.isArray(tokens) ? tokens : DEFAULT_KEY_BAR_KEYS;
		for (const token of list) {
			const key = typeof token === 'string' ? parseKeyBarKey(token) : undefined;
			if (!key) {
				continue;
			}
			const icon = key.kind === 'key' || key.kind === 'command' ? key.icon : undefined;
			const button = this.renderButton(this.row, key.label, icon);
			if (key.kind === 'modifier') {
				button.classList.add('modifier');
				button.setAttribute('aria-pressed', 'false');
				this.latchButtons.set(key.modifier, button);
				this.rendered.add(addDisposableListener(button, 'click', () => this.toggleLatch(key.modifier)));
				continue;
			}
			if (key.kind === 'command' && key.editorOnly) {
				button.classList.add('editor-only');
			}
			if (key.kind === 'key' && REPEATING.has(key.key)) {
				this.rendered.add(addDisposableListener(button, 'pointerdown', () => this.startRepeat(key)));
				for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
					this.rendered.add(addDisposableListener(button, type, () => this.stopRepeat(true)));
				}
			}
			this.rendered.add(addDisposableListener(button, 'click', () => {
				if (this.repeat?.fired) {
					this.repeat = undefined;
					return;
				}
				voltHaptic('tick');
				this.press(key);
			}));
		}
		this.syncLatches();
	}

	private renderButton(parent: HTMLElement, label: string, icon: ThemeIcon | undefined): HTMLElement {
		const button = append(parent, $('button.volt-keybar-key')) as HTMLButtonElement;
		button.type = 'button';
		button.tabIndex = -1;
		if (icon) {
			button.classList.add('icon');
			button.appendChild(renderIcon(icon));
			button.setAttribute('aria-label', label);
		} else {
			button.textContent = label;
			// Names (esc, ctrl) set smaller than the symbols beside them.
			button.classList.toggle('word', label.length > 1);
		}
		return button;
	}

	private press(key: KeyBarKey): void {
		const target = this.target;
		if (!target) {
			return;
		}
		const modifiers = this.currentModifiers();
		if (target.kind === 'terminal') {
			if (key.kind === 'command') {
				void this.commandService.executeCommand(key.command);
			} else {
				const data = terminalSequence(key, modifiers, !!target.instance?.xterm?.raw.modes.applicationCursorKeysMode);
				if (data !== undefined) {
					void target.instance?.sendText(data, false);
				}
			}
		} else if (key.kind === 'command') {
			void this.commandService.executeCommand(key.command);
		} else if (key.kind === 'key') {
			this.keybindingService.dispatchByUserSettingsLabel(editorKeybindingLabel(key.key, modifiers), target.element);
		} else if (key.kind === 'text') {
			if ((modifiers.ctrl || modifiers.alt) && key.text.length === 1) {
				this.keybindingService.dispatchByUserSettingsLabel(editorKeybindingLabel(key.text, modifiers), target.element);
			} else {
				target.editor.trigger('keyboard', 'type', { text: key.text });
			}
		}
		this.clearLatches(false);
	}

	/** A key typed on the on-screen keyboard while Ctrl or Alt is latched becomes that chord. */
	private onKeyboardKey(e: KeyboardEvent): void {
		if (!this.visible || !this.hasChordLatch() || e.isComposing || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) {
			return;
		}
		if (this.typeChord(e.key)) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	/** Android keyboards send no key, only the text (keyCode 229): the same, from the input. */
	private onKeyboardInput(e: InputEvent): void {
		if (!this.visible || !this.hasChordLatch() || !e.cancelable || e.inputType !== 'insertText' || !e.data || e.data.length !== 1) {
			return;
		}
		if (this.typeChord(e.data)) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	private typeChord(char: string): boolean {
		const target = this.target;
		if (!target) {
			return false;
		}
		const modifiers = this.currentModifiers();
		if (target.kind === 'terminal') {
			void target.instance?.sendText(terminalText(char, modifiers), false);
		} else {
			this.keybindingService.dispatchByUserSettingsLabel(editorKeybindingLabel(char, modifiers), target.element);
		}
		voltHaptic('tick');
		this.clearLatches(false);
		return true;
	}

	private startRepeat(key: KeyBarKey): void {
		this.stopRepeat();
		const repeat = { timer: undefined as ReturnType<typeof setTimeout> | undefined, interval: undefined as number | undefined, fired: false };
		repeat.timer = setTimeout(() => {
			repeat.fired = true;
			this.press(key);
			repeat.interval = getWindow(this.root).setInterval(() => this.press(key), REPEAT_INTERVAL_MS);
		}, REPEAT_DELAY_MS);
		this.repeat = repeat;
	}

	/** @param keepFired leaves a repeat that fired in place, so the click its lift sends is dropped. */
	private stopRepeat(keepFired = false): void {
		const repeat = this.repeat;
		if (!repeat) {
			return;
		}
		clearTimeout(repeat.timer);
		getWindow(this.root).clearInterval(repeat.interval);
		if (!keepFired || !repeat.fired) {
			this.repeat = undefined;
		}
	}

	private toggleLatch(modifier: KeyBarModifier): void {
		voltHaptic('tick');
		const now = Date.now();
		const state = this.latches.get(modifier) ?? LatchState.Off;
		const doubleTap = now - (this.lastLatchTap.get(modifier) ?? 0) < DOUBLE_TAP_MS;
		this.lastLatchTap.set(modifier, now);
		let next: LatchState;
		if (state === LatchState.Off) {
			next = LatchState.Once;
		} else if (state === LatchState.Once && doubleTap) {
			next = LatchState.Locked;
		} else {
			next = LatchState.Off;
		}
		this.latches.set(modifier, next);
		this.syncLatches();
	}

	private currentModifiers(): IKeyBarModifiers {
		const on = (m: KeyBarModifier) => (this.latches.get(m) ?? LatchState.Off) !== LatchState.Off;
		return { ctrl: on('ctrl'), alt: on('alt'), shift: on('shift') };
	}

	private hasChordLatch(): boolean {
		const m = this.currentModifiers();
		return m.ctrl || m.alt;
	}

	/** After a key: one-shot modifiers let go, locked ones stay (all of them when the bar hides). */
	private clearLatches(all: boolean): void {
		let changed = false;
		for (const [modifier, state] of this.latches) {
			if (state === LatchState.Once || (all && state === LatchState.Locked)) {
				this.latches.set(modifier, LatchState.Off);
				changed = true;
			}
		}
		if (changed) {
			this.syncLatches();
		}
	}

	private syncLatches(): void {
		for (const [modifier, button] of this.latchButtons) {
			const state = this.latches.get(modifier) ?? LatchState.Off;
			button.classList.toggle('latched', state === LatchState.Once);
			button.classList.toggle('locked', state === LatchState.Locked);
			button.setAttribute('aria-pressed', state === LatchState.Off ? 'false' : 'true');
		}
	}

	private hideKeyboard(): void {
		const active = getActiveElement();
		if (isHTMLElement(active)) {
			active.blur();
		}
	}
}
