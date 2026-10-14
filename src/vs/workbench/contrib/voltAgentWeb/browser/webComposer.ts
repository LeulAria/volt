/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentLimitBanner } from '../../voltAgent/browser/composer/agentLimitBanner.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ACCESS_MODE_OPTIONS, VoltAccessMode } from '../../../services/voltRuntime/common/access/accessModes.js';
import { splitModelDisplayName } from '../../../services/voltRuntime/common/models/modelOptions.js';
import { IVoltCatalogItem } from '../../../services/voltRuntime/common/providers.js';
import { createBrandIcon, providerFamily } from '../../../services/voltRuntime/browser/providers/providerBrands.js';
import { createAccessIcon } from '../../voltAgent/browser/chrome/accessIcons.js';
import { createThinkingDots, paintThinkingDots, THINKING_DOTS_SPEED } from '../../voltAgent/browser/composer/agentThinkingDots.js';
import { agentEmptyComposerChips } from '../../voltAgent/browser/composer/agentSuggestChips.js';
import { AgentQuestionTray } from '../../voltAgent/browser/composer/agentQuestionTray.js';
import { createChevronIcon, createOpenNewAgentIcon, createPlusIcon, createSendIcon, createExpandIcon } from '../../voltAgent/browser/editor/agentEditorIcons.js';
import { agentTurnStatus, currentModelRef, sendAgentPrompt } from '../../../services/voltAgentServer/common/agentClientServices.js';
import { WebAgentServices } from './webServices.js';
import { WebThread } from './webThread.js';

const MODEL_KEY = 'volt.web.model';

/**
 * The agent window's composer for the web: the same DOM and CSS (landing pickers, question tray,
 * input box, toolbar, status row, suggestion chips), with a text area where the window has a
 * Monaco editor. Sending goes through the server's orchestrator exactly as the window's does.
 */
export class WebComposer extends Disposable {

	readonly element: HTMLElement;
	private readonly chips: HTMLElement;
	private readonly statusChip: HTMLElement;
	private readonly statusLabel: HTMLElement;
	private readonly landing: HTMLElement;
	private readonly projectLabel: HTMLElement;
	private readonly projectPick: HTMLElement;
	private readonly tray: AgentQuestionTray;
	private readonly inputBox: HTMLElement;
	private readonly input: HTMLTextAreaElement;
	private readonly placeholder: HTMLElement;
	private readonly accessButton: HTMLElement;
	private readonly modelButton: HTMLElement;
	private readonly sendButton: HTMLButtonElement;
	private readonly status: HTMLElement;
	private readonly suggest: HTMLElement;
	private readonly menu = this._register(new DisposableStore());
	private sessionId: string | undefined;
	private readonly dotCells: HTMLElement[];
	private dotsTimer: number | undefined;
	private dotsStep = 0;
	private readonly limitBanner: AgentLimitBanner;
	private model: string | undefined = localStorage.getItem(MODEL_KEY) ?? undefined;

	private readonly _onDidSend = this._register(new Emitter<string>());
	/** The chat a prompt was sent to (a new chat gets its id here). */
	readonly onDidSend = this._onDidSend.event;

