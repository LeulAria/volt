/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AGENT_OVERLAYS, IAgentStatePlan } from './agentState.js';
import { AGENT_CONFIG_NAMES, AGENT_ENV_INHERIT, agentSystemReadPaths, CREDENTIAL_HOME_PATHS, credentialDenyEntries, HOME_TOOLCHAIN_PATHS, isSecretEnvName, PROTECTED_GIT_PATTERNS, PROTECTED_ROOT_NAMES } from './sandboxProfiles.js';
import { IVoltSandboxPolicy, SandboxDimension } from './sandboxSchema.js';

/**
 * Per-chat sandbox settings for agent processes, and the agent profile built from them. Pure: the
 * node side resolves `agentSandboxPolicy` and runs it through the SandboxManager; the renderer
 * decides levels per chat and uses `resolveSandboxPlan` for its own checks.
 *
 * Unlike Codex and Claude Code, which sandbox only the shell commands an agent runs, Volt wraps
 * the whole agent process tree, so the agent's own file tools are confined too. That makes the
 * agent CLI's state folders (sessions, auth, caches) part of the policy: without them it breaks.
 * They are listed as allow lists (B-05): what the CLI writes, never its config, which a later
 * unsandboxed run of the same CLI would load.
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
	/**
	 * Loopback ports the user granted the chat (`net.listen:<port>`): its dev servers. The agent may
	 * listen only on these (none by default, B-30), and with the network off the chat's in-app
	 * browser opens local pages only on these ports (B-16).
	 */
	readonly listenPorts?: readonly number[];
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
	/** Loopback ports the agent may listen on (granted one by one). */
	readonly listenPorts?: readonly number[];
	/**
	 * Whose agent state this is (the chat id): picks the per-chat config overlay (agentState.ts).
	 * Without it the CLI's config folder stays read-only and nothing is overlaid.
	 */
	readonly stateKey?: string;
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

/**
 * Where an agent CLI keeps its state, in allow-list form (B-05, INV-17). Paths are relative to the
 * home folder. Nothing else of the home folder is writable, and nothing else is readable beyond
 * the system, the toolchains and the workspace (D-14, narrow reads).
 */
