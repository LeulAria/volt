/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentAutomations.css';
import { $, append, clearNode, Dimension } from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IAutomationService } from '../../../../services/voltRuntime/common/automations/automations.js';
import { createAgentScrollable } from '../editor/agentScrollable.js';
import { AutomationDetailView } from './automationDetailView.js';
import { AutomationListView } from './automationListView.js';
import { AllRunsView } from './automationRunsView.js';
import { AutomationsRoute, IAutomationsHost, IAutomationsPage } from './automationRoutes.js';

export const AUTOMATIONS_EDITOR_ID = 'workbench.editor.voltAutomations';
const AUTOMATIONS_INPUT_ID = 'workbench.input.voltAutomations';

export class AutomationsEditorInput extends EditorInput {

	static readonly TypeID = AUTOMATIONS_INPUT_ID;
	static readonly EditorID = AUTOMATIONS_EDITOR_ID;

	readonly resource = URI.from({ scheme: Schemas.voltAutomations, path: 'automations' });
	route: AutomationsRoute = { page: 'list' };

	override get typeId(): string {
		return AutomationsEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return AutomationsEditorInput.EditorID;
	}

	override getName(): string {
		return localize('voltAutomations.tab', "Automations");
	}

	override getIcon(): ThemeIcon {
		return Codicon.zap;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof AutomationsEditorInput;
	}
}

export class AutomationsEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(input: EditorInput): string {
		const route = input instanceof AutomationsEditorInput ? input.route : undefined;
		// A saved automation's page comes back after a reload; a new, unsaved one does not.
		return route?.page === 'detail' && route.id ? JSON.stringify({ id: route.id, tab: route.tab }) : route?.page === 'runs' ? JSON.stringify({ runs: true }) : '';
	}
	deserialize(instantiationService: IInstantiationService, raw: string): EditorInput {
		const input = instantiationService.createInstance(AutomationsEditorInput);
		try {
			const value = raw ? JSON.parse(raw) as { id?: unknown; tab?: unknown; runs?: unknown } : {};
			if (typeof value.id === 'string') {
				input.route = { page: 'detail', id: value.id, tab: value.tab === 'runs' ? 'runs' : 'settings' };
			} else if (value.runs === true) {
				input.route = { page: 'runs' };
			}
		} catch {
			// The list.
		}
		return input;
	}
}

/**
 * Automations, in Cursor's layout: the list (with Volt's built-in agents and templates), one
 * automation (Settings, Run History), and every run. One editor tab; pages swap inside it and the
 * route lives on the input, so the tab reopens where it was.
 */
export class AutomationsEditor extends EditorPane {

	static readonly ID = AUTOMATIONS_EDITOR_ID;

	private container!: HTMLElement;
	private bar!: HTMLElement;
	private content!: HTMLElement;
	private scroll!: DomScrollableElement;
	private readonly page = this._register(new MutableDisposable<IAutomationsPage>());
	private navigating = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAutomationService private readonly automations: IAutomationService,
	) {
		super(AutomationsEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.volt-automations'));
		this.container.tabIndex = -1;
		this.bar = append(this.container, $('.volt-automations-bar'));
		const body = $('.volt-automations-body');
		this.content = append(body, $('.volt-automations-content'));
		this.scroll = this._register(createAgentScrollable(body));
		append(this.container, this.scroll.getDomNode());
	}

	override async setInput(input: AutomationsEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		await this.automations.whenReady;
		if (!token.isCancellationRequested) {
			this.show(input.route);
		}
	}

	override clearInput(): void {
		this.page.clear();
		super.clearInput();
	}

	/** Opens a page; asks the current one first (unsaved changes). */
	async navigate(route: AutomationsRoute): Promise<void> {
		if (this.navigating) {
			return;
		}
		this.navigating = true;
		try {
			if (this.page.value?.canLeave && !await this.page.value.canLeave()) {
				return;
			}
			this.show(route);
		} finally {
			this.navigating = false;
		}
	}

	private show(route: AutomationsRoute): void {
		const input = this.input instanceof AutomationsEditorInput ? this.input : undefined;
		if (input) {
			input.route = route;
		}
		this.page.clear();
		clearNode(this.bar);
		clearNode(this.content);
		this.container.dataset.page = route.page;
		const host: IAutomationsHost = {
			bar: this.bar,
			content: this.content,
			navigate: next => void this.navigate(next),
			setRoute: next => {
				if (this.input instanceof AutomationsEditorInput) {
					this.input.route = next;
				}
			},
			relayout: () => this.scroll.scanDomNode(),
			scrollToTop: () => this.scroll.setScrollPosition({ scrollTop: 0 }),
		};
		switch (route.page) {
			case 'list':
				this.page.value = this.instantiationService.createInstance(AutomationListView, host);
				break;
			case 'runs':
				this.page.value = this.instantiationService.createInstance(AllRunsView, host);
				break;
			case 'detail':
				this.page.value = this.instantiationService.createInstance(AutomationDetailView, host, route);
				break;
		}
		host.scrollToTop();
		this.scroll.scanDomNode();
	}

	override layout(dimension: Dimension): void {
		this.container.style.height = `${dimension.height}px`;
		this.container.style.width = `${dimension.width}px`;
		this.scroll.scanDomNode();
	}

	override focus(): void {
		super.focus();
		if (this.page.value?.focus) {
			this.page.value.focus();
		} else {
			this.container.focus();
		}
	}

	override dispose(): void {
		this.page.clear();
		super.dispose();
	}
}
