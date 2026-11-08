/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { promisify } from 'util';
import { basename, dirname, isAbsolute, join, resolve } from '../../../base/common/path.js';
import { SandboxUnavailableError } from '../common/sandboxBackend.js';
import { isReservedEnvName, isSecretEnvName, systemReadPaths } from '../common/sandboxProfiles.js';
import { IResolvedPattern, IResolvedSandboxPolicy } from '../common/sandboxResolved.js';
import { IVoltSandboxPolicy } from '../common/sandboxSchema.js';

const execFileAsync = promisify(execFile);

/** Facts about this machine the resolver needs. Gathered once. */
export interface ISandboxHostFacts {
	readonly platform: string;
	readonly arch: string;
	/** Real path of the home folder. */
	readonly home: string;
	/** Real path of `os.tmpdir()` (on macOS the per-user `/private/var/folders/.../T`). */
	readonly tmpRoot: string;
	/** macOS: the real path of `xcode-select -p`, whose `Contents` the `/usr/bin` shims load from. */
	readonly developerDir?: string;
}

export async function sandboxHostFacts(platform: string = process.platform): Promise<ISandboxHostFacts> {
	const home = await fs.realpath(homedir()).catch(() => homedir());
	const tmpRoot = await fs.realpath(tmpdir()).catch(() => tmpdir());
	let developerDir: string | undefined;
	if (platform === 'darwin') {
		developerDir = await execFileAsync('/usr/bin/xcode-select', ['-p'], { timeout: 5_000 })
			.then(r => fs.realpath(r.stdout.trim()))
			.catch(() => undefined);
	}
	return { platform, arch: process.arch, home, tmpRoot, developerDir };
}

/** What one run is about. */
export interface ISandboxRunContext {
	/** The folders `${workspace}` stands for. */
	readonly workspaceRoots: readonly string[];
	readonly cwd?: string;
	/** What `${storage}` stands for (created if missing). */
	readonly storageDir?: string;
	/** The environment `env.inherit` copies from. Nothing else of it reaches the workload. */
	readonly hostEnv: Readonly<Record<string, string | undefined>>;
	/** Variables Volt itself sets for this run (provider settings). Reserved names are ignored. */
	readonly env?: Readonly<Record<string, string>>;
}

export interface ISandboxResolution {
	readonly policy: IResolvedSandboxPolicy;
	/** Entries dropped or adjusted, for diagnostics. */
	readonly notes: readonly string[];
}

interface ICanonical {
	readonly path: string;
	readonly exists: boolean;
	readonly isDirectory: boolean;
}

/** The real path, or the real path of the nearest existing parent plus the rest. */
export async function canonicalPath(path: string): Promise<ICanonical> {
	try {
		const real = await fs.realpath(path);
		const stat = await fs.stat(real);
		return { path: real, exists: true, isDirectory: stat.isDirectory() };
	} catch {
		// Not there yet.
	}
	const rest: string[] = [];
	let current = path;
	for (let i = 0; i < 128 && current && current !== '/'; i++) {
		rest.unshift(basename(current));
		current = dirname(current);
		try {
			const real = await fs.realpath(current);
			return { path: join(real, ...rest), exists: false, isDirectory: false };
		} catch {
			// Keep climbing.
		}
	}
	return { path, exists: false, isDirectory: false };
}

export function isInside(path: string, root: string): boolean {
	return root === '/' || path === root || path.startsWith(`${root}/`);
}

const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'];

function unique<T>(values: Iterable<T>): T[] {
	return [...new Set(values)];
}

/**
 * Expands and canonicalises a policy for one run. Throws `SandboxUnavailableError` when the
 * policy cannot be applied safely as written (a workspace that is the home folder, a write root
 * of `/`, a working directory the workload could not read).
 */
