/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPane } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

/**
 * The agent window as a feature module sees it (spec H.11: a feature reaches the rest of Volt only
 * through the facade and its broker interfaces). Core (`voltAgent`) implements it; a module never
 * imports the agent window's own files.
 */

export const IVoltAgentWindowService = createDecorator<IVoltAgentWindowService>('voltAgentWindowService');

/** A chat a feature opened, to hand it a prompt. */
export interface IVoltChatPane {
	/** Keeps the transcript on screen when it is a side chat in a right panel (those show only the composer by default). */
	showTranscript(): void;
	/** Sends `prompt` as the user's next message; `display` is what the transcript shows for it. */
	submitPrompt(prompt: string, display?: { readonly text: string }): void;
}

/** A page's own right panel (a main tab's, like the Git Graph's): its side chats open there. */
export interface IVoltToolsPanel extends IDisposable {
	/** Shows the panel's saved tabs under `id`, a page's id rather than a chat's. */
	present(id: string): void;
	canOpen(): boolean;
	/** Sizes the panel within the page's frame (the page then lays out in what is left). */
	layout(dimension: Dimension): void;
	/** A new chat in the panel. */
	openNewChat(): Promise<IVoltChatPane | undefined>;
}

/** What a chat's composer gives a feature's card. */
export interface IVoltComposerTrayHost {
	/**
	 * The card shrunk to a chip, in the row above the composer: the composer's own button
	 * (`.volt-agent-composer-chip.hidden`), which the card fills and shows by removing `hidden`.
	 * The composer empties it again when the card goes.
	 */
	readonly chip: HTMLButtonElement;
	/** The chip showed or hid. */
	chipChanged(): void;
	/** The card changed height: the composer lays out again. */
	layout(): void;
}

/** A feature's card above a chat's composer (like the commit review), shown while the feature is loaded. */
export interface IVoltComposerTray extends IDisposable {
	/** Placed in the composer, above the question tray. */
	readonly element: HTMLElement;
	/** The chat the composer shows now (undefined: a new chat). */
	setSession(sessionKey: string | undefined): void;
}

export type VoltComposerTrayFactory = (host: IVoltComposerTrayHost) => IVoltComposerTray;

export interface IVoltAgentWindowService {
	readonly _serviceBrand: undefined;

	/**
	 * Adds a card to every chat's composer, open ones included, under `id` (the composer knows
	 * where each id's card and chip go) until disposed; disposing removes it from them all.
	 */
	registerComposerTray(id: string, factory: VoltComposerTrayFactory): IDisposable;
	composerTray(id: string): VoltComposerTrayFactory | undefined;
	readonly onDidChangeComposerTrays: Event<string>;

	/** The agent layout is on (rather than the IDE layout). */
	isAgentLayout(): boolean;
	/** The chat on screen: the active editor's, else the first chat any group shows. */
	visibleChat(): string | undefined;

	/**
	 * Opens `input` as a tab in the right panel of the chat on screen (preferring `sessionId`'s).
	 * Undefined when no chat can show one (the IDE layout): open it as a normal editor instead.
	 */
	openInTools(input: EditorInput, sessionId?: string, options?: IEditorOptions): Promise<IEditorPane | undefined> | undefined;
	/** Brings a tab that already lives in a right panel forward. False when none holds it. */
	revealInTools(input: EditorInput): boolean;
	/** A right panel saved under `id` has tabs to restore. */
	hasSavedTools(id: string): boolean;
	/** A right panel of its own for a page drawn in `content`, sized inside `frame`. */
	createToolsPanel(frame: HTMLElement, content: HTMLElement): IVoltToolsPanel;

	/** A new side chat in the right panel that holds `element` (a tab's content). Undefined: no panel holds it. */
	openSideChatBeside(element: HTMLElement): Promise<IVoltChatPane | undefined> | undefined;
	/** A new side chat in the right panel of the chat on screen (preferring `sessionId`'s). Undefined: no chat on screen. */
	openSideChatOnScreen(sessionId?: string): Promise<IVoltChatPane | undefined> | undefined;
	/** A new chat as a tab of its own. */
	openNewChat(): Promise<IVoltChatPane | undefined>;
}
