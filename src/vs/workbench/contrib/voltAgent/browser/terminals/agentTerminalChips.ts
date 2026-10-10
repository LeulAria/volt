/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentTerminals.css';
import { $, addDisposableListener, append, EventHelper } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { URI } from '../../../../../base/common/uri.js';
import { AgentTerminalStatus, isTerminalLive } from '../../../../services/voltRuntime/common/terminalTools.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { IAgentTerminalInfo, IAgentTerminalsService } from './agentTerminals.js';

export interface IAgentTerminalChipsHost {
	/** The chat on screen. */
	chatId(): string;
}

type ChipAction = 'open' | 'url' | 'copy-url' | 'copy-command' | 'restart' | 'stop' | 'dismiss';

interface IChipPick {
	readonly id: string;
	readonly action: ChipAction;
}

/** Which state the summary shows when several terminals run: the one that most needs a look. */
const STATUS_WEIGHT: Record<AgentTerminalStatus, number> = {
	failed: 6,
	attention: 5,
	starting: 4,
	stopping: 3,
	running: 2,
	ready: 1,
	completed: 0,
	stopped: 0,
};

/**
 * The chat's managed terminals as chips at the top of the chat: one chip per terminal, or one
 * "2 terminals running" chip for several. A spinner only while a terminal is genuinely starting;
 * a running server shows a steady dot. Clicking opens the terminal in the chat's tools on the
 * right; starting a terminal never opens them by itself.
 */
export class AgentTerminalChips extends Disposable {

