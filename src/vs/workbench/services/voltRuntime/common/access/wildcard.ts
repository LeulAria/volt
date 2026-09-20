/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

function normalize(value: string): string {
	return value.replaceAll('\\', '/');
}

function escapeRegExp(value: string): string {
	return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles a resource/action pattern once. Fast paths avoid RegExp for the
 * common literal and trailing-prefix cases.
 */
export function compilePattern(pattern: string): (input: string) => boolean {
	const raw = normalize(pattern);
	if (!raw || raw === '*') {
		return () => true;
	}

	const hasWildcard = /[*?]/.test(raw);
	if (!hasWildcard) {
		return input => normalize(input) === raw;
	}

	if (raw.endsWith('*') && !raw.includes('?') && raw.indexOf('*') === raw.length - 1) {
		const prefix = raw.slice(0, -1);
		return input => normalize(input).startsWith(prefix);
	}

	const escaped = escapeRegExp(raw)
		.replace(/\*\*/g, '\u0000')
		.replace(/\*/g, '[^/]*')
		.replace(/\u0000/g, '.*')
		.replace(/\?/g, '.');
	const regex = new RegExp(`^${escaped}$`, 's');
	return input => regex.test(normalize(input));
}

export function matchWildcard(input: string, pattern: string): boolean {
	return compilePattern(pattern)(input);
}

export function alwaysAllowPattern(action: string, resource: string): string {
	if (action === 'shell' || action === 'git') {
		const tokens = resource.trim().split(/\s+/).filter(Boolean);
		if (tokens.length <= 1) {
			return tokens[0] ? `${tokens[0]} *` : '*';
		}
		if (tokens[0] === 'git' || tokens[0] === 'npm' || tokens[0] === 'pnpm' || tokens[0] === 'yarn') {
			return `${tokens.slice(0, Math.min(2, tokens.length)).join(' ')} *`;
		}
		return `${tokens[0]} *`;
	}
	if (action === 'edit' || action === 'read') {
		const slash = Math.max(resource.lastIndexOf('/'), resource.lastIndexOf('\\'));
		if (slash > 0) {
			return `${resource.slice(0, slash)}/**`;
		}
	}
	return resource || '*';
}
