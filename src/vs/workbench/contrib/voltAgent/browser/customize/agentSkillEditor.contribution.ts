/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../services/editor/common/editorResolverService.js';
import { customizationKindForResource } from './agentCustomize.js';
import { AgentSkillEditor } from './agentSkillEditor.js';
import { AGENT_SKILL_EDITOR_ID, AgentSkillEditorInput, AgentSkillEditorInputSerializer } from './agentSkillEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AgentSkillEditor, AGENT_SKILL_EDITOR_ID, localize('voltSkillEditor.label', "Skill Editor")),
	[new SyncDescriptor(AgentSkillEditorInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	AgentSkillEditorInput.ID,
	AgentSkillEditorInputSerializer
);

/**
 * Where skills, subagents, rules and commands live: Volt's, Claude Code's, Cursor's, Codex's and
 * the shared `.agents` folders, in projects, the home folder and installed plugins. The globs are
 * broad; `customizationKindForResource` decides, so other markdown keeps the text editor.
 */
const GLOBS = [
	'**/{SKILL,skill,Skill}.md',
	'**/{.volt,.claude,.cursor,.agents,.codex}/{agents,commands,rules}/**/*.{md,mdc}',
	'**/.codex/prompts/**/*.md',
	'**/rules/**/*.mdc',
	'**/plugins/**/{agents,commands,rules}/**/*.{md,mdc}',
];

class AgentSkillEditorResolverContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltSkillEditorResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IFileService fileService: IFileService,
	) {
		super();
		const canSupportResource = (resource: URI) => fileService.hasProvider(resource) && customizationKindForResource(resource) !== undefined;
		for (const glob of GLOBS) {
			this._register(editorResolverService.registerEditor(
				glob,
				{
					id: AGENT_SKILL_EDITOR_ID,
					label: localize('voltSkillEditor.label', "Skill Editor"),
					detail: localize('voltSkillEditor.detail', "Preview and edit skills, subagents, rules and commands"),
					priority: RegisteredEditorPriority.default,
				},
				{ canSupportResource, singlePerResource: false },
				{
					createEditorInput: ({ resource, options }) => ({
						editor: instantiationService.createInstance(AgentSkillEditorInput, resource),
						options,
					}),
				},
			));
		}
	}
}

registerWorkbenchContribution2(AgentSkillEditorResolverContribution.ID, AgentSkillEditorResolverContribution, WorkbenchPhase.BlockStartup);
