/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltSetup.css';
import { $, addDisposableListener, append, EventHelper, isHTMLElement } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IVoltEditorImportService, IVoltImportedEditor } from '../../../../platform/voltEditorImport/common/voltEditorImport.js';
import { IVoltFsBrowseService } from '../../../../platform/voltFsBrowse/common/voltFsBrowse.js';
import { createBrandIcon } from '../../../services/voltRuntime/browser/providers/providerBrands.js';
import { ICliAgentDefinition } from '../../../services/voltRuntime/browser/agents/cliAgents.js';
import { IAgentRuntimeService, OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../services/voltRuntime/common/runtime.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { tildify } from '../../voltProjects/common/browsePath.js';
import { IVoltProjectsService, VoltProjectCommands } from '../../voltProjects/common/projects.js';
import { IVoltFolderPickerService } from '../../voltProjects/browser/folderPickerService.js';
import { showVoltModal } from '../../voltProjects/browser/ui/voltModal.js';
import { AgentSetupService, IAgentSetupState } from './agentSetupService.js';

export type SetupStep = 'agents' | 'projects' | 'done';

const STEPS: readonly SetupStep[] = ['agents', 'projects', 'done'];
/** Setup uses neutral "white" primaries (foreground on editor background), not the theme's blue button. */
const setupPrimaryButtonStyles = {
	...defaultButtonStyles,
	buttonBackground: 'var(--vscode-foreground)',
	buttonForeground: 'var(--vscode-editor-background)',
	buttonHoverBackground: 'color-mix(in srgb, var(--vscode-foreground) 84%, var(--vscode-editor-background))',
	buttonBorder: 'transparent',
} as const;
/** How often a CLI is checked while its install or sign-in runs in the terminal. */
const WATCH_INTERVAL_MS = 3000;
/** A forgotten terminal stops being watched after this. */
const WATCH_LIMIT_MS = 15 * 60_000;

interface IRunningAction {
	readonly id: string;
	readonly action: 'install' | 'login';
	readonly label: string;
	readonly command: string;
}

let openWizard: { readonly show: (step: SetupStep) => void } | undefined;

/**
 * First-run setup: which agent CLIs are installed and signed in (install and sign in run in a
 * terminal the user watches), then projects from This PC, a Git URL, GitHub, or the recent
 * folders of VS Code and Cursor. Every step can be skipped; the command opens it again.
 */
export class VoltSetupWizard {

	private readonly agentSetup: AgentSetupService;
	private step: SetupStep = 'agents';
	private readonly states = new Map<string, IAgentSetupState | 'checking'>();
	private editors: readonly IVoltImportedEditor[] | undefined;
	private readonly selected = new Set<string>();
	private readonly addedHere = new Set<string>();
	private running: IRunningAction | undefined;
	private home = '';
	private changedAgents = false;

	private panel: HTMLElement | undefined;
	private backdrop: HTMLElement | undefined;
	private body: HTMLElement | undefined;
	private readonly renderStore = new DisposableStore();
	private readonly watch = new MutableDisposable();

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoltProjectsService private readonly projects: IVoltProjectsService,
		@IVoltFolderPickerService private readonly folderPicker: IVoltFolderPickerService,
		@IVoltFsBrowseService private readonly fsBrowse: IVoltFsBrowseService,
		@IVoltEditorImportService private readonly editorImport: IVoltEditorImportService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
	) {
		this.agentSetup = instantiationService.createInstance(AgentSetupService);
	}

	show(step: SetupStep = 'agents'): void {
		if (openWizard) {
			openWizard.show(step);
			return;
		}
		this.step = step;
		const modal = showVoltModal(this.layoutService, {
			title: localize('voltSetup.title', "Set up Volt"),
			headless: true,
			width: 720,
			height: 560,
			className: 'volt-setup',
			render: (body, close) => this.renderShell(body, close),
			onDidClose: () => {
				openWizard = undefined;
				this.watch.clear();
				this.renderStore.dispose();
				if (this.changedAgents) {
					void this.runtime.refreshProviders();
				}
			},
		});
		openWizard = {
			show: next => {
				this.expand();
				this.goTo(next);
			},
		};
		void modal;
	}

	private renderShell(body: HTMLElement, close: () => void): IDisposable {
		const store = new DisposableStore();
		this.body = body;
		this.panel = body.closest<HTMLElement>('.volt-modal') ?? undefined;
		const previous = this.panel?.previousElementSibling;
		this.backdrop = isHTMLElement(previous) && previous.classList.contains('volt-modal-backdrop') ? previous : undefined;
		this.close = close;
		store.add(this.projects.onDidChange(() => {
			if (this.step === 'projects' || this.step === 'done') {
				this.render();
			}
		}));
		void this.fsBrowse.home().then(home => this.home = home).catch(() => undefined);
		this.render();
		this.detectAll();
		return store;
	}

	private close: () => void = () => { };

	private goTo(step: SetupStep): void {
		this.step = step;
		if (step === 'projects' && !this.editors) {
			void this.editorImport.recentFolders().then(editors => {
				this.editors = editors;
				this.render();
			}, () => {
				this.editors = [];
				this.render();
			});
		}
		this.render();
	}

	//#region Agents

	private detectAll(): void {
		for (const def of this.agentSetup.definitions()) {
			void this.detectOne(def);
		}
	}

	private async detectOne(def: ICliAgentDefinition): Promise<IAgentSetupState> {
		if (!this.states.has(def.id)) {
			this.states.set(def.id, 'checking');
		}
		const state = await this.agentSetup.detect(def);
		this.states.set(def.id, state);
		if (this.step === 'agents' || this.step === 'done') {
			this.render();
		}
		return state;
	}

	private async run(state: IAgentSetupState, action: 'install' | 'login'): Promise<void> {
		const command = action === 'install' ? this.agentSetup.installCommand(state) : this.agentSetup.loginCommand(state);
		if (!command) {
			return;
		}
		this.running = { id: state.id, action, label: state.label, command };
		this.changedAgents = true;
		this.collapse();
		let onClosed;
		try {
			onClosed = await this.agentSetup.runInTerminal(action, state.label, command);
		} catch {
			this.running = undefined;
			this.expand();
			return;
		}
		const def = this.agentSetup.definitions().find(candidate => candidate.id === state.id)!;
		const store = new DisposableStore();
		const started = Date.now();
		const done = (next: IAgentSetupState) => action === 'install' ? next.installed : next.signIn.kind === 'signedIn';
		const finish = () => {
			this.running = undefined;
			this.watch.clear();
			this.expand();
		};
		const handle = mainWindow.setInterval(() => {
			if (Date.now() - started > WATCH_LIMIT_MS) {
				this.watch.clear();
				return;
			}
			void this.detectOne(def).then(next => {
				if (this.running?.id === def.id && done(next)) {
					finish();
				}
			});
		}, WATCH_INTERVAL_MS);
		store.add(toDisposable(() => mainWindow.clearInterval(handle)));
		store.add(onClosed(() => void this.detectOne(def).then(() => {
			if (this.running?.id === def.id) {
				finish();
			}
		})));
		this.watch.value = store;
	}

	/** While the terminal runs, the wizard shrinks to a card in the corner so the prompts are visible. */
	private collapse(): void {
		if (!this.panel) {
			return;
		}
		this.panel.classList.add('collapsed');
		this.panel.dataset.width = this.panel.style.width;
		this.panel.dataset.height = this.panel.style.height;
		this.panel.style.width = '340px';
		this.panel.style.height = 'auto';
		if (this.backdrop) {
			this.backdrop.style.display = 'none';
		}
		this.render();
	}

	private expand(): void {
		if (!this.panel?.classList.contains('collapsed')) {
			return;
		}
		this.panel.classList.remove('collapsed');
		this.panel.style.width = this.panel.dataset.width ?? '';
		this.panel.style.height = this.panel.dataset.height ?? '';
		if (this.backdrop) {
			this.backdrop.style.display = '';
		}
		this.render();
		this.panel.focus();
	}

	//#endregion

	private render(): void {
		const body = this.body;
		if (!body) {
			return;
		}
		this.renderStore.clear();
		body.replaceChildren();
		if (this.panel?.classList.contains('collapsed') && this.running) {
			this.renderRunning(body, this.running);
			return;
		}
		this.renderHeader(body);
		const content = append(body, $('.volt-setup-content'));
		const footer = append(body, $('.volt-add-footer.volt-setup-footer'));
		switch (this.step) {
			case 'agents':
				this.renderAgents(content, footer);
				break;
			case 'projects':
				this.renderProjects(content, footer);
				break;
			case 'done':
				this.renderDone(content, footer);
				break;
		}
	}

	private renderHeader(body: HTMLElement): void {
		const header = append(body, $('.volt-setup-header'));
		const titles = append(header, $('.volt-setup-titles'));
		append(titles, $('.volt-modal-title')).textContent = localize('voltSetup.title', "Set up Volt");
		const steps = append(titles, $('ol.volt-setup-steps'));
		const labels: Record<SetupStep, string> = {
			agents: localize('voltSetup.step.agents', "Agents"),
			projects: localize('voltSetup.step.projects', "Projects"),
			done: localize('voltSetup.step.done', "Done"),
		};
		const current = STEPS.indexOf(this.step);
		STEPS.forEach((step, index) => {
			const item = append(steps, $('li.volt-setup-step'));
			item.classList.toggle('active', index === current);
			item.classList.toggle('past', index < current);
			const button = append(item, $('button')) as HTMLButtonElement;
			button.type = 'button';
			append(button, $('span.index')).textContent = index < current ? '' : String(index + 1);
			if (index < current) {
				button.firstElementChild!.appendChild(renderIcon(Codicon.check));
			}
			append(button, $('span.label')).textContent = labels[step];
			this.renderStore.add(addDisposableListener(button, 'click', () => this.goTo(step)));
		});
		const close = append(header, $('button.volt-modal-close')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('voltSetup.skipAll', "Skip setup"));
		setAgentTooltip(close, localize('voltSetup.skipAllHint', "Skip setup. Run \"Volt: Set Up Agents and Projects\" to come back."));
		close.appendChild(renderIcon(Codicon.close));
		this.renderStore.add(addDisposableListener(close, 'click', e => {
			EventHelper.stop(e, true);
			this.close();
		}));
	}

	private footerButtons(footer: HTMLElement, hint: string, buttons: readonly { label: string; secondary?: boolean; run: () => void; enabled?: boolean }[]): void {
		append(footer, $('span.volt-add-footer-hint')).textContent = hint;
		for (const spec of buttons) {
			const button = this.renderStore.add(new Button(footer, { ...setupPrimaryButtonStyles, secondary: !!spec.secondary }));
			button.label = spec.label;
			button.enabled = spec.enabled !== false;
			this.renderStore.add(button.onDidClick(spec.run));
		}
	}

	private renderAgents(content: HTMLElement, footer: HTMLElement): void {
		const head = append(content, $('.volt-setup-lead'));
		append(head, $('span')).textContent = localize('voltSetup.agentsLead', "Volt runs the coding agents you already use. Install the ones you want and sign in; you can pick them in any chat.");
		const refresh = append(head, $('button.volt-setup-link')) as HTMLButtonElement;
		refresh.type = 'button';
		refresh.appendChild(renderIcon(Codicon.refresh));
		append(refresh, $('span')).textContent = localize('voltSetup.checkAgain', "Check again");
		this.renderStore.add(addDisposableListener(refresh, 'click', () => {
			this.states.clear();
			this.detectAll();
			this.render();
		}));

		const list = append(content, $('.volt-setup-list'));
		let ready = 0;
		for (const def of this.agentSetup.definitions()) {
			const state = this.states.get(def.id);
			if (state && state !== 'checking' && state.installed && state.signIn.kind !== 'signedOut') {
				ready++;
			}
			this.renderAgentRow(list, def, state);
		}
		const total = this.agentSetup.definitions().length;
		this.footerButtons(footer, localize('voltSetup.agentsReady', "{0} of {1} agents ready", ready, total), [
			{ label: localize('voltSetup.skip', "Skip"), secondary: true, run: () => this.goTo('projects') },
			{ label: localize('voltSetup.next', "Next"), run: () => this.goTo('projects') },
		]);
	}

	private renderAgentRow(list: HTMLElement, def: ICliAgentDefinition, state: IAgentSetupState | 'checking' | undefined): void {
		const row = append(list, $('.volt-setup-agent'));
		append(row, $('.volt-setup-agent-icon')).appendChild(createBrandIcon(def.id, 20));
		const text = append(row, $('.volt-setup-agent-text'));
		const name = append(text, $('.volt-setup-agent-name'));
		append(name, $('span')).textContent = def.label;
		if (state && state !== 'checking' && state.version) {
			append(name, $('span.volt-setup-version')).textContent = state.version;
		}
		if (def.earlyAccess) {
			append(name, $('span.volt-setup-badge')).textContent = localize('voltSetup.earlyAccess', "Early Access");
		}
		const status = append(text, $('.volt-setup-agent-status'));
		const actions = append(row, $('.volt-setup-agent-actions'));
		if (!state || state === 'checking') {
			row.classList.add('checking');
			append(status, $('span.volt-setup-dot.checking'));
			append(status, $('span')).textContent = localize('voltSetup.checking', "Checking...");
			return;
		}
		const info = state.info;
		if (!state.installed) {
			append(status, $('span.volt-setup-dot.missing'));
			append(status, $('span')).textContent = localize('voltSetup.notInstalled', "Not installed");
			const install = this.agentSetup.installCommand(state);
			if (install) {
				this.actionButton(actions, localize('voltSetup.install', "Install"), localize('voltSetup.installHint', "Runs {0} in a terminal", install), () => void this.run(state, 'install'));
			}
			if (info) {
				this.actionButton(actions, install ? '' : localize('voltSetup.installGuide', "Install Guide"), localize('voltSetup.docsHint', "Open {0}", info.docsUrl), () => void this.openerService.open(URI.parse(info.docsUrl), { openExternal: true }), install ? Codicon.linkExternal : undefined, !install);
			}
			return;
		}
		const signIn = state.signIn;
		const login = this.agentSetup.loginCommand(state);
		switch (signIn.kind) {
			case 'signedIn': {
				append(status, $('span.volt-setup-dot.ready'));
				const who = signIn.account
					? localize('voltSetup.signedInAs', "Signed in as {0}", signIn.account)
					: localize('voltSetup.signedIn', "Signed in");
				append(status, $('span')).textContent = signIn.plan ? `${who} · ${signIn.plan}` : who;
				break;
			}
			case 'signedOut':
				append(status, $('span.volt-setup-dot.warn'));
				append(status, $('span')).textContent = localize('voltSetup.signedOut', "Installed · not signed in");
				if (login) {
					this.actionButton(actions, localize('voltSetup.signIn', "Sign In"), localize('voltSetup.signInHint', "Runs {0} in a terminal", login), () => void this.run(state, 'login'), undefined, true);
				}
				break;
			default:
				append(status, $('span.volt-setup-dot.unknown'));
				append(status, $('span')).textContent = info?.loginHint
					? localize('voltSetup.unknownHint', "Installed · Volt can't tell if you're signed in. Sign In opens {0}; type {1} there.", login ?? def.commands[0], info.loginHint)
					: localize('voltSetup.unknown', "Installed · Volt can't tell if you're signed in");
				if (login) {
					this.actionButton(actions, localize('voltSetup.signIn', "Sign In"), localize('voltSetup.signInHint', "Runs {0} in a terminal", login), () => void this.run(state, 'login'));
				}
		}
		if (state.path) {
			setAgentTooltip(name, state.path);
		}
	}

	private actionButton(parent: HTMLElement, label: string, tooltip: string, run: () => void, icon?: typeof Codicon.check, primary = false): void {
		const button = append(parent, $('button.volt-setup-action')) as HTMLButtonElement;
		button.type = 'button';
		button.classList.toggle('primary', primary);
		button.classList.toggle('icon-only', !label);
		if (icon) {
			button.appendChild(renderIcon(icon));
		}
		if (label) {
			append(button, $('span')).textContent = label;
		} else {
			button.setAttribute('aria-label', tooltip);
		}
		setAgentTooltip(button, tooltip);
		this.renderStore.add(addDisposableListener(button, 'click', e => {
			EventHelper.stop(e, true);
			run();
		}));
	}

	private renderRunning(body: HTMLElement, running: IRunningAction): void {
		const card = append(body, $('.volt-setup-running'));
		const head = append(card, $('.volt-setup-running-head'));
		append(head, $('span.volt-setup-spinner')).appendChild(renderIcon(Codicon.loading));
		append(head, $('span.title')).textContent = running.action === 'install'
			? localize('voltSetup.installing', "Installing {0}", running.label)
			: localize('voltSetup.signingIn', "Signing in to {0}", running.label);
		append(card, $('code.volt-setup-command')).textContent = running.command;
		append(card, $('.volt-setup-running-hint')).textContent = localize('voltSetup.runningHint', "Follow the prompts in the terminal. Setup comes back when it is done.");
		const actions = append(card, $('.volt-setup-running-actions'));
		const check = this.renderStore.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		check.label = localize('voltSetup.checkAgain', "Check again");
		this.renderStore.add(check.onDidClick(() => {
			const def = this.agentSetup.definitions().find(candidate => candidate.id === running.id);
			if (def) {
				void this.detectOne(def);
			}
		}));
		const back = this.renderStore.add(new Button(actions, setupPrimaryButtonStyles));
		back.label = localize('voltSetup.backToSetup', "Back to Setup");
		this.renderStore.add(back.onDidClick(() => {
			this.running = undefined;
			this.watch.clear();
			this.expand();
		}));
	}

	//#region Projects

	private isAdded(path: string): boolean {
		return !!this.projects.getByUri(URI.file(path));
	}

	private renderProjects(content: HTMLElement, footer: HTMLElement): void {
		append(content, $('.volt-setup-lead')).textContent = localize('voltSetup.projectsLead', "Add the folders you work in. Chats start in a project; nothing is copied or changed.");
		const sources = append(content, $('.volt-setup-sources'));
		this.sourceButton(sources, Codicon.deviceDesktop, localize('voltSetup.thisPC', "This PC"), localize('voltSetup.thisPCHint', "Pick a folder"), () => void this.addFromThisPC());
		this.sourceButton(sources, Codicon.link, localize('voltSetup.gitUrl', "Git URL"), localize('voltSetup.gitUrlHint', "Clone a repository"), () => void this.commandService.executeCommand(VoltProjectCommands.cloneFromUrl));
		this.sourceButton(sources, Codicon.github, localize('voltSetup.github', "GitHub"), localize('voltSetup.githubHint', "Clone one of your repositories"), () => void this.commandService.executeCommand(VoltProjectCommands.cloneFromGitHub));

		if (this.addedHere.size) {
			const added = append(content, $('.volt-setup-added'));
			added.appendChild(renderIcon(Codicon.check));
			append(added, $('span')).textContent = localize('voltSetup.addedCount', "Added {0}", [...this.addedHere].map(path => path.split(/[\\/]/).pop()).join(', '));
		}

		const importHead = append(content, $('.volt-setup-section'));
		append(importHead, $('span')).textContent = localize('voltSetup.importTitle', "Recent folders in other editors");
		const list = append(content, $('.volt-setup-list.volt-setup-import'));
		if (!this.editors) {
			append(list, $('.volt-setup-empty')).textContent = localize('voltSetup.reading', "Reading recent folders...");
		} else if (!this.editors.length) {
			append(list, $('.volt-setup-empty')).textContent = localize('voltSetup.noEditors', "No recent folders found in VS Code, Cursor, Windsurf or VSCodium on this machine.");
		} else {
			for (const editor of this.editors) {
				this.renderEditorGroup(list, editor);
			}
		}

		const count = this.selected.size;
		this.footerButtons(footer, count
			? localize('voltSetup.selectedCount', "{0} selected", count)
			: localize('voltSetup.projectsCount', "{0} projects in Volt", this.projects.list().length), [
			{ label: localize('voltSetup.back', "Back"), secondary: true, run: () => this.goTo('agents') },
			...(count
				? [{ label: localize('voltSetup.importSelected', "Import {0}", count), run: () => this.importSelected() }]
				: [{ label: localize('voltSetup.next', "Next"), run: () => this.goTo('done') }]),
		]);
	}

	private renderEditorGroup(list: HTMLElement, editor: IVoltImportedEditor): void {
		const present = editor.folders.filter(folder => folder.exists);
		const gone = editor.folders.length - present.length;
		const group = append(list, $('.volt-setup-group'));
		const head = append(group, $('.volt-setup-group-head'));
		append(head, $('span.name')).textContent = editor.label;
		append(head, $('span.count')).textContent = gone
			? localize('voltSetup.folderCountGone', "{0} folders · {1} no longer exist", present.length, gone)
			: localize('voltSetup.folderCount', "{0} folders", present.length);
		const selectable = present.filter(folder => !this.isAdded(folder.path));
		if (selectable.length) {
			const all = selectable.every(folder => this.selected.has(folder.path));
			const toggle = append(head, $('button.volt-setup-link')) as HTMLButtonElement;
			toggle.type = 'button';
			toggle.textContent = all ? localize('voltSetup.selectNone', "Clear") : localize('voltSetup.selectAll', "Select all");
			this.renderStore.add(addDisposableListener(toggle, 'click', () => {
				for (const folder of selectable) {
					if (all) {
						this.selected.delete(folder.path);
					} else {
						this.selected.add(folder.path);
					}
				}
				this.render();
			}));
		}
		for (const folder of present) {
			const added = this.isAdded(folder.path);
			const checked = added || this.selected.has(folder.path);
			const row = append(group, $('button.volt-setup-folder')) as HTMLButtonElement;
			row.type = 'button';
			row.setAttribute('role', 'checkbox');
			row.setAttribute('aria-checked', String(checked));
			row.disabled = added;
			row.classList.toggle('checked', checked);
			const box = append(row, $('span.volt-setup-check'));
			if (checked) {
				box.appendChild(renderIcon(Codicon.check));
			}
			append(row, $('span.volt-setup-folder-icon')).appendChild(renderIcon(folder.gitRepo ? Codicon.repo : Codicon.folder));
			append(row, $('span.name')).textContent = folder.name;
			append(row, $('span.path')).textContent = this.home ? tildify(folder.path, this.home) : folder.path;
			if (added) {
				append(row, $('span.volt-setup-tag')).textContent = localize('voltSetup.added', "Added");
			}
			this.renderStore.add(addDisposableListener(row, 'click', () => {
				if (this.selected.has(folder.path)) {
					this.selected.delete(folder.path);
				} else {
					this.selected.add(folder.path);
				}
				this.render();
			}));
		}
	}

	private sourceButton(parent: HTMLElement, icon: typeof Codicon.check, label: string, detail: string, run: () => void): void {
		const button = append(parent, $('button.volt-setup-source')) as HTMLButtonElement;
		button.type = 'button';
		append(button, $('span.icon')).appendChild(renderIcon(icon));
		const text = append(button, $('span.text'));
		append(text, $('span.label')).textContent = label;
		append(text, $('span.detail')).textContent = detail;
		this.renderStore.add(addDisposableListener(button, 'click', e => {
			EventHelper.stop(e, true);
			run();
		}));
	}

	private async addFromThisPC(): Promise<void> {
		const path = await this.folderPicker.pickFolder({
			title: localize('voltSetup.pickTitle', "Add a project"),
			subtitle: localize('voltSetup.pickSubtitle', "Choose a folder on this computer"),
			acceptLabel: localize('voltSetup.add', "Add"),
		});
		if (path) {
			this.projects.add(URI.file(path), { source: 'local' });
			this.addedHere.add(path);
			this.render();
		}
	}

	private importSelected(): void {
		for (const path of this.selected) {
			if (!this.isAdded(path)) {
				this.projects.add(URI.file(path), { source: 'local' });
				this.addedHere.add(path);
			}
		}
		this.selected.clear();
		this.goTo('done');
	}

	//#endregion

	private renderDone(content: HTMLElement, footer: HTMLElement): void {
		const done = append(content, $('.volt-setup-done'));
		append(done, $('.volt-setup-done-icon')).appendChild(renderIcon(Codicon.passFilled));
		append(done, $('.volt-setup-done-title')).textContent = localize('voltSetup.doneTitle', "You're set up");
		const states = [...this.states.values()].filter((state): state is IAgentSetupState => state !== 'checking');
		const ready = states.filter(state => state.installed && state.signIn.kind !== 'signedOut');
		const needSignIn = states.filter(state => state.installed && state.signIn.kind === 'signedOut');
		const lines = append(done, $('ul.volt-setup-summary'));
		const line = (icon: typeof Codicon.check, text: string) => {
			const item = append(lines, $('li'));
			item.appendChild(renderIcon(icon));
			append(item, $('span')).textContent = text;
		};
		line(Codicon.robot, ready.length
			? localize('voltSetup.doneAgents', "Agents ready: {0}", ready.map(state => state.label).join(', '))
			: localize('voltSetup.doneNoAgents', "No agent is installed yet. Models with an API key still work."));
		if (needSignIn.length) {
			line(Codicon.warning, localize('voltSetup.doneSignIn', "Still to sign in: {0}", needSignIn.map(state => state.label).join(', ')));
		}
		line(Codicon.folder, localize('voltSetup.doneProjects', "Projects in Volt: {0}", this.projects.list().length));
		append(done, $('.volt-setup-done-hint')).textContent = localize('voltSetup.doneHint', "Run \"Volt: Set Up Agents and Projects\" from the Command Palette, or use Volt Settings, to come back here.");
		this.footerButtons(footer, '', [
			{ label: localize('voltSetup.openSettings', "Volt Settings"), secondary: true, run: () => { this.close(); void this.commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID); } },
			{ label: localize('voltSetup.finish', "Done"), run: () => this.close() },
		]);
	}
}
