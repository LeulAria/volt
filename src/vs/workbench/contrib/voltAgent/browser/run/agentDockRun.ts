/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper, reset } from '../../../../../base/browser/dom.js';
import { renderIcon, renderLabelWithIcons } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { isMarkdownString } from '../../../../../base/common/htmlContent.js';
import { stripIcons } from '../../../../../base/common/iconLabels.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IExtensionStatusBarItemService } from '../../../../services/statusbar/browser/extensionStatusBarItems.js';
import { IStatusbarEntry, ShowTooltipCommand } from '../../../../services/statusbar/browser/statusbar.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { AgentRunToolbar } from './agentRunToolbar.js';
import { AGENT_RUN_STATUS_ITEMS_SETTING } from '../../common/agentRunSettings.js';
import { IAgentRunService, IAgentRunTarget, IAgentRunView } from './agentRunService.js';

const STATUS_ROW_HEIGHT = 26;
/** More than this many extension items scroll inside the group. */
const STATUS_ROWS_VISIBLE = 5;

interface IStatusItem {
	readonly id: string;
	readonly entry: IStatusbarEntry;
	readonly priority: number;
	/** The extension's display name. */
	readonly source: string;
}

/** A leading `$(icon)` takes the row's icon slot, lined up with the rows above. */
const LEADING_ICON_RE = /^\$\(([a-z0-9-]+(?:~[a-z]+)?)\)\s*/i;

/**
 * Run in the chat side toolbar, under the project's Explorer, Terminal and Browser: the Run row
 * (what VS Code's Run and Debug would start, its arrow opens the launcher), the device row for
 * runners that need one ("No Device" until picked, like Flutter's status bar item), the status
 * bar items extensions add (Live Server's Go Live, Dart's device), and the debug toolbar while
 * something runs.
 */
export class AgentDockRun extends Disposable {

	readonly element: HTMLElement;
	private readonly runRow: HTMLButtonElement;
	private readonly runIcon: HTMLElement;
	private readonly runLabel: HTMLElement;
	private readonly runState: HTMLElement;
	private readonly deviceRow: HTMLButtonElement;
	private readonly deviceIcon: HTMLElement;
	private readonly deviceLabel: HTMLElement;
	private readonly statusHost: HTMLElement;
	private readonly statusList: WorkbenchList<IStatusItem>;
	private readonly toolbar: AgentRunToolbar;
	private target: IAgentRunTarget | undefined;
	private view: IAgentRunView | undefined;
	private renderGen = 0;
	private readonly renderSoon = this._register(new RunOnceScheduler(() => void this.render(), 50));
	private readonly renderStatusSoon = this._register(new RunOnceScheduler(() => this.renderStatus(), 50));

	constructor(
		parent: HTMLElement,
		@IAgentRunService private readonly runService: IAgentRunService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExtensionStatusBarItemService private readonly statusItems: IExtensionStatusBarItemService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.element = append(parent, $('.volt-agent-dock-run'));

		this.runRow = append(this.element, $('button.volt-agent-dock-row.volt-agent-dock-run-row')) as HTMLButtonElement;
		this.runRow.type = 'button';
		this.runIcon = append(this.runRow, $('span.volt-agent-dock-run-icon'));
		this.runLabel = append(this.runRow, $('span.volt-agent-dock-row-label'));
		this.runState = append(this.runRow, $('span.volt-agent-dock-run-state'));
		// A span, not a button: a button cannot sit inside the row's button.
		const pick = append(this.runRow, $('span.volt-agent-dock-run-pick'));
		pick.setAttribute('role', 'button');
		pick.tabIndex = 0;
		pick.appendChild(renderIcon(Codicon.chevronDown));
		const pickLabel = localize('agentRun.pickTitle', "Select and Start Debugging");
		pick.setAttribute('aria-label', pickLabel);
		setAgentTooltip(pick, pickLabel);
		this._register(addDisposableListener(pick, 'click', e => {
			EventHelper.stop(e, true);
			this.pickRunner();
		}));
		this._register(addDisposableListener(pick, 'keydown', e => {
			if (e.key === 'Enter' || e.key === ' ') {
				EventHelper.stop(e, true);
				this.pickRunner();
			}
		}));
		this._register(addDisposableListener(this.runRow, 'click', () => this.onRunClick()));

		this.deviceRow = append(this.element, $('button.volt-agent-dock-row.volt-agent-dock-device-row')) as HTMLButtonElement;
		this.deviceRow.type = 'button';
		this.deviceIcon = append(this.deviceRow, $('span.volt-agent-dock-run-icon'));
		this.deviceLabel = append(this.deviceRow, $('span.volt-agent-dock-row-label'));
		this.deviceRow.style.display = 'none';
		this._register(addDisposableListener(this.deviceRow, 'click', () => {
			if (this.target) {
				void this.runService.pickDevice(this.target);
			}
		}));

		this.statusHost = append(this.element, $('.volt-agent-dock-status-list'));
		this.statusList = this._register(instantiationService.createInstance(WorkbenchList<IStatusItem>, 'voltAgentDockStatusItems', this.statusHost, new StatusItemDelegate(), [new StatusItemRenderer()], {
			identityProvider: { getId: (item: IStatusItem) => item.id },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('agentRun.statusItems', "Extension status items"),
				getAriaLabel: (item: IStatusItem) => item.entry.ariaLabel || stripIcons(item.entry.text).trim() || item.entry.name,
			},
		}));
		this._register(this.statusList.onDidOpen(e => {
			if (e.element) {
				this.runStatusCommand(e.element.entry);
			}
		}));

