/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Code Intelligence feature's contract: the ids core knows it by. Its parts (index warmup,
 * the instant_grep / find_symbol / find_files host tools, its Settings page) live in
 * `contrib/voltCodeIntelligence/`, the `volt.code-intelligence` built-in extension's module. The
 * index itself and its settings stay in core (`services/voltRuntime/.../codeIntelligence*`).
 */

export const CODE_INTELLIGENCE_FEATURE_ID = 'codeIntelligence';
/** Its Volt Settings page (the manifest's `voltSettingsPages` id). */
export const CODE_INTELLIGENCE_SECTION_ID = 'codeIntelligence';
