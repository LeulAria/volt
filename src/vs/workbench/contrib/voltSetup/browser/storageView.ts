/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltSetup.css';
import { $, addDisposableListener, append, EventHelper } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IVoltStorageService, IVoltProjectStorageRequest, IVoltStorageCleanResult, IVoltStorageContext, IVoltStorageItem, IVoltStorageReport, VoltStorageId, VoltStorageKeep } from '../../../../platform/voltStorage/common/voltStorage.js';
import { formatBytes } from '../../../../platform/voltStorage/common/voltStorageRules.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltProjectRecord, sessionBelongsToProject } from '../../../services/voltRuntime/common/sessionContext.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { AgentEditorInput } from '../../voltAgent/browser/editor/agentEditorInput.js';

interface IRowCopy {
	readonly label: string;
	readonly detail: string;
	/** What Clean does, for the confirmation. */
	readonly clean: string;
}

function rowCopy(id: VoltStorageId): IRowCopy {
	switch (id) {
		case 'logs': return {
			label: localize('voltStorage.logs', "Logs"),
			detail: localize('voltStorage.logsDetail', "Log folders of earlier sessions. This session's logs stay."),
			clean: localize('voltStorage.logsClean', "Log folders of earlier sessions are deleted."),
		};
		case 'crashDumps': return {
			label: localize('voltStorage.crashDumps', "Crash reports"),
			detail: localize('voltStorage.crashDumpsDetail', "Crash dumps written when Volt or one of its processes crashed."),
			clean: localize('voltStorage.crashDumpsClean', "Crash dumps are deleted."),
		};
		case 'cachedData': return {
			label: localize('voltStorage.cachedData', "Compiled code of older versions"),
			detail: localize('voltStorage.cachedDataDetail', "V8 code caches of earlier Volt builds. This build's cache stays."),
			clean: localize('voltStorage.cachedDataClean', "Code caches of earlier builds are deleted."),
		};
		case 'chromiumCache': return {
			label: localize('voltStorage.chromiumCache', "Web cache"),
			detail: localize('voltStorage.chromiumCacheDetail', "Downloaded images, fonts and pages (Cache). Cleared through Electron while Volt runs."),
			clean: localize('voltStorage.chromiumCacheClean', "The app's HTTP cache is cleared. Things download again as needed."),
		};
		case 'codeCache': return {
			label: localize('voltStorage.codeCache', "Script cache"),
			detail: localize('voltStorage.codeCacheDetail', "Compiled scripts of web views and extensions (Code Cache)."),
			clean: localize('voltStorage.codeCacheClean', "The script cache is cleared; scripts compile again on next use."),
		};
		case 'gpuCache': return {
			label: localize('voltStorage.gpuCache', "GPU shader caches"),
			detail: localize('voltStorage.gpuCacheDetail', "GPUCache and Dawn caches. The GPU process keeps them open while Volt runs, so they are not cleaned here."),
			clean: '',
		};
		case 'workspaceStorage': return {
			label: localize('voltStorage.workspaceStorage', "Workspace state"),
			detail: localize('voltStorage.workspaceStorageDetail', "Per-folder UI state and extension data. Clean removes entries of folders that no longer exist; clean a project's from its settings."),
			clean: localize('voltStorage.workspaceStorageClean', "State of folders that no longer exist is deleted."),
		};
		case 'chatHistory': return {
			label: localize('voltStorage.chatHistory', "Chat history"),
			detail: localize('voltStorage.chatHistoryDetail', "Every chat, its draft and attachments. Clean deletes archived chats only."),
			clean: localize('voltStorage.chatHistoryClean', "Archived chats and their drafts are deleted. This cannot be undone."),
		};
		case 'agentTraces': return {
			label: localize('voltStorage.agentTraces', "Run traces"),
			detail: localize('voltStorage.agentTracesDetail', "Each chat's event trace, kept for diagnostics. Chats keep working without them; running chats' traces stay."),
			clean: localize('voltStorage.agentTracesClean', "Run traces are deleted. Chats are not affected."),
		};
		case 'nativeTranscripts': return {
			label: localize('voltStorage.nativeTranscripts', "Model transcripts"),
			detail: localize('voltStorage.nativeTranscriptsDetail', "What Volt's own agent had seen in each chat, so it can continue after a restart. Only deleted chats' go."),
			clean: localize('voltStorage.nativeTranscriptsClean', "Transcripts of chats that no longer exist are deleted."),
		};
		case 'worktrees': return {
			label: localize('voltStorage.worktrees', "Agent worktrees"),
			detail: localize('voltStorage.worktreesDetail', "Checkouts in ~/.volt/worktrees. Clean removes clean ones of archived chats; ones with uncommitted changes, and ones no chat here knows, stay."),
			clean: localize('voltStorage.worktreesClean', "Clean worktrees of archived chats are removed with git worktree remove. Their branches stay."),
		};
		case 'checkpoints': return {
			label: localize('voltStorage.checkpoints', "Checkpoints of folders without git"),
			detail: localize('voltStorage.checkpointsDetail', "Per-message undo for folders that are not git repositories. Clean removes those of folders that no longer exist."),
			clean: localize('voltStorage.checkpointsClean', "Checkpoints of folders that no longer exist are deleted."),
		};
		case 'runGroups': return {
			label: localize('voltStorage.runGroups', "Run group snapshots"),
			detail: localize('voltStorage.runGroupsDetail', "Snapshots of multi-model runs. They go when their run group is archived."),
			clean: '',
		};
		case 'browserCache': return {
			label: localize('voltStorage.browserCache', "In-app browser cache"),
			detail: localize('voltStorage.browserCacheDetail', "Cached pages and scripts of the browser tab. Sign-ins stay."),
			clean: localize('voltStorage.browserCacheClean', "The browser tab's cache is cleared. You stay signed in to sites."),
		};
		case 'browserData': return {
			label: localize('voltStorage.browserData', "In-app browser site data"),
			detail: localize('voltStorage.browserDataDetail', "Cookies, local storage and service workers of sites opened in the browser tab."),
			clean: localize('voltStorage.browserDataClean', "Cookies and site data are deleted. You are signed out of every site in the browser tab."),
		};
		case 'project.worktrees': return {
			label: localize('voltStorage.projectWorktrees', "Agent worktrees"),
			detail: localize('voltStorage.projectWorktreesDetail', "This project's checkouts in ~/.volt/worktrees. Open chats' and ones with uncommitted changes stay."),
			clean: localize('voltStorage.projectWorktreesClean', "Clean worktrees of archived chats are removed with git worktree remove. Their branches stay."),
		};
		case 'project.chats': return {
			label: localize('voltStorage.projectChats', "Chat history"),
			detail: localize('voltStorage.projectChatsDetail', "This project's chats. Clean deletes its archived chats."),
			clean: localize('voltStorage.projectChatsClean', "This project's archived chats are deleted. This cannot be undone."),
		};
		case 'project.traces': return {
			label: localize('voltStorage.projectTraces', "Run traces"),
			detail: localize('voltStorage.projectTracesDetail', "Diagnostics traces of this project's chats."),
			clean: localize('voltStorage.projectTracesClean', "This project's run traces are deleted. Chats are not affected."),
		};
		case 'project.workspaceStorage': return {
			label: localize('voltStorage.projectWorkspaceStorage', "Workspace state"),
			detail: localize('voltStorage.projectWorkspaceStorageDetail', "UI state and extension data saved for this folder, unless a window has it open."),
			clean: localize('voltStorage.projectWorkspaceStorageClean', "Saved UI state and extension data of this folder are deleted."),
		};
		case 'project.checkpoints': return {
			label: localize('voltStorage.projectCheckpoints', "Checkpoints"),
			detail: localize('voltStorage.projectCheckpointsDetail', "Per-message undo for this folder (it is not a git repository)."),
			clean: localize('voltStorage.projectCheckpointsClean', "Per-message undo of this folder's chats is no longer possible."),
		};
	}
}

