/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { AcknowledgeDocCommentsToken, IAccessibilitySignalService, Sound } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { FocusMode } from '../../../../../platform/native/common/native.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentOrchestratorService, IOrchThread } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import {
	AGENT_NOTIFY_INPUT_SETTING,
	AGENT_NOTIFY_SOUND_SETTING,
	AGENT_NOTIFY_THREAD_SETTING,
	AgentNotifySound,
	agentNotifyMode,
	agentNotifySound,
	AgentThreadAttentionEvent,
	AgentUnreadThreads,
	IAgentAttentionContext,
	IAgentThreadSnapshot,
	shouldNotifyThread,
	threadAttentionEvents,
} from '../../common/agentThreadAttention.js';
import { AgentEditorInput, OPEN_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';

export const IAgentThreadAttentionService = createDecorator<IAgentThreadAttentionService>('agentThreadAttentionService');

/**
 * Which chats want the user: the ones that finished out of sight (the app badge counts them and
 * the sidebar rail marks them) and, opt in, an OS notification with a sound when a chat finishes
 * or waits for an approval or an answer. It follows the orchestrator, not the views.
 */
export interface IAgentThreadAttentionService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** Chats that finished in the background and were not looked at since. */
	readonly unreadCount: number;
	isUnread(sessionId: string): boolean;
	unreadIds(): readonly string[];
}

/** The sound each choice plays, from the accessibility signal sounds that ship with the app. */
function soundFor(choice: AgentNotifySound, event: AgentThreadAttentionEvent): Sound | undefined {
	if (choice === 'none' || choice === 'system') {
		return undefined;
	}
	if (event.kind === 'input') {
		return Sound.chatUserActionRequired;
	}
	switch (choice) {
		case 'chime': return Sound.taskCompleted;
		case 'ping': return Sound.responseReceived2;
		case 'bell': return Sound.terminalBell;
	}
}

function snapshotOf(thread: IOrchThread): IAgentThreadSnapshot {
	return {
		...(thread.active ? { activeTurnId: thread.active.id } : {}),
		inputs: thread.inputs.map(input => ({ id: input.id, kind: input.kind })),
		...(thread.last ? { last: { turnId: thread.last.turnId, outcome: thread.last.outcome, ...(thread.last.error ? { error: thread.last.error } : {}) } } : {}),
		queued: thread.queue.filter(item => !item.held).length,
	};
}

