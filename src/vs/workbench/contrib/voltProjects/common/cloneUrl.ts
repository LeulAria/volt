/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IParsedCloneUrl {
	/** What git is given. `owner/repo` shorthand becomes a GitHub HTTPS URL. */
	readonly url: string;
	/** Default folder name: the repo name without `.git`. */
	readonly name: string;
	readonly host?: string;
	readonly owner?: string;
	readonly repo?: string;
}

export type CloneUrlError = 'empty' | 'unsafe' | 'unsupported';

const SHORTHAND = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([\w.-]+?)(?:\.git)?$/;
const SCP_LIKE = /^([\w.-]+)@([\w.-]+):(.+)$/;

/**
 * Parses what the user typed into "Clone from Git URL". Accepts https/ssh/git URLs, scp-style
 * `git@host:owner/repo`, and GitHub `owner/repo` shorthand. Rejects option injection, control
 * characters, and transports that run commands (`ext::`).
 */
export function parseCloneUrl(input: string): IParsedCloneUrl | CloneUrlError {
	const value = input.trim();
	if (!value) {
		return 'empty';
	}
	if (value.startsWith('-') || /[\u0000-\u001f\u007f\s]/.test(value) || /^[a-z][a-z0-9+.-]*::/i.test(value)) {
		return 'unsafe';
	}
	const shorthand = SHORTHAND.exec(value);
	if (shorthand && !value.includes(':')) {
		const [, owner, repo] = shorthand;
		return { url: `https://github.com/${owner}/${repo}.git`, name: sanitizeFolderName(repo), host: 'github.com', owner, repo };
	}
	const scp = SCP_LIKE.exec(value);
	if (scp && !value.includes('://')) {
		const [, , host, path] = scp;
		return { url: value, ...fromPath(host, path) };
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return 'unsupported';
	}
	if (!/^(https?|ssh|git):$/.test(parsed.protocol)) {
		return 'unsupported';
	}
	let path = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, '');
	let url = value;
	if (parsed.hostname === 'github.com' && /^https?:$/.test(parsed.protocol)) {
		// A browser URL such as github.com/owner/repo/tree/main still means the repo.
		const [owner, repo] = path.split('/');
		if (!owner || !repo) {
			return 'unsupported';
		}
		path = `${owner}/${repo}`;
		url = `https://github.com/${owner}/${repo.replace(/\.git$/, '')}.git`;
	}
	if (!path) {
		return 'unsupported';
	}
	return { url, ...fromPath(parsed.hostname, path) };
}

function fromPath(host: string, path: string): Omit<IParsedCloneUrl, 'url'> {
	const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);
	const repo = (segments.at(-1) ?? '').replace(/\.git$/, '');
	const owner = segments.length > 1 ? segments.at(-2) : undefined;
	return { name: sanitizeFolderName(repo) || host, host, owner, repo };
}

/** A folder name that is safe on every OS. */
export function sanitizeFolderName(name: string): string {
	return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^\.+/, '').trim();
}

/** `parent` + `name`, where `parent` is the folder the user picked. Cloning into `~/code` means `~/code/<repo>`. */
export function resolveCloneDestination(parent: string, name: string): string {
	const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
	const base = parent.length > 1 ? parent.replace(/[\\/]+$/, '') : parent;
	return base.endsWith(separator) ? `${base}${name}` : `${base}${separator}${name}`;
}

/** `name`, or `name-2`, `name-3`... the first one not in `taken`. */
export function nextFreeName(name: string, taken: ReadonlySet<string>): string {
	if (!taken.has(name)) {
		return name;
	}
	for (let i = 2; ; i++) {
		const candidate = `${name}-${i}`;
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
}

/** Two remotes name the same repo, ignoring protocol, user, `.git`, and case of the host. */
export function sameRemote(a: string | undefined, b: string | undefined): boolean {
	return !!a && !!b && remoteKey(a) === remoteKey(b);
}

function remoteKey(url: string): string {
	const value = url.trim();
	const scp = SCP_LIKE.exec(value);
	let host: string;
	let path: string;
	if (scp && !value.includes('://')) {
		host = scp[2];
		path = scp[3];
	} else {
		try {
			const parsed = new URL(value);
			host = parsed.hostname;
			path = parsed.pathname;
		} catch {
			return value.toLowerCase();
		}
	}
	return `${host.toLowerCase()}/${path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').toLowerCase()}`;
}
