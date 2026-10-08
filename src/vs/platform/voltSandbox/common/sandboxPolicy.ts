/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * OS sandbox policy for agent processes. Pure: the main process turns a plan into a Seatbelt
 * profile (macOS) or Landlock rules (Linux); the renderer decides levels per chat.
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

/** Files that run as code later, outside any sandbox (srt's mandatory denies, plus Volt's own). */
const DANGEROUS_ROOT_FILES = ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.zshenv', '.profile', '.ripgreprc', '.mcp.json'];
const DANGEROUS_ROOT_DIRS = ['.git/hooks', '.vscode', '.idea', '.claude/commands', '.claude/agents', '.cursor/hooks', '.volt/hooks'];
const DANGEROUS_ROOT_EXACT = ['.git/config', '.claude/settings.json', '.claude/settings.local.json', '.cursor/hooks.json', '.cursor/mcp.json', '.volt/hooks.json'];

/** Credentials no agent needs (git over SSH still works: `~/.ssh` stays readable). */
const SECRET_HOME_DIRS = ['.aws', '.gnupg', '.kube', '.config/gcloud', '.azure', '.docker/config.json', '.netrc', '.npmrc', '.pypirc'];

interface IAgentFootprint {
	/** Folders under the home directory the CLI writes (sessions, auth, caches, installs). */
	readonly homeDirs: readonly string[];
	/** Files under the home directory written in place (atomic writes go through siblings). */
	readonly homeFiles?: readonly string[];
	/** Paths under the home directory that hold code or hooks the CLI runs: never writable. */
	readonly protectedHome?: readonly string[];
	/** Absolute temp folders keyed off the uid (`claude-<uid>`). */
	readonly tmpDirs?: (uid: number | undefined) => readonly string[];
	/** API hosts the agent must reach to work at all. */
	readonly domains: readonly string[];
}

/** Every agent goes through npx or a package manager cache at some point. */
const SHARED_HOME_DIRS = ['.npm', '.cache', 'Library/Caches', '.bun/install/cache', '.local/state'];
const NPM_DOMAINS = ['registry.npmjs.org'];

const AGENT_FOOTPRINTS: Readonly<Record<string, IAgentFootprint>> = {
	'claude-code': {
		homeDirs: ['.claude', '.config/claude', '.local/share/claude'],
		homeFiles: ['.claude.json'],
		protectedHome: ['.claude/settings.json', '.claude/settings.local.json', '.claude/commands', '.claude/agents', '.claude/hooks'],
		tmpDirs: uid => [`/private/tmp/claude-${uid ?? 0}`, `/tmp/claude-${uid ?? 0}`, '/private/tmp/cc-socks', '/tmp/cc-socks'],
		domains: ['api.anthropic.com', '*.anthropic.com', 'claude.ai', '*.claude.ai', 'claude.com', '*.claude.com', 'sentry.io', '*.sentry.io'],
	},
	codex: {
		homeDirs: ['.codex'],
		protectedHome: ['.codex/config.toml', '.codex/rules'],
		domains: ['chatgpt.com', '*.chatgpt.com', 'api.openai.com', '*.openai.com', 'auth.openai.com'],
	},
	'cursor-acp': {
		homeDirs: ['.cursor', '.config/cursor', '.local/share/cursor-agent', 'Library/Application Support/Cursor/User/globalStorage'],
		protectedHome: ['.cursor/mcp.json', '.cursor/hooks.json', '.cursor/hooks', '.cursor/cli-config.json'],
		domains: ['cursor.com', '*.cursor.com', 'cursor.sh', '*.cursor.sh', 'cursorapi.com', '*.cursorapi.com'],
	},
	grok: {
		homeDirs: ['.grok'],
		protectedHome: ['.grok/hooks', '.grok/mcp.json'],
		domains: ['x.ai', '*.x.ai', 'grok.com', '*.grok.com'],
	},
	opencode: {
		homeDirs: ['.local/share/opencode', '.config/opencode', '.opencode', '.omo', '.local/share/oh-my-opencode', '.claude/transcripts'],
		protectedHome: ['.config/opencode/opencode.json', '.config/opencode/opencode.jsonc', '.config/opencode/plugin', '.config/opencode/plugins'],
		domains: ['opencode.ai', '*.opencode.ai', 'models.dev', 'api.anthropic.com', 'api.openai.com', 'openrouter.ai', '*.openrouter.ai', 'generativelanguage.googleapis.com', 'api.x.ai', 'api.deepseek.com', 'api.moonshot.ai', 'api.z.ai'],
	},
	antigravity: {
		homeDirs: ['.gemini', '.antigravity', '.config/antigravity'],
		domains: ['*.googleapis.com', 'accounts.google.com', 'oauth2.googleapis.com'],
	},
	kimi: {
		homeDirs: ['.kimi', '.kimi-code'],
		domains: ['*.moonshot.ai', '*.moonshot.cn', 'kimi.com', '*.kimi.com'],
	},
	muse: {
		homeDirs: ['.muse', '.config/muse'],
		domains: [],
	},
};

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
			// A worktree's git common dir: its hooks and config run later, outside the sandbox.
			denySubpaths.push(`${root}/hooks`);
			denyFiles.push(`${root}/config`);
			continue;
		}
		for (const dir of DANGEROUS_ROOT_DIRS) {
			denySubpaths.push(`${root}/${dir}`);
		}
		for (const file of [...DANGEROUS_ROOT_FILES, ...DANGEROUS_ROOT_EXACT]) {
			denyFiles.push(`${root}/${file}`);
		}
	}
	for (const file of DANGEROUS_ROOT_FILES) {
		denyFiles.push(`${home}/${file}`);
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

/** Environment for a wrapped agent: says it is sandboxed and routes HTTP through Volt's proxy. */
export function sandboxEnv(plan: ISandboxPlan, proxyUrl: string | undefined, tag: string): Record<string, string> {
	const env: Record<string, string> = {
		VOLT_SANDBOX: plan.level,
		VOLT_SANDBOX_TAG: tag,
	};
	if (plan.network === 'proxy') {
		env.VOLT_SANDBOX_NETWORK_DISABLED = '1';
		// Codex's convention; tools that know it skip network tests.
		env.CODEX_SANDBOX_NETWORK_DISABLED = '1';
	}
	if (proxyUrl) {
		const noProxy = 'localhost,127.0.0.1,::1,.localhost';
		Object.assign(env, {
			HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl,
			ALL_PROXY: proxyUrl, all_proxy: proxyUrl,
			NO_PROXY: noProxy, no_proxy: noProxy,
			// Node 24+ fetch honours the variables above only with this set.
			NODE_USE_ENV_PROXY: '1',
			npm_config_proxy: proxyUrl, npm_config_https_proxy: proxyUrl,
		});
	}
	return env;
}

/** One-line summary for tooltips and logs. */
export function describeSandbox(settings: IVoltSandboxSettings): string {
	if (settings.level === 'off') {
		return 'No sandbox: the agent can write anywhere your user can.';
	}
	const where = settings.level === 'read-only' ? 'Read-only: the agent cannot change your files' : 'Writes stay inside the workspace';
	return `${where}; network ${settings.network ? 'on' : 'off (only the agent\'s own API)'}.`;
}
