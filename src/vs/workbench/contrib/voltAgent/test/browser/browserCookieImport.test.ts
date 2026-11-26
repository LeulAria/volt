/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IVoltCookieImportRequest, IVoltCookieImportResult, IVoltCookieSite, IVoltCookieSource } from '../../../../../platform/voltBrowser/common/browserCookies.js';
import { IVoltBrowserService } from '../../../../../platform/voltBrowser/common/voltBrowser.js';
import { AGENT_COOKIE_IMPORT_SETTING, AGENT_COOKIE_SOURCE_STORAGE_KEY } from '../../../../services/voltRuntime/common/browserAccess.js';
import { IVoltHostToolResult } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { ITestInstantiationService, workbenchInstantiationService, workbenchTeardown } from '../../../../test/browser/workbenchTestServices.js';
import { describeAgentCookieImport, importCookiesForAgent } from '../../browser/preview/browserCookieAgent.js';

const CHROME: IVoltCookieSource = { id: 'chrome:Default', browser: 'chrome', browserLabel: 'Google Chrome', profile: 'Default', profileLabel: 'Personal', path: '/x/Cookies', encrypted: true };
const FIREFOX: IVoltCookieSource = { id: 'firefox:abc', browser: 'firefox', browserLabel: 'Firefox', profile: 'abc', profileLabel: 'default', path: '/x/cookies.sqlite', encrypted: false };
const SITES: IVoltCookieSite[] = [{ site: 'google.com', cookies: 40 }, { site: 'github.com', cookies: 9 }, { site: 'vercel.com', cookies: 3 }];

/** Waits for a DOM condition the dialog reaches asynchronously. */
async function until<T>(read: () => T | undefined | null | false, what: string): Promise<T> {
	for (let i = 0; i < 200; i++) {
		const value = read();
		if (value) {
			return value;
		}
		await timeout(10);
	}
	throw new Error(`timed out waiting for ${what}`);
}

