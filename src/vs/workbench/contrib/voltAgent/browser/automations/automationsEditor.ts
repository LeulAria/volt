/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentAutomations.css';
import { $, append, clearNode, Dimension } from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
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
import { IAgentPageCrumb } from '../customize/agentMarketplaceView.js';
import { AutomationsRoute, IAutomationsHost, IAutomationsPage } from './automationRoutes.js';
import { WorkflowBuilderPage } from '../workflows/workflowBuilderPage.js';
import { WorkflowLibraryPage } from '../workflows/workflowLibraryPage.js';

export const AUTOMATIONS_EDITOR_ID = 'workbench.editor.voltAutomations';
const AUTOMATIONS_INPUT_ID = 'workbench.input.voltAutomations';

export class AutomationsEditorInput extends EditorInput {

	static readonly TypeID = AUTOMATIONS_INPUT_ID;
	static readonly EditorID = AUTOMATIONS_EDITOR_ID;

	readonly resource = URI.from({ scheme: Schemas.voltAutomations, path: 'automations' });
	route: AutomationsRoute = { page: 'list' };

	private _crumbs: readonly IAgentPageCrumb[] = [];
	private _home: (() => void) | undefined;

	/** Where the page is past Automations, for the title bar: an automation, then its runs. */
	get crumbs(): readonly IAgentPageCrumb[] {
		return this._crumbs;
	}

	/** Back to the list, from the title bar's Automations while a page is open past it. */
	get home(): (() => void) | undefined {
		return this._home;
	}

	setCrumbs(crumbs: readonly IAgentPageCrumb[], home: (() => void) | undefined): void {
		const same = crumbs.length === this._crumbs.length && crumbs.every((crumb, i) => crumb.label === this._crumbs[i].label && !crumb.run === !this._crumbs[i].run);
		this._crumbs = crumbs;
		this._home = home;
		if (!same) {
			this._onDidChangeLabel.fire();
		}
	}

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
		switch (route?.page) {
			case 'detail': return route.id ? JSON.stringify({ id: route.id, tab: route.tab }) : '';
			case 'runs': return JSON.stringify({ runs: true });
			case 'list': return route.view && route.view !== 'list' ? JSON.stringify({ view: route.view }) : '';
			case 'workflows': return JSON.stringify({ workflows: route.tab ?? 'mine' });
			// A saved workflow comes back after a reload; a new, unsaved one opens the library.
			case 'workflow': return route.id ? JSON.stringify({ workflow: route.id }) : JSON.stringify({ workflows: 'mine' });
			default: return '';
		}
	}
	deserialize(instantiationService: IInstantiationService, raw: string): EditorInput {
		const input = instantiationService.createInstance(AutomationsEditorInput);
		try {
			const value = raw ? JSON.parse(raw) as { id?: unknown; tab?: unknown; runs?: unknown; view?: unknown; workflows?: unknown; workflow?: unknown } : {};
			if (typeof value.id === 'string') {
				input.route = { page: 'detail', id: value.id, tab: value.tab === 'runs' ? 'runs' : 'settings' };
			} else if (value.runs === true) {
				input.route = { page: 'runs' };
			} else if (typeof value.workflow === 'string') {
				input.route = { page: 'workflow', id: value.workflow };
			} else if (value.workflows === 'mine' || value.workflows === 'templates') {
				input.route = { page: 'workflows', tab: value.workflows };
			} else if (value.view === 'day' || value.view === 'week' || value.view === 'month') {
				input.route = { page: 'list', view: value.view };
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
	private stage!: HTMLElement;
	private scroll!: DomScrollableElement;
	private stageWidth = 0;
	private stageHeight = 0;
	private readonly onDidLayoutStage = this._register(new Emitter<{ readonly width: number; readonly height: number }>());
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
		this.stage = append(this.container, $('.volt-automations-stage'));
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
		clearNode(this.stage);
		input?.setCrumbs([], undefined);
		this.container.dataset.page = route.page;
		const host: IAutomationsHost = {
			bar: this.bar,
			content: this.content,
			stage: this.stage,
			onDidLayout: this.onDidLayoutStage.event,
			stageSize: () => ({ width: this.stageWidth, height: this.stageHeight }),
			navigate: next => void this.navigate(next),
			setRoute: next => {
				if (this.input instanceof AutomationsEditorInput) {
					this.input.route = next;
				}
			},
			setCrumbs: crumbs => {
				if (this.input instanceof AutomationsEditorInput) {
					this.input.setCrumbs(crumbs, crumbs.length ? () => void this.navigate({ page: 'list' }) : undefined);
				}
			},
			relayout: () => this.scroll.scanDomNode(),
			scrollToTop: () => this.scroll.setScrollPosition({ scrollTop: 0 }),
		};
		switch (route.page) {
			case 'list':
				this.page.value = this.instantiationService.createInstance(AutomationListView, host, route);
				break;
			case 'runs':
				this.page.value = this.instantiationService.createInstance(AllRunsView, host);
				break;
			case 'detail':
				this.page.value = this.instantiationService.createInstance(AutomationDetailView, host, route);
				break;
			case 'workflows':
				this.page.value = this.instantiationService.createInstance(WorkflowLibraryPage, host, route);
				break;
			case 'workflow':
				this.page.value = this.instantiationService.createInstance(WorkflowBuilderPage, host, route);
				break;
		}
		this.container.classList.toggle('uses-stage', !!this.page.value?.usesStage);
		host.scrollToTop();
		this.scroll.scanDomNode();
	}

	override layout(dimension: Dimension): void {
		this.container.style.height = `${dimension.height}px`;
		this.container.style.width = `${dimension.width}px`;
		this.scroll.scanDomNode();
		const width = this.stage.clientWidth || dimension.width;
		const height = this.stage.clientHeight || Math.max(0, dimension.height - this.bar.offsetHeight);
		if (width !== this.stageWidth || height !== this.stageHeight) {
			this.stageWidth = width;
			this.stageHeight = height;
			this.onDidLayoutStage.fire({ width, height });
		}
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