	readonly element: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());

	constructor(
		private readonly host: IAgentTerminalChipsHost,
		@IAgentTerminalsService private readonly terminals: IAgentTerminalsService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.element = $('.volt-agent-terminal-bar.hidden');
		this.element.setAttribute('role', 'toolbar');
		this.element.setAttribute('aria-label', localize('voltAgent.terminals', "Terminals"));
		this._register(this.terminals.onDidChange(chatId => {
			if (chatId === this.host.chatId()) {
				this.render();
			}
		}));
		this.render();
	}

	render(): void {
		this.renderStore.clear();
		this.element.replaceChildren();
		const list = this.sorted(this.terminals.list(this.host.chatId()));
		this.element.classList.toggle('hidden', !list.length);
		if (!list.length) {
			return;
		}
		if (list.length === 1) {
			this.renderChip(list[0]);
		} else {
			this.renderSummary(list);
		}
	}

	/** Live first, newest first. */
	private sorted(list: readonly IAgentTerminalInfo[]): IAgentTerminalInfo[] {
		return [...list].sort((a, b) => Number(isTerminalLive(b.status)) - Number(isTerminalLive(a.status)) || b.startedAt - a.startedAt);
	}

	private renderChip(info: IAgentTerminalInfo): void {
		const chip = append(this.element, $(`.volt-agent-terminal-chip.${info.status}`));
		const main = append(chip, $('button.volt-agent-terminal-chip-main')) as HTMLButtonElement;
		main.type = 'button';
		main.appendChild(statusIndicator(info.status));
		append(main, $('span.label')).textContent = info.label;
		const detail = chipDetail(info);
		if (detail) {
			append(main, $('span.detail')).textContent = detail;
		}
		setAgentTooltip(main, tooltipFor(info));
		main.setAttribute('aria-label', `${info.label}, ${statusLabel(info)}`);
		this.renderStore.add(addDisposableListener(main, 'click', e => {
			EventHelper.stop(e, true);
			if (info.viewable) {
				this.terminals.reveal(info.id);
			} else {
				this.openMenu(chip, [info]);
			}
		}));
		this.appendMenuButton(chip, [info]);
		if (!isTerminalLive(info.status)) {
			const close = append(chip, $('button.volt-agent-terminal-chip-close')) as HTMLButtonElement;
			close.type = 'button';
			close.appendChild(renderIcon(Codicon.close));
			setAgentTooltip(close, localize('voltAgent.terminal.dismiss', "Dismiss"));
			this.renderStore.add(addDisposableListener(close, 'click', e => {
				EventHelper.stop(e, true);
				this.terminals.dismiss(info.id);
			}));
		}
	}

	private renderSummary(list: readonly IAgentTerminalInfo[]): void {
		const live = list.filter(info => isTerminalLive(info.status));
		const failed = list.filter(info => info.status === 'failed');
		const top = [...list].sort((a, b) => STATUS_WEIGHT[b.status] - STATUS_WEIGHT[a.status])[0];
		const chip = append(this.element, $(`.volt-agent-terminal-chip.summary.${top.status}`));
		const main = append(chip, $('button.volt-agent-terminal-chip-main')) as HTMLButtonElement;
		main.type = 'button';
		main.appendChild(statusIndicator(top.status));
		const label = live.length
			? failed.length
				? localize('voltAgent.terminal.summaryFailed', "{0} terminals running \u00b7 {1} failed", live.length, failed.length)
				: localize('voltAgent.terminal.summary', "{0} terminals running", live.length)
			: localize('voltAgent.terminal.summaryDone', "{0} terminals", list.length);
		append(main, $('span.label')).textContent = label;
		const dots = append(main, $('span.dots'));
		for (const info of list.slice(0, 5)) {
			append(dots, $(`span.dot.${info.status}`));
		}
		setAgentTooltip(main, list.map(info => `${info.label}: ${statusLabel(info)}${info.urls[0] ? ` \u00b7 ${info.urls[0]}` : ''}`).join('\n'));
		this.renderStore.add(addDisposableListener(main, 'click', e => {
			EventHelper.stop(e, true);
			this.revealAll(list);
		}));
		this.appendMenuButton(chip, list);
	}

	/** Opens every terminal as a tab in the chat's tools; the one that most needs a look ends in front. */
	private revealAll(list: readonly IAgentTerminalInfo[]): void {
		const viewable = list.filter(info => info.viewable);
		if (!viewable.length) {
			this.openMenu(this.element, list);
			return;
		}
		const front = [...viewable].sort((a, b) => STATUS_WEIGHT[b.status] - STATUS_WEIGHT[a.status] || b.lastActivity - a.lastActivity)[0];
		for (const info of viewable) {
			if (info !== front) {
				this.terminals.reveal(info.id, true);
			}
		}
		this.terminals.reveal(front.id);
	}

	private appendMenuButton(chip: HTMLElement, list: readonly IAgentTerminalInfo[]): void {
		const more = append(chip, $('button.volt-agent-terminal-chip-more')) as HTMLButtonElement;
		more.type = 'button';
		more.setAttribute('aria-haspopup', 'menu');
		more.appendChild(renderIcon(Codicon.chevronDown));
		setAgentTooltip(more, localize('voltAgent.terminal.more', "Terminal actions"));
		this.renderStore.add(addDisposableListener(more, 'click', e => {
			EventHelper.stop(e, true);
			this.openMenu(more, list);
		}));
	}

	private openMenu(anchor: HTMLElement, list: readonly IAgentTerminalInfo[]): void {
		const sections: IVoltMenuSection<IChipPick>[] = list.map(info => ({
			id: info.id,
			title: list.length > 1 ? info.label : undefined,
			items: menuItems(info, list.length > 1),
		}));
		showVoltMenu<IChipPick>(this.contextViewService, {
			anchor,
			position: 'below',
			align: 'left',
			width: 300,
			ariaLabel: localize('voltAgent.terminals', "Terminals"),
			className: 'volt-agent-terminal-menu',
			sections,
			onPick: item => this.act(item.data),
		});
	}

	private async act(pick: IChipPick): Promise<void> {
		const info = this.terminals.get(pick.id);
		if (!info) {
			return;
		}
		switch (pick.action) {
			case 'open':
				this.terminals.reveal(info.id);
				return;
			case 'url':
				if (info.urls[0]) {
					await this.openerService.open(URI.parse(info.urls[0]));
				}
				return;
			case 'copy-url':
				if (info.urls[0]) {
					await this.clipboardService.writeText(info.urls[0]);
				}
				return;
			case 'copy-command':
				await this.clipboardService.writeText(info.command);
				return;
			case 'restart':
				await this.terminals.restart(info.id);
				return;
			case 'stop':
				await this.terminals.stop(info.id);
				return;
			case 'dismiss':
				this.terminals.dismiss(info.id);
				return;
		}
	}
}

