/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';
import { dirname, extUriBiasedIgnorePathCase, joinPath, normalizePath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IUserDataProfilesService } from '../../../platform/userDataProfile/common/userDataProfile.js';
import { ceilingCovers, firstPartyCeiling } from '../../../platform/voltPlugins/common/firstPartyCeilings.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../platform/workspace/common/workspaceTrust.js';
import { WebviewContentOptions, WebviewExtensionDescription } from '../../contrib/webview/browser/webview.js';
import { clampLocalResourceRoots, isDocumentFolderReadable, isSandboxedExtension, promptSafeText, VOLT_SANDBOXED_EXTENSIONS_SETTING, webviewOwnerPolicy } from '../../contrib/webview/common/voltWebviewOwnership.js';
import { ExternalOpenDecision, ExternalOpenPromptBudget, IExternalOpenCaller } from '../../services/voltPlugins/common/externalOpenGate.js';
import { EditorResourceAccessor } from '../../common/editor.js';
import { IWorkbenchEnvironmentService } from '../../services/environment/common/environmentService.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { assertHostsExtension, ExtensionNotInHostError, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import { IPathService } from '../../services/path/common/pathService.js';
import { IUserDataProfileService } from '../../services/userDataProfile/common/userDataProfile.js';
import { pickVoltContributes, validateVoltContribution } from '../../services/voltPlugins/common/voltContributions.js';

/**
 * Extensions whose webview shows other extensions' files by design: the Markdown preview loads
 * the styles and scripts other extensions contribute to it. Those folders join its readable set.
 */
const CONTRIBUTED_PREVIEW_ROOTS: Readonly<Record<string, readonly string[]>> = {
	'vscode.markdown-language-features': ['markdown.previewStyles', 'markdown.previewScripts', 'markdown.markdownItPlugins'],
};

/** Where an extension's webview shows a document (a custom editor's), so its folder is the extension's to read. */
export interface IWebviewOwnerContext {
	readonly document?: URI;
}

/**
 * Core's side of an extension's webview (spec B-08, B-23, I.10): which extension it belongs to,
 * as core knows that extension (running in this extension host, its location from its
 * description, never from the payload), the roots it may load from (its readable set) and the
 * CSP floor and egress core enforces. One per extension host.
 */
