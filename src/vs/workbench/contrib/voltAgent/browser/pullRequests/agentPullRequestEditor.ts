/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentPullRequests.css';
import { $, append, Dimension } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { AgentPullRequestCreateView } from './agentPullRequestCreateView.js';
import { AGENT_PULL_REQUEST_EDITOR_ID, AgentPullRequestEditorInput } from './agentPullRequestEditorInput.js';
import { AgentPullRequestView } from './agentPullRequestView.js';

export class AgentPullRequestEditor extends EditorPane {

	static readonly ID = AGENT_PULL_REQUEST_EDITOR_ID;

	private container!: HTMLElement;
	private readonly view = this._register(new MutableDisposable<AgentPullRequestView>());
	private readonly createView = this._register(new MutableDisposable<AgentPullRequestCreateView>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(AgentPullRequestEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.volt-pr-editor'));
	}

	override async setInput(input: AgentPullRequestEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested) {
			return;
		}
		if (input.target.kind === 'new') {
			this.view.clear();
			if (!this.createView.value) {
				const view = this.instantiationService.createInstance(AgentPullRequestCreateView, this.container);
				view.onDidCreate(pr => {
					const current = this.input;
					if (!(current instanceof AgentPullRequestEditorInput)) {
						return;
					}
					const next = this.instantiationService.createInstance(AgentPullRequestEditorInput, { kind: 'pr', repo: pr.repo, number: pr.number }, current.sessionId);
					void this.group.replaceEditors([{ editor: current, replacement: next, options: { pinned: true } }]);
				});
				this.createView.value = view;
			}
			this.createView.value.setTarget(input.target.folder, input.sessionId);
			return;
		}
		this.createView.clear();
		if (!this.view.value) {
			this.view.value = this.instantiationService.createInstance(AgentPullRequestView, this.container);
		}
		this.view.value.setInput(input);
		this.view.value.setVisible(this.isVisible());
	}

	override clearInput(): void {
		this.view.value?.setInput(undefined);
		this.view.value?.setVisible(false);
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.view.value?.setVisible(visible);
		if (visible) {
			void this.createView.value?.refreshIfStale();
		}
	}

	/** Opening the tab again (it was already open) reads it again. */
	override setOptions(options: IEditorOptions | undefined): void {
		super.setOptions(options);
		void this.createView.value?.refreshIfStale();
		void this.view.value?.load(false);
	}

	override focus(): void {
		super.focus();
		this.view.value?.focus();
	}

	layout(dimension: Dimension): void {
		this.container.style.width = `${dimension.width}px`;
		this.container.style.height = `${dimension.height}px`;
	}
}
