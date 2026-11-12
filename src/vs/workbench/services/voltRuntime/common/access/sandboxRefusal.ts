/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A sandboxed chat whose agent could not be confined is refused, never run unconfined. The stdio
 * layer rejects such a spawn with a `SandboxUnavailableError`; the chat shows it as an error the
 * user can answer by turning the sandbox off for that chat.
 */

export const SANDBOX_UNAVAILABLE_ERROR_NAME = 'SandboxUnavailableError';

/** The spawn was refused because the sandbox cannot be enforced. The name survives IPC; the class does not. */
export function isSandboxUnavailableError(err: unknown): err is Error {
	return err instanceof Error && err.name === SANDBOX_UNAVAILABLE_ERROR_NAME;
}

export function sandboxUnavailableError(message: string): Error {
	const error = new Error(message);
	error.name = SANDBOX_UNAVAILABLE_ERROR_NAME;
	return error;
}

/** Why no sandboxed chat can run on `platform`; undefined where the OS offers one. */
export function sandboxPlatformUnavailable(platform: string): string | undefined {
	return platform === 'win32' ? 'OS sandboxing isn\'t available on Windows yet.' : undefined;
}

const REFUSED_PREFIX = 'Sandbox unavailable: ';

/** The chat's error for a refused spawn. The chat recognizes it by its prefix, in saved chats and over the agent server too. */
export function sandboxRefusedMessage(reason: string): string {
	const why = reason.trim().replace(/^SandboxUnavailableError:\s*/, '') || 'the OS sandbox could not start.';
	return `${REFUSED_PREFIX}${why}${/[.!?]$/.test(why) ? '' : '.'} Volt did not start the agent without it.`;
}

export function isSandboxRefusedMessage(text: string): boolean {
	return text.trim().startsWith(REFUSED_PREFIX);
}

/** The reason in a refused-spawn message, without the prefix. */
export function sandboxRefusedReason(text: string): string {
	return isSandboxRefusedMessage(text) ? text.trim().slice(REFUSED_PREFIX.length) : text;
}
