/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension, getWindow } from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { createAgentScrollable } from '../editor/agentScrollable.js';
import { AgentUsagePage } from './agentUsagePage.js';

export const AGENT_USAGE_EDITOR_ID = 'workbench.editor.voltUsage';
export const AGENT_USAGE_INPUT_ID = 'workbench.input.voltUsage';
/** Opens Volt Settings on its Usage page (agentHistory.contribution.ts). */
export const OPEN_AGENT_USAGE_COMMAND_ID = 'workbench.action.voltAgent.usage';

const UsageTabIcon = registerIcon('volt-usage-editor-label-icon', Codicon.graph, localize('voltUsageIcon', 'Icon of the agent Usage tab.'));

export class AgentUsageEditorInput extends EditorInput {

	static readonly TypeID = AGENT_USAGE_INPUT_ID;
	static readonly EditorID = AGENT_USAGE_EDITOR_ID;

	readonly resource = URI.from({ scheme: Schemas.voltUsage, path: 'usage' });

	override get typeId(): string {
		return AgentUsageEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return AgentUsageEditorInput.EditorID;
	}

	override getName(): string {
		return localize('voltUsage.tab', "Usage");
	}

	override getIcon(): ThemeIcon {
		return UsageTabIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof AgentUsageEditorInput;
	}
}

export class AgentUsageEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(AgentUsageEditorInput);
	}
}

/**
 * The old Usage tab, kept so tabs restored from earlier sessions still open. Usage now lives in
 * Volt Settings; this only hosts the same page in a scroller.
 */
export class AgentUsageEditor extends EditorPane {

	static readonly ID = AGENT_USAGE_EDITOR_ID;

	private container!: HTMLElement;
	private scroll!: DomScrollableElement;
	private page!: AgentUsagePage;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storage: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(AgentUsageEditor.ID, group, telemetryService, themeService, storage);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.volt-usage-editor'));
		this.page = this._register(this.instantiationService.createInstance(AgentUsagePage, () => this.container));
		const body = $('.volt-usage-body');
		body.appendChild(this.page.element);
		this.scroll = this._register(createAgentScrollable(body));
		append(this.container, this.scroll.getDomNode()).classList.add('volt-usage-scroll');
		// The page grows as its charts draw; rescan whenever its size changes.
		const sizeObserver = new (getWindow(this.container).ResizeObserver)(() => this.scroll.scanDomNode());
		sizeObserver.observe(this.page.element);
		this._register(toDisposable(() => sizeObserver.disconnect()));
	}

	override async setInput(input: AgentUsageEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.page.setVisible(this.isVisible());
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.page.setVisible(visible && !!this.input);
	}

	override layout(dimension: Dimension): void {
		this.container.style.height = `${dimension.height}px`;
		this.container.style.width = `${dimension.width}px`;
		this.scroll.scanDomNode();
	}

	override focus(): void {
		super.focus();
		this.page.focus();
	}
}