export interface IAgentFootprint {
	/** Folders the CLI writes in place: sessions, logs, caches. Never a CLI's whole folder, never config (see `footprintLintErrors`). */
	readonly writable: readonly string[];
	/** Single files written in place (atomic-write siblings too): lock files, histories, its own login. */
	readonly writableFiles?: readonly string[];
	/** What the CLI reads and never writes: its config, instructions and install. */
	readonly readable: readonly string[];
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

const NPM_DOMAINS = ['registry.npmjs.org'];

/** Volt's own per-chat agent state (config overlays, see agentState.ts), below the home folder. */
export const AGENT_STATE_ROOT = '.volt/sandbox/agent-state';

/**
 * Package and tool caches redirected to a sandbox-only folder. The shared ones (`~/.npm`,
 * `~/.cache`, `~/Library/Caches`, Bun's cache) hold code the host runs later, including the npx
 * copies of the ACP adapters Volt itself launches, so a sandboxed agent must not write them.
 */
export const SANDBOX_CACHE_ENV: Readonly<Record<string, string>> = {
	npm_config_cache: 'npm',
	XDG_CACHE_HOME: 'xdg',
	BUN_INSTALL_CACHE_DIR: 'bun',
	PIP_CACHE_DIR: 'pip',
	YARN_CACHE_FOLDER: 'yarn',
	npm_config_store_dir: 'pnpm-store',
	UV_CACHE_DIR: 'uv',
	GOCACHE: 'go-build',
};

/**
 * Claude Code, Codex and Cursor take their config folder from the environment: a sandboxed chat
 * gets a per-chat copy (AGENT_OVERLAYS in agentState.ts), so their footprints here hold only what
 * lives outside it. The others write in place, in the subpaths listed.
 *
 * The built-in provider manifests repeat this table (and AGENT_OVERLAYS) as `contributes.voltAgents[].state`
 * (spec H.12, M2), and `cliAgentParity.test.ts` fails when they differ. The sandbox profile is built
 * from this compiled table, never from a manifest, so a changed `package.json` can't widen it.
 */
export const AGENT_FOOTPRINTS: Readonly<Record<string, IAgentFootprint>> = {
	'claude-code': {
		writable: ['Library/Caches/claude-cli-nodejs', '.cache/claude-cli-nodejs'],
		// The install (`.local/share/claude`, `.claude/local`). Its config folder comes in through the overlay.
		readable: ['.local/share/claude'],
		credentials: ['.claude/.credentials.json'],
		tmpDirs: uid => [`/private/tmp/claude-${uid ?? 0}`, `/tmp/claude-${uid ?? 0}`, '/private/tmp/cc-socks', '/tmp/cc-socks'],
		domains: ['api.anthropic.com', '*.anthropic.com', 'claude.ai', '*.claude.ai', 'claude.com', '*.claude.com', 'sentry.io', '*.sentry.io'],
		envKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
		env: { DISABLE_AUTOUPDATER: '1' },
	},
	codex: {
		writable: [],
		readable: [],
		credentials: ['.codex/auth.json'],
		domains: ['chatgpt.com', '*.chatgpt.com', 'api.openai.com', '*.openai.com', 'auth.openai.com'],
		envKeys: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'],
	},
	'cursor-acp': {
		writable: ['Library/Application Support/Cursor/User/globalStorage'],
		// It refreshes its login in place (`auth.json`, or the keychain).
		writableFiles: ['.cursor/auth.json', '.config/cursor/auth.json'],
		readable: ['.local/share/cursor-agent'],
		credentials: ['.cursor/auth.json', '.config/cursor/auth.json'],
		domains: ['cursor.com', '*.cursor.com', 'cursor.sh', '*.cursor.sh', 'cursorapi.com', '*.cursorapi.com'],
		envKeys: ['CURSOR_API_KEY'],
	},
	grok: {
		writable: ['.grok/sessions', '.grok/logs', '.grok/memory-v2', '.grok/memtrace', '.grok/grove', '.grok/downloads', '.local/state/grok'],
		writableFiles: [
			'.grok/auth.json', '.grok/auth.json.lock', '.grok/active_sessions.json', '.grok/active_sessions.lock', '.grok/worktrees.db', '.grok/models_cache.json',
			'.grok/settings_cache.json', '.grok/tip_cursor.json', '.grok/agent_id', '.grok/.config-init.lock', '.grok/managed_config.lock', '.grok/.metadata_version',
		],
		readable: ['.grok'],
		credentials: ['.grok/auth.json'],
		domains: ['x.ai', '*.x.ai', 'grok.com', '*.grok.com'],
		envKeys: ['XAI_API_KEY', 'GROK_API_KEY'],
	},
	opencode: {
		// OpenCode 2 keeps credentials and sessions in `.local/share/opencode/opencode.db` and its settings in `.config/opencode`.
		writable: ['.local/share/opencode/storage', '.local/share/opencode/snapshot', '.local/share/opencode/log', '.local/state/opencode', '.local/share/oh-my-opencode', '.claude/transcripts'],
		writableFiles: ['.local/share/opencode/auth.json', '.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal', '.local/share/opencode/opencode.db-shm', '.local/share/opencode/opencode.db-journal'],
		readable: ['.local/share/opencode', '.config/opencode', '.opencode', '.omo'],
		credentials: ['.local/share/opencode/auth.json', '.local/share/opencode/opencode.db'],
		domains: ['opencode.ai', '*.opencode.ai', 'models.dev', 'api.anthropic.com', 'api.openai.com', 'openrouter.ai', '*.openrouter.ai', 'generativelanguage.googleapis.com', 'api.x.ai', 'api.deepseek.com', 'api.moonshot.ai', 'api.z.ai'],
		envKeys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'ZAI_API_KEY', 'OPENCODE_API_KEY'],
	},
	antigravity: {
		// `~/.gemini/settings.json`, `GEMINI.md`, `config/mcp_config.json` and skills stay read-only.
		writable: ['.gemini/antigravity-cli', '.gemini/tmp', '.gemini/antigravity/conversations', '.gemini/antigravity/brain', '.gemini/antigravity/annotations'],
		writableFiles: ['.gemini/oauth_creds.json', '.gemini/google_accounts.json', '.gemini/installation_id'],
		readable: ['.gemini', '.antigravity', '.config/antigravity'],
		credentials: ['.gemini/oauth_creds.json', '.gemini/antigravity-cli/antigravity-oauth-token', '.gemini/jetski-standalone-oauth-token'],
		domains: ['*.googleapis.com', 'accounts.google.com', 'oauth2.googleapis.com'],
		envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT'],
	},
	pi: {
		// Pi refreshes its OAuth tokens in `.pi/agent/auth.json`.
		writable: ['.pi/agent/sessions', '.pi/agent/logs'],
		writableFiles: ['.pi/agent/auth.json'],
		readable: ['.pi'],
		credentials: ['.pi/agent/auth.json'],
		domains: ['pi.dev', '*.pi.dev', 'api.anthropic.com', 'api.openai.com', 'chatgpt.com', '*.chatgpt.com', 'auth.openai.com', 'openrouter.ai', '*.openrouter.ai', 'generativelanguage.googleapis.com', 'api.x.ai', 'api.deepseek.com', 'api.moonshot.ai', 'api.z.ai', 'api.groq.com', 'api.mistral.ai', 'api.cerebras.ai'],
		envKeys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'CEREBRAS_API_KEY'],
	},
	kimi: {
		writable: ['.kimi/sessions', '.kimi/logs', '.kimi-code/sessions', '.kimi-code/logs'],
		readable: ['.kimi', '.kimi-code'],
		domains: ['*.moonshot.ai', '*.moonshot.cn', 'kimi.com', '*.kimi.com'],
		envKeys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
	},
	muse: {
		writable: ['.muse/sessions', '.muse/logs'],
		readable: ['.muse', '.config/muse'],
		domains: [],
	},
	fx: {
		// Sessions and the shell-startup cache live in `.fx`; `fx login codex` and `fx login grok` reach those services too.
		writable: ['.fx/sessions', '.fx/backups', '.fx/diagnostics', '.fx/file-index'],
		writableFiles: ['.fx/history.jsonl', '.fx/history.lock', '.fx/auth.lock', '.fx/settings.lock', '.fx/auth.json'],
		readable: ['.fx'],
		credentials: ['.fx/auth.json', '.fx/mcp-credentials'],
		domains: ['fx.sh', '*.fx.sh', 'ai-gateway.vercel.sh', 'vercel.com', '*.vercel.com', 'chatgpt.com', '*.chatgpt.com', 'api.openai.com', 'auth.openai.com', 'x.ai', '*.x.ai', 'grok.com', '*.grok.com'],
		envKeys: ['AI_GATEWAY_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY'],
	},
};

