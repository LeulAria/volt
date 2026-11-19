/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { CodeLens, CodeLensList } from '../../../../editor/common/languages.js';
import { ModesRegistry } from '../../../../editor/common/languages/modesRegistry.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { parseHttpFile } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IAgentResourcesService } from '../../voltAgent/browser/resources/agentResourcesService.js';
import { agentToolsSessionOnScreen, openInAgentTools, shownAgentToolEditors } from '../../voltAgent/browser/workspace/agentSurfaceHost.js';
import { OPEN_HTTP_IN_TOOLS_COMMAND_ID } from '../../voltAgent/browser/workspace/agentSurfaceMenu.js';
import { closeEditorsWhenVoltFeatureOff } from '../../voltCustomize/browser/voltFeatureEditors.js';
import { IVoltFeatureService, voltFeatureOn, whileVoltFeatureOn } from '../../voltCustomize/common/voltFeatures.js';
import { HTTP_ADD_TO_CHAT_COMMAND_ID, HTTP_CLIENT_FEATURE_ID } from '../common/voltHttp.js';
import './voltHttpSessions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { AgentEditor } from '../../voltAgent/browser/editor/agentEditor.js';
import { AgentEditorInput } from '../../voltAgent/browser/editor/agentEditorInput.js';
import { HttpClientCommand, VOLT_HTTP_EDITOR_ID, VOLT_HTTP_INPUT_ID, VoltHttpClientEditor, VoltHttpClientInput, VoltHttpClientInputSerializer } from './voltHttpEditor.js';
import { IVoltHttpCollections } from './voltHttpCollections.js';
import { IVoltHttpService } from './voltHttpService.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { OPEN_HTTP_EXCHANGE_COMMAND_ID, OPEN_HTTP_REQUEST_COMMAND_ID, REVEAL_HTTP_COLLECTION_COMMAND_ID, VOLT_HTTP_HISTORY_VIEW_ID, VOLT_HTTP_REQUESTS_VIEW_ID, VOLT_HTTP_VIEW_CONTAINER_ID, VoltHttpHistoryView, VoltHttpRequestsView } from './voltHttpViews.js';

const NEW_REQUEST_COMMAND_ID = 'volt.http.newRequest';
const SEND_AT_COMMAND_ID = 'volt.http.sendAt';
const SELECT_ENV_COMMAND_ID = 'volt.http.selectEnvironment';
const REFRESH_COMMAND_ID = 'volt.http.refresh';

// `.http` / `.rest` files get their own language: CodeLens hangs off it (and themes can color it).
ModesRegistry.registerLanguage({ id: 'http', extensions: ['.http', '.rest'], aliases: ['HTTP', 'http'] });

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VoltHttpClientEditor, VOLT_HTTP_EDITOR_ID, localize('voltHttp.editor', "Volt Client")),
	[new SyncDescriptor(VoltHttpClientInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(VOLT_HTTP_INPUT_ID, VoltHttpClientInputSerializer);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'voltHttp',
	title: localize('voltHttp.configuration', "Volt Client"),
	type: 'object',
	properties: {
		'volt.http.collectionsFolder': {
			type: 'string',
			default: 'http',
			description: localize('voltHttp.collectionsFolder', "The folder, inside a project, where the Volt Client writes new collections, environments and imports. Collection files anywhere in the project are found whatever this is set to."),
		},
	},
});

const httpIcon = registerIcon('volt-http-view-icon', Codicon.globe, localize('voltHttp.icon', "Volt Client view icon."));
const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: VOLT_HTTP_VIEW_CONTAINER_ID,
	title: localize2('voltHttp.container', "Volt Client"),
	icon: httpIcon,
	order: 20,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VOLT_HTTP_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: false }]),
	storageId: VOLT_HTTP_VIEW_CONTAINER_ID,
	// Its views go while the HTTP client feature is off, and the container with them.
	hideIfEmpty: true,
}, ViewContainerLocation.Sidebar);
const httpClientOn = voltFeatureOn(HTTP_CLIENT_FEATURE_ID);
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([
	{ id: VOLT_HTTP_REQUESTS_VIEW_ID, name: localize2('voltHttp.requests', "Requests"), ctorDescriptor: new SyncDescriptor(VoltHttpRequestsView), canToggleVisibility: true, canMoveView: true, order: 1, when: httpClientOn },
	{ id: VOLT_HTTP_HISTORY_VIEW_ID, name: localize2('voltHttp.history', "History"), ctorDescriptor: new SyncDescriptor(VoltHttpHistoryView), canToggleVisibility: true, canMoveView: true, order: 2, when: httpClientOn },
], container);

/** Whether the HTTP client feature (`volt.http-client`) is on; off, nothing opens a request tab. */
function httpClientEnabled(accessor: ServicesAccessor): boolean {
	return accessor.getIfExists(IVoltFeatureService)?.isEnabled(HTTP_CLIENT_FEATURE_ID) !== false;
}

