/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/settingsInspector.css';
import { $, addDisposableListener, append, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IInputBoxStyles, InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { Orientation, Sash, SashState } from '../../../../base/browser/ui/sash/sash.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ConfigurationTarget, IConfigurationService, IConfigurationValue } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IPreferencesService, ISetting } from '../../../services/preferences/common/preferences.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { createVoltDropdown } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { catalogSettings, ISettingsCatalogCategory, ISettingsCatalogGroup, ISettingsCatalogSetting, searchWords, settingMatches } from './settingsCatalog.js';

const ROW_HEIGHT = 30;

/** Scopes that only user settings can hold. */
const USER_ONLY_SCOPES = new Set<ConfigurationScope | undefined>([ConfigurationScope.APPLICATION, ConfigurationScope.MACHINE, ConfigurationScope.APPLICATION_MACHINE]);

/** A page of its own listed above a category's subsections (Volt's Providers & Models, Composer, …). */
export interface IInspectorPageLink {
	readonly id: string;
	readonly label: string;
	readonly icon: () => Element | undefined;
}

/** A row of the list: a page link, or a subsection with how many of its settings show. */
type ListRow =
	| { readonly kind: 'page'; readonly id: string; readonly page: IInspectorPageLink }
	| { readonly kind: 'group'; readonly id: string; readonly group: ISettingsCatalogGroup; readonly count: number };

interface IRowTemplate {
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly count: HTMLElement;
}

class RowDelegate implements IListVirtualDelegate<ListRow> {
	getHeight(): number {
		return ROW_HEIGHT;
	}
	getTemplateId(): string {
		return RowRenderer.ID;
	}
}

class RowRenderer implements IListRenderer<ListRow, IRowTemplate> {
	static readonly ID = 'voltSettingsListRow';
	readonly templateId = RowRenderer.ID;
	renderTemplate(container: HTMLElement): IRowTemplate {
		const row = append(container, $('.volt-settings-inspect-label'));
		return { icon: append(row, $('span.volt-settings-nav-icon')), label: append(row, $('span.label')), count: append(row, $('span.count')) };
	}
	renderElement(row: ListRow, _index: number, template: IRowTemplate): void {
		template.icon.replaceChildren();
		const glyph = row.kind === 'page' ? row.page.icon() : undefined;
		if (glyph) {
			template.icon.appendChild(glyph);
		}
		template.icon.hidden = !glyph;
		template.label.textContent = row.kind === 'page' ? row.page.label : row.group.label;
		template.count.textContent = row.kind === 'group' ? String(row.count) : '';
	}
	disposeTemplate(): void { }
}

/**
 * A category as two panes, like VS Code's settings editor: its subsections in a list (Text Editor >
 * Cursor, Find, Font, …), and every setting of the picked one beside it, each with its control.
 * Settings that sit on the category itself are the first subsection, General. A category with
 * pages of its own (Volt) lists them first; picking one fires `onDidOpenPage`, and the editor
 * draws the page where the settings were. Reads and writes the same configuration VS Code does.
 */
export class SettingsInspectorPage extends Disposable {

	readonly element: HTMLElement;
	private readonly list: WorkbenchList<ListRow>;
	private readonly title: HTMLElement;
	private readonly count: HTMLElement;
	private readonly modifiedButton: HTMLButtonElement;
	private readonly empty: HTMLElement;
	private readonly detail: HTMLElement;
	private readonly detailScroll: DomScrollableElement;
	private readonly detailStore = this._register(new DisposableStore());
	private readonly onDidOpenPageEmitter = this._register(new Emitter<string>());
	/** A page link was picked (click or arrow keys). */
	readonly onDidOpenPage = this.onDidOpenPageEmitter.event;
	private readonly onDidPickGroupEmitter = this._register(new Emitter<void>());
	/** A subsection was picked while a page was open, so the settings should come back. */
	readonly onDidPickGroup = this.onDidPickGroupEmitter.event;
	private category: ISettingsCatalogCategory | undefined;
	private pages: readonly IInspectorPageLink[] = [];
	private activePage: string | undefined;
	/** The rows on screen after the search and the modified filter. */
	private rows: ListRow[] = [];
	/** The subsection picked in each category, kept while the window lives. */
	private readonly pickedGroup = new Map<string, string>();
	/** Set while the list is rebuilt, so its own focus and selection changes are not picks. */
	private updating = false;
	private words: string[] = [];
	private modifiedOnly = false;
	/** Which settings the controls show and write: the user's, or the open project's. */
	private target: ConfigurationTarget.USER_LOCAL | ConfigurationTarget.WORKSPACE = ConfigurationTarget.USER_LOCAL;

	constructor(
		parent: HTMLElement,
		private readonly inputBoxStyles: () => IInputBoxStyles,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super();
		this.element = append(parent, $('.volt-settings-inspect'));
		const pane = append(this.element, $('.volt-settings-inspect-list-pane'));
		const head = append(pane, $('.volt-settings-inspect-head'));
		const heading = append(head, $('.volt-settings-inspect-title'));
		this.title = append(heading, $('span.title'));
		this.count = append(heading, $('span.count'));
		this.modifiedButton = append(head, $('button.volt-settings-inspect-filter')) as HTMLButtonElement;
		this.modifiedButton.type = 'button';
		this.modifiedButton.textContent = localize('voltSettings.inspect.modifiedOnly', "Modified only");
		this.modifiedButton.setAttribute('aria-pressed', 'false');
		this._register(addDisposableListener(this.modifiedButton, 'click', () => {
			this.modifiedOnly = !this.modifiedOnly;
			this.modifiedButton.classList.toggle('on', this.modifiedOnly);
			this.modifiedButton.setAttribute('aria-pressed', String(this.modifiedOnly));
			this.refresh();
		}));

		const listHost = append(pane, $('.volt-settings-inspect-list'));
		this.empty = append(pane, $('.volt-settings-inspect-empty'));
		this.list = this._register(instantiationService.createInstance(WorkbenchList<ListRow>, 'VoltSettingsInspector', listHost, new RowDelegate(), [new RowRenderer()], {
			identityProvider: { getId: (row: ListRow) => `${row.kind}:${row.id}` },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltSettings.inspect.listAria', "Settings sections"),
				getAriaLabel: (row: ListRow) => row.kind === 'page' ? row.page.label : localize('voltSettings.inspect.groupAria', "{0}, {1} settings", row.group.label, row.count),
			},
		}));
		this._register(this.list.onDidChangeFocus(e => this.pick(e.elements[0])));
		this._register(this.list.onDidChangeSelection(e => this.pick(e.elements[0])));
		const resize = new (getWindow(parent).ResizeObserver)(() => this.list.layout(listHost.clientHeight, listHost.clientWidth));
		resize.observe(listHost);
		this._register(toDisposable(() => resize.disconnect()));

		const detailHost = $('.volt-settings-inspect-detail-scroll');
		this.detail = append(detailHost, $('.volt-settings-inspect-detail'));
		this.detailScroll = this._register(new DomScrollableElement(detailHost, {
			className: 'volt-settings-inspect-detail-host',
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Auto,
			useShadows: false,
		}));
		append(this.element, this.detailScroll.getDomNode());
		this._register(attachPaneSash(this.element, pane, 'inspect'));
		const detailResize = new (getWindow(parent).ResizeObserver)(() => this.detailScroll.scanDomNode());
		detailResize.observe(this.detail);
		this._register(toDisposable(() => detailResize.disconnect()));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (!this.category || !this.element.isConnected) {
				return;
			}
			// Counts, the modified bars and the controls all show values: redraw both panes in place.
			if (this.category.settings.some(entry => e.affectsConfiguration(entry.setting.key))) {
				this.refresh(false);
			}
		}));
	}

	/**
	 * Shows a category with its page links first, keeping the picked subsection when it is still
	 * listed. `activePage` is the page drawn in place of the settings, lit in the list; `group`
	 * picks a subsection by id (an extension in Extensions).
	 */
	show(category: ISettingsCatalogCategory, search: string, pages: readonly IInspectorPageLink[] = [], activePage?: string, group?: string): void {
		const words = searchWords(search);
		if (group) {
			this.pickedGroup.set(category.id, group);
		}
		if (!group && this.category === category && this.pages === pages && this.activePage === activePage && words.join(' ') === this.words.join(' ')) {
			// The editor re-renders for many reasons; the panes already show this.
			return;
		}
		this.category = category;
		this.pages = pages;
		this.activePage = activePage;
		this.words = words;
		this.refresh();
	}

	setSearch(search: string): void {
		this.words = searchWords(search);
		if (this.category) {
			this.refresh();
		}
	}

	focus(): void {
		this.list.domFocus();
	}

	/** A category's subsections: General (the settings on the category itself) first, then the rest. */
	private groups(category: ISettingsCatalogCategory): ISettingsCatalogGroup[] {
		const groups = category.nodes.filter((node): node is ISettingsCatalogGroup => node.kind === 'group');
		const own = category.nodes.filter(node => node.kind === 'setting');
		if (own.length) {
			groups.unshift({ kind: 'group', id: `g:${category.id}:general`, label: groups.length ? localize('voltSettings.inspect.general', "General") : category.label, children: own });
		}
		return groups;
	}

	private keep(entry: ISettingsCatalogSetting): boolean {
		return settingMatches(entry, this.words) && (!this.modifiedOnly || isModified(this.configurationService.inspect(entry.setting.key)));
	}

	private refresh(keepScroll = false): void {
		const category = this.category;
		if (!category) {
			return;
		}
		// A list of pages only (Volt) has no count and nothing to filter by modified.
		const pagesOnly = category.count === 0 && this.pages.length > 0;
		this.modifiedButton.hidden = pagesOnly;
		const pages = this.modifiedOnly && !pagesOnly ? [] : this.pages.filter(page => this.words.every(word => page.label.toLowerCase().includes(word)));
		const groups: ListRow[] = [];
		let shown = 0;
		for (const group of this.groups(category)) {
			const count = catalogSettings(group.children).filter(entry => this.keep(entry)).length;
			shown += count;
			if (count) {
				groups.push({ kind: 'group', id: group.id, group, count });
			}
		}
		this.rows = [...pages.map((page): ListRow => ({ kind: 'page', id: page.id, page })), ...groups];
		this.title.textContent = category.label;
		this.count.textContent = pagesOnly ? '' : shown === category.count
			? String(category.count)
			: localize('voltSettings.inspect.countOf', "{0} of {1}", shown, category.count);
		const nothing = !this.rows.length;
		this.empty.textContent = !nothing ? '' : this.modifiedOnly && !this.words.length
			? localize('voltSettings.inspect.noneModified', "None of these settings are changed.")
			: localize('voltSettings.inspect.noMatch', "No settings here match your search.");
		this.empty.hidden = !nothing;

		// The open page is lit; else the picked subsection, else the first one.
		let target: ListRow | undefined = this.activePage !== undefined ? this.rows.find(row => row.kind === 'page' && row.id === this.activePage) : undefined;
		if (!target) {
			const picked = this.pickedGroup.get(category.id);
			target = groups.find(row => row.id === picked) ?? groups[0];
			if (target) {
				this.pickedGroup.set(category.id, target.id);
			}
		}
		const index = target ? this.rows.indexOf(target) : -1;
		this.updating = true;
		try {
			const scrollTop = this.list.scrollTop;
			this.list.splice(0, this.list.length, this.rows);
			this.list.setFocus(index >= 0 ? [index] : []);
			this.list.setSelection(index >= 0 ? [index] : []);
			if (keepScroll) {
				this.list.scrollTop = scrollTop;
			} else if (index >= 0) {
				this.list.reveal(index);
			}
		} finally {
			this.updating = false;
		}
		this.renderDetail(keepScroll);
	}

	private pick(row: ListRow | undefined): void {
		if (this.updating || !row || !this.category) {
			return;
		}
		if (row.kind === 'page') {
			if (row.id !== this.activePage) {
				this.activePage = row.id;
				this.onDidOpenPageEmitter.fire(row.id);
			}
			return;
		}
		const leavingPage = this.activePage !== undefined;
		this.activePage = undefined;
		if (row.id !== this.pickedGroup.get(this.category.id) || leavingPage) {
			this.pickedGroup.set(this.category.id, row.id);
			this.renderDetail(false);
		}
		if (leavingPage) {
			this.onDidPickGroupEmitter.fire();
		}
	}

	/** Every setting of the picked subsection; its own subsections follow under their titles. */
	private renderDetail(keepScroll: boolean): void {
		const scrollTop = keepScroll ? this.detailScroll.getScrollPosition().scrollTop : 0;
		// A write redraws the page; the control that made it gets focus back.
		const focusedKey = keepScroll ? (this.detail.ownerDocument.activeElement?.closest<HTMLElement>('[data-setting]')?.dataset.setting) : undefined;
		this.detailStore.clear();
		this.detail.replaceChildren();
		const picked = this.category && this.pickedGroup.get(this.category.id);
		const row = this.rows.find((candidate): candidate is Extract<ListRow, { kind: 'group' }> => candidate.kind === 'group' && candidate.id === picked);
		if (!row) {
			this.detailScroll.scanDomNode();
			return;
		}

		const head = append(this.detail, $('.volt-settings-inspect-page-head'));
		const heading = append(head, $('.volt-settings-inspect-page-title'));
		append(heading, $('h2.volt-settings-inspect-name')).textContent = row.group.label;
		append(heading, $('span.count')).textContent = String(row.count);
		const workspaceName = this.workspaceName();
		if (!workspaceName) {
			this.target = ConfigurationTarget.USER_LOCAL;
		} else {
			createVoltDropdown(head, this.contextViewService, {
				options: [
					{ id: 'user', label: localize('voltSettings.inspect.user', "User"), description: localize('voltSettings.inspect.userDesc', "Your settings, in every project."), icon: Codicon.account },
					{ id: 'project', label: localize('voltSettings.inspect.project', "Project · {0}", workspaceName), description: localize('voltSettings.inspect.projectDesc', "Only this project; wins over your settings."), icon: Codicon.folder },
				],
				value: this.target === ConfigurationTarget.WORKSPACE ? 'project' : 'user',
				ariaLabel: localize('voltSettings.inspect.scopeAria', "Settings to show"),
				align: 'right',
				onChange: id => {
					this.target = id === 'project' ? ConfigurationTarget.WORKSPACE : ConfigurationTarget.USER_LOCAL;
					this.renderDetail(true);
				},
			}, this.detailStore);
		}

		const renderGroup = (nodes: readonly (ISettingsCatalogSetting | ISettingsCatalogGroup)[], path: readonly string[]) => {
			const settings = nodes.filter((node): node is ISettingsCatalogSetting => node.kind === 'setting' && this.keep(node));
			if (settings.length) {
				if (path.length) {
					// allow-any-unicode-next-line
					append(this.detail, $('.volt-settings-inspect-section')).textContent = path.join(' › ');
				}
				const card = append(this.detail, $('.volt-settings-group'));
				for (const entry of settings) {
					this.settingRow(card, entry, workspaceName);
				}
			}
			for (const node of nodes) {
				if (node.kind === 'group') {
					renderGroup(node.children, [...path, node.label]);
				}
			}
		};
		renderGroup(row.group.children, []);

		if (focusedKey) {
			this.detail.querySelector<HTMLElement>(`[data-setting="${CSS.escape(focusedKey)}"]`)?.querySelector<HTMLElement>('input, button.volt-settings-toggle, .volt-dropdown, button')?.focus();
		}
		this.detailScroll.scanDomNode();
		this.detailScroll.setScrollPosition({ scrollTop });
	}

	/** One setting: its title, description and control for the scope in view, and a reset when set there. */
	private settingRow(parent: HTMLElement, entry: ISettingsCatalogSetting, workspaceName: string | undefined): void {
		const setting = entry.setting;
		const inspected = this.configurationService.inspect(setting.key);
		const project = this.target === ConfigurationTarget.WORKSPACE;
		const userOnly = USER_ONLY_SCOPES.has(setting.scope);
		const policy = inspected.policyValue !== undefined;
		const scopeValue = project ? inspected.workspaceValue : inspected.userValue;
		const set = scopeValue !== undefined;
		const value = project
			? inspected.workspaceValue ?? inspected.userValue ?? inspected.defaultValue
			: inspected.userValue ?? inspected.defaultValue;
		const title = entry.category ? `${entry.category}: ${entry.label}` : entry.label;

		const row = append(parent, $('.volt-settings-row.volt-settings-inspect-setting'));
		row.dataset.setting = setting.key;
		row.classList.toggle('modified', set);
		const copy = append(row, $('.volt-settings-row-copy'));
		const titleRow = append(copy, $('.volt-settings-inspect-setting-title'));
		const label = append(titleRow, $('label'));
		if (entry.category) {
			append(label, $('span.cat')).textContent = `${entry.category}: `;
		}
		label.appendChild(label.ownerDocument.createTextNode(entry.label));
		label.title = setting.key;
		const copyId = append(titleRow, $('button.volt-settings-inspect-icon.copy')) as HTMLButtonElement;
		copyId.type = 'button';
		copyId.title = localize('voltSettings.inspect.copyId', "Copy Setting ID ({0})", setting.key);
		copyId.setAttribute('aria-label', copyId.title);
		copyId.appendChild(renderIcon(Codicon.copy));
		this.detailStore.add(addDisposableListener(copyId, 'click', () => void this.clipboardService.writeText(setting.key)));
		appendDescription(append(copy, $('.desc')), setting.description.join('\n'));
		if (setting.deprecationMessage) {
			appendDescription(append(copy, $('.volt-settings-inspect-warning')), setting.deprecationMessage);
		}
		const note = policy ? localize('voltSettings.inspect.byPolicy', "Set by your organization's policy.")
			: project && userOnly ? localize('voltSettings.inspect.userOnly', "Only your user settings can set this.")
				: !project && inspected.workspaceValue !== undefined && workspaceName ? localize('voltSettings.inspect.overridden', "The project sets its own value.")
					: undefined;
		if (note) {
			append(copy, $('.volt-settings-inspect-note')).textContent = note;
		}

		const control = append(row, $('.volt-settings-row-control'));
		const disabled = policy || (project && userOnly);
		const write = (next: unknown) => void this.configurationService.updateValue(setting.key, next, this.target);
		this.control(control, setting, value, title, disabled, write);
		const type = primaryType(setting);
		if (!setting.enum?.length && (type === 'array' || type === 'object')) {
			const edit = this.detailStore.add(createVoltButton(control, 'ghost'));
			edit.label = localize('voltSettings.inspect.editJson', "Edit in settings.json");
			this.detailStore.add(edit.onDidClick(() => void (project
				? this.preferencesService.openWorkspaceSettings({ jsonEditor: true, revealSetting: { key: setting.key, edit: true } })
				: this.preferencesService.openUserSettings({ jsonEditor: true, revealSetting: { key: setting.key, edit: true } }))));
		}
		if (set) {
			const reset = append(control, $('button.volt-settings-inspect-icon')) as HTMLButtonElement;
			reset.type = 'button';
			reset.title = project
				? localize('voltSettings.inspect.removeOverride', "Remove the project's value")
				: localize('voltSettings.inspect.reset', "Reset to default");
			reset.setAttribute('aria-label', reset.title);
			reset.appendChild(renderIcon(Codicon.discard));
			reset.disabled = disabled;
			this.detailStore.add(addDisposableListener(reset, 'click', () => write(undefined)));
		}
	}

	private workspaceName(): string | undefined {
		if (this.workspaceService.getWorkbenchState() === WorkbenchState.EMPTY) {
			return undefined;
		}
		const workspace = this.workspaceService.getWorkspace();
		return workspace.folders.length === 1 ? workspace.folders[0].name : localize('voltSettings.inspect.workspace', "Workspace");
	}

	/** The control a setting's schema calls for: switch, dropdown, text or number, else JSON. */
	private control(host: HTMLElement, setting: ISetting, value: unknown, label: string, disabled: boolean, write: (value: unknown) => void): void {
		const type = primaryType(setting);
		if (setting.enum?.length) {
			const values = setting.enum as unknown[];
			const index = Math.max(0, values.findIndex(candidate => candidate === value));
			const options = values.map((candidate, i) => ({
				id: String(i),
				label: setting.enumItemLabels?.[i] || (candidate === null ? localize('voltSettings.inspect.none', "None") : String(candidate)),
				description: setting.enumDescriptions?.[i] ? plainText(setting.enumDescriptions[i]) : undefined,
			}));
			const dropdown = createVoltDropdown(host, this.contextViewService, {
				options,
				value: String(index),
				ariaLabel: label,
				align: 'right',
				onChange: id => write(values[Number(id)]),
			}, this.detailStore);
			dropdown.element.disabled = disabled;
			return;
		}
		if (type === 'boolean') {
			const on = value === true;
			const toggle = append(host, $('button.volt-settings-toggle')) as HTMLButtonElement;
			toggle.type = 'button';
			toggle.classList.toggle('on', on);
			toggle.setAttribute('role', 'switch');
			toggle.setAttribute('aria-checked', String(on));
			toggle.setAttribute('aria-label', label);
			toggle.disabled = disabled;
			this.detailStore.add(addDisposableListener(toggle, 'click', () => write(!on)));
			return;
		}
		if (type === 'string' || type === 'number' || type === 'integer') {
			const numeric = type !== 'string';
			const box = this.detailStore.add(new InputBox(append(host, $('.volt-settings-input.volt-settings-inspect-input')), this.contextViewService, {
				ariaLabel: label,
				type: numeric ? 'number' : 'text',
				inputBoxStyles: this.inputBoxStyles(),
			}));
			box.value = value === undefined || value === null ? '' : String(value);
			if (disabled) {
				box.disable();
			}
			if (numeric && !disabled) {
				// Themed stepper in place of the native spin arrows, which are hidden in CSS.
				box.element.classList.add('volt-settings-number');
				if (type === 'integer') {
					box.inputElement.step = '1';
				}
				const stepper = append(box.element, $('.volt-settings-number-stepper'));
				for (const [icon, up] of [[Codicon.chevronUp, true], [Codicon.chevronDown, false]] as const) {
					const button = append(stepper, $('button.volt-settings-number-step')) as HTMLButtonElement;
					button.type = 'button';
					button.tabIndex = -1;
					button.setAttribute('aria-label', up ? localize('voltSettings.inspect.increase', "Increase") : localize('voltSettings.inspect.decrease', "Decrease"));
					append(button, renderIcon(icon));
					this.detailStore.add(addDisposableListener(button, 'mousedown', e => e.preventDefault()));
					this.detailStore.add(addDisposableListener(button, 'click', () => {
						const input = box.inputElement;
						if (input.value.trim() === '') {
							input.value = '0';
						}
						try {
							if (up) {
								input.stepUp();
							} else {
								input.stepDown();
							}
						} catch {
							return;
						}
						input.dispatchEvent(new Event('change'));
					}));
				}
			}
			const error = append(host.parentElement!.querySelector('.volt-settings-row-copy')!, $('.volt-settings-inspect-error'));
			this.detailStore.add(addDisposableListener(box.inputElement, 'change', () => {
				let next: unknown = box.value;
				if (numeric) {
					if (box.value.trim() === '') {
						next = setting.type === 'null' || (Array.isArray(setting.type) && setting.type.includes('null')) ? null : undefined;
					} else {
						const parsed = Number(box.value);
						next = Number.isFinite(parsed) ? (type === 'integer' ? Math.trunc(parsed) : parsed) : NaN;
					}
				}
				const message = Number.isNaN(next) ? localize('voltSettings.inspect.notNumber', "Type a number.") : setting.validator?.(next) ?? '';
				error.textContent = message;
				if (!message && next !== undefined) {
					write(next);
				}
			}));
			return;
		}
		// Arrays and objects are edited as JSON; the row shows what is set.
		const preview = append(host, $('span.volt-settings-inspect-mono.volt-settings-inspect-preview'));
		preview.textContent = formatJson(value);
		preview.title = JSON.stringify(value, undefined, 2) ?? '';
	}
}

