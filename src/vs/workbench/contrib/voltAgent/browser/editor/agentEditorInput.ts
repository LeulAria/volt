/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, GroupIdentifier, IEditorSerializer, IRevertOptions, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { AgentSessionStatus, IAgentHistoryService, IAgentSessionHandle } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import type { IAgentAssistantMessage, IAgentMessage, IAgentPromptDisplay, IAgentUserMessage } from './agentEditor.js';
import { AgentHistoryCodec, assistantSummary, userMessageText } from '../history/agentHistoryCodec.js';
import type { IAgentDisplayMention } from '../composer/agentMentions.js';

const AgentEditorIcon = registerIcon('volt-agent-editor-label-icon', Codicon.robot, localize('voltAgentEditorLabelIcon', 'Icon of the New Agent editor tab.'));
export const AgentSidePanelIcon = registerIcon('volt-agent-panel', Codicon.commentDiscussion, localize('voltAgentSidePanelIcon', 'Icon of the Toggle Agents Side Bar title-bar action.'));

export const AGENT_EDITOR_ID = 'workbench.editor.voltAgent';
export const AGENT_EDITOR_INPUT_ID = 'workbench.input.voltAgent';
export const NEW_AGENT_COMMAND_ID = 'workbench.action.newAgent';
export const NEW_AGENT_TAB_COMMAND_ID = 'workbench.action.voltAgent.newAgentTab';
export const REPLACE_AGENT_COMMAND_ID = 'workbench.action.voltAgent.replaceAgent';
export const OPEN_AGENT_COMMAND_ID = 'workbench.action.voltAgent.openSession';
export const OPEN_AGENT_HISTORY_COMMAND_ID = 'workbench.action.voltAgent.showHistory';
export const TOGGLE_AGENT_DRAWER_COMMAND_ID = 'workbench.action.voltAgent.toggleDrawer';
export const EXPORT_AGENT_TRANSCRIPT_COMMAND_ID = 'workbench.action.voltAgent.exportTranscript';
export const OPEN_AGENT_SETTINGS_COMMAND_ID = 'workbench.action.voltAgent.openSettings';
export const OPEN_AGENT_CUSTOMIZE_COMMAND_ID = 'workbench.action.voltAgent.customize';
export const OPEN_AGENT_SIDE_PANEL_COMMAND_ID = 'workbench.action.openAgentSidePanel';
export const AGENT_SIDE_PANEL_ID = 'workbench.panel.voltAgent';
export const AGENT_SIDE_PANEL_VIEW_ID = 'workbench.panel.voltAgent.view';

export const AGENT_SUBMIT_COMMAND_ID = 'workbench.action.voltAgent.submit';
export const AGENT_FIND_COMMAND_ID = 'workbench.action.voltAgent.find';
export const AGENT_FIND_HIDE_COMMAND_ID = 'workbench.action.voltAgent.hideFind';
export const AGENT_FIND_NEXT_COMMAND_ID = 'workbench.action.voltAgent.findNext';
export const AGENT_FIND_PREVIOUS_COMMAND_ID = 'workbench.action.voltAgent.findPrevious';
export const AGENT_FIND_TOGGLE_REGEX_COMMAND_ID = 'workbench.action.voltAgent.toggleFindRegex';
export const AGENT_FIND_TOGGLE_WHOLE_WORD_COMMAND_ID = 'workbench.action.voltAgent.toggleFindWholeWord';
export const AGENT_FIND_TOGGLE_CASE_COMMAND_ID = 'workbench.action.voltAgent.toggleFindCaseSensitive';
export const AGENT_EDITOR_LINE_NUMBERS_SETTING = 'volt.agent.editor.lineNumbers';

/** Streaming replies are snapshotted to disk at most this often. */
const PARTIAL_SNAPSHOT_INTERVAL_MS = 3000;

export interface IAgentQueuedPrompt {
	id: string;
	text: string;
	display?: IAgentPromptDisplay;
}

/**
 * Editor input for one agent session. Owns the durable history binding: it
 * loads the transcript and draft when first shown, records every turn as it
 * happens, and keeps the tab title in sync with the stored session title.
 */
export class AgentEditorInput extends EditorInput {

	static readonly TypeID = AGENT_EDITOR_INPUT_ID;
	static readonly EditorID = AGENT_EDITOR_ID;

	private hasUnsavedContent = false;

	draft = '';
	draftMentions: IAgentDisplayMention[] = [];
	composerZoomed = false;
	composerHeight: number | undefined;
	messages: IAgentMessage[] = [];
	promptQueue: IAgentQueuedPrompt[] = [];
	queueExpanded = false;
	contextUsed?: number;
	contextWindow?: number;
	/** Mode restored from history, applied by the editor on first show. */
	restoredMode: string | undefined;

