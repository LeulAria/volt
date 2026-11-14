/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IEditorOptions } from '../../../../../editor/common/config/editorOptions.js';

type CaretBlinking = NonNullable<IEditorOptions['cursorBlinking']>;

/**
 * How long the composer's caret blinks after the last key, click or focus before it holds still (GTK's
 * `gtk-cursor-blink-timeout` is the same 10 s). Each blink is a frame: style, paint and a GPU swap twice a second,
 * and the display link kept running between them. A focused composer in a window left alone cost about 2.5 % of a
 * core in the renderer and GPU processes for a caret nobody watched (round 4, A6).
 */
export const CARET_REST_MS = 10_000;

/**
 * The caret's blinking `sinceInputMs` after the last input: the configured style while input is recent, solid once
 * it is older than {@link CARET_REST_MS}; `recheckIn` is when it changes next.
 */
export function caretBlinking(configured: CaretBlinking | undefined, sinceInputMs: number): { blinking: CaretBlinking; recheckIn?: number } {
	const style = configured ?? 'blink';
	if (style === 'solid') {
		return { blinking: style };
	}
	return sinceInputMs >= CARET_REST_MS ? { blinking: 'solid' } : { blinking: style, recheckIn: CARET_REST_MS - sinceInputMs };
}

/**
 * Rests a composer's caret: it blinks as configured while the composer is in use and holds still (shown, not
 * blinking) once nothing has been typed, clicked or focused there for {@link CARET_REST_MS}. Any input starts the
 * blinking again. {@link override} is what the composer's options must say while rested, so a later
 * `updateOptions` with the whole option set keeps the rest.
 */
export class AgentCaretRest extends Disposable {

	private lastInput = Date.now();
	private rested = false;
	private timer: number | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly configured: () => CaretBlinking | undefined,
		private readonly now: () => number = Date.now,
	) {
		super();
		const input = () => this.input();
		this._register(editor.onDidFocusEditorText(input));
		this._register(editor.onDidChangeCursorPosition(input));
		this._register(editor.onDidChangeModelContent(input));
		this._register(editor.onKeyDown(input));
		this._register(editor.onMouseDown(input));
		// An unfocused caret does not blink: nothing to rest until the composer has focus again.
		this._register(editor.onDidBlurEditorText(() => this.clearTimer()));
		this._register({ dispose: () => this.clearTimer() });
		if (editor.hasTextFocus()) {
			this.input();
		}
	}

	/** The `cursorBlinking` the composer's options must carry: solid while rested, else the configured style. */
	override(): CaretBlinking | undefined {
		return this.rested ? 'solid' : this.configured();
	}

	private input(): void {
		this.lastInput = this.now();
		if (this.rested) {
			this.rested = false;
			this.editor.updateOptions({ cursorBlinking: this.configured() ?? 'blink' });
		}
		// One timer per rest: input only moves `lastInput`, and the timer checks it when it fires.
		if (this.timer === undefined) {
			this.arm(caretBlinking(this.configured(), 0).recheckIn);
		}
	}

	private arm(ms: number | undefined): void {
		if (ms === undefined) {
			return;
		}
		const win = getWindow(this.editor.getDomNode());
		this.timer = win.setTimeout(() => {
			this.timer = undefined;
			if (!this.editor.hasTextFocus()) {
				return;
			}
			const next = caretBlinking(this.configured(), this.now() - this.lastInput);
			if (next.recheckIn !== undefined) {
				this.arm(next.recheckIn);
			} else if (next.blinking === 'solid' && !this.rested) {
				this.rested = true;
				this.editor.updateOptions({ cursorBlinking: 'solid' });
			}
		}, ms);
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			getWindow(this.editor.getDomNode()).clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}
