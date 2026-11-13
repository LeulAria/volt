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
	/** False: the network broker says no "Allow" may be offered for it (a private address, the prompt budget spent). */
	readonly promptable?: boolean;
	/**
	 * B-34: the broker's own record of the refusal. Only a denial with one gets "Allow" buttons; an
	 * approval names it and the epoch, and the broker rebuilds the rule from its record.
	 */
	readonly denialId?: string;
	/** The grant epoch the broker refused at (compare-and-swap on approval). */
	readonly epoch?: number;
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
		// libc opens the login-record database on every process start (setutxent), so every sandboxed command logs it.
		|| /^\/(private\/)?var\/run\/utmpx?$/.test(target)
		|| /^\/(private\/)?var\/folders\//.test(target);
}

/** Shell startup files: every shell the agent starts reads them, and they often hold tokens, so they stay denied. */
const SHELL_STARTUP_FILE = /^\.(?:zshrc|zshenv|zprofile|zlogin|zlogout|bashrc|bash_profile|bash_login|bash_logout|profile|inputrc|kshrc|mkshrc)$/;
const SHELL_PROCESS = /^-?(?:zsh|bash|sh|dash|ksh|mksh|fish|tcsh|csh)$/;
/** Home folders a shell reads its framework from at startup. */
const SHELL_STARTUP_DIR = /^(?:\.config\/fish|\.oh-my-zsh|\.zsh|\.zim|\.zinit|\.zprezto|\.antigen|\.bash_it|\.local\/share\/fish)(?:\/|$)/;
/**
 * Credential files a tool reads by itself every time it starts (npm's and yarn's config, curl's
 * and git's netrc, pip's index config, docker's config): denied, but not something the agent
 * asked for. By the tool that reads them; any other process reading them (`cat ~/.npmrc`) is.
 */
const TOOL_STARTUP_SECRETS: readonly { readonly file: RegExp; readonly process: RegExp }[] = [
	{ file: /^\.npmrc$/, process: /^(?:node|npm|npx|pnpm|yarn|corepack|bun|deno)$/ },
	{ file: /^\.yarnrc(?:\.yml)?$/, process: /^(?:node|yarn|corepack|npm|npx|pnpm)$/ },
	{ file: /^_?netrc$|^\.netrc$/, process: /^(?:git|git-remote-https?|curl|wget|node|python\d*(?:\.\d+)?|pip\d*)$/ },
	{ file: /^\.pypirc$/, process: /^(?:python\d*(?:\.\d+)?|pip\d*|twine|uv|poetry|pdm|hatch)$/ },
	{ file: /^\.docker\/config\.json$/, process: /^(?:docker|docker-credential-[\w-]+|com\.docker\.[\w.-]+)$/ },
];

/** Commands that read a folder or file because they were told to: their read of an ancestor folder is the agent's own (a card). */
const EXPLICIT_READER = /^(?:ls|find|tree|du|stat|cat|head|tail|less|more|file|wc|bat|eza|exa|lsd|open|xxd|od|strings)$/;
/** What a tool looks for in each folder above the one it works in: git's repository discovery, ignore files. */
const ANCESTOR_PROBE_NAME = /^(?:\.git|\.hg|\.svn|\.gitignore|\.ignore|\.rgignore|\.fdignore|\.editorconfig|\.npmrc|\.yarnrc(?:\.yml)?|\.nvmrc|\.node-version|\.tool-versions|\.python-version|package\.json|pyproject\.toml|tsconfig\.json|\.prettierrc(?:\.[a-z]+)?|\.eslintrc(?:\.[a-z]+)?)$/;

/**
 * A denial that stays denied but gets no card (DENY-QUIET-1): reads a shell, a tool or the agent
 * CLI makes of its own accord, which every sandboxed turn would otherwise show:
 * - a shell's startup files (`~/.zshrc`, `~/.config/fish/...`) read by the shell;
 * - a credential file a tool reads at every start (`~/.npmrc` by npm) read by that tool;
 * - the home folder, or a folder above the workspace or an allowed folder, listed or probed (git's
 *   repository discovery, ignore files, the CLI scanning its surroundings) by anything but a
 *   command that lists or reads what it is told (`ls ~`, `cat ~/x`).
 * - the agent CLI's own background state outside its overlay (`own`, from its footprint's
 *   `quietPaths`), read or written by the CLI's own process, and the folders on the way to it;
 *   its `readPaths` (other CLIs' skills and settings it scans) for reads only.
 * A read by another process (the agent running `cat ~/.zshrc`), any other write, or one with no
 * process named (Linux reports none: then only the shell files count) still gets its card. The
 * caller logs quiet ones.
 */
export function isQuietDenial(denial: ISandboxDenial, home: string, roots: readonly string[] = [], own?: { readonly processes: readonly string[]; readonly paths: readonly string[]; readonly readPaths?: readonly string[] }): boolean {
	const process = denial.process?.replace(/^.*\//, '');
	// A CLI shipped as one binary per release names its process `grok-1.0.77-macos-aarch64`.
	if (own && process !== undefined && own.processes.some(name => process === name || process.startsWith(`${name}-`)) && (denial.kind === 'read' || denial.kind === 'write')) {
		const touched = denial.target.replace(/\/+$/, '');
		// A file's temp siblings (`version.json.WHr5lQ.tmp`, written then renamed over it) count as the file.
		const paths = denial.kind === 'read' ? [...own.paths, ...(own.readPaths ?? [])] : own.paths;
		if (paths.some(path => touched === path || touched.startsWith(`${path}/`) || touched.startsWith(`${path}.`) || (denial.kind === 'read' && isPathAbove(touched, path, home)))) {
			return true;
		}
	}
	if (denial.kind !== 'read' || !home) {
		return false;
	}
	if (denial.target.startsWith(`${home}/`)) {
		const relative = denial.target.slice(home.length + 1);
		if (SHELL_STARTUP_FILE.test(relative) || SHELL_STARTUP_DIR.test(relative)) {
			return process === undefined || SHELL_PROCESS.test(process);
		}
		if (process !== undefined && TOOL_STARTUP_SECRETS.some(entry => entry.file.test(relative) && entry.process.test(process))) {
			return true;
		}
	}
	if (process === undefined || EXPLICIT_READER.test(process)) {
		return false;
	}
	const target = denial.target.replace(/\/+$/, '');
	const slash = target.lastIndexOf('/');
	const parent = slash > 0 ? target.slice(0, slash) : '/';
	const ancestors = ancestorFolders([home, ...roots]);
	return ancestors.has(target) || (ancestors.has(parent) && ANCESTOR_PROBE_NAME.test(target.slice(slash + 1)));
}

/** `home` and every folder above the given roots (not `/`), and `home` itself. */
function ancestorFolders(roots: readonly string[]): Set<string> {
	const out = new Set<string>();
	for (const [index, root] of roots.entries()) {
		let current = root.replace(/\/+$/, '');
		// The home folder counts itself; a workspace or allowed folder only its parents.
		if (index > 0) {
			current = current.slice(0, Math.max(0, current.lastIndexOf('/')));
		}
		while (current && current !== '/' && !out.has(current)) {
			out.add(current);
			current = current.slice(0, Math.max(0, current.lastIndexOf('/')));
		}
	}
	return out;
}

/** `folder` is above `path` and inside `home` (not `home` itself, which has its own rule). */
function isPathAbove(folder: string, path: string, home: string): boolean {
	return !!home && folder.startsWith(`${home}/`) && path.startsWith(`${folder}/`);
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
