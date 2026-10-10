/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IReference } from '../../../../../base/common/lifecycle.js';
import { basename, dirname, isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { EditorInputCapabilities, GroupIdentifier, IEditorSerializer, IRevertOptions, ISaveOptions, IUntypedEditorInput, Verbosity } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { ITextFileService, TextFileEditorModelState } from '../../../../services/textfile/common/textfiles.js';
import { AgentCustomizationKind, customizationKindForResource } from './agentCustomize.js';

export const AGENT_SKILL_EDITOR_ID = 'workbench.editor.voltSkillEditor';
export const AGENT_SKILL_EDITOR_INPUT_ID = 'workbench.input.voltSkillEditor';

/**
 * A skill, subagent, rule or command file shown in the Preview / Source editor. The file's text
 * model is the single source of truth: both modes edit it, and dirty state, save and revert are
 * the text file's own, so the tab, Cmd+S and hot exit behave like any text editor.
 */
export class AgentSkillEditorInput extends EditorInput {

	static readonly ID = AGENT_SKILL_EDITOR_INPUT_ID;

	readonly kind: AgentCustomizationKind;
	private reference: Promise<IReference<IResolvedTextEditorModel>> | undefined;
	private disposedReference = false;

	constructor(
		readonly resource: URI,
		@ITextFileService private readonly textFileService: ITextFileService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@ILabelService private readonly labelService: ILabelService,
	) {
		super();
		this.kind = customizationKindForResource(resource) ?? 'skill';
		this._register(this.textFileService.files.onDidChangeDirty(model => {
			if (isEqual(model.resource, this.resource)) {
				this._onDidChangeDirty.fire();
			}
		}));
		this._register(this.textFileService.files.onDidSave(e => {
			if (isEqual(e.model.resource, this.resource)) {
				this._onDidChangeDirty.fire();
			}
		}));
		this._register(this.labelService.onDidChangeFormatters(() => this._onDidChangeLabel.fire()));
	}

	override get typeId(): string {
		return AgentSkillEditorInput.ID;
	}

	override get editorId(): string {
		return AGENT_SKILL_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.CanSplitInGroup;
	}

	override getName(): string {
		return basename(this.resource);
	}

	override getDescription(verbosity?: Verbosity): string | undefined {
		const folder = dirname(this.resource);
		switch (verbosity) {
			case Verbosity.SHORT:
				return basename(folder);
			case Verbosity.LONG:
				return this.labelService.getUriLabel(folder);
			default:
				return this.labelService.getUriLabel(folder, { relative: true });
		}
	}

	override getTitle(verbosity?: Verbosity): string {
		return verbosity === Verbosity.LONG ? this.labelService.getUriLabel(this.resource) : this.getName();
	}

	/** The file's text model, loaded once and kept while the input lives. */
	async resolveModel(): Promise<ITextModel> {
		if (!this.reference || this.disposedReference) {
			this.disposedReference = false;
			this.reference = this.textModelService.createModelReference(this.resource);
			this.reference.catch(() => this.reference = undefined);
		}
		const reference = await this.reference;
		return reference.object.textEditorModel;
	}

	override isDirty(): boolean {
		return this.textFileService.isDirty(this.resource);
	}

	override isSaving(): boolean {
		return !!this.textFileService.files.get(this.resource)?.hasState(TextFileEditorModelState.PENDING_SAVE);
	}

	override async save(_group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | IUntypedEditorInput | undefined> {
		const saved = await this.textFileService.save(this.resource, options);
		return saved ? this : undefined;
	}

	override async saveAs(group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | IUntypedEditorInput | undefined> {
		const target = await this.textFileService.saveAs(this.resource, undefined, options);
		return target ? { resource: target } : undefined;
	}

	override async revert(_group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
		await this.textFileService.revert(this.resource, options);
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof AgentSkillEditorInput && isEqual(other.resource, this.resource);
	}

	override toUntyped(): IUntypedEditorInput {
		return { resource: this.resource, options: { override: AGENT_SKILL_EDITOR_ID } };
	}

	override dispose(): void {
		const reference = this.reference;
		this.reference = undefined;
		this.disposedReference = true;
		void reference?.then(ref => ref.dispose(), () => undefined);
		super.dispose();
	}
}

export class AgentSkillEditorInputSerializer implements IEditorSerializer {

	canSerialize(editor: EditorInput): boolean {
		return editor instanceof AgentSkillEditorInput;
	}

	serialize(editor: EditorInput): string | undefined {
		return editor instanceof AgentSkillEditorInput ? JSON.stringify({ resource: editor.resource.toJSON() }) : undefined;
	}

	deserialize(instantiationService: IInstantiationService, raw: string): EditorInput | undefined {
		try {
			const data = JSON.parse(raw) as { resource?: unknown };
			if (!data.resource) {
				return undefined;
			}
			return instantiationService.createInstance(AgentSkillEditorInput, URI.revive(data.resource as URI));
		} catch {
			return undefined;
		}
	}
}
