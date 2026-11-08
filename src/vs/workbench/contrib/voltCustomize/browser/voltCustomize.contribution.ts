/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../common/voltCustomizeConfiguration.js';
import { $, addDisposableListener } from '../../../../base/browser/dom.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { onDidChangeLayoutMode } from '../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { createSurfaceStrokeIcon } from '../../voltAgent/browser/workspace/agentSurfaceMenu.js';
import { SHOW_AGENT_SCM_COMMAND_ID } from '../../voltAgent/common/agentGitActions.js';
import { IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { VOLT_LOOK_SETTING_PREFIX, voltLookCssVariables } from '../common/voltLookTokens.js';
import { IVoltSlotService, VoltSlotService } from '../common/voltSlots.js';
import { applyDraft, createDraft, deleteDraft, ensureDraftRepository, installDraft, listDrafts, openPlayground, readDraft } from './voltPlayground.js';
import { IVoltCustomizeService, VoltCustomizeService } from './voltCustomizeService.js';
import { VOLT_DEVTOOLS_EDITOR_ID, VoltDevtoolsEditor, VoltDevtoolsInput } from './voltDevtools.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, EditorsOrder } from '../../../common/editor.js';
import { closeAgentToolEditor, openInAgentTools, revealAgentToolEditor, shownAgentToolEditors } from '../../voltAgent/browser/workspace/agentSurfaceHost.js';
import { REVEAL_VOLT_PART_COMMAND_ID } from '../common/voltCustomizeContext.js';
import { IVoltFeatureService } from '../common/voltFeatures.js';
import { VoltFeatureService } from './voltFeatureService.js';

registerSingleton(IVoltSlotService, VoltSlotService, InstantiationType.Delayed);
// Eager: it sets the `voltFeature.*` context keys and takes turned-off features' tools away at startup.
registerSingleton(IVoltFeatureService, VoltFeatureService, InstantiationType.Eager);
registerSingleton(IVoltCustomizeService, VoltCustomizeService, InstantiationType.Eager);

export const CUSTOMIZE_VOLT_SECTION = 'customizeVolt';
const OPEN_VOLT_SETTINGS = 'workbench.action.openVoltSettings';

/**
 * Writes `--volt-look-*` on every window's root for each token that is not at its default. The
 * CSS reads `var(--volt-look-…, default)`, so Volt as it ships sets nothing.
 */
class VoltLookCssContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltLookCss';

	private applied = new Set<string>();

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILayoutService private readonly layoutService: ILayoutService,
		// Created with the window: its defaults must be registered before the first paint.
		@IVoltCustomizeService _customize: IVoltCustomizeService,
	) {
		super();
		this.applyAll();
		this._register(this.layoutService.onDidAddContainer(({ container }) => this.applyTo(container, this.variables())));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VOLT_LOOK_SETTING_PREFIX.slice(0, -1))) {
				this.applyAll();
			}
		}));
	}

	private variables(): Map<string, string> {
		return voltLookCssVariables(id => this.configurationService.getValue(id));
	}

	private applyAll(): void {
		const variables = this.variables();
		for (const container of this.layoutService.containers) {
			this.applyTo(container, variables);
		}
		this.applied = new Set(variables.keys());
	}

	private applyTo(container: HTMLElement, variables: Map<string, string>): void {
		for (const name of this.applied) {
			if (!variables.has(name)) {
				container.style.removeProperty(name);
			}
		}
		for (const [name, value] of variables) {
			if (container.style.getPropertyValue(name) !== value) {
				container.style.setProperty(name, value);
			}
		}
	}
}

/** Lucide's flask, drawn like the other title bar toggles. */
const FLASK_ICON_PATH = 'M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2M6.453 15h11.094M8.5 2h7';

/**
 * In a Playground window: a flask first among the agent title bar's toggles. Its menu has the
 * Playground's actions (Develop / Preview, Pop Out, Review Changes, Apply, Install, Discard); it
 * turns the warning color while the draft has problems, listed at the end of the menu.
 */
class VoltPlaygroundTitleContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltPlaygroundTitle';

	private button: HTMLButtonElement | undefined;
	private readonly mountRetry = this._register(new MutableDisposable());

	constructor(
		@IVoltCustomizeService private readonly customize: IVoltCustomizeService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
	) {
		super();
		void this.customize.whenReady().then(() => {
			this.update();
			void this.ensureRepository();
		});
		this._register(this.customize.onDidChange(() => this.update()));
		this._register(onDidChangeLayoutMode(() => this.update()));
	}

	/** Drafts made before Playgrounds were repositories get their baseline the first time they open. */
	private async ensureRepository(): Promise<void> {
		const playground = this.customize.playground;
		if (playground?.role !== 'develop' || await this.fileService.exists(joinPath(playground.folder, '.git'))) {
			return;
		}
		const draft = await readDraft(this.fileService, playground.folder);
		if (draft && await ensureDraftRepository(this.fileService, this.stdio, draft)) {
			await this.commandService.executeCommand('git.openRepository', draft.folder.fsPath).catch(() => undefined);
		}
	}

	private update(): void {
		const playground = this.customize.playground;
		if (!playground) {
			return;
		}
		const button = this.button ??= this.createButton();
		// The toggles belong to the agent window's chrome, which may not be built yet.
		const toggles = this.layoutService.mainContainer.querySelector<HTMLElement>('.part.titlebar .volt-agent-titlebar-toggles');
		if (!toggles) {
			this.mountRetry.value = disposableTimeout(() => this.update(), 1000);
			return;
		}
		if (toggles.firstElementChild !== button) {
			toggles.prepend(button);
		}
		const problems = playground.errors.length;
		button.classList.toggle('has-problems', problems > 0);
		const label = playground.role === 'preview'
			? localize('voltPlayground.previewTitle', "Preview of {0}", playground.label)
			: problems
				? localize('voltPlayground.titleProblems', "Playground: {0} ({1} problem(s))", playground.label, problems)
				: localize('voltPlayground.title', "Playground: {0}", playground.label);
		button.setAttribute('aria-label', label);
		setAgentTooltip(button, label, undefined, undefined, 'below');
	}

	private createButton(): HTMLButtonElement {
		const button = $('button.volt-agent-titlebar-toggle.volt-titlebar-control.volt-playground-entry') as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-haspopup', 'menu');
		button.appendChild(createSurfaceStrokeIcon(button.ownerDocument, FLASK_ICON_PATH));
		this._register(addDisposableListener(button, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showMenu(button);
		}));
		this._register(toDisposable(() => button.remove()));
		return button;
	}

	private showMenu(anchor: HTMLElement): void {
		const playground = this.customize.playground;
		if (!playground) {
			return;
		}
		const run = (id: string) => () => this.commandService.executeCommand(id);
		const actions: IAction[] = [];
		if (playground.role === 'preview') {
			actions.push(toAction({ id: 'volt.playground.previewNote', label: localize('voltPlayground.previewNote', "Preview of {0}: close this window to get Develop back", playground.label), enabled: false, run: () => { } }));
		} else {
			if (!this.customize.previewElsewhere) {
				const develop = this.customize.mode === 'develop';
				actions.push(
					toAction({ id: 'volt.playground.develop', label: localize('voltPlayground.develop', "Develop"), checked: develop, run: develop ? () => { } : run(TOGGLE_PLAYGROUND_MODE) }),
					toAction({ id: 'volt.playground.preview', label: localize('voltPlayground.preview', "Preview"), checked: !develop, run: develop ? run(TOGGLE_PLAYGROUND_MODE) : () => { } }),
					toAction({ id: POP_OUT_PREVIEW, label: localize('voltPlayground.popOut', "Pop Out Preview"), run: run(POP_OUT_PREVIEW) }),
					new Separator(),
				);
			}
			actions.push(
				toAction({ id: SHOW_AGENT_SCM_COMMAND_ID, label: localize('voltPlayground.review', "Review Changes"), run: run(SHOW_AGENT_SCM_COMMAND_ID) }),
				new Separator(),
				toAction({ id: APPLY_PLAYGROUND, label: localize('voltPlayground.apply', "Apply to My Volt"), run: run(APPLY_PLAYGROUND) }),
				toAction({ id: INSTALL_PLAYGROUND, label: localize('voltPlayground.install', "Install as Extension"), run: run(INSTALL_PLAYGROUND) }),
				toAction({ id: DISCARD_PLAYGROUND, label: localize('voltPlayground.discard', "Discard…"), run: run(DISCARD_PLAYGROUND) }),
			);
		}
		if (playground.errors.length) {
			actions.push(new Separator(), ...playground.errors.slice(0, 5).map((error, index) => toAction({ id: `volt.playground.problem.${index}`, label: `⚠ ${error}`, enabled: false, run: () => { } })));
		}
		this.contextMenuService.showContextMenu({ getAnchor: () => anchor, getActions: () => actions });
	}
}

