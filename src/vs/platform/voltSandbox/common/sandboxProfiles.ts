/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltSandboxPolicy, SANDBOX_POLICY_SCHEMA_VERSION } from './sandboxSchema.js';

/**
 * Built-in profiles and the protections every profile carries.
 *
 * The protections are not optional extras: they are what keeps a sandboxed workload from
 * planting code that the unsandboxed host runs later (git hooks and config, shell rc files, editor
 * tasks, agent hooks) and from reading credentials. Composition can add to them; no layer removes
 * them, and only a trusted layer may `unmask` a credential path.
 */

export type SandboxProfileId = 'restricted' | 'workspace' | 'network';

/** Credentials below the home folder: neither readable nor writable. */
export const CREDENTIAL_HOME_PATHS: readonly string[] = [
	'.ssh', '.gnupg', '.aws', '.azure', '.config/gcloud', '.kube', '.docker/config.json', '.docker/contexts',
	'.netrc', '.npmrc', '.yarnrc.yml', '.pypirc', '.gem/credentials', '.cargo/credentials', '.cargo/credentials.toml',
	'.git-credentials', '.config/git/credentials', '.config/gh', '.config/hub', '.config/op', '.config/configstore',
	'.terraform.d/credentials.tfrc.json', '.vault-token', '.password-store', '.local/share/keyrings',
	'.volt/accounts', 'Library/Keychains', 'Library/Cookies',
	// Browser profiles: cookies and saved passwords.
	'Library/Application Support/Google/Chrome', 'Library/Application Support/Chromium', 'Library/Application Support/BraveSoftware',
	'Library/Application Support/Microsoft Edge', 'Library/Application Support/Arc', 'Library/Application Support/Firefox', 'Library/Safari',
	'.mozilla', '.config/google-chrome', '.config/chromium', '.config/BraveSoftware', '.config/microsoft-edge',
];

/** Secret-bearing env files, at any depth, including inside the workspace. */
export const SECRET_FILE_PATTERNS: readonly string[] = [
	'**/.env', '**/.env.local', '**/.env.production', '**/.env.production.local', '**/.env.development.local', '**/.env.test.local', '**/.envrc',
];

/**
 * Files at a writable root that the host runs or trusts later: shell startup files, git hook
 * managers, editor, agent and worktree-setup configs, MCP server lists, and the files that would
 * make the root a bare git repository.
 */
export const PROTECTED_ROOT_NAMES: readonly string[] = [
	'.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.bash_login', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.profile',
	'.ripgreprc', '.mcp.json', '.envrc', '.vscode', '.idea', '.devcontainer',
	'.husky', '.githooks', '.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yml',
	'.claude/settings.json', '.claude/settings.local.json', '.claude/commands', '.claude/agents', '.claude/hooks',
	'.cursor/mcp.json', '.cursor/hooks.json', '.cursor/hooks', '.cursor/worktrees.json',
	'.volt/hooks.json', '.volt/hooks', '.volt/mcp.json', '.volt/worktrees.json', 'volt.json', 't3.json',
	'opencode.json', 'opencode.jsonc', '.opencode',
	'HEAD', 'objects', 'refs',
];

/**
 * Git internals at any depth: config and hooks run code in every later git command, including the
 * ones Volt's Source Control view runs on its own. Writes elsewhere in `.git` (objects, refs, the
 * index) stay allowed, so commits work.
 */
export const PROTECTED_GIT_PATTERNS: readonly string[] = ['**/.git/config', '**/.git/config.worktree', '**/.git/hooks', '**/.git/modules'];

/** Every protection, as `protect` entries relative to one writable root token. */
export function protectedEntries(root: '${workspace}'): string[] {
	return [...PROTECTED_ROOT_NAMES.map(name => `${root}/${name}`), ...PROTECTED_GIT_PATTERNS];
}

/** Credential denies as `deny` entries. */
export function credentialDenyEntries(): string[] {
	return [...CREDENTIAL_HOME_PATHS.map(path => `\${home}/${path}`), ...SECRET_FILE_PATTERNS];
}

/**
 * Variables that are never copied by `inherit: ["*"]`, and that an untrusted layer may not name:
 * credentials, the host's IPC endpoints, proxy settings (Volt sets those) and code injection hooks.
 */
const SECRET_ENV_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|CLIENT_?ID|SESSION|COOKIE|AUTH|_DSN$|_URL$|_URI$|CONNECTION_?STRING)/i;
const SECRET_ENV_PREFIX = /^(?:AWS_|AZURE_|ARM_|GOOGLE_|GCP_|GCLOUD_|CLOUDSDK_|GH_|GITHUB_|GITLAB_|BITBUCKET_|NPM_|YARN_|DOCKER_|KUBE|HELM_|VAULT_|OP_|HEROKU_|VERCEL_|NETLIFY_|SENTRY_|STRIPE_|TWILIO_|SLACK_|DATABASE|PG|MYSQL_|REDIS_|MONGO|SSH_|GPG_|GNUPG|VSCODE_|ELECTRON_|CHROME_|DBUS_|XDG_RUNTIME_DIR$|DISPLAY$|WAYLAND_|XAUTHORITY$|LD_|DYLD_|BASH_ENV$|ENV$|NODE_OPTIONS$|PYTHONSTARTUP$|PERL5OPT$|RUBYOPT$|PROMPT_COMMAND$|TMUX|STY$|VOLT_)/i;
const PROXY_ENV = /^(?:HTTPS?_PROXY|ALL_PROXY|NO_PROXY|FTP_PROXY|NPM_CONFIG_(?:HTTPS_)?PROXY)$/i;

