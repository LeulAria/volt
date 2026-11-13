/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Usage feature's contract: the ids core knows it by. Its code lives in `contrib/voltUsage/`
 * (the `volt.usage` built-in extension's module, loaded on first use); core reaches it only
 * through these ids, its commands and `IVoltFeatureModuleService.part`.
 */

export const USAGE_FEATURE_ID = 'usage';
export const AGENT_USAGE_EDITOR_ID = 'workbench.editor.voltUsage';
/** The old Usage tab's editor type; the agent window treats it as a page, not a tab. */
export const AGENT_USAGE_INPUT_ID = 'workbench.input.voltUsage';
/** Opens Volt Settings on its Usage page. */
export const OPEN_AGENT_USAGE_COMMAND_ID = 'workbench.action.voltAgent.usage';
/** The Usage Settings page, slot item and side toolbar section (the manifest's ids). */
export const USAGE_SECTION_ID = 'usage';
export const USAGE_SLOT_ITEM_ID = 'volt.usage';
export const USAGE_DOCK_SECTION_ID = 'usage';