export class WebviewOwnership extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** The trust, the workspace folders or the sandboxed list changed: re-derive every webview's options. */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly logged = new Set<string>();

	constructor(
		private readonly context: IExtHostContext,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly trustService: IWorkspaceTrustManagementService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IUserDataProfilesService private readonly profilesService: IUserDataProfilesService,
		@IUserDataProfileService private readonly profileService: IUserDataProfileService,
		@IEditorService private readonly editorService: IEditorService,
		@IPathService private readonly pathService: IPathService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(trustService.onDidChangeTrust(() => this._onDidChange.fire()));
		this._register(workspaceService.onDidChangeWorkspaceFolders(() => this._onDidChange.fire()));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VOLT_SANDBOXED_EXTENSIONS_SETTING)) {
				this._onDidChange.fire();
			}
		}));
	}

	/**
	 * The extension a payload names, as core knows it. Throws unless it runs in this extension
	 * host; its location comes from its description, not from the payload.
	 */
	extension(extensionData: { readonly id: ExtensionIdentifier | string }): WebviewExtensionDescription {
		assertHostsExtension(this.context, extensionData.id);
		const value = typeof extensionData.id === 'string' ? extensionData.id : extensionData.id.value;
		const description = this.description(value);
		if (!description) {
			throw new ExtensionNotInHostError(value);
		}
		return { id: description.identifier, location: description.extensionLocation };
	}

	/** A webview restored from storage names its owner: it is this host's only if that extension runs here. */
	owns(extension: WebviewExtensionDescription | undefined): boolean {
		return !!extension && this.context.hostsExtension(extension.id.value) && !!this.description(extension.id.value);
	}

	isSandboxed(extensionId: string): boolean {
		return isSandboxedExtension(this.configurationService.getValue(VOLT_SANDBOXED_EXTENSIONS_SETTING), extensionId);
	}

	/** The webview's owner as a caller of the external-open gate, with its name for the prompt. */
	externalOpenCaller(extension: WebviewExtensionDescription): IExternalOpenCaller & { readonly name: string | undefined } {
		const description = this.description(extension.id.value);
		const sandboxed = this.isSandboxed(extension.id.value);
		return {
			extensionId: extension.id.value,
			name: description?.displayName || description?.name,
			builtin: !!description?.isBuiltin && !description.isUserBuiltin,
			sandboxed,
			grantedHosts: sandboxed && description ? grantedNetHosts(description) : [],
		};
	}

	/**
	 * The options the webview really gets: the requested ones with the roots clamped to the
	 * extension's readable set (what is dropped is logged) and core's CSP floor and egress.
	 */
	contentOptions(extension: WebviewExtensionDescription, requested: WebviewContentOptions, owner?: IWebviewOwnerContext): WebviewContentOptions {
		const description = this.description(extension.id.value);
		const sandboxed = this.isSandboxed(extension.id.value);
		const ownerPolicy = webviewOwnerPolicy(sandboxed, description ? grantedNetHosts(description) : []);
		if (!requested.localResourceRoots) {
			return { ...requested, ownerPolicy };
		}
		const readable = description ? this.readableSet(description, sandboxed, owner) : [];
		const { kept, dropped } = clampLocalResourceRoots(requested.localResourceRoots, readable, !sandboxed);
		// A custom editor's document right in the home folder or a drive root: its folder is too
		// broad to read, so a dropped root that holds it is narrowed to the document itself.
		const document = owner?.document;
		if (document && !kept.some(root => extUriBiasedIgnorePathCase.isEqualOrParent(document, root)) && dropped.some(root => extUriBiasedIgnorePathCase.isEqualOrParent(document, normalizePath(root)))) {
			kept.push(document);
		}
		if (dropped.length) {
			const key = `${extension.id.value}\n${dropped.map(root => root.toString()).join('\n')}`;
			if (!this.logged.has(key)) {
				this.logged.add(key);
				this.logService.warn(`[volt webview] ${extension.id.value}: dropped local resource roots outside what the extension may read: ${dropped.map(root => root.toString(true)).join(', ')}`);
			}
		}
		return { ...requested, localResourceRoots: kept, ownerPolicy };
	}

	/**
	 * What an extension's webview may load files from (INV-20):
	 * - its own folder and its global and workspace storage;
	 * - the workspace folders when the workspace is trusted (a built-in that isn't sandboxed
	 *   keeps them in Restricted Mode: it is Volt's own code and reads them anyway);
	 * - the folder of the document a custom editor shows;
	 * - unsandboxed only: the folders of files open in editors (a preview of a file outside the
	 *   workspace), never a file system root or the home folder;
	 * - the Markdown preview: the folders of extensions that contribute to it.
	 */
	private readableSet(description: IExtensionDescription, sandboxed: boolean, owner: IWebviewOwnerContext | undefined): URI[] {
		const id = description.identifier.value;
		const readable: URI[] = [description.extensionLocation];
		// Extension hosts get the default profile's storage home; the current profile's is listed too.
		for (const home of new Set([this.profilesService.defaultProfile.globalStorageHome.toString(), this.profileService.currentProfile.globalStorageHome.toString()])) {
			readable.push(joinPath(URI.parse(home), id.toLowerCase()));
		}
		const workspace = this.workspaceService.getWorkspace();
		readable.push(joinPath(this.environmentService.workspaceStorageHome, workspace.id, id));

		const builtin = description.isBuiltin && !description.isUserBuiltin;
		if (this.trustService.isWorkspaceTrusted() || (builtin && !sandboxed)) {
			readable.push(...workspace.folders.map(folder => folder.uri));
		}

		const home = this.pathService.resolvedUserHome;
		if (owner?.document && isDocumentFolderReadable(dirname(owner.document), home)) {
			readable.push(dirname(owner.document));
		}
		if (!sandboxed) {
			for (const editor of this.editorService.editors) {
				const resource = EditorResourceAccessor.getOriginalUri(editor);
				if (resource && (resource.scheme === Schemas.file || resource.scheme === Schemas.vscodeRemote) && isDocumentFolderReadable(dirname(resource), home)) {
					readable.push(dirname(resource));
				}
			}
		}

		const points = CONTRIBUTED_PREVIEW_ROOTS[id];
		if (points) {
			for (const other of this.extensionService.extensions) {
				const contributes = other.contributes as Record<string, unknown> | undefined;
				if (contributes && points.some(point => contributes[point] !== undefined)) {
					readable.push(other.extensionLocation);
				}
			}
		}
		return readable;
	}

	private description(id: string): IExtensionDescription | undefined {
		return this.extensionService.extensions.find(extension => ExtensionIdentifier.equals(extension.identifier, id));
	}
}

