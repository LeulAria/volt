/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SimpleFindWidget } from '../../codeEditor/browser/find/simpleFindWidget.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import {
	AGENT_FIND_HIDE_COMMAND_ID,
	AGENT_FIND_NEXT_COMMAND_ID,
	AGENT_FIND_PREVIOUS_COMMAND_ID,
	AGENT_FIND_TOGGLE_CASE_COMMAND_ID,
	AGENT_FIND_TOGGLE_REGEX_COMMAND_ID,
	AGENT_FIND_TOGGLE_WHOLE_WORD_COMMAND_ID,
} from './agentEditorInput.js';

export const CONTEXT_IN_AGENT_INPUT = new RawContextKey<boolean>('inAgentInput', false);
export const CONTEXT_AGENT_FIND_WIDGET_VISIBLE = new RawContextKey<boolean>('voltAgentFindWidgetVisible', false);
export const CONTEXT_AGENT_FIND_WIDGET_FOCUSED = new RawContextKey<boolean>('voltAgentFindFocus', false);
export const CONTEXT_AGENT_FIND_INPUT_FOCUSED = new RawContextKey<boolean>('voltAgentFindInputFocus', false);

export interface IAgentFindHost {
	findInThread(previous: boolean): void;
	findFirstInThread(): void;
	onFindQueryChanged(): boolean;
	getFindResultCount(): { resultIndex: number; resultCount: number };
	getSelectedThreadText(): string | undefined;
	focusAfterFindClosed(): void;
}

export class AgentFindWidget extends SimpleFindWidget {

	private readonly findWidgetVisible: IContextKey<boolean>;
	private readonly findWidgetFocused: IContextKey<boolean>;
	private readonly findInputFocused: IContextKey<boolean>;

	constructor(
		private readonly host: IAgentFindHost,
		@IContextViewService contextViewService: IContextViewService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHoverService hoverService: IHoverService,
		@IKeybindingService keybindingService: IKeybindingService,
	) {
		super({
			showCommonFindToggles: true,
			checkImeCompletionState: true,
			showResultCount: true,
			appendCaseSensitiveActionId: AGENT_FIND_TOGGLE_CASE_COMMAND_ID,
			appendRegexActionId: AGENT_FIND_TOGGLE_REGEX_COMMAND_ID,
			appendWholeWordsActionId: AGENT_FIND_TOGGLE_WHOLE_WORD_COMMAND_ID,
			previousMatchActionId: AGENT_FIND_PREVIOUS_COMMAND_ID,
			nextMatchActionId: AGENT_FIND_NEXT_COMMAND_ID,
			closeWidgetActionId: AGENT_FIND_HIDE_COMMAND_ID,
		}, contextViewService, contextKeyService, hoverService, keybindingService);

		this.findWidgetVisible = CONTEXT_AGENT_FIND_WIDGET_VISIBLE.bindTo(contextKeyService);
		this.findWidgetFocused = CONTEXT_AGENT_FIND_WIDGET_FOCUSED.bindTo(contextKeyService);
		this.findInputFocused = CONTEXT_AGENT_FIND_INPUT_FOCUSED.bindTo(contextKeyService);
	}

	find(previous: boolean): void {
		this.host.findInThread(previous);
		this.updateResultCount();
	}

	findFirst(): void {
		this.host.findFirstInThread();
		this.updateResultCount();
	}

	override reveal(initialInput?: string, animated = true): void {
		const seeded = initialInput ?? this.host.getSelectedThreadText();
		super.reveal(seeded, animated);
		this.findWidgetVisible.set(true);
		this.host.findFirstInThread();
		this.updateResultCount();
	}

	override show(initialInput?: string): void {
		super.show(initialInput);
		this.findWidgetVisible.set(true);
	}

	override hide(animated = true): void {
		super.hide(animated);
		this.findWidgetVisible.reset();
		this.host.focusAfterFindClosed();
	}

	protected _onInputChanged(): boolean {
		const found = this.host.onFindQueryChanged();
		this.updateResultCount();
		return found;
	}

	protected _onFocusTrackerFocus(): void {
		this.findWidgetFocused.set(true);
	}

	protected _onFocusTrackerBlur(): void {
		this.findWidgetFocused.reset();
	}

	protected _onFindInputFocusTrackerFocus(): void {
		this.findInputFocused.set(true);
	}

	protected _onFindInputFocusTrackerBlur(): void {
		this.findInputFocused.reset();
	}

	protected async _getResultCount(): Promise<{ resultIndex: number; resultCount: number } | undefined> {
		return this.host.getFindResultCount();
	}

	getCaseSensitive(): boolean {
		return this._getCaseSensitiveValue();
	}

	getWholeWord(): boolean {
		return this._getWholeWordValue();
	}

	getRegex(): boolean {
		return this._getRegexValue();
	}

	getQuery(): string {
		return this.inputValue;
	}

	override dispose(): void {
		this.findWidgetVisible.reset();
		this.findWidgetFocused.reset();
		this.findInputFocused.reset();
		super.dispose();
	}
}
