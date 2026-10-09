/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, getActiveWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { localize2 } from '../../../../../nls.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { InputFocusedContext } from '../../../../../platform/contextkey/common/contextkeys.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { GroupsOrder, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { AgentSidePanel } from '../chrome/agentSidePanel.js';
import { AgentEditor } from './agentEditor.js';
import { AGENT_SIDE_PANEL_VIEW_ID } from './agentEditorInput.js';
import { CONTEXT_AGENT_FIND_INPUT_FOCUSED, CONTEXT_IN_AGENT_INPUT } from './agentFindWidget.js';
import { pageScrollTarget, threadGlide } from './agentThreadScroll.js';
import { AgentThreadView } from './agentThreadView.js';
import { AgentTurnNav } from './agentTurnNav.js';

/** Keyboard focus is in a chat: its composer, its transcript, or nowhere while a chat is the active editor. */
export const CONTEXT_AGENT_CHAT_FOCUS = new RawContextKey<boolean>('voltAgentChatFocus', false);

export const AGENT_SCROLL_PAGE_UP_COMMAND_ID = 'workbench.action.voltAgent.scrollPageUp';
export const AGENT_SCROLL_PAGE_DOWN_COMMAND_ID = 'workbench.action.voltAgent.scrollPageDown';
export const AGENT_SCROLL_TOP_COMMAND_ID = 'workbench.action.voltAgent.scrollToTop';
export const AGENT_SCROLL_BOTTOM_COMMAND_ID = 'workbench.action.voltAgent.scrollToBottom';
export const AGENT_PREVIOUS_MESSAGE_COMMAND_ID = 'workbench.action.voltAgent.previousMessage';
export const AGENT_NEXT_MESSAGE_COMMAND_ID = 'workbench.action.voltAgent.nextMessage';

const AGENT_EDITOR_ROOT = '.volt-agent-editor';

/** In the chat, and either in its composer or in no text field at all (the find box keeps its keys). */
const inChatNotOtherInput = ContextKeyExpr.and(
	CONTEXT_AGENT_CHAT_FOCUS,
	CONTEXT_AGENT_FIND_INPUT_FOCUSED.negate(),
	ContextKeyExpr.or(InputFocusedContext.negate(), CONTEXT_IN_AGENT_INPUT),
);

/** In the chat but not typing anywhere: Home and End belong to the composer's text otherwise. */
const inChatNotTyping = ContextKeyExpr.and(CONTEXT_AGENT_CHAT_FOCUS, InputFocusedContext.negate());

/**
 * Keeps `voltAgentChatFocus` in step with the focused element. Clicking transcript text leaves
 * focus on the page body, which counts while a chat is the active editor.
 */
class AgentChatFocusContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentChatFocus';

	private readonly key: IContextKey<boolean>;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this.key = CONTEXT_AGENT_CHAT_FOCUS.bindTo(contextKeyService);
		const doc = mainWindow.document;
		this._register(addDisposableListener(doc, 'focusin', () => this.sync(), true));
		// Focus leaving to nothing reports the body only after the event.
		this._register(addDisposableListener(doc, 'focusout', () => mainWindow.setTimeout(() => this.sync(), 0), true));
		this._register(this.editorService.onDidActiveEditorChange(() => this.sync()));
		this.sync();
	}

	private sync(): void {
		const active = mainWindow.document.activeElement;
		let inChat = isHTMLElement(active) && !!active.closest(AGENT_EDITOR_ROOT);
		if (!inChat && (!active || active === mainWindow.document.body)) {
			inChat = this.editorService.activeEditorPane instanceof AgentEditor;
		}
		this.key.set(inChat);
	}
}

registerWorkbenchContribution2(AgentChatFocusContribution.ID, AgentChatFocusContribution, WorkbenchPhase.AfterRestored);

function agentEditors(accessor: ServicesAccessor): AgentEditor[] {
	const editors: AgentEditor[] = [];
	for (const group of accessor.get(IEditorGroupsService).getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
		if (group.activeEditorPane instanceof AgentEditor) {
			editors.push(group.activeEditorPane);
		}
	}
	const side = accessor.get(IViewsService).getViewWithId<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID)?.getActiveAgentEditor();
	if (side) {
		editors.push(side);
	}
	return editors;
}

/** The chat holding focus, else the active chat when focus is on nothing. */
function focusedThread(accessor: ServicesAccessor): AgentThreadView | undefined {
	const active = getActiveWindow().document.activeElement;
	const editors = agentEditors(accessor);
	for (const editor of editors) {
		const thread = editor.getThreadView();
		const root = thread?.element.closest(AGENT_EDITOR_ROOT);
		if (thread && root && active && root.contains(active)) {
			return thread;
		}
	}
	const pane = accessor.get(IEditorService).activeEditorPane;
	return pane instanceof AgentEditor ? pane.getThreadView() : undefined;
}

function focusedComposer(accessor: ServicesAccessor): ICodeEditor | undefined {
	const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
	return editor?.getModel()?.uri.scheme === 'volt-agent-input' ? editor : undefined;
}

/**
 * Whether Page Up / Page Down should move the caret inside the composer instead: only when its
 * text runs over several lines and the caret is not already on the edge line in that direction,
 * as in Slack and ChatGPT. From the first (or last) line the key pages the transcript.
 */