suite('Volt browser: cookie import for agents', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let disposables: DisposableStore;
	let instantiation: ITestInstantiationService;
	let container: HTMLElement;
	let configuration: TestConfigurationService;
	let imports: IVoltCookieImportRequest[];
	let sandboxed: boolean;

	setup(() => {
		disposables = store.add(new DisposableStore());
		instantiation = workbenchInstantiationService(undefined, disposables);
		container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		container.style.cssText = 'position: fixed; inset: 0; width: 800px; height: 700px;';
		instantiation.stub(ILayoutService, { activeContainer: container, mainContainer: container } as Partial<ILayoutService>);
		// Writes land in the user configuration, like the real service's.
		configuration = new class extends TestConfigurationService {
			override updateValue(key: string, value: unknown): Promise<void> {
				return this.setUserConfiguration(key, value);
			}
		}();
		instantiation.stub(IConfigurationService, configuration);
		imports = [];
		sandboxed = false;
		instantiation.stub(IAgentRuntimeService, {
			chatFor: (id: string) => id,
			getSandboxSettings: () => (sandboxed ? { level: 'workspace-write', network: false } : { level: 'off' }) as unknown as ReturnType<IAgentRuntimeService['getSandboxSettings']>,
		} as Partial<IAgentRuntimeService>);
		instantiation.stub(IVoltBrowserService, {
			listCookieSources: async () => [CHROME, FIREFOX],
			listCookieSites: async (id: string) => id === CHROME.id ? SITES : [],
			importCookies: async (request: IVoltCookieImportRequest): Promise<IVoltCookieImportResult> => {
				imports.push(request);
				return { imported: 12, skipped: 3, failed: 0, sites: request.domains?.length ?? 0, warnings: [] };
			},
		} as Partial<IVoltBrowserService>);
	});

	teardown(async () => {
		container.remove();
		mainWindow.document.querySelectorAll('.volt-cookie-import, .volt-modal-backdrop').forEach(element => element.remove());
		await workbenchTeardown(instantiation);
	});

	function call(args: Record<string, unknown>, token = CancellationToken.None): Promise<IVoltHostToolResult> {
		return instantiation.invokeFunction(accessor => importCookiesForAgent(accessor, 'chat-1', args, token));
	}

	const dialog = () => container.querySelector<HTMLElement>('.volt-cookie-import');
	const button = (label: string) => [...dialog()?.querySelectorAll<HTMLElement>('.volt-cookie-import-footer .monaco-button') ?? []].find(element => element.textContent === label);
	const siteRows = () => [...dialog()?.querySelectorAll<HTMLElement>('.volt-cookie-import-row.site') ?? []];
	const checkedSites = () => siteRows().filter(row => row.querySelector('.monaco-checkbox')?.classList.contains('checked')).map(row => row.querySelector('.volt-cookie-import-label')!.textContent);

	test('the user picks a browser, gets the asked sites checked first, and imports only those', async () => {
		const pending = call({ sites: ['app.vercel.com', 'linear.app'], reason: 'To read the deploy logs' });
		// Step 1: the browsers on this machine.
		const sources = await until(() => dialog()?.querySelectorAll('.volt-cookie-import-row.source').length === 2 && dialog(), 'the browser list');
		assert.match(sources.textContent ?? '', /Sign the browser in to app\.vercel\.com and linear\.app\?/);
		assert.match(sources.textContent ?? '', /To read the deploy logs/);
		assert.match(sources.textContent ?? '', /asks for keychain access/);
		sources.querySelector<HTMLElement>('.volt-cookie-import-row.source')!.closest<HTMLElement>('.monaco-list-row')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		// Step 2: Chrome's sites, the asked one first and checked; the one Chrome lacks is named.
		await until(() => siteRows().length === 3, 'the site list');
		assert.deepStrictEqual(siteRows().map(row => row.querySelector('.volt-cookie-import-label')!.textContent), ['vercel.com', 'google.com', 'github.com']);
		assert.deepStrictEqual(checkedSites(), ['vercel.com']);
		assert.match(dialog()!.querySelector('.volt-cookie-import-missing')!.textContent ?? '', /no cookies for linear\.app/);
		assert.match(dialog()!.textContent ?? '', /1 of 3 sites · 3 cookies/);
		// The user adds github.com.
		siteRows()[2].querySelector<HTMLElement>('.monaco-checkbox')!.click();
		assert.deepStrictEqual(checkedSites(), ['vercel.com', 'github.com']);
		button('Import')!.click();

		const result = await pending;
		assert.deepStrictEqual(imports, [{ sourceId: CHROME.id, domains: ['vercel.com', 'github.com'], partition: undefined }]);
		assert.ok(!result.error);
		assert.match(result.text!, /The user imported their cookies from Google Chrome · Personal\./);
		assert.match(result.text!, /Sites: vercel\.com, github\.com/);
		assert.match(result.text!, /Cookies imported: 12/);
		assert.ok(!dialog(), 'the dialog closed');
		// Nothing was allowed for later.
		assert.strictEqual(configuration.getValue(AGENT_COOKIE_IMPORT_SETTING), undefined);
	});

	test('"without asking" remembers the profile, and the next ask imports at once from it', async () => {
		const storage = instantiation.invokeFunction(accessor => accessor.get(IStorageService));
		const pending = call({ sites: ['github.com'] });
		await until(() => dialog()?.querySelectorAll('.volt-cookie-import-row.source').length === 2, 'the browser list');
		dialog()!.querySelector<HTMLElement>('.volt-cookie-import-row.source')!.closest<HTMLElement>('.monaco-list-row')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const always = await until(() => dialog()?.querySelector<HTMLElement>('.volt-cookie-import-always'), 'the allow box');
		assert.match(always.textContent ?? '', /Let agents import from Google Chrome · Personal without asking/);
		always.querySelector<HTMLElement>('.monaco-checkbox')!.click();
		button('Import')!.click();
		await pending;
		assert.strictEqual(storage.get(AGENT_COOKIE_SOURCE_STORAGE_KEY, StorageScope.APPLICATION), CHROME.id);
		assert.strictEqual(configuration.getValue(AGENT_COOKIE_IMPORT_SETTING), 'allow');

		const next = await call({ sites: ['vercel.com'] });
		assert.ok(!dialog(), 'no dialog');
		assert.match(next.text!, /Imported without asking/);
		assert.deepStrictEqual(imports.at(-1), { sourceId: CHROME.id, domains: ['vercel.com'] });
	});

	test('with an allowed profile still in the setting\'s ask mode, the dialog starts on its sites', async () => {
		instantiation.invokeFunction(accessor => accessor.get(IStorageService)).store(AGENT_COOKIE_SOURCE_STORAGE_KEY, CHROME.id, StorageScope.APPLICATION, StorageTarget.MACHINE);
		const pending = call({ sites: ['github.com'] });
		await until(() => siteRows().length === 3, 'the site list');
		assert.deepStrictEqual(checkedSites(), ['github.com']);
		button("Don't Import")!.click();
		const result = await pending;
		assert.match(result.text!, /closed the import dialog without importing/);
		assert.deepStrictEqual(imports, []);
	});

	test('a click on a row and Select all show their checks at once; the filter narrows Select all', async () => {
		instantiation.invokeFunction(accessor => accessor.get(IStorageService)).store(AGENT_COOKIE_SOURCE_STORAGE_KEY, CHROME.id, StorageScope.APPLICATION, StorageTarget.MACHINE);
		const pending = call({ sites: ['github.com'] });
		await until(() => siteRows().length === 3, 'the site list');
		const all = dialog()!.querySelector<HTMLElement>('.volt-cookie-import-tools .monaco-checkbox')!;
		assert.ok(all.classList.contains('codicon-dash'), 'one of three checked: partial');
		// A click on the row, not its box.
		siteRows()[1].closest<HTMLElement>('.monaco-list-row')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		assert.deepStrictEqual(checkedSites(), ['github.com', 'google.com']);
		all.click();
		assert.deepStrictEqual(checkedSites(), ['github.com', 'google.com', 'vercel.com']);
		assert.match(dialog()!.textContent ?? '', /3 of 3 sites · 52 cookies/);
		all.click();
		assert.deepStrictEqual(checkedSites(), []);
		assert.strictEqual(button('Import')!.classList.contains('disabled'), true, 'nothing to import');
		// Filtered: Select all takes only the sites shown.
		const filter = dialog()!.querySelector<HTMLInputElement>('.volt-cookie-import-search input')!;
		filter.value = 'verc';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		await until(() => siteRows().length === 1, 'the filtered list');
		all.click();
		filter.value = '';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		await until(() => siteRows().length === 3, 'the whole list');
		assert.deepStrictEqual(checkedSites(), ['vercel.com']);
		button('Import')!.click();
		await pending;
		assert.deepStrictEqual(imports.at(-1)?.domains, ['vercel.com']);
	});

	test('off, sandboxed or without sites: refused, and no dialog opens', async () => {
		configuration.setUserConfiguration(AGENT_COOKIE_IMPORT_SETTING, 'off');
		assert.match((await call({ sites: ['github.com'] })).error!, /turned off cookie import/);
		configuration.setUserConfiguration(AGENT_COOKIE_IMPORT_SETTING, 'ask');
		assert.match((await call({ sites: [] })).error!, /needs `sites`/);
		sandboxed = true;
		assert.match((await call({ sites: ['github.com'] })).error!, /sandbox/);
		assert.ok(!dialog());
		assert.deepStrictEqual(imports, []);
	});

	test('a cancelled turn closes the dialog it opened', async () => {
		const source = new CancellationTokenSource();
		const pending = call({ sites: ['github.com'] }, source.token);
		await until(() => dialog(), 'the dialog');
		source.cancel();
		assert.strictEqual((await pending).error, 'Cancelled.');
		assert.ok(!dialog());
		source.dispose();
	});

	test('what the agent reads has counts and sites, never a cookie', () => {
		const text = describeAgentCookieImport(CHROME, ['github.com'], { imported: 0, skipped: 2, failed: 1, sites: 0, warnings: ['app-bound'] }, false);
		assert.match(text, /Cookies imported: 0 \(2 skipped: expired or outside these sites\), 1 could not be read or set/);
		assert.match(text, /Note: app-bound/);
		assert.match(text, /still signed out/);
	});
});
