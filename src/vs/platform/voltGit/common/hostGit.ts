/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * HostGit (B-03, I.5, INV-16): every git process Volt itself runs goes through one wrapper, so a
 * repository (or a sandboxed agent writing into one) can never make Volt run code implicitly:
 *
 * - `-c core.fsmonitor=false`: `git status` and friends never start a repository's fsmonitor.
 * - `-c core.hooksPath=<a path nothing can create>`: no hook runs, unless the call is the user's
 *   own Commit or Push and the build-entry guard has no unreviewed hook or config change.
 * - `-c protocol.ext.allow=never`: no `ext::` remote runs a command.
 * - `GIT_CONFIG_NOSYSTEM=1` (POSIX) and `GIT_NO_REPLACE_OBJECTS=1`, and `GIT_DIR`-style variables
 *   from the environment dropped, so the repository git uses is the one the folder holds.
 * - The repository is checked first: its git folder must be `<work tree>/.git`, a linked
 *   worktree's `<common>/worktrees/<name>`, or a submodule's folder, and the common folder must be
 *   the git folder itself or that `<common>`. A planted `commondir` (or `gitdir`) that points git at
 *   another folder's config and hooks is refused, never followed.
 *
 * This file holds the request shape (callers in the workbench reach HostGit through the stdio
 * service) and the pure argument builder; `node/hostGit.ts` runs it.
 */

export interface IHostGitRequest {
	/** Optional id, so the call can be cancelled with `cancelExec(id)`. */
	readonly id?: string;
	/** The folder git runs in: inside the repository's work tree (or a bare repository's folder). */
	readonly cwd: string;
	/** git's arguments. `-C`, `--git-dir` and `--work-tree` are refused: the repository is `cwd`'s. */
	readonly args: readonly string[];
	readonly env?: Record<string, string>;
	/** Written to stdin, then stdin is closed. */
	readonly input?: string;
	readonly timeoutMs?: number;
	/** Output beyond this many bytes per stream fails the call (default 64 MB). */
	readonly maxBytes?: number;
	/**
	 * `user`: the user's own hooks run. Only for the user's own Commit or Push in Volt's commit UI,
	 * and refused while the build-entry guard holds an unreviewed hook or config change.
	 * Default `none`.
	 */
	readonly hooks?: 'none' | 'user';
	/**
	 * Folders the repository's git folder and common folder must be inside, when the caller knows
	 * them (a project and its worktrees' common `.git`). The structural check always applies.
	 */
	readonly expectedRoots?: readonly string[];
	/**
	 * A private repository Volt keeps for a folder outside git (snapshots): git runs with it as the
	 * git folder and `cwd` as the work tree. It must be a plain git folder (no `commondir`).
	 */
	readonly gitDir?: string;
}

export interface IHostGitResult {
	/** Null when git did not run to completion. */
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	/** Why git did not run, or did not finish: a refusal, not found, timed out, too much output. */
	readonly error?: string;
	/** The repository check (or the guard) refused the call; git never ran. */
	readonly refused?: boolean;
	readonly timedOut?: boolean;
}

/** One execution-bearing file that changed since a sandboxed writer started (I.6). */
export interface IBuildEntryChange {
	/** Absolute path. */
	readonly path: string;
	/** `git`: git config, hooks and the files that redirect git; `build`: tasks, scripts, installs, setup. */
	readonly group: 'git' | 'build';
	readonly kind: 'added' | 'changed' | 'removed';
	/** Text before and after, when small and text (else undefined). */
	readonly before?: string;
	readonly after?: string;
}

/**
 * What Volt is about to run for the user from a folder a sandboxed writer worked in (I.6): their
 * commit or push hooks, worktree setup, or a Run target (script, task, launch).
 */
export type BuildEntryPurpose = 'commit' | 'push' | 'setup' | 'run';

/** The changes `purpose` would run: hooks and git config for a commit or push; everything for setup and Run. */
export function relevantBuildEntryChanges(changes: readonly IBuildEntryChange[], purpose: BuildEntryPurpose): IBuildEntryChange[] {
	return purpose === 'commit' || purpose === 'push' ? changes.filter(change => change.group === 'git') : [...changes];
}

/**
 * The review a process needs before it starts, from who it runs for and why (`IVoltExecContext`):
 * project-defined setup that runs outside any sandbox (`worktree-setup` for an unsandboxed chat)
 * waits for the build-entry review. Inside a sandbox the guard has nothing to protect: what runs
 * there is held to the sandbox. Undefined: no review.
 */
