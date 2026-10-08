/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Outside agents (connected over Volt's OAuth MCP server) act as callers without a chat. Their
 * id is never a chat id, so a "From" pill or a queue line naming them cannot open a chat.
 */

const EXTERNAL_PREFIX = 'external:';
/** An outside agent's start and send limits count per window of this length. */
export const EXTERNAL_SPEND_WINDOW_MS = 10 * 60_000;

export function externalCallerId(clientId: string): string {
	return `${EXTERNAL_PREFIX}${clientId}`;
}

export function isExternalCallerId(id: string | undefined): boolean {
	return !!id && id.startsWith(EXTERNAL_PREFIX);
}

export function externalSpendWindow(now: number): number {
	return Math.floor(now / EXTERNAL_SPEND_WINDOW_MS);
}

/** Opens Volt Settings on Connected agents (from an "external" pill in a chat). */
export const OPEN_CONNECTED_AGENTS_COMMAND_ID = 'volt.externalMcp.openConnectedAgents';