function keepText(keep: VoltStorageKeep, count: number): string {
	switch (keep) {
		case 'current': return localize('voltStorage.keep.current', "{0} in use by this session", count);
		case 'open': return localize('voltStorage.keep.open', "{0} open or running", count);
		case 'inUse': return localize('voltStorage.keep.inUse', "{0} used by an open chat", count);
		case 'dirty': return localize('voltStorage.keep.dirty', "{0} with uncommitted changes", count);
		case 'unknown': return localize('voltStorage.keep.unknown', "{0} that git could not read", count);
		case 'exists': return localize('voltStorage.keep.exists', "{0} still in use", count);
		case 'managed': return localize('voltStorage.keep.managed', "managed by run groups");
		case 'foreign': return localize('voltStorage.keep.foreign', "{0} no chat here knows (another Volt app or profile may use them)", count);
	}
}

/** Which rows the window cleans itself (chats go through the history service). */
function isChatRow(id: VoltStorageId): boolean {
	return id === 'chatHistory' || id === 'project.chats';
}

/**
 * Sizes of what Volt stores, machine-wide or for one project, with a Clean button per row.
 * Sizes are measured in the main process; nothing in use is ever removed.
 */
export class VoltStorageView extends Disposable {

	readonly element: HTMLElement;
	private report: IVoltStorageReport | undefined;
	private readonly results = new Map<VoltStorageId, string>();
	private readonly busy = new Set<VoltStorageId>();
	private readonly rowStore = this._register(new DisposableStore());
	private measuring = false;

