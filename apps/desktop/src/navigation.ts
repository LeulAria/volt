/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from T3 Code's desktop app (MIT, github.com/pingdotgg/t3code): apps/desktop/src/
// electron/ElectronShell.ts (parseSafeExternalUrl), window/DesktopWindow.ts
// (isSameOriginRendererNavigation) and backend/DesktopBackendManager.ts (calculateRestartDelay).

const SAFE_WEB_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** The URL to hand to the OS browser, or undefined for anything that is not a web link. */
export function parseSafeExternalUrl(rawUrl: unknown): string | undefined {
	if (typeof rawUrl !== 'string') {
		return undefined;
	}
	try {
		const url = new URL(rawUrl);
		return SAFE_WEB_PROTOCOLS.has(url.protocol) ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/** Whether a navigation stays on the page the window was opened on (the agent server's). */
export function isSameOriginNavigation(applicationUrl: string | undefined, navigationUrl: string): boolean {
	if (!applicationUrl) {
		return false;
	}
	try {
		return new URL(applicationUrl).origin === new URL(navigationUrl).origin;
	} catch {
		return false;
	}
}

const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 10_000;

/** 0.5 s, 1 s, 2 s, … up to 10 s between attempts to reach the server again. */
export function retryDelay(attempt: number): number {
	return Math.min(INITIAL_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}
