/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IVoltCookieImportResult, IVoltCookieSource, parseDomainFilter } from '../../../../../platform/voltBrowser/common/browserCookies.js';
import { IVoltBrowserService } from '../../../../../platform/voltBrowser/common/voltBrowser.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';

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

function profileName(source: IVoltCookieSource): string {
	return source.profileLabel === source.profile || !source.profileLabel ? source.profile : source.profileLabel;
}

function domainPrompt(): string {
	return localize('voltCookies.domains', "Only these sites, e.g. github.com, vercel.app (Enter for all)");
}

/**
 * Picks a browser profile and, optionally, the sites to bring over, then imports into the
 * preview browser. `onDone` gets the summary for the browser's toast.
 */
export async function showCookieImportMenu(contextViewService: IContextViewService, anchor: HTMLElement, browserService: IVoltBrowserService, onDone: (message: string) => void): Promise<void> {
	let sources: IVoltCookieSource[];
	try {
		sources = await browserService.listCookieSources();
	} catch {
		onDone(localize('voltCookies.needsRestart', "Restart Volt to import cookies"));
		return;
	}
	const byBrowser = new Map<string, IVoltCookieSource[]>();
	for (const source of sources) {
		byBrowser.set(source.browserLabel, [...byBrowser.get(source.browserLabel) ?? [], source]);
	}
	const sections: IVoltMenuSection<IVoltCookieSource>[] = [...byBrowser].map(([browser, profiles]) => ({
		id: browser,
		title: browser,
		items: profiles.map((source): IVoltMenuItem<IVoltCookieSource> => ({
			id: source.id,
			label: profileName(source),
			description: source.encrypted ? localize('voltCookies.keychainHint', "asks for keychain access") : undefined,
			icon: Codicon.account,
			keywords: `${browser} ${source.profile}`,
			data: source,
			prompt: {
				placeholder: domainPrompt(),
				hint: localize('voltCookies.hint', "Enter to import from {0} ({1})", browser, profileName(source)),
				validate: value => value.trim() && !parseDomainFilter(value).length ? localize('voltCookies.badDomains', "Enter site names like example.com") : undefined,
				onSubmit: async value => {
					const result = await browserService.importCookies({ sourceId: source.id, domains: parseDomainFilter(value) });
					onDone(cookieImportSummary(source, result));
				},
			},
		})),
	}));
	showVoltMenu(contextViewService, {
		anchor,
		position: 'below',
		align: 'right',
		gap: 4,
		width: 320,
		search: { placeholder: localize('voltCookies.search', "Import cookies from…") },
		sections,
		emptyMessage: localize('voltCookies.noBrowsers', "No supported browsers found (Chrome, Safari, Arc, Firefox, Edge, Brave…)"),
		className: 'volt-cookie-import-menu',
		ariaLabel: localize('voltCookies.menu', "Import cookies"),
		onPick: () => undefined,
	});
}

interface ISourcePick extends IQuickPickItem {
	readonly source: IVoltCookieSource;
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: IMPORT_BROWSER_COOKIES_COMMAND_ID, title: localize2('voltCookies.command', "Import Browser Cookies into Preview Browser…"), category: localize2('volt', "Volt"), f1: true });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const browserService = accessor.get(IVoltBrowserService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const items = browserService.listCookieSources().then(sources => {
			const picks: (ISourcePick | IQuickPickSeparator)[] = [];
			let browser = '';
			for (const source of sources) {
				if (source.browserLabel !== browser) {
					browser = source.browserLabel;
					picks.push({ type: 'separator', label: browser });
				}
				picks.push({ label: profileName(source), description: source.browserLabel, detail: source.path, source });
			}
			return picks;
		});
		const picked = await quickInput.pick(items, { placeHolder: localize('voltCookies.pick', "Browser profile to import cookies from"), matchOnDescription: true });
		if (!picked) {
			return;
		}
		const domains = await quickInput.input({ placeHolder: domainPrompt(), prompt: localize('voltCookies.prompt', "Leave empty to import every cookie.") });
		if (domains === undefined) {
			return;
		}
		try {
			const result = await browserService.importCookies({ sourceId: picked.source.id, domains: parseDomainFilter(domains) });
			notifications.info(cookieImportSummary(picked.source, result));
			for (const warning of result.warnings) {
				notifications.warn(warning);
			}
		} catch (err) {
			notifications.error(err instanceof Error ? err.message : String(err));
		}
	}
});
