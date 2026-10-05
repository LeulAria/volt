/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { getLayoutMode, onDidChangeLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { EditorExtensions, EditorsOrder, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { canonicalProjectRoot, IVoltSessionContextService, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { AGENT_SIDE_PANEL_VIEW_ID, AgentEditorInput } from '../editor/agentEditorInput.js';
import { SidebarEditorPart } from '../editor/sidebarEditorPart.js';
import { AgentChangesEditorInput } from '../review/agentChangesEditor.js';
import { AgentUsageEditorInput } from '../usage/agentUsageEditor.js';
import { TerminalEditorInput } from '../../../terminal/browser/terminalEditorInput.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../../scm/common/scm.js';
import { findAgentPanelGroup, MAX_BACKGROUND_AGENT_PANELS } from './agentPanels.js';
import { VoltBrowserEditorInput } from '../preview/browserEditorInput.js';
import { ensureAgentToolsPart, liveAgentToolsPart, onDidChangeAgentToolEditors, setBorrowedAgentBrowserResolver } from './agentSurfaceHost.js';
import { hasSavedAgentTools } from './agentToolsEditorPart.js';

/** Which chat each IDE tab came from, so it goes back to that chat's tools. */
const OWNERS_KEY = 'volt.agent.ideOwners';
/** Chats the agent layout had open that the IDE layout does not show, most recent first. */
const SET_ASIDE_KEY = 'volt.agent.ideSetAside';

/**
 * The chats the IDE layout shows together. A chat in its own worktree is shown alone (with any
 * chat sharing that worktree); chats on the project's checkout share its branch, so they are
 * shown together. `folder` is what the window opens: the worktree, else the project.
 */
export interface IAgentIdeScope {
	readonly key: string;
	readonly folder: URI;
	readonly members: ReadonlySet<string>;
	/** The chat in front in the agent side panel. */
	readonly front: string;
}

let currentScope: IAgentIdeScope | undefined;
const scopeEmitter = new Emitter<IAgentIdeScope | undefined>();
/** Fires when the IDE layout starts showing another set of chats, or stops showing any. */
export const onDidChangeAgentIdeScope = scopeEmitter.event;

/** The chats the IDE layout shows now. Undefined in agent layout. */
export function agentIdeScope(): IAgentIdeScope | undefined {
	return currentScope;
}

function setScope(scope: IAgentIdeScope | undefined): void {
	currentScope = scope;
	scopeEmitter.fire(scope);
}

/**
 * Agent layout and IDE layout are two views of the same chats:
 *
 * - Agent: the chat in the middle, its tools (files, browsers, terminals, changes) on the right.
 * - IDE: the chat's scope (see {@link IAgentIdeScope}) as the window's folder and its chats as tabs in
 *   the agent side panel on the right. The middle shows the tools of the chat in front only (files,
 *   browsers, its side chats go to the side panel); picking another chat there swaps them. Changes
 *   stay with the chat. Terminals are shared by the scope: every member's terminal tabs join the
 *   middle and only their panel terminals show (AgentTerminalScopeContribution).
 *
 * Switching moves the same editors between the two places, so nothing reloads and running agents,
 * terminals and pages carry on. A tab opened in the IDE goes to the chat in front when switching back.
 */
class AgentIdeWorkspaceContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentIdeWorkspace';

	/** Switches run one after another, each to the end: a later one must not replace an earlier one. */
	private readonly sequencer = new Sequencer();
	/** IDE tabs and side chats taken from a chat's tools, by the chat they belong to. */
	private readonly owners = new Map<EditorInput, string>();
	/** Owners read at startup, matched to the restored tabs when they are first needed. */
	private storedOwners: Map<string, string> | undefined;
	/**
	 * Open chats of other scopes, most recent first. The IDE layout closes them; they come back
	 * in the agent layout, and in the IDE layout when it moves to their scope.
	 */
	private setAside: string[];
	private switching = false;
	private readonly repositoryWatch = this._register(new MutableDisposable());

	constructor(
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IViewsService private readonly viewsService: IViewsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@ILogService private readonly logService: ILogService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		this.storedOwners = this.readStoredOwners();
		this.setAside = this.readSetAside();
		this._register(onDidChangeLayoutMode(mode => {
			if (mode === 'ide') {
				this.schedule(() => this.enterIde());
			} else {
				this.schedule(() => this.leaveIde());
			}
		}));
		this._register(this.editorService.onDidActiveEditorChange(() => this.followActiveChat()));
		// A tool a chat opens while the IDE layout shows it joins the tabs in the middle.
		this._register(onDidChangeAgentToolEditors(() => {
			if (!this.switching && this.isIde() && currentScope) {
				this.schedule(async () => {
					const side = this.existingSidePart();
					if (side && currentScope && this.isIde()) {
						this.pullTools(currentScope.members, side, currentScope.front);
					}
				});
			}
		}));
		this._register(setBorrowedAgentBrowserResolver(sessionId => this.borrowedBrowser(sessionId)));
		this._register(this.storageService.onWillSaveState(() => this.saveOwners()));
		void lifecycleService.when(LifecyclePhase.Restored).then(() => {
			if (this.isIde()) {
				this.schedule(() => this.enterIde());
			}
		});
	}

	private isIde(): boolean {
		return getLayoutMode(this.layoutService) === 'ide';
	}

	private schedule(task: () => Promise<void>): void {
		void this.sequencer.queue(async () => {
			this.switching = true;
			try {
				await task();
			} catch (error) {
				this.logService.error('[voltAgent] layout switch', error);
			} finally {
				this.switching = false;
			}
		});
	}

	//#region Scope

	/** Where a chat runs: its worktree, else its project. */
	private folderOf(sessionId: string): URI | undefined {
		const meta = this.history.get(sessionId);
		const worktree = meta?.worktreePath ?? this.runtime.getOrCreateSession(sessionId).worktreePath;
		if (worktree) {
			return URI.file(worktree);
		}
		const root = this.sessionContext.rootFor(sessionId);
		if (root) {
			return root;
		}
		return meta?.workspaceFolder ? uriFromStoredRoot(meta.workspaceFolder) : undefined;
	}

	private keyOf(sessionId: string): string | undefined {
		const folder = this.folderOf(sessionId);
		return folder ? canonicalProjectRoot(folder).toString() : undefined;
	}

	//#endregion

	//#region Agent → IDE

	/** The chat the agent layout was showing, which the IDE layout opens on. */
	private frontChat(side: IEditorPart | undefined): AgentEditorInput | undefined {
		const main = findAgentPanelGroup(this.editorGroupsService.mainPart).activeEditor;
		if (main instanceof AgentEditorInput) {
			return main;
		}
		const inSide = side?.activeGroup.activeEditor;
		return inSide instanceof AgentEditorInput ? inSide : undefined;
	}

	private async enterIde(front?: AgentEditorInput): Promise<void> {
		if (!this.isIde()) {
			return;
		}
		// Usage is a page of the agent layout, not a tab: drop it before anything can return early.
		for (const group of this.editorGroupsService.mainPart.groups) {
			const pages = group.editors.filter(editor => editor instanceof AgentUsageEditorInput);
			if (pages.length) {
				await group.closeEditors(pages, { preserveFocus: true });
			}
		}
		const side = await this.sidePart();
		front ??= this.frontChat(side);
		if (!front || !side) {
			return;
		}
		const key = this.keyOf(front.sessionId);
		const folder = this.folderOf(front.sessionId);
		if (folder) {
			await this.showFolder(folder);
		}
		if (!this.isIde()) {
			return;
		}

		const main = this.editorGroupsService.mainPart;
		const members = new Set<string>([front.sessionId]);
		for (const { editor } of [...this.chatsIn(main), ...this.chatsIn(side)]) {
			if (key && this.keyOf(editor.sessionId) === key) {
				members.add(editor.sessionId);
			}
		}
		const fromAside = key ? this.setAside.filter(id => !members.has(id) && this.keyOf(id) === key) : [];
		fromAside.forEach(id => members.add(id));

		// Tools first: a chat view must still exist to host a tools area that is not alive.
		this.adoptRestoredOwners();
		this.pullTools(members, side, front.sessionId);

		const sideGroup = side.activeGroup;
		const closed: string[] = [];
		for (const { editor, group } of this.chatsIn(main)) {
			if (members.has(editor.sessionId) && !this.sideHas(side, editor)) {
				group.moveEditor(editor, sideGroup, { inactive: editor !== front, preserveFocus: true, pinned: true });
			} else {
				closed.push(editor.sessionId);
				await group.closeEditor(editor, { preserveFocus: true });
			}
		}
		for (const { editor, group } of this.chatsIn(side)) {
			if (!members.has(editor.sessionId) && !this.owners.has(editor)) {
				closed.push(editor.sessionId);
				await group.closeEditor(editor, { preserveFocus: true });
			}
		}
		for (const id of fromAside) {
			if (!this.chatsIn(side).some(({ editor }) => editor.sessionId === id)) {
				await sideGroup.openEditor(this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.uriForSession(id)), { inactive: true, preserveFocus: true, pinned: true });
			}
		}
		this.rememberSetAside([...closed.filter(id => !members.has(id) && this.isKept(id)), ...this.setAside.filter(id => !members.has(id))]);
		const frontGroup = side.groups.find(group => group.editors.includes(front)) ?? sideGroup;
		await frontGroup.openEditor(front, { pinned: true });

		const project = this.sessionContext.bindingFor(front.sessionId)?.projectId;
		if (project) {
			this.sessionContext.selectProject(project);
		}
		setScope({ key: key ?? `chat:${front.sessionId}`, folder: folder ?? URI.file('/'), members, front: front.sessionId });
		if (folder) {
			this.showRepository(folder);
		}
	}

	/**
	 * Source control shows the scope's repository: a worktree's own branch, not the project's
	 * checkout git also has open. Git opens it a moment after the folder changes.
	 */
	private showRepository(folder: URI): void {
		const target = canonicalProjectRoot(folder).path;
		const matches = (repository: ISCMRepository) => {
			const root = repository.provider.rootUri?.path;
			// Git reports real paths: /tmp is /private/tmp on macOS.
			return !!root && (root === target || root === `/private${target}` || `/private${root}` === target);
		};
		const show = () => {
			const repository = [...this.scmService.repositories].find(matches);
			if (!repository || !currentScope || !isEqual(currentScope.folder, folder)) {
				return;
			}
			if (this.scmViewService.visibleRepositories.length !== 1 || this.scmViewService.visibleRepositories[0] !== repository) {
				this.scmViewService.visibleRepositories = [repository];
			}
			if (this.scmViewService.focusedRepository !== repository) {
				this.scmViewService.focus(repository);
			}
			this.scmViewService.pinActiveRepository(repository);
		};
		// Git opens repositories one by one after the folder changes, and source control brings back
		// the one it showed last as they come; the scope's repository wins while that settles.
		const watch = new DisposableStore();
		this.repositoryWatch.value = watch;
		watch.add(this.scmService.onDidAddRepository(() => show()));
		watch.add(this.scmViewService.onDidChangeVisibleRepositories(() => show()));
		const timer = setTimeout(() => this.repositoryWatch.clear(), 60_000);
		watch.add(toDisposable(() => clearTimeout(timer)));
		show();
	}

	/** The window's only folder becomes `folder`, in place: no reload, running agents carry on. */
	private async showFolder(folder: URI): Promise<void> {
		const workspace = this.workspaceContextService.getWorkspace();
		const target = canonicalProjectRoot(folder);
		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.FOLDER
			&& workspace.folders.length === 1 && isEqual(canonicalProjectRoot(workspace.folders[0].uri), target)) {
			return;
		}
		try {
			await this.workspaceEditingService.enterFolder?.(folder);
		} catch (error) {
			// The tabs and terminals are still scoped; only the Explorer keeps the old folder.
			this.logService.error('[voltAgent] could not open the folder', error);
		}
	}

	/**
	 * The chat in front shows its tools in the middle (its side chats go to the side panel). The other
	 * members only share their terminal tabs: terminals belong to the branch, files and pages to a chat.
	 */
	private pullTools(members: ReadonlySet<string>, side: IEditorPart, front?: string): void {
		const center = this.editorGroupsService.mainPart.activeGroup;
		// The chat in front goes last, so its tab in front is the one in front in the middle.
		const order = [...members].filter(id => id !== front);
		if (front && members.has(front)) {
			order.push(front);
		}
		let frontActive: EditorInput | undefined;
		let frontFirst: EditorInput | undefined;
		for (const sessionId of order) {
			const part = liveAgentToolsPart(sessionId)
				?? (hasSavedAgentTools(this.storageService, sessionId) ? ensureAgentToolsPart(sessionId) : undefined);
			if (!part) {
				continue;
			}
			const isFront = sessionId === front;
			for (const group of part.getGroups(GroupsOrder.GRID_APPEARANCE)) {
				for (const editor of [...group.getEditors(EditorsOrder.SEQUENTIAL)]) {
					if (editor instanceof AgentChangesEditorInput || (!isFront && !(editor instanceof TerminalEditorInput))) {
						continue;
					}
					if (editor instanceof AgentEditorInput) {
						if (!this.sideHas(side, editor)) {
							group.moveEditor(editor, side.activeGroup, { inactive: true, preserveFocus: true, pinned: true });
						}
						this.owners.set(editor, sessionId);
						continue;
					}
					// The same file in two chats' tools shows once; the other copy stays with its chat.
					if (center.editors.some(open => open === editor || open.matches(editor))) {
						continue;
					}
					if (isFront) {
						frontFirst ??= editor;
						if (group.activeEditor === editor) {
							frontActive = editor;
						}
					}
					group.moveEditor(editor, center, { inactive: true, preserveFocus: true, pinned: true });
					this.owners.set(editor, sessionId);
				}
			}
		}
		// The tab the chat in front had in front is in front here; the others' terminals only join.
		const show = frontActive ?? frontFirst;
		if (show) {
			void center.openEditor(show, { pinned: true, preserveFocus: true });
		}
	}

	//#endregion

	//#region IDE → agent

	/** Puts each tab back in its chat's tools and the chats back in the middle. */
	private async leaveIde(): Promise<void> {
		if (this.isIde()) {
			return;
		}
		const side = this.existingSidePart();
		const front = this.returnTools(side);
		if (side) {
			const target = findAgentPanelGroup(this.editorGroupsService.mainPart);
			for (const { editor, group } of this.chatsIn(side)) {
				group.moveEditor(editor, target, { inactive: editor !== front, preserveFocus: true, pinned: true });
			}
			const open = new Set(this.chatsIn(this.editorGroupsService.mainPart).map(({ editor }) => editor.sessionId));
			const room = Math.max(0, MAX_BACKGROUND_AGENT_PANELS + 1 - open.size);
			for (const id of this.setAside.filter(id => !open.has(id) && this.isKept(id)).slice(0, room)) {
				await target.openEditor(this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.uriForSession(id)), { inactive: true, preserveFocus: true, pinned: true });
			}
			this.rememberSetAside([]);
			if (front) {
				await target.openEditor(front, { pinned: true });
			}
		}
		this.owners.clear();
		this.storedOwners = undefined;
		this.repositoryWatch.clear();
		this.scmViewService.pinActiveRepository(undefined);
		setScope(undefined);
	}

	/** A chat worth reopening: one that still exists and is not archived. */
	private isKept(sessionId: string): boolean {
		const meta = this.history.get(sessionId);
		return !!meta && !meta.archived;
	}

	private rememberSetAside(ids: readonly string[]): void {
		this.setAside = [...new Set(ids)].slice(0, MAX_BACKGROUND_AGENT_PANELS * 2);
		this.storageService.store(SET_ASIDE_KEY, JSON.stringify(this.setAside), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private readSetAside(): string[] {
		try {
			const raw = JSON.parse(this.storageService.get(SET_ASIDE_KEY, StorageScope.WORKSPACE, '[]')) as unknown;
			return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
		} catch {
			return [];
		}
	}

	/**
	 * Moves the middle tabs and borrowed side chats back to the chats they came from. A tab opened
	 * in the IDE goes to the chat in front. Returns that chat.
	 */
	private returnTools(side: IEditorPart | undefined): AgentEditorInput | undefined {
		this.adoptRestoredOwners();
		const sideFront = side?.activeGroup.activeEditor;
		const front = sideFront instanceof AgentEditorInput && !this.owners.has(sideFront)
			? sideFront
			: side ? this.chatsIn(side).map(entry => entry.editor).find(editor => !this.owners.has(editor)) : undefined;
		const main = this.editorGroupsService.mainPart;
		for (const group of main.getGroups(GroupsOrder.GRID_APPEARANCE)) {
			for (const editor of [...group.getEditors(EditorsOrder.SEQUENTIAL)]) {
				if (editor instanceof AgentEditorInput) {
					continue;
				}
				const owner = this.owners.get(editor) ?? front?.sessionId;
				const part = owner ? ensureAgentToolsPart(owner) : undefined;
				if (part) {
					group.moveEditor(editor, part.activeGroup, { inactive: group.activeEditor !== editor, preserveFocus: true, pinned: true });
				}
			}
		}
		for (const { editor, group } of side ? this.chatsIn(side) : []) {
			const owner = this.owners.get(editor);
			const part = owner ? ensureAgentToolsPart(owner) : undefined;
			if (part) {
				group.moveEditor(editor, part.activeGroup, { inactive: true, preserveFocus: true, pinned: true });
			}
		}
		return front;
	}

	//#endregion

	/**
	 * Another chat of the same scope came to the front of the side panel: the middle swaps to its
	 * files and pages. Terminal tabs stay, they are shared. A tab opened meanwhile goes with the
	 * chat that was in front.
	 */
	private async showFront(next: string): Promise<void> {
		const scope = currentScope;
		const side = this.existingSidePart();
		if (!scope || !side || !this.isIde()) {
			return;
		}
		const previous = scope.front;
		for (const group of this.editorGroupsService.mainPart.getGroups(GroupsOrder.GRID_APPEARANCE)) {
			for (const editor of [...group.getEditors(EditorsOrder.SEQUENTIAL)]) {
				if (editor instanceof AgentEditorInput || editor instanceof TerminalEditorInput) {
					continue;
				}
				const owner = this.owners.get(editor) ?? previous;
				const part = owner !== next ? ensureAgentToolsPart(owner) : undefined;
				if (part) {
					group.moveEditor(editor, part.activeGroup, { inactive: group.activeEditor !== editor, preserveFocus: true, pinned: true });
					this.owners.delete(editor);
				}
			}
		}
		for (const { editor, group } of this.chatsIn(side)) {
			const owner = this.owners.get(editor);
			const part = owner && owner !== next ? ensureAgentToolsPart(owner) : undefined;
			if (part && group.activeEditor !== editor) {
				group.moveEditor(editor, part.activeGroup, { inactive: true, preserveFocus: true, pinned: true });
				this.owners.delete(editor);
			}
		}
		const members = new Set([...scope.members, next]);
		setScope({ ...scope, members, front: next });
		this.pullTools(members, side, next);
	}

	/** The browser tab a chat's agent drives while it sits in the middle of the IDE layout. */
	private borrowedBrowser(sessionId: string): { input: VoltBrowserEditorInput; group: IEditorGroup } | undefined {
		let fallback: { input: VoltBrowserEditorInput; group: IEditorGroup } | undefined;
		for (const [editor, owner] of this.owners) {
			if (owner !== sessionId || !(editor instanceof VoltBrowserEditorInput) || editor.isDisposed()) {
				continue;
			}
			const group = this.editorGroupsService.mainPart.groups.find(candidate => candidate.editors.includes(editor));
			if (group?.activeEditor === editor) {
				return { input: editor, group };
			}
			fallback ??= group ? { input: editor, group } : undefined;
		}
		return fallback;
	}

	//#region Following the chat in front

	/** Showing another scope's chat in the IDE layout makes the IDE show that scope. */
	private followActiveChat(): void {
		if (this.switching || !this.isIde()) {
			return;
		}
		const active = this.editorService.activeEditor;
		if (!(active instanceof AgentEditorInput) || this.owners.has(active)) {
			return;
		}
		const scope = currentScope;
		const key = this.keyOf(active.sessionId);
		if (scope && key && key === scope.key) {
			if (scope.front !== active.sessionId || !scope.members.has(active.sessionId)) {
				this.schedule(() => this.showFront(active.sessionId));
			}
			return;
		}
		if (!key) {
			return;
		}
		this.schedule(async () => {
			this.returnTools(this.existingSidePart());
			this.owners.clear();
			await this.enterIde(active);
		});
	}

	//#endregion

	//#region Parts

	private existingSidePart(): IEditorPart | undefined {
		return this.editorGroupsService.parts.find(part => part instanceof SidebarEditorPart);
	}

	/** The agent side panel's tabs, opening the panel when it has not been shown yet. */
	private async sidePart(): Promise<IEditorPart | undefined> {
		let part = this.existingSidePart();
		if (!part) {
			await this.viewsService.openView(AGENT_SIDE_PANEL_VIEW_ID, false);
			part = this.existingSidePart();
		}
		await part?.whenRestored;
		return part;
	}

	private chatsIn(part: IEditorPart): { editor: AgentEditorInput; group: IEditorGroup }[] {
		const chats: { editor: AgentEditorInput; group: IEditorGroup }[] = [];
		for (const group of part.getGroups(GroupsOrder.GRID_APPEARANCE)) {
			for (const editor of group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
				if (editor instanceof AgentEditorInput) {
					chats.push({ editor, group });
				}
			}
		}
		return chats;
	}

	private sideHas(side: IEditorPart, chat: AgentEditorInput): boolean {
		return side.groups.some(group => group.editors.some(editor => editor === chat
			|| (editor instanceof AgentEditorInput && editor.sessionId === chat.sessionId)));
	}

	//#endregion

	//#region Owners across restarts

	private ownerKey(editor: EditorInput): string | undefined {
		// A terminal tab is serialized by its live process, which a reload reattaches under the same id.
		if (editor instanceof TerminalEditorInput) {
			const instance = editor.terminalInstance;
			const id = instance?.shellLaunchConfig.attachPersistentProcess?.id ?? instance?.persistentProcessId;
			return id === undefined ? undefined : `terminal\n${id}`;
		}
		const serializer = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).getEditorSerializer(editor);
		const value = serializer?.canSerialize(editor) ? serializer.serialize(editor) : undefined;
		return value === undefined ? undefined : `${editor.typeId}\n${value}`;
	}

	private saveOwners(): void {
		if (!this.isIde() || this.switching) {
			return;
		}
		const stored: Record<string, string> = {};
		for (const [editor, owner] of this.owners) {
			const key = !editor.isDisposed() ? this.ownerKey(editor) : undefined;
			if (key) {
				stored[key] = owner;
			}
		}
		this.storageService.store(OWNERS_KEY, JSON.stringify(stored), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private readStoredOwners(): Map<string, string> | undefined {
		try {
			const raw = JSON.parse(this.storageService.get(OWNERS_KEY, StorageScope.WORKSPACE, '{}')) as Record<string, unknown> | null;
			const owners = new Map<string, string>();
			for (const [key, owner] of Object.entries(raw ?? {})) {
				if (typeof owner === 'string') {
					owners.set(key, owner);
				}
			}
			return owners.size ? owners : undefined;
		} catch {
			return undefined;
		}
	}

	/** After a restart in the IDE layout, the restored tabs get their owners back. */
	private adoptRestoredOwners(): void {
		const stored = this.storedOwners;
		if (!stored) {
			return;
		}
		const side = this.existingSidePart();
		for (const part of [this.editorGroupsService.mainPart, ...(side ? [side] : [])]) {
			for (const group of part.groups) {
				for (const editor of group.editors) {
					const key = this.owners.has(editor) ? undefined : this.ownerKey(editor);
					const owner = key ? stored.get(key) : undefined;
					if (key && owner) {
						this.owners.set(editor, owner);
						stored.delete(key);
					}
				}
			}
		}
		// A terminal tab gets its process id once it reattaches, so the rest is tried again later.
		if (!stored.size) {
			this.storedOwners = undefined;
		}
	}

	//#endregion
}

// Before the editors restore, so an early switch to the IDE layout is never missed.
registerWorkbenchContribution2(AgentIdeWorkspaceContribution.ID, AgentIdeWorkspaceContribution, WorkbenchPhase.BlockRestore);
