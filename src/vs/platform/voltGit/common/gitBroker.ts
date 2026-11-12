/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The git broker's pure rules (spec I.5, INV-16): which git commands a plugin may run through
 * HostGit, the capability each needs (`git.read`, `git.write`, `git.push`), and the arguments it
 * may pass. The broker itself is `node/gitBroker.ts`.
 *
 * A caller names a subcommand and its arguments, nothing before it: no `-c`, `-C`, `--git-dir`,
 * `--exec-path` or `--config-env`, so no config (`core.*`, hooks, fsmonitor, credential helpers,
 * editors) can be set per call. Options that run a program (`--upload-pack`, `--receive-pack`,
 * `--exec`, `--ext-diff`, `--textconv`, `-x`), read or write a file anywhere (`--output`,
 * `--no-index`, `--contents`, `-F`, `--template`, `--pathspec-from-file`), or point git elsewhere
 * (`--repo`, `--work-tree`) are refused anywhere in the list. A command not listed here (`config`,
 * `remote add`, `submodule`, aliases) is refused.
 */

export type GitBrokerCapability = 'git.read' | 'git.write' | 'git.push';

export const GIT_BROKER_LIMITS = Object.freeze({
	args: 64,
	argLength: 4096,
	/** Output per stream. */
	outputBytes: 16 * 1024 * 1024,
	timeoutMs: 120_000,
	/** git processes one principal runs at once. */
	concurrent: 4,
	input: 1024 * 1024,
});

const READ_COMMANDS = ['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'cat-file', 'describe', 'shortlog', 'merge-base', 'for-each-ref', 'ls-tree', 'rev-list', 'show-ref', 'name-rev', 'grep'];
const WRITE_COMMANDS = ['add', 'rm', 'mv', 'restore', 'commit', 'checkout', 'switch', 'branch', 'tag', 'reset', 'stash', 'merge', 'rebase', 'cherry-pick', 'revert', 'fetch', 'pull'];

/** Commands that talk to a remote: the remote must be one the repository names, and allowed. */
export const GIT_BROKER_REMOTE_COMMANDS: readonly string[] = ['fetch', 'pull', 'push'];

/** Diff-like commands: Volt adds `--no-ext-diff --no-textconv` (config-named programs never run). */
const DIFF_COMMANDS = new Set(['diff', 'log', 'show']);

/** Options refused for every command (the part before `=`). Global options never get past the subcommand check. */
const DENIED_OPTIONS = new Set([
	'--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path', '--config-env', '--config',
	'--upload-pack', '--receive-pack', '--exec', '--repo',
	'--ext-diff', '--textconv', '--output', '--output-directory', '--open-files-in-pager', '--show-signature',
	'--no-index', '--contents', '--file', '--template', '--pathspec-from-file', '--exclude-from',
	'--interactive', '--edit', '--strategy', '--gpg-sign', '--sign',
]);

/** Exact options that are also the start of a refused one (`--exclude` of `--exclude-from`). */
const ALLOWED_PREFIXES = new Set(['--exclude']);

/** Short and long options refused per command (they read files, run programs or open an editor there). */
const DENIED_PER_COMMAND: Readonly<Record<string, readonly string[]>> = {
	commit: ['-F', '-t', '-e', '-p', '-S', '-C', '-c', '--patch', '--reedit-message', '--reuse-message'],
	tag: ['-F', '-e', '-s', '-u'],
	rebase: ['-x', '-i', '-s', '-S'],
	merge: ['-s', '-e', '-S', '-F'],
	'cherry-pick': ['-e', '-S', '-x'],
	revert: ['-e', '-S'],
	pull: ['-s', '-S', '-e'],
	add: ['-i', '-p', '-e', '--patch'],
	checkout: ['-p', '--patch'],
	restore: ['-p', '--patch'],
	reset: ['-p', '--patch'],
	stash: ['-p', '--patch'],
	grep: ['-O', '-f'],
	blame: ['-S'],
	'ls-files': ['-X'],
};

/** Options under which `git branch` and `git tag` only list. */
const LIST_OPTIONS = /^(?:-a|-r|-l|-v|-vv|--all|--remotes|--list|--verbose|--show-current|--no-color|--column|--no-column|--format=.*|--sort=.*|--merged(?:=.*)?|--no-merged(?:=.*)?|--contains=.*|--no-contains=.*|--points-at=.*|-n\d*)$/;

export class GitBrokerArgsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GitBrokerArgsError';
	}
}