/** Every agent's own credential files, so each sandboxed agent can be denied the others'. */
const ALL_AGENT_CREDENTIALS = [...new Set(Object.values(AGENT_FOOTPRINTS).flatMap(footprint => footprint.credentials ?? []))];

/**
 * An agent Volt has no footprint for: its dot folders by provider id (the usual convention),
 * readable so it finds its config, and nothing of the home folder writable (B-05). It works in
 * the workspace, temp and its private `${tmp}`.
 */
function genericFootprint(providerId: string): IAgentFootprint {
	const name = providerId.replace(/-acp$/, '').replace(/[^a-z0-9._-]/gi, '').replace(/^\.+/, '');
	return { writable: [], readable: name ? [`.${name}`, `.config/${name}`, `.local/share/${name}`] : [], domains: [] };
}

function footprintOf(providerId: string): IAgentFootprint {
	return Object.prototype.hasOwnProperty.call(AGENT_FOOTPRINTS, providerId) ? AGENT_FOOTPRINTS[providerId] : genericFootprint(providerId);
}

/**
 * The footprint lint (K.4): a footprint may not make a CLI's config writable. Every writable entry
 * is a subpath (never a whole `.<cli>` or `.config/<cli>` folder), and no segment of it is a
 * config-bearing name (`settings.json`, `hooks`, `skills`, `CLAUDE.md`, ...). Overlays copy back
 * only listed keys. Empty when every footprint passes; the tests assert it.
 */
