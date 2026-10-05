/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { getLayoutMode, onDidChangeLayoutMode, onWillChangeLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { agentIdeScope, onDidChangeAgentIdeScope } from './agentIdeWorkspace.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { ITerminalGroup, ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { IAgentPanelState, IAgentWorkspaceService } from './agentWorkspace.js';

/** Which chat owns each terminal, by persistent process id, so a reload puts them back. */
const OWNERS_KEY = 'volt.agent.terminalOwners';

/**
 * The bottom panel belongs to the chat on screen. Each panel terminal is owned by the chat
 * that was active when it opened; switching chats parks the other chats' terminals (they
 * keep running) and shows this chat's. In agent layout the panel also opens or closes as
 * that chat left it. IDE layout shows a set of chats (see IAgentIdeScope), so there it shows
 * the terminals of each of them.
 */
class AgentTerminalScopeContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentTerminalScope';

	private readonly owners = new Map<ITerminalInstance, string>();
	private readonly storedOwners: Map<number, string>;
	/** The group each chat was looking at when it left, shown again on return. */
	private readonly activeGroups = new Map<string, ITerminalGroup>();
	private scope: string | undefined;
	private readonly resizeHold = this._register(new MutableDisposable());

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly groupService: ITerminalGroupService,
		@IAgentWorkspaceService private readonly workspaceService: IAgentWorkspaceService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IStorageService private readonly storageService: IStorageService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
	) {
		super();
		this.storedOwners = this.readStoredOwners();
		this.scope = this.workspaceService.active?.sessionId;
		this._register(this.terminalService.onDidCreateInstance(instance => this.adopt(instance)));
		this._register(this.groupService.onDidChangeInstances(() => this.adoptAll()));
		this._register(this.terminalService.onDidDisposeInstance(instance => this.release(instance)));
		this._register(this.workspaceService.onDidChangeActive(workspace => this.switchTo(workspace?.sessionId)));
		this._register(this.workspaceService.onDidChange(e => {
			if (e.slot === undefined && !this.workspaceService.get(e.sessionId)) {
				this.disposeTerminalsOf(e.sessionId);
			}
		}));
		this._register(onDidChangeAgentIdeScope(() => this.apply()));
		this._register(onDidChangeLayoutMode(() => this.apply()));
		this._register(onWillChangeLayoutMode(() => this.holdResizes()));
		this.adoptAll();
	}

	/**
	 * A layout switch moves the panel several times before it settles. Every size reaches the
	 * shell, and a shell like zsh reprints its prompt on each one, which leaves blank prompt
	 * lines behind. Terminals keep their size until the switch is done, then take the final one.
	 */
	private holdResizes(): void {
		const instances = this.terminalService.instances.filter(instance => !instance.disableLayout);
		for (const instance of instances) {
			instance.disableLayout = true;
		}
		const hold = new DisposableStore();
		this.resizeHold.value = hold;
		const window = getWindow(this.layoutService.mainContainer);
		const release = () => {
			if (this.resizeHold.value !== hold) {
				return;
			}
			this.resizeHold.clear();
			for (const instance of instances) {
				if (!instance.isDisposed) {
					instance.disableLayout = false;
				}
			}
			this.layoutService.layout();
		};
		// The parts settle on the first frame after the switch, the agent list takes its width on the next.
		hold.add(onDidChangeLayoutMode(() => {
			hold.add(scheduleAtNextAnimationFrame(window, () => hold.add(scheduleAtNextAnimationFrame(window, release))));
		}));
		// A switch that fails part way must not leave terminals frozen.
		const timeout = setTimeout(release, 2000);
		hold.add(toDisposable(() => clearTimeout(timeout)));
	}

	/** Which chat a new terminal belongs to: in IDE layout, the chat in front of the side panel. */
	private ownerForNew(): string | undefined {
		if (getLayoutMode(this.layoutService) === 'ide') {
			return agentIdeScope()?.front ?? this.scope;
		}
		return this.scope;
	}

	/** Agent layout shows the chat on screen's terminals; IDE layout those of every chat it shows. */
	private shows(owner: string): boolean {
		if (getLayoutMode(this.layoutService) === 'ide') {
			const ide = agentIdeScope();
			return ide ? ide.members.has(owner) : owner === this.scope;
		}
		return owner === this.scope;
	}

	private readStoredOwners(): Map<number, string> {
		try {
			const raw = JSON.parse(this.storageService.get(OWNERS_KEY, StorageScope.WORKSPACE, '{}'));
			return new Map(Object.entries(raw ?? {})
				.filter((entry): entry is [string, string] => typeof entry[1] === 'string')
				.map(([pid, owner]) => [Number(pid), owner]));
		} catch {
			return new Map();
		}
	}

	private saveOwners(): void {
		for (const [instance, owner] of this.owners) {
			const pid = persistentId(instance);
			if (pid !== undefined) {
				this.storedOwners.set(pid, owner);
			}
		}
		this.storageService.store(OWNERS_KEY, JSON.stringify(Object.fromEntries(this.storedOwners)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private adoptAll(): void {
		let adopted = false;
		for (const group of [...this.groupService.groups, ...this.groupService.parkedGroups]) {
			for (const instance of group.terminalInstances) {
				adopted = this.claim(instance, group) || adopted;
			}
		}
		if (adopted) {
			this.apply();
		}
	}

	private adopt(instance: ITerminalInstance): void {
		const group = this.groupService.getGroupForInstance(instance);
		if (group && this.claim(instance, group)) {
			this.apply();
		}
	}

	/** Gives a panel terminal its owner: the one saved for its process, its split partner's, or the chat on screen. */
	private claim(instance: ITerminalInstance, group: ITerminalGroup): boolean {
		if (this.owners.has(instance)) {
			return false;
		}
		const pid = persistentId(instance);
		const owner = (pid !== undefined ? this.storedOwners.get(pid) : undefined)
			?? group.terminalInstances.map(other => this.owners.get(other)).find(Boolean)
			?? this.ownerForNew();
		if (!owner) {
			return false;
		}
		this.owners.set(instance, owner);
		if (pid === undefined) {
			void instance.processReady.then(() => this.saveOwners(), () => undefined);
		} else {
			this.saveOwners();
		}
		return true;
	}

	private release(instance: ITerminalInstance): void {
		this.owners.delete(instance);
		// A reload disposes every terminal on its way out; those come back and keep their owner.
		if (this.lifecycleService.willShutdown) {
			return;
		}
		const pid = persistentId(instance);
		if (pid !== undefined && this.storedOwners.delete(pid)) {
			this.saveOwners();
		}
	}

	private ownerOf(group: ITerminalGroup): string | undefined {
		return group.terminalInstances.map(instance => this.owners.get(instance)).find(Boolean);
	}

	private switchTo(sessionId: string | undefined): void {
		const previous = this.scope;
		if (previous === sessionId) {
			return;
		}
		const agentLayout = getLayoutMode(this.layoutService) === 'agent';
		if (previous) {
			const group = this.groupService.activeGroup;
			if (group && this.ownerOf(group) === previous) {
				this.activeGroups.set(previous, group);
			}
			if (agentLayout && this.workspaceService.get(previous)) {
				this.recordPanel(previous);
			}
		}
		this.scope = sessionId;
		// Terminals that opened before any chat was on screen go to this one.
		this.adoptAll();
		this.apply();
		if (agentLayout && sessionId) {
			this.restorePanel(this.workspaceService.get(sessionId)?.layout.panel);
		}
	}

	/** Shows the terminals of the chat on screen; the rest stay running out of sight. */
	private apply(): void {
		if (!this.scope) {
			return;
		}
		const parked = new Set<ITerminalGroup>();
		for (const group of [...this.groupService.groups, ...this.groupService.parkedGroups]) {
			const owner = this.ownerOf(group);
			if (owner && !this.shows(owner)) {
				parked.add(group);
			}
		}
		const remembered = this.activeGroups.get(this.scope);
		this.groupService.setParkedGroups(parked, remembered && !parked.has(remembered) ? remembered : undefined);
	}

	private recordPanel(sessionId: string): void {
		const visible = this.layoutService.isVisible(Parts.PANEL_PART);
		const container = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Panel)?.getId();
		const workspace = this.workspaceService.getOrCreate(sessionId);
		const current = workspace.layout.panel;
		if (current?.visible === visible && current.container === container) {
			return;
		}
		this.workspaceService.update(sessionId, 'layout', { ...workspace.layout, panel: { visible, container } });
	}

	/** A chat that never opened the panel starts with it closed. */
	private restorePanel(panel: IAgentPanelState | undefined): void {
		if (!panel?.visible) {
			if (this.layoutService.isVisible(Parts.PANEL_PART)) {
				this.layoutService.setPartHidden(true, Parts.PANEL_PART);
			}
			return;
		}
		if (!this.layoutService.isVisible(Parts.PANEL_PART)) {
			this.layoutService.setPartHidden(false, Parts.PANEL_PART);
		}
		if (panel.container && this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Panel)?.getId() !== panel.container) {
			void this.paneCompositeService.openPaneComposite(panel.container, ViewContainerLocation.Panel, false);
		}
	}

	/** A deleted chat takes its terminals with it. */
	private disposeTerminalsOf(sessionId: string): void {
		this.activeGroups.delete(sessionId);
		for (const [instance, owner] of [...this.owners]) {
			if (owner === sessionId) {
				instance.dispose();
			}
		}
	}
}

function persistentId(instance: ITerminalInstance): number | undefined {
	return instance.shellLaunchConfig.attachPersistentProcess?.id ?? instance.persistentProcessId;
}

registerWorkbenchContribution2(AgentTerminalScopeContribution.ID, AgentTerminalScopeContribution, WorkbenchPhase.AfterRestored);
