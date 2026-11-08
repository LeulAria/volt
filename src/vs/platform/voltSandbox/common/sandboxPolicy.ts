/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CREDENTIAL_HOME_PATHS, credentialDenyEntries, PROTECTED_GIT_PATTERNS, PROTECTED_ROOT_NAMES } from './sandboxProfiles.js';
import { IVoltSandboxPolicy } from './sandboxSchema.js';

/**
 * Per-chat sandbox settings for agent processes, and the agent profile built from them. Pure: the
 * node side resolves `agentSandboxPolicy` and runs it through the SandboxManager; the renderer
 * decides levels per chat and uses `resolveSandboxPlan` for its own checks.
 *
 * Unlike Codex and Claude Code, which sandbox only the shell commands an agent runs, Volt wraps
 * the whole agent process tree, so the agent's own file tools are confined too. That makes the
 * agent CLI's state folders (sessions, auth, caches) part of the policy: without them it breaks.
 */

export type VoltSandboxLevel = 'off' | 'workspace-write' | 'read-only';

export const VOLT_SANDBOX_LEVELS: readonly VoltSandboxLevel[] = ['off', 'workspace-write', 'read-only'];

export function normalizeSandboxLevel(value: unknown): VoltSandboxLevel {
	return value === 'workspace-write' || value === 'read-only' ? value : 'off';
}

/** What a chat asks for. Stored per chat; new chats copy the default settings. */
export interface IVoltSandboxSettings {
	readonly level: VoltSandboxLevel;
	/** Outbound network for the agent's commands. The agent's own API stays reachable either way. */
	readonly network: boolean;
	/** Folders the user allowed from a denial ("Allow this folder"), on top of the workspace. */
	readonly extraWritableRoots?: readonly string[];
	/** Hosts the user allowed from a blocked request while network is off. */
	readonly allowedDomains?: readonly string[];
}

/** Sent with a spawn: the main process wraps the command in the OS sandbox. */
export interface IVoltSandboxRequest {
	readonly level: Exclude<VoltSandboxLevel, 'off'>;
	readonly network: boolean;
	/** Volt provider id (`claude-code`, `cursor-acp`, ...): picks the agent's state folders and API hosts. */
	readonly providerId: string;
	/** The chat's workspace or worktree, and its git common dir when that lives elsewhere. Writable in `workspace-write`. */
	readonly workspaceRoots: readonly string[];
	/** Folders the user allowed from a denial. Writable at every level. */
	readonly extraWritableRoots?: readonly string[];
	/** Extra hosts allowed while network is off. */
	readonly allowedDomains?: readonly string[];
	/** Loopback ports the agent must reach directly (Volt's MCP server). */
	readonly loopbackPorts?: readonly number[];
}

/** Machine facts the plan needs; the main process fills them. */
export interface ISandboxHostInfo {
	readonly platform: 'darwin' | 'linux' | 'win32' | string;
	readonly home: string;
	/** `os.tmpdir()` (on macOS the per-user `/var/folders/.../T`). */
	readonly tmpdir: string;
	/** `getconf DARWIN_USER_CACHE_DIR` on macOS. */
	readonly darwinUserCacheDir?: string;
	readonly uid?: number;
}

/** A resolved plan: paths are absolute and normalized (no trailing slash). */
export interface ISandboxPlan {
	readonly level: Exclude<VoltSandboxLevel, 'off'>;
	/** Folders writable with everything below them. */
	readonly writableSubpaths: readonly string[];
	/** Single files writable (plus atomic-write siblings: `<file>.lock`, `<file>.tmp.*`, `<file>.backup*`). */
	readonly writableFiles: readonly string[];
	/** Never writable, even inside a writable folder: code that runs later outside the sandbox. */
	readonly denyWriteSubpaths: readonly string[];
	readonly denyWriteFiles: readonly string[];
	/** Secrets the agent has no business reading. */
	readonly denyReadSubpaths: readonly string[];
	/** `all`: unrestricted. `proxy`: only loopback, so traffic must go through Volt's filtering proxy. */
	readonly network: 'all' | 'proxy';
	/** Hosts the proxy lets through when network is `proxy`. Wildcards: `*.example.com`. */
	readonly allowedDomains: readonly string[];
	readonly loopbackPorts: readonly number[];
}

