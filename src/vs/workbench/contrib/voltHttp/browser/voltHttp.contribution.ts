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
import { openInAgentTools } from '../../voltAgent/browser/workspace/agentSurfaceHost.js';
import { OPEN_HTTP_IN_TOOLS_COMMAND_ID } from '../../voltAgent/browser/workspace/agentSurfaceMenu.js';
import { IVoltFeatureService, voltFeatureOn, whileVoltFeatureOn } from '../../voltCustomize/common/voltFeatures.js';
import { HTTP_CLIENT_FEATURE_ID } from '../common/voltHttp.js';
import { draftFromSpec, VOLT_HTTP_EDITOR_ID, VOLT_HTTP_INPUT_ID, VoltHttpRequestEditor, VoltHttpRequestInput, VoltHttpRequestInputSerializer } from './voltHttpEditor.js';
import { IVoltHttpService } from './voltHttpService.js';
import { OPEN_HTTP_EXCHANGE_COMMAND_ID, OPEN_HTTP_REQUEST_COMMAND_ID, VOLT_HTTP_HISTORY_VIEW_ID, VOLT_HTTP_REQUESTS_VIEW_ID, VOLT_HTTP_VIEW_CONTAINER_ID, VoltHttpHistoryView, VoltHttpRequestsView } from './voltHttpViews.js';

const NEW_REQUEST_COMMAND_ID = 'volt.http.newRequest';
const SEND_AT_COMMAND_ID = 'volt.http.sendAt';
const SELECT_ENV_COMMAND_ID = 'volt.http.selectEnvironment';
const REFRESH_COMMAND_ID = 'volt.http.refresh';

