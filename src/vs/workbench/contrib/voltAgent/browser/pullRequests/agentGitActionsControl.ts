/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentPullRequests.css';
import { $, addDisposableListener, append, EventHelper } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IntervalTimer } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { AgentGitAction, IAgentGitMenuItem } from '../../common/agentGitActions.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';
import { SHOW_AGENT_SCM_COMMAND_ID } from '../workspace/agentSurfaceHost.js';
import { IAgentGitActionsService, IAgentGitControlState } from './agentGitActionsService.js';

export interface IAgentGitActionsControlOptions {
	/** `dock`: a full-width row in the chat side toolbar. `chip`: a pill above the composer. */
	readonly look: 'dock' | 'chip';
	/** The chat and the folder its agent works in, read when the control refreshes or runs. */
	readonly target: () => { readonly sessionId?: string; readonly folder?: string };
	/** Called when the control appears or disappears (a clean branch with nothing to do hides the chip). */
	readonly onDidChangeVisibility?: (visible: boolean) => void;
}

/**
 * T3 Code's git actions control: the button runs the next useful step (Commit, Push & PR; Commit &
 * Push; Push; Create PR; Pull), the chevron opens Commit…, Push and Create PR one by one. While an
 * action runs, the button shows its current step.
 */
export class AgentGitActionsControl extends Disposable {

	readonly element: HTMLElement;
	private readonly main: HTMLButtonElement;
	private readonly icon: HTMLElement;
	private readonly label: HTMLElement;
	private readonly elapsed: HTMLElement;
	private readonly chevron: HTMLButtonElement;
	private readonly service: IAgentGitActionsService | undefined;
	private readonly ticker = this._register(new MutableDisposable<IntervalTimer>());
	private state: IAgentGitControlState | undefined;
	private folder: string | undefined;
	private gen = 0;
	private visible = false;

	constructor(
		parent: HTMLElement,
		private readonly options: IAgentGitActionsControlOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.service = instantiationService.invokeFunction(accessor => accessor.getIfExists(IAgentGitActionsService));
		const chip = options.look === 'chip';
		this.element = append(parent, $(chip ? '.volt-git-control.chip.volt-agent-composer-chip.volt-browser-dock-chip' : '.volt-git-control.dock'));
		this.main = append(this.element, $(chip ? 'button.volt-git-control-main' : 'button.volt-git-control-main.volt-agent-dock-row')) as HTMLButtonElement;
		this.main.type = 'button';
		this.icon = append(this.main, $('span.volt-git-control-icon'));
		this.label = append(this.main, $(chip ? 'span.volt-agent-composer-chip-label' : 'span.volt-agent-dock-row-label'));
		this.elapsed = append(this.main, $('span.volt-git-control-elapsed'));
		this.chevron = append(this.element, $('button.volt-git-control-chevron')) as HTMLButtonElement;
		this.chevron.type = 'button';
		this.chevron.appendChild(renderIcon(Codicon.chevronDown));
		const options_ = localize('voltGit.options', "Git Action Options");
		this.chevron.setAttribute('aria-label', options_);
		setAgentTooltip(this.chevron, options_);

		this._register(addDisposableListener(this.main, 'click', e => {
			EventHelper.stop(e, true);
			this.runQuick();
		}));
		this._register(addDisposableListener(this.chevron, 'click', e => {
			EventHelper.stop(e, true);
			this.showMenu();
		}));
		if (this.service) {
			this._register(this.service.onDidChange(folder => {
				if (folder === this.folder) {
					this.paint(this.service!.cachedState(folder));
				}
			}));
		}
		this.paint(undefined);
	}

	/** Reads the folder's status again (debounced by the service) and repaints. */
	async refresh(force = false): Promise<void> {
		const gen = ++this.gen;
		const { sessionId, folder } = this.options.target();
		this.folder = folder;
		if (!this.service || !folder) {
			this.paint(undefined);
			return;
		}
		const state = await this.service.state(folder, sessionId, force);
		if (gen === this.gen) {
			this.paint(state);
		}
	}

