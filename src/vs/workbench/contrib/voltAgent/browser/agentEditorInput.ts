/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Schemas } from '../../../../base/common/network.js';
import Severity from '../../../../base/common/severity.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfirmResult, IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, GroupIdentifier, IEditorIdentifier, IEditorSerializer, IRevertOptions, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput, IEditorCloseHandler } from '../../../common/editor/editorInput.js';

const AgentEditorIcon = registerIcon('volt-agent-editor-label-icon', Codicon.robot, localize('voltAgentEditorLabelIcon', 'Icon of the New Agent editor tab.'));

export const AGENT_EDITOR_ID = 'workbench.editor.voltAgent';
export const AGENT_EDITOR_INPUT_ID = 'workbench.input.voltAgent';
export const NEW_AGENT_COMMAND_ID = 'workbench.action.newAgent';
export const OPEN_AGENT_SIDE_PANEL_COMMAND_ID = 'workbench.action.openAgentSidePanel';
export const AGENT_SIDE_PANEL_ID = 'workbench.panel.voltAgent';
export const AGENT_SIDE_PANEL_VIEW_ID = 'workbench.panel.voltAgent.view';

export const AGENT_FIND_COMMAND_ID = 'workbench.action.voltAgent.find';
export const AGENT_FIND_HIDE_COMMAND_ID = 'workbench.action.voltAgent.hideFind';
export const AGENT_FIND_NEXT_COMMAND_ID = 'workbench.action.voltAgent.findNext';
export const AGENT_FIND_PREVIOUS_COMMAND_ID = 'workbench.action.voltAgent.findPrevious';
export const AGENT_FIND_TOGGLE_REGEX_COMMAND_ID = 'workbench.action.voltAgent.toggleFindRegex';
export const AGENT_FIND_TOGGLE_WHOLE_WORD_COMMAND_ID = 'workbench.action.voltAgent.toggleFindWholeWord';
export const AGENT_FIND_TOGGLE_CASE_COMMAND_ID = 'workbench.action.voltAgent.toggleFindCaseSensitive';
export const AGENT_EDITOR_LINE_NUMBERS_SETTING = 'volt.agent.editor.lineNumbers';

export class AgentEditorInput extends EditorInput implements IEditorCloseHandler {

	static readonly countsInUse = new Set<number>();

	static readonly TypeID = AGENT_EDITOR_INPUT_ID;
	static readonly EditorID = AGENT_EDITOR_ID;

	private readonly inputCount: number;
	private hasUnsavedContent = false;

	draft = '';
	composerZoomed = false;
	composerHeight: number | undefined;
	messages: object[] = [];
	contextUsed?: number;
	contextWindow?: number;

	static getNewEditorUri(): URI {
		const handle = Math.floor(Math.random() * 1e9);
		return URI.from({ scheme: Schemas.voltAgent, path: `agent-${handle}` });
	}

	static getNextCount(): number {
		let count = 0;
		while (AgentEditorInput.countsInUse.has(count)) {
			count++;
		}
		return count;
	}

	constructor(
		readonly resource: URI,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();
		this.inputCount = AgentEditorInput.getNextCount();
		AgentEditorInput.countsInUse.add(this.inputCount);
	}

	override closeHandler = this;

	setHasUnsavedContent(value: boolean): void {
		if (this.hasUnsavedContent === value) {
			return;
		}
		this.hasUnsavedContent = value;
		this._onDidChangeDirty.fire();
	}

	override isDirty(): boolean {
		return this.hasUnsavedContent;
	}

	showConfirm(): boolean {
		return this.hasUnsavedContent;
	}

	async confirm(_editors: ReadonlyArray<IEditorIdentifier>): Promise<ConfirmResult> {
		const { result } = await this.dialogService.prompt({
			type: Severity.Warning,
			message: localize('voltAgent.closeTitle', "Are you sure you want to close?"),
			detail: localize('voltAgent.closeDetail', "You'll lose the content in this agent."),
			custom: true,
			buttons: [
				{
					label: localize('voltAgent.yesClose', "Yes, Close"),
					run: () => ConfirmResult.DONT_SAVE
				}
			],
			cancelButton: {
				label: localize('voltAgent.cancel', "Cancel"),
				run: () => ConfirmResult.CANCEL
			}
		});
		return result ?? ConfirmResult.CANCEL;
	}

	override async revert(_group: GroupIdentifier, _options?: IRevertOptions): Promise<void> {
		this.draft = '';
		this.setHasUnsavedContent(false);
	}

	override get typeId(): string {
		return AgentEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return AgentEditorInput.EditorID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton | EditorInputCapabilities.CanDropIntoEditor;
	}

	override getName(): string {
		return this.inputCount > 0
			? localize('voltAgentEditorNameN', "New Agent {0}", this.inputCount + 1)
			: localize('voltAgentEditorName', "New Agent");
	}

	override getIcon(): ThemeIcon {
		return AgentEditorIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof AgentEditorInput && other.resource.toString() === this.resource.toString();
	}

	override dispose(): void {
		AgentEditorInput.countsInUse.delete(this.inputCount);
		super.dispose();
	}
}

export class AgentEditorInputSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof AgentEditorInput;
	}

	serialize(editorInput: EditorInput): string | undefined {
		if (!(editorInput instanceof AgentEditorInput)) {
			return undefined;
		}
		return editorInput.resource.toString();
	}

	deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		try {
			return instantiationService.createInstance(AgentEditorInput, URI.parse(serializedEditorInput));
		} catch {
			return undefined;
		}
	}
}