		this.toolbar = this._register(instantiationService.createInstance(AgentRunToolbar, this.element));
		this.toolbar.element.classList.add('inline');

		this._register(this.runService.onDidChange(() => this.renderSoon.schedule()));
		this._register(this.statusItems.onDidChange(() => this.renderStatusSoon.schedule()));
		this._register(this.extensionService.onDidChangeExtensions(() => this.renderStatusSoon.schedule()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_RUN_STATUS_ITEMS_SETTING)) {
				this.renderStatusSoon.schedule();
			}
		}));
		this.renderStatus();
	}

	/** The chat on screen: its project and checkout. */
	setSession(sessionId: string | undefined): void {
		const target = this.runService.targetFor(sessionId);
		if (target?.project.toString() === this.target?.project.toString() && target?.cwd.toString() === this.target?.cwd.toString() && target?.sessionId === this.target?.sessionId) {
			return;
		}
		this.target = target;
		this.toolbar.setProject(target?.project);
		void this.render();
	}

	/** The collapsed rail's Run button. */
	runFromRail(): void {
		this.onRunClick();
	}

	private pickRunner(): void {
		if (this.target) {
			void this.runService.pickRunner(this.target);
		}
	}

	private onRunClick(): void {
		const target = this.target;
		if (!target) {
			return;
		}
		const run = this.view?.run;
		if (run && !run.ended) {
			this.runService.showOutput(run);
			return;
		}
		if (this.runService.debugging) {
			void this.commandService.executeCommand('workbench.debug.action.toggleRepl');
			return;
		}
		void this.runService.start(target);
	}

	private async render(): Promise<void> {
		const target = this.target;
		const gen = ++this.renderGen;
		if (!target) {
			this.element.classList.add('hidden');
			return;
		}
		const view = await this.runService.view(target);
		if (gen !== this.renderGen) {
			return;
		}
		this.view = view;
		this.element.classList.remove('hidden');
		const running = !!view.run && !view.run.ended;
		const debugging = this.runService.debugging;
		const label = running ? view.run!.label : view.runner?.label ?? localize('agentRun.run', "Run");
		this.runLabel.textContent = label;
		reset(this.runIcon, renderIcon(running || debugging ? Codicon.debugAlt : Codicon.play));
		this.runRow.classList.toggle('running', running || debugging);
		this.runState.textContent = running
			? localize('agentRun.running', "Running")
			: debugging ? localize('agentRun.debugging', "Debugging") : '';
		const tooltip = running
			? localize('agentRun.showRunOutput', "{0} is running. Show its output", label)
			: debugging
				? localize('agentRun.showDebugConsole', "Show the Debug Console")
				: view.runner
					? localize('agentRun.startRunner', "Run {0}", view.runner.label)
					: localize('agentRun.chooseRunner', "Choose how to run this project");
		this.runRow.setAttribute('aria-label', tooltip);
		setAgentTooltip(this.runRow, tooltip);

		this.deviceRow.style.display = view.usesDevice ? '' : 'none';
		if (view.usesDevice) {
			const device = view.device;
			const icon: ThemeIcon = !device ? Codicon.deviceMobile : device.kind === 'browser' ? Codicon.globe : device.kind === 'desktop' ? Codicon.deviceDesktop : Codicon.deviceMobile;
			reset(this.deviceIcon, renderIcon(icon));
			this.deviceLabel.textContent = device?.label ?? localize('agentRun.noDevice', "No Device");
			this.deviceRow.classList.toggle('none', !device);
			const deviceTip = localize('agentRun.selectDevice', "Select a device to use");
			this.deviceRow.setAttribute('aria-label', device ? `${device.label}, ${deviceTip}` : deviceTip);
			setAgentTooltip(this.deviceRow, deviceTip);
		}
	}

	/** Extensions' own status bar items (not the built-in ones), most important first. */
	private renderStatus(): void {
		const items: IStatusItem[] = [];
		if (this.configurationService.getValue<boolean>(AGENT_RUN_STATUS_ITEMS_SETTING) !== false) {
			const extensions = new Map(this.extensionService.extensions.map(extension => [ExtensionIdentifier.toKey(extension.identifier), extension]));
			for (const [id, { entry, priority }] of this.statusItems.getEntries()) {
				const extension = entry.extensionId ? extensions.get(ExtensionIdentifier.toKey(entry.extensionId)) : undefined;
				if (!extension || extension.isBuiltin || !entry.text.trim()) {
					continue;
				}
				items.push({ id, entry, priority, source: extension.displayName || extension.name });
			}
			items.sort((a, b) => b.priority - a.priority);
		}
		const height = Math.min(items.length, STATUS_ROWS_VISIBLE) * STATUS_ROW_HEIGHT;
		this.statusHost.style.height = `${height}px`;
		this.statusHost.style.display = height ? '' : 'none';
		this.statusList.layout(height);
		this.statusList.splice(0, this.statusList.length, items);
	}

	private runStatusCommand(entry: IStatusbarEntry): void {
		const command = entry.command;
		if (!command || command === ShowTooltipCommand || typeof command !== 'string' && command.id === ShowTooltipCommand.id) {
			return;
		}
		const id = typeof command === 'string' ? command : command.id;
		const args = typeof command === 'string' ? [] : command.arguments ?? [];
		void this.commandService.executeCommand(id, ...args);
	}
}

