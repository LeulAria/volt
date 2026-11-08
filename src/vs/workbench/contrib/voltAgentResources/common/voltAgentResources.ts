/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Agent Resources feature's contract: the ids core knows its page by. The page and its
 * commands live in `contrib/voltAgentResources/`, the `volt.agent-resources` built-in extension's
 * module, loaded on first use. What other pages share with it stays in core
 * (`voltAgent/browser/resources/`: the scan service, the sections Customize embeds, the files
 * sidebar's filter).
 */

export const AGENT_RESOURCES_FEATURE_ID = 'agentResources';
/** Opens Agent Resources; args: a section id, and the folder it is about (a chat's worktree). */
export const OPEN_AGENT_RESOURCES_COMMAND_ID = 'volt.agent.openAgentResources';
export const AGENT_RESOURCES_EDITOR_ID = 'workbench.editor.voltAgentResources';
export const AGENT_RESOURCES_INPUT_ID = 'workbench.input.voltAgentResources';
