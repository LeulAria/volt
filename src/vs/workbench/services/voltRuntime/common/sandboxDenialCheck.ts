/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Text of a tool's result that says the OS may have refused it: a file or a connection the sandbox
 * kept out, or a command that ended with an error. The kernel's refusals of a sandboxed agent are
 * read on demand (no resident `log stream`), and these are the moments to read them.
 */
const REFUSAL_HINT = /operation not permitted|permission denied|\bEPERM\b|\bEACCES\b|read-only file system|sandbox|denied|not allowed|exit (?:code|status) [1-9]|exited with (?:code )?[1-9]|could not resolve host|connection refused|failed to connect|\bENOTFOUND\b|\bECONNREFUSED\b|getaddrinfo|network is unreachable|no route to host/i;

/** How much of a result is searched: refusals are named near the start of a command's error. */
const SCAN_CHARS = 64_000;

/** Whether a finished tool call may have been refused by the OS sandbox, so its refusals should be read now. */
export function sandboxRefusalLikely(result: unknown, error: string | undefined): boolean {
	if (error) {
		return true;
	}
	const text = resultText(result);
	return !!text && REFUSAL_HINT.test(text);
}

function resultText(result: unknown): string {
	if (result === undefined || result === null) {
		return '';
	}
	if (typeof result === 'string') {
		return result.slice(0, SCAN_CHARS);
	}
	try {
		return (JSON.stringify(result) ?? '').slice(0, SCAN_CHARS);
	} catch {
		return '';
	}
}