// `.http` / `.rest` files get their own language: CodeLens hangs off it (and themes can color it).
ModesRegistry.registerLanguage({ id: 'http', extensions: ['.http', '.rest'], aliases: ['HTTP', 'http'] });

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VoltHttpRequestEditor, VOLT_HTTP_EDITOR_ID, localize('voltHttp.editor', "HTTP Request")),
	[new SyncDescriptor(VoltHttpRequestInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(VOLT_HTTP_INPUT_ID, VoltHttpRequestInputSerializer);

const httpIcon = registerIcon('volt-http-view-icon', Codicon.globe, localize('voltHttp.icon', "HTTP Client view icon."));
const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: VOLT_HTTP_VIEW_CONTAINER_ID,
	title: localize2('voltHttp.container', "HTTP Client"),
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

/** Opens a request beside the chat when an agent window is in front, else in the editor. */
async function openRequest(accessor: ServicesAccessor, input: VoltHttpRequestInput, sessionId?: string): Promise<void> {
	if (!httpClientEnabled(accessor)) {
		return;
	}
	const editorService = accessor.get(IEditorService);
	const existing = editorService.editors.find(editor => editor instanceof VoltHttpRequestInput && editor.matches(input));
	const target = (existing as VoltHttpRequestInput | undefined) ?? input;
	if (target !== input) {
		target.sendOnOpen = input.sendOnOpen;
		target.pendingExchange = input.pendingExchange;
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

async function inputAt(accessor: ServicesAccessor, uri: URI, line: number): Promise<VoltHttpRequestInput | undefined> {
	const files = await accessor.get(IVoltHttpService).index();
	const request = files.find(file => file.uri.toString() === uri.toString())?.requests.find(item => item.line === line);
	return request ? new VoltHttpRequestInput(draftFromSpec(request), { uri, line }) : undefined;
}

function newRequest(): VoltHttpRequestInput {
	return new VoltHttpRequestInput({ name: '', method: 'GET', url: '', headers: [], bodyMode: 'none', body: '', form: [], graphqlVariables: '', auth: { mode: 'none', token: '', user: '', password: '', keyName: 'X-API-Key', keyValue: '', keyIn: 'header' } }, undefined);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			visibility: 'internal',
			id: NEW_REQUEST_COMMAND_ID,
			title: localize2('voltHttp.new', "New HTTP Request"),
			category: localize2('voltHttp.category', "HTTP Client"),
			icon: Codicon.add,
			f1: true,
			precondition: httpClientOn,
			menu: [{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', VOLT_HTTP_REQUESTS_VIEW_ID), group: 'navigation', order: 1 }],
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await openRequest(accessor, newRequest());
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ visibility: 'internal', id: OPEN_HTTP_IN_TOOLS_COMMAND_ID, title: localize2('voltHttp.openInTools', "Open HTTP Client Beside Chat") });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		// The newest request tab comes back; otherwise a new request.
		const open = accessor.get(IEditorService).editors.filter((editor): editor is VoltHttpRequestInput => editor instanceof VoltHttpRequestInput).at(-1);
		await openRequest(accessor, open ?? newRequest());
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ visibility: 'internal', id: OPEN_HTTP_REQUEST_COMMAND_ID, title: localize2('voltHttp.open', "Open HTTP Request") });
	}
	override async run(accessor: ServicesAccessor, uri?: unknown, line?: unknown): Promise<void> {
		if (URI.isUri(uri) && typeof line === 'number') {
			const input = await inputAt(accessor, uri, line);
			if (input) {
				await openRequest(accessor, input);
			}
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ visibility: 'internal', id: SEND_AT_COMMAND_ID, title: localize2('voltHttp.sendAt', "Send HTTP Request") });
	}
	override async run(accessor: ServicesAccessor, uri?: unknown, line?: unknown): Promise<void> {
		if (URI.isUri(uri) && typeof line === 'number') {
			const input = await inputAt(accessor, uri, line);
			if (input) {
				input.sendOnOpen = true;
				await openRequest(accessor, input);
			}
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ visibility: 'internal', id: OPEN_HTTP_EXCHANGE_COMMAND_ID, title: localize2('voltHttp.openExchange', "Open HTTP History Entry") });
	}
	override async run(accessor: ServicesAccessor, id?: unknown, sessionId?: unknown): Promise<void> {
		const http = accessor.get(IVoltHttpService);
		const exchange = http.history.find(item => item.id === id);
		if (!exchange) {
			return;
		}
		const fromFile = exchange.source ? await inputAt(accessor, exchange.source.uri, exchange.source.line) : undefined;
		const input = fromFile ?? new VoltHttpRequestInput(draftFromSpec({ ...(exchange.name ? { name: exchange.name } : {}), method: exchange.method, url: exchange.url, headers: exchange.headers, ...(exchange.body !== undefined ? { body: exchange.body } : {}), line: 0 }), undefined);
		input.pendingExchange = exchange;
		await openRequest(accessor, input, typeof sessionId === 'string' ? sessionId : undefined);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			visibility: 'internal',
			id: SELECT_ENV_COMMAND_ID,
			title: localize2('voltHttp.selectEnv', "Select HTTP Environment"),
			category: localize2('voltHttp.category', "HTTP Client"),
			icon: Codicon.symbolVariable,
			f1: true,
			precondition: httpClientOn,
			menu: [{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', VOLT_HTTP_REQUESTS_VIEW_ID), group: 'navigation', order: 2 }],
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const http = accessor.get(IVoltHttpService);
		const envs = await http.environments();
		const picked = await accessor.get(IQuickInputService).pick([
			{ id: '', label: localize('voltHttp.noEnv', "No Environment"), picked: !http.environment },
			...Object.keys(envs).map(name => ({ id: name, label: name, description: localize('voltHttp.envVars', "{0} variables", Object.keys(envs[name]).length), picked: http.environment === name })),
		], { placeHolder: localize('voltHttp.envPick', "Environment for {{variables}} (http-client.env.json)") });
		if (picked) {
			http.setEnvironment(picked.id || undefined);
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
class HttpCodeLens extends Disposable implements IWorkbenchContribution {
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
						{ range, command: { id: OPEN_HTTP_REQUEST_COMMAND_ID, title: localize('voltHttp.lensOpen', "Open in HTTP Client"), arguments: [model.uri, request.line] } },
					);
				}
				return { lenses, dispose: () => { } };
			},
		})));
	}
}

registerWorkbenchContribution2(HttpCodeLens.ID, HttpCodeLens, WorkbenchPhase.Eventually);
