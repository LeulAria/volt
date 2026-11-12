/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

/**
 * The Git Graph's contract (the `volt.git-graph` built-in extension's module): what code outside
 * `contrib/voltGitGraph/` may use. Everything else reaches it by running these commands.
 */

/** `voltModule.feature` of `extensions/volt-git-graph`. */
export const GIT_GRAPH_FEATURE_ID = 'gitGraph';

/** Opens the Git Graph tab: `{ repositoryRoot?, query?, revealCommit? }`. The git extension and `vscode.volt` run it. */
export const OPEN_GIT_GRAPH_COMMAND_ID = 'volt.gitGraph.open';
/** Opens the Git Graph as a tab in a chat's right panel (the argument is the chat's session id). */
export const OPEN_GIT_GRAPH_IN_TOOLS_COMMAND_ID = 'volt.gitGraph.openInTools';
export const GIT_GRAPH_FILE_HISTORY_COMMAND_ID = 'volt.gitGraph.fileHistory';
export const GIT_GRAPH_LINE_HISTORY_COMMAND_ID = 'volt.gitGraph.lineHistory';
/** Explain / Review with an agent (`IGitAskAgentArgs`). The git extension and `vscode.volt` run it. */
export const GIT_GRAPH_ASK_AGENT_COMMAND_ID = 'volt.gitGraph.askAgent';
export const GIT_GRAPH_EXPLAIN_COMMIT_COMMAND_ID = 'volt.gitGraph.explainCommit';
export const GIT_GRAPH_REVIEW_COMMIT_COMMAND_ID = 'volt.gitGraph.reviewCommit';
export const GIT_GRAPH_REVEAL_COMMIT_COMMAND_ID = 'volt.gitGraph.revealCommit';
export const GIT_GRAPH_EXPLAIN_LINES_COMMAND_ID = 'volt.gitGraph.explainLines';

/** The Git Graph tab's editor input type, restored from a saved layout. */
export const GIT_GRAPH_INPUT_TYPE_ID = 'workbench.input.voltGitGraph';

/** Focus is in the Git Graph tab. */
export const InGitGraphContext = new RawContextKey<boolean>('voltInGitGraph', false);