export interface IGitBrokerCommand {
	readonly subcommand: string;
	readonly capability: GitBrokerCapability;
	/** The arguments HostGit gets (Volt's additions included). */
	readonly args: readonly string[];
	/** For a remote command: the remote's name. */
	readonly remote?: string;
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The command a plugin asked for, checked and classified; a {@link GitBrokerArgsError} when refused. */
export function gitBrokerCommand(raw: unknown): IGitBrokerCommand {
	if (!Array.isArray(raw) || !raw.length) {
		throw new GitBrokerArgsError('args must name a git command and its arguments');
	}
	if (raw.length > GIT_BROKER_LIMITS.args) {
		throw new GitBrokerArgsError(`at most ${GIT_BROKER_LIMITS.args} arguments`);
	}
	for (const arg of raw) {
		if (typeof arg !== 'string') {
			throw new GitBrokerArgsError('every argument must be a string');
		}
		if (arg.length > GIT_BROKER_LIMITS.argLength || arg.includes('\0')) {
			throw new GitBrokerArgsError('an argument is too long or has a NUL');
		}
	}
	const args = raw as string[];
	const subcommand = args[0];
	if (subcommand.startsWith('-')) {
		throw new GitBrokerArgsError(`${subcommand.split('=')[0]}: git's global options are Volt's to set, never the caller's`);
	}
	const capability: GitBrokerCapability | undefined = subcommand === 'push' ? 'git.push' : READ_COMMANDS.includes(subcommand) ? 'git.read' : WRITE_COMMANDS.includes(subcommand) ? 'git.write' : undefined;
	if (!capability) {
		throw new GitBrokerArgsError(`git ${subcommand} is not available through the git broker`);
	}
	const denied = DENIED_PER_COMMAND[subcommand] ?? [];
	for (const arg of args.slice(1)) {
		if (arg === '--') {
			break;
		}
		if (!arg.startsWith('-') || arg === '-') {
			continue;
		}
		const name = arg.split('=')[0];
		// Also refused as an abbreviation git would expand (`--upload-p`); git itself is told to refuse abbreviations too.
		const abbreviates = (option: string) => name.startsWith('--') && name.length >= 5 && option.startsWith(name) && !ALLOWED_PREFIXES.has(name);
		if (DENIED_OPTIONS.has(name) || [...DENIED_OPTIONS].some(abbreviates) || denied.includes(name) || denied.filter(option => option.startsWith('--')).some(abbreviates)) {
			throw new GitBrokerArgsError(`${name} is not allowed for git ${subcommand} through the git broker`);
		}
		if (!arg.startsWith('--')) {
			// A cluster of short options (`-fx`): every letter counts, even one that would be a value.
			for (const letter of arg.slice(1)) {
				if (denied.includes(`-${letter}`)) {
					throw new GitBrokerArgsError(`-${letter} is not allowed for git ${subcommand} through the git broker`);
				}
			}
		}
	}
	let remote: string | undefined;
	if (GIT_BROKER_REMOTE_COMMANDS.includes(subcommand)) {
		remote = args.slice(1).find(arg => !arg.startsWith('-'));
		if (!remote) {
			throw new GitBrokerArgsError(`git ${subcommand} through the git broker names its remote`);
		}
		if (!REMOTE_NAME.test(remote)) {
			throw new GitBrokerArgsError(`${remote} is not the name of a remote: a URL or a path is never pushed to or fetched from directly`);
		}
	}
	if (subcommand === 'branch' || subcommand === 'tag') {
		// Listing is a read; anything else (a name, a delete, a move, an upstream) writes refs.
		const listing = args.slice(1).every(arg => LIST_OPTIONS.test(arg)) && (subcommand === 'branch' || args.includes('-l') || args.includes('--list'));
		return { subcommand, capability: listing ? 'git.read' : 'git.write', args };
	}
	const extra = DIFF_COMMANDS.has(subcommand) ? ['--no-ext-diff', '--no-textconv'] : subcommand === 'grep' ? ['--no-textconv'] : [];
	return { subcommand, capability, args: [subcommand, ...extra, ...args.slice(1)], ...(remote ? { remote } : {}) };
}

/** Environment for a broker call: no editor, pager or askpass program from config ever runs. */
export const GIT_BROKER_ENV: Readonly<Record<string, string>> = Object.freeze({
	GIT_EDITOR: 'true',
	GIT_SEQUENCE_EDITOR: 'true',
	GIT_PAGER: 'cat',
	PAGER: 'cat',
	GIT_TERMINAL_PROMPT: '0',
	GIT_OPTIONAL_LOCKS: '0',
	// git refuses abbreviated long options, so `--upload-p` is never `--upload-pack`.
	GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS: '1',
});

/**
 * A remote URL as a `git.push` target: `host/path` without user, port 22/443, scheme or `.git`
 * (`git@github.com:acme/app.git` and `https://x@github.com/acme/app` are `github.com/acme/app`);
 * `file:<path>` for a local repository. Undefined: a transport the broker never uses (`ext::`,
 * `fd::`, any `<transport>::`, or an unparsable URL).
 */
export function gitRemoteTarget(url: string): { readonly target: string; readonly local?: string } | undefined {
	const value = url.trim();
	if (!value || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(value)) {
		return undefined;
	}
	const strip = (path: string) => path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
	const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(value);
	if (scp && !/^[A-Za-z]:[\\/]/.test(value)) {
		return { target: `${scp[1].toLowerCase()}/${strip(scp[2])}` };
	}
	if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
		return { target: `file:${value}`, local: value };
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return undefined;
	}
	switch (parsed.protocol) {
		case 'file:': {
			const path = decodeURIComponent(parsed.pathname);
			return { target: `file:${path}`, local: path };
		}
		case 'https:': case 'http:': case 'ssh:': case 'git:': {
			const port = parsed.port && !['22', '443', '80', '9418'].includes(parsed.port) ? `:${parsed.port}` : '';
			return { target: `${parsed.hostname.toLowerCase()}${port}/${strip(decodeURIComponent(parsed.pathname))}` };
		}
	}
	return undefined;
}