export function footprintLintErrors(footprints: Readonly<Record<string, IAgentFootprint>> = AGENT_FOOTPRINTS): string[] {
	const errors: string[] = [];
	const configNames = new Set(AGENT_CONFIG_NAMES.map(name => name.toLowerCase()));
	for (const [id, footprint] of Object.entries(footprints)) {
		for (const entry of [...footprint.writable, ...(footprint.writableFiles ?? [])]) {
			const segments = entry.split('/');
			if (!entry || entry.startsWith('/') || segments.some(segment => !segment || segment === '.' || segment === '..')) {
				errors.push(`${id}: ${entry} is not a plain path under the home folder`);
			}
			const configSegment = segments.find(segment => configNames.has(segment.toLowerCase()));
			if (configSegment) {
				errors.push(`${id}: ${entry} makes ${configSegment} writable, which holds config, hooks or instructions`);
			}
			if (segments.length < 2 || (segments.length === 2 && ['.config', '.local', 'Library'].includes(segments[0]))) {
				errors.push(`${id}: ${entry} is a whole folder; list the subpaths the CLI writes`);
			}
			if (footprint.readable.includes(entry)) {
				errors.push(`${id}: ${entry} is both readable state and writable; list the writable subpaths`);
			}
		}
	}
	for (const [id, overlay] of Object.entries(AGENT_OVERLAYS)) {
		for (const seed of overlay.seed) {
			if (seed.mergeBack.some(key => !key || key === '*' || key.split('.')[0] === '*')) {
				errors.push(`${id}: ${seed.name} merges back every key`);
			}
		}
		if (!overlay.link.length) {
			errors.push(`${id}: the overlay links none of the user's config read-only`);
		}
	}
	return errors;
}

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
	const footprint = footprintOf(request.providerId);
	for (const dir of footprint.writable) {
		writable.push(`${home}/${dir}`);
	}
	if (Object.prototype.hasOwnProperty.call(AGENT_OVERLAYS, request.providerId)) {
		// Its config folder is a per-chat overlay (agentState.ts); which chat is not known here.
		writable.push(`${home}/${AGENT_STATE_ROOT}`);
	}
	for (const file of footprint.writableFiles ?? []) {
		files.push(`${home}/${file}`);
	}
	writable.push(...(footprint.tmpDirs?.(host.uid) ?? []));

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
	// Config, hooks and instructions inside the CLI's writable state folders (B-05).
	denySubpaths.push(...agentStateProtections(home, footprintOf(request.providerId)));

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

/** Config names directly inside each writable state folder, never writable (a CLI that keeps `bin` or `settings.json` there). */
function agentStateProtections(home: string, footprint: IAgentFootprint): string[] {
	return footprint.writable.flatMap(dir => AGENT_CONFIG_NAMES.map(name => `${home}/${dir}/${name}`));
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
	/** The chat's config overlay for this CLI (agentState.ts), already created by the node side. */
	readonly statePlan?: IAgentStatePlan;
}

/** Ports from 1 to 65535, once each. */
function ports(values: readonly number[] | undefined): number[] {
	return unique((values ?? []).filter(port => Number.isInteger(port) && port > 0 && port < 65536).map(String)).map(Number);
}

/**
 * The policy an agent CLI process tree runs under. Weaker than the workload profiles by design,
 * because the whole CLI runs inside it, but narrow in what it reads (D-14, on every platform):
 * - readable: the system folders, the programs on PATH and the user's toolchains (`~/.cargo`,
 *   `~/.nvm`, Homebrew), the workspace and allowed folders, temp, and the CLI's own state (its
 *   install, its config read-only, its sessions). Nothing else of the home folder: not other
 *   projects, not shell startup files, not other agents' state. Credentials stay denied on top;
 * - writable: the workspace (`workspace-write`), folders the user allowed, temp, and the CLI's own
 *   state in allow-list form, never its config, hooks or instructions (B-05). Claude Code, Codex
 *   and Cursor write their config into a per-chat overlay instead (agentState.ts);
 * - OS services stay reachable on macOS (Keychain, launchd), with Apple Events, LaunchServices,
 *   synthetic input, the pasteboard, preference writes and signals to other processes denied;
 * - no unix sockets (ssh-agent only with network on); loopback only to the proxy and Volt's MCP
 *   server unless network is on; listening only on ports the user granted (B-30);
 * - the environment is an allow list (`AGENT_ENV_INHERIT`) plus the CLI's own keys, never `*` (B-41).
 */
