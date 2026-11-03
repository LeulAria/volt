/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindow, isKeyboardEvent } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { ColorScheme, isDark, isHighContrast } from '../../../../platform/theme/common/theme.js';
import { IWorkbenchColorTheme } from '../../../services/themes/common/workbenchThemeService.js';
import { AppearancePage, swatch, themeOrder } from './appearancePage.js';

type ThemeRow =
	| { readonly kind: 'header'; readonly id: string; readonly label: string }
	| { readonly kind: 'theme'; readonly id: string; readonly theme: IWorkbenchColorTheme }
	| { readonly kind: 'browse'; readonly id: string };

interface IThemeTemplate {
	readonly row: HTMLElement;
	readonly chip: HTMLElement;
	readonly label: HTMLElement;
	readonly tag: HTMLElement;
	readonly check: HTMLElement;
}

class ThemeDelegate implements IListVirtualDelegate<ThemeRow> {
	getHeight(row: ThemeRow): number {
		return row.kind === 'header' ? 30 : 28;
	}
	getTemplateId(): string {
		return ThemeRenderer.ID;
	}
}

class ThemeRenderer implements IListRenderer<ThemeRow, IThemeTemplate> {
	static readonly ID = 'voltSettingsTheme';
	readonly templateId = ThemeRenderer.ID;

	constructor(private readonly marks: () => { readonly active: string; readonly standby: ReadonlySet<string> }) { }

	renderTemplate(container: HTMLElement): IThemeTemplate {
		const row = append(container, $('.volt-settings-theme-row'));
		return {
			row,
			chip: append(row, $('span.volt-settings-theme-chip')),
			label: append(row, $('span.volt-settings-theme-name')),
			tag: append(row, $('span.volt-settings-theme-tag')),
			check: append(row, $('span.volt-settings-theme-check')),
		};
	}

	renderElement(row: ThemeRow, _index: number, template: IThemeTemplate): void {
		template.row.className = `volt-settings-theme-row ${row.kind}`;
		template.row.closest('.monaco-list-row')?.classList.toggle('volt-settings-list-static', row.kind === 'header');
		template.chip.replaceChildren();
		template.check.replaceChildren();
		template.tag.textContent = '';
		if (row.kind === 'header') {
			template.label.textContent = row.label;
			return;
		}
		if (row.kind === 'browse') {
			template.label.textContent = localize('voltSettings.appearance.browse', "Browse more themes");
			return;
		}
		// The theme in miniature: its editor with an accent, a keyword and a string.
		const colors = swatch(row.theme);
		template.chip.style.background = colors.editor;
		for (const color of [colors.keyword, colors.string, colors.accent]) {
			append(template.chip, $('span')).style.background = color;
		}
		template.label.textContent = row.theme.label;
		const { active, standby } = this.marks();
		if (row.theme.settingsId === active) {
			template.check.appendChild(renderIcon(Codicon.check));
		} else if (standby.has(row.theme.settingsId)) {
			template.tag.textContent = isDark(row.theme.type) ? localize('voltSettings.appearance.whenDark', "When dark") : localize('voltSettings.appearance.whenLight', "When light");
		}
	}

	disposeElement(_row: ThemeRow, _index: number, template: IThemeTemplate): void {
		template.chip.style.background = '';
	}

	disposeTemplate(): void { }
}

/**
 * Color themes as VS Code's theme picker lists them (light, dark and high contrast themes, by name,
 * Volt's first), in the settings' list pane. Clicking or arrowing onto a theme applies it. The list
 * outlives page re-renders, so a theme switch never takes keyboard focus away from it.
 */
export class SettingsThemeList extends Disposable {

	readonly element: HTMLElement;
	private readonly list: WorkbenchList<ThemeRow>;
	private readonly count: HTMLElement;
	private rows: ThemeRow[] = [];
	private generation = 0;

	constructor(private readonly page: AppearancePage, @IInstantiationService instantiationService: IInstantiationService) {
		super();
		this.element = $('.volt-settings-theme-list');
		const head = append(this.element, $('.volt-settings-side-head'));
		append(head, $('span.volt-settings-side-title')).textContent = localize('voltSettings.colorTheme', "Color Theme");
		this.count = append(head, $('span.volt-settings-side-count'));
		const host = append(this.element, $('.volt-settings-side-list'));
		this.list = this._register(instantiationService.createInstance(WorkbenchList<ThemeRow>, 'VoltSettingsThemes', host, new ThemeDelegate(), [new ThemeRenderer(() => this.page.themeMarks())], {
			identityProvider: { getId: (row: ThemeRow) => row.id },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltSettings.colorTheme', "Color Theme"),
				getAriaLabel: (row: ThemeRow) => row.kind === 'theme' ? row.theme.label : row.kind === 'header' ? row.label : localize('voltSettings.appearance.browse', "Browse more themes"),
				getRole: (row: ThemeRow) => row.kind === 'header' ? 'presentation' : 'option',
			},
		}));
		this._register(this.list.onDidOpen(e => this.choose(e.element)));
		// Arrowing through the list tries each theme on, as the quick pick does.
		this._register(this.list.onDidChangeFocus(e => {
			const row = e.elements[0];
			if (e.browserEvent && isKeyboardEvent(e.browserEvent) && row?.kind === 'theme') {
				void this.page.pick(row.theme);
			}
		}));
		const resize = new (getWindow(host).ResizeObserver)(() => this.list.layout(host.clientHeight, host.clientWidth));
		resize.observe(host);
		this._register(toDisposable(() => resize.disconnect()));
	}

	private choose(row: ThemeRow | undefined): void {
		if (row?.kind === 'theme') {
			void this.page.pick(row.theme);
		} else if (row?.kind === 'browse') {
			this.page.browseThemes();
		}
	}

	/** Reloads the themes (filtered by the settings search) and marks the one in use. */
	async refresh(needle: string, scheme: ColorScheme): Promise<void> {
		const generation = ++this.generation;
		const themes = (await this.page.colorThemes()).filter(theme => !needle || theme.label.toLowerCase().includes(needle));
		if (generation !== this.generation) {
			return;
		}
		const group = (id: string, label: string, list: IWorkbenchColorTheme[]): ThemeRow[] => list.length
			? [{ kind: 'header', id: `h:${id}`, label }, ...list.sort(themeOrder).map(theme => ({ kind: 'theme' as const, id: theme.id, theme }))]
			: [];
		const light = group('light', localize('voltSettings.appearance.lightThemes', "Light Themes"), themes.filter(theme => theme.type === ColorScheme.LIGHT));
		const dark = group('dark', localize('voltSettings.appearance.darkThemes', "Dark Themes"), themes.filter(theme => theme.type === ColorScheme.DARK));
		const hc = group('hc', localize('voltSettings.appearance.hcThemes', "High Contrast Themes"), themes.filter(theme => isHighContrast(theme.type)));
		// The scheme on screen comes first, as in VS Code's picker.
		this.rows = [...(isDark(scheme) ? [...dark, ...light] : [...light, ...dark]), ...hc, { kind: 'browse', id: 'browse' }];
		this.count.textContent = String(themes.length);
		this.list.splice(0, this.list.length, this.rows);
		const { active } = this.page.themeMarks();
		const index = this.rows.findIndex(row => row.kind === 'theme' && row.theme.settingsId === active);
		if (index >= 0) {
			// Keyboard focus stays where it is; only the mark moves.
			if (!this.list.getHTMLElement().contains(getWindow(this.element).document.activeElement)) {
				this.list.setFocus([index]);
				this.list.reveal(index);
			}
			this.list.setSelection([index]);
		}
	}
}