/** Files that run as code later, outside any sandbox: the same set the OS profiles protect. */
const DANGEROUS_ROOT_NAMES = PROTECTED_ROOT_NAMES;
const GIT_DIR_DANGEROUS = ['config', 'config.worktree', 'hooks', 'modules', 'commondir', 'gitdir', 'info', 'objects/info/alternates', 'objects/info/http-alternates'];
const DANGEROUS_GIT_NAMES = GIT_DIR_DANGEROUS.map(name => `.git/${name}`);

/** Credentials no agent needs, for the renderer-side checks (the OS profile uses `credentialDenyEntries`). */
const SECRET_HOME_DIRS = CREDENTIAL_HOME_PATHS.filter(path => path !== 'Library/Keychains');

interface IAgentFootprint {
	/** Folders under the home directory the CLI writes (sessions, auth, caches). */
	readonly homeDirs: readonly string[];
	/** Files under the home directory written in place (atomic writes go through siblings). */
	readonly homeFiles?: readonly string[];
	/**
	 * Paths under the home directory that hold code, hooks or installs the CLI (or Volt) runs
	 * later: never writable, even inside `homeDirs`.
	 */
	readonly protectedHome?: readonly string[];
	/** The CLI's own credentials: readable by this agent, denied to every other one. */
	readonly credentials?: readonly string[];
	/** Absolute temp folders keyed off the uid (`claude-<uid>`). */
	readonly tmpDirs?: (uid: number | undefined) => readonly string[];
	/** API hosts the agent must reach to work at all. */
	readonly domains: readonly string[];
	/** Environment variables the CLI reads its keys and endpoints from, copied even though they look secret. */
	readonly envKeys?: readonly string[];
	/** Fixed environment for a sandboxed run (turn off self-updates that would write executables). */
	readonly env?: Readonly<Record<string, string>>;
}

/** State every CLI writes; shared caches are not here (see `SANDBOX_CACHE_ENV`). */
const SHARED_HOME_DIRS = ['.local/state'];
const NPM_DOMAINS = ['registry.npmjs.org'];

/**
 * Package and tool caches redirected to a sandbox-only folder. The shared ones (`~/.npm`,
 * `~/.cache`, `~/Library/Caches`, Bun's cache) hold code the host runs later, including the npx
 * copies of the ACP adapters Volt itself launches, so a sandboxed agent must not write them.
 */
const SANDBOX_CACHE_ENV: Readonly<Record<string, string>> = {
	npm_config_cache: 'npm',
	XDG_CACHE_HOME: 'xdg',
	BUN_INSTALL_CACHE_DIR: 'bun',
	PIP_CACHE_DIR: 'pip',
	YARN_CACHE_FOLDER: 'yarn',
	npm_config_store_dir: 'pnpm-store',
	UV_CACHE_DIR: 'uv',
	GOCACHE: 'go-build',
};

