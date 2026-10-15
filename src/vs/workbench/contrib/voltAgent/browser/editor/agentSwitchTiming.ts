/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * When the user asked for another chat or project (a sidebar click, a project pick), so the chat
 * pane can log how long the switch took from the click, not only from its own setInput.
 */
let requestedAt: number | undefined;

/** A switch starts now; the chat that shows next reports from here. A mark made just before (the project pick that opens this chat) stays. */
export function markAgentSwitch(): void {
	const now = performance.now();
	if (requestedAt === undefined || now - requestedAt > 1_000) {
		requestedAt = now;
	}
}

/** The pending switch's start, at most once, and only when it is recent (an abandoned click is not). */
export function takeAgentSwitchStart(now: number): number | undefined {
	const at = requestedAt;
	requestedAt = undefined;
	return at !== undefined && now - at < 10_000 ? at : undefined;
}

/** `load 3 ms, draw 9 ms (stashed), on screen 21 ms after the click`: the line the pane logs per switch. */
export function formatAgentSwitch(timing: { readonly load: number; readonly draw: number; readonly how: string; readonly onScreen: number; readonly fromClick: boolean }): string {
	const ms = (value: number) => `${Math.round(value)} ms`;
	return `load ${ms(timing.load)}, draw ${ms(timing.draw)} (${timing.how}), on screen ${ms(timing.onScreen)} after the ${timing.fromClick ? 'click' : 'open'}`;
}