export function agentSandboxPolicy(request: IVoltSandboxRequest, host: IAgentSandboxHost): IVoltSandboxPolicy {
	const home = normalizeSandboxPath(host.home);
	const footprint = footprintOf(request.providerId);
	const plan = host.statePlan;
	const overlay = Object.prototype.hasOwnProperty.call(AGENT_OVERLAYS, request.providerId) ? AGENT_OVERLAYS[request.providerId] : undefined;
	const usable = (paths: readonly string[] | undefined) => (paths ?? []).map(normalizeSandboxPath).filter(isAbsolute).filter(root => root !== '/' && !isPathInside(home, root));
	const workspace = usable(request.workspaceRoots);
	const extra = usable(request.extraWritableRoots);
	const at = (relative: string) => `${home}/${relative}`;

	const write = unique([
		...(request.level === 'workspace-write' ? workspace : []),
		...extra,
		...host.tempDirs,
		...(footprint.tmpDirs?.(host.uid) ?? []),
		...footprint.writable.map(at),
		...(footprint.writableFiles ?? []).map(at),
		...(plan ? [...plan.write, ...plan.writeFiles] : []),
		host.cacheDir,
	]);

	const read = unique([
		'${system}',
		'${path}',
		...agentSystemReadPaths(host.platform),
		...HOME_TOOLCHAIN_PATHS.map(at),
		...workspace,
		...footprint.readable.map(at),
		// Its config: the overlay's read-only links, or (no overlay for this launch) the real folder.
		...(plan ? plan.read : overlay ? [at(overlay.home)] : []),
		// The login: macOS keychain files are guarded by their own access lists.
		...(host.platform === 'darwin' ? [at('Library/Keychains')] : []),
		// ssh needs its config and known_hosts for git over SSH; the private keys stay denied.
		...(request.network ? [at('.ssh')] : []),
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
	// The user's own sandbox policy, which may widen: read-only even when the user lets the agent write `~/.volt`.
	protect.push(at('.volt/sandbox.json'), ...agentStateProtections(home, footprint), ...(plan?.protect ?? []), ...PROTECTED_GIT_PATTERNS);

	const ownCredentials = new Set(footprint.credentials ?? []);
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
		// The overlay's seed snapshots are Volt's: the merge compares against them.
		...(plan ? [plan.seedDir] : []),
	];

	const listenPorts = ports(request.listenPorts);
	// Linux with an open network shares the host's network namespace, where seccomp can refuse
	// listening but cannot tell ports apart: a granted port there opens them all, and says so.
	const listenAnywhere = request.network && host.platform === 'linux' && listenPorts.length > 0;
	const network = request.network
		? { mode: 'host' as const, allow: [], loopbackPorts: [], listen: listenAnywhere, ...(listenPorts.length && !listenAnywhere ? { listenPorts } : {}) }
		: {
			mode: 'proxy' as const,
			allow: unique([...agentApiDomains(request.providerId), ...(request.allowedDomains ?? [])].map(domain => domain.trim().toLowerCase()).filter(domain => domain && domain !== 'localhost')),
			loopbackPorts: ports(request.loopbackPorts),
			listen: false,
			...(listenPorts.length ? { listenPorts } : {}),
		};

	const cacheEnv = Object.fromEntries(Object.entries(SANDBOX_CACHE_ENV).map(([name, sub]) => [name, `${host.cacheDir}/${sub}`]));
	// bubblewrap cannot guard paths that do not exist yet; macOS cannot contain a setsid daemon.
	const bestEffort: SandboxDimension[] = ['filesystem.protectNew', 'process.tree'];
	return {
		schemaVersion: 1,
		name: `agent ${request.providerId} ${request.level}`,
		filesystem: { read, write, deny: unique(deny), protect: unique(protect), unmask: [] },
		network,
		process: { limits: {} },
		env: {
			inherit: unique([...AGENT_ENV_INHERIT.filter(name => !isSecretEnvName(name)), ...(footprint.envKeys ?? []), ...(request.network && host.sshAuthSock ? ['SSH_AUTH_SOCK'] : [])]),
			set: { ...cacheEnv, ...footprint.env, ...plan?.env },
		},
		// Seatbelt can allow exactly one socket. bubblewrap would have to allow AF_UNIX altogether,
		// so on Linux ssh-agent stays out (git over HTTPS works).
		host: { unixSockets: request.network && host.sshAuthSock && host.platform === 'darwin' ? [host.sshAuthSock] : [], systemServices: true },
		bestEffort,
	};
}

/** The writes a sandboxed agent of `providerId` may make in the home folder, relative to it: for tests and the Security page. */
export function agentHomeWrites(providerId: string): { readonly folders: readonly string[]; readonly files: readonly string[] } {
	const footprint = footprintOf(providerId);
	return { folders: footprint.writable, files: footprint.writableFiles ?? [] };
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
 * - `wrap`: Volt wraps the whole agent process tree (Seatbelt / bubblewrap).
 * - `native`: the agent's own sandbox, configured by Volt. No provider gets it any more (B-10,
 *   D-16): Codex's own sandbox read the whole disk and lacked Volt's credential denies and
 *   protected names, so a handoff to Codex weakened the chat. It stays in the type, and in every
 *   comparison (`native` is weaker than `wrap`), for agents that may only sandbox themselves.
 * - `none`: no sandbox (level `off`, or no OS sandbox on this platform: such a chat is refused).
 *
 * macOS refuses nested sandboxes (`sandbox_apply: Operation not permitted`), so an agent's own
 * sandbox is switched off while Volt wraps it (`codexSandboxValue`, `nativeSandboxOffArgs`).
 */
export type SandboxStrategy = 'wrap' | 'native' | 'none';

const STRATEGY_RANK: Readonly<Record<SandboxStrategy, number>> = { none: 0, native: 1, wrap: 2 };

/** Whether strategy `a` confines at least as much as `b` (`none < native < wrap`). */
export function strategyAtLeast(a: SandboxStrategy, b: SandboxStrategy): boolean {
	return STRATEGY_RANK[a] >= STRATEGY_RANK[b];
}

export function sandboxStrategy(_providerId: string, level: VoltSandboxLevel, platform: string): SandboxStrategy {
	if (level === 'off' || platform === 'win32') {
		return 'none';
	}
	// Always wrap (D-16): Codex runs under Volt's sandbox with its own sandbox off, like every other agent.
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

/**
 * What a new chat starts with (spec N.1): writes inside the workspace, with the chat's network
 * through the broker, on macOS and Linux. Off on Windows until its sandbox is on by default.
 */
export function newChatSandboxDefaults(platform: string): IVoltSandboxSettings {
	return platform === 'darwin' || platform === 'linux' ? { level: 'workspace-write', network: true } : DEFAULT_SANDBOX_SETTINGS;
}

/** Settings read back from storage: unknown fields dropped, paths and hosts cleaned. */
export function normalizeSandboxSettings(value: unknown): IVoltSandboxSettings {
	const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
	const strings = (list: unknown) => Array.isArray(list) ? [...new Set(list.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim()))] : [];
	const extra = strings(raw.extraWritableRoots).map(normalizeSandboxPath).filter(isAbsolute);
	const domains = strings(raw.allowedDomains).map(domain => domain.toLowerCase());
	const listen = Array.isArray(raw.listenPorts) ? ports(raw.listenPorts.filter((port): port is number => typeof port === 'number')) : [];
	return {
		level: normalizeSandboxLevel(raw.level),
		network: raw.network !== false,
		...(extra.length ? { extraWritableRoots: extra } : {}),
		...(domains.length ? { allowedDomains: domains } : {}),
		...(listen.length ? { listenPorts: listen } : {}),
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
	const key: unknown[] = [settings.level, settings.network, [...(settings.extraWritableRoots ?? [])].sort()];
	if (settings.listenPorts?.length) {
		key.push([...settings.listenPorts].sort((a, b) => a - b));
	}
	return JSON.stringify(key);
}

/** The settings with one more loopback port the agent may listen on (a dev server, B-30). */
export function withListenPort(settings: IVoltSandboxSettings, port: number): IVoltSandboxSettings {
	if (!Number.isInteger(port) || port < 1 || port > 65535 || settings.listenPorts?.includes(port)) {
		return settings;
	}
	return { ...settings, listenPorts: [...(settings.listenPorts ?? []), port] };
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
 * - `wrap` (every sandboxed level): Volt confines the whole tree, so Codex's per-command sandbox
 *   must stay off; macOS refuses a second sandbox inside one that denies anything. Codex's own
 *   approval prompts go with it (B-AP-13); Volt's sandbox is the boundary.
 * - `native` (no longer chosen, see `sandboxStrategy`): Codex's own sandbox; full access is never chosen.
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