	private paint(state: IAgentGitControlState | undefined): void {
		this.state = state;
		const quick = state?.quick;
		const progress = state?.progress;
		// Nothing to show without a repository; the chip also steps aside when there is nothing to do.
		const visible = !!quick && !!state?.context.status && (this.options.look === 'dock' || !quick.disabled || !!progress);
		if (this.options.look === 'dock') {
			// The chip's owner animates it in and out (onDidChangeVisibility).
			this.element.classList.toggle('hidden', !visible);
		}
		if (visible !== this.visible) {
			this.visible = visible;
			this.options.onDidChangeVisibility?.(visible);
		}
		if (!quick) {
			return;
		}
		this.element.classList.toggle('busy', !!progress);
		this.icon.replaceChildren(renderIcon(progress ? ThemeIcon.modify(Codicon.loading, 'spin') : iconFor(quick.kind === 'pull' ? 'pull' : quick.action)));
		this.label.textContent = progress?.label ?? quick.label;
		this.main.classList.toggle('disabled', quick.disabled && !progress);
		this.main.setAttribute('aria-disabled', String(quick.disabled || !!progress));
		setAgentTooltip(this.main, progress ? progress.label : quick.hint ?? tooltipFor(quick.action, quick.kind));
		this.chevron.disabled = !!progress;
		this.element.classList.toggle('has-changes', !!state?.context.status?.files.length);
		if (progress) {
			this.updateElapsed();
			if (!this.ticker.value) {
				const timer = new IntervalTimer();
				timer.cancelAndSet(() => this.updateElapsed(), 1000);
				this.ticker.value = timer;
			}
		} else {
			this.ticker.clear();
			this.elapsed.textContent = '';
		}
	}

	private updateElapsed(): void {
		const startedAt = this.state?.progress?.startedAt;
		const seconds = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
		this.elapsed.textContent = seconds >= 2 ? (seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`) : '';
	}

	private runQuick(): void {
		const { sessionId, folder } = this.options.target();
		if (!this.service || !folder || this.state?.progress) {
			return;
		}
		void this.service.runQuick(folder, sessionId);
	}

	private showMenu(): void {
		const { sessionId, folder } = this.options.target();
		const service = this.service;
		if (!service || !folder) {
			return;
		}
		type Pick = { kind: 'git'; id: IAgentGitMenuItem['id'] } | { kind: 'scm' };
		const items: IVoltMenuItem<Pick>[] = (this.state?.menu ?? []).map(item => ({
			id: item.id,
			label: item.label,
			icon: iconFor(item.id === 'commit' ? 'commit' : item.id === 'push' ? 'push' : 'createPr'),
			disabled: item.disabled,
			...(item.hint ? { tooltip: item.hint } : {}),
			data: { kind: 'git', id: item.id },
		}));
		const status = this.state?.context.status;
		const description = status?.branch
			? status.upstream
				? localize('voltGit.menu.tracking', "{0} → {1}/{2}", status.branch, status.remote ?? 'origin', status.upstream)
				: status.branch
			: undefined;
		showVoltMenu<Pick>(this.contextViewService, {
			anchor: this.chevron,
			align: 'right',
			ariaLabel: localize('voltGit.options', "Git Action Options"),
			width: 260,
			sections: [
				{ id: 'git', ...(description ? { title: description } : {}), items },
				{ id: 'scm', items: [{ id: 'scm', label: localize('voltGit.openScm', "Open Source Control"), icon: Codicon.sourceControl, data: { kind: 'scm' } }] },
			],
			onPick: item => {
				const pick = item.data;
				if (pick.kind === 'scm') {
					void this.commandService.executeCommand(SHOW_AGENT_SCM_COMMAND_ID);
					return;
				}
				void service.runMenu(folder, sessionId, pick.id);
			},
		});
	}
}

function iconFor(action: AgentGitAction | 'pull' | undefined): ThemeIcon {
	switch (action) {
		case 'push': return Codicon.cloudUpload;
		case 'pull': return Codicon.cloudDownload;
		case 'createPr':
		case 'commitPushPr': return Codicon.gitPullRequestCreate;
		case 'commitPush': return Codicon.cloudUpload;
		default: return Codicon.gitCommit;
	}
}

function tooltipFor(action: AgentGitAction | undefined, kind: 'run' | 'pull' | 'hint'): string {
	if (kind === 'pull') {
		return localize('voltGit.tip.pull', "Pull the upstream's new commits");
	}
	switch (action) {
		case 'commit': return localize('voltGit.tip.commit', "Commit every change (the message is written for you)");
		case 'commitPush': return localize('voltGit.tip.commitPush', "Commit every change and push");
		case 'commitPushPr': return localize('voltGit.tip.commitPushPr', "Commit every change, push, and open a pull request linked to this chat");
		case 'push': return localize('voltGit.tip.push', "Push the branch's commits");
		case 'createPr': return localize('voltGit.tip.createPr', "Push if needed and open a pull request linked to this chat");
		default: return '';
	}
}