export function isSecretEnvName(name: string): boolean {
	return SECRET_ENV_NAME.test(name) || SECRET_ENV_PREFIX.test(name) || PROXY_ENV.test(name);
}

/** Names only the manager sets. No layer may set or inherit them. */
export function isReservedEnvName(name: string): boolean {
	return PROXY_ENV.test(name) || /^VOLT_SANDBOX/i.test(name);
}

/**
 * Loader and interpreter hooks. Harmless inside the sandbox, but a launcher that runs outside it
 * (bubblewrap, sandbox-exec) could load them too, so an untrusted layer may not set them.
 */
export function isInjectionEnvName(name: string): boolean {
	return /^(?:LD_|DYLD_)|^(?:BASH_ENV|ENV|NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|PROMPT_COMMAND|GCONV_PATH|MALLOC_.*)$/i.test(name);
}

/** Host variables every profile copies when present: harmless and needed by almost every tool. */
export const BASE_ENV_INHERIT: readonly string[] = ['LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TERM', 'COLORTERM', 'TZ', 'USER', 'LOGNAME'];

/** Limits every built-in profile sets. The wall clock is the manager's own timer, so it holds everywhere. */
const DEFAULT_LIMITS = { wallClockSeconds: 600, cpuSeconds: 300, fileSizeMB: 1024, openFiles: 4096, processes: 512 };

function profile(id: SandboxProfileId, policy: Omit<IVoltSandboxPolicy, 'schemaVersion' | 'name'>): IVoltSandboxPolicy {
	// Name last: profiles extend each other by spreading, which would carry the parent's name.
	return { ...policy, schemaVersion: SANDBOX_POLICY_SCHEMA_VERSION, name: id };
}

/**
 * - `restricted`: system binaries read-only, a private temp folder, no network, nothing of the
 *   user's. For running something you know nothing about.
 * - `workspace`: plus the workspace read-write (protected paths read-only) and the user's
 *   toolchains (the programs on PATH) read-only. No network.
 * - `network`: `workspace` with network through Volt's proxy. Its allow list starts empty, so
 *   a grant has to name each host.
 *
 * Best effort, so the run is reported `partial` instead of refused: `limits.processes` and
 * `process.tree` (macOS has no per-sandbox process count or PID namespace; a process that
 * double-forks, calls setsid and clears its environment outlives the kill, still sandboxed), and
 * `filesystem.protectNew` (bubblewrap can only protect paths that exist at launch).
 */
export function builtinProfile(id: SandboxProfileId): IVoltSandboxPolicy {
	const restricted = profile('restricted', {
		filesystem: { read: ['${system}'], write: ['${tmp}'], deny: credentialDenyEntries(), protect: [], unmask: [] },
		network: { mode: 'none', allow: [], loopbackPorts: [], listen: false },
		process: { limits: DEFAULT_LIMITS },
		env: { inherit: BASE_ENV_INHERIT, set: { HOME: '${tmp}/home', TMPDIR: '${tmp}' } },
		host: { unixSockets: [], systemServices: false },
		// protectNew here only covers credential paths created during the run, which restricted cannot read anyway.
		bestEffort: ['limits.processes', 'process.tree', 'filesystem.protectNew'],
	});
	if (id === 'restricted') {
		return restricted;
	}
	const workspace = profile('workspace', {
		...restricted,
		filesystem: {
			read: ['${system}', '${path}'],
			write: ['${workspace}', '${tmp}'],
			deny: credentialDenyEntries(),
			protect: protectedEntries('${workspace}'),
			unmask: [],
		},
		bestEffort: ['limits.processes', 'process.tree', 'filesystem.protectNew'],
	});
	if (id === 'workspace') {
		return workspace;
	}
	return profile('network', { ...workspace, network: { mode: 'proxy', allow: [], loopbackPorts: [], listen: false } });
}

export const BUILTIN_PROFILE_IDS: readonly SandboxProfileId[] = ['restricted', 'workspace', 'network'];

/**
 * Folders `${system}` stands for, per platform: binaries, libraries, certificates, locale and
 * time zone data. Missing ones are skipped.
 */
export function systemReadPaths(platform: string): readonly string[] {
	if (platform === 'darwin') {
		return [
			'/usr', '/bin', '/sbin', '/System', '/Library/Apple', '/Library/Frameworks', '/Library/Developer/CommandLineTools',
			'/Library/Preferences/SystemConfiguration', '/private/etc', '/private/var/db/timezone', '/private/var/select',
			'/Applications/Xcode.app/Contents/Developer', '/opt/homebrew', '/usr/local', '/dev',
		];
	}
	return ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/opt', '/nix/store', '/snap'];
}
