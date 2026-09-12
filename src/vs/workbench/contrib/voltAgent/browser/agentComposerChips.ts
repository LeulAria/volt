/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Action } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { setAgentTooltip } from './agentTooltip.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ISCMRepository, ISCMService } from '../../scm/common/scm.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalCommandId } from '../../terminal/common/terminal.js';

const DOT_RING = [0, 1, 2, 5, 8, 7, 6, 3];
const DOT_TRAIL = 2;
const DOT_SPEED = 90;

export interface IAgentComposerChipStatus {
	label: string;
	working: boolean;
}

export interface IAgentComposerChipsOptions {
	onStatusClick?: () => void;
	dock?: boolean;
}

interface IGitShortStat {
	files: number;
	insertions: number;
	deletions: number;
}

function createThinkingDots(): { root: HTMLElement; cells: HTMLElement[] } {
	const root = $('span.volt-browser-dock-dots');
	root.setAttribute('aria-hidden', 'true');
	const cells: HTMLElement[] = [];
	for (let i = 0; i < 9; i++) {
		cells.push(append(root, $('span.volt-browser-dock-dot')));
	}
	return { root, cells };
}

export class AgentComposerChips extends Disposable {

	readonly element: HTMLElement;

	private readonly statusChip: HTMLButtonElement;
	private readonly chipDots: HTMLElement[];
	private readonly chipLabelEl: HTMLElement;
	private readonly changesChip: HTMLButtonElement;
	private readonly changesLabelEl: HTMLElement;
	private readonly changesAddEl: HTMLElement;
	private readonly changesDelEl: HTMLElement;
	private readonly terminalsChip: HTMLButtonElement;
	private readonly terminalsLabelEl: HTMLElement;
	private readonly commitChip: HTMLButtonElement;
	private readonly repoListeners = this._register(new DisposableStore());
	private readonly terminalListeners = this._register(new DisposableStore());
	private hostOpen = true;
	private status: IAgentComposerChipStatus = { label: '', working: false };
	private insertions = 0;
	private deletions = 0;
	private hasChanges = false;
	private runningTerminals = 0;
	private refreshHandle: number | undefined;
	private refreshGen = 0;
	private dotsTimer: number | undefined;
	private dotsStep = 0;

