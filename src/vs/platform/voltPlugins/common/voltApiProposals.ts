/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * API proposals Volt owns and opens to every extension that declares them in
 * `enabledApiProposals`, including ones installed from Open VSX (VS Code's own proposals stay
 * limited to built-ins and development mode). What each call may do is decided by the extension's
 * declared capabilities, not by the proposal (spec G.8, `VoltExtensionCapabilityPolicy`).
 */
export const VOLT_OPEN_API_PROPOSALS: ReadonlySet<string> = new Set(['volt']);
