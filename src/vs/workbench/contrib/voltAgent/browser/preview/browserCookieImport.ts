/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../voltProjects/browser/media/addProject.css';
import '../media/browserCookieImport.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { Checkbox, TriStateCheckbox } from '../../../../../base/browser/ui/toggle/toggle.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { defaultCheckboxStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { cookieSourceLabel, IVoltCookieImportResult, IVoltCookieSite, IVoltCookieSource, orderCookieSites } from '../../../../../platform/voltBrowser/common/browserCookies.js';
import { IVoltBrowserService } from '../../../../../platform/voltBrowser/common/voltBrowser.js';
import { showVoltModal } from '../../../voltProjects/browser/ui/voltModal.js';
import { createVoltButton } from '../chrome/voltButton.js';

export const IMPORT_BROWSER_COOKIES_COMMAND_ID = 'volt.browser.importCookies';

/** One line for a toast: "Imported 214 cookies for 31 sites from Arc". */
export function cookieImportSummary(source: IVoltCookieSource, result: IVoltCookieImportResult): string {
	if (!result.imported) {
		return result.warnings[0] ?? localize('voltCookies.none', "No cookies to import from {0}.", source.browserLabel);
	}
	const cookies = result.imported === 1 ? localize('voltCookies.oneCookie', "1 cookie") : localize('voltCookies.manyCookies', "{0} cookies", result.imported);
	const sites = result.sites === 1 ? localize('voltCookies.oneSite', "1 site") : localize('voltCookies.manySites', "{0} sites", result.sites);
	return localize('voltCookies.done', "Imported {0} for {1} from {2}.", cookies, sites, source.browserLabel);
}

export interface ICookieImportDialogOptions {
	/** Sites to list first and check (what an agent asked for). */
	readonly sites?: readonly string[];
	/** An agent asks (browser_import_cookies), not the user. */
	readonly askedByAgent?: boolean;
	/** The agent's reason, in its words. */
	readonly reason?: string;
	/** The preview browser profile to import into; default the in-app browser's. */
	readonly partition?: string;
	/** Offer "let agents import from this profile without asking". */
	readonly offerAlwaysAllow?: boolean;
	/** Start on this profile's sites when it is still there (the one used last). */
	readonly preferredSourceId?: string;
}

export interface ICookieImportOutcome {
	readonly source: IVoltCookieSource;
	/** The sites the user checked. */
	readonly sites: readonly string[];
	readonly result: IVoltCookieImportResult;
	/** The user let agents import from this profile without asking from now on. */
	readonly alwaysAllow: boolean;
}

export interface ICookieImportDialog extends IDisposable {
	/** The import the user made, or undefined when they closed the dialog without one. */
	readonly outcome: Promise<ICookieImportOutcome | undefined>;
}

const ROW_HEIGHT = 30;

//#region rows

interface ISourceTemplate {
	readonly label: HTMLElement;
	readonly detail: HTMLElement;
	readonly hint: HTMLElement;
}

class SourceRenderer implements IListRenderer<IVoltCookieSource, ISourceTemplate> {
	static readonly ID = 'source';
	readonly templateId = SourceRenderer.ID;

	renderTemplate(container: HTMLElement): ISourceTemplate {
		const row = append(container, $('.volt-cookie-import-row.source'));
		append(row, $('span.volt-cookie-import-icon')).appendChild(renderIcon(Codicon.globe));
		const label = append(row, $('span.volt-cookie-import-label'));
		const detail = append(row, $('span.volt-cookie-import-detail'));
		const hint = append(row, $('span.volt-cookie-import-hint'));
		append(row, $('span.volt-cookie-import-chevron')).appendChild(renderIcon(Codicon.chevronRight));
		return { label, detail, hint };
	}

	renderElement(source: IVoltCookieSource, _index: number, template: ISourceTemplate): void {
		template.label.textContent = source.browserLabel;
		template.detail.textContent = source.browser === 'safari' ? '' : (source.profileLabel || source.profile);
		template.hint.textContent = source.encrypted ? localize('voltCookies.keychainHint', "asks for keychain access") : '';
	}

	disposeTemplate(): void { }
}

interface ISiteTemplate {
	readonly checkbox: Checkbox;
	readonly label: HTMLElement;
	readonly count: HTMLElement;
	readonly store: DisposableStore;
	readonly ref: { current?: IVoltCookieSite };
}

class SiteRenderer implements IListRenderer<IVoltCookieSite, ISiteTemplate> {
	static readonly ID = 'site';
	readonly templateId = SiteRenderer.ID;

	/** Rows on screen, so a change made elsewhere (Select all, Enter on a row) shows at once. */
	private readonly templates = new Set<ISiteTemplate>();

	constructor(private readonly checked: Set<string>, private readonly toggle: (site: IVoltCookieSite, checked: boolean) => void) { }

	/** Shows `checked` on every row on screen (the list's own rerender only redraws rows of varying height). */
	sync(): void {
		for (const template of this.templates) {
			if (template.ref.current) {
				template.checkbox.checked = this.checked.has(template.ref.current.site);
			}
		}
	}

	renderTemplate(container: HTMLElement): ISiteTemplate {
		const store = new DisposableStore();
		const ref: ISiteTemplate['ref'] = {};
		const row = append(container, $('.volt-cookie-import-row.site'));
		const checkbox = store.add(new Checkbox('', false, defaultCheckboxStyles));
		append(row, $('span.volt-cookie-import-check')).appendChild(checkbox.domNode);
		// The checkbox toggles itself; the row's own click (onDidOpen) toggles too, so keep them apart.
		for (const type of [EventType.MOUSE_DOWN, EventType.CLICK, EventType.DBLCLICK]) {
			store.add(addDisposableListener(checkbox.domNode, type, e => e.stopPropagation()));
		}
		store.add(checkbox.onChange(() => ref.current && this.toggle(ref.current, checkbox.checked)));
		const label = append(row, $('span.volt-cookie-import-label'));
		const count = append(row, $('span.volt-cookie-import-hint'));
		const template = { checkbox, label, count, store, ref };
		this.templates.add(template);
		return template;
	}

	renderElement(site: IVoltCookieSite, _index: number, template: ISiteTemplate): void {
		template.ref.current = site;
		template.checkbox.checked = this.checked.has(site.site);
		template.checkbox.setTitle(site.site);
		template.label.textContent = site.site;
		template.count.textContent = site.cookies === 1 ? localize('voltCookies.rowOne', "1 cookie") : localize('voltCookies.rowMany', "{0} cookies", site.cookies);
	}

	disposeElement(_site: IVoltCookieSite, _index: number, template: ISiteTemplate): void {
		template.ref.current = undefined;
	}

	disposeTemplate(template: ISiteTemplate): void {
		this.templates.delete(template);
		template.store.dispose();
	}
}

const delegate = <T>(templateId: string): IListVirtualDelegate<T> => ({ getHeight: () => ROW_HEIGHT, getTemplateId: () => templateId });

/** Keeps a list laid out at its host's height, which the dialog's flex layout sets. */
function layoutWithHost<T>(host: HTMLElement, list: WorkbenchList<T>, store: DisposableStore): void {
	const window = getWindow(host);
	const layout = () => list.layout(host.clientHeight, host.clientWidth);
	const observer = new window.ResizeObserver(layout);
	observer.observe(host);
	store.add(toDisposable(() => observer.disconnect()));
	layout();
}

//#endregion

/**
 * The import flow, one dialog: "Import from" lists the browser profiles on this machine, then the
 * chosen profile's sites come as checkboxes (the ones an agent asked for first and checked), and
 * Import copies only those sites' cookies into the in-app browser. Listing sites reads host names
 * only, so the keychain is asked (once) only when the user imports from a Chromium browser.
 */
export function showCookieImportDialog(accessor: ServicesAccessor, options: ICookieImportDialogOptions = {}): ICookieImportDialog {
	const layoutService = accessor.get(ILayoutService);
	const instantiationService = accessor.get(IInstantiationService);
	const browserService = accessor.get(IVoltBrowserService);
	const outcome = new DeferredPromise<ICookieImportOutcome | undefined>();
	const requested = options.sites ?? [];
	const asked = !!options.askedByAgent;
	const title = asked
		? (requested.length
			? localize('voltCookies.askTitleSites', "Sign the browser in to {0}?", listSites(requested))
			: localize('voltCookies.askTitle', "Import sign-ins into the browser?"))
		: localize('voltCookies.title', "Import cookies");

	let modal: IDisposable | undefined = undefined;
	modal = showVoltModal(layoutService, {
		title,
		width: 520,
		height: 560,
		headless: true,
		className: 'volt-cookie-import',
		onDidClose: () => {
			outcome.complete(undefined);
			// Closed from inside (Import, Escape, the backdrop): the handle is spent too.
			modal?.dispose();
		},
		render: (body, close) => {
			const store = new DisposableStore();
			const head = append(body, $('.volt-cookie-import-head'));
			append(head, $('.mark')).appendChild(renderIcon(Codicon.key));
			const titles = append(head, $('.titles'));
			append(titles, $('h2')).textContent = title;
			const lead = append(titles, $('p.lead'));
			lead.textContent = asked
				? localize('voltCookies.askLead', "The agent needs a signed-in page. Copy your cookies for the sites you pick from another browser into Volt's browser, so they open signed in. The cookies stay on this computer and the agent never sees them.")
				: localize('voltCookies.lead', "Copy cookies from another browser into Volt's browser, so the sites you pick open signed in.");
			if (options.reason) {
				append(titles, $('p.reason')).textContent = options.reason;
			}

			const crumb = append(body, $('.volt-cookie-import-crumb'));
			const stage = append(body, $('.volt-cookie-import-stage'));
			const footer = append(body, $('.volt-add-footer.volt-cookie-import-footer'));
			const status = append(footer, $('span.volt-add-footer-hint'));
			const cancel = store.add(createVoltButton(footer));
			cancel.label = asked ? localize('voltCookies.deny', "Don't Import") : localize('voltCookies.cancel', "Cancel");
			store.add(cancel.onDidClick(() => close()));
			const importButton = store.add(createVoltButton(footer, 'primary'));
			importButton.label = localize('voltCookies.import', "Import");
			importButton.enabled = false;

			const step = store.add(new DisposableStore());
			/** Bumped on every step change, so a slow read or import that finishes late leaves the new step alone. */
			let generation = 0;
			let runImport: (() => Promise<void>) | undefined;
			store.add(importButton.onDidClick(() => void runImport?.()));

			const showSources = (sources: readonly IVoltCookieSource[]) => {
				generation++;
				step.clear();
				clearNode(stage);
				clearNode(crumb);
				runImport = undefined;
				importButton.enabled = false;
				// Picking a profile is the step: Import comes with its sites.
				importButton.element.classList.add('hidden');
				append(crumb, $('span.step')).textContent = localize('voltCookies.importFrom', "Import from");
				status.textContent = '';
				if (!sources.length) {
					append(stage, $('.volt-cookie-import-empty')).textContent = localize('voltCookies.noBrowsers', "No supported browsers found (Chrome, Safari, Arc, Firefox, Edge, Brave…)");
					return;
				}
				const host = append(stage, $('.volt-cookie-import-list'));
				const list = step.add(instantiationService.createInstance(WorkbenchList<IVoltCookieSource>, 'VoltCookieSources', host, delegate<IVoltCookieSource>(SourceRenderer.ID), [new SourceRenderer()], {
					multipleSelectionSupport: false,
					accessibilityProvider: {
						getAriaLabel: source => cookieSourceLabel(source),
						getWidgetAriaLabel: () => localize('voltCookies.sourcesAria', "Browser profiles"),
					},
				}));
				layoutWithHost(host, list, step);
				list.splice(0, 0, [...sources]);
				step.add(list.onDidOpen(e => e.element && void showSites(sources, e.element)));
				list.focusFirst();
				list.domFocus();
			};

			const showSites = async (sources: readonly IVoltCookieSource[], source: IVoltCookieSource) => {
				const mine = ++generation;
				step.clear();
				clearNode(stage);
				clearNode(crumb);
				runImport = undefined;
				importButton.enabled = false;
				importButton.element.classList.remove('hidden');
				const back = step.add(createVoltButton(crumb, 'ghost'));
				back.label = localize('voltCookies.back', "Import from");
				back.element.classList.add('back');
				back.element.prepend(renderIcon(Codicon.chevronLeft));
				step.add(back.onDidClick(() => showSources(sources)));
				append(crumb, $('span.sep')).textContent = '/';
				append(crumb, $('span.step')).textContent = cookieSourceLabel(source);
				status.textContent = localize('voltCookies.reading', "Reading sites…");
				const loading = append(stage, $('.volt-cookie-import-empty'));
				loading.textContent = localize('voltCookies.readingLong', "Reading the sites {0} has cookies for…", cookieSourceLabel(source));
				let sites: IVoltCookieSite[];
				try {
					sites = await browserService.listCookieSites(source.id);
				} catch (err) {
					if (mine === generation) {
						loading.textContent = err instanceof Error ? err.message : String(err);
						status.textContent = '';
					}
					return;
				}
				if (mine !== generation || store.isDisposed) {
					return;
				}
				loading.remove();
				const ordered = orderCookieSites(sites, requested);
				const checked = new Set(ordered.preselected);
				let shown: readonly IVoltCookieSite[] = ordered.sites;

				if (ordered.missing.length) {
					append(stage, $('.volt-cookie-import-missing')).textContent = localize('voltCookies.missing', "{0} has no cookies for {1}: sign in there first, or pick another profile.", cookieSourceLabel(source), listSites(ordered.missing));
				}
				if (!sites.length) {
					append(stage, $('.volt-cookie-import-empty')).textContent = localize('voltCookies.noSites', "This profile has no cookies to import.");
					status.textContent = '';
					return;
				}

				const tools = append(stage, $('.volt-cookie-import-tools'));
				const all = step.add(new TriStateCheckbox(localize('voltCookies.all', "Select all shown"), false, defaultCheckboxStyles));
				append(tools, $('span.volt-cookie-import-check')).appendChild(all.domNode);
				const search = step.add(new InputBox(append(tools, $('.volt-cookie-import-search')), undefined, {
					placeholder: localize('voltCookies.filter', "Filter {0} sites", sites.length),
					ariaLabel: localize('voltCookies.filterAria', "Filter sites"),
					tooltip: '',
					inputBoxStyles: defaultInputBoxStyles,
				}));

				const host = append(stage, $('.volt-cookie-import-list'));
				const update = () => {
					const shownChecked = shown.filter(entry => checked.has(entry.site)).length;
					all.checked = !shown.length || !shownChecked ? false : shownChecked === shown.length ? true : 'partial';
					importButton.enabled = checked.size > 0;
					const cookies = sites.filter(entry => checked.has(entry.site)).reduce((sum, entry) => sum + entry.cookies, 0);
					status.textContent = checked.size
						? localize('voltCookies.selected', "{0} of {1} sites · {2} cookies", checked.size, sites.length, cookies)
						: localize('voltCookies.pickSites', "Pick the sites to sign in to");
				};
				const renderer = new SiteRenderer(checked, (site, value) => {
					if (value) {
						checked.add(site.site);
					} else {
						checked.delete(site.site);
					}
					update();
				});
				const list = step.add(instantiationService.createInstance(WorkbenchList<IVoltCookieSite>, 'VoltCookieSites', host, delegate<IVoltCookieSite>(SiteRenderer.ID), [renderer], {
					multipleSelectionSupport: false,
					accessibilityProvider: {
						getAriaLabel: site => localize('voltCookies.siteAria', "{0}, {1} cookies, {2}", site.site, site.cookies, checked.has(site.site) ? localize('voltCookies.checked', "checked") : localize('voltCookies.unchecked', "not checked")),
						getWidgetAriaLabel: () => localize('voltCookies.sitesAria', "Sites to import"),
					},
				}));
				layoutWithHost(host, list, step);
				const render = () => list.splice(0, list.length, [...shown]);
				render();
				// Enter or a click on a row toggles it.
				step.add(list.onDidOpen(e => {
					if (!e.element) {
						return;
					}
					if (checked.has(e.element.site)) {
						checked.delete(e.element.site);
					} else {
						checked.add(e.element.site);
					}
					renderer.sync();
					update();
				}));
				step.add(all.onChange(() => {
					const value = all.checked === true;
					for (const entry of shown) {
						if (value) {
							checked.add(entry.site);
						} else {
							checked.delete(entry.site);
						}
					}
					renderer.sync();
					update();
				}));
				step.add(search.onDidChange(value => {
					const query = value.trim().toLowerCase();
					shown = query ? ordered.sites.filter(entry => entry.site.includes(query)) : ordered.sites;
					render();
					update();
				}));
				step.add(addDisposableListener(search.inputElement, EventType.KEY_DOWN, e => {
					if (e.key === 'ArrowDown' && shown.length) {
						e.preventDefault();
						list.focusFirst();
						list.domFocus();
					}
				}));

				let always: Checkbox | undefined;
				if (options.offerAlwaysAllow) {
					const row = append(stage, $('label.volt-cookie-import-always'));
					always = step.add(new Checkbox(localize('voltCookies.alwaysTitle', "Let agents import without asking"), false, defaultCheckboxStyles));
					append(row, $('span.volt-cookie-import-check')).appendChild(always.domNode);
					append(row, $('span')).textContent = localize('voltCookies.always', "Let agents import from {0} without asking", cookieSourceLabel(source));
					step.add(addDisposableListener(row, EventType.CLICK, e => {
						if (!always!.domNode.contains(e.target as Node)) {
							always!.checked = !always!.checked;
						}
					}));
				}

				update();
				if (ordered.preselected.size) {
					list.focusFirst();
					list.domFocus();
				} else {
					search.focus();
				}

				runImport = async () => {
					const picked = ordered.sites.filter(entry => checked.has(entry.site)).map(entry => entry.site);
					if (!picked.length) {
						return;
					}
					importButton.enabled = false;
					back.enabled = false;
					status.classList.remove('error');
					status.textContent = source.encrypted
						? localize('voltCookies.importingKeychain', "Importing… allow Volt if macOS asks for {0}'s key", source.browserLabel)
						: localize('voltCookies.importing', "Importing…");
					try {
						const result = await browserService.importCookies({ sourceId: source.id, domains: picked, partition: options.partition });
						outcome.complete({ source, sites: picked, result, alwaysAllow: always?.checked ?? false });
						close();
					} catch (err) {
						if (mine !== generation || store.isDisposed) {
							return;
						}
						status.classList.add('error');
						status.textContent = err instanceof Error ? err.message : String(err);
						importButton.enabled = true;
						back.enabled = true;
					}
				};
			};

			status.textContent = localize('voltCookies.finding', "Looking for browsers…");
			browserService.listCookieSources().then(sources => {
				if (store.isDisposed) {
					return;
				}
				const preferred = sources.find(source => source.id === options.preferredSourceId);
				if (preferred) {
					void showSites(sources, preferred);
				} else if (sources.length === 1) {
					void showSites(sources, sources[0]);
				} else {
					showSources(sources);
				}
			}, () => {
				if (!store.isDisposed) {
					status.textContent = localize('voltCookies.needsRestart', "Restart Volt to import cookies");
				}
			});
			return store;
		},
	});
	return { outcome: outcome.p, dispose: () => modal?.dispose() };
}

/** "github.com", "github.com and vercel.com", "github.com, vercel.com and 2 more". */
function listSites(sites: readonly string[]): string {
	if (sites.length === 1) {
		return sites[0];
	}
	if (sites.length === 2) {
		return localize('voltCookies.two', "{0} and {1}", sites[0], sites[1]);
	}
	return localize('voltCookies.more', "{0}, {1} and {2} more", sites[0], sites[1], sites.length - 2);
}

/** Opens the import dialog and says how it went in a toast (the browser's own, or a notification). */
export async function importCookiesInteractively(accessor: ServicesAccessor, toast?: (message: string) => void): Promise<void> {
	const notifications = accessor.get(INotificationService);
	const done = await showCookieImportDialog(accessor).outcome;
	if (!done) {
		return;
	}
	const summary = cookieImportSummary(done.source, done.result);
	if (toast) {
		toast(summary);
	} else {
		notifications.info(summary);
	}
	for (const warning of done.result.imported ? done.result.warnings : done.result.warnings.slice(1)) {
		notifications.warn(warning);
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: IMPORT_BROWSER_COOKIES_COMMAND_ID, visibility: 'internal', title: localize2('voltCookies.command', "Import Browser Cookies into Volt's Browser"), category: localize2('volt', "Volt"), f1: true });
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return importCookiesInteractively(accessor);
	}
});
