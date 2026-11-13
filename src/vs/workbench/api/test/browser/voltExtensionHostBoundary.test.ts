/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt P0-3 (spec B-08, B-09, I.14): what an extension host may name and run.
// XPL-CMD-1..3: internal Volt commands refuse extension callers; public built-ins still run.
// IPC-3: a payload's extension id that is not running in the calling host is denied.

import assert from 'assert';
import { transformErrorForSerialization } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CommandNotAllowedError, CommandsRegistry, CommandVisibility, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionStorageService } from '../../../../platform/extensionManagement/common/extensionStorage.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService, ServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService, NullLogService } from '../../../../platform/log/common/log.js';
import { InMemoryStorageService, IStorageService } from '../../../../platform/storage/common/storage.js';
import { TestSecretStorageService } from '../../../../platform/secrets/test/common/testSecretStorageService.js';
import { VOLT_ALLOW_NETWORK_COMMAND_ID } from '../../../../platform/voltAgentServer/common/agentServerService.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../services/environment/browser/environmentService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ExtensionNotInHostError } from '../../../services/extensions/common/extHostCustomers.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { AUTOMATE_BROWSER_COMMAND_ID } from '../../../services/voltRuntime/common/hostTools.js';
import { IWebviewWorkbenchService } from '../../../contrib/webviewPanel/browser/webviewWorkbenchService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../platform/telemetry/common/telemetryUtils.js';
import { IURLService } from '../../../../platform/url/common/url.js';
import { IAuthenticationAccessService } from '../../../services/authentication/browser/authenticationAccessService.js';
import { IAuthenticationUsageService } from '../../../services/authentication/browser/authenticationUsageService.js';
import { IAuthenticationExtensionsService, IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IDynamicAuthenticationProviderStorageService } from '../../../services/authentication/common/dynamicAuthenticationProviderStorage.js';
import { MainThreadAuthentication } from '../../browser/mainThreadAuthentication.js';
import { MainThreadCommands } from '../../browser/mainThreadCommands.js';
import { MainThreadSecretState } from '../../browser/mainThreadSecretState.js';
import { MainThreadStorage } from '../../browser/mainThreadStorage.js';
import { MainThreadWebviewPanels } from '../../browser/mainThreadWebviewPanels.js';
import { MainThreadWebviews } from '../../browser/mainThreadWebviews.js';
import { ExtHostContext, ExtHostSecretStateShape } from '../../common/extHost.protocol.js';
import { SingleProxyRPCProtocol, TestRPCProtocol } from '../common/testRPCProtocol.js';

/** The checkpoint commands Volt's turn rows run (agentCheckpointService.ts). */
const CHECKPOINT_RESTORE_COMMAND_ID = 'voltAgent.checkpoint.restore';
const CHECKPOINT_REDO_COMMAND_ID = 'voltAgent.checkpoint.redo';