const AGENT_FOOTPRINTS: Readonly<Record<string, IAgentFootprint>> = {
	'claude-code': {
		homeDirs: ['.claude', '.config/claude', 'Library/Caches/claude-cli-nodejs'],
		homeFiles: ['.claude.json'],
		// `.local/share/claude` and `.claude/local` hold the CLI's own binaries; plugins carry hooks.
		protectedHome: ['.claude/settings.json', '.claude/settings.local.json', '.claude/commands', '.claude/agents', '.claude/hooks', '.claude/plugins', '.claude/local', '.local/share/claude'],
		credentials: ['.claude/.credentials.json'],
		tmpDirs: uid => [`/private/tmp/claude-${uid ?? 0}`, `/tmp/claude-${uid ?? 0}`, '/private/tmp/cc-socks', '/tmp/cc-socks'],
		domains: ['api.anthropic.com', '*.anthropic.com', 'claude.ai', '*.claude.ai', 'claude.com', '*.claude.com', 'sentry.io', '*.sentry.io'],
		envKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
		env: { DISABLE_AUTOUPDATER: '1' },
	},
	codex: {
		homeDirs: ['.codex'],
		protectedHome: ['.codex/config.toml', '.codex/rules'],
		credentials: ['.codex/auth.json'],
		domains: ['chatgpt.com', '*.chatgpt.com', 'api.openai.com', '*.openai.com', 'auth.openai.com'],
		envKeys: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'],
	},
	'cursor-acp': {
		homeDirs: ['.cursor', '.config/cursor', 'Library/Application Support/Cursor/User/globalStorage'],
		// cli-config.json is the CLI's own state (it saves the chosen model), so it stays writable under ~/.cursor.
		protectedHome: ['.cursor/mcp.json', '.cursor/hooks.json', '.cursor/hooks', '.cursor/extensions', '.local/share/cursor-agent'],
		domains: ['cursor.com', '*.cursor.com', 'cursor.sh', '*.cursor.sh', 'cursorapi.com', '*.cursorapi.com'],
		envKeys: ['CURSOR_API_KEY'],
	},
	grok: {
		homeDirs: ['.grok'],
		protectedHome: ['.grok/hooks', '.grok/mcp.json'],
		domains: ['x.ai', '*.x.ai', 'grok.com', '*.grok.com'],
		envKeys: ['XAI_API_KEY', 'GROK_API_KEY'],
	},
	opencode: {
		// OpenCode 2 keeps credentials and sessions in `.local/share/opencode/opencode.db` and its CLI settings in `.config/opencode/cli.json`.
		homeDirs: ['.local/share/opencode', '.config/opencode', '.opencode', '.omo', '.local/share/oh-my-opencode', '.claude/transcripts'],
		protectedHome: ['.config/opencode/opencode.json', '.config/opencode/opencode.jsonc', '.config/opencode/cli.json', '.config/opencode/plugin', '.config/opencode/plugins', '.opencode/bin', '.opencode/plugin', '.opencode/plugins'],
		credentials: ['.local/share/opencode/auth.json', '.local/share/opencode/opencode.db'],
		domains: ['opencode.ai', '*.opencode.ai', 'models.dev', 'api.anthropic.com', 'api.openai.com', 'openrouter.ai', '*.openrouter.ai', 'generativelanguage.googleapis.com', 'api.x.ai', 'api.deepseek.com', 'api.moonshot.ai', 'api.z.ai'],
		envKeys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'ZAI_API_KEY', 'OPENCODE_API_KEY'],
	},
	antigravity: {
		homeDirs: ['.gemini', '.antigravity', '.config/antigravity'],
		credentials: ['.gemini/oauth_creds.json'],
		domains: ['*.googleapis.com', 'accounts.google.com', 'oauth2.googleapis.com'],
		envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT'],
	},
	pi: {
		// `.pi/agent/auth.json` stays writable: Pi refreshes its OAuth tokens there.
		homeDirs: ['.pi'],
		protectedHome: ['.pi/agent/settings.json', '.pi/agent/models.json', '.pi/agent/mcp.json', '.pi/agent/keybindings.json'],
		credentials: ['.pi/agent/auth.json'],
		domains: ['pi.dev', '*.pi.dev', 'api.anthropic.com', 'api.openai.com', 'chatgpt.com', '*.chatgpt.com', 'auth.openai.com', 'openrouter.ai', '*.openrouter.ai', 'generativelanguage.googleapis.com', 'api.x.ai', 'api.deepseek.com', 'api.moonshot.ai', 'api.z.ai', 'api.groq.com', 'api.mistral.ai', 'api.cerebras.ai'],
		envKeys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'CEREBRAS_API_KEY'],
	},
	kimi: {
		homeDirs: ['.kimi', '.kimi-code'],
		domains: ['*.moonshot.ai', '*.moonshot.cn', 'kimi.com', '*.kimi.com'],
		envKeys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
	},
	muse: {
		homeDirs: ['.muse', '.config/muse'],
		domains: [],
	},
	fx: {
		// Sessions, settings and the shell-startup cache live in `.fx`; `fx login codex` and `fx login grok` reach those services too.
		homeDirs: ['.fx'],
		protectedHome: ['.fx/AGENTS.md', '.fx/skills'],
		domains: ['fx.sh', '*.fx.sh', 'ai-gateway.vercel.sh', 'vercel.com', '*.vercel.com', 'chatgpt.com', '*.chatgpt.com', 'api.openai.com', 'auth.openai.com', 'x.ai', '*.x.ai', 'grok.com', '*.grok.com'],
		envKeys: ['AI_GATEWAY_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY'],
	},
};