	constructor(
		parent: HTMLElement,
		private readonly project: IVoltProjectRecord | undefined,
		@IVoltStorageService private readonly storage: IVoltStorageService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super();
		this.element = append(parent, $('.volt-storage'));
		this.render();
		void this.measure();
	}

	private context(): IVoltStorageContext {
		const sessions = this.history.list({ includeArchived: true });
		const open = new Set<string>();
		for (const group of this.editorGroupsService.groups) {
			for (const editor of group.editors) {
				if (editor instanceof AgentEditorInput) {
					open.add(editor.sessionId);
				}
			}
		}
		const running = sessions.filter(session => session.status === 'running').map(session => session.id);
		return {
			openWorkspaceIds: [this.workspaceContext.getWorkspace().id],
			worktrees: sessions.filter(session => session.worktreePath).map(session => ({ path: session.worktreePath!, sessionId: session.id, archived: !!session.archived })),
			sessionIds: [...new Set([...sessions.map(session => session.id), ...open])],
			runningSessionIds: [...new Set([...running, ...[...open].filter(id => this.history.get(id)?.status === 'running')])],
		};
	}

	private projectSessions(): IAgentSessionMeta[] {
		const project = this.project;
		return project ? this.history.list({ includeArchived: true }).filter(session => sessionBelongsToProject(session, project)) : [];
	}

	private request(): IVoltProjectStorageRequest | undefined {
		return this.project ? { ...this.context(), root: this.project.root.fsPath, projectSessionIds: this.projectSessions().map(session => session.id) } : undefined;
	}

	async measure(): Promise<void> {
		this.measuring = true;
		this.render();
		try {
			const request = this.request();
			this.report = request ? await this.storage.projectReport(request) : await this.storage.machineReport(this.context());
		} catch (err) {
			this.report = { items: [], measuredAt: Date.now(), durationMs: 0 };
			this.results.set('logs', err instanceof Error ? err.message : String(err));
		} finally {
			this.measuring = false;
			this.render();
		}
	}

	/** Archived chats a chat row's Clean would delete, with their bytes. */
	private archivedChats(item: IVoltStorageItem): { readonly ids: string[]; readonly bytes: number } {
		const scope = this.project ? new Set(this.projectSessions().map(session => session.id)) : undefined;
		const archived = this.history.list({ includeArchived: true }).filter(session => session.archived && session.status !== 'running' && (!scope || scope.has(session.id)));
		const ids = archived.map(session => session.id);
		const byId = new Map(item.entries.map(entry => [entry.sessionId, entry.bytes]));
		return { ids, bytes: ids.reduce((sum, id) => sum + (byId.get(id) ?? 0), 0) };
	}

	private render(): void {
		this.rowStore.clear();
		this.element.replaceChildren();
		const head = append(this.element, $('.volt-storage-head'));
		const total = this.report?.items.reduce((sum, item) => sum + item.bytes, 0) ?? 0;
		append(head, $('span.volt-storage-total')).textContent = this.report
			? localize('voltStorage.total', "{0} in total", formatBytes(total))
			: localize('voltStorage.measuring', "Measuring...");
		if (this.report?.measuredAt) {
			append(head, $('span.volt-storage-when')).textContent = localize('voltStorage.measuredAt', "Measured {0}", fromNow(this.report.measuredAt, true));
		}
		const refresh = append(head, $('button.volt-setup-link')) as HTMLButtonElement;
		refresh.type = 'button';
		refresh.disabled = this.measuring;
		refresh.appendChild(renderIcon(this.measuring ? Codicon.loading : Codicon.refresh));
		append(refresh, $('span')).textContent = localize('voltStorage.measureAgain', "Measure again");
		this.rowStore.add(addDisposableListener(refresh, 'click', () => void this.measure()));
		if (!this.report) {
			return;
		}
		const list = append(this.element, $('.volt-storage-list'));
		for (const item of this.report.items) {
			if (this.project && item.bytes === 0 && !item.entries.length) {
				continue;
			}
			this.renderRow(list, item);
		}
	}