suite('Volt: extension host boundary (P0-3)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function commandsHost(): { commands: MainThreadCommands; ran: string[] } {
		const ran: string[] = [];
		const commands = new MainThreadCommands(
			SingleProxyRPCProtocol(null),
			new class extends mock<ICommandService>() {
				override executeCommand<T>(id: string): Promise<T | undefined> {
					ran.push(id);
					return Promise.resolve(undefined);
				}
			},
			new class extends mock<IExtensionService>() {
				override activateByEvent() { return Promise.resolve(); }
			},
		);
		store.add({ dispose: () => commands.dispose() });
		return { commands, ran };
	}

	/** Registers `id` the way Volt's code does (`visibility` as its registration says). */
	function register(id: string, visibility?: CommandVisibility): IDisposable {
		return store.add(CommandsRegistry.registerCommand(id, () => 'volt ran', visibility));
	}

	async function refusal(commands: MainThreadCommands, id: string, args: unknown[] = []): Promise<unknown> {
		try {
			await commands.$executeCommand(id, args, true);
		} catch (err) {
			return err;
		}
		return undefined;
	}

	function assertNotAllowed(err: unknown, id: string): void {
		assert.ok(err instanceof CommandNotAllowedError, `${id}: expected CommandNotAllowed, got ${err}`);
		assert.strictEqual(err.commandId, id);
		// What the extension sees after the RPC: the error keeps its name.
		assert.strictEqual(transformErrorForSerialization(err).name, 'CommandNotAllowed');
	}

	test('XPL-CMD-1: an extension calling volt.browser.automate gets CommandNotAllowed', async () => {
		const { commands, ran } = commandsHost();
		assert.strictEqual(AUTOMATE_BROWSER_COMMAND_ID, 'volt.browser.automate');
		// Not registered yet (the browser loads lazily): a Volt id is internal by default.
		assertNotAllowed(await refusal(commands, AUTOMATE_BROWSER_COMMAND_ID, ['chat', 'browser_evaluate', { function: '() => document.cookie' }]), AUTOMATE_BROWSER_COMMAND_ID);
		register(AUTOMATE_BROWSER_COMMAND_ID, 'internal');
		assertNotAllowed(await refusal(commands, AUTOMATE_BROWSER_COMMAND_ID, ['chat', 'browser_run', { edits: [] }]), AUTOMATE_BROWSER_COMMAND_ID);
		assertNotAllowed(await refusal(commands, AUTOMATE_BROWSER_COMMAND_ID), AUTOMATE_BROWSER_COMMAND_ID);
		assert.deepStrictEqual(ran, [], 'nothing reached the command service');
		// Volt's own code still runs it.
		assert.strictEqual(CommandsRegistry.getCommand(AUTOMATE_BROWSER_COMMAND_ID)?.handler(undefined!), 'volt ran');
	});

	test('XPL-CMD-2: an extension calling volt.agentServer.allowNetwork gets CommandNotAllowed', async () => {
		const { commands, ran } = commandsHost();
		assert.strictEqual(VOLT_ALLOW_NETWORK_COMMAND_ID, 'volt.agentServer.allowNetwork');
		register(VOLT_ALLOW_NETWORK_COMMAND_ID, 'internal');
		assertNotAllowed(await refusal(commands, VOLT_ALLOW_NETWORK_COMMAND_ID), VOLT_ALLOW_NETWORK_COMMAND_ID);
		// A registration that forgot its visibility is internal too (the lint makes it say).
		store.add(CommandsRegistry.registerCommand('volt.agentServer.someNewCommand', () => undefined));
		assertNotAllowed(await refusal(commands, 'volt.agentServer.someNewCommand'), 'volt.agentServer.someNewCommand');
		// An alias is no more visible than its target.
		store.add(CommandsRegistry.registerCommandAlias('workbench.action.legacyAllowNetwork', VOLT_ALLOW_NETWORK_COMMAND_ID));
		assertNotAllowed(await refusal(commands, 'workbench.action.legacyAllowNetwork'), 'workbench.action.legacyAllowNetwork');
		assert.deepStrictEqual(ran, []);
	});

	test('XPL-CMD-3: checkpoint commands are refused; public built-ins and exported commands still run', async () => {
		const { commands, ran } = commandsHost();
		register(CHECKPOINT_RESTORE_COMMAND_ID, 'internal');
		register(CHECKPOINT_REDO_COMMAND_ID, 'internal');
		assertNotAllowed(await refusal(commands, CHECKPOINT_RESTORE_COMMAND_ID, [{ sessionId: 'chat', turnId: 't1' }]), CHECKPOINT_RESTORE_COMMAND_ID);
		assertNotAllowed(await refusal(commands, CHECKPOINT_REDO_COMMAND_ID, [{ sessionId: 'chat' }]), CHECKPOINT_REDO_COMMAND_ID);
		assert.deepStrictEqual(ran, []);

		// A VS Code built-in registered without a visibility, and a Volt command marked public or exported.
		register('workbench.action.voltTest.builtin');
		register('volt.test.publicView', 'public');
		register('volt.test.exported', 'exported:git.read');
		await commands.$executeCommand('workbench.action.voltTest.builtin', [], false);
		await commands.$executeCommand('volt.test.publicView', [], false);
		await commands.$executeCommand('volt.test.exported', [{ repositoryRoot: '/repo' }], false);
		// An unregistered built-in id behaves as before (activation, then retry).
		await assert.rejects(commands.$executeCommand('vscode.notYetRegistered', [1], true), /\$executeCommand:retry/);
		assert.deepStrictEqual(ran, ['workbench.action.voltTest.builtin', 'volt.test.publicView', 'volt.test.exported']);

		// Internal commands are not listed to extensions.
		const listed = await commands.$getCommands();
		assert.ok(!listed.includes(CHECKPOINT_RESTORE_COMMAND_ID));
		assert.ok(listed.includes('workbench.action.voltTest.builtin') && listed.includes('volt.test.exported'));
	});

	test('XPL-CMD: an extension cannot register a command over an internal one', () => {
		const { commands } = commandsHost();
		register(CHECKPOINT_RESTORE_COMMAND_ID, 'internal');
		assert.throws(() => commands.$registerCommand(CHECKPOINT_RESTORE_COMMAND_ID), (err: unknown) => err instanceof CommandNotAllowedError);
		assert.strictEqual(CommandsRegistry.getCommand(CHECKPOINT_RESTORE_COMMAND_ID)?.handler(undefined!), 'volt ran', 'Volt\'s handler still answers');
		// Extensions' own commands, even in a Volt-looking namespace, stay public as in VS Code.
		commands.$registerCommand('_volt.git.commitActivity');
		assert.strictEqual(CommandsRegistry.getCommandVisibility('_volt.git.commitActivity'), 'public');
		commands.$unregisterCommand('_volt.git.commitActivity');
	});

	// --- IPC-3 -----------------------------------------------------------------------------------

	/** A host that runs only `pub.mine`. */
	function hostOf(...ids: string[]): TestRPCProtocol {
		const rpc = store.add(new TestRPCProtocol());
		rpc.hostsExtension = id => ids.some(own => ExtensionIdentifier.equals(own, typeof id === 'string' ? id : id.value));
		return rpc;
	}

	test('IPC-3: $getPassword and the other secret calls for an extension not in this host are denied', async () => {
		const secrets = new TestSecretStorageService();
		const rpc = hostOf('pub.mine');
		const changed: string[] = [];
		rpc.set(ExtHostContext.ExtHostSecretState, new class extends mock<ExtHostSecretStateShape>() {
			override async $onDidChangePassword(e: { extensionId: string; key: string }) { changed.push(e.extensionId); }
		});
		const state = store.add(new MainThreadSecretState(rpc, secrets, new NullLogService(), undefined! as IBrowserWorkbenchEnvironmentService));
		await secrets.set(JSON.stringify({ extensionId: 'vscode.github-authentication', key: 'token' }), 'gho_secret');
		await rpc.sync();
		assert.deepStrictEqual(changed, [], 'another host\'s extension\'s secret changes are not announced here');
		const notInHost = (err: unknown) => err instanceof ExtensionNotInHostError && err.extensionId === 'vscode.github-authentication';
		await assert.rejects(state.$getPassword('vscode.github-authentication', 'token'), notInHost);
		await assert.rejects(state.$setPassword('vscode.github-authentication', 'token', 'x'), notInHost);
		await assert.rejects(state.$deletePassword('vscode.github-authentication', 'token'), notInHost);
		await assert.rejects(state.$getKeys('vscode.github-authentication'), notInHost);
		assert.strictEqual(await secrets.get(JSON.stringify({ extensionId: 'vscode.github-authentication', key: 'token' })), 'gho_secret', 'untouched');
		// Its own secrets work.
		await state.$setPassword('pub.mine', 'k', 'v');
		assert.strictEqual(await state.$getPassword('pub.mine', 'k'), 'v');
		assert.deepStrictEqual(await state.$getKeys('pub.mine'), ['k']);
		await rpc.sync();
		assert.deepStrictEqual(changed, ['pub.mine']);
	});

	test('IPC-3: an authentication session for an extension not in this host is denied before any access check', async () => {
		const asked: string[] = [];
		const services = new ServiceCollection();
		services.set(ILogService, new NullLogService());
		services.set(IAuthenticationService, new class extends mock<IAuthenticationService>() {
			override onDidChangeSessions = Event.None;
			override onDidUnregisterAuthenticationProvider = Event.None;
			override registerAuthenticationProviderHostDelegate() { return { dispose() { } }; }
			override async getSessions(id: string) { asked.push(id); return []; }
			override getProvider(id: string): never { throw new Error(`no provider ${id}`); }
		});
		services.set(ITelemetryService, NullTelemetryService);
		services.set(IAuthenticationExtensionsService, new class extends mock<IAuthenticationExtensionsService>() {
			override onDidChangeAccountPreference = Event.None;
		});
		services.set(IDynamicAuthenticationProviderStorageService, new class extends mock<IDynamicAuthenticationProviderStorageService>() {
			override onDidChangeTokens = Event.None;
		});
		// Never reached: the check comes first.
		const unused: ServiceIdentifier<unknown>[] = [IAuthenticationAccessService, IAuthenticationUsageService, IDialogService, INotificationService, IExtensionService, IOpenerService, IURLService, IClipboardService, IQuickInputService];
		for (const id of unused) {
			services.set(id, {});
		}
		const instantiation = store.add(new TestInstantiationService(services));
		const auth = store.add(instantiation.createInstance(MainThreadAuthentication, hostOf('pub.mine')));
		await assert.rejects(auth.$getSession('github', ['repo'], 'vscode.git', 'Git', { silent: true }), (err: unknown) => err instanceof ExtensionNotInHostError && err.extensionId === 'vscode.git');
		assert.deepStrictEqual(asked, [], 'refused before any session or access check');
		// Its own id gets past the check (and on to the provider, which this test does not have).
		await assert.rejects(auth.$getSession('github', ['repo'], 'pub.mine', 'Mine', { silent: true }), /no provider github/);
		assert.deepStrictEqual(asked, ['github']);
	});

	test('IPC-3: extension storage for an extension not in this host is denied', async () => {
		const written: string[] = [];
		const storage = new MainThreadStorage(
			hostOf('pub.mine'),
			new class extends mock<IExtensionStorageService>() {
				override getSourceExtensionToMigrate() { return undefined; }
				override getExtensionStateRaw() { return '{}'; }
				override setExtensionState(id: string) { written.push(id); }
				override setKeysForSync() { written.push('sync'); }
			},
			new class extends mock<IStorageService>() {
				override onDidChangeValue = () => Event.None;
			},
			undefined! as IInstantiationService,
			new NullLogService(),
		);
		store.add({ dispose: () => storage.dispose() });
		const notInHost = (err: unknown) => err instanceof ExtensionNotInHostError;
		await assert.rejects(storage.$initializeExtensionStorage(false, 'other.ext'), notInHost);
		await assert.rejects(storage.$setValue(true, 'other.ext', { stolen: true }), notInHost);
		assert.throws(() => storage.$registerExtensionStorageKeysToSync({ id: 'other.ext', version: '1.0.0' }, ['k']), notInHost);
		assert.deepStrictEqual(written, []);
		assert.strictEqual(await storage.$initializeExtensionStorage(false, 'pub.mine'), '{}');
		await storage.$setValue(false, 'pub.mine', { mine: true });
		assert.deepStrictEqual(written, ['pub.mine']);
	});

	test('IPC-3: a webview panel cannot take the origin of an extension not in this host', () => {
		const disposables = store.add(new DisposableStore());
		const opened: string[] = [];
		const panels = disposables.add(new MainThreadWebviewPanels(
			hostOf('pub.mine'),
			// Core's description of the extension; the real one is tested in voltWebviewOwnership.test.ts.
			new class extends mock<MainThreadWebviews>() {
				override readonly ownership = new class extends mock<MainThreadWebviews['ownership']>() {
					override extension(data: { readonly id: ExtensionIdentifier | string }) { return { id: new ExtensionIdentifier(typeof data.id === 'string' ? data.id : data.id.value) }; }
					override contentOptions(_extension: unknown, requested: object) { return requested; }
				};
			},
			undefined! as IConfigurationService,
			new class extends mock<IEditorGroupsService>() {
				override onDidAddGroup = Event.None;
				override onDidRemoveGroup = Event.None;
				override onDidMoveGroup = Event.None;
			},
			new class extends mock<IEditorService>() {
				override onDidActiveEditorChange = Event.None;
				override onDidVisibleEditorsChange = Event.None;
			},
			new class extends mock<IExtensionService>() { },
			disposables.add(new InMemoryStorageService()),
			new class extends mock<IWebviewWorkbenchService>() {
				override onDidChangeActiveWebviewEditor = Event.None;
				override registerResolver() { return { dispose() { } }; }
				override openWebview(init: { origin?: string; extension?: { id: ExtensionIdentifier } }): never {
					opened.push(init.extension!.id.value);
					throw new Error('stop after the origin was chosen');
				}
			},
		));
		const create = (id: unknown) => () => panels.$createWebviewPanel({ id: id as ExtensionIdentifier, location: { scheme: 'file', path: '/ext' } }, 'h', 'view', { title: 't', panelOptions: {}, webviewOptions: {}, serializeBuffersForPostMessage: false }, {});
		assert.throws(create(new ExtensionIdentifier('vscode.git')), (err: unknown) => err instanceof ExtensionNotInHostError);
		// An identifier object that crossed RPC with a `_lower` naming this host's extension and a
		// `value` naming another is judged by `value`, the part that keys the origin.
		assert.throws(create({ value: 'vscode.git', _lower: 'pub.mine' }), (err: unknown) => err instanceof ExtensionNotInHostError);
		assert.deepStrictEqual(opened, []);
		assert.throws(create(new ExtensionIdentifier('pub.mine')), /stop after the origin was chosen/);
		assert.deepStrictEqual(opened, ['pub.mine']);
	});
});