/** Every agent's own credential files, so each sandboxed agent can be denied the others'. */
const ALL_AGENT_CREDENTIALS = [...new Set(Object.values(AGENT_FOOTPRINTS).flatMap(footprint => footprint.credentials ?? []))];

/** The agent's API hosts: what stays reachable when the chat's network is off. */
export function agentApiDomains(providerId: string): readonly string[] {
	return [...(AGENT_FOOTPRINTS[providerId]?.domains ?? []), ...NPM_DOMAINS];
}

/** `/a/b/` and `/a//b` as `/a/b`. Relative paths are returned unchanged (and later rejected). */
export function normalizeSandboxPath(path: string): string {
	const trimmed = path.trim().replace(/\/{2,}/g, '/');
	return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

function isAbsolute(path: string): boolean {
	return path.startsWith('/');
}

/** macOS resolves `/tmp` and `/var` through `/private`: Seatbelt checks the resolved path, so both forms go in. */
function withPrivateAliases(path: string, platform: string): string[] {
	if (platform !== 'darwin') {
		return [path];
	}
	for (const prefix of ['/tmp', '/var', '/etc']) {
		if (path === prefix || path.startsWith(`${prefix}/`)) {
			return [path, `/private${path}`];
		}
	}
	if (path.startsWith('/private/tmp') || path.startsWith('/private/var') || path.startsWith('/private/etc')) {
		return [path, path.slice('/private'.length)];
	}
	return [path];
}

function unique(values: Iterable<string>): string[] {
	return [...new Set(values)];
}

/** True when `path` is `root` or below it. */
export function isPathInside(path: string, root: string): boolean {
	const p = normalizeSandboxPath(path);
	const r = normalizeSandboxPath(root);
	return p === r || p.startsWith(r === '/' ? '/' : `${r}/`);
}

/**
 * The full plan for one agent process: the workspace (unless read-only), temp, the agent's own
 * state folders, and the denies that keep a sandboxed agent from planting code that runs later
 * outside the sandbox (git hooks, shell rc files, the CLI's own hook and MCP configs).
 */
export function resolveSandboxPlan(request: IVoltSandboxRequest, host: ISandboxHostInfo): ISandboxPlan {
	const home = normalizeSandboxPath(host.home);
	const footprint = AGENT_FOOTPRINTS[request.providerId];
	const writable: string[] = [];
	const files: string[] = [];
	const usable = (paths: readonly string[] | undefined) => (paths ?? []).map(normalizeSandboxPath).filter(isAbsolute).filter(root => root !== '/' && root !== home);
	const workspace = usable(request.workspaceRoots);
	const extra = usable(request.extraWritableRoots);
	// Folders the user explicitly allowed apply at every level; the workspace only when it may be written.
	const roots = request.level === 'workspace-write' ? [...workspace, ...extra] : extra;
	writable.push(...roots);
	// Temp. The agents and the shells they start all write here (heredocs, diffs, sockets).
	writable.push('/tmp', '/var/tmp', normalizeSandboxPath(host.tmpdir));
	if (host.darwinUserCacheDir) {
		writable.push(normalizeSandboxPath(host.darwinUserCacheDir));
	}
	for (const dir of [...SHARED_HOME_DIRS, ...(footprint?.homeDirs ?? genericHomeDirs(request.providerId))]) {
		writable.push(`${home}/${dir}`);
	}
	for (const file of footprint?.homeFiles ?? []) {
		files.push(`${home}/${file}`);
	}
	writable.push(...(footprint?.tmpDirs?.(host.uid) ?? []));

	const denySubpaths: string[] = [];
	const denyFiles: string[] = [];
	if (request.level === 'read-only') {
		// Read-only holds even when the workspace sits below a writable folder (a repo in /tmp).
		denySubpaths.push(...workspace.filter(root => !extra.some(allowed => isPathInside(root, allowed))));
	}
	for (const root of [...workspace, ...extra]) {
		if (root.endsWith('/.git')) {
			// A worktree's git common dir: its hooks and config run later, outside the sandbox, and
			// `commondir`/`gitdir`/alternates would point git elsewhere.
			denySubpaths.push(`${root}/hooks`, `${root}/modules`, `${root}/info`);
			denyFiles.push(...GIT_DIR_DANGEROUS.filter(name => !['hooks', 'modules', 'info'].includes(name)).map(name => `${root}/${name}`));
			continue;
		}
		// Treated as folders: a folder rule also covers a file of that name.
		for (const name of [...DANGEROUS_ROOT_NAMES, ...DANGEROUS_GIT_NAMES]) {
			denySubpaths.push(`${root}/${name}`);
		}
	}
	for (const name of PROTECTED_ROOT_NAMES.filter(name => name.startsWith('.') && !name.includes('/'))) {
		denyFiles.push(`${home}/${name}`);
	}
	denyFiles.push(`${home}/.config/git/config`, `${home}/.ssh/config`, `${home}/.ssh/authorized_keys`);
	for (const path of footprint?.protectedHome ?? []) {
		(/\.[a-z]+$/i.test(path) ? denyFiles : denySubpaths).push(`${home}/${path}`);
	}

	const network = request.network ? 'all' : 'proxy';
	return {
		level: request.level,
		writableSubpaths: unique(writable.flatMap(path => withPrivateAliases(normalizeSandboxPath(path), host.platform))),
		writableFiles: unique(files.flatMap(path => withPrivateAliases(path, host.platform))),
		denyWriteSubpaths: unique(denySubpaths.flatMap(path => withPrivateAliases(path, host.platform))),
		denyWriteFiles: unique(denyFiles.flatMap(path => withPrivateAliases(path, host.platform))),
		denyReadSubpaths: SECRET_HOME_DIRS.map(dir => `${home}/${dir}`),
		network,
		allowedDomains: network === 'proxy' ? unique([...agentApiDomains(request.providerId), ...(request.allowedDomains ?? [])].map(domain => domain.trim().toLowerCase()).filter(Boolean)) : [],
		loopbackPorts: unique((request.loopbackPorts ?? []).filter(port => Number.isInteger(port) && port > 0 && port < 65536).map(String)).map(Number),
	};
}

/** An agent Volt has no footprint for: its dot folder by provider id, the usual convention. */
function genericHomeDirs(providerId: string): string[] {
	const name = providerId.replace(/-acp$/, '').replace(/[^a-z0-9._-]/gi, '');
	return name ? [`.${name}`, `.config/${name}`, `.local/share/${name}`] : [];
}

/** Machine facts the agent profile needs; the node side fills them. */
export interface IAgentSandboxHost {
	readonly platform: string;
	/** Real path. */
	readonly home: string;
	/** Real temp folders the CLI and its shells write: `os.tmpdir()`, `/tmp`, `/var/tmp`, the macOS user cache dir. */
	readonly tempDirs: readonly string[];
	readonly uid?: number;
	/** Volt's user data: the agent-server token, the host MCP state. No agent may read it. */
	readonly userDataDir?: string;
	/** Private keys in `~/.ssh` (found by content): denied even when `~/.ssh` stays readable for git over SSH. */
	readonly sshPrivateKeys?: readonly string[];
	/** The ssh-agent socket, granted when the chat's network is on. */
	readonly sshAuthSock?: string;
	/** Where sandboxed package caches live (see `SANDBOX_CACHE_ENV`). */
	readonly cacheDir: string;
}

/**
 * The policy an agent CLI process tree runs under. Weaker than the workload profiles by design,
 * because the whole CLI runs inside it:
 * - the whole filesystem is readable except credentials (SSH private keys, cloud and `gh`
 *   credentials, browser profiles, `.env` files, other agents' tokens, Volt's user data);
 * - writable: the workspace (`workspace-write`), folders the user allowed, temp, and the CLI's own
 *   state, minus everything that runs later outside the sandbox;
 * - OS services stay reachable on macOS (Keychain, launchd), with Apple Events, LaunchServices,
 *   synthetic input, the pasteboard, preference writes and signals to other processes denied;
 * - no unix sockets (ssh-agent only with network on); loopback only to the proxy and Volt's MCP
 *   server unless network is on;
 * - the environment is the user's minus anything that looks secret, plus the CLI's own keys.
 */
export function agentSandboxPolicy(request: IVoltSandboxRequest, host: IAgentSandboxHost): IVoltSandboxPolicy {
	const home = normalizeSandboxPath(host.home);
	const footprint = AGENT_FOOTPRINTS[request.providerId];
	const usable = (paths: readonly string[] | undefined) => (paths ?? []).map(normalizeSandboxPath).filter(isAbsolute).filter(root => root !== '/' && !isPathInside(home, root));
	const workspace = usable(request.workspaceRoots);
	const extra = usable(request.extraWritableRoots);
	const at = (relative: string) => `${home}/${relative}`;

	const write = unique([
		...(request.level === 'workspace-write' ? workspace : []),
		...extra,
		...host.tempDirs,
		...(footprint?.tmpDirs?.(host.uid) ?? []),
		...[...SHARED_HOME_DIRS, ...(footprint?.homeDirs ?? genericHomeDirs(request.providerId)), ...(footprint?.homeFiles ?? [])].map(at),
		host.cacheDir,
	]);

	const protect: string[] = [];
	for (const root of [...workspace, ...extra]) {
		if (root.endsWith('/.git')) {
			// The rest of this folder is an allow list too (the resolver's `gitDirs`).
			protect.push(...GIT_DIR_DANGEROUS.map(name => `${root}/${name}`));
			continue;
		}
		protect.push(...PROTECTED_ROOT_NAMES.map(name => `${root}/${name}`));
	}
	if (request.level === 'read-only') {
		// Read-only holds even when the workspace sits below a writable folder (a repo in /tmp).
		protect.push(...workspace.filter(root => !extra.some(allowed => isPathInside(root, allowed))));
	}
	protect.push(...(footprint?.protectedHome ?? []).map(at), ...PROTECTED_GIT_PATTERNS);

	const ownCredentials = new Set(footprint?.credentials ?? []);
	const deny = [
		...credentialDenyEntries()
			// Keychain items are guarded by their own access lists; the CLI reads its login from there.
			.filter(entry => entry !== '${home}/Library/Keychains')
			// With network on, ssh needs its config and known_hosts; only the private keys stay denied.
			.filter(entry => !(entry === '${home}/.ssh' && request.network))
			.map(entry => entry.replace(/^\$\{home\}/, home)),
		...(request.network ? (host.sshPrivateKeys ?? []) : []),
		...ALL_AGENT_CREDENTIALS.filter(path => !ownCredentials.has(path)).map(at),
		...(host.userDataDir ? [normalizeSandboxPath(host.userDataDir)] : []),
	];

	const network = request.network
		? { mode: 'host' as const, allow: [], loopbackPorts: [], listen: true }
		: {
			mode: 'proxy' as const,
			allow: unique([...agentApiDomains(request.providerId), ...(request.allowedDomains ?? [])].map(domain => domain.trim().toLowerCase()).filter(domain => domain && domain !== 'localhost')),
			loopbackPorts: unique((request.loopbackPorts ?? []).filter(port => Number.isInteger(port) && port > 0 && port < 65536).map(String)).map(Number),
			listen: true,
		};

	const cacheEnv = Object.fromEntries(Object.entries(SANDBOX_CACHE_ENV).map(([name, sub]) => [name, `${host.cacheDir}/${sub}`]));
	return {
		schemaVersion: 1,
		name: `agent ${request.providerId} ${request.level}`,
		filesystem: { read: ['/'], write, deny: unique(deny), protect: unique(protect), unmask: [] },
		network,
		process: { limits: {} },
		env: { inherit: ['*', ...(footprint?.envKeys ?? [])], set: { ...cacheEnv, ...footprint?.env } },
		// Seatbelt can allow exactly one socket. bubblewrap would have to allow AF_UNIX altogether
		// while the whole filesystem is readable, so on Linux ssh-agent stays out (git over HTTPS works).
		host: { unixSockets: request.network && host.sshAuthSock && host.platform === 'darwin' ? [host.sshAuthSock] : [], systemServices: true },
		// bubblewrap cannot guard paths that do not exist yet; macOS cannot contain a setsid daemon.
		bestEffort: ['filesystem.protectNew', 'process.tree'],
	};
}

/**
 * Whether a write to `path` is allowed by `plan`, the same rule the OS enforces. Used for writes
 * agents route through Volt (ACP `fs/write_text_file`), which happen in Volt's own process.
 */
export function planAllowsWrite(plan: ISandboxPlan, path: string): boolean {
	const target = normalizeSandboxPath(path);
	if (!isAbsolute(target)) {
		return false;
	}
	if (plan.denyWriteFiles.includes(target) || plan.denyWriteSubpaths.some(root => isPathInside(target, root))) {
		return false;
	}
	if (plan.writableFiles.some(file => target === file || isAtomicSibling(target, file))) {
		return true;
	}
	return plan.writableSubpaths.some(root => isPathInside(target, root));
}

/** `~/.claude.json.lock`, `~/.claude.json.tmp.123.ab`, `~/.claude.json.backup`: how CLIs write a file atomically. */
function isAtomicSibling(target: string, file: string): boolean {
	return target.startsWith(`${file}.`) && /^\.(lock|tmp|backup|bak|swp)/.test(target.slice(file.length));
}

/** `api.anthropic.com` against `*.anthropic.com`, `anthropic.com` and exact names. */
export function domainAllowed(host: string, allowed: readonly string[]): boolean {
	const name = host.trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
	if (!name) {
		return false;
	}
	if (name === 'localhost' || name === '127.0.0.1' || name === '::1' || name.endsWith('.localhost')) {
		return true;
	}
	return allowed.some(pattern => {
		const p = pattern.trim().toLowerCase();
		if (p === '*') {
			return true;
		}
		if (p.startsWith('*.')) {
			const base = p.slice(2);
			return name === base || name.endsWith(`.${base}`);
		}
		return name === p;
	});
}

/**
 * How a provider is sandboxed at a level.
 * - `wrap`: Volt wraps the whole agent process tree (Seatbelt / Landlock).
 * - `native`: the agent's own sandbox, configured by Volt (Codex: its per-command Seatbelt, with
 *   escalation prompts that reach Volt's approval UI). macOS refuses nested sandboxes
 *   (`sandbox_apply: Operation not permitted`), so the two are never stacked.
 * - `none`: no sandbox.
 */
export type SandboxStrategy = 'wrap' | 'native' | 'none';

export function sandboxStrategy(providerId: string, level: VoltSandboxLevel, platform: string): SandboxStrategy {
	if (level === 'off' || platform === 'win32') {
		return 'none';
	}
	if (providerId === 'codex' && level === 'workspace-write') {
		return 'native';
	}
	return 'wrap';
}

/** Extra CLI arguments that switch an agent's own sandbox off while Volt wraps it (nesting fails on macOS). */
export function nativeSandboxOffArgs(providerId: string): readonly string[] {
	return providerId === 'cursor-acp' ? ['--sandbox', 'disabled'] : [];
}

/** One-line summary for tooltips and logs. */
export function describeSandbox(settings: IVoltSandboxSettings): string {
	if (settings.level === 'off') {
		return 'No sandbox: the agent can write anywhere your user can.';
	}
	const where = settings.level === 'read-only' ? 'Read-only: the agent cannot change your files' : 'Writes stay inside the workspace';
	return `${where}; network ${settings.network ? 'on' : 'off (only the agent\'s own API)'}.`;
}

// --- Per chat settings ------------------------------------------------------------------------

export const DEFAULT_SANDBOX_SETTINGS: IVoltSandboxSettings = { level: 'off', network: true };

/** Settings read back from storage: unknown fields dropped, paths and hosts cleaned. */
export function normalizeSandboxSettings(value: unknown): IVoltSandboxSettings {
	const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
	const strings = (list: unknown) => Array.isArray(list) ? [...new Set(list.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim()))] : [];
	const extra = strings(raw.extraWritableRoots).map(normalizeSandboxPath).filter(isAbsolute);
	const domains = strings(raw.allowedDomains).map(domain => domain.toLowerCase());
	return {
		level: normalizeSandboxLevel(raw.level),
		network: raw.network !== false,
		...(extra.length ? { extraWritableRoots: extra } : {}),
		...(domains.length ? { allowedDomains: domains } : {}),
	};
}