	private readonly codec: AgentHistoryCodec;
	private historyHandle: IAgentSessionHandle | undefined;
	private loading: Promise<void> | undefined;
	private lastTitle: string | undefined;
	private lastPartialAt = 0;
	private lastDraftSignature: string | undefined;
	private recordChain: Promise<void> = Promise.resolve();
	private partialTimer: ReturnType<typeof setTimeout> | undefined;
	private draftTimer: ReturnType<typeof setTimeout> | undefined;

	static getNewEditorUri(): URI {
		return URI.from({ scheme: Schemas.voltAgent, path: `agent-${generateUuid()}` });
	}

	static uriForSession(sessionId: string): URI {
		return URI.from({ scheme: Schemas.voltAgent, path: sessionId });
	}

	constructor(
		readonly resource: URI,
		@IAgentHistoryService private readonly historyService: IAgentHistoryService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
	) {
		super();
		this.codec = new AgentHistoryCodec(historyService);
		this.lastTitle = historyService.get(this.sessionId)?.title || undefined;
		this._register(historyService.onDidChange(() => {
			const title = historyService.get(this.sessionId)?.title || undefined;
			if (title !== this.lastTitle) {
				this.lastTitle = title;
				this._onDidChangeLabel.fire();
			}
		}));
	}

	/** Matches the runtime session key so history and runtime share one id. */
	get sessionId(): string {
		return this.resource.path.replace(/\//g, '') || 'agent';
	}

	//#region History

	private get history(): IAgentSessionHandle {
		this.historyHandle ??= this.historyService.open(this.sessionId);
		return this.historyHandle;
	}

	/** Load transcript and draft from disk once. Safe to call repeatedly. */
	ensureLoaded(): Promise<void> {
		this.loading ??= this.doLoad();
		return this.loading;
	}

	private async doLoad(): Promise<void> {
		await this.historyService.whenReady;
		if (!this.historyService.has(this.sessionId)) {
			return;
		}
		const handle = this.history;
		const [transcript, draft] = await Promise.all([handle.load(), handle.loadDraft()]);
		if (this.isDisposed()) {
			return;
		}
		if (!this.messages.length && transcript.turns.length) {
			const messages: IAgentMessage[] = [];
			const modelTranscript: { role: 'user' | 'assistant'; content: string }[] = [];
			for (const turn of transcript.turns) {
				const user = await this.codec.thawUser(turn.user.message);
				if (!user) {
					continue;
				}
				user.id = turn.id;
				messages.push(user);
				modelTranscript.push({ role: 'user', content: turn.user.text });
				if (turn.assistant) {
					const assistant = await this.codec.thawAssistant(turn.assistant.message, true, turn.assistant.at);
					if (assistant) {
						assistant.id = turn.id;
						messages.push(assistant);
						if (turn.assistant.text) {
							modelTranscript.push({ role: 'assistant', content: turn.assistant.text });
						}
					}
				}
			}
			this.messages = messages;
			this.runtime.seedSession(this.sessionId, modelTranscript);
		}
		this.restoredMode = transcript.mode;
		if (draft && !this.draft.trim() && !this.promptQueue.length) {
			this.draft = draft.text;
			this.draftMentions = (await this.codec.thawMentions(draft.mentions)) ?? [];
			this.promptQueue = await this.thawQueue(draft.queue);
			this.hasUnsavedContent = !!this.draft.trim();
			this.lastDraftSignature = this.draftSignature();
		}
	}

	private async thawQueue(stored: unknown[] | undefined): Promise<IAgentQueuedPrompt[]> {
		if (!Array.isArray(stored)) {
			return [];
		}
		const queue: IAgentQueuedPrompt[] = [];
		for (const raw of stored) {
			if (!raw || typeof raw !== 'object' || typeof (raw as { text?: unknown }).text !== 'string') {
				continue;
			}
			const item = raw as { id?: string; text: string; display?: { text: string; mentions?: unknown } };
			queue.push({
				id: typeof item.id === 'string' ? item.id : `q-${generateUuid()}`,
				text: item.text,
				display: item.display ? { text: item.display.text, mentions: await this.codec.thawMentions(item.display.mentions) } : undefined,
			});
		}
		return queue;
	}

	recordUser(message: IAgentUserMessage): void {
		const turn = message.id ??= generateUuid();
		const handle = this.history;
		const frozen = this.codec.freezeUser(message);
		this.sequence(async () => handle.appendUser(turn, userMessageText(message), await frozen));
	}

	recordAssistant(message: IAgentAssistantMessage, final: boolean, status: AgentSessionStatus, plainText: string): void {
		const turn = message.id;
		if (!turn) {
			return;
		}
		if (this.partialTimer !== undefined) {
			clearTimeout(this.partialTimer);
			this.partialTimer = undefined;
		}
		if (!final) {
			const elapsed = Date.now() - this.lastPartialAt;
			if (elapsed < PARTIAL_SNAPSHOT_INTERVAL_MS) {
				this.partialTimer = setTimeout(() => {
					this.partialTimer = undefined;
					if (message.activity?.streaming) {
						this.recordAssistant(message, false, status, plainText);
					}
				}, PARTIAL_SNAPSHOT_INTERVAL_MS - elapsed);
				return;
			}
		}
		this.lastPartialAt = Date.now();
		const summary = assistantSummary(message, plainText);
		const handle = this.history;
		const frozen = this.codec.freezeAssistant(message);
		this.sequence(async () => handle.appendAssistant({ turn, final, status, text: plainText, summary, message: await frozen }));
	}

	/** Records are appended in call order even though freezing is asynchronous. */
	private sequence(work: () => Promise<void>): void {
		this.recordChain = this.recordChain.then(work, work).catch(() => undefined);
	}

	recordTruncate(message: IAgentMessage | undefined): void {
		const turn = message?.id;
		if (turn) {
			const handle = this.history;
			this.sequence(async () => handle.truncate(turn));
		}
	}

	recordMode(mode: string): void {
		if (this.restoredMode !== mode && (this.messages.length || this.historyService.has(this.sessionId))) {
			this.restoredMode = mode;
			const handle = this.history;
			this.sequence(async () => handle.setMeta({ mode }));
		}
	}

	private draftSignature(): string {
		if (!this.draft.trim() && !this.promptQueue.length) {
			return '';
		}
		return JSON.stringify([this.draft, this.draftMentions.map(m => [m.kind, m.label, m.value]), this.promptQueue.map(item => [item.id, item.text])]);
	}

	/** Debounced; persists the composer text, mentions and queued prompts. */
	scheduleDraftSave(): void {
		if (this.draftTimer !== undefined) {
			return;
		}
		this.draftTimer = setTimeout(() => {
			this.draftTimer = undefined;
			void this.saveDraft();
		}, 400);
	}

	private async saveDraft(force = false): Promise<void> {
		if (this.isDisposed() && !force) {
			return;
		}
		const text = this.draft;
		const hasContent = !!text.trim() || this.promptQueue.length > 0;
		const signature = this.draftSignature();
		if (signature === this.lastDraftSignature) {
			return;
		}
		this.lastDraftSignature = signature;
		if (!hasContent) {
			if (this.historyHandle || this.historyService.has(this.sessionId)) {
				this.history.saveDraft(undefined);
			}
			return;
		}
		const [mentions, queue] = await Promise.all([
			this.codec.freezeMentions(this.draftMentions),
			Promise.all(this.promptQueue.map(async item => ({
				id: item.id,
				text: item.text,
				display: item.display ? { text: item.display.text, mentions: await this.codec.freezeMentions(item.display.mentions) } : undefined,
			}))),
		]);
		if (!this.isDisposed() || force) {
			this.history.saveDraft({ text, mentions, queue });
		}
	}

	//#endregion

	setHasUnsavedContent(value: boolean): void {
		this.hasUnsavedContent = value;
	}

	hasDraftContent(): boolean {
		return this.hasUnsavedContent;
	}

	override async revert(_group: GroupIdentifier, _options?: IRevertOptions): Promise<void> {
		this.draft = '';
		this.draftMentions = [];
		this.setHasUnsavedContent(false);
		this.scheduleDraftSave();
	}

	override get typeId(): string {
		return AgentEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return AgentEditorInput.EditorID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton | EditorInputCapabilities.CanDropIntoEditor;
	}

	override getName(): string {
		return this.lastTitle || localize('voltAgentEditorName', "New Agent");
	}

	override getIcon(): ThemeIcon {
		return AgentEditorIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof AgentEditorInput && other.resource.toString() === this.resource.toString();
	}

	override dispose(): void {
		if (this.partialTimer !== undefined) {
			clearTimeout(this.partialTimer);
			this.partialTimer = undefined;
		}
		const handle = this.historyHandle;
		if (handle) {
			const pendingDraft = this.draftTimer !== undefined;
			if (pendingDraft) {
				clearTimeout(this.draftTimer);
				this.draftTimer = undefined;
			}
			// Let in-flight records land, persist the draft, then compact and release the log.
			void this.recordChain
				.then(() => pendingDraft ? this.saveDraft(true) : undefined)
				.finally(() => void handle.close());
		}
		super.dispose();
	}
}

export class AgentEditorInputSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof AgentEditorInput;
	}

	serialize(editorInput: EditorInput): string | undefined {
		if (!(editorInput instanceof AgentEditorInput)) {
			return undefined;
		}
		return editorInput.resource.toString();
	}

	deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		try {
			return instantiationService.createInstance(AgentEditorInput, URI.parse(serializedEditorInput));
		} catch {
			return undefined;
		}
	}
}
