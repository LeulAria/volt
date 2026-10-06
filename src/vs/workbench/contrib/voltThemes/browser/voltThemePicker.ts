/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltThemePicker.css';
import { $, addDisposableListener, append, getActiveWindow, getDomNodePagePosition, getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { AnchorAlignment, AnchorPosition, IAnchor } from '../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { matchesFuzzy } from '../../../../base/common/filters.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { VOLT_THEME_CONTRAST_MAX, VOLT_THEME_CONTRAST_MIN, VOLT_THEME_CONTRAST_STEP } from '../common/voltThemeContrast.js';
import { IVoltThemeSwatches } from '../common/voltThemeSwatches.js';
import { loadThemeSwatches, themeGroup, VoltThemeGroup } from './voltThemeCatalog.js';
import { IVoltThemeContrastService } from './voltThemeContrast.js';

export const VOLT_IMPORT_THEMES_COMMAND_ID = 'volt.theme.importFromVSCode';

export interface IVoltThemePickerOptions {
	/** Open against this element (the composer); without one the picker drops from the window's top. */
	readonly anchor?: HTMLElement;
}

interface IRow {
	readonly theme: IWorkbenchColorTheme;
	readonly element: HTMLElement;
	readonly search: string;
}

const WIDTH = 380;
/** Arrow keys preview a theme once the selection rests this long, so holding a key stays smooth. */
const PREVIEW_DELAY_MS = 90;
/** Theme files read at once while swatches fill in. */
const SWATCH_CONCURRENCY = 6;

let openPicker: { hide(): void } | undefined;

function groupTitle(group: VoltThemeGroup): string {
	switch (group) {
		case 'dark': return localize('voltThemes.group.dark', "Dark");
		case 'light': return localize('voltThemes.group.light', "Light");
		case 'hc': return localize('voltThemes.group.hc', "High Contrast");
	}
}

function formatContrast(value: number): string {
	return value > 0 ? `+${value}` : value < 0 ? `\u2212${-value}` : '0';
}

/** A small editor drawn in the theme's colors: side bar strip, three code lines, the accent. */
function paintSwatch(tile: HTMLElement, swatches: IVoltThemeSwatches): void {
	tile.classList.remove('loading');
	tile.style.backgroundColor = swatches.background;
	const strip = append(tile, $('span.strip'));
	strip.style.backgroundColor = swatches.surface;
	const lines = append(tile, $('span.lines'));
	const line = (...parts: [string, number][]) => {
		const row = append(lines, $('span.line'));
		for (const [color, width] of parts) {
			const bar = append(row, $('span.bar'));
			bar.style.backgroundColor = color;
			bar.style.width = `${width}px`;
		}
	};
	line([swatches.keyword, 7], [swatches.func, 13]);
	line([swatches.foreground, 5], [swatches.string, 14]);
	line([swatches.comment, 16]);
	const accent = append(tile, $('span.accent'));
	accent.style.backgroundColor = swatches.accent;
}

/**
 * The chat's theme picker: every installed color theme with a color tile, grouped light and dark.
 * Arrow keys preview a theme live, Enter or a click keeps it, Escape (or a click outside) goes
 * back to the theme and contrast that were on before. The contrast control under the list
 * previews the same way.
 */
export class VoltThemePicker {

	constructor(
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@IExtensionResourceLoaderService private readonly loader: IExtensionResourceLoaderService,
		@IVoltThemeContrastService private readonly contrast: IVoltThemeContrastService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IExtensionService private readonly extensionService: IExtensionService,
	) { }

	/** The extension a theme came from, by display name; built-in themes show none. */
	private sourceLabels(): (theme: IWorkbenchColorTheme) => string {
		const names = new Map(this.extensionService.extensions.map(e => [e.identifier.value.toLowerCase(), e.displayName || e.name]));
		return theme => {
			const data = theme.extensionData;
			if (!data || data.extensionIsBuiltin) {
				return '';
			}
			const name = names.get(data.extensionId.toLowerCase()) ?? data.extensionName;
			return name && !name.startsWith('%') && name !== theme.label ? name : '';
		};
	}

	async show(options: IVoltThemePickerOptions = {}): Promise<void> {
		openPicker?.hide();
		const themes = await this.themeService.getColorThemes();
		const original = this.themeService.getColorTheme();
		const originalContrast = this.contrast.value;
		const restoreFocus = getActiveWindow().document.activeElement;
		const sourceOf = this.sourceLabels();

		const store = new DisposableStore();
		let accepted = false;
		let previewed: IWorkbenchColorTheme = original;
		let previewTimer: ReturnType<typeof setTimeout> | undefined;
		let contrastValue = originalContrast;
		let afterHide: (() => void) | undefined;

		const clearPreviewTimer = () => {
			if (previewTimer !== undefined) {
				clearTimeout(previewTimer);
				previewTimer = undefined;
			}
		};
		const preview = (theme: IWorkbenchColorTheme, delay: number) => {
			clearPreviewTimer();
			const run = () => {
				previewTimer = undefined;
				if (theme.id === this.themeService.getColorTheme().id) {
					previewed = theme;
					return;
				}
				previewed = theme;
				this.themeService.setColorTheme(theme, 'preview').catch(onUnexpectedError);
			};
			if (delay) {
				previewTimer = setTimeout(run, delay);
			} else {
				run();
			}
		};

		const hide = () => this.contextViewService.hideContextView();
		const finish = () => {
			clearPreviewTimer();
			if (openPicker?.hide === hide) {
				openPicker = undefined;
			}
			if (accepted) {
				this.themeService.setColorTheme(previewed, 'auto').catch(onUnexpectedError);
				if (contrastValue !== this.contrast.saved) {
					this.contrast.set(contrastValue).catch(onUnexpectedError);
				} else {
					this.contrast.preview(undefined);
				}
			} else {
				if (this.themeService.getColorTheme().id !== original.id) {
					this.themeService.setColorTheme(original, undefined).catch(onUnexpectedError);
				}
				this.contrast.preview(undefined);
			}
			if (isHTMLElement(restoreFocus) && restoreFocus.isConnected) {
				restoreFocus.focus();
			}
			store.dispose();
			afterHide?.();
		};

		const anchor = (): HTMLElement | IAnchor => {
			if (options.anchor?.isConnected) {
				return options.anchor;
			}
			const container = this.layoutService.activeContainer;
			const page = getDomNodePagePosition(container);
			return { x: page.left + Math.max(8, (page.width - WIDTH) / 2), y: page.top + this.layoutService.activeContainerOffset.quickPickTop, width: 0, height: 0 };
		};

		openPicker = { hide };
		this.contextViewService.showContextView({
			getAnchor: anchor,
			anchorPosition: options.anchor ? AnchorPosition.ABOVE : AnchorPosition.BELOW,
			anchorAlignment: AnchorAlignment.LEFT,
			canRelayout: true,
			onHide: finish,
			render: container => {
				const root = append(container, $('.volt-theme-picker'));
				root.style.width = `${WIDTH}px`;
				root.setAttribute('role', 'dialog');
				root.setAttribute('aria-label', localize('voltThemes.picker', "Choose a theme"));
				store.add(toDisposable(() => root.remove()));

				// Outside presses cancel; the context view only reports its own events.
				store.add(addDisposableListener(getWindow(container).document, 'mousedown', e => {
					if (e.target instanceof Node && !root.contains(e.target)) {
						hide();
					}
				}, true));

				const searchRow = append(root, $('.volt-theme-picker-search'));
				searchRow.appendChild(renderIcon(Codicon.search)).classList.add('icon');
				const input = store.add(new InputBox(searchRow, undefined, {
					placeholder: localize('voltThemes.search', "Search themes"),
					ariaLabel: localize('voltThemes.search', "Search themes"),
					tooltip: '',
					inputBoxStyles: { ...defaultInputBoxStyles, inputBackground: 'transparent', inputBorder: 'transparent' },
				}));
				input.inputElement.setAttribute('role', 'combobox');
				input.inputElement.setAttribute('aria-expanded', 'true');

				const list = $('.volt-theme-picker-list');
				list.setAttribute('role', 'listbox');
				const scroll = store.add(new DomScrollableElement(list, {
					vertical: ScrollbarVisibility.Auto,
					horizontal: ScrollbarVisibility.Hidden,
					useShadows: false,
					verticalScrollbarSize: 10,
					alwaysConsumeMouseWheel: true,
				}));
				append(root, scroll.getDomNode()).classList.add('volt-theme-picker-scroll');

				const rows: IRow[] = [];
				const groupHeads = new Map<VoltThemeGroup, HTMLElement>();
				const order: VoltThemeGroup[] = themeGroup(original) === 'light' ? ['light', 'dark', 'hc'] : ['dark', 'light', 'hc'];
				const byGroup = new Map<VoltThemeGroup, IWorkbenchColorTheme[]>();
				for (const theme of themes) {
					const group = themeGroup(theme);
					byGroup.set(group, [...(byGroup.get(group) ?? []), theme]);
				}
				const tiles: { theme: IWorkbenchColorTheme; tile: HTMLElement }[] = [];
				for (const group of order) {
					const members = (byGroup.get(group) ?? []).sort((a, b) => a.label.localeCompare(b.label));
					if (!members.length) {
						continue;
					}
					const head = append(list, $('.volt-theme-picker-group'));
					head.textContent = groupTitle(group);
					groupHeads.set(group, head);
					for (const theme of members) {
						const element = append(list, $('.volt-theme-picker-row'));
						element.setAttribute('role', 'option');
						element.dataset.group = group;
						const tile = append(element, $('span.volt-theme-swatch.loading'));
						tile.setAttribute('aria-hidden', 'true');
						tiles.push({ theme, tile });
						const text = append(element, $('span.text'));
						append(text, $('span.label')).textContent = theme.label;
						const detail = sourceOf(theme);
						if (detail) {
							append(text, $('span.detail')).textContent = detail;
						}
						const check = append(element, $('span.check'));
						if (theme.id === original.id) {
							element.classList.add('current');
							check.appendChild(renderIcon(Codicon.check));
						}
						element.setAttribute('aria-label', [theme.label, detail, theme.id === original.id ? localize('voltThemes.current', "current") : undefined].filter(Boolean).join(', '));
						const row: IRow = { theme, element, search: `${theme.label} ${detail}` };
						rows.push(row);
						store.add(addDisposableListener(element, 'mousedown', e => e.preventDefault()));
						store.add(addDisposableListener(element, 'click', () => {
							clearPreviewTimer();
							previewed = theme;
							accepted = true;
							hide();
						}));
					}
				}

				// Swatches fill in as their theme files are read, a few at a time.
				let next = 0;
				const work = async () => {
					while (next < tiles.length && !store.isDisposed) {
						const { theme, tile } = tiles[next++];
						try {
							const swatches = await loadThemeSwatches(theme, original, this.loader);
							if (!store.isDisposed) {
								paintSwatch(tile, swatches);
							}
						} catch {
							tile.classList.add('failed');
						}
					}
				};
				for (let i = 0; i < SWATCH_CONCURRENCY; i++) {
					void work();
				}

				let visible: IRow[] = rows;
				let active = -1;
				const setActive = (index: number, reveal: boolean, doPreview: boolean) => {
					rows.forEach(r => r.element.classList.remove('active'));
					active = Math.max(-1, Math.min(visible.length - 1, index));
					const row = visible[active];
					if (!row) {
						input.inputElement.removeAttribute('aria-activedescendant');
						return;
					}
					row.element.classList.add('active');
					row.element.id = `volt-theme-row-${active}`;
					input.inputElement.setAttribute('aria-activedescendant', row.element.id);
					if (reveal) {
						scroll.scanDomNode();
						const top = row.element.offsetTop;
						const bottom = top + row.element.offsetHeight;
						const view = scroll.getScrollDimensions().height;
						const pos = scroll.getScrollPosition().scrollTop;
						if (top < pos + 24) {
							scroll.setScrollPosition({ scrollTop: Math.max(0, top - 24) });
						} else if (bottom > pos + view) {
							scroll.setScrollPosition({ scrollTop: bottom - view });
						}
					}
					if (doPreview) {
						preview(row.theme, PREVIEW_DELAY_MS);
					}
				};
				const filter = () => {
					const query = input.value.trim();
					visible = rows.filter(r => !query || !!matchesFuzzy(query, r.search, true));
					const shown = new Set(visible);
					for (const r of rows) {
						r.element.classList.toggle('hidden', !shown.has(r));
					}
					for (const [group, head] of groupHeads) {
						head.classList.toggle('hidden', !visible.some(r => r.element.dataset.group === group));
					}
					empty.classList.toggle('hidden', visible.length > 0);
					scroll.scanDomNode();
					const keep = visible.findIndex(r => r.theme.id === previewed.id);
					setActive(keep >= 0 ? keep : 0, true, keep < 0 && visible.length > 0);
				};
				const empty = append(list, $('.volt-theme-picker-empty.hidden'));
				empty.textContent = localize('voltThemes.noMatch', "No themes match");

				// Contrast, previewed with the theme and kept or dropped with it.
				const contrastRow = append(root, $('.volt-theme-picker-contrast'));
				append(contrastRow, $('span.title')).textContent = localize('voltThemes.contrast', "Contrast");
				const minus = append(contrastRow, $('button.step')) as HTMLButtonElement;
				minus.type = 'button';
				minus.setAttribute('aria-label', localize('voltThemes.lessContrast', "Less contrast"));
				minus.appendChild(renderIcon(Codicon.dash));
				const slider = append(contrastRow, $('input.slider')) as HTMLInputElement;
				slider.type = 'range';
				slider.min = String(VOLT_THEME_CONTRAST_MIN);
				slider.max = String(VOLT_THEME_CONTRAST_MAX);
				slider.step = String(VOLT_THEME_CONTRAST_STEP / 2);
				slider.value = String(contrastValue);
				slider.setAttribute('aria-label', localize('voltThemes.contrast', "Contrast"));
				const plus = append(contrastRow, $('button.step')) as HTMLButtonElement;
				plus.type = 'button';
				plus.setAttribute('aria-label', localize('voltThemes.moreContrast', "More contrast"));
				plus.appendChild(renderIcon(Codicon.add));
				const valueLabel = append(contrastRow, $('span.value'));
				const setContrast = (value: number) => {
					contrastValue = Math.max(VOLT_THEME_CONTRAST_MIN, Math.min(VOLT_THEME_CONTRAST_MAX, Math.round(value)));
					slider.value = String(contrastValue);
					// The filled part of the track, painted on the input itself (the track is transparent).
					const fill = `${(contrastValue - VOLT_THEME_CONTRAST_MIN) / (VOLT_THEME_CONTRAST_MAX - VOLT_THEME_CONTRAST_MIN) * 100}%`;
					slider.style.background = `linear-gradient(to right, var(--vscode-button-background, var(--vscode-focusBorder)) ${fill}, color-mix(in srgb, var(--vscode-foreground) 16%, transparent) ${fill}) center / 100% 4px no-repeat`;
					valueLabel.textContent = formatContrast(contrastValue);
					minus.disabled = contrastValue <= VOLT_THEME_CONTRAST_MIN;
					plus.disabled = contrastValue >= VOLT_THEME_CONTRAST_MAX;
					this.contrast.preview(contrastValue);
				};
				setContrast(contrastValue);
				store.add(addDisposableListener(slider, 'input', () => setContrast(Number(slider.value))));
				store.add(addDisposableListener(minus, 'click', () => setContrast(contrastValue - VOLT_THEME_CONTRAST_STEP)));
				store.add(addDisposableListener(plus, 'click', () => setContrast(contrastValue + VOLT_THEME_CONTRAST_STEP)));
				store.add(addDisposableListener(valueLabel, 'dblclick', () => setContrast(0)));
				// Done with the slider: give the keys back to the search field.
				store.add(addDisposableListener(slider, 'change', () => input.focus()));

				const footer = append(root, $('.volt-theme-picker-footer'));
				const importButton = append(footer, $('button.import')) as HTMLButtonElement;
				importButton.type = 'button';
				importButton.appendChild(renderIcon(Codicon.cloudDownload));
				append(importButton, $('span')).textContent = localize('voltThemes.import', "Import from VS Code…");
				importButton.title = localize('voltThemes.importTitle', "Copy theme extensions and theme settings from VS Code or Cursor");
				store.add(addDisposableListener(importButton, 'click', () => {
					afterHide = () => void this.commandService.executeCommand(VOLT_IMPORT_THEMES_COMMAND_ID);
					hide();
				}));
				const hint = append(footer, $('span.hint'));
				hint.textContent = localize('voltThemes.hint', "↑↓ preview  ⏎ apply  esc cancel");

				store.add(input.onDidChange(() => filter()));
				store.add(addDisposableListener(root, 'keydown', e => {
					const event = new StandardKeyboardEvent(e);
					let handled = true;
					if (event.keyCode === KeyCode.Escape) {
						hide();
					} else if (event.keyCode === KeyCode.Enter) {
						if (e.target === slider || e.target === input.inputElement || e.target === root) {
							const row = visible[active];
							if (row) {
								clearPreviewTimer();
								previewed = row.theme;
							}
							accepted = true;
							hide();
						} else {
							handled = false;
						}
					} else if (e.target === slider) {
						handled = false;
					} else if (event.keyCode === KeyCode.DownArrow) {
						setActive(active + 1 >= visible.length ? 0 : active + 1, true, true);
					} else if (event.keyCode === KeyCode.UpArrow) {
						setActive(active - 1 < 0 ? visible.length - 1 : active - 1, true, true);
					} else if (event.keyCode === KeyCode.PageDown) {
						setActive(Math.min(visible.length - 1, active + 8), true, true);
					} else if (event.keyCode === KeyCode.PageUp) {
						setActive(Math.max(0, active - 8), true, true);
					} else {
						handled = false;
					}
					if (handled) {
						e.preventDefault();
						e.stopPropagation();
					}
				}));

				const currentIndex = rows.findIndex(r => r.theme.id === original.id);
				const sizeList = () => {
					scroll.scanDomNode();
					setActive(currentIndex, true, false);
				};
				store.add(toDisposable(() => clearPreviewTimer()));
				getWindow(root).requestAnimationFrame(() => {
					if (!store.isDisposed) {
						sizeList();
						input.focus();
					}
				});
				return store;
			},
		});
	}
}