/**
 * What the agent process was started with. A chat whose key changed needs a new process (the OS
 * profile is fixed at launch); allowed hosts are not in it, the proxy takes those live.
 */
export function sandboxLaunchKey(settings: IVoltSandboxSettings | undefined): string {
	if (!settings || settings.level === 'off') {
		return 'off';
	}
	return JSON.stringify([settings.level, settings.network, [...(settings.extraWritableRoots ?? [])].sort()]);
}

/** The settings with one more folder the agent may write. */
export function withWritableRoot(settings: IVoltSandboxSettings, folder: string): IVoltSandboxSettings {
	const path = normalizeSandboxPath(folder);
	if (!isAbsolute(path) || (settings.extraWritableRoots ?? []).some(root => isPathInside(path, root))) {
		return settings;
	}
	return { ...settings, extraWritableRoots: [...(settings.extraWritableRoots ?? []).filter(root => !isPathInside(root, path)), path] };
}

/** The settings with one more host reachable while network is off. */
export function withAllowedDomain(settings: IVoltSandboxSettings, host: string): IVoltSandboxSettings {
	const name = host.trim().toLowerCase();
	if (!name || domainAllowed(name, settings.allowedDomains ?? [])) {
		return settings;
	}
	return { ...settings, allowedDomains: [...(settings.allowedDomains ?? []), name] };
}

