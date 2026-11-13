/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt P5 (spec I.10, B-37, G.12), WEB-5: `vscode.env.openExternal` to a custom scheme asks, with
// the full URL, within a per-extension budget; a sandboxed extension's link to an ungranted host
// asks too; first party never asks.

import assert from 'assert';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { IConfirmation, IConfirmationResult, IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { IOpenerService, OpenOptions } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { VOLT_SANDBOXED_EXTENSIONS_SETTING } from '../../../contrib/webview/common/voltWebviewOwnership.js';
import { IExtensionService, nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IUserActivityService } from '../../../services/userActivity/common/userActivityService.js';
import { ExternalOpenPromptBudget, externalOpenDecision, externalUriDecision, IExternalOpenCaller } from '../../../services/voltPlugins/common/externalOpenGate.js';
import { MainThreadWindow } from '../../browser/mainThreadWindow.js';
import { TestRPCProtocol } from '../common/testRPCProtocol.js';

const thirdParty: IExternalOpenCaller = { extensionId: 'pub.mine', builtin: false, sandboxed: false, grantedHosts: [] };
const sandboxed: IExternalOpenCaller = { extensionId: 'pub.box', builtin: false, sandboxed: true, grantedHosts: ['api.example.com'] };
const builtin: IExternalOpenCaller = { extensionId: 'vscode.git', builtin: true, sandboxed: false, grantedHosts: [] };

function description(id: string, options: { builtin?: boolean; contributes?: object } = {}): IExtensionDescription {
	const [publisher, name] = id.split('.');
	return { ...nullExtensionDescription, identifier: new ExtensionIdentifier(id), publisher, name, displayName: `${name} \u202Eexe.`, isBuiltin: !!options.builtin, contributes: options.contributes };
}

suite('Volt: openExternal gate (WEB-5)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('WEB-5: a custom scheme asks; web links, Volt\'s own scheme and first party do not', () => {
		assert.deepStrictEqual(externalOpenDecision('zoommtg://zoom.us/join?confno=1', thirdParty, 'volt'), { kind: 'confirm', reason: 'scheme' });
		assert.deepStrictEqual(externalOpenDecision('file:///Applications/Calculator.app', thirdParty, 'volt'), { kind: 'confirm', reason: 'scheme' });
		assert.deepStrictEqual(externalOpenDecision('mailto:a@example.com', thirdParty, 'volt'), { kind: 'confirm', reason: 'scheme' });
		assert.deepStrictEqual(externalOpenDecision('no scheme at all', thirdParty, 'volt'), { kind: 'confirm', reason: 'scheme' });
		assert.deepStrictEqual(externalOpenDecision('https://example.com/', thirdParty, 'volt'), { kind: 'allow' });
		assert.deepStrictEqual(externalOpenDecision('volt://pub.mine/callback', thirdParty, 'volt'), { kind: 'allow' });
		assert.deepStrictEqual(externalOpenDecision('zoommtg://zoom.us/', builtin, 'volt'), { kind: 'allow' });
	});

	test('WEB-5: a sandboxed extension asks for hosts it was not granted, for opening and resolving', () => {
		assert.deepStrictEqual(externalOpenDecision('https://api.example.com/login', sandboxed, 'volt'), { kind: 'allow' });
		assert.deepStrictEqual(externalOpenDecision('https://exfil.example/?d=1', sandboxed, 'volt'), { kind: 'confirm', reason: 'host' });
		assert.deepStrictEqual(externalUriDecision('http://localhost:8080/', sandboxed), { kind: 'confirm', reason: 'host' });
		assert.deepStrictEqual(externalUriDecision('http://localhost:8080/', thirdParty), { kind: 'allow' });
		assert.deepStrictEqual(externalUriDecision('volt://pub.box/cb', sandboxed), { kind: 'allow' });
	});

	test('G.12 budget: one prompt a minute, three a day, two refusals stop the asking; concurrent asks share one prompt', async () => {
		let now = 0;
		const budget = new ExternalOpenPromptBudget(() => now);
		let prompts = 0;
		const answer = (value: boolean) => async () => { prompts++; return value; };

		assert.deepStrictEqual(await budget.ask('a', 'x:1', answer(true)), { allowed: true, asked: true });
		assert.deepStrictEqual(await budget.ask('a', 'x:2', answer(true)), { allowed: false, asked: false, reason: 'asked less than a minute ago' });
		now += 61_000;
		assert.strictEqual((await budget.ask('a', 'x:3', answer(true))).allowed, true);
		now += 61_000;
		assert.strictEqual((await budget.ask('a', 'x:4', answer(true))).allowed, true);
		now += 61_000;
		assert.deepStrictEqual(await budget.ask('a', 'x:5', answer(true)), { allowed: false, asked: false, reason: 'asked three times today' });
		now += 24 * 3_600_000;
		assert.strictEqual((await budget.ask('a', 'x:6', answer(true))).allowed, true);
		assert.strictEqual(prompts, 4);

		// Refusals.
		await budget.ask('b', 'x:1', answer(false));
		now += 61_000;
		await budget.ask('b', 'x:2', answer(false));
		now += 61_000;
		assert.deepStrictEqual(await budget.ask('b', 'x:3', answer(true)), { allowed: false, asked: false, reason: 'refused twice already' });

		// The same link asked twice at once: one dialog.
		let release!: (value: boolean) => void;
		const pending = new Promise<boolean>(resolve => release = resolve);
		const first = budget.ask('c', 'x:1', () => { prompts++; return pending; });
		const second = budget.ask('c', 'x:1', answer(false));
		release(true);
		assert.deepStrictEqual(await Promise.all([first, second]), [{ allowed: true, asked: true }, { allowed: true, asked: false }]);
	});

	function windowFor(hosted: IExtensionDescription[], confirm: boolean, options: { sandboxed?: string[] } = {}) {
		const rpc = store.add(new TestRPCProtocol());
		rpc.hostsExtension = id => hosted.some(own => ExtensionIdentifier.equals(own.identifier, typeof id === 'string' ? id : id.value));
		const config = new TestConfigurationService();
		config.setUserConfiguration(VOLT_SANDBOXED_EXTENSIONS_SETTING, options.sandboxed ?? []);
		const asked: IConfirmation[] = [];
		const opened: { target: string; options: OpenOptions | undefined }[] = [];
		const window = new MainThreadWindow(
			rpc,
			new class extends mock<IHostService>() {
				override readonly onDidChangeFocus = Event.None;
				override readonly onDidChangeActiveWindow = Event.None;
			},
			new class extends mock<IOpenerService>() {
				override async open(target: URI | string, openOptions?: OpenOptions) {
					opened.push({ target: target.toString(), options: openOptions });
					return true;
				}
				override async resolveExternalUri(resource: URI) {
					return { resolved: resource.with({ authority: 'tunnelled:1' }), dispose() { } };
				}
			},
			new class extends mock<IUserActivityService>() {
				override readonly onDidChangeIsActive = Event.None;
			},
			new class extends mock<IDialogService>() {
				override async confirm(confirmation: IConfirmation): Promise<IConfirmationResult> {
					asked.push(confirmation);
					return { confirmed: confirm };
				}
			},
			new class extends mock<IExtensionService>() {
				override readonly extensions = hosted;
			},
			config,
			new class extends mock<IProductService>() {
				override readonly urlProtocol = 'volt';
			},
			new NullLogService(),
		);
		store.add(window);
		return { window, asked, opened };
	}

	test('WEB-5: openExternal to a custom scheme shows Volt\'s confirm with the full URL; refused, nothing opens', async () => {
		// A unique id per test: the budget is per extension and lives as long as the window.
		const ext = description('pub.webfivecustom');
		const { window, asked, opened } = windowFor([ext], false);
		const url = 'zoommtg://zoom.us/join?confno=123&pwd=secret';
		assert.strictEqual(await window.$openUri(URI.parse(url), url, { extensionId: 'pub.webfivecustom' }), false);
		assert.deepStrictEqual(opened, []);
		assert.strictEqual(asked.length, 1);
		assert.ok(asked[0].detail?.includes(url), 'the full URL is shown');
		assert.ok(asked[0].message.toString().includes('pub.webfivecustom') && asked[0].message.toString().includes('zoommtg'));
		assert.ok(!asked[0].message.toString().includes('\u202E'), 'the extension\'s name is stripped of bidi characters');
	});

	test('WEB-5: confirmed, it opens once, without a second prompt from link protection', async () => {
		const ext = description('pub.webfiveconfirmed');
		const { window, asked, opened } = windowFor([ext], true);
		const url = 'ssh://host.example/';
		assert.strictEqual(await window.$openUri(URI.parse(url), url, { extensionId: 'pub.webfiveconfirmed' }), true);
		assert.strictEqual(asked.length, 1);
		assert.deepStrictEqual(opened.map(entry => [entry.target, entry.options?.skipValidation, entry.options?.fromExtension]), [[url, true, true]]);
	});

	test('WEB-5: web links open as before; first party never asks; a payload naming another host\'s extension counts as unknown', async () => {
		const ext = description('pub.webfiveweb');
		const git = description('vscode.git', { builtin: true });
		const { window, asked, opened } = windowFor([ext, git], false);
		assert.strictEqual(await window.$openUri(URI.parse('https://example.com/'), 'https://example.com/', { extensionId: 'pub.webfiveweb' }), true);
		assert.strictEqual(await window.$openUri(URI.parse('vscode-insiders://x/'), undefined, { extensionId: 'vscode.git' }), true);
		assert.strictEqual(asked.length, 0);
		// Not running in this host: no built-in pass, so a custom scheme asks.
		assert.strictEqual(await window.$openUri(URI.parse('zoommtg://x/'), undefined, { extensionId: 'vscode.github-authentication' }), false);
		assert.strictEqual(asked.length, 1);
		assert.ok(asked[0].message.toString().startsWith('An extension'));
		assert.strictEqual(opened.length, 2);
	});

	test('WEB-5: a sandboxed extension\'s link to an ungranted host asks, and an unresolved asExternalUri comes back unchanged', async () => {
		const box = description('pub.webfivebox', { contributes: { voltCapabilities: { required: [{ id: 'net.connect', class: 'low', targets: ['api.example.com'] }] } } });
		const { window, asked, opened } = windowFor([box], false, { sandboxed: ['pub.webfivebox'] });
		assert.strictEqual(await window.$openUri(URI.parse('https://api.example.com/login'), undefined, { extensionId: 'pub.webfivebox' }), true);
		assert.strictEqual(asked.length, 0);
		assert.strictEqual(await window.$openUri(URI.parse('https://exfil.example/?d=1'), undefined, { extensionId: 'pub.webfivebox' }), false);
		assert.strictEqual(asked.length, 1);
		assert.strictEqual(opened.length, 1);
		// The budget already spent this minute: no dialog, unresolved.
		const resolved = URI.revive(await window.$asExternalUri(URI.parse('http://localhost:8080/'), { allowTunneling: true, extensionId: 'pub.webfivebox' }));
		assert.strictEqual(resolved.authority, 'localhost:8080');
		assert.strictEqual(asked.length, 1);
	});
});