export async function resolveSandboxPolicy(policy: IVoltSandboxPolicy, context: ISandboxRunContext, host: ISandboxHostFacts, runTmp: string): Promise<ISandboxResolution> {
	const notes: string[] = [];
	const refuse = (message: string): never => { throw new SandboxUnavailableError(message, 'unavailable'); };
	const home = host.home;

	const workspaceRoots: string[] = [];
	for (const root of context.workspaceRoots) {
		if (!isAbsolute(root)) {
			refuse(`Workspace root is not absolute: ${root}`);
		}
		const canonical = await canonicalPath(root);
		if (!canonical.exists || !canonical.isDirectory) {
			notes.push(`workspace root does not exist: ${root}`);
			continue;
		}
		if (canonical.path === '/' || isInside(home, canonical.path)) {
			refuse(`Refusing a workspace that is / or contains the home folder: ${canonical.path}`);
		}
		workspaceRoots.push(canonical.path);
	}
	let storage: string | undefined;
	if (context.storageDir) {
		await fs.mkdir(context.storageDir, { recursive: true, mode: 0o700 });
		storage = (await canonicalPath(context.storageDir)).path;
	}
	await fs.mkdir(join(runTmp, 'home'), { recursive: true, mode: 0o700 });

	const pathDirs = await toolchainDirs(context.hostEnv.PATH, home, notes);
	const systemDirs = (await Promise.all(systemReadPaths(host.platform).map(canonicalPath))).filter(c => c.exists).map(c => c.path);
	if (host.platform === 'darwin' && host.developerDir && host.developerDir.startsWith('/Applications/')) {
		// `/usr/bin/git` and friends are shims that load frameworks from the selected Xcode.
		systemDirs.push(dirname(host.developerDir));
	}

	const expand = (entry: string): string[] => {
		if (entry === '${system}') {
			return systemDirs;
		}
		if (entry === '${path}') {
			return pathDirs;
		}
		const token = /^\$\{(\w+)\}(.*)$/.exec(entry);
		if (!token) {
			return [entry];
		}
		const rest = token[2];
		switch (token[1]) {
			case 'workspace': return workspaceRoots.map(root => root + rest);
			case 'home': return [home + rest];
			case 'tmp': return [runTmp + rest];
			case 'storage': return storage ? [storage + rest] : [];
			default: return [];
		}
	};

	// Reads.
	const readAll = policy.filesystem.read.includes('/');
	const read: string[] = [];
	for (const entry of policy.filesystem.read.filter(e => e !== '/')) {
		for (const path of expand(entry)) {
			const c = await canonicalPath(path);
			if (c.exists) {
				read.push(c.path);
			}
		}
	}

	// Writes: folders, or single files. The run's own temp folder is private to it and always writable.
	const write: string[] = [runTmp];
	const writeFiles: string[] = [];
	for (const entry of policy.filesystem.write) {
		for (const path of expand(entry)) {
			const c = await canonicalPath(path);
			if (c.path === '/' || isInside(home, c.path)) {
				refuse(`Refusing to make ${c.path === '/' ? '/' : 'the home folder or one of its parents'} writable`);
			}
			if (c.exists && c.isDirectory) {
				write.push(c.path);
			} else if (c.exists || /\.[a-z0-9]{1,8}$/i.test(c.path)) {
				writeFiles.push(c.path);
			} else {
				notes.push(`write path does not exist, skipped: ${c.path}`);
			}
		}
	}

	// Denies (credentials), minus what a trusted layer unmasked.
	const unmask = new Set(policy.filesystem.unmask);
	const deny: string[] = [];
	const denyPatterns: IResolvedPattern[] = [];
	const protect: string[] = [];
	const protectPatterns: IResolvedPattern[] = [];
	// Only temp roots themselves skip protect patterns (tests create repositories there); a
	// workspace that merely lives under a temp folder is protected like any other.
	const tempRoots = new Set([runTmp, host.tmpRoot, ...TEMP_ROOTS]);
	const isTemp = (root: string) => tempRoots.has(root);
	const patternRootsFor = (kind: 'deny' | 'protect'): string[] => kind === 'protect'
		? write.filter(root => !isTemp(root))
		: unique(readAll ? ['/'] : [...write, ...read.filter(root => !systemDirs.includes(root) && !pathDirs.includes(root))]);
	for (const [kind, entries] of [['deny', policy.filesystem.deny], ['protect', policy.filesystem.protect]] as const) {
		const paths = kind === 'deny' ? deny : protect;
		const patterns = kind === 'deny' ? denyPatterns : protectPatterns;
		for (const entry of entries) {
			if (unmask.has(entry)) {
				continue;
			}
			if (entry.startsWith('**/')) {
				const names = entry.slice(3).split('/');
				for (const root of patternRootsFor(kind)) {
					patterns.push({ root, names });
				}
				continue;
			}
			for (const path of expand(entry)) {
				const c = await canonicalPath(path);
				paths.push(c.path);
				if (c.path !== path) {
					paths.push(path);
				}
			}
		}
	}

	// Git: the repository's real layout decides what runs later.
	const workspaceWrites = workspaceRoots.filter(root => write.some(w => isInside(root, w)));
	for (const root of workspaceWrites) {
		protect.push(...await gitProtections(root, home, write));
	}
	for (const root of write.filter(w => basename(w) === '.git')) {
		// A linked worktree's common git dir, writable so commits work: its config and hooks are not.
		protect.push(join(root, 'config'), join(root, 'config.worktree'), join(root, 'hooks'), join(root, 'modules'));
		protectPatterns.push({ root, names: ['config.worktree'] });
	}
	const newRepositoryGuard = policy.filesystem.protect.includes('**/.git/config') ? workspaceWrites : [];

	// Sockets.
	const unixSockets: string[] = [];
	for (const entry of policy.host.unixSockets) {
		for (const path of expand(entry)) {
			const c = await canonicalPath(path);
			if (c.exists) {
				unixSockets.push(c.path);
			} else {
				notes.push(`socket does not exist, skipped: ${path}`);
			}
		}
	}

	// Environment: built from nothing.
	const env: Record<string, string> = {};
	for (const name of policy.env.inherit) {
		if (name === '*') {
			for (const [key, value] of Object.entries(context.hostEnv)) {
				if (value !== undefined && !isSecretEnvName(key) && !isReservedEnvName(key)) {
					env[key] = value;
				}
			}
		} else if (context.hostEnv[name] !== undefined && !isReservedEnvName(name)) {
			env[name] = context.hostEnv[name]!;
		}
	}
	const expandValue = (value: string) => value
		.replace(/\$\{tmp\}/g, runTmp)
		.replace(/\$\{home\}/g, home)
		.replace(/\$\{workspace\}/g, workspaceRoots[0] ?? runTmp)
		.replace(/\$\{storage\}/g, storage ?? runTmp);
	for (const [name, value] of Object.entries(policy.env.set)) {
		if (!isReservedEnvName(name)) {
			env[name] = expandValue(value);
		}
	}
	for (const [name, value] of Object.entries(context.env ?? {})) {
		if (!isReservedEnvName(name)) {
			env[name] = value;
		}
	}
	const readable = (dir: string) => readAll || [...read, ...write].some(root => isInside(dir, root));
	if (!env.PATH) {
		const fromHost = (context.hostEnv.PATH ?? '').split(':').filter(dir => isAbsolute(dir) && readable(dir));
		env.PATH = fromHost.length ? unique(fromHost).join(':') : '/usr/bin:/bin:/usr/sbin:/sbin';
	}
	env.TMPDIR ??= runTmp;
	env.HOME ??= readAll ? (context.hostEnv.HOME ?? home) : join(runTmp, 'home');

	// Working directory: the one asked for, else the workspace when the workload can read it, else its temp.
	const usableDir = (dir: string) => readable(dir) && !deny.some(path => isInside(dir, path));
	let cwd = runTmp;
	if (context.cwd) {
		cwd = (await canonicalPath(context.cwd)).path;
		if (!usableDir(cwd)) {
			refuse(`The working directory is not readable inside the sandbox: ${cwd}`);
		}
	} else if (workspaceRoots[0] && usableDir(workspaceRoots[0])) {
		cwd = workspaceRoots[0];
	}

	// Under deny-by-default (not readAll, no system services), a deny outside every readable root and
	// a protection outside every writable root change nothing: the default already refuses both.
	// Dropping them makes the profile smaller (about 20 ms of Seatbelt compile time) and binds fewer paths.
	let finalDeny = unique(deny);
	let finalProtect = unique(protect);
	if (!readAll && !policy.host.systemServices) {
		const reachable = [...read, ...write, ...writeFiles];
		const overlaps = (path: string, roots: readonly string[]) => roots.some(root => isInside(path, root) || isInside(root, path));
		finalDeny = finalDeny.filter(path => overlaps(path, reachable));
		finalProtect = finalProtect.filter(path => overlaps(path, [...write, ...writeFiles]));
	}

	// Paths reach a Seatbelt profile or bubblewrap arguments; one that cannot be expressed exactly is refused.
	for (const path of [...read, ...write, ...writeFiles, ...deny, ...protect, ...unixSockets, cwd, ...denyPatterns.map(p => p.root), ...protectPatterns.map(p => p.root)]) {
		if (/["\u0000-\u001f\u007f]/.test(path)) {
			refuse(`Paths with a double quote or a control character cannot be sandboxed: ${JSON.stringify(path)}`);
		}
	}

	return {
		policy: {
			name: policy.name ?? 'custom',
			platform: host.platform,
			readAll,
			read: unique(read),
			write: unique(write),
			writeFiles: unique(writeFiles),
			deny: finalDeny,
			protect: finalProtect,
			denyPatterns,
			protectPatterns,
			newRepositoryGuard,
			network: {
				mode: policy.network.mode,
				allow: policy.network.mode === 'proxy' ? policy.network.allow : [],
				loopbackPorts: policy.network.mode === 'host' ? [] : policy.network.loopbackPorts,
				listen: policy.network.listen,
			},
			unixSockets: unique(unixSockets),
			systemServices: policy.host.systemServices,
			limits: policy.process.limits,
			env,
			cwd,
			tmp: runTmp,
			home,
		},
		notes,
	};
}

/**
 * `${path}`: install folders of the programs on the host PATH, so a workspace profile can run the
 * user's node, python or cargo. `<prefix>/bin` gives `<prefix>` (libraries live beside it), except
 * where the prefix is a catch-all such as `~/.local` or the home folder.
 */
async function toolchainDirs(pathVar: string | undefined, home: string, notes: string[]): Promise<string[]> {
	const out: string[] = [];
	for (const dir of (pathVar ?? '').split(':')) {
		if (!isAbsolute(dir)) {
			continue;
		}
		const c = await canonicalPath(dir);
		if (!c.exists || !c.isDirectory || c.path === '/' || c.path === home) {
			continue;
		}
		let prefix = c.path;
		const parent = dirname(c.path);
		if ((basename(c.path) === 'bin' || basename(c.path) === 'sbin') && parent !== '/' && parent !== home && parent !== join(home, '.local') && !isInside(home, parent)) {
			prefix = parent;
		}
		if (prefix === '/' || isInside(home, prefix)) {
			notes.push(`PATH entry too broad to expose: ${dir}`);
			continue;
		}
		out.push(prefix);
	}
	return unique(out);
}

/**
 * Paths inside `root` that git runs or trusts later and that the generic protections cannot name:
 * a linked worktree's `.git` pointer file, the worktree's own config, and `core.hooksPath` from
 * the repository's and the user's git config.
 */
async function gitProtections(root: string, home: string, writeRoots: readonly string[]): Promise<string[]> {
	const out: string[] = [];
	const dotGit = join(root, '.git');
	const configs: string[] = [join(home, '.gitconfig'), join(home, '.config', 'git', 'config')];
	const stat = await fs.lstat(dotGit).catch(() => undefined);
	if (stat?.isFile()) {
		out.push(dotGit);
		const pointer = await fs.readFile(dotGit, 'utf8').catch(() => '');
		const gitdir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
		if (gitdir) {
			const dir = resolve(root, gitdir);
			const common = await fs.readFile(join(dir, 'commondir'), 'utf8').then(text => resolve(dir, text.trim())).catch(() => dir);
			configs.push(join(dir, 'config.worktree'), join(common, 'config'));
			for (const path of [join(dir, 'config.worktree'), join(common, 'config'), join(common, 'hooks')]) {
				if (writeRoots.some(w => isInside(path, w))) {
					out.push(path);
				}
			}
		}
	} else if (stat?.isDirectory()) {
		configs.push(join(dotGit, 'config'));
		// Named outright as well as by pattern: bubblewrap binds existing paths, not patterns.
		out.push(join(dotGit, 'config'), join(dotGit, 'config.worktree'), join(dotGit, 'hooks'), join(dotGit, 'modules'));
	}
	for (const config of configs) {
		const text = await fs.readFile(config, 'utf8').catch(() => undefined);
		const hooksPath = text ? gitConfigHooksPath(text) : undefined;
		if (hooksPath) {
			const path = hooksPath.startsWith('~/') ? join(home, hooksPath.slice(2)) : resolve(root, hooksPath);
			out.push(path);
		}
	}
	return out;
}

/** `core.hooksPath` from git config text (the last one wins, as in git). Includes are not followed. */
export function gitConfigHooksPath(text: string): string | undefined {
	let section = '';
	let value: string | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]/.exec(line);
		if (header) {
			section = header[1].toLowerCase();
			continue;
		}
		if (section !== 'core') {
			continue;
		}
		const pair = /^hookspath\s*=\s*(.*)$/i.exec(line);
		if (pair) {
			const v = pair[1].replace(/\s+[#;].*$/, '').trim();
			value = v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
		}
	}
	return value || undefined;
}