/**
 * Folders an agent may write for a chat: its checkout, plus the main repository's `.git` when the
 * checkout is a linked worktree (commits, the index and refs live there).
 */
export function sandboxWorkspaceRoots(cwd: string | undefined, projectRoot: string | undefined, worktree: boolean): string[] {
	const roots: string[] = [];
	if (cwd) {
		roots.push(normalizeSandboxPath(cwd));
	}
	if (worktree && projectRoot) {
		roots.push(`${normalizeSandboxPath(projectRoot)}/.git`);
	}
	return roots.filter(isAbsolute);
}

/** The loopback port of an `http://127.0.0.1:<port>/...` URL (Volt's MCP server), if it is one. */
export function loopbackPort(url: string | undefined): number | undefined {
	const match = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/i.exec(url ?? '');
	const port = match ? Number(match[1]) : NaN;
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

// --- Codex's own sandbox --------------------------------------------------------------------

/**
 * Codex config and session-mode values Volt sends, adjusted for the chat's sandbox.
 * - `native` (workspace-write): Codex's own Seatbelt / Landlock does the job per command, and its
 *   escalation requests reach Volt's approval UI. Full access is never chosen.
 * - `wrap` (read-only): Volt confines the whole tree, so Codex's per-command sandbox must stay
 *   off; macOS refuses a second sandbox inside one that denies anything.
 */
export function codexSandboxValue(id: string, value: string | boolean, strategy: SandboxStrategy): string | boolean {
	if (strategy === 'none' || typeof value !== 'string') {
		return value;
	}
	if (id === 'mode') {
		if (strategy === 'wrap') {
			return 'agent-full-access';
		}
		return value === 'agent-full-access' ? 'agent' : value;
	}
	if (id === 'sandbox' || id === 'sandbox_mode') {
		if (strategy === 'wrap') {
			return 'danger-full-access';
		}
		return value === 'danger-full-access' ? 'workspace-write' : value;
	}
	return value;
}