/**
 * Develop shows the devtools tab beside the chat; Preview takes it away. With the preview popped out
 * into its own window, this window keeps the devtools until that window closes.
 */
class VoltPlaygroundDevtoolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltPlaygroundDevtools';

	private wanted: boolean | undefined;

	constructor(
		@IVoltCustomizeService private readonly customize: IVoltCustomizeService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		void this.customize.whenReady().then(() => this.sync());
		this._register(this.customize.onDidChange(() => this.sync()));
		// The tab opens beside a chat: if none was on screen yet, try again when one is.
		this._register(this.editorService.onDidActiveEditorChange(() => {
			if (this.wanted && !this.isOpen()) {
				this.wanted = undefined;
				this.sync();
			}
		}));
	}

	/** The tab lives in the right panel's own editor part, which the editor service doesn't list. */
	private openTabs(): VoltDevtoolsInput[] {
		return [...shownAgentToolEditors(), ...this.editorService.editors].filter((editor): editor is VoltDevtoolsInput => editor instanceof VoltDevtoolsInput);
	}

	private isOpen(): boolean {
		return this.openTabs().length > 0;
	}

	private sync(): void {
		const playground = this.customize.playground;
		const wanted = playground?.role === 'develop' && (this.customize.mode === 'develop' || this.customize.previewElsewhere);
		if (wanted === this.wanted) {
			return;
		}
		this.wanted = wanted;
		if (wanted) {
			if (!this.isOpen()) {
				openInAgentTools(new VoltDevtoolsInput(), undefined, { pinned: true });
			}
			return;
		}
		for (const editor of shownAgentToolEditors()) {
			if (editor instanceof VoltDevtoolsInput) {
				closeAgentToolEditor(editor);
			}
		}
		for (const { editor, groupId } of this.editorService.getEditors(EditorsOrder.SEQUENTIAL)) {
			if (editor instanceof VoltDevtoolsInput) {
				void this.editorService.closeEditor({ editor, groupId });
			}
		}
	}
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VoltDevtoolsEditor, VOLT_DEVTOOLS_EDITOR_ID, localize('voltDevtools.editorLabel', "Customize Devtools")),
	[new SyncDescriptor(VoltDevtoolsInput)],
);

