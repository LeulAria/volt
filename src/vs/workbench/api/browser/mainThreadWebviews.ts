/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';
import { isWeb } from '../../../base/common/platform.js';
import { escape } from '../../../base/common/strings.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier } from '../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { IWebview, WebviewContentOptions, WebviewExtensionDescription } from '../../contrib/webview/browser/webview.js';
import { IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { SerializableObjectWithBuffers } from '../../services/extensions/common/proxyIdentifier.js';
import * as extHostProtocol from '../common/extHost.protocol.js';
import { deserializeWebviewMessage, serializeWebviewMessage } from '../common/extHostWebviewMessaging.js';
import { externalOpenDecision } from '../../services/voltPlugins/common/externalOpenGate.js';
import { confirmExternalOpen, IWebviewOwnerContext, WebviewOwnership } from './voltWebviewOwnership.js';

export class MainThreadWebviews extends Disposable implements extHostProtocol.MainThreadWebviewsShape {

	private static readonly standardSupportedLinkSchemes = new Set([
		Schemas.http,
		Schemas.https,
		Schemas.mailto,
		Schemas.vscode,
		'vscode-insider',
	]);

	private readonly _proxy: extHostProtocol.ExtHostWebviewsShape;

	private readonly _webviews = new Map<string, IWebview>();

	/** Volt: who owns each webview and the options it asked for, before core clamped them (spec B-23). */
	private readonly _owners = new Map<string, { readonly extension: WebviewExtensionDescription; requested: WebviewContentOptions; readonly context: IWebviewOwnerContext }>();

	/** Core's view of each webview's owner: identity, readable roots, CSP floor and egress (spec I.10). */
	public readonly ownership: WebviewOwnership;

	constructor(
		context: IExtHostContext,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IProductService private readonly _productService: IProductService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IDialogService private readonly _dialogService: IDialogService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._proxy = context.getProxy(extHostProtocol.ExtHostContext.ExtHostWebviews);
		this.ownership = this._register(instantiationService.createInstance(WebviewOwnership, context));
		// Trust, workspace folders or the sandboxed list changed: every webview's roots and floor follow.
		this._register(this.ownership.onDidChange(() => {
			for (const [handle, owner] of this._owners) {
				const webview = this._webviews.get(handle);
				if (webview) {
					webview.contentOptions = this.ownership.contentOptions(owner.extension, owner.requested, owner.context);
				}
			}
		}));
	}

	/**
	 * Records the webview's owner, as core knows it, and gives the webview the options core derives
	 * from what it asked for. Later `$setOptions` calls go through the same clamp.
	 */
	public setOwner(handle: extHostProtocol.WebviewHandle, extension: WebviewExtensionDescription, requested: WebviewContentOptions, context: IWebviewOwnerContext = {}): void {
		const webview = this.getWebview(handle);
		this._owners.set(handle, { extension, requested, context });
		webview.extension = extension;
		webview.contentOptions = this.ownership.contentOptions(extension, requested, context);
	}

	public addWebview(handle: extHostProtocol.WebviewHandle, webview: IWebview, options: { serializeBuffersForPostMessage: boolean }): void {
		if (this._webviews.has(handle)) {
			throw new Error('Webview already registered');
		}

		this._webviews.set(handle, webview);
		this.hookupWebviewEventDelegate(handle, webview, options);
	}

	public $setHtml(handle: extHostProtocol.WebviewHandle, value: string): void {
		this.tryGetWebview(handle)?.setHtml(value);
	}

	public $setOptions(handle: extHostProtocol.WebviewHandle, options: extHostProtocol.IWebviewContentOptions): void {
		const webview = this.tryGetWebview(handle);
		if (!webview) {
			return;
		}
		const requested = reviveWebviewContentOptions(options);
		const owner = this._owners.get(handle);
		if (owner) {
			owner.requested = requested;
			webview.contentOptions = this.ownership.contentOptions(owner.extension, requested, owner.context);
		} else {
			// Every extension webview gets its owner when it is created or resolved; one without is
			// given nothing to read rather than what it asked for.
			webview.contentOptions = { ...requested, localResourceRoots: [] };
		}
	}

	public async $postMessage(handle: extHostProtocol.WebviewHandle, jsonMessage: string, ...buffers: VSBuffer[]): Promise<boolean> {
		const webview = this.tryGetWebview(handle);
		if (!webview) {
			return false;
		}
		const { message, arrayBuffers } = deserializeWebviewMessage(jsonMessage, buffers);
		return webview.postMessage(message, arrayBuffers);
	}

	private hookupWebviewEventDelegate(handle: extHostProtocol.WebviewHandle, webview: IWebview, options: { serializeBuffersForPostMessage: boolean }) {
		const disposables = new DisposableStore();

		disposables.add(webview.onDidClickLink((uri) => this.onDidClickLink(handle, uri)));

		disposables.add(webview.onMessage((message) => {
			const serialized = serializeWebviewMessage(message.message, options);
			this._proxy.$onMessage(handle, serialized.message, new SerializableObjectWithBuffers(serialized.buffers));
		}));

		disposables.add(webview.onMissingCsp((extension: ExtensionIdentifier) => this._proxy.$onMissingCsp(handle, extension.value)));

		disposables.add(webview.onDidDispose(() => {
			disposables.dispose();
			this._webviews.delete(handle);
			this._owners.delete(handle);
		}));
	}

	private async onDidClickLink(handle: extHostProtocol.WebviewHandle, link: string): Promise<void> {
		const webview = this.getWebview(handle);
		const uri = URI.parse(link);
		if (!this.isSupportedLink(webview, uri)) {
			return;
		}
		// Volt: a sandboxed extension's page can click its own links; one leaving Volt for a host it
		// wasn't granted (or for the mail app) is the same as its openExternal and asks first (I.10).
		const owner = this._owners.get(handle);
		let confirmed = false;
		if (owner && uri.scheme !== Schemas.command && this.ownership.isSandboxed(owner.extension.id.value)) {
			const caller = this.ownership.externalOpenCaller(owner.extension);
			const decision = externalOpenDecision(link, caller, this._productService.urlProtocol);
			if (decision.kind === 'confirm') {
				if (!await confirmExternalOpen(this._dialogService, this._logService, { id: caller.extensionId, name: caller.name }, link, decision)) {
					return;
				}
				confirmed = true;
			}
		}
		this._openerService.open(link, {
			fromUserGesture: true, allowContributedOpeners: true, allowCommands: Array.isArray(webview.contentOptions.enableCommandUris) || webview.contentOptions.enableCommandUris === true, fromWorkspace: true,
			// The user just confirmed this exact link: no second prompt for the same thing.
			skipValidation: confirmed ? true : undefined,
		});
	}

	private isSupportedLink(webview: IWebview, link: URI): boolean {
		if (MainThreadWebviews.standardSupportedLinkSchemes.has(link.scheme)) {
			return true;
		}

		if (!isWeb && this._productService.urlProtocol === link.scheme) {
			return true;
		}

		if (link.scheme === Schemas.command) {
			if (Array.isArray(webview.contentOptions.enableCommandUris)) {
				return webview.contentOptions.enableCommandUris.includes(link.path);
			}

			return webview.contentOptions.enableCommandUris === true;
		}

		return false;
	}

	private tryGetWebview(handle: extHostProtocol.WebviewHandle): IWebview | undefined {
		return this._webviews.get(handle);
	}

	private getWebview(handle: extHostProtocol.WebviewHandle): IWebview {
		const webview = this.tryGetWebview(handle);
		if (!webview) {
			throw new Error(`Unknown webview handle:${handle}`);
		}
		return webview;
	}

	public getWebviewResolvedFailedContent(viewType: string) {
		return `<!DOCTYPE html>
		<html>
			<head>
				<meta http-equiv="Content-type" content="text/html;charset=UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none';">
			</head>
			<body>${localize('errorMessage', "An error occurred while loading view: {0}", escape(viewType))}</body>
		</html>`;
	}
}

export function reviveWebviewContentOptions(webviewOptions: extHostProtocol.IWebviewContentOptions): WebviewContentOptions {
	return {
		allowScripts: webviewOptions.enableScripts,
		allowForms: webviewOptions.enableForms,
		enableCommandUris: webviewOptions.enableCommandUris,
		localResourceRoots: Array.isArray(webviewOptions.localResourceRoots) ? webviewOptions.localResourceRoots.map(r => URI.revive(r)) : undefined,
		portMapping: webviewOptions.portMapping,
	};
}
