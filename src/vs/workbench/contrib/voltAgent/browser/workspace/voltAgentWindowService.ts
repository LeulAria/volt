/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { getLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IEditorPane } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IVoltAgentWindowService, IVoltChatPane, IVoltThreadCard, IVoltThreadCardProvider, IVoltToolsPanel, VoltComposerTrayFactory } from '../../../../services/voltPlugins/browser/voltAgentWindow.js';
import { AgentEditor } from '../editor/agentEditor.js';
import { AgentEditorInput, OPEN_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { AgentSurfaceHost, openInAgentTools, openSideChatBeside, openSideChatOnScreen, revealAgentToolEditor } from './agentSurfaceHost.js';
import { hasSavedAgentTools } from './agentToolsEditorPart.js';
import { visibleChatSession } from './agentVisibleChat.js';

/** A chat pane, or undefined when what opened isn't one. */
function chatPane(pane: IEditorPane | undefined): IVoltChatPane | undefined {
	if (!(pane instanceof AgentEditor)) {
		return undefined;
	}
	return {
		showTranscript: () => pane.showTranscriptInTools(),
		submitPrompt: (prompt, display, source) => pane.submitPrompt(prompt, display ? { text: display.text } : undefined, source),
		get sessionKey() { return pane.chatSessionKey; },
		isEmpty: () => pane.chatIsEmpty(),
	};
}

function chatPaneOf(opened: Promise<IEditorPane | undefined> | undefined): Promise<IVoltChatPane | undefined> | undefined {
	return opened?.then(chatPane);
}

/** The agent window for feature modules (`IVoltAgentWindowService`), over the right panel's own helpers. */
export class VoltAgentWindowService extends Disposable implements IVoltAgentWindowService {

	declare readonly _serviceBrand: undefined;

	private readonly trays = new Map<string, VoltComposerTrayFactory>();
	private readonly _onDidChangeComposerTrays = this._register(new Emitter<string>());
	readonly onDidChangeComposerTrays = this._onDidChangeComposerTrays.event;

	private readonly cardProviders = this._register(new DisposableMap<IVoltThreadCardProvider>());
	private readonly _onDidChangeThreadCards = this._register(new Emitter<string | undefined>());
	readonly onDidChangeThreadCards = this._onDidChangeThreadCards.event;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
	}

	registerComposerTray(id: string, factory: VoltComposerTrayFactory): IDisposable {
		if (this.trays.has(id)) {
			throw new Error(`A composer tray ${id} is already registered.`);
		}
		this.trays.set(id, factory);
		this._onDidChangeComposerTrays.fire(id);
		return toDisposable(() => {
			if (this.trays.get(id) === factory) {
				this.trays.delete(id);
				this._onDidChangeComposerTrays.fire(id);
			}
		});
	}

	composerTray(id: string): VoltComposerTrayFactory | undefined {
		return this.trays.get(id);
	}

	registerThreadCards(provider: IVoltThreadCardProvider): IDisposable {
		this.cardProviders.set(provider, provider.onDidChange(sessionKey => this._onDidChangeThreadCards.fire(sessionKey)));
		this._onDidChangeThreadCards.fire(undefined);
		return toDisposable(() => {
			if (this.cardProviders.has(provider)) {
				this.cardProviders.deleteAndDispose(provider);
				this._onDidChangeThreadCards.fire(undefined);
			}
		});
	}

	threadCards(sessionKey: string): readonly IVoltThreadCard[] {
		const cards: IVoltThreadCard[] = [];
		for (const provider of this.cardProviders.keys()) {
			cards.push(...provider.cards(sessionKey));
		}
		return cards;
	}

	isAgentLayout(): boolean {
		return getLayoutMode(this.layoutService) === 'agent';
	}

	visibleChat(): string | undefined {
		return this.instantiationService.invokeFunction(visibleChatSession);
	}

	chatPane(sessionKey?: string): IVoltChatPane | undefined {
		const panes = this.editorService.visibleEditorPanes.filter(pane => pane instanceof AgentEditor) as unknown as AgentEditor[];
		const active = this.editorService.activeEditorPane;
		const match = sessionKey !== undefined
			? panes.find(pane => pane.chatSessionKey === sessionKey)
			: active instanceof AgentEditor ? active : panes[0];
		return chatPane(match);
	}

	async openChat(sessionKey: string): Promise<void> {
		await this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, sessionKey);
	}

	openInTools(input: EditorInput, sessionId?: string, options?: IEditorOptions): Promise<IEditorPane | undefined> | undefined {
		return openInAgentTools(input, sessionId, options);
	}

	revealInTools(input: EditorInput): boolean {
		return revealAgentToolEditor(input);
	}

	hasSavedTools(id: string): boolean {
		return hasSavedAgentTools(this.storageService, id);
	}

	createToolsPanel(frame: HTMLElement, content: HTMLElement): IVoltToolsPanel {
		const host = this.instantiationService.createInstance(AgentSurfaceHost, frame, content);
		return {
			present: id => host.present(id),
			canOpen: () => host.canOpenTools(),
			layout: dimension => host.layout(dimension),
			openNewChat: () => host.openEditorInTools(this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri())).then(chatPane),
			dispose: () => host.dispose(),
		};
	}

	openSideChatBeside(element: HTMLElement): Promise<IVoltChatPane | undefined> | undefined {
		return chatPaneOf(openSideChatBeside(element));
	}

	openSideChatOnScreen(sessionId?: string): Promise<IVoltChatPane | undefined> | undefined {
		return chatPaneOf(openSideChatOnScreen(sessionId));
	}

	async openNewChat(): Promise<IVoltChatPane | undefined> {
		const input = this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri());
		return chatPane(await this.editorService.openEditor(input, { pinned: true }));
	}
}

registerSingleton(IVoltAgentWindowService, VoltAgentWindowService, InstantiationType.Delayed);
