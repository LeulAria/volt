/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/customizeVoltPage.css';
import { $, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { IVoltDropdownOption } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { IVoltCustomizeService } from '../../voltCustomize/browser/voltCustomizeService.js';
import { IVoltDraft, cloneDraft, listDrafts } from '../../voltCustomize/browser/voltPlayground.js';
import { IVoltLookToken, VOLT_LOOK_TOKENS, VoltLookTokenGroup, clampVoltLookValue, voltLookSettingId } from '../../voltCustomize/common/voltLookTokens.js';
import { ISettingsPageKit } from './codeIntelligencePage.js';

export interface ICustomizeVoltPageKit extends ISettingsPageKit {
	sectionHint(text: string): void;
	dropdown<T extends string>(host: HTMLElement, options: readonly IVoltDropdownOption<T>[], value: T, ariaLabel: string, onChange: (value: T) => void, width?: number): void;
}

const OPEN_PLAYGROUND = 'volt.customize.openPlayground';
const DRAFT_ROW_HEIGHT = 56;

const GROUP_LABELS: Record<VoltLookTokenGroup, string> = {
	chat: localize('customizeVolt.group.chat', "Chat"),
	composer: localize('customizeVolt.group.composer', "Message box"),
	sidebar: localize('customizeVolt.group.sidebar', "Agent sidebar"),
	toolbar: localize('customizeVolt.group.toolbar', "Title bar"),
};

/**
 * Settings > Customize Volt: which layout and look the window uses, every look token as a
 * stepper, the Playground and its drafts, and the files behind all of it (~/.volt/customize).
 */
export class CustomizeVoltPage {

	constructor(
		private readonly kit: ICustomizeVoltPageKit,
		@IVoltCustomizeService private readonly customize: IVoltCustomizeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	render(): Promise<void> {
		const { kit } = this;
		kit.pageHead(
			localize('customizeVolt.title', "Customize Volt"),
			localize('customizeVolt.lead', "Volt's look and the agent window's layout are files that you or your agent can change. Nothing here changes until you pick something; values you set yourself always win."),
		);
		// A new extension, a saved file or a picked layout redraws the page.
		kit.store.add(this.customize.onDidChange(() => {
			if (kit.isCurrent()) {
				kit.rerender();
			}
		}));
		this.renderPickers();
		const drafts = this.renderPlayground();
		this.renderProblems();
		this.renderTokens();
		this.renderFiles();
		return drafts;
	}

	private renderPickers(): void {
		const { kit, customize } = this;
		kit.sectionLabel(localize('customizeVolt.layoutAndLook', "Layout and look"));
		const group = kit.settingsGroup();
		const layouts: IVoltDropdownOption<string>[] = customize.layouts.map(entry => ({ id: entry.id, label: entry.label, description: entry.description ?? entry.id }));
		kit.settingRow(group, localize('customizeVolt.layout', "Layout"), localize('customizeVolt.layoutDesc', "How the agent window is arranged: the sidebar, the chat's width, the files sidebar and the right panel."), host => {
			kit.dropdown(host, layouts, customize.activeLayoutId, localize('customizeVolt.layout', "Layout"), id => void customize.setLayout(id), 220);
		});
		const looks: IVoltDropdownOption<string>[] = [
			{ id: '', label: localize('customizeVolt.noLook', "None"), description: localize('customizeVolt.noLookDesc', "The layout's own look") },
			...customize.looks.map(entry => ({ id: entry.id, label: entry.label, description: entry.description ?? entry.id })),
		];
		kit.settingRow(group, localize('customizeVolt.look', "Look"), localize('customizeVolt.lookDesc', "Corner radii, spacing, text sizes and colors over the layout."), host => {
			kit.dropdown(host, looks, customize.activeLookId, localize('customizeVolt.look', "Look"), id => void customize.setLook(id), 220);
		});
		kit.settingRow(group, localize('customizeVolt.reapply', "Window arrangement"), localize('customizeVolt.reapplyDesc', "Put the sidebar, files sidebar and right panel back the way the layout says. Reset goes back to Volt as it ships (⌘⌥⇧Escape)."), host => {
			const reapply = kit.store.add(createVoltButton(host, 'secondary'));
			reapply.label = localize('customizeVolt.reapplyButton', "Reapply Layout");
			kit.store.add(reapply.onDidClick(() => customize.applyLayoutWindowState()));
			const reset = kit.store.add(createVoltButton(host, 'secondary'));
			reset.label = localize('customizeVolt.reset', "Reset");
			kit.store.add(reset.onDidClick(() => void this.commandService.executeCommand('volt.customize.reset')));
		});
	}

	private async renderPlayground(): Promise<void> {
		const { kit } = this;
		kit.sectionLabel(localize('customizeVolt.playground', "Playground"));
		kit.sectionHint(localize('customizeVolt.playgroundHint', "Build your Volt inside Volt. The Playground opens a new window with its own chat: ask for a change (\"make the left sidebar blue\", \"hide the sidebar\", \"rounder message box\") and watch it happen there. Apply it to every window, or install it as an extension to share."));
		const group = kit.settingsGroup();
		kit.settingRow(group, localize('customizeVolt.newPlayground', "New customization"), localize('customizeVolt.newPlaygroundDesc', "Starts from the layout and look you use now."), host => {
			const open = kit.store.add(createVoltButton(host, 'primary'));
			open.label = localize('customizeVolt.openPlayground', "Open Playground");
			kit.store.add(open.onDidClick(() => void this.commandService.executeCommand(OPEN_PLAYGROUND)));
		});
		await this.customize.whenReady();
		if (!kit.isCurrent()) {
			return;
		}
		const drafts = await listDrafts(this.fileService, this.customize).catch(() => [] as IVoltDraft[]);
		if (!drafts.length || !kit.isCurrent()) {
			return;
		}
		const listHost = append(append(group, $('.volt-customize-drafts')), $('.volt-customize-drafts-list'));
		listHost.style.height = `${drafts.length * DRAFT_ROW_HEIGHT}px`;
		const clone = async (draft: IVoltDraft) => {
			await cloneDraft(this.fileService, this.customize, draft);
			if (kit.isCurrent()) {
				kit.rerender();
			}
		};
		const list = kit.store.add(this.instantiationService.createInstance(WorkbenchList<IVoltDraft>, 'VoltCustomizeDrafts', listHost, new DraftDelegate(), [new DraftRenderer(draft => void clone(draft))], {
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('customizeVolt.drafts', "Playground drafts"),
				getAriaLabel: draft => localize('customizeVolt.draftAria', "{0}, open its Playground", draft.label),
			},
		}));
		list.layout(drafts.length * DRAFT_ROW_HEIGHT);
		list.splice(0, 0, drafts);
		kit.store.add(list.onDidOpen(e => {
			if (e.element) {
				void this.commandService.executeCommand(OPEN_PLAYGROUND, e.element.folder);
			}
		}));
	}

	private renderProblems(): void {
		const problems = this.customize.problems;
		if (!problems.length) {
			return;
		}
		const { kit } = this;
		kit.sectionLabel(localize('customizeVolt.problems', "Problems"));
		kit.sectionHint(localize('customizeVolt.problemsHint', "These files were not used as written; Volt keeps the last good version. Each has a .error file beside it."));
		const group = kit.settingsGroup();
		for (const problem of problems) {
			kit.settingRow(group, problem.file.path.split('/').slice(-2).join('/'), problem.errors.join(' '), host => {
				const open = kit.store.add(createVoltButton(host, 'secondary'));
				open.label = localize('customizeVolt.openFile', "Open");
				kit.store.add(open.onDidClick(() => void this.editorService.openEditor({ resource: problem.file })));
			});
		}
	}

	private renderTokens(): void {
		const { kit } = this;
		kit.sectionLabel(localize('customizeVolt.tokens', "Sizes and spacing"));
		kit.sectionHint(localize('customizeVolt.tokensHint', "Each value is a setting (volt.look.*) and a CSS variable extensions can use. Changes apply to every window at once; the look and layout set the starting values."));
		const groups = new Map<VoltLookTokenGroup, IVoltLookToken[]>();
		for (const entry of VOLT_LOOK_TOKENS) {
			groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
		}
		for (const [groupId, tokens] of groups) {
			kit.sectionLabel(GROUP_LABELS[groupId]);
			const group = kit.settingsGroup();
			for (const entry of tokens) {
				const setting = voltLookSettingId(entry.id);
				const value = clampVoltLookValue(entry, this.configurationService.getValue(setting)) ?? entry.default;
				const own = this.configurationService.inspect(setting).userValue !== undefined;
				const title = own ? localize('customizeVolt.tokenSet', "{0} (set by you)", entry.id) : entry.id;
				kit.settingRow(group, title, entry.description, host => {
					kit.stepper(host, String(value), entry.unit === 'px' ? 'px' : '', next => {
						const clamped = clampVoltLookValue(entry, next) ?? entry.default;
						// Back at the default (Volt's, or the one a look or layout set): nothing to keep.
						void this.configurationService.updateValue(setting, clamped === this.configurationService.inspect(setting).defaultValue ? undefined : clamped);
						return clamped;
					}, entry.unit === 'px' ? 1 : 0.05);
					if (own) {
						const reset = kit.store.add(createVoltButton(host, 'ghost'));
						reset.label = localize('customizeVolt.tokenReset', "Reset");
						kit.store.add(reset.onDidClick(() => void this.configurationService.updateValue(setting, undefined)));
					}
				});
			}
		}
	}

	private renderFiles(): void {
		const { kit, customize } = this;
		kit.sectionLabel(localize('customizeVolt.files', "Files"));
		const group = kit.settingsGroup();
		kit.settingRow(group, localize('customizeVolt.folder', "Customize folder"), customize.home?.fsPath ?? localize('customizeVolt.folderPending', "Not ready yet"), host => {
			const guide = kit.store.add(createVoltButton(host, 'secondary'));
			guide.label = localize('customizeVolt.openGuide', "Open AGENTS.md");
			kit.store.add(guide.onDidClick(() => void this.commandService.executeCommand('volt.customize.openGuide')));
		});
		kit.settingRow(group, localize('customizeVolt.settingsJson', "All settings"), localize('customizeVolt.settingsJsonDesc', "Every token with its description in the Settings editor, or as JSON."), host => {
			const editor = kit.store.add(createVoltButton(host, 'secondary'));
			editor.label = localize('customizeVolt.openSettingsEditor', "Settings Editor");
			kit.store.add(editor.onDidClick(() => void this.commandService.executeCommand('workbench.action.openSettings2', { query: 'volt.look' })));
			const json = kit.store.add(createVoltButton(host, 'secondary'));
			json.label = localize('customizeVolt.openSettingsJson', "settings.json");
			kit.store.add(json.onDidClick(() => void this.commandService.executeCommand('workbench.action.openSettingsJson')));
		});
	}
}

class DraftDelegate implements IListVirtualDelegate<IVoltDraft> {
	getHeight(): number { return DRAFT_ROW_HEIGHT; }
	getTemplateId(): string { return 'draft'; }
}

interface IDraftTemplate {
	readonly label: HTMLElement;
	readonly detail: HTMLElement;
	readonly store: DisposableStore;
	draft?: IVoltDraft;
}

class DraftRenderer implements IListRenderer<IVoltDraft, IDraftTemplate> {
	readonly templateId = 'draft';

	constructor(private readonly onClone: (draft: IVoltDraft) => void) { }

	renderTemplate(container: HTMLElement): IDraftTemplate {
		const store = new DisposableStore();
		const row = append(container, $('.volt-customize-draft-row'));
		append(row, renderIcon(Codicon.beaker));
		const copy = append(row, $('.volt-customize-draft-copy'));
		const template: IDraftTemplate = { label: append(copy, $('.volt-customize-draft-label')), detail: append(copy, $('.volt-customize-draft-detail')), store };
		const clone = store.add(createVoltButton(append(row, $('.volt-customize-draft-actions')), 'secondary'));
		clone.label = localize('customizeVolt.cloneDraft', "Clone");
		clone.element.title = localize('customizeVolt.cloneDraftTitle', "Copy this draft into a new one");
		store.add(clone.onDidClick(() => {
			if (template.draft) {
				this.onClone(template.draft);
			}
		}));
		return template;
	}

	renderElement(draft: IVoltDraft, _index: number, template: IDraftTemplate): void {
		template.draft = draft;
		template.label.textContent = draft.label;
		template.detail.textContent = localize('customizeVolt.draftDetail', "playground/{0} · open its Playground", draft.folder.path.split('/').pop() ?? draft.name);
	}

	disposeTemplate(template: IDraftTemplate): void {
		template.store.dispose();
	}
}
