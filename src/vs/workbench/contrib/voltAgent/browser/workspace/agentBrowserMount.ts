/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which browser UI an agent surface mounts.
 * Always the IDE `VoltBrowserEditor` chrome (Design toolbar), never a bare webview.
 */
export type AgentBrowserSurfaceMount = 'ide-chrome';

export function chooseAgentBrowserSurfaceMount(): AgentBrowserSurfaceMount {
	return 'ide-chrome';
}
