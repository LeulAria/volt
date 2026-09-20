/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { FindInput } from '../../../../../base/browser/ui/findinput/findInput.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ContextScopedFindInput } from '../../../../../platform/history/browser/contextScopedHistoryWidget.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { defaultInputBoxStyles, defaultToggleStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { ISCMViewService } from '../../../scm/common/scm.js';
import { AgentCustomizationScanner } from '../customize/agentCustomize.js';
import { AgentContextModelsList } from './agentContextModelsList.js';
import {
	buildContextUsageSnapshot,
	defaultOverhead,
	filterContextModels,
	formatContextPercent,
	formatContextTokens,
	groupContextModels,
	IContextOverhead,
	IContextUsageInput,
	IContextUsageSnapshot,
	overheadFromCustomizations,
} from './agentContextUsage.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';

const RING_RADIUS = 7.25;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export interface IAgentContextUsageHost {
	getUsageInput(): Omit<IContextUsageInput, 'overhead'>;
	getPanelAnchor(): { parent: HTMLElement; before: HTMLElement };
	onWillOpenPanel?(): void;
}

export class AgentContextUsageView extends Disposable {

	readonly element: HTMLElement;

	private readonly branchButton: HTMLButtonElement;
	private readonly branchLabel: HTMLElement;
	private readonly contextButton: HTMLButtonElement;
	private readonly ringFill: SVGCircleElement;
	private readonly percentLabel: HTMLElement;
	private readonly tokensLabel: HTMLElement;
	private readonly scanner: AgentCustomizationScanner;
	private readonly panelStore = this._register(new DisposableStore());

	private open = false;
	private overhead: IContextOverhead | undefined;
	private overheadGen = 0;
	private popup: IContextPopupRefs | undefined;
	private panelEl: HTMLElement | undefined;
	private scrollEl: HTMLElement | undefined;
	private modelsList: AgentContextModelsList | undefined;
	private modelsExpanded = false;
	private modelsQuery = '';
	private branchName: string | undefined;

	constructor(
		private readonly host: IAgentContextUsageHost,
		@ICommandService private readonly commandService: ICommandService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IFileService fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService,
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.scanner = new AgentCustomizationScanner(fileService);
		this.element = $('.volt-agent-composer-status');

		this.branchButton = append(this.element, $('button.volt-agent-status-branch')) as HTMLButtonElement;
		this.branchButton.type = 'button';
		this.branchButton.appendChild(renderIcon(Codicon.gitBranch));
		this.branchLabel = append(this.branchButton, $('span.label'));
		this.branchButton.appendChild(renderIcon(Codicon.chevronDown)).classList.add('chevron');

		this.contextButton = append(this.element, $('button.volt-agent-context-meter')) as HTMLButtonElement;
		this.contextButton.type = 'button';
		this.ringFill = this.createRing(this.contextButton);
		this.percentLabel = append(this.contextButton, $('span.percent'));
		this.tokensLabel = append(this.contextButton, $('span.tokens'));

		this._register(addDisposableListener(this.branchButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			void this.openBranchPicker();
		}));
		this._register(addDisposableListener(this.contextButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.togglePanel();
			this.contextButton.blur();
		}));
		this._register(autorun(reader => {
			const repository = this.scmViewService.activeRepository.read(reader);
			const ref = repository?.provider.historyProvider.read(reader)?.historyItemRef.read(reader);
			this.branchName = ref?.name?.replace(/^refs\/heads\//, '') || undefined;
			this.renderBranch();
		}));
		this._register(this.hostTools.onDidChangeMcp(() => void this.refreshOverhead()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => void this.refreshOverhead()));

		this.renderBranch();
		this.refresh();
		void this.refreshOverhead();
	}

	refresh(): void {
		const hasChat = this.host.getUsageInput().messages.length > 0;
		this.contextButton.hidden = !hasChat;
		this.contextButton.classList.toggle('empty', !hasChat);
		if (!hasChat) {
			this.hidePanel();
			return;
		}
		const snapshot = this.snapshot();
		const percent = formatContextPercent(snapshot.percent);
		const used = formatContextTokens(snapshot.used);
		const limit = formatContextTokens(snapshot.limit);
		const ratio = Math.min(1, snapshot.used / Math.max(snapshot.limit, 1));
		this.ringFill.setAttribute('stroke-dasharray', `${RING_CIRCUMFERENCE}`);
		this.ringFill.setAttribute('stroke-dashoffset', `${RING_CIRCUMFERENCE * (1 - ratio)}`);
		this.contextButton.classList.toggle('warn', snapshot.percent >= 80);
		this.contextButton.classList.toggle('critical', snapshot.percent >= 95);
		this.percentLabel.textContent = percent;
		this.tokensLabel.textContent = localize('voltAgent.contextUsedShort', "{0}/{1}", used, limit);
		this.contextButton.setAttribute('aria-label', localize('voltAgent.contextUsageDetail', "Context usage: {0} / {1}", used, limit));
		this.contextButton.setAttribute('aria-expanded', String(this.open));
		setAgentTooltip(this.contextButton, localize('voltAgent.contextUsageDetail', "Context usage: {0} / {1}", used, limit));
		if (this.open && this.popup) {
			this.fillPopup(this.popup, snapshot);
			this.syncPanelScroll();
		}
	}

	private snapshot(): IContextUsageSnapshot {
		const input = this.host.getUsageInput();
		return buildContextUsageSnapshot({
			...input,
			overhead: this.overhead ?? defaultOverhead(input.nativeAgent),
		});
	}

	private renderBranch(): void {
		const name = this.branchName;
		this.branchLabel.textContent = name || localize('voltAgent.noBranch', "No branch");
		this.branchButton.classList.toggle('empty', !name);
		setAgentTooltip(this.branchButton, name
			? localize('voltAgent.switchBranch', "Branch: {0}", name)
			: localize('voltAgent.noRepository', "No git repository"));
	}

	private async openBranchPicker(): Promise<void> {
		try {
			await this.commandService.executeCommand('git.checkout');
		} catch {
			await this.commandService.executeCommand('workbench.view.scm');
		}
	}

	private async refreshOverhead(): Promise<void> {
		const gen = ++this.overheadGen;
		const folders = this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
		let home;
		try {
			home = await this.pathService.userHome();
		} catch {
			home = undefined;
		}
		const items = await this.scanner.scan(folders, home);
		if (gen !== this.overheadGen) {
			return;
		}
		this.overhead = overheadFromCustomizations(items, this.hostTools.listTools(), this.host.getUsageInput().nativeAgent);
		this.refresh();
	}

	hidePanel(): void {
		if (!this.open) {
			return;
		}
		this.panelStore.clear();
		this.panelEl?.remove();
		this.panelEl = undefined;
		this.scrollEl = undefined;
		this.modelsList = undefined;
		this.popup = undefined;
		this.modelsExpanded = false;
		this.modelsQuery = '';
		this.open = false;
		this.contextButton.setAttribute('aria-expanded', 'false');
	}

	private togglePanel(): void {
		if (this.open) {
			this.hidePanel();
			return;
		}
		this.showPanel();
	}

	private showPanel(): void {
		if (this.open) {
			this.refresh();
			return;
		}
		this.host.onWillOpenPanel?.();
		this.panelStore.clear();
		this.panelEl?.remove();
		this.open = true;
		void this.refreshOverhead();

		const panel = $('.volt-agent-context-panel');
		this.panelEl = panel;
		const { parent, before } = this.host.getPanelAnchor();
		parent.insertBefore(panel, before);

		const scroll = append(panel, $('.volt-agent-context-scroll'));
		this.scrollEl = scroll;
		append(panel, $('.volt-agent-context-fade.top'));
		append(panel, $('.volt-agent-context-fade.bottom'));

		const lead = append(scroll, $('.volt-agent-context-lead'));
		const header = append(lead, $('.volt-agent-context-header'));
		const hero = append(header, $('.volt-agent-context-hero'));
		const donut = this.createDonut(hero);
		const copy = append(hero, $('.volt-agent-context-copy'));
		append(copy, $('span.title')).textContent = localize('voltAgent.contextUsageTitle', "Context Usage");
		const summary = append(copy, $('.volt-agent-context-summary'));
		const close = append(header, $('button.close')) as HTMLButtonElement;
		close.appendChild(renderIcon(Codicon.close));
		this.panelStore.add(addDisposableListener(close, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.hidePanel();
		}));

		const bar = append(lead, $('.volt-agent-context-bar'));
		const searchWrap = append(lead, $('.volt-agent-context-models-search'));
		const search = this.panelStore.add(this.instantiationService.createInstance(ContextScopedFindInput, searchWrap, this.contextViewService, {
			label: localize('voltAgent.contextSearchModelsAria', "Search models"),
			placeholder: localize('voltAgent.contextSearchModels', "Search models"),
			history: new Set<string>(),
			inputBoxStyles: defaultInputBoxStyles,
			toggleStyles: defaultToggleStyles,
		}));
		this.panelStore.add(search.onInput(() => {
			this.modelsQuery = search.getValue();
			if (this.popup) {
				this.fillPopup(this.popup, this.snapshot());
				this.syncPanelScroll();
			}
		}));
		this.panelStore.add(search.onKeyDown(event => {
			if (event.keyCode === KeyCode.Escape && this.modelsQuery) {
				event.preventDefault();
				event.stopPropagation();
				this.modelsQuery = '';
				search.setValue('');
				if (this.popup) {
					this.fillPopup(this.popup, this.snapshot());
				}
			} else if (event.keyCode === KeyCode.DownArrow && this.modelsExpanded) {
				event.preventDefault();
				this.modelsList?.focus();
			}
		}));
		const list = append(scroll, $('.volt-agent-context-list'));
		const session = append(scroll, $('.volt-agent-context-session'));
		const fit = append(scroll, $('.volt-agent-context-fit'));
		const chrome = append(fit, $('.volt-agent-context-fit-chrome'));
		const toggle = append(chrome, $('button.volt-agent-context-models-toggle')) as HTMLButtonElement;
		toggle.type = 'button';
		append(toggle, $('span.label'));
		toggle.appendChild(renderIcon(Codicon.chevronRight)).classList.add('chevron');
		this.panelStore.add(addDisposableListener(toggle, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.modelsExpanded = !this.modelsExpanded;
			if (!this.modelsExpanded) {
				this.modelsQuery = '';
			}
			toggle.blur();
			if (this.popup) {
				this.fillPopup(this.popup, this.snapshot());
				this.syncPanelScroll();
				if (this.modelsExpanded) {
					this.popup.search.focus();
				}
			}
		}));
		const models = append(fit, $('.volt-agent-context-models'));
		this.modelsList = this.panelStore.add(this.instantiationService.createInstance(AgentContextModelsList, models));
		const note = append(scroll, $('.volt-agent-context-note'));

		this.popup = {
			percent: append(summary, $('span.full')),
			tokens: append(summary, $('span.tokens')),
			model: append(copy, $('span.model')),
			donutFill: donut.fill,
			donutLabel: donut.label,
			bar,
			list,
			session,
			fit,
			toggle,
			search,
			note,
		};
		this.fillPopup(this.popup, this.snapshot());
		this.syncPanelScroll();

		this.panelStore.add(addDisposableListener(scroll, 'scroll', () => {
			this.modelsList?.layout();
			this.syncPanelScroll();
		}));
		this.panelStore.add(addDisposableListener(getWindow(panel), 'resize', () => {
			this.popup?.search.inputBox.layout();
			this.modelsList?.layout();
			this.syncPanelScroll();
		}));
		this.panelStore.add(addDisposableListener(getWindow(panel).document, 'mousedown', e => {
			if (!(e.target instanceof Node)) {
				return;
			}
			if (panel.contains(e.target) || this.contextButton.contains(e.target)) {
				return;
			}
			this.hidePanel();
		}, true));
		this.panelStore.add(addDisposableListener(getWindow(panel), 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.hidePanel();
			}
		}));
		this.panelStore.add(toDisposable(() => {
			panel.remove();
			if (this.panelEl === panel) {
				this.panelEl = undefined;
				this.scrollEl = undefined;
				this.modelsList = undefined;
				this.popup = undefined;
				this.modelsExpanded = false;
				this.modelsQuery = '';
				this.open = false;
				this.contextButton.setAttribute('aria-expanded', 'false');
			}
		}));
		this.contextButton.setAttribute('aria-expanded', 'true');
	}

	private syncPanelScroll(): void {
		const panel = this.panelEl;
		const scroll = this.scrollEl;
		if (!panel || !scroll) {
			return;
		}
		const canScroll = scroll.scrollHeight > scroll.clientHeight + 1;
		const atStart = scroll.scrollTop <= 2;
		const atEnd = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2;
		panel.classList.toggle('can-scroll', canScroll);
		panel.classList.toggle('at-start', atStart);
		panel.classList.toggle('at-end', atEnd);
	}

	private fillPopup(popup: IContextPopupRefs, snapshot: IContextUsageSnapshot): void {
		const percent = formatContextPercent(snapshot.percent);
		popup.percent.textContent = localize('voltAgent.contextFull', "{0} Full", percent);
		popup.tokens.textContent = snapshot.estimated
			? localize('voltAgent.contextTokens', "~{0} / {1} Tokens", formatContextTokens(snapshot.used), formatContextTokens(snapshot.limit))
			: localize('voltAgent.contextTokensExact', "{0} / {1} Tokens", formatContextTokens(snapshot.used), formatContextTokens(snapshot.limit));
		popup.model.textContent = snapshot.modelName
			? localize('voltAgent.contextModelWindow', "{0} · {1} window", snapshot.modelName, formatContextTokens(snapshot.limit))
			: localize('voltAgent.contextWindowOnly', "{0} context window", formatContextTokens(snapshot.limit));
		popup.donutLabel.textContent = percent;
		const ratio = Math.min(1, snapshot.used / Math.max(snapshot.limit, 1));
		popup.donutFill.setAttribute('stroke-dasharray', `${DONUT_CIRCUMFERENCE}`);
		popup.donutFill.setAttribute('stroke-dashoffset', `${DONUT_CIRCUMFERENCE * (1 - ratio)}`);
		popup.donutFill.style.stroke = snapshot.percent >= 95
			? 'var(--vscode-charts-red, #f85149)'
			: snapshot.percent >= 80
				? 'var(--vscode-charts-orange, #d29922)'
				: 'var(--vscode-charts-blue, #58a6ff)';

		popup.bar.replaceChildren();
		for (const item of snapshot.items) {
			const segment = append(popup.bar, $('.segment'));
			segment.style.background = item.color;
			segment.style.flexGrow = String(Math.max(item.tokens, 1));
			segment.title = `${item.label} · ${formatContextTokens(item.tokens)}`;
		}
		const unused = Math.max(0, snapshot.limit - snapshot.used);
		const rest = append(popup.bar, $('.segment.unused'));
		rest.style.flexGrow = String(Math.max(unused, snapshot.used === 0 ? 1 : 0));

		popup.list.replaceChildren();
		for (const item of snapshot.items) {
			const row = append(popup.list, $('.row'));
			const swatch = append(row, $('span.swatch'));
			swatch.style.background = item.color;
			const label = append(row, $('span.label'));
			label.textContent = item.label;
			if (item.detail) {
				append(label, $('span.detail')).textContent = item.detail;
			}
			append(row, $('span.count')).textContent = formatContextTokens(item.tokens);
			const share = append(row, $('span.share'));
			share.textContent = formatContextPercent((item.tokens / Math.max(snapshot.used, 1)) * 100);
		}

		popup.session.replaceChildren();
		const stats = [
			snapshot.input ? [localize('voltAgent.contextInput', "Input"), snapshot.input] as const : undefined,
			snapshot.output ? [localize('voltAgent.contextOutput', "Output"), snapshot.output] as const : undefined,
			snapshot.cache ? [localize('voltAgent.contextCache', "Cached"), snapshot.cache] as const : undefined,
		].filter((stat): stat is readonly [string, number] => !!stat);
		if (stats.length) {
			const row = append(popup.session, $('.metrics'));
			for (const [label, value] of stats) {
				const chip = append(row, $('.metric'));
				append(chip, $('span.k')).textContent = label;
				append(chip, $('span.v')).textContent = formatContextTokens(value);
			}
		}

		const canCompare = snapshot.models.length > 1;
		popup.fit.classList.toggle('hidden', !canCompare);
		popup.fit.classList.toggle('expanded', this.modelsExpanded);
		this.panelEl?.classList.toggle('expanded-models', canCompare && this.modelsExpanded);
		popup.toggle.setAttribute('aria-expanded', String(this.modelsExpanded));
		const toggleLabel = popup.toggle.querySelector('.label');
		if (toggleLabel) {
			toggleLabel.textContent = localize('voltAgent.contextFitsToggle', "See which models this context can fit");
		}

		if (popup.search.getValue() !== this.modelsQuery) {
			popup.search.setValue(this.modelsQuery);
		}
		if (canCompare && this.modelsExpanded) {
			this.modelsList?.setGroups(groupContextModels(filterContextModels(snapshot.models, this.modelsQuery)));
			popup.search.inputBox.layout();
		} else {
			this.modelsList?.clear();
		}

		popup.note.textContent = snapshot.compacted
			? (snapshot.modelName
				? localize('voltAgent.contextCompactNamed', "Context for {0} compacts automatically when needed.", snapshot.modelName)
				: localize('voltAgent.contextCompact', "Context compacts automatically when needed."))
			: '';
	}

	private createRing(parent: HTMLElement): SVGCircleElement {
		const svg = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 20 20');
		svg.setAttribute('width', '16');
		svg.setAttribute('height', '16');
		svg.setAttribute('aria-hidden', 'true');
		const track = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
		track.setAttribute('cx', '10');
		track.setAttribute('cy', '10');
		track.setAttribute('r', String(RING_RADIUS));
		track.setAttribute('fill', 'none');
		track.setAttribute('stroke-width', '2.4');
		track.classList.add('track');
		const fill = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
		fill.setAttribute('cx', '10');
		fill.setAttribute('cy', '10');
		fill.setAttribute('r', String(RING_RADIUS));
		fill.setAttribute('fill', 'none');
		fill.setAttribute('stroke-width', '2.4');
		fill.setAttribute('stroke-linecap', 'round');
		fill.setAttribute('transform', 'rotate(-90 10 10)');
		fill.classList.add('fill');
		svg.appendChild(track);
		svg.appendChild(fill);
		parent.appendChild(svg);
		return fill;
	}

	private createDonut(parent: HTMLElement): { fill: SVGCircleElement; label: HTMLElement } {
		const wrap = append(parent, $('.volt-agent-context-donut'));
		const svg = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 56 56');
		svg.setAttribute('width', '56');
		svg.setAttribute('height', '56');
		svg.setAttribute('aria-hidden', 'true');
		const track = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
		track.setAttribute('cx', '28');
		track.setAttribute('cy', '28');
		track.setAttribute('r', String(DONUT_RADIUS));
		track.setAttribute('fill', 'none');
		track.setAttribute('stroke-width', '6');
		track.classList.add('track');
		const fill = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
		fill.setAttribute('cx', '28');
		fill.setAttribute('cy', '28');
		fill.setAttribute('r', String(DONUT_RADIUS));
		fill.setAttribute('fill', 'none');
		fill.setAttribute('stroke-width', '6');
		fill.setAttribute('stroke-linecap', 'round');
		fill.setAttribute('transform', 'rotate(-90 28 28)');
		fill.classList.add('fill');
		svg.appendChild(track);
		svg.appendChild(fill);
		wrap.appendChild(svg);
		const label = append(wrap, $('span.value'));
		return { fill, label };
	}

}

const DONUT_RADIUS = 20;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

interface IContextPopupRefs {
	percent: HTMLElement;
	tokens: HTMLElement;
	model: HTMLElement;
	donutFill: SVGCircleElement;
	donutLabel: HTMLElement;
	bar: HTMLElement;
	list: HTMLElement;
	session: HTMLElement;
	fit: HTMLElement;
	toggle: HTMLButtonElement;
	search: FindInput;
	note: HTMLElement;
}
