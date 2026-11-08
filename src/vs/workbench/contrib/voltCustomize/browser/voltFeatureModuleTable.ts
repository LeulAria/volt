/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize2 } from '../../../../nls.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { GIT_GRAPH_ASK_AGENT_COMMAND_ID, GIT_GRAPH_EXPLAIN_COMMIT_COMMAND_ID, GIT_GRAPH_EXPLAIN_LINES_COMMAND_ID, GIT_GRAPH_FEATURE_ID, GIT_GRAPH_FILE_HISTORY_COMMAND_ID, GIT_GRAPH_INPUT_TYPE_ID, GIT_GRAPH_LINE_HISTORY_COMMAND_ID, GIT_GRAPH_REVEAL_COMMIT_COMMAND_ID, GIT_GRAPH_REVIEW_COMMIT_COMMAND_ID, InGitGraphContext, OPEN_GIT_GRAPH_COMMAND_ID, OPEN_GIT_GRAPH_IN_TOOLS_COMMAND_ID } from '../../voltGitGraph/common/voltGitGraph.js';
import { IVoltFeatureModuleEntry } from './voltFeatureModules.js';

/**
 * Volt's feature modules: one entry per built-in extension whose `voltModule.entry` names a
 * feature folder. This is the only file that may import a feature's module entry
 * (`contrib/volt<Feature>/browser/volt<Feature>.module.ts`); the import lint checks it. The
 * import is dynamic, so the module's code runs when the feature is first used.
 *
 * Keep one entry per feature, in the manifests' order; each M3 feature adds its own.
 */

const gitCategory = localize2('voltGitGraph.category', "Git");
const commitAgentWhen = ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), ContextKeyExpr.not('listMultiSelection'));

/** The Git Graph (`volt.git-graph`): its commands and menu entries as the module registers them (`voltGitGraph.module.ts`). */
const GIT_GRAPH_MODULE: IVoltFeatureModuleEntry = {
	feature: GIT_GRAPH_FEATURE_ID,
	load: async () => (await import('../../voltGitGraph/browser/voltGitGraph.module.js')).gitGraphModule,
	editors: [GIT_GRAPH_INPUT_TYPE_ID],
	commands: [
		{
			id: OPEN_GIT_GRAPH_COMMAND_ID,
			// The git extension (blame hover links) and `vscode.volt` run it.
			registerStub: handler => CommandsRegistry.registerCommand({ id: OPEN_GIT_GRAPH_COMMAND_ID, visibility: 'exported:git.read', handler }),
			title: localize2('voltGitGraph.open', "Open Git Graph"),
			category: gitCategory,
			icon: Codicon.sourceControl,
			f1: true,
			menus: [{ id: MenuId.SCMHistoryTitle, group: 'navigation', order: 0 }],
		},
		{ id: OPEN_GIT_GRAPH_IN_TOOLS_COMMAND_ID, visibility: 'public' },
		{
			id: GIT_GRAPH_FILE_HISTORY_COMMAND_ID,
			visibility: 'public',
			title: localize2('voltGitGraph.fileHistory', "Open File History"),
			category: gitCategory,
			icon: Codicon.history,
			f1: true,
			precondition: ContextKeyExpr.equals('config.git.enabled', true),
			menus: [
				{ id: MenuId.ExplorerContext, group: '7_volt_git', order: 1, when: ContextKeyExpr.and(ContextKeyExpr.equals('resourceScheme', Schemas.file), ContextKeyExpr.equals('config.git.enabled', true)) },
				{ id: MenuId.EditorTitleContext, group: '2_volt_git', order: 1, when: ContextKeyExpr.equals('resourceScheme', Schemas.file) },
			],
		},
		{
			id: GIT_GRAPH_LINE_HISTORY_COMMAND_ID,
			visibility: 'public',
			title: localize2('voltGitGraph.lineHistory', "Open Line History"),
			category: gitCategory,
			icon: Codicon.history,
			f1: true,
			menus: [{ id: MenuId.EditorContext, group: '1_volt_git', order: 1, when: ContextKeyExpr.equals('resourceScheme', Schemas.file) }],
		},
		{
			id: GIT_GRAPH_ASK_AGENT_COMMAND_ID,
			// The git extension (GIT_EDITOR, blame hovers) and `vscode.volt` run it.
			registerStub: handler => CommandsRegistry.registerCommand({ id: GIT_GRAPH_ASK_AGENT_COMMAND_ID, visibility: 'exported:agents.send', handler }),
		},
		{
			id: GIT_GRAPH_EXPLAIN_COMMIT_COMMAND_ID,
			title: localize2('voltGitGraph.explainCommit', "Explain with Agent"),
			icon: Codicon.sparkle,
			menus: [{ id: MenuId.SCMHistoryItemContext, group: '0_volt_agent', order: 1, when: commitAgentWhen }],
		},
		{
			id: GIT_GRAPH_REVIEW_COMMIT_COMMAND_ID,
			title: localize2('voltGitGraph.reviewCommit', "Review with Agent"),
			icon: Codicon.sparkle,
			menus: [{ id: MenuId.SCMHistoryItemContext, group: '0_volt_agent', order: 2, when: commitAgentWhen }],
		},
		{
			id: GIT_GRAPH_REVEAL_COMMIT_COMMAND_ID,
			visibility: 'public',
			title: localize2('voltGitGraph.reveal', "Open in Git Graph"),
			icon: Codicon.sourceControl,
			menus: [{ id: MenuId.SCMHistoryItemContext, group: '0_view', order: 3, when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), InGitGraphContext.negate()) }],
		},
		{
			id: GIT_GRAPH_EXPLAIN_LINES_COMMAND_ID,
			title: localize2('voltGitGraph.explainLines', "Explain Lines with Agent"),
			category: gitCategory,
			icon: Codicon.sparkle,
			f1: true,
			menus: [{ id: MenuId.EditorContext, group: '1_volt_git', order: 2, when: ContextKeyExpr.equals('resourceScheme', Schemas.file) }],
		},
	],
};

export const VOLT_FEATURE_MODULES: readonly IVoltFeatureModuleEntry[] = [
	GIT_GRAPH_MODULE,
];