function primaryType(setting: ISetting): string | undefined {
	return Array.isArray(setting.type) ? setting.type.find(type => type !== 'null') : setting.type;
}

function isModified(inspected: IConfigurationValue<unknown>): boolean {
	return inspected.userValue !== undefined || inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined;
}

const PANE_MIN_WIDTH = 220;
const PAGE_MIN_WIDTH = 320;
/** Widths the user dragged list panes to, by pane, for as long as the window lives. */
const paneWidths = new Map<string, number>();

/**
 * A sash on the right edge of a list pane inside `host` (its offset parent). Dragging sets the
 * pane's width, double-click puts the stylesheet's width back; hidden panes take no drags.
 */
export function attachPaneSash(host: HTMLElement, pane: HTMLElement, key: string, minWidth = PANE_MIN_WIDTH): IDisposable {
	const store = new DisposableStore();
	const sash = store.add(new Sash(host, { getVerticalSashLeft: () => pane.offsetLeft + pane.offsetWidth }, { orientation: Orientation.VERTICAL }));
	const setWidth = (width: number | undefined) => {
		pane.style.width = width === undefined ? '' : `${width}px`;
		sash.layout();
	};
	const saved = paneWidths.get(key);
	if (saved !== undefined) {
		setWidth(saved);
	}
	let start = 0;
	store.add(sash.onDidStart(() => start = pane.offsetWidth));
	store.add(sash.onDidChange(e => {
		const max = Math.max(minWidth, host.clientWidth - pane.offsetLeft - PAGE_MIN_WIDTH);
		const width = Math.round(Math.max(minWidth, Math.min(max, start + e.currentX - e.startX)));
		paneWidths.set(key, width);
		setWidth(width);
	}));
	store.add(sash.onDidReset(() => {
		paneWidths.delete(key);
		setWidth(undefined);
	}));
	// A list pane starts hidden. ResizeObserver misses the moment it is shown, which leaves the
	// sash disabled on the pane's old edge. The class that shows it is on an ancestor.
	const layout = () => {
		sash.state = pane.offsetWidth ? SashState.Enabled : SashState.Disabled;
		sash.layout();
	};
	const targetWindow = getWindow(host);
	const resize = new targetWindow.ResizeObserver(layout);
	resize.observe(pane);
	resize.observe(host);
	const shown = new targetWindow.MutationObserver(layout);
	for (let node: HTMLElement | null = pane; node; node = node.parentElement) {
		shown.observe(node, { attributes: true, attributeFilter: ['class', 'style'] });
	}
	layout();
	store.add(toDisposable(() => {
		resize.disconnect();
		shown.disconnect();
	}));
	return store;
}

function formatJson(value: unknown): string {
	if (value === undefined) {
		return localize('voltSettings.inspect.unset', "Not set");
	}
	const text = JSON.stringify(value) ?? String(value);
	return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** Setting descriptions are markdown: links become their text, `#key#` references their key. */
function plainText(markdown: string): string {
	return markdown
		.replace(/`#([^#`]+)#`/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/\*\*([^*]+)\*\*/g, '$1');
}

/** A description with its `code` spans set in mono. */
function appendDescription(parent: HTMLElement, markdown: string): void {
	const parts = plainText(markdown).split('`');
	parts.forEach((part, index) => {
		if (index % 2) {
			append(parent, $('code')).textContent = part;
		} else if (part) {
			parent.appendChild(parent.ownerDocument.createTextNode(part));
		}
	});
}