registerWorkbenchContribution2(VoltLookCssContribution.ID, VoltLookCssContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(VoltPlaygroundTitleContribution.ID, VoltPlaygroundTitleContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(VoltPlaygroundDevtoolsContribution.ID, VoltPlaygroundDevtoolsContribution, WorkbenchPhase.AfterRestored);

// --- Commands ----------------------------------------------------------------------------------

const APPLY_PLAYGROUND = 'volt.playground.apply';
const INSTALL_PLAYGROUND = 'volt.playground.install';
const DISCARD_PLAYGROUND = 'volt.playground.discard';
const TOGGLE_PLAYGROUND_MODE = 'volt.playground.toggleMode';
const POP_OUT_PREVIEW = 'volt.playground.popOutPreview';
export const OPEN_PLAYGROUND = 'volt.customize.openPlayground';

const category = localize2('voltCustomize.category', "Volt");

registerAction2(class TogglePlaygroundModeAction extends Action2 {
	constructor() {
		super({ id: TOGGLE_PLAYGROUND_MODE, visibility: 'public', title: localize2('voltPlayground.toggleMode', "Toggle Playground Develop / Preview"), category, f1: true });
	}
	run(accessor: ServicesAccessor): void {
		const customize = accessor.get(IVoltCustomizeService);
		if (customize.playground?.role === 'develop' && !customize.previewElsewhere) {
			customize.setMode(customize.mode === 'develop' ? 'preview' : 'develop');
		}
	}
});

/** A part chip clicked in a chat: the devtools open (Develop) on that part. */
registerAction2(class RevealVoltPartAction extends Action2 {
	constructor() {
		super({ id: REVEAL_VOLT_PART_COMMAND_ID, visibility: 'public', title: localize2('voltDevtools.revealTitle', "Show Part in Customize Devtools"), category, f1: false });
	}
	run(accessor: ServicesAccessor, id?: unknown): void {
		if (typeof id !== 'string') {
			return;
		}
		const customize = accessor.get(IVoltCustomizeService);
		if (customize.playground?.role === 'develop' && customize.mode === 'preview' && !customize.previewElsewhere) {
			customize.setMode('develop');
		}
		const existing = shownAgentToolEditors().find(editor => editor instanceof VoltDevtoolsInput);
		for (const editor of VoltDevtoolsEditor.live) {
			if (editor.reveal(id)) {
				if (existing) {
					revealAgentToolEditor(existing);
				}
				return;
			}
		}
		VoltDevtoolsEditor.pendingReveal = id;
		if (existing) {
			revealAgentToolEditor(existing);
		} else {
			openInAgentTools(new VoltDevtoolsInput(), undefined, { pinned: true });
		}
	}
});

registerAction2(class PopOutPreviewAction extends Action2 {
	constructor() {
		super({ id: POP_OUT_PREVIEW, visibility: 'public', title: localize2('voltPlayground.popOutTitle', "Open Playground Preview in New Window"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IVoltCustomizeService).openPreviewWindow();
	}
});

registerAction2(class CustomizeVoltAction extends Action2 {
	constructor() {
		super({ id: 'volt.customize.open', visibility: 'public', title: localize2('voltCustomize.open', "Customize Volt"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand(OPEN_VOLT_SETTINGS, CUSTOMIZE_VOLT_SECTION);
	}
});

registerAction2(class ResetCustomizationsAction extends Action2 {
	constructor() {
		super({
			id: 'volt.customize.reset',
			visibility: 'internal',
			title: localize2('voltCustomize.reset', "Reset Customizations"),
			category,
			f1: true,
			// The escape hatch: always there, whatever a layout or keys file did.
			keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.Escape, weight: KeybindingWeight.ExternalExtension + 1000 },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IVoltCustomizeService).reset();
		accessor.get(INotificationService).info(localize('voltCustomize.resetDone', "Volt is back to its default layout with no look. Your files in ~/.volt/customize are unchanged."));
	}
});

async function pickEntry(accessor: ServicesAccessor, kind: 'layout' | 'look'): Promise<void> {
	const customize = accessor.get(IVoltCustomizeService);
	const quickInput = accessor.get(IQuickInputService);
	await customize.whenReady();
	const entries = kind === 'layout' ? customize.layouts : customize.looks;
	const active = kind === 'layout' ? customize.activeLayoutId : customize.activeLookId;
	const items: (IQuickPickItem & { id: string })[] = [
		...(kind === 'look' ? [{ id: '', label: localize('voltCustomize.noLook', "None"), description: localize('voltCustomize.noLookDesc', "the layout's own look") }] : []),
		...entries.map(entry => ({ id: entry.id, label: entry.label, description: entry.id, detail: entry.description })),
	];
	const picked = await quickInput.pick(items, {
		placeHolder: kind === 'layout' ? localize('voltCustomize.pickLayout', "Pick a layout") : localize('voltCustomize.pickLook', "Pick a look"),
		activeItem: items.find(item => item.id === active),
	});
	if (picked) {
		await (kind === 'layout' ? customize.setLayout(picked.id) : customize.setLook(picked.id));
	}
}

registerAction2(class SelectLayoutAction extends Action2 {
	constructor() {
		super({ id: 'volt.customize.selectLayout', visibility: 'public', title: localize2('voltCustomize.selectLayout', "Switch Layout…"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return pickEntry(accessor, 'layout');
	}
});

registerAction2(class SelectLookAction extends Action2 {
	constructor() {
		super({ id: 'volt.customize.selectLook', visibility: 'public', title: localize2('voltCustomize.selectLook', "Switch Look…"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return pickEntry(accessor, 'look');
	}
});

registerAction2(class OpenCustomizeGuideAction extends Action2 {
	constructor() {
		super({ id: 'volt.customize.openGuide', visibility: 'public', title: localize2('voltCustomize.openGuide', "Open Customize Folder Guide (AGENTS.md)"), category, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const customize = accessor.get(IVoltCustomizeService);
		await customize.whenReady();
		if (customize.home) {
			await accessor.get(IEditorService).openEditor({ resource: joinPath(customize.home, 'AGENTS.md'), options: { pinned: true } });
		}
	}
});

registerAction2(class OpenPlaygroundAction extends Action2 {
	constructor() {
		super({ id: OPEN_PLAYGROUND, visibility: 'public', title: localize2('voltCustomize.openPlayground', "Open Customize Playground"), category, f1: true });
	}
	/** `folder` reopens an existing draft; without it a new draft is made. */
	async run(accessor: ServicesAccessor, folder?: unknown): Promise<void> {
		const customize = accessor.get(IVoltCustomizeService);
		const fileService = accessor.get(IFileService);
		const hostService = accessor.get(IHostService);
		const quickInput = accessor.get(IQuickInputService);
		const stdio = accessor.get(IVoltStdioService);
		await customize.whenReady();
		let target = URI.isUri(folder) ? folder : undefined;
		if (!target) {
			// Reopen a draft, or start a new one.
			const drafts = await listDrafts(fileService, customize).catch(() => []);
			if (drafts.length) {
				const newItem = { id: '', label: `$(add) ${localize('voltPlayground.new', "New customization…")}` };
				const picked = await quickInput.pick([
					newItem,
					{ type: 'separator', label: localize('voltPlayground.drafts', "Drafts") },
					...drafts.map(draft => ({ id: draft.folder.toString(), label: `$(beaker) ${draft.label}`, description: `playground/${draft.folder.path.split('/').pop()}`, draft })),
				] as (IQuickPickItem & { id: string; draft?: (typeof drafts)[number] } | IQuickPickSeparator)[], { placeHolder: localize('voltPlayground.pick', "Open a Playground") });
				if (!picked || !('id' in picked)) {
					return;
				}
				target = picked.draft?.folder;
			}
		}
		if (!target) {
			const label = await quickInput.input({
				prompt: localize('voltPlayground.namePrompt', "Name this customization. The Playground opens in a new window with its own chat."),
				value: localize('voltPlayground.defaultName', "My Volt"),
			});
			if (!label?.trim()) {
				return;
			}
			target = await createDraft(fileService, customize, label.trim());
			// Before the window opens, so its Changes view starts from these files.
			const draft = await readDraft(fileService, target);
			if (draft) {
				await ensureDraftRepository(fileService, stdio, draft);
			}
		}
		await openPlayground(hostService, target);
	}
});

async function currentDraft(accessor: ServicesAccessor) {
	const customize = accessor.get(IVoltCustomizeService);
	const playground = customize.playground;
	return playground ? readDraft(accessor.get(IFileService), playground.folder) : undefined;
}

registerAction2(class ApplyPlaygroundAction extends Action2 {
	constructor() {
		super({ id: APPLY_PLAYGROUND, visibility: 'internal', title: localize2('voltPlayground.applyTitle', "Apply Playground to My Volt"), category, f1: false });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const customize = accessor.get(IVoltCustomizeService);
		const fileService = accessor.get(IFileService);
		const notificationService = accessor.get(INotificationService);
		const draft = await currentDraft(accessor);
		if (!draft) {
			return;
		}
		await applyDraft(fileService, customize, draft);
		notificationService.info(localize('voltPlayground.applied', "\"{0}\" is now your look and layout in every window (home/{1}). Keep editing here and apply again to update it.", draft.label, draft.name));
	}
});

registerAction2(class InstallPlaygroundAction extends Action2 {
	constructor() {
		super({ id: INSTALL_PLAYGROUND, visibility: 'internal', title: localize2('voltPlayground.installTitle', "Install Playground as Extension"), category, f1: false });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const customize = accessor.get(IVoltCustomizeService);
		const fileService = accessor.get(IFileService);
		const extensionManagementService = accessor.get(IWorkbenchExtensionManagementService);
		const notificationService = accessor.get(INotificationService);
		const draft = await currentDraft(accessor);
		if (!draft) {
			return;
		}
		try {
			const id = await installDraft(fileService, extensionManagementService, customize, draft);
			notificationService.info(localize('voltPlayground.installed', "Installed {0}. Its look and layout are {0}/{1} in Settings > Customize Volt; share it with `npx @vscode/vsce package` in the draft folder.", id, draft.name));
		} catch (error) {
			notificationService.error(localize('voltPlayground.installFailed', "Could not install the draft: {0}", String(error)));
		}
	}
});

registerAction2(class DiscardPlaygroundAction extends Action2 {
	constructor() {
		super({ id: DISCARD_PLAYGROUND, visibility: 'internal', title: localize2('voltPlayground.discardTitle', "Discard Playground"), category, f1: false });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const fileService = accessor.get(IFileService);
		const dialogService = accessor.get(IDialogService);
		const hostService = accessor.get(IHostService);
		const draft = await currentDraft(accessor);
		if (!draft) {
			return;
		}
		const { confirmed } = await dialogService.confirm({
			message: localize('voltPlayground.discardConfirm', "Discard the \"{0}\" draft?", draft.label),
			detail: localize('voltPlayground.discardDetail', "Its folder goes to the trash and this window closes. Anything you applied or installed from it stays."),
			primaryButton: localize('voltPlayground.discardButton', "Discard"),
		});
		if (confirmed) {
			await deleteDraft(fileService, draft);
			await hostService.close();
		}
	}
});
