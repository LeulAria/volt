/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Something the sandbox stopped, as the transcript shows it. */
export interface ISandboxDenial {
	readonly kind: 'write' | 'read' | 'network' | 'launch';
	/** Absolute path, or the host for network. */
	readonly target: string;
	/**
	 * Who saw it: `os` the kernel (Seatbelt log), `proxy` Volt's network proxy, `volt` a write the
	 * agent routed through Volt, `output` an error message in a command's output.
	 */
	readonly source: 'os' | 'proxy' | 'volt' | 'output';
	/** The process that tried (`touch`, `node`), when known. */
	readonly process?: string;
}

/** Seatbelt operation names as denial kinds. */
export function denialKindForOperation(operation: string): ISandboxDenial['kind'] | undefined {
	if (operation.startsWith('file-write')) {
		return 'write';
	}
	if (operation.startsWith('file-read')) {
		return 'read';
	}
	if (operation.startsWith('network')) {
		return 'network';
	}
	if (operation === 'lsopen' || operation.startsWith('appleevent') || operation === 'mach-lookup') {
		return 'launch';
	}
	return undefined;
}

const OUTPUT_PATTERNS: readonly RegExp[] = [
	// BSD tools and shells: `touch: /x/y: Operation not permitted`, `sh: /x/y: Operation not permitted`
	/(?:^|\n)[^\n:]*?:\s*(\/[^\n:]+?):\s*(?:Operation not permitted|Read-only file system)/g,
	// GNU: `touch: cannot touch '/x/y': Permission denied`, `mkdir: cannot create directory '/x': Read-only file system`
	/cannot (?:touch|create(?: regular file| directory)?|remove|open|move|write)[^'"\u2018\n]*['"\u2018]([^'"\u2019\n]+)['"\u2019]:\s*(?:Permission denied|Operation not permitted|Read-only file system)/g,
	// Python: `PermissionError: [Errno 1] Operation not permitted: '/x/y'`
	/\[Errno (?:1|13|30)\] (?:Operation not permitted|Permission denied|Read-only file system): ['"]([^'"\n]+)['"]/g,
	// Node: `EPERM: operation not permitted, open '/x/y'`
	/E(?:PERM|ACCES|ROFS): [^,\n]*, \w+ ['"]([^'"\n]+)['"]/g,
	// Volt's own refusal for writes routed through it.
	/Blocked by Volt sandbox: (\/[^\s'"]+)/g,
];

/**
 * Write denials named in a command's output. Only called for chats that run sandboxed, where
 * "Operation not permitted" on a path outside the workspace is almost always the sandbox.
 */
export function denialsInOutput(output: string): ISandboxDenial[] {
	const found = new Map<string, ISandboxDenial>();
	if (!/not permitted|Permission denied|Read-only file system|EPERM|EACCES|EROFS|Volt sandbox/i.test(output)) {
		return [];
	}
	for (const pattern of OUTPUT_PATTERNS) {
		pattern.lastIndex = 0;
		for (let match = pattern.exec(output); match; match = pattern.exec(output)) {
			const target = match[1].trim();
			if (target.startsWith('/') && !found.has(target)) {
				found.set(target, { kind: 'write', target, source: 'output' });
			}
		}
	}
	const blockedHost = /Blocked by Volt sandbox: network access to ([\w.-]+)/g;
	for (let match = blockedHost.exec(output); match; match = blockedHost.exec(output)) {
		found.set(`net:${match[1]}`, { kind: 'network', target: match[1], source: 'output' });
	}
	return [...found.values()];
}

/** Noise the kernel logs for every sandboxed process: not worth a transcript row. */
export function isNoiseDenial(denial: ISandboxDenial): boolean {
	if (denial.kind === 'launch') {
		return false;
	}
	const target = denial.target;
	return !target
		|| target.startsWith('/dev/')
		|| /\/Library\/(Caches|Saved Application State|HTTPStorages|Preferences)\//.test(target)
		|| /\/\.DS_Store$/.test(target)
		|| /^\/private\/var\/db\//.test(target)
		|| /^\/(private\/)?var\/folders\//.test(target);
}

/** The folder "Allow this folder" adds for a denied path: the path itself when it is a folder, else its parent. */
export function folderToAllow(target: string, isDirectory: boolean): string {
	if (isDirectory) {
		return target.replace(/\/+$/, '') || '/';
	}
	const slash = target.lastIndexOf('/');
	return slash > 0 ? target.slice(0, slash) : '/';
}

/** One short line for a denial row: "Blocked a write to ~/notes.txt". */
export function describeDenial(denial: ISandboxDenial, home?: string): string {
	const shown = home && denial.target.startsWith(`${home}/`) ? `~${denial.target.slice(home.length)}` : denial.target;
	switch (denial.kind) {
		case 'write': return `Sandbox blocked a write to ${shown}`;
		case 'read': return `Sandbox blocked reading ${shown}`;
		case 'network': return `Sandbox blocked network access to ${shown}`;
		case 'launch': return `Sandbox blocked launching outside the sandbox${denial.process ? ` (${denial.process})` : ''}`;
	}
}
