/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentSchedules.css';
import { $, addDisposableListener, append, clearNode, Dimension, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { describeSchedule, IAgentSchedule, IAgentScheduleService } from '../../../../services/voltRuntime/common/schedules/agentSchedules.js';
import { IVoltSessionContextService, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createAgentScrollable } from '../editor/agentScrollable.js';
import { OPEN_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';
import { showVoltMenu } from '../ui/menu/voltMenu.js';
import { showAgentScheduleDialog } from './agentScheduleDialog.js';
import { formatScheduleWhen } from './agentScheduleFormat.js';

export const AGENT_SCHEDULES_EDITOR_ID = 'workbench.editor.voltAgentSchedules';
const AGENT_SCHEDULES_INPUT_ID = 'workbench.input.voltAgentSchedules';

export class AgentSchedulesEditorInput extends EditorInput {

	static readonly TypeID = AGENT_SCHEDULES_INPUT_ID;
	static readonly EditorID = AGENT_SCHEDULES_EDITOR_ID;

	readonly resource = URI.from({ scheme: 'volt-schedules', path: 'schedules' });
	/** A task to scroll to and highlight once the page shows it. */
	focusTask: string | undefined;

	override get typeId(): string {
		return AgentSchedulesEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return AgentSchedulesEditorInput.EditorID;
	}

	override getName(): string {
		return localize('voltSchedules.tab', "Scheduled Tasks");
	}

	override getIcon(): ThemeIcon {
		return Codicon.history;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof AgentSchedulesEditorInput;
	}
}

export class AgentSchedulesEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(AgentSchedulesEditorInput);
	}
}

/**
 * Scheduled Tasks: every task with its schedule, where it runs, when it runs next and how the
 * last run went. A switch pauses it; Run now, Edit and Delete sit on the row. Like T3's settings
 * page for scheduled tasks, in the look of Volt's Usage page.
 */
export class AgentSchedulesEditor extends EditorPane {

	static readonly ID = AGENT_SCHEDULES_EDITOR_ID;

	private container!: HTMLElement;
	private content!: HTMLElement;
	private scroll!: DomScrollableElement;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly dialog = this._register(new MutableDisposable());
	private readonly clock = this._register(new MutableDisposable());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentScheduleService private readonly schedules: IAgentScheduleService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super(AgentSchedulesEditor.ID, group, telemetryService, themeService, storageService);
		this._register(this.schedules.onDidChange(() => this.render()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.volt-schedules'));
		const body = $('.volt-schedules-body');
		this.content = append(body, $('.volt-schedules-content'));
		this.scroll = this._register(createAgentScrollable(body));
		append(this.container, this.scroll.getDomNode());
		this.render();
	}

	override async setInput(input: AgentSchedulesEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		await this.schedules.whenReady;
		if (!token.isCancellationRequested) {
			this.render();
			this.revealFocused();
		}
		// "Next run in 4 min" keeps counting down while the page is open.
		const win = getWindow(this.container);
		const timer = win.setInterval(() => this.render(), 30_000);
		this.clock.value = { dispose: () => win.clearInterval(timer) };
	}

	override clearInput(): void {
		this.clock.clear();
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		this.container.style.height = `${dimension.height}px`;
		this.container.style.width = `${dimension.width}px`;
		this.scroll.scanDomNode();
	}

	override focus(): void {
		super.focus();
		this.container.focus();
	}

	private revealFocused(): void {
		const input = this.input instanceof AgentSchedulesEditorInput ? this.input : undefined;
		const id = input?.focusTask;
		if (!id) {
			return;
		}
		input.focusTask = undefined;
		const row = this.content.querySelector<HTMLElement>(`[data-task="${CSS.escape(id)}"]`);
		if (row) {
			row.classList.add('flash');
			this.scroll.setScrollPosition({ scrollTop: Math.max(0, row.offsetTop - 80) });
		}
	}

	private render(): void {
		if (!this.content) {
			return;
		}
		this.renderStore.clear();
		clearNode(this.content);
		const now = Date.now();

		const head = append(this.content, $('.volt-schedules-head'));
		const titles = append(head, $('.volt-schedules-titles'));
		append(titles, $('h1.volt-schedules-title')).textContent = localize('voltSchedules.tab', "Scheduled Tasks");
		append(titles, $('p.volt-schedules-subtitle')).textContent = localize('voltSchedules.pageSubtitle', "Prompts Volt sends on a schedule, into a chat or a new chat each time. They run while Volt is open; a fixed-time run missed while it was closed is skipped.");
		const add = append(head, $('button.volt-schedules-new')) as HTMLButtonElement;
		add.type = 'button';
		add.appendChild(renderIcon(Codicon.add));
		append(add, $('span')).textContent = localize('voltSchedules.newButton', "New Task");
		this.renderStore.add(addDisposableListener(add, 'click', () => this.openDialog(undefined)));

		const tasks = [...this.schedules.list()].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.createdAt - b.createdAt);
		if (!tasks.length) {
			const empty = append(this.content, $('.volt-schedules-empty'));
			empty.appendChild(renderIcon(Codicon.history));
			append(empty, $('.volt-schedules-empty-title')).textContent = localize('voltSchedules.emptyTitle', "No scheduled tasks yet");
			append(empty, $('.volt-schedules-empty-text')).textContent = localize('voltSchedules.emptyText', "Schedule a prompt from a chat's + menu, with New Task, or ask an agent to set one up.");
			this.scroll.scanDomNode();
			return;
		}
		const list = append(this.content, $('.volt-schedules-list'));
		for (const task of tasks) {
			this.renderRow(list, task, now);
		}
		this.scroll.scanDomNode();
	}