/** The project a chat works in (the one on screen when none is named); undefined in the IDE layout, where the window's folders count. */
function clientRoot(accessor: ServicesAccessor, sessionId?: string): URI | undefined {
	const session = sessionId ?? agentToolsSessionOnScreen();
	return session ? accessor.getIfExists(IAgentResourcesService)?.folderForSession(session) : undefined;
}

/**
 * Opens a Volt Client (beside the chat when an agent window is in front, else in the editor).
 * Opening it by itself (the + menu, its shortcut) always makes a new one, as a terminal or a
 * browser tab does. With a `command` (a CodeLens, a history entry, what an agent changed or sent)
 * it goes to the project's client the user had in front last, and only makes one when there is none.
 */
async function openClient(accessor: ServicesAccessor, command?: HttpClientCommand, sessionId?: string): Promise<void> {
	if (!httpClientEnabled(accessor)) {
		return;
	}
	const editorService = accessor.get(IEditorService);
	const root = clientRoot(accessor, sessionId);
	const existing = command
		? [...shownAgentToolEditors(), ...editorService.editors]
			.filter((editor): editor is VoltHttpClientInput => editor instanceof VoltHttpClientInput && (editor.root?.toString() ?? '') === (root?.toString() ?? ''))
			.sort((a, b) => b.shownAt - a.shownAt)[0]
		: undefined;
	const target = existing ?? new VoltHttpClientInput(root);
	if (command) {
		target.request(command);
	}
	// An agent's send opens without taking focus from the chat (and in the IDE, in the background).
	const quiet = sessionId !== undefined;
	const inTools = openInAgentTools(target, sessionId, { pinned: true, preserveFocus: quiet });
	if (inTools) {
		await inTools;
		return;
	}
	await editorService.openEditor(target, { pinned: true, preserveFocus: quiet, ...(quiet ? { inactive: true } : {}) });
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			visibility: 'internal',
			id: NEW_REQUEST_COMMAND_ID,
			title: localize2('voltHttp.new', "New HTTP Request"),
			category: localize2('voltHttp.category', "Volt Client"),
			icon: Codicon.add,
			f1: true,
			precondition: httpClientOn,
			menu: [{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', VOLT_HTTP_REQUESTS_VIEW_ID), group: 'navigation', order: 1 }],
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await openClient(accessor, { type: 'openUntitled' });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ visibility: 'internal', id: OPEN_HTTP_IN_TOOLS_COMMAND_ID, title: localize2('voltHttp.openInTools', "Open Volt Client Beside Chat") });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await openClient(accessor);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ visibility: 'internal', id: OPEN_HTTP_REQUEST_COMMAND_ID, title: localize2('voltHttp.open', "Open HTTP Request") });
	}
	override async run(accessor: ServicesAccessor, uri?: unknown, line?: unknown): Promise<void> {
		if (URI.isUri(uri)) {
			await openClient(accessor, typeof line === 'number' ? { type: 'openRequest', collection: uri, line } : { type: 'openCollection', collection: uri });
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ visibility: 'internal', id: SEND_AT_COMMAND_ID, title: localize2('voltHttp.sendAt', "Send HTTP Request") });
	}
	override async run(accessor: ServicesAccessor, uri?: unknown, line?: unknown): Promise<void> {
		if (URI.isUri(uri) && typeof line === 'number') {
			await openClient(accessor, { type: 'openRequest', collection: uri, line, send: true });
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ visibility: 'internal', id: OPEN_HTTP_EXCHANGE_COMMAND_ID, title: localize2('voltHttp.openExchange', "Open HTTP History Entry") });
	}
	override async run(accessor: ServicesAccessor, id?: unknown, sessionId?: unknown): Promise<void> {
		const exchange = accessor.get(IVoltHttpService).history.find(item => item.id === id);
		if (exchange) {
			await openClient(accessor, { type: 'openExchange', exchange }, typeof sessionId === 'string' ? sessionId : undefined);
		}
	}
});

/** Shows a collection (or one of its requests) in a chat's client, without taking focus: what an agent just changed or ran. */
CommandsRegistry.registerCommand(REVEAL_HTTP_COLLECTION_COMMAND_ID, async (accessor, uri?: unknown, requestPath?: unknown, sessionId?: unknown) => {
	if (URI.isUri(uri)) {
		const path = Array.isArray(requestPath) ? requestPath.filter((part): part is string => typeof part === 'string') : undefined;
		await openClient(accessor, path?.length ? { type: 'openRequest', collection: uri, path } : { type: 'openCollection', collection: uri }, typeof sessionId === 'string' ? sessionId : undefined);
	}
}, 'internal');