export function buildEntryPurposeOf(reason: string, sandboxed: boolean): BuildEntryPurpose | undefined {
	return !sandboxed && reason === 'worktree-setup' ? 'setup' : undefined;
}

/** Subcommands that talk to a remote (and may need credentials or ssh). */
const REMOTE_COMMANDS = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote', 'remote', 'submodule', 'archive']);

/** Leading options that move git to another repository: the repository must be `cwd`'s. */
const REDIRECTING_OPTIONS = /^(?:-C|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path)(?:=|$)/;

/** Keys a caller's own `-c` may not set: they are what keeps the repository's code from running. */
const GUARDED_KEYS = /^(?:core\.fsmonitor|core\.hookspath|protocol\.|core\.sshcommand|core\.alternaterefscommand|uploadpack\.|receive\.|include\.|includeif\.)/i;

/** The subcommand: the first argument that is not a global option (or a `-c` value). */
export function gitSubcommand(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '-c' || arg === '-C' || arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace' || arg === '--config-env') {
			i++;
			continue;
		}
		if (!arg.startsWith('-')) {
			return arg;
		}
	}
	return undefined;
}

export function isRemoteGitCommand(args: readonly string[]): boolean {
	const sub = gitSubcommand(args);
	return !!sub && REMOTE_COMMANDS.has(sub);
}

/** Why the arguments cannot go through HostGit, or undefined. */
export function hostGitArgsError(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith('-')) {
			return undefined;
		}
		if (REDIRECTING_OPTIONS.test(arg)) {
			return `HostGit runs git in the folder it is given; \`${arg.split('=')[0]}\` is not allowed`;
		}
		if (arg === '-c' || arg === '--config-env') {
			const value = args[i + 1] ?? '';
			if (GUARDED_KEYS.test(value.split('=')[0])) {
				return `HostGit sets \`${value.split('=')[0]}\` itself`;
			}
			i++;
		}
	}
	return undefined;
}

export interface IHostGitArgsOptions {
	/** A folder no hook can be put in (`/dev/null` on POSIX); undefined when the user's hooks run. */
	readonly hooksPath: string | undefined;
	/** For commands that talk to a remote: the user's own ssh command (global config) or `ssh`. */
	readonly sshCommand?: string;
	/** For commands that talk to a remote: the system config's credential helpers, which `GIT_CONFIG_NOSYSTEM` drops. */
	readonly credentialHelpers?: readonly string[];
}

/** The full argument list: Volt's guards first, then the caller's (which may not touch them). */
export function hostGitArgs(args: readonly string[], options: IHostGitArgsOptions): string[] {
	const out = ['-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never'];
	if (options.hooksPath !== undefined) {
		out.push('-c', `core.hooksPath=${options.hooksPath}`);
	}
	if (isRemoteGitCommand(args)) {
		if (options.sshCommand) {
			out.push('-c', `core.sshCommand=${options.sshCommand}`);
		}
		for (const helper of options.credentialHelpers ?? []) {
			out.push('-c', `credential.helper=${helper}`);
		}
	}
	return [...out, ...args];
}

/** Variables that point git at another repository, config or object store. Never inherited. */
export const HOST_GIT_DROPPED_ENV: readonly string[] = [
	'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
	'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_SYSTEM', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
	'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR', 'GIT_REPLACE_REF_BASE', 'GIT_EXTERNAL_DIFF',
];

const CONFIG_ENV = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/;

/** Why a caller's own environment cannot go through HostGit (config it may not set that way), or undefined. */
export function hostGitEnvError(extra: Readonly<Record<string, string>> | undefined): string | undefined {
	for (const [key, value] of Object.entries(extra ?? {})) {
		if (/^GIT_CONFIG_KEY_\d+$/.test(key) && GUARDED_KEYS.test(value)) {
			return `HostGit sets \`${value}\` itself`;
		}
	}
	return undefined;
}

/**
 * The environment for one call: the base (the user's), minus redirects and inherited config, plus
 * the caller's (which may carry config such as a clone's auth header, never a guarded key) and
 * Volt's own.
 */