	private renderRow(list: HTMLElement, task: IAgentSchedule, now: number): void {
		const row = append(list, $('.volt-schedules-row'));
		row.dataset.task = task.id;
		row.classList.toggle('paused', !task.enabled);

		const main = append(row, $('.volt-schedules-main'));
		const top = append(main, $('.volt-schedules-line'));
		append(top, $('span.volt-schedules-name')).textContent = task.title;
		append(top, $('span.volt-schedules-cadence')).textContent = describeSchedule(task.schedule);

		const meta = append(main, $('.volt-schedules-line.meta'));
		const where = append(meta, $('span.volt-schedules-where'));
		if (task.target.kind === 'thread') {
			const threadId = task.target.threadId;
			const title = this.history.get(threadId)?.title || localize('voltSchedules.untitledChat', "Untitled chat");
			where.appendChild(renderIcon(Codicon.commentDiscussion));
			const link = append(where, $('a.volt-schedules-link'));
			link.textContent = title;
			link.tabIndex = 0;
			this.renderStore.add(addDisposableListener(link, 'click', () => void this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, threadId)));
		} else {
			where.appendChild(renderIcon(Codicon.add));
			append(where, $('span')).textContent = localize('voltSchedules.newChatIn', "New chat in {0}", this.projectLabel(task));
		}
		append(meta, $('span.volt-schedules-dot')).textContent = '·';
		const next = append(meta, $('span.volt-schedules-next'));
		next.textContent = !task.enabled
			? localize('voltSchedules.paused', "Paused")
			: task.nextRunAt !== undefined
				? localize('voltSchedules.nextRun', "Next {0}", formatScheduleWhen(task.nextRunAt, now))
				: localize('voltSchedules.noNext', "Not scheduled");
		const last = task.runs.at(-1);
		if (last) {
			append(meta, $('span.volt-schedules-dot')).textContent = '·';
			const lastEl = append(meta, $(`span.volt-schedules-last.status-${last.status}`));
			const when = formatScheduleWhen(last.at, now);
			lastEl.textContent = last.status === 'failed'
				? localize('voltSchedules.lastFailed', "Failed {0}", when)
				: last.status === 'skipped'
					? localize('voltSchedules.lastSkipped', "Skipped {0}", when)
					: localize('voltSchedules.lastRan', "Ran {0}", when);
			if (last.error) {
				setAgentTooltip(lastEl, last.error);
			}
			if (last.threadId) {
				lastEl.classList.add('clickable');
				const threadId = last.threadId;
				this.renderStore.add(addDisposableListener(lastEl, 'click', () => void this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, threadId)));
			}
		}
		const prompt = append(main, $('.volt-schedules-prompt'));
		prompt.textContent = task.prompt;

		const actions = append(row, $('.volt-schedules-actions'));
		const run = this.iconButton(actions, Codicon.play, localize('voltSchedules.runNow', "Run now"));
		this.renderStore.add(addDisposableListener(run, 'click', () => void this.schedules.runNow(task.id)));

		const toggle = append(actions, $('button.volt-schedules-switch')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.setAttribute('role', 'switch');
		toggle.setAttribute('aria-checked', String(task.enabled));
		toggle.classList.toggle('on', task.enabled);
		append(toggle, $('span.thumb'));
		setAgentTooltip(toggle, task.enabled ? localize('voltSchedules.pause', "Pause") : localize('voltSchedules.resume', "Resume"));
		this.renderStore.add(addDisposableListener(toggle, 'click', () => void this.schedules.setEnabled(task.id, !task.enabled)));

		const more = this.iconButton(actions, Codicon.ellipsis, localize('voltSchedules.more', "More actions"));
		this.renderStore.add(addDisposableListener(more, 'click', () => {
			showVoltMenu<'edit' | 'open' | 'delete'>(this.contextViewService, {
				anchor: more,
				align: 'right',
				gap: 4,
				width: 200,
				ariaLabel: localize('voltSchedules.more', "More actions"),
				sections: [
					{
						id: 'main', items: [
							{ id: 'edit', label: localize('voltSchedules.editItem', "Edit…"), data: 'edit' },
							...(task.target.kind === 'thread' ? [{ id: 'open', label: localize('voltSchedules.openChat', "Open Chat"), data: 'open' as const }] : []),
						],
					},
					{ id: 'danger', items: [{ id: 'delete', label: localize('voltSchedules.delete', "Delete"), data: 'delete' }] },
				],
				onPick: item => {
					if (item.data === 'edit') {
						this.openDialog(task);
					} else if (item.data === 'open' && task.target.kind === 'thread') {
						void this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, task.target.threadId);
					} else if (item.data === 'delete') {
						void this.schedules.delete(task.id);
					}
				},
			});
		}));
	}

	private iconButton(parent: HTMLElement, icon: ThemeIcon, label: string): HTMLButtonElement {
		const button = append(parent, $('button.volt-schedules-icon')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', label);
		button.appendChild(renderIcon(icon));
		setAgentTooltip(button, label);
		return button;
	}

	private projectLabel(task: IAgentSchedule): string {
		const root = task.target.kind === 'new' ? task.target.projectRoot : undefined;
		if (root) {
			const uri = uriFromStoredRoot(root);
			return this.sessionContext.projects.find(project => project.root.toString() === uri.toString())?.displayName ?? uri.path.split('/').pop() ?? root;
		}
		return this.sessionContext.activeProject?.displayName ?? localize('voltSchedules.currentProject', "the current project");
	}

	private openDialog(task: IAgentSchedule | undefined): void {
		const threadId = task?.target.kind === 'thread' ? task.target.threadId : undefined;
		this.dialog.value = showAgentScheduleDialog(getWindow(this.container).document.body, {
			...(task ? { task } : {}),
			...(threadId ? { threadId, threadTitle: this.history.get(threadId)?.title } : {}),
			projectLabel: task ? this.projectLabel(task) : this.sessionContext.activeProject?.displayName,
			...(!task && this.sessionContext.activeProject ? { projectRoot: this.sessionContext.activeProject.root.toString() } : {}),
			onSave: async input => {
				if (task) {
					await this.schedules.update(task.id, input);
				} else {
					await this.schedules.create(input);
				}
			},
		});
	}
}