function composerTakesPageKey(editor: ICodeEditor, direction: -1 | 1): boolean {
	const model = editor.getModel();
	const position = editor.getPosition();
	if (!model || !position) {
		return false;
	}
	const caretTop = editor.getTopForPosition(position.lineNumber, position.column);
	const edgeLine = direction < 0 ? 1 : model.getLineCount();
	const edgeTop = editor.getTopForPosition(edgeLine, direction < 0 ? 1 : model.getLineMaxColumn(edgeLine));
	return direction < 0 ? caretTop > edgeTop : caretTop < edgeTop;
}

function page(accessor: ServicesAccessor, direction: -1 | 1): void {
	const composer = focusedComposer(accessor);
	if (composer && composerTakesPageKey(composer, direction)) {
		composer.trigger('keyboard', direction < 0 ? 'cursorPageUp' : 'cursorPageDown', null);
		return;
	}
	const thread = focusedThread(accessor);
	if (!thread) {
		return;
	}
	const glide = threadGlide(thread.scroll, thread.element);
	const dims = thread.scroll.getScrollDimensions();
	glide.glideTo(pageScrollTarget(glide.target, dims.height, dims.scrollHeight, direction));
}

function scrollToEnd(accessor: ServicesAccessor, end: 'top' | 'bottom'): void {
	const thread = focusedThread(accessor);
	if (!thread) {
		return;
	}
	const dims = thread.scroll.getScrollDimensions();
	threadGlide(thread.scroll, thread.element).glideTo(end === 'top' ? 0 : dims.scrollHeight - dims.height);
}

function stepMessage(accessor: ServicesAccessor, direction: -1 | 1): void {
	const thread = focusedThread(accessor);
	if (!thread) {
		return;
	}
	const nav = AgentTurnNav.forThread(thread);
	if (!nav?.stepTo(direction) && direction > 0) {
		// Past the last message: the end of its reply.
		scrollToEnd(accessor, 'bottom');
	}
}

const pageWeight = KeybindingWeight.WorkbenchContrib + 20;

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_SCROLL_PAGE_UP_COMMAND_ID,
			title: localize2('voltAgent.scrollPageUp', "Scroll Chat Up a Page"),
			category: Categories.View,
			f1: true,
			precondition: CONTEXT_AGENT_CHAT_FOCUS,
			keybinding: { primary: KeyCode.PageUp, weight: pageWeight, when: ContextKeyExpr.and(inChatNotOtherInput, ContextKeyExpr.not('suggestWidgetVisible')) },
		});
	}
	run(accessor: ServicesAccessor): void {
		page(accessor, -1);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_SCROLL_PAGE_DOWN_COMMAND_ID,
			title: localize2('voltAgent.scrollPageDown', "Scroll Chat Down a Page"),
			category: Categories.View,
			f1: true,
			precondition: CONTEXT_AGENT_CHAT_FOCUS,
			keybinding: { primary: KeyCode.PageDown, weight: pageWeight, when: ContextKeyExpr.and(inChatNotOtherInput, ContextKeyExpr.not('suggestWidgetVisible')) },
		});
	}
	run(accessor: ServicesAccessor): void {
		page(accessor, 1);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_SCROLL_TOP_COMMAND_ID,
			title: localize2('voltAgent.scrollToTop', "Scroll Chat to Top"),
			category: Categories.View,
			f1: true,
			precondition: CONTEXT_AGENT_CHAT_FOCUS,
			keybinding: { primary: KeyCode.Home, mac: { primary: KeyCode.Home, secondary: [KeyMod.CtrlCmd | KeyCode.UpArrow] }, weight: pageWeight, when: inChatNotTyping },
		});
	}
	run(accessor: ServicesAccessor): void {
		scrollToEnd(accessor, 'top');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_SCROLL_BOTTOM_COMMAND_ID,
			title: localize2('voltAgent.scrollToBottom', "Scroll Chat to Bottom"),
			category: Categories.View,
			f1: true,
			precondition: CONTEXT_AGENT_CHAT_FOCUS,
			keybinding: { primary: KeyCode.End, mac: { primary: KeyCode.End, secondary: [KeyMod.CtrlCmd | KeyCode.DownArrow] }, weight: pageWeight, when: inChatNotTyping },
		});
	}
	run(accessor: ServicesAccessor): void {
		scrollToEnd(accessor, 'bottom');
	}
});

// ⌥⌘↑/↓ (Ctrl+Alt+↑/↓ elsewhere) add cursors in a code editor; in the chat they walk the sent
// messages. The composer is a code editor too, but extra cursors mean nothing in a prompt.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_PREVIOUS_MESSAGE_COMMAND_ID,
			title: localize2('voltAgent.previousMessage', "Go to Previous Message in Chat"),
			category: Categories.View,
			f1: true,
			precondition: CONTEXT_AGENT_CHAT_FOCUS,
			keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.UpArrow, weight: pageWeight, when: inChatNotOtherInput },
		});
	}
	run(accessor: ServicesAccessor): void {
		stepMessage(accessor, -1);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGENT_NEXT_MESSAGE_COMMAND_ID,
			title: localize2('voltAgent.nextMessage', "Go to Next Message in Chat"),
			category: Categories.View,
			f1: true,
			precondition: CONTEXT_AGENT_CHAT_FOCUS,
			keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.DownArrow, weight: pageWeight, when: inChatNotOtherInput },
		});
	}
	run(accessor: ServicesAccessor): void {
		stepMessage(accessor, 1);
	}
});