	private renderRow(list: HTMLElement, item: IVoltStorageItem): void {
		const copy = rowCopy(item.id);
		const row = append(list, $('.volt-storage-row'));
		row.dataset.id = item.id;
		const text = append(row, $('.volt-storage-text'));
		append(text, $('.volt-storage-label')).textContent = copy.label;
		append(text, $('.volt-storage-detail')).textContent = copy.detail;
		const kept = new Map<VoltStorageKeep, number>();
		for (const entry of item.entries) {
			if (entry.keep && entry.keep !== 'exists') {
				kept.set(entry.keep, (kept.get(entry.keep) ?? 0) + 1);
			}
		}
		const notes = [...kept].filter(([keep]) => keep === 'dirty' || keep === 'unknown' || keep === 'inUse' || keep === 'open' || keep === 'foreign').map(([keep, count]) => keepText(keep, count));
		const result = this.results.get(item.id);
		if (notes.length || result) {
			const note = append(text, $('.volt-storage-note'));
			if (kept.has('dirty') || kept.has('unknown')) {
				note.classList.add('warn');
				note.appendChild(renderIcon(Codicon.warning));
			}
			append(note, $('span')).textContent = [result, notes.length ? localize('voltStorage.kept', "Kept: {0}", notes.join(', ')) : undefined].filter(Boolean).join(' · ');
		}
		if (item.roots.length) {
			setAgentTooltip(text, item.roots.join('\n'));
		}

		const size = append(row, $('.volt-storage-size'));
		append(size, $('span.bytes')).textContent = formatBytes(item.bytes);
		const chats = isChatRow(item.id) ? this.archivedChats(item) : undefined;
		const freeable = chats ? chats.bytes : item.cleanableBytes;
		const canClean = chats ? chats.ids.length > 0 : item.cleanable && item.cleanableBytes > 0;
		if ((chats || item.cleanable) && freeable > 0 && freeable !== item.bytes) {
			append(size, $('span.freeable')).textContent = localize('voltStorage.freeable', "{0} can go", formatBytes(freeable));
		}
		const button = append(row, $('button.volt-setup-action')) as HTMLButtonElement;
		button.type = 'button';
		const busy = this.busy.has(item.id);
		button.disabled = busy || !canClean;
		append(button, $('span')).textContent = busy ? localize('voltStorage.cleaning', "Cleaning...") : localize('voltStorage.clean', "Clean");
		if (!item.cleanable && !chats) {
			button.classList.add('hidden');
			if (item.keep === 'inUse') {
				append(size, $('span.freeable')).textContent = localize('voltStorage.inUse', "in use");
			}
		}
		this.rowStore.add(addDisposableListener(button, 'click', e => {
			EventHelper.stop(e, true);
			void this.clean(item, copy, chats);
		}));
	}

	private async clean(item: IVoltStorageItem, copy: IRowCopy, chats: { readonly ids: string[]; readonly bytes: number } | undefined): Promise<void> {
		const amount = chats ? chats.bytes : item.cleanableBytes;
		const { confirmed } = await this.dialogService.confirm({
			type: item.id === 'browserData' || chats || item.id === 'project.checkpoints' ? 'warning' : 'info',
			message: chats
				? localize('voltStorage.confirmChats', "Delete {0} archived chats ({1})?", chats.ids.length, formatBytes(amount))
				: localize('voltStorage.confirm', "Clean {0} ({1})?", copy.label, formatBytes(amount)),
			detail: copy.clean,
			primaryButton: localize({ key: 'voltStorage.cleanButton', comment: ['&& denotes a mnemonic'] }, "&&Clean"),
		});
		if (!confirmed) {
			return;
		}
		this.busy.add(item.id);
		this.render();
		try {
			const result = chats ? await this.deleteChats(chats.ids) : await this.storage.clean(item.id, this.context(), this.request());
			this.results.set(item.id, this.resultText(result));
		} catch (err) {
			this.results.set(item.id, err instanceof Error ? err.message : String(err));
		} finally {
			this.busy.delete(item.id);
		}
		await this.measure();
	}

	private async deleteChats(ids: readonly string[]): Promise<IVoltStorageCleanResult> {
		let removed = 0;
		const errors: string[] = [];
		const wanted = new Set(ids);
		for (const group of this.editorGroupsService.groups) {
			const open = group.editors.filter(editor => editor instanceof AgentEditorInput && wanted.has(editor.sessionId));
			if (open.length) {
				await group.closeEditors(open);
			}
		}
		for (const id of ids) {
			try {
				await this.history.delete(id);
				removed++;
			} catch (err) {
				errors.push(err instanceof Error ? err.message : String(err));
			}
		}
		return { freedBytes: 0, removed, skipped: [], errors };
	}

	private resultText(result: IVoltStorageCleanResult): string {
		const parts: string[] = [];
		if (result.freedBytes) {
			parts.push(localize('voltStorage.freed', "Freed {0}", formatBytes(result.freedBytes)));
		} else if (result.removed) {
			parts.push(localize('voltStorage.removed', "Removed {0}", result.removed));
		} else {
			parts.push(localize('voltStorage.nothing', "Nothing to clean"));
		}
		if (result.errors.length) {
			parts.push(localize('voltStorage.failed', "{0} failed: {1}", result.errors.length, result.errors[0]));
		}
		return parts.join(' · ');
	}
}
