/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { cookieSourceLabel, IVoltCookieImportResult, IVoltCookieSource, parseDomainFilter } from '../../../../../platform/voltBrowser/common/browserCookies.js';
import { IVoltBrowserService } from '../../../../../platform/voltBrowser/common/voltBrowser.js';
import { AGENT_COOKIE_IMPORT_SETTING, AGENT_COOKIE_SOURCE_STORAGE_KEY, agentCookieImportMode } from '../../../../services/voltRuntime/common/browserAccess.js';
import { IVoltHostToolResult } from '../../../../services/voltRuntime/common/hostTools.js';
import { isSandboxed } from '../../../../services/voltRuntime/common/hostToolSandbox.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { cookieImportSummary, ICookieImportDialog, ICookieImportOutcome, showCookieImportDialog } from './browserCookieImport.js';

/**
 * How long one call waits for the user. Agents call MCP tools with a 60 s timeout (cursor-agent),
 * so a call that is still waiting returns before that and the agent calls again.
 */
const WAIT_MS = 45_000;
const MAX_SITES = 20;

interface IPendingAsk {
	readonly dialog: ICookieImportDialog;
	readonly done: Promise<ICookieImportOutcome | undefined>;
}

/** The dialog each chat has open, so a call that comes back to wait finds it instead of opening another. */
const pendingAsks = new Map<string, IPendingAsk>();

/** What the agent reads: counts and sites, never a cookie. */
export function describeAgentCookieImport(source: IVoltCookieSource, sites: readonly string[], result: IVoltCookieImportResult, withoutAsking: boolean): string {
	const lines = [
		withoutAsking
			? `Imported without asking (the user allowed agents to import from ${cookieSourceLabel(source)}).`
			: `The user imported their cookies from ${cookieSourceLabel(source)}.`,
		`- Sites: ${sites.join(', ')}`,
		`- Cookies imported: ${result.imported}${result.skipped ? ` (${result.skipped} skipped: expired or outside these sites)` : ''}${result.failed ? `, ${result.failed} could not be read or set` : ''}`,
		...result.warnings.map(warning => `- Note: ${warning}`),
		result.imported
			? 'The in-app browser has them now: reload the page (browser_reload) or open it again to load it signed in.'
			: 'Nothing was imported, so the browser is still signed out of these sites. Ask the user to sign in in the browser tab themselves if you still need it.',
	];
	return lines.join('\n');
}

/**
 * `browser_import_cookies`: an agent asks for the user's sign-ins. Depending on
 * `volt.browser.agentCookieImport` the user gets the import dialog with the asked sites checked,
 * the import runs from the profile they allowed, or the call is refused. The agent learns only
 * counts and sites.
 */
export async function importCookiesForAgent(accessor: ServicesAccessor, sessionId: string, args: Record<string, unknown>, token: CancellationToken): Promise<IVoltHostToolResult> {
	const configurationService = accessor.get(IConfigurationService);
	const storageService = accessor.get(IStorageService);
	const notificationService = accessor.get(INotificationService);
	const instantiationService = accessor.get(IInstantiationService);
	let browser: IVoltBrowserService;
	try {
		browser = accessor.get(IVoltBrowserService);
	} catch {
		return { error: 'Importing cookies needs the Volt desktop app; this window has no access to other browsers.' };
	}
	let sandboxed = false;
	try {
		const runtime = accessor.get(IAgentRuntimeService);
		sandboxed = isSandboxed(runtime.getSandboxSettings(runtime.chatFor(sessionId)));
	} catch {
		// no runtime in this window: the user's own browser profile
	}
	if (sandboxed) {
		return { error: 'browser_import_cookies is not available here: this chat runs in Volt\'s sandbox, whose browser is signed out on purpose. Work with signed-out pages, or ask the user to run this in a chat without the sandbox.' };
	}

	const mode = agentCookieImportMode(configurationService.getValue(AGENT_COOKIE_IMPORT_SETTING));
	if (mode === 'off') {
		return { error: 'The user turned off cookie import requests from agents (volt.browser.agentCookieImport is off). Ask them to sign in in the browser tab themselves.' };
	}
	const sites = parseDomainFilter(Array.isArray(args.sites) ? args.sites.filter((site): site is string => typeof site === 'string') : typeof args.sites === 'string' ? args.sites : []).slice(0, MAX_SITES);
	if (!sites.length) {
		return { error: 'browser_import_cookies needs `sites`: the sites to sign in to, e.g. ["github.com"].' };
	}
	const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 300) : undefined;
	const allowedSource = storageService.get(AGENT_COOKIE_SOURCE_STORAGE_KEY, StorageScope.APPLICATION);

	if (mode === 'allow' && allowedSource) {
		const source = (await browser.listCookieSources().catch(() => [] as IVoltCookieSource[])).find(candidate => candidate.id === allowedSource);
		if (source) {
			try {
				const result = await browser.importCookies({ sourceId: source.id, domains: sites });
				notificationService.info(localize('voltCookies.agentImported', "An agent imported cookies for {0}: {1}", sites.join(', '), cookieImportSummary(source, result)));
				return { text: describeAgentCookieImport(source, sites, result, true) };
			} catch (err) {
				return { error: `The import from ${cookieSourceLabel(source)} failed: ${err instanceof Error ? err.message : String(err)}` };
			}
		}
		// The allowed profile is gone: ask instead.
	}

	let pending = pendingAsks.get(sessionId);
	if (!pending) {
		const dialog = instantiationService.invokeFunction(dialogAccessor => showCookieImportDialog(dialogAccessor, { sites, reason, askedByAgent: true, offerAlwaysAllow: true, preferredSourceId: allowedSource }));
		const entry: IPendingAsk = {
			dialog,
			done: dialog.outcome.then(outcome => {
				if (pendingAsks.get(sessionId) === entry) {
					pendingAsks.delete(sessionId);
				}
				if (outcome?.alwaysAllow) {
					storageService.store(AGENT_COOKIE_SOURCE_STORAGE_KEY, outcome.source.id, StorageScope.APPLICATION, StorageTarget.MACHINE);
					void configurationService.updateValue(AGENT_COOKIE_IMPORT_SETTING, 'allow');
				}
				return outcome;
			}),
		};
		pending = entry;
		pendingAsks.set(sessionId, entry);
	}

	const cancelled = new Promise<'cancelled'>(resolve => {
		const listener = token.onCancellationRequested(() => {
			listener.dispose();
			resolve('cancelled');
		});
		if (token.isCancellationRequested) {
			resolve('cancelled');
		}
	});
	const wait = timeout(WAIT_MS);
	const waited = await Promise.race([pending.done, wait.then(() => 'waiting' as const, () => 'waiting' as const), cancelled]).finally(() => wait.cancel());
	if (waited === 'cancelled') {
		// The turn stopped: nobody is left to read the answer.
		pending.dialog.dispose();
		return { error: 'Cancelled.' };
	}
	if (waited === 'waiting') {
		return { text: 'The import dialog is still open for the user. Call browser_import_cookies again with the same arguments to keep waiting for their answer (it waits on the same dialog, it does not open another). Do not sign in another way meanwhile.' };
	}
	if (!waited) {
		return { text: 'The user closed the import dialog without importing. Do not ask again this turn; continue signed out, or ask the user to sign in in the browser tab themselves.' };
	}
	return { text: describeAgentCookieImport(waited.source, waited.sites, waited.result, false) };
}
