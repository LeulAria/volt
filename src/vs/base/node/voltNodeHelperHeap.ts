/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The largest semi-space (MB) of V8's young generation in the agent server. Under a burst of allocation V8 grows the
 * young generation to two semi-spaces of its maximum and keeps that size while the burst lasts: 32 MB in Electron
 * 37's Node 22, measured with a JSON-parsing loop. Five Claude chats streaming at once (ADEMark A7) are such a burst
 * for as long as they stream. The server parses and forwards short-lived messages (ACP updates, transcript
 * patches): what survives a scavenge is small, so a smaller young generation costs more frequent but no larger
 * scavenges. Dev build, A7 (n 2 each): the server at A7's p95 tick 235 MB without the cap, 191 MB with it.
 *
 * The shared ACP adapter host (the user's `node`) is not capped: its young generation shrinks back after the first
 * burst, and with the cap it ended A7 6 MB higher (more promotion), so the cap bought it nothing at the p95 tick.
 */
export const NODE_HELPER_MAX_SEMI_SPACE_MB = 4;

/** The agent server's V8 options, before its entry script on the command line. */
export function nodeHelperHeapFlags(): string[] {
	return [`--max-semi-space-size=${NODE_HELPER_MAX_SEMI_SPACE_MB}`];
}
