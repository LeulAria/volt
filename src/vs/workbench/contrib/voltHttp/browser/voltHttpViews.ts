/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { relativePath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchList, WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IHttpRequestSpec } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { IHttpExchange, IHttpFileEntry, IVoltHttpService } from './voltHttpService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

export const VOLT_HTTP_VIEW_CONTAINER_ID = 'workbench.view.voltHttp';
export const VOLT_HTTP_REQUESTS_VIEW_ID = 'workbench.view.voltHttp.requests';
export const VOLT_HTTP_HISTORY_VIEW_ID = 'workbench.view.voltHttp.history';
export const OPEN_HTTP_REQUEST_COMMAND_ID = 'volt.http.openRequest';
export const OPEN_HTTP_EXCHANGE_COMMAND_ID = 'volt.http.openExchange';

const ROW_HEIGHT = 24;

type RequestNode = { readonly kind: 'file'; readonly file: IHttpFileEntry } | { readonly kind: 'request'; readonly file: IHttpFileEntry; readonly request: IHttpRequestSpec };

interface IRowTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly method: HTMLElement;
	readonly label: HTMLElement;
	readonly detail: HTMLElement;
}

function rowTemplate(container: HTMLElement): IRowTemplate {
	const row = append(container, $('.volt-http-row'));
	return {
		row,
		icon: append(row, $('span.volt-http-row-icon')),
		method: append(row, $('span.volt-http-row-method')),
		label: append(row, $('span.volt-http-row-label')),
		detail: append(row, $('span.volt-http-row-detail')),
	};
}

/** The workspace's .http / .rest files and their requests; opening a request opens it in the request editor. */
export class VoltHttpRequestsView extends ViewPane {

	private tree: WorkbenchObjectTree<RequestNode> | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IVoltHttpService private readonly http: IVoltHttpService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.http.onDidChangeIndex(() => void this.refresh()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('volt-http-view');
		const delegate: IListVirtualDelegate<RequestNode> = { getHeight: () => ROW_HEIGHT, getTemplateId: () => 'row' };
		const workspace = this.workspace;
		const renderer: ITreeRenderer<RequestNode, void, IRowTemplate> = {
			templateId: 'row',
			renderTemplate: rowTemplate,
			renderElement: (node: ITreeNode<RequestNode, void>, _index: number, template: IRowTemplate) => {
				const element = node.element;
				template.icon.replaceChildren();
				if (element.kind === 'file') {
					template.icon.appendChild(renderIcon(Codicon.file));
					template.method.textContent = '';
					template.method.removeAttribute('data-method');
					const folder = workspace.getWorkspaceFolder(element.file.uri)?.uri;
					template.label.textContent = (folder && relativePath(folder, element.file.uri)) || element.file.uri.path.split('/').pop() || '';
					template.detail.textContent = String(element.file.requests.length);
				} else {
					template.method.textContent = element.request.method;
					template.method.dataset.method = element.request.method;
					template.label.textContent = element.request.name ?? element.request.url.replace(/^[a-z]+:\/\/[^/]+/i, '') ?? element.request.url;
					template.detail.textContent = element.request.name ? element.request.url.replace(/^[a-z]+:\/\//i, '') : '';
				}
			},
			disposeTemplate: () => { },
		};
		this.tree = this._register(this.instantiationService.createInstance(WorkbenchObjectTree<RequestNode>, 'VoltHttpRequests', append(container, $('.volt-http-tree')), delegate, [renderer], {
			accessibilityProvider: {
				getAriaLabel: element => element.kind === 'file' ? element.file.uri.path : `${element.request.method} ${element.request.name ?? element.request.url}`,
				getWidgetAriaLabel: () => localize('voltHttp.requestsAria', "HTTP requests"),
			},
			identityProvider: { getId: element => element.kind === 'file' ? element.file.uri.toString() : `${element.file.uri.toString()}#${element.request.line}` },
		}));
		this._register(this.tree.onDidOpen(event => {
			const element = event.element;
			if (element?.kind === 'request') {
				void this.commandService.executeCommand(OPEN_HTTP_REQUEST_COMMAND_ID, element.file.uri, element.request.line);
			}
		}));
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		if (!this.tree) {
			return;
		}
		const files = await this.http.index();
		this.tree.setChildren(null, files.map(file => ({
			element: { kind: 'file' as const, file },
			collapsed: false,
			children: file.requests.map(request => ({ element: { kind: 'request' as const, file, request } })),
		})));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}
}

/** Every request sent (by the user or an agent), newest first, with its status and time; opening one shows it again. */
export class VoltHttpHistoryView extends ViewPane {

	private list: WorkbenchList<IHttpExchange> | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IVoltHttpService private readonly http: IVoltHttpService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.http.onDidSend(() => this.refresh()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('volt-http-view');
		const renderer: IListRenderer<IHttpExchange, IRowTemplate> = {
			templateId: 'row',
			renderTemplate: rowTemplate,
			renderElement: (exchange, _index, template) => {
				template.icon.replaceChildren();
				const status = exchange.response?.status;
				template.icon.textContent = status ? String(status) : '';
				template.icon.className = `volt-http-row-icon status ${!status ? 'error' : status >= 500 ? 'error' : status >= 400 ? 'warn' : status >= 300 ? 'info' : 'ok'}`;
				if (!status) {
					template.icon.appendChild(renderIcon(Codicon.error));
				}
				template.method.textContent = exchange.method;
				template.method.dataset.method = exchange.method;
				template.label.textContent = exchange.name ?? exchange.url.replace(/^[a-z]+:\/\/[^/]+/i, '') ?? exchange.url;
				template.detail.textContent = `${exchange.response ? `${exchange.response.durationMs}ms \u00b7 ` : ''}${fromNow(exchange.at, true)}`;
			},
			disposeTemplate: () => { },
		};
		this.list = this._register(this.instantiationService.createInstance(WorkbenchList<IHttpExchange>, 'VoltHttpHistory', append(container, $('.volt-http-tree')), { getHeight: () => ROW_HEIGHT, getTemplateId: () => 'row' }, [renderer], {
			accessibilityProvider: {
				getAriaLabel: exchange => `${exchange.method} ${exchange.url} ${exchange.response?.status ?? exchange.error ?? ''}`,
				getWidgetAriaLabel: () => localize('voltHttp.historyAria', "HTTP history"),
			},
		}));
		this._register(this.list.onDidOpen(event => {
			if (event.element) {
				void this.commandService.executeCommand(OPEN_HTTP_EXCHANGE_COMMAND_ID, event.element.id);
			}
		}));
		this.refresh();
	}

	private refresh(): void {
		this.list?.splice(0, this.list.length, [...this.http.history]);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.list?.layout(height, width);
	}
}
