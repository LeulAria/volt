/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Denser agent list: smaller rows, no secondary metadata. */
export const AGENT_COMPACT_LIST_SETTING = 'volt.agent.sidebar.compactList';

export interface IAgentHomeDensityHost {
	readonly compact: boolean;
	setCompact(compact: boolean): void;
}

let host: IAgentHomeDensityHost | undefined;

/** Set by the sidebar contribution; the list's filter menu offers the toggle while it is set. */
export function setAgentHomeDensityHost(next: IAgentHomeDensityHost | undefined): void {
	host = next;
}

export function agentHomeDensityHost(): IAgentHomeDensityHost | undefined {
	return host;
}