registerAction2(class extends Action2 {
	constructor() {
		super({
			visibility: 'internal',
			id: SELECT_ENV_COMMAND_ID,
			title: localize2('voltHttp.selectEnv', "Select HTTP Environment"),
			category: localize2('voltHttp.category', "Volt Client"),
			icon: Codicon.symbolVariable,
			f1: true,
			precondition: httpClientOn,
			menu: [{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', VOLT_HTTP_REQUESTS_VIEW_ID), group: 'navigation', order: 2 }],
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const http = accessor.get(IVoltHttpService);
		const root = clientRoot(accessor);
		const entries = (await accessor.get(IVoltHttpCollections).environments(root)).filter(entry => !entry.globals && !entry.shared);
		const names = [...new Set(entries.map(entry => entry.environment.name))];
		const current = http.environmentOf(root);
		const picked = await accessor.get(IQuickInputService).pick([
			{ id: '', label: localize('voltHttp.noEnv', "No Environment"), picked: !current },
			...names.map(name => ({ id: name, label: name, picked: current === name })),
		], { placeHolder: localize('voltHttp.envPick', "Environment for {{variables}}") });
		if (picked) {
			http.setEnvironment(picked.id || undefined, root);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			visibility: 'internal',
			id: REFRESH_COMMAND_ID,
			title: localize2('voltHttp.refresh', "Refresh"),
			icon: Codicon.refresh,
			menu: [{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', VOLT_HTTP_REQUESTS_VIEW_ID), group: 'navigation', order: 3 }],
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IVoltHttpService).index();
	}
});

/** "Send Request | Open in HTTP Client" above every request in a .http file, while the feature is on. */
export class HttpCodeLens extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltHttpCodeLens';
	constructor(@ILanguageFeaturesService languageFeatures: ILanguageFeaturesService, @IVoltFeatureService features: IVoltFeatureService) {
		super();
		// Registering and removing the provider makes open editors ask again.
		this._register(whileVoltFeatureOn(features, HTTP_CLIENT_FEATURE_ID, () => languageFeatures.codeLensProvider.register({ language: 'http' }, {
			provideCodeLenses: (model: ITextModel, _token: CancellationToken): CodeLensList => {
				const lenses: CodeLens[] = [];
				for (const request of parseHttpFile(model.getValue()).requests) {
					const range = { startLineNumber: request.line, startColumn: 1, endLineNumber: request.line, endColumn: 1 };
					lenses.push(
						{ range, command: { id: SEND_AT_COMMAND_ID, title: `$(play) ${localize('voltHttp.lensSend', "Send Request")}`, arguments: [model.uri, request.line] } },
						{ range, command: { id: OPEN_HTTP_REQUEST_COMMAND_ID, title: localize('voltHttp.lensOpen', "Open in Volt Client"), arguments: [model.uri, request.line] } },
					);
				}
				return { lenses, dispose: () => { } };
			},
		})));
	}
}

registerWorkbenchContribution2(HttpCodeLens.ID, HttpCodeLens, WorkbenchPhase.Eventually);

/** The request tabs close when the HTTP client is turned off; saved ones aren't restored while it is (the serializer). */
export class HttpRequestTabs extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltHttpRequestTabs';
	constructor(@IVoltFeatureService features: IVoltFeatureService, @IEditorService editorService: IEditorService) {
		super();
		this._register(closeEditorsWhenVoltFeatureOff(features, HTTP_CLIENT_FEATURE_ID, [VOLT_HTTP_INPUT_ID], editorService));
	}
}

registerWorkbenchContribution2(HttpRequestTabs.ID, HttpRequestTabs, WorkbenchPhase.AfterRestored);

/** A request's reference as a chip in the chat's composer: the chat the client sits beside, else any chat on screen. */
CommandsRegistry.registerCommand(HTTP_ADD_TO_CHAT_COMMAND_ID, async (accessor: ServicesAccessor, args?: { readonly label?: string; readonly value?: string; readonly chatId?: string }) => {
	if (!args?.label || !args.value) {
		return;
	}
	const groups = accessor.get(IEditorGroupsService);
	const chats: AgentEditor[] = [];
	for (const part of groups.parts.length ? groups.parts : [groups.mainPart]) {
		for (const group of part.groups) {
			const pane = group.activeEditorPane;
			if (pane instanceof AgentEditor) {
				chats.push(pane);
			}
		}
	}
	const own = chats.find(pane => pane.input instanceof AgentEditorInput && pane.input.sessionId === args.chatId);
	for (const chat of own ? [own, ...chats.filter(pane => pane !== own)] : chats) {
		if (chat.addContextMention(args.label, args.value)) {
			return;
		}
	}
	await accessor.get(IClipboardService).writeText(args.value);
	accessor.get(INotificationService).info(localize('voltHttp.addToChatCopied', "No chat is open beside the Volt Client, so the request was copied. Paste it into a chat."));
}, 'internal');