	constructor(private readonly services: WebAgentServices, private readonly thread: WebThread) {
		super();
		this.element = $('.volt-agent-composer');

		this.chips = append(this.element, $('.volt-agent-composer-chips'));
		this.statusChip = append(this.chips, $('button.volt-agent-composer-chip.status.volt-browser-dock-chip'));
		const dots = createThinkingDots();
		this.statusChip.appendChild(dots.root);
		this.dotCells = dots.cells;
		this.statusLabel = append(this.statusChip, $('span.volt-agent-composer-chip-label.volt-browser-dock-chip-label'));
		const scrollBottom = append(this.chips, $('button.volt-agent-composer-chip.scroll-bottom.hidden'));
		scrollBottom.appendChild(renderIcon(Codicon.arrowDown));
		scrollBottom.setAttribute('aria-label', localize('voltAgent.scrollToBottom', "Scroll to bottom"));
		this._register(addDisposableListener(scrollBottom, 'click', () => thread.scrollToEnd()));
		this._register(thread.onDidChangeScrolledUp(up => scrollBottom.classList.toggle('hidden', !up)));

		this.landing = append(this.element, $('.volt-agent-landing-chrome'));
		this.projectPick = this.landingPick('', true);
		this.projectLabel = this.projectPick.querySelector('.label')!;
		this.landingPick(localize('voltAgent.noBranch', "No branch"), true);
		const env = this.landingPick(localize('voltAgent.thisMac', "This Mac"), false, Codicon.deviceDesktop);
		env.classList.remove('empty');
		this._register(addDisposableListener(this.projectPick, 'click', e => {
			e.stopPropagation();
			this.showProjectMenu();
		}));

		this.tray = this._register(new AgentQuestionTray({
			onSubmit: (requestId, response) => {
				const note = this.input.value.trim();
				this.services.runtime.respondToQuestions(requestId, note ? { ...response, note } : response);
				if (note) {
					this.input.value = '';
					this.update();
				}
			},
			onLayout: () => this.thread.layout(),
		}));
		this.element.appendChild(this.tray.element);

		this.limitBanner = this._register(new AgentLimitBanner(services));
		this.element.appendChild(this.limitBanner.element);

		this.inputBox = append(this.element, $('.volt-agent-input-box'));
		const monaco = append(this.inputBox, $('.volt-agent-monaco.show-file-icons'));
		this.placeholder = append(monaco, $('.volt-agent-placeholder'));
		this.input = append(monaco, $('textarea.volt-web-input')) as HTMLTextAreaElement;
		this.input.rows = 1;
		this.input.spellcheck = false;
		const toolbar = append(this.inputBox, $('.volt-agent-toolbar'));
		const start = append(toolbar, $('.volt-agent-toolbar-start'));
		const end = append(toolbar, $('.volt-agent-toolbar-end'));
		append(start, $('button.volt-agent-plus')).appendChild(createPlusIcon());
		append(start, $('button.volt-agent-mode.hidden'));
		this.accessButton = append(start, $('button.volt-agent-access'));
		const openNew = append(start, $('button.volt-agent-open-new'));
		openNew.appendChild(createOpenNewAgentIcon());
		append(openNew, $('span.volt-agent-open-new-label')).textContent = localize('voltAgent.newAgent', "New agent");
		this.modelButton = append(end, $('button.volt-agent-model'));
		append(end, $('button.volt-agent-icon-btn.volt-agent-zoom-btn')).appendChild(createExpandIcon(false));
		append(end, $('button.volt-agent-icon-btn.volt-agent-attach-btn')).appendChild(renderIcon(Codicon.attach));
		this.sendButton = append(end, $('button.volt-agent-send')) as HTMLButtonElement;
		this.sendButton.appendChild(createSendIcon());

		this.status = append(this.element, $('.volt-agent-composer-status'));
		const statusStart = append(this.status, $('.volt-agent-status-start'));
		const branch = append(statusStart, $('button.volt-agent-status-branch.empty'));
		branch.appendChild(renderIcon(Codicon.gitBranch));
		append(branch, $('span.label')).textContent = localize('voltAgent.noBranch', "No branch");
		branch.appendChild(renderIcon(Codicon.chevronDown)).classList.add('chevron');
		const envStatus = append(statusStart, $('span.volt-agent-status-env'));
		append(envStatus, $('span.icon')).appendChild(renderIcon(Codicon.folder));
		append(envStatus, $('span.label')).textContent = localize('voltAgent.local', "Local");

		this.suggest = append(this.element, $('.volt-agent-suggest'));
		for (const chip of agentEmptyComposerChips({ mode: 'Agent' })) {
			const button = append(this.suggest, $('button.volt-agent-suggest-chip'));
			append(button, $('span.label')).textContent = chip.label;
			if (chip.kb) {
				append(button, $('span.kb')).textContent = chip.kb;
			}
		}

		this._register(addDisposableListener(this.input, 'input', () => this.update()));
		this._register(addDisposableListener(this.input, 'keydown', e => {
			if (this.tray.active && this.tray.handleKey(e)) {
				return;
			}
			if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) {
				e.preventDefault();
				void this.send();
			}
		}));
		this._register(addDisposableListener(this.sendButton, 'click', e => {
			e.preventDefault();
			void this.send();
		}));
		this._register(addDisposableListener(this.modelButton, 'click', e => {
			e.stopPropagation();
			this.showModelMenu();
		}));
		this._register(addDisposableListener(this.accessButton, 'click', e => {
			e.stopPropagation();
			this.showAccessMenu();
		}));
		this._register(addDisposableListener(this.statusChip, 'click', () => this.thread.layout()));
		this._register(addDisposableListener(mainWindow, 'mousedown', e => {
			if (!(e.target instanceof Node) || !this.element.ownerDocument.querySelector('.volt-web-menu')?.contains(e.target)) {
				this.menu.clear();
			}
		}));
		this._register(services.runtime.onDidChangeCatalog(() => this.update()));
		this._register(services.runtime.onDidChangeAccess(() => this.update()));
		this._register(services.runtime.onDidChangeActiveCatalog(() => this.update()));
		this._register(services.runtime.onDidChangeQuestions(id => id === this.sessionId && this.syncQuestions()));
		this._register(services.projects.onDidChangeProjects(() => this.update()));
		this._register(services.projects.onDidChangeActiveProject(() => this.update()));
		this._register(thread.onDidChange(() => this.update()));
		const ticker = mainWindow.setInterval(() => this.updateStatusChip(), 1000);
		this._register({
			dispose: () => {
				mainWindow.clearInterval(ticker);
				if (this.dotsTimer !== undefined) {
					mainWindow.clearInterval(this.dotsTimer);
				}
			}
		});
		this.update();
	}

	private landingPick(label: string, empty: boolean, icon?: typeof Codicon.deviceDesktop): HTMLElement {
		const button = append(this.landing, $('button.volt-agent-landing-pick'));
		button.classList.toggle('empty', empty);
		button.setAttribute('aria-haspopup', 'menu');
		if (icon) {
			append(button, $('span.trigger-icon')).appendChild(renderIcon(icon));
		}
		append(button, $('span.label')).textContent = label;
		button.appendChild(renderIcon(Codicon.chevronDown)).classList.add('chevron');
		return button;
	}

	setSession(sessionId: string | undefined): void {
		this.sessionId = sessionId;
		this.limitBanner.setSession(sessionId);
		this.menu.clear();
		this.syncQuestions();
		this.update();
	}

	focus(): void {
		this.input.focus();
	}

	private get currentModel(): string | undefined {
		return currentModelRef(this.services, this.sessionId, this.model);
	}

	private catalogItem(ref: string | undefined): IVoltCatalogItem | undefined {
		return ref ? this.services.runtime.resolveCatalogItem(ref) : undefined;
	}

	private update(): void {
		const followUp = this.thread.messages.length > 0;
		this.element.classList.toggle('follow-up', followUp);
		this.inputBox.classList.toggle('follow-up', followUp);
		this.placeholder.textContent = followUp ? localize('voltAgent.sendFollowUp', "Send follow-up") : localize('voltAgent.planSearchBuild', "Plan, search, build anything");
		this.placeholder.classList.toggle('hidden', !!this.input.value);
		this.input.style.height = 'auto';
		this.input.style.height = `${Math.min(220, this.input.scrollHeight)}px`;
		const project = this.services.projects.activeProject;
		this.projectLabel.textContent = project?.displayName ?? localize('voltAgent.selectProject', "Select project");
		this.projectPick.classList.toggle('empty', !project);
		this.renderAccess();
		this.renderModel();
		const canSend = !!this.input.value.trim() && (followUp || !!project);
		this.sendButton.classList.toggle('disabled', !canSend);
		this.updateStatusChip();
	}

	/** The chip beside the composer: the live phrase while a turn runs, then how long it worked (the window's dock status). */
	private updateStatusChip(): void {
		const lastAgent = [...this.thread.messages].reverse().find(message => message.kind === 'agent');
		const streaming = this.thread.isStreaming;
		const { label } = agentTurnStatus(lastAgent, streaming);
		this.chips.classList.toggle('is-visible', !!label);
		this.statusChip.classList.toggle('hidden', !label);
		this.statusChip.classList.toggle('working', streaming);
		this.statusLabel.textContent = label;
		if (streaming && this.dotsTimer === undefined) {
			paintThinkingDots(this.dotCells, this.dotsStep);
			this.dotsTimer = mainWindow.setInterval(() => paintThinkingDots(this.dotCells, ++this.dotsStep), THINKING_DOTS_SPEED);
		} else if (!streaming && this.dotsTimer !== undefined) {
			mainWindow.clearInterval(this.dotsTimer);
			this.dotsTimer = undefined;
		}
	}

	private renderAccess(): void {
		const mode = this.services.runtime.getAccessMode();
		const option = ACCESS_MODE_OPTIONS.find(item => item.id === mode);
		this.accessButton.replaceChildren(createAccessIcon(mode));
		append(this.accessButton, $('span.volt-agent-access-label')).textContent = option?.label ?? mode;
		this.accessButton.appendChild(createChevronIcon());
	}

	private renderModel(): void {
		const item = this.catalogItem(this.currentModel);
		this.modelButton.replaceChildren();
		if (item) {
			this.modelButton.appendChild(createBrandIcon(providerFamily(item.providerId), 13));
		}
		append(this.modelButton, $('span.volt-agent-model-label')).textContent = item ? splitModelDisplayName(item.label).name : localize('voltAgent.pickModel', "Pick a model");
		this.modelButton.appendChild(createChevronIcon());
	}

	private syncQuestions(): void {
		const pending = this.sessionId ? this.services.runtime.getPendingQuestions(this.sessionId) : [];
		this.tray.setRequest(pending[0]);
		this.thread.layout();
	}

	/** Sends the prompt: a new chat is bound to the selected project first, as the window does. */
	private async send(): Promise<void> {
		const text = this.input.value.trim();
		if (!text) {
			return;
		}
		const isNewChat = !this.sessionId || !this.thread.messages.length;
		const project = this.services.projects.activeProject;
		if (isNewChat && !project) {
			this.showProjectMenu();
			return;
		}
		const sent = sendAgentPrompt(this.services, { text, sessionId: this.sessionId, isNewChat, project, modelRef: this.currentModel });
		if (!sent) {
			return;
		}
		this.input.value = '';
		this.update();
		this.sessionId = sent.sessionId;
		this._onDidSend.fire(sent.sessionId);
		await sent.done;
	}

	//#region Menus

	private showMenu(anchor: HTMLElement, className: string, build: (menu: HTMLElement) => void): void {
		this.menu.clear();
		const menu = append(this.element.ownerDocument.body, $(`.volt-web-menu.volt-agent-dropdown.${className}`));
		build(menu);
		const rect = anchor.getBoundingClientRect();
		menu.style.left = `${Math.round(rect.left)}px`;
		menu.style.bottom = `${Math.round(mainWindow.innerHeight - rect.top + 6)}px`;
		this.menu.add({ dispose: () => menu.remove() });
	}

	private menuItem(menu: HTMLElement, label: string, description: string | undefined, active: boolean, run: () => void, icon?: HTMLElement): void {
		const item = append(menu, $('button.volt-agent-dropdown-item'));
		item.classList.toggle('active', active);
		if (icon) {
			append(item, $('span.icon')).appendChild(icon);
		}
		const copy = append(item, $('span.copy'));
		append(copy, $('span.label')).textContent = label;
		if (description) {
			append(copy, $('span.desc')).textContent = description;
		}
		this.menu.add(addDisposableListener(item, 'click', e => {
			e.stopPropagation();
			run();
			this.menu.clear();
			this.update();
		}));
	}

	private showProjectMenu(): void {
		this.showMenu(this.projectPick, 'projects', menu => {
			const active = this.services.projects.activeProject?.id;
			for (const project of this.services.projects.projects) {
				this.menuItem(menu, project.displayName, project.root.fsPath, project.id === active, () => this.services.projects.selectProject(project.id), renderIcon(Codicon.folder));
			}
			if (!this.services.projects.projects.length) {
				append(menu, $('.volt-agent-dropdown-empty')).textContent = localize('voltAgent.noProjects', "No projects yet. Add one in Volt.");
			}
		});
	}

	private showAccessMenu(): void {
		this.showMenu(this.accessButton, 'access', menu => {
			const mode = this.services.runtime.getAccessMode();
			for (const option of ACCESS_MODE_OPTIONS) {
				this.menuItem(menu, option.label, option.description, option.id === mode, () => void this.services.runtime.setAccessMode(option.id as VoltAccessMode), createAccessIcon(option.id));
			}
		});
	}

	private showModelMenu(): void {
		this.showMenu(this.modelButton, 'models', menu => {
			const current = this.currentModel;
			const enabled = this.services.runtime.listCatalog().filter(item => this.services.runtime.isModelEnabled(item.ref));
			for (const item of enabled) {
				this.menuItem(menu, splitModelDisplayName(item.label).name, item.detail, item.ref === current, () => {
					this.model = item.ref;
					localStorage.setItem(MODEL_KEY, item.ref);
				}, createBrandIcon(providerFamily(item.providerId), 14));
			}
		});
	}

	//#endregion
}