export function hostGitEnv(base: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>> | undefined, platform: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined && !HOST_GIT_DROPPED_ENV.includes(key) && !CONFIG_ENV.test(key)) {
			env[key] = value;
		}
	}
	for (const [key, value] of Object.entries(extra ?? {})) {
		// A caller may pick a temporary index (commits by hunks), never another repository.
		if (!HOST_GIT_DROPPED_ENV.includes(key) || key === 'GIT_CONFIG_COUNT') {
			env[key] = value;
		}
	}
	env.GIT_NO_REPLACE_OBJECTS = '1';
	env.GIT_TERMINAL_PROMPT ??= '0';
	// Git for Windows keeps line endings, the credential manager and TLS settings in its system config.
	if (platform !== 'win32') {
		env.GIT_CONFIG_NOSYSTEM = '1';
	}
	return env;
}

/** Path separators normalised and trailing ones dropped, for comparisons. */
function norm(path: string): string {
	const p = path.replace(/\\/g, '/');
	return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function parentOf(path: string): string {
	const p = norm(path);
	const at = p.lastIndexOf('/');
	return at <= 0 ? '/' : p.slice(0, at);
}

function baseOf(path: string): string {
	const p = norm(path);
	return p.slice(p.lastIndexOf('/') + 1);
}

function inside(path: string, root: string, fold: boolean): boolean {
	const a = fold ? norm(path).toLowerCase() : norm(path);
	const b = fold ? norm(root).toLowerCase() : norm(root);
	return b === '/' || a === b || a.startsWith(`${b}/`);
}

export interface IGitLayout {
	/** The work tree's top folder; undefined for a bare repository. */
	readonly toplevel?: string;
	readonly gitDir: string;
	readonly commonDir: string;
	/**
	 * Where `<toplevel>/.git` leads: its real path (a folder or a symlink), or the folder its `gitdir:`
	 * line names (`--separate-git-dir`, older submodules). The sandbox protects that entry.
	 */
	readonly dotGit?: string;
}

/**
 * Why a repository's layout (real paths) is not one git makes on its own, or undefined when it is.
 * `fold`: compare case-insensitively (macOS, Windows).
 */
export function hostGitLayoutError(layout: IGitLayout, expectedRoots: readonly string[] | undefined, fold: boolean): string | undefined {
	const same = (a: string, b: string) => fold ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
	const { toplevel, gitDir, commonDir } = layout;
	const linked = baseOf(parentOf(gitDir)) === 'worktrees' && same(parentOf(parentOf(gitDir)), commonDir);
	if (!same(commonDir, gitDir) && !linked) {
		return `its git folder ${gitDir} points at another folder for config and hooks (${commonDir})`;
	}
	if (toplevel !== undefined && !linked) {
		// Its own `.git` (or where that entry leads), or a submodule's folder inside the superproject's `.git/modules`.
		const own = same(gitDir, `${norm(toplevel)}/.git`) || (layout.dotGit !== undefined && same(gitDir, layout.dotGit));
		const submodule = /\/\.git\/modules\//i.test(norm(gitDir)) || /\/\.git\/worktrees\/[^/]+\/modules\//i.test(norm(gitDir));
		if (!own && !submodule) {
			return `the work tree ${toplevel} uses a git folder elsewhere (${gitDir})`;
		}
	}
	if (expectedRoots?.length) {
		for (const path of [gitDir, commonDir, ...(toplevel ? [toplevel] : [])]) {
			if (!expectedRoots.some(root => inside(path, root, fold))) {
				return `${path} is outside the project`;
			}
		}
	}
	return undefined;
}

/** A short unified diff of each change, for the review that runs before Volt executes them. */
export function formatBuildEntryDiff(changes: readonly IBuildEntryChange[], maxLinesPerFile = 40): string {
	const out: string[] = [];
	for (const change of changes) {
		out.push(`${change.kind === 'added' ? 'Added' : change.kind === 'removed' ? 'Removed' : 'Changed'}: ${change.path}`);
		if (change.before === undefined && change.after === undefined) {
			out.push('  (binary or large file)');
			continue;
		}
		const before = change.before === undefined ? [] : change.before.split('\n');
		const after = change.after === undefined ? [] : change.after.split('\n');
		let start = 0;
		while (start < before.length && start < after.length && before[start] === after[start]) {
			start++;
		}
		let endBefore = before.length;
		let endAfter = after.length;
		while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
			endBefore--;
			endAfter--;
		}
		const lines = [...before.slice(start, endBefore).map(line => `- ${line}`), ...after.slice(start, endAfter).map(line => `+ ${line}`)];
		out.push(...lines.slice(0, maxLinesPerFile));
		if (lines.length > maxLinesPerFile) {
			out.push(`  ... ${lines.length - maxLinesPerFile} more lines`);
		}
	}
	return out.join('\n');
}