	constructor(
		private readonly options: IAgentComposerChipsOptions,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@ISCMService private readonly scmService: ISCMService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();
		this.element = $(options.dock ? '.volt-agent-composer-chips.volt-browser-dock-chips' : '.volt-agent-composer-chips');

		this.statusChip = append(this.element, $('button.volt-agent-composer-chip.status.volt-browser-dock-chip')) as HTMLButtonElement;
		this.statusChip.type = 'button';
		const dots = createThinkingDots();
		this.chipDots = dots.cells;
		append(this.statusChip, dots.root);
		this.chipLabelEl = append(this.statusChip, $('span.volt-agent-composer-chip-label.volt-browser-dock-chip-label'));

		this.changesChip = append(this.element, $('button.volt-agent-composer-chip.changes.volt-browser-dock-chip')) as HTMLButtonElement;
		this.changesChip.type = 'button';
		setAgentTooltip(this.changesChip, localize('voltAgent.viewChanges', "View changes"));
		this.changesLabelEl = append(this.changesChip, $('span.volt-agent-composer-chip-label'));
		this.changesLabelEl.textContent = localize('voltAgent.changes', "Changes");
		this.changesAddEl = append(this.changesChip, $('span.volt-agent-composer-chip-add'));
		this.changesDelEl = append(this.changesChip, $('span.volt-agent-composer-chip-del'));

		this.terminalsChip = append(this.element, $('button.volt-agent-composer-chip.terminals.volt-browser-dock-chip')) as HTMLButtonElement;
		this.terminalsChip.type = 'button';
		setAgentTooltip(this.terminalsChip, localize('voltAgent.viewTerminals', "View running terminals"));
		append(this.terminalsChip, $('span.volt-agent-composer-chip-dot'));
		this.terminalsLabelEl = append(this.terminalsChip, $('span.volt-agent-composer-chip-label'));

		this.commitChip = append(this.element, $('button.volt-agent-composer-chip.commit.volt-browser-dock-chip')) as HTMLButtonElement;
		this.commitChip.type = 'button';
		setAgentTooltip(this.commitChip, localize('voltAgent.commitAndPush', "Commit & Push"));
		append(this.commitChip, $('span.volt-agent-composer-chip-label')).textContent = localize('voltAgent.commitAndPush', "Commit & Push");
		append(this.commitChip, renderIcon(Codicon.chevronDown)).classList.add('volt-agent-composer-chip-chevron');

		this._register(addDisposableListener(this.statusChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.options.onStatusClick?.();
		}));
		this._register(addDisposableListener(this.changesChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.commandService.executeCommand('workbench.view.scm');
		}));
		this._register(addDisposableListener(this.terminalsChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			const running = this.terminalService.instances.find(instance => instance.hasChildProcesses);
			(running ?? this.terminalService.instances[0])?.focus(true);
			void this.commandService.executeCommand(TerminalCommandId.Focus);
		}));
		this._register(addDisposableListener(this.commitChip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showCommitMenu();
		}));

		this._register(this.scmService.onDidAddRepository(() => {
			this.bindRepositories();
			this.scheduleRefresh();
		}));
		this._register(this.scmService.onDidRemoveRepository(() => {
			this.bindRepositories();
			this.scheduleRefresh();
		}));
		this._register(this.terminalService.onDidChangeInstances(() => {
			this.bindTerminals();
			this.scheduleRefresh();
		}));
		this._register(this.terminalService.onAnyInstancePrimaryStatusChange(() => this.scheduleRefresh()));
		this.bindRepositories();
		this.bindTerminals();
		this.scheduleRefresh();
		this.render();
	}

	setHostOpen(open: boolean): void {
		if (this.hostOpen === open) {
			return;
		}
		this.hostOpen = open;
		this.render();
	}

	setStatus(status: IAgentComposerChipStatus): void {
		if (this.status.label === status.label && this.status.working === status.working) {
			return;
		}
		this.status = status;
		this.render();
	}

	hasVisibleChips(): boolean {
		return this.hostOpen && (this.hasStatus() || this.hasChanges || this.runningTerminals > 0);
	}

	private hasStatus(): boolean {
		return !!this.status.label;
	}

	private bindRepositories(): void {
		this.repoListeners.clear();
		for (const repository of this.scmService.repositories) {
			this.bindRepository(repository);
		}
	}

	private bindRepository(repository: ISCMRepository): void {
		this.repoListeners.add(repository.provider.onDidChangeResources(() => this.scheduleRefresh()));
		this.repoListeners.add(repository.provider.onDidChangeResourceGroups(() => this.scheduleRefresh()));
		for (const group of repository.provider.groups) {
			this.repoListeners.add(group.onDidChangeResources(() => this.scheduleRefresh()));
		}
	}

	private bindTerminals(): void {
		this.terminalListeners.clear();
		for (const instance of this.terminalService.instances) {
			this.terminalListeners.add(instance.onDidChangeHasChildProcesses(() => this.scheduleRefresh()));
		}
	}

	private scmHasChanges(): boolean {
		for (const repository of this.scmService.repositories) {
			for (const group of repository.provider.groups) {
				if (group.resources.length) {
					return true;
				}
			}
		}
		return false;
	}

	private scheduleRefresh(): void {
		const win = getWindow(this.element);
		if (this.refreshHandle !== undefined) {
			win.clearTimeout(this.refreshHandle);
		}
		this.refreshHandle = win.setTimeout(() => {
			this.refreshHandle = undefined;
			void this.refresh();
		}, 250);
	}

	private async refresh(): Promise<void> {
		const gen = ++this.refreshGen;
		const hasChanges = this.scmHasChanges();
		const runningTerminals = this.terminalService.instances.filter(instance => instance.hasChildProcesses).length;
		let insertions = 0;
		let deletions = 0;
		if (hasChanges) {
			try {
				const stat = await this.commandService.executeCommand<IGitShortStat>('git.api.getWorkingTreeShortStat');
				if (gen !== this.refreshGen) {
					return;
				}
				if (stat) {
					insertions = stat.insertions;
					deletions = stat.deletions;
				}
			} catch {
				insertions = this.insertions;
				deletions = this.deletions;
			}
		}
		if (gen !== this.refreshGen) {
			return;
		}
		this.hasChanges = hasChanges || insertions > 0 || deletions > 0;
		this.insertions = insertions;
		this.deletions = deletions;
		this.runningTerminals = runningTerminals;
		this.render();
	}

	private render(): void {
		const showStatus = this.hasStatus();
		const showChanges = this.hasChanges;
		const showTerminals = this.runningTerminals > 0;
		const showCommit = this.hasChanges;
		const visible = this.hostOpen && (showStatus || showChanges || showTerminals || showCommit);

		this.statusChip.classList.toggle('hidden', !showStatus);
		this.statusChip.classList.toggle('working', this.status.working);
		this.chipLabelEl.textContent = this.status.label;
		if (this.status.working) {
			this.startDots();
		} else {
			this.stopDots();
		}

		this.changesChip.classList.toggle('hidden', !showChanges);
		this.changesAddEl.textContent = this.insertions > 0 ? `+${this.insertions}` : '';
		this.changesDelEl.textContent = this.deletions > 0 ? `-${this.deletions}` : '';
		this.changesAddEl.classList.toggle('hidden', this.insertions <= 0);
		this.changesDelEl.classList.toggle('hidden', this.deletions <= 0);

		this.terminalsChip.classList.toggle('hidden', !showTerminals);
		this.terminalsLabelEl.textContent = this.runningTerminals === 1
			? localize('voltAgent.oneTerminal', "1 Terminal")
			: localize('voltAgent.manyTerminals', "{0} Terminals", this.runningTerminals);

		this.commitChip.classList.toggle('hidden', !showCommit);
		this.element.classList.toggle('is-visible', visible);
	}

	private showCommitMenu(): void {
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.commitChip,
			getActions: () => [
				new Action('volt.agent.commit', localize('voltAgent.commit', "Commit"), undefined, true, () => this.commandService.executeCommand('git.commitAll')),
				new Action('volt.agent.commitPush', localize('voltAgent.commitAndPush', "Commit & Push"), undefined, true, async () => {
					await this.commandService.executeCommand('git.commitAll');
					await this.commandService.executeCommand('git.push');
				}),
				new Action('volt.agent.push', localize('voltAgent.push', "Push"), undefined, true, () => this.commandService.executeCommand('git.push')),
			],
		});
	}

	private startDots(): void {
		if (this.dotsTimer !== undefined) {
			return;
		}
		this.paintDots();
		this.dotsTimer = getWindow(this.element).setInterval(() => {
			this.dotsStep++;
			this.paintDots();
		}, DOT_SPEED);
	}

	private stopDots(): void {
		if (this.dotsTimer === undefined) {
			return;
		}
		getWindow(this.element).clearInterval(this.dotsTimer);
		this.dotsTimer = undefined;
	}

	private paintDots(): void {
		for (const [index, cell] of this.chipDots.entries()) {
			let opacity = index === 4 ? 0.16 : 0.1;
			const ring = DOT_RING.indexOf(index);
			if (ring >= 0) {
				const distance = (ring - (this.dotsStep % DOT_RING.length) + DOT_RING.length) % DOT_RING.length;
				if (distance <= DOT_TRAIL) {
					opacity = 1 - distance / (DOT_TRAIL + 1);
				}
			}
			cell.style.opacity = String(opacity);
		}
	}

	override dispose(): void {
		const win = getWindow(this.element);
		if (this.refreshHandle !== undefined) {
			win.clearTimeout(this.refreshHandle);
			this.refreshHandle = undefined;
		}
		this.stopDots();
		super.dispose();
	}
}
