/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Volt's UI typeface: the system font. Only code uses the monospace font. CSS reads `--volt-font`
 * (agentEditor.css), which also follows the interface font set in Settings > Appearance; this
 * constant is for what CSS can't reach (Monaco's fontFamily option, canvas text).
 */
export const VOLT_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif';