export class AgentThreadAttentionService extends Disposable implements IAgentThreadAttentionService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly unread = new AgentUnreadThreads();
	private readonly snapshots = new Map<string, IAgentThreadSnapshot>();
	/** Open OS notifications, by chat: a newer one for the same chat replaces it. */
	private readonly notifications = new Map<string, DisposableStore>();

	constructor(
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IEditorService private readonly editorService: IEditorService,
		@IHostService private readonly hostService: IHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAccessibilitySignalService private readonly signals: IAccessibilitySignalService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		void this.orchestrator.whenReady.then(() => {
			if (this._store.isDisposed) {
				return;
			}
			// What was running before this window looked is not news.
			for (const thread of Object.values(this.orchestrator.getState().threads)) {
				this.snapshots.set(thread.id, snapshotOf(thread));
			}
			this._register(this.orchestrator.onDidChange(change => this.onThreads(change.threads)));
		});
		this._register(this.hostService.onDidChangeFocus(() => this.markSeen()));
		this._register(this.editorService.onDidVisibleEditorsChange(() => this.markSeen()));
		this._register(this.editorService.onDidActiveEditorChange(() => this.markSeen()));
		this._register(this.history.onDidChange(() => this.syncWithHistory()));
		this._register(toDisposable(() => {
			for (const store of this.notifications.values()) {
				store.dispose();
			}
			this.notifications.clear();
		}));
	}

	get unreadCount(): number {
		return this.unread.count;
	}

	isUnread(sessionId: string): boolean {
		return this.unread.has(sessionId);
	}

	unreadIds(): readonly string[] {
		return this.unread.values();
	}

	private onThreads(ids: readonly string[]): void {
		for (const id of ids) {
			const thread = this.orchestrator.getThread(id);
			if (!thread) {
				this.snapshots.delete(id);
				continue;
			}
			const next = snapshotOf(thread);
			const events = threadAttentionEvents(this.snapshots.get(id), next);
			this.snapshots.set(id, next);
			// Subagent chats report to their parent; the parent's own turn is what the user waits for.
			if (thread.taskId || !events.length) {
				continue;
			}
			const context = this.context(id);
			for (const event of events) {
				if (event.kind === 'finished' && this.unread.finished(id, context)) {
					this._onDidChange.fire();
				}
				this.maybeNotify(id, event, context);
			}
		}
	}

	private context(sessionId: string): IAgentAttentionContext {
		return { windowFocused: this.hostService.hasFocus, threadVisible: this.visibleSessions().has(sessionId) };
	}

	private visibleSessions(): Set<string> {
		const ids = new Set<string>();
		for (const editor of this.editorService.visibleEditors) {
			if (editor instanceof AgentEditorInput) {
				ids.add(editor.sessionId);
			}
		}
		return ids;
	}

	private markSeen(): void {
		const visible = this.visibleSessions();
		if (this.hostService.hasFocus) {
			// Looking at the chat answers its notification too.
			for (const id of visible) {
				this.notifications.get(id)?.dispose();
			}
		}
		if (this.unread.seen(visible, this.hostService.hasFocus)) {
			this._onDidChange.fire();
		}
	}

	/** Deleted chats leave; so do chats read elsewhere (another window, Mark All as Read) while you are here. */
	private syncWithHistory(): void {
		let changed = false;
		for (const id of this.unread.values()) {
			const meta = this.history.get(id);
			if (!meta || meta.archived || (this.hostService.hasFocus && !meta.unread)) {
				changed = this.unread.clear(id) || changed;
			}
		}
		if (changed) {
			this._onDidChange.fire();
		}
	}

	private maybeNotify(sessionId: string, event: AgentThreadAttentionEvent, context: IAgentAttentionContext): void {
		const mode = agentNotifyMode(this.configurationService.getValue(AGENT_NOTIFY_THREAD_SETTING));
		if (!shouldNotifyThread(mode, context)) {
			return;
		}
		if (event.kind === 'input' && this.configurationService.getValue<boolean>(AGENT_NOTIFY_INPUT_SETTING) === false) {
			return;
		}
		const sound = agentNotifySound(this.configurationService.getValue(AGENT_NOTIFY_SOUND_SETTING));
		const meta = this.history.get(sessionId);
		const title = meta?.title || this.orchestrator.getThread(sessionId)?.title || localize('voltAgent.notify.untitled', "New Agent");
		const body = this.describe(event, meta?.summary, meta?.workspaceLabel);
		this.logService.info(`[volt] chat notification: ${sessionId} ${event.kind === 'finished' ? event.outcome : event.input} (${mode}, sound ${sound})`);
		this.show(sessionId, title, body, sound === 'system');
		const file = soundFor(sound, event);
		// Our own setting decides, not the accessibility signal's enablement (playSound's documented use).
		if (file) {
			void this.signals.playSound(file, true, AcknowledgeDocCommentsToken);
		}
	}

	private describe(event: AgentThreadAttentionEvent, summary: string | undefined, project: string | undefined): string {
		let status: string;
		if (event.kind === 'input') {
			status = event.input === 'approval'
				? localize('voltAgent.notify.approval', "Needs your approval")
				: localize('voltAgent.notify.question', "Has a question for you");
		} else if (event.outcome === 'failed') {
			status = event.error
				? localize('voltAgent.notify.failedWith', "Failed: {0}", event.error.slice(0, 120))
				: localize('voltAgent.notify.failed', "Failed");
		} else {
			status = summary
				? localize('voltAgent.notify.finishedWith', "Finished · {0}", summary.slice(0, 120))
				: localize('voltAgent.notify.finished', "Finished");
		}
		return project ? `${project} · ${status}` : status;
	}

	/** An OS notification; a click brings the window forward and opens the chat. */
	private show(sessionId: string, title: string, body: string, systemSound: boolean): void {
		const NotificationCtor = mainWindow.Notification;
		if (!NotificationCtor || NotificationCtor.permission === 'denied') {
			return;
		}
		const open = async () => {
			if (NotificationCtor.permission !== 'granted' && await NotificationCtor.requestPermission() !== 'granted') {
				return;
			}
			this.notifications.get(sessionId)?.dispose();
			const store = new DisposableStore();
			this.notifications.set(sessionId, store);
			store.add(toDisposable(() => {
				if (this.notifications.get(sessionId) === store) {
					this.notifications.delete(sessionId);
				}
			}));
			const notification = new NotificationCtor(title, { body, silent: !systemSound, tag: `volt-chat-${sessionId}` });
			store.add(toDisposable(() => notification.close()));
			store.add(addDisposableListener(notification, 'close', () => store.dispose()));
			store.add(addDisposableListener(notification, 'click', () => {
				void this.reveal(sessionId);
				store.dispose();
			}));
		};
		void open().catch(err => this.logService.warn('[volt] chat notification failed', err));
	}

	private async reveal(sessionId: string): Promise<void> {
		await this.hostService.focus(mainWindow, { mode: FocusMode.Force });
		await this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, sessionId);
	}
}