function menuItems(info: IAgentTerminalInfo, grouped: boolean): IVoltMenuItem<IChipPick>[] {
	const items: IVoltMenuItem<IChipPick>[] = [];
	const live = isTerminalLive(info.status);
	if (info.viewable) {
		items.push({
			id: `${info.id}:open`,
			label: grouped ? localize('voltAgent.terminal.open', "Open Terminal") : localize('voltAgent.terminal.openNamed', "Open {0}", info.label),
			subtitle: `${statusLabel(info)} \u00b7 $ ${info.command}`,
			icon: Codicon.terminal,
			data: { id: info.id, action: 'open' },
		});
	} else if (!grouped) {
		items.push({ id: `${info.id}:state`, label: `${info.label} \u00b7 ${statusLabel(info)}`, subtitle: `$ ${info.command}`, icon: Codicon.terminal, disabled: true, data: { id: info.id, action: 'open' } });
	}
	if (info.urls[0]) {
		items.push({ id: `${info.id}:url`, label: localize('voltAgent.terminal.openUrl', "Open {0}", info.urls[0]), icon: Codicon.globe, data: { id: info.id, action: 'url' } });
		items.push({ id: `${info.id}:copy-url`, label: localize('voltAgent.terminal.copyUrl', "Copy URL"), icon: Codicon.link, data: { id: info.id, action: 'copy-url' } });
	}
	if (info.kind === 'terminal') {
		// An agent's own background task is the agent's to rerun.
		items.push({ id: `${info.id}:copy`, label: localize('voltAgent.terminal.copyCommand', "Copy Command"), icon: Codicon.copy, data: { id: info.id, action: 'copy-command' } });
		items.push({ id: `${info.id}:restart`, label: localize('voltAgent.terminal.restart', "Restart"), icon: Codicon.debugRestart, data: { id: info.id, action: 'restart' } });
	}
	if (live) {
		items.push({ id: `${info.id}:stop`, label: localize('voltAgent.terminal.stop', "Stop"), icon: Codicon.debugStop, data: { id: info.id, action: 'stop' } });
	} else {
		items.push({ id: `${info.id}:dismiss`, label: localize('voltAgent.terminal.dismiss', "Dismiss"), icon: Codicon.close, data: { id: info.id, action: 'dismiss' } });
	}
	return items;
}

function statusIndicator(status: AgentTerminalStatus): HTMLElement {
	const el = $(`span.volt-agent-terminal-status.${status}`);
	switch (status) {
		case 'starting':
		case 'stopping':
			el.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
			break;
		case 'failed':
			el.appendChild(renderIcon(Codicon.error));
			break;
		case 'completed':
			el.appendChild(renderIcon(Codicon.check));
			break;
		case 'stopped':
			el.appendChild(renderIcon(Codicon.debugStop));
			break;
		default:
			// Running, ready, needs input: a steady dot, so a server that runs for hours never looks stuck.
			append(el, $('span.dot'));
	}
	return el;
}

function statusLabel(info: IAgentTerminalInfo): string {
	switch (info.status) {
		case 'starting': return localize('voltAgent.terminal.starting', "Starting");
		case 'running': return localize('voltAgent.terminal.running', "Running");
		case 'ready': return localize('voltAgent.terminal.ready', "Ready");
		case 'attention': return localize('voltAgent.terminal.attention', "Needs input");
		case 'stopping': return localize('voltAgent.terminal.stopping', "Stopping");
		case 'completed': return localize('voltAgent.terminal.completed', "Finished");
		case 'failed': return info.exitCode !== undefined
			? localize('voltAgent.terminal.failedCode', "Failed (exit {0})", info.exitCode)
			: localize('voltAgent.terminal.failed', "Failed");
		case 'stopped': return localize('voltAgent.terminal.stopped', "Stopped");
	}
}

/** The muted text after a chip's label: where it serves, or why it failed. */
function chipDetail(info: IAgentTerminalInfo): string | undefined {
	if (info.status === 'failed') {
		return info.exitCode !== undefined ? localize('voltAgent.terminal.exitShort', "exit {0}", info.exitCode) : statusLabel(info);
	}
	const url = info.urls[0];
	if (url && isTerminalLive(info.status)) {
		return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
	}
	return info.status === 'attention' ? statusLabel(info) : undefined;
}

function tooltipFor(info: IAgentTerminalInfo): string {
	const lines = [`${info.label} \u00b7 ${statusLabel(info)}`, info.kind === 'terminal' ? `$ ${info.command}` : localize('voltAgent.terminal.agentTask', "Run by the agent in the background")];
	if (info.urls.length) {
		lines.push(info.urls.join('  '));
	}
	if (info.error && (info.status === 'failed' || info.status === 'attention')) {
		lines.push(info.error);
	}
	lines.push(info.viewable
		? localize('voltAgent.terminal.clickToOpen', "Click to open it beside the chat")
		: localize('voltAgent.terminal.closed', "Its terminal was closed"));
	return lines.join('\n');
}