/** The longest URL a prompt shows in full (G.12); longer ones are cut, with an ellipsis. */
const MAX_PROMPT_URL = 500;

/**
 * One budget per window: prompts are counted per extension, whether it asks from its host
 * (`openExternal`) or from its webview (a link the page clicks), whichever host it runs in.
 */
const externalOpenPromptBudget = new ExternalOpenPromptBudget();

/**
 * Volt's confirmation before an extension's link leaves Volt (spec I.10, B-37), within the
 * extension's prompt budget (G.12): its name and the URL are stripped of invisible characters and
 * length-capped. False when refused or when the budget is spent (then nothing is shown).
 */
export async function confirmExternalOpen(dialogService: IDialogService, logService: ILogService, extension: { readonly id: string | undefined; readonly name: string | undefined }, url: string, decision: ExternalOpenDecision & { kind: 'confirm' }): Promise<boolean> {
	const name = extension.name ? promptSafeText(extension.name, 60) : undefined;
	const who = name && extension.id ? localize('voltOpenExternal.who', "The extension \"{0}\" ({1})", name, extension.id) : localize('voltOpenExternal.whoUnknown', "An extension");
	const shown = promptSafeText(url, MAX_PROMPT_URL);
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1] ?? '';
	const result = await externalOpenPromptBudget.ask(extension.id ?? '(unknown extension)', url, async () => {
		const { confirmed } = await dialogService.confirm({
			type: 'warning',
			message: decision.reason === 'scheme'
				? localize('voltOpenExternal.schemeMessage', "{0} wants to open a {1}: link in another app", who, promptSafeText(scheme, 40))
				: localize('voltOpenExternal.hostMessage', "{0} wants to open a website it has no access to", who),
			detail: decision.reason === 'scheme'
				? localize('voltOpenExternal.schemeDetail', "Volt would hand this link to the app your system uses for it. Open it only if you expected this.\n\n{0}", shown)
				: localize('voltOpenExternal.hostDetail', "This extension runs in Volt's sandbox and didn't declare this website. Open it only if you expected this.\n\n{0}", shown),
			primaryButton: localize({ key: 'voltOpenExternal.open', comment: ['&& denotes a mnemonic'] }, "&&Open Link"),
		});
		return confirmed;
	});
	if (!result.allowed) {
		logService.info(`[volt] ${extension.id ?? 'an extension'} was not allowed to open a ${scheme}: link${result.reason ? ` (${result.reason}, not asked)` : ''}`);
	}
	return result.allowed;
}

/**
 * The hosts an extension may reach: its `net.connect` declarations in `contributes.voltCapabilities`
 * (a declared `low` capability is granted while the extension is enabled; a declaration without
 * targets means any host), a built-in's capped by its first-party ceiling.
 */
export function grantedNetHosts(description: Pick<IExtensionDescription, 'identifier' | 'publisher' | 'isBuiltin' | 'isUserBuiltin' | 'contributes'>): string[] {
	const capabilities = pickVoltContributes(description.contributes).voltCapabilities;
	if (!capabilities || validateVoltContribution('voltCapabilities', capabilities).length) {
		return [];
	}
	const id = description.identifier.value;
	const firstParty = description.isBuiltin && !description.isUserBuiltin && description.publisher === 'volt' && !!firstPartyCeiling(id);
	const hosts = new Set<string>();
	for (const entry of [...capabilities.required ?? [], ...capabilities.optional ?? []]) {
		if (entry.id.replace(/@\d+$/, '') !== 'net.connect') {
			continue;
		}
		for (const target of entry.targets?.length ? entry.targets : ['*']) {
			if (!firstParty || ceilingCovers(id, 'net.connect', target === '*' ? undefined : target)) {
				hosts.add(target);
			}
		}
	}
	return [...hosts].sort();
}