class StatusItemDelegate implements IListVirtualDelegate<IStatusItem> {
	getHeight(): number {
		return STATUS_ROW_HEIGHT;
	}
	getTemplateId(): string {
		return StatusItemRenderer.TEMPLATE_ID;
	}
}

interface IStatusItemTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly source: HTMLElement;
}

class StatusItemRenderer implements IListRenderer<IStatusItem, IStatusItemTemplate> {
	static readonly TEMPLATE_ID = 'voltAgentDockStatusItem';
	readonly templateId = StatusItemRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IStatusItemTemplate {
		container.classList.add('volt-agent-dock-status-row');
		const icon = append(container, $('span.volt-agent-dock-status-icon'));
		const label = append(container, $('span.volt-agent-dock-status-label'));
		const source = append(container, $('span.volt-agent-dock-status-source'));
		return { row: container, icon, label, source };
	}

	renderElement(item: IStatusItem, _index: number, template: IStatusItemTemplate): void {
		const text = item.entry.text.trim();
		const leading = LEADING_ICON_RE.exec(text);
		reset(template.icon, renderIcon(leading ? ThemeIcon.fromId(leading[1]) : Codicon.extensions));
		const rest = leading ? text.slice(leading[0].length) : text;
		const iconOnly = !stripIcons(rest).trim();
		// An item that is only an icon reads as its extension's name; others say whose they are after the text.
		reset(template.label, ...renderLabelWithIcons(iconOnly ? `${rest} ${item.source}`.trim() : rest));
		template.source.textContent = iconOnly ? '' : item.source;
		template.row.classList.toggle('no-command', !item.entry.command);
		const tooltip = item.entry.tooltip;
		const tip = typeof tooltip === 'string' ? tooltip : isMarkdownString(tooltip) ? tooltip.value : undefined;
		setAgentTooltip(template.row, tip || item.entry.name);
	}

	disposeTemplate(): void { }
}
