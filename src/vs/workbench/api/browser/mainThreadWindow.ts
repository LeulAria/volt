/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier } from '../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ExtHostContext, ExtHostWindowShape, IOpenUriOptions, MainContext, MainThreadWindowShape } from '../common/extHost.protocol.js';
import { IHostService } from '../../services/host/browser/host.js';
import { IUserActivityService } from '../../services/userActivity/common/userActivityService.js';
import { encodeBase64 } from '../../../base/common/buffer.js';
import { isSandboxedExtension, VOLT_SANDBOXED_EXTENSIONS_SETTING } from '../../contrib/webview/common/voltWebviewOwnership.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import { ExternalOpenDecision, externalOpenDecision, externalUriDecision, IExternalOpenCaller } from '../../services/voltPlugins/common/externalOpenGate.js';
import { confirmExternalOpen, grantedNetHosts } from './voltWebviewOwnership.js';

@extHostNamedCustomer(MainContext.MainThreadWindow)
export class MainThreadWindow implements MainThreadWindowShape {

	private readonly proxy: ExtHostWindowShape;
	private readonly disposables = new DisposableStore();

	constructor(
		private readonly extHostContext: IExtHostContext,
		@IHostService private readonly hostService: IHostService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IUserActivityService private readonly userActivityService: IUserActivityService,
		@IDialogService private readonly dialogService: IDialogService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
	) {
		this.proxy = extHostContext.getProxy(ExtHostContext.ExtHostWindow);

		Event.latch(hostService.onDidChangeFocus)
			(this.proxy.$onDidChangeWindowFocus, this.proxy, this.disposables);
		userActivityService.onDidChangeIsActive(this.proxy.$onDidChangeWindowActive, this.proxy, this.disposables);
		this.registerNativeHandle();
	}

	dispose(): void {
		this.disposables.dispose();
	}

	registerNativeHandle(): void {
		Event.latch(this.hostService.onDidChangeActiveWindow)(
			async windowId => {
				const handle = await this.hostService.getNativeWindowHandle(windowId);
				this.proxy.$onDidChangeActiveNativeWindowHandle(handle ? encodeBase64(handle) : undefined);
			},
			this,
			this.disposables
		);
	}

	$getInitialState() {
		return Promise.resolve({
			isFocused: this.hostService.hasFocus,
			isActive: this.userActivityService.isActive,
		});
	}

	async $openUri(uriComponents: UriComponents, uriString: string | undefined, options: IOpenUriOptions): Promise<boolean> {
		const uri = URI.from(uriComponents);
		let target: URI | string;
		if (uriString && URI.parse(uriString).toString() === uri.toString()) {
			// called with string and no transformation happened -> keep string
			target = uriString;
		} else {
			// called with URI or transformed -> use uri
			target = uri;
		}
		// Volt: a link to another app, or a sandboxed extension's to a host it wasn't granted, is
		// shown to the user first (spec I.10, B-37); first party never asks.
		const caller = this.caller(options.extensionId);
		const url = typeof target === 'string' ? target : target.toString(true);
		const decision = externalOpenDecision(url, caller, this.productService.urlProtocol);
		if (decision.kind === 'confirm' && !await this.confirm(caller, url, decision)) {
			return false;
		}
		return this.openerService.open(target, {
			openExternal: true,
			allowTunneling: options.allowTunneling,
			allowContributedOpeners: options.allowContributedOpeners,
			fromExtension: true,
			// The user just confirmed this exact link: no second prompt for the same thing.
			skipValidation: decision.kind === 'confirm' ? true : undefined,
		});
	}

	async $asExternalUri(uriComponents: UriComponents, options: IOpenUriOptions): Promise<UriComponents> {
		const uri = URI.revive(uriComponents);
		const caller = this.caller(options.extensionId);
		const decision = externalUriDecision(uri.toString(true), caller);
		if (decision.kind === 'confirm' && !await this.confirm(caller, uri.toString(true), decision)) {
			// Not resolved (no port forwarded): the extension gets its URI back as it was.
			return uri;
		}
		const result = await this.openerService.resolveExternalUri(uri, { allowTunneling: options.allowTunneling });
		return result.resolved;
	}

	/**
	 * The caller as core knows it: the payload's id counts only for an extension this host runs.
	 * An unknown caller is treated as sandboxed when its host runs a sandboxed extension.
	 */
	private caller(extensionId: string | undefined): IExternalOpenCaller {
		const sandboxedList = this.configurationService.getValue(VOLT_SANDBOXED_EXTENSIONS_SETTING);
		const description = typeof extensionId === 'string' && this.extHostContext.hostsExtension(extensionId)
			? this.extensionService.extensions.find(extension => ExtensionIdentifier.equals(extension.identifier, extensionId))
			: undefined;
		if (!description) {
			const hostRunsSandboxed = Array.isArray(sandboxedList) && sandboxedList.some(id => typeof id === 'string' && this.extHostContext.hostsExtension(id));
			return { extensionId: undefined, builtin: false, sandboxed: hostRunsSandboxed, grantedHosts: [] };
		}
		const id = description.identifier.value;
		const sandboxed = isSandboxedExtension(sandboxedList, id);
		return {
			extensionId: id,
			builtin: description.isBuiltin && !description.isUserBuiltin,
			sandboxed,
			grantedHosts: sandboxed ? grantedNetHosts(description) : [],
		};
	}

	/** Volt's confirmation, within the extension's prompt budget (G.12). */
	private confirm(caller: IExternalOpenCaller, url: string, decision: ExternalOpenDecision & { kind: 'confirm' }): Promise<boolean> {
		const description = caller.extensionId ? this.extensionService.extensions.find(extension => ExtensionIdentifier.equals(extension.identifier, caller.extensionId)) : undefined;
		return confirmExternalOpen(this.dialogService, this.logService, { id: caller.extensionId, name: description?.displayName || description?.name }, url, decision);
	}
}
