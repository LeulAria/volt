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
	'.volt/accounts', '.volt/trust', 'Library/Keychains', 'Library/Cookies',
	// Browser profiles: cookies and saved passwords.
	'Library/Application Support/Google/Chrome', 'Library/Application Support/Chromium', 'Library/Application Support/BraveSoftware',
	'Library/Application Support/Microsoft Edge', 'Library/Application Support/Arc', 'Library/Application Support/Firefox', 'Library/Safari',
	'.mozilla', '.config/google-chrome', '.config/chromium', '.config/BraveSoftware', '.config/microsoft-edge',
	// Windows: DPAPI keys, Credential Manager and the vault, git's `_netrc`, CLI logins and browser profiles.
	'_netrc', 'AppData/Roaming/Microsoft/Credentials', 'AppData/Local/Microsoft/Credentials', 'AppData/Roaming/Microsoft/Protect',
	'AppData/Local/Microsoft/Vault', 'AppData/Roaming/Microsoft/Vault', 'AppData/Roaming/GitHub CLI', 'AppData/Roaming/gcloud',
	'AppData/Local/Google/Chrome/User Data', 'AppData/Local/Microsoft/Edge/User Data', 'AppData/Local/BraveSoftware',
	'AppData/Roaming/Mozilla/Firefox', 'AppData/Roaming/Opera Software',
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
 * Git internals at any depth that run code or redirect git later: config and hooks run in every
 * later git command, `commondir`/`gitdir` point git at another folder's config and hooks, and
 * `alternates` borrows objects from another repository. These are named for the backends that can
 * only protect existing paths; the real rule is the allow list below (`gitDirWritable`), which
 * covers every other name too, including ones created later.
 */
export const PROTECTED_GIT_PATTERNS: readonly string[] = [
	'**/.git/config', '**/.git/config.worktree', '**/.git/hooks', '**/.git/modules',
	'**/.git/commondir', '**/.git/gitdir', '**/.git/info', '**/.git/objects/info/alternates', '**/.git/objects/info/http-alternates',
];

/**
 * `.git` is an allow list for sandboxed writers (B-03): only what commits, merges, rebases,
 * fetches and stashes write. Everything else in a git folder (config, hooks, `commondir`, `gitdir`,
 * `info/`, `modules/`, alternates, names git may add later) stays read-only. The same set applies
 * inside each linked worktree's folder (`worktrees/<name>/`); creating a worktree folder itself
 * is a host operation. Rebase and sequencer state is writable because the agent finishes its own
 * rebases (`git rebase --continue` inside the sandbox); Volt never continues one on the host.
 */
const GIT_WRITABLE_DIRS = ['objects', 'refs', 'logs', 'rebase-merge', 'rebase-apply', 'sequencer', 'rr-cache', 'lfs'];
const GIT_WRITABLE_FILES = ['index', 'HEAD', 'ORIG_HEAD', 'FETCH_HEAD', 'COMMIT_EDITMSG', 'packed-refs', 'AUTO_MERGE', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'shallow', 'gc.pid', 'gc.log'];
/** `MERGE_HEAD`, `MERGE_MSG`, `BISECT_LOG`, temp indexes (`index.stash.<pid>`), and every lock file. */
const GIT_WRITABLE_FILE_PATTERN = /^(?:(?:MERGE|BISECT|NOTES_MERGE)_[A-Za-z_]+|index\.[^/]+|sharedindex\.[^/]+|[^/]+\.lock)$/;
/** Read-only even inside a writable folder: they make git read another repository's objects. */
const GIT_READONLY_OBJECT_FILES = ['info/alternates', 'info/http-alternates'];

/** Whether a sandboxed writer may write `relative`, a path inside a git folder (`a/b`, no leading slash). */
export function gitDirWritable(relative: string): boolean {
	let parts = relative.split('/').filter(part => part !== '');
	if (parts[0] === 'worktrees') {
		if (parts.length < 3) {
			return false;
		}
		parts = parts.slice(2);
	}
	if (!parts.length || parts.some(part => part === '..' || part === '.')) {
		return false;
	}
	if (GIT_WRITABLE_DIRS.includes(parts[0])) {
		return !(parts[0] === 'objects' && GIT_READONLY_OBJECT_FILES.includes(parts.slice(1).join('/')));
	}
	return parts.length === 1 && (GIT_WRITABLE_FILES.includes(parts[0]) || GIT_WRITABLE_FILE_PATTERN.test(parts[0]));
}

/** The allow list as two regex alternations, for profile generators (Seatbelt). Exact case, no anchors. */
export const GIT_WRITABLE_REGEX = {
	dirs: `(${GIT_WRITABLE_DIRS.map(escapeRegex).join('|')})`,
	files: `(${GIT_WRITABLE_FILES.map(escapeRegex).join('|')}|(MERGE|BISECT|NOTES_MERGE)_[A-Za-z_]+|index\\.[^/]+|sharedindex\\.[^/]+|[^/]+\\.lock)`,
	readonlyObjects: `objects/info/(http-)?alternates`,
} as const;

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
/** `*_KEY`, `*_PAT`, `*_JWT` and their `_KEY_`-style middles (`STRIPE_KEY_LIVE`); not `KEYCHAIN` or `PATH`. */
const SECRET_ENV_WORD = /(?:^|_)(?:KEY|KEYS|PAT|JWT)(?:_|$)/i;
const SECRET_ENV_PREFIX = /^(?:AWS_|AZURE_|ARM_|GOOGLE_|GCP_|GCLOUD_|CLOUDSDK_|GH_|GITHUB_|GITLAB_|BITBUCKET_|NPM_|YARN_|DOCKER_|KUBE|HELM_|VAULT_|OP_|HEROKU_|VERCEL_|NETLIFY_|SENTRY_|STRIPE_|TWILIO_|SLACK_|DATABASE|PG|MYSQL_|REDIS_|MONGO|SSH_|GPG_|GNUPG|VSCODE_|ELECTRON_|CHROME_|DBUS_|XDG_RUNTIME_DIR$|DISPLAY$|WAYLAND_|XAUTHORITY$|LD_|DYLD_|BASH_ENV$|ENV$|NODE_OPTIONS$|PYTHONSTARTUP$|PERL5OPT$|RUBYOPT$|PROMPT_COMMAND$|TMUX|STY$|VOLT_)/i;
const PROXY_ENV = /^(?:HTTPS?_PROXY|ALL_PROXY|NO_PROXY|FTP_PROXY|NPM_CONFIG_(?:HTTPS_)?PROXY)$/i;

export function isSecretEnvName(name: string): boolean {
	return SECRET_ENV_NAME.test(name) || SECRET_ENV_WORD.test(name) || SECRET_ENV_PREFIX.test(name) || PROXY_ENV.test(name);
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

/**
 * What an agent CLI's process tree gets of the user's environment (B-41): never `*`, only these
 * names plus the agent's own (`envKeys` of its footprint). Locale, terminal and shell, and where
 * the user's toolchains live, so builds and tests behave as in the user's terminal. Anything that
 * looks secret is dropped even when listed (`isSecretEnvName`), except an agent's own keys.
 */
export const AGENT_ENV_INHERIT: readonly string[] = [
	...BASE_ENV_INHERIT, 'PATH', 'HOME', 'SHELL', 'LC_COLLATE', 'LC_NUMERIC', 'LC_TIME', 'LC_MONETARY', 'EDITOR', 'VISUAL', 'PAGER', 'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR',
	'__CF_USER_TEXT_ENCODING', 'COMMAND_MODE', 'DEVELOPER_DIR', 'SDKROOT', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS',
	'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_REPOSITORY', 'NVM_DIR', 'NVM_BIN', 'NVM_INC', 'VOLTA_HOME', 'FNM_DIR', 'PNPM_HOME', 'BUN_INSTALL', 'DENO_INSTALL',
	'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'GOPATH', 'GOROOT', 'GOBIN', 'GOFLAGS', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'PYENV_ROOT', 'PYENV_VERSION',
	'VIRTUAL_ENV', 'CONDA_PREFIX', 'RBENV_ROOT', 'ASDF_DIR', 'ASDF_DATA_DIR', 'MISE_DATA_DIR', 'SDKMAN_DIR', 'DOTNET_ROOT', 'FLUTTER_ROOT', 'GEM_HOME', 'GEM_PATH',
];

/**
 * Toolchains under the home folder an agent may read (D-14, narrow reads): where the user's
 * compilers, runtimes and version managers install programs. Their credential files stay denied
 * by the floor (`~/.cargo/credentials`). Settings that hold registry tokens (`~/.m2`, `~/.gradle`)
 * are not here.
 */
export const HOME_TOOLCHAIN_PATHS: readonly string[] = [
	'.cargo', '.rustup', 'go', '.nvm', '.bun', '.deno', '.volta', '.fnm', '.local/share/fnm', '.pnpm', 'Library/pnpm', '.local/share/pnpm', '.yarn/bin',
	'.pyenv', '.rbenv', '.asdf', '.local/share/mise', '.sdkman', '.dotnet', '.swiftpm', '.foundry', '.local/bin', '.local/lib', 'Library/Python', '.npm-global',
	'.gem', '.local/share/gem', 'flutter', 'Library/Android/sdk', 'Android/Sdk', '.jenv', '.ghcup', '.opam', '.elan', '.pub-cache', '.juliaup',
	// Tools installed by uv and pipx (`~/.local/bin` links into these).
	'.local/share/uv', '.local/pipx', '.local/share/pipx',
	// npx's own installs: the ACP adapters Volt starts run from here (read, never written).
	'.npm/_npx',
	// git's own settings (`~/.config/git/credentials` stays denied by the floor).
	'.gitconfig', '.config/git', '.gitignore_global',
];

/**
 * Names in an agent CLI's state that hold configuration, hooks, MCP servers, instructions or
 * installs: code or prompts every later session of that CLI runs, sandboxed or not (B-05). Never
 * writable from a sandbox; a footprint may not list them (or a folder holding them) as writable.
 */
export const AGENT_CONFIG_NAMES: readonly string[] = [
	'.claude.json', 'settings.json', 'settings.local.json', 'config.toml', 'config.json', 'config.yaml', 'cli-config.json', 'cli.json', 'mcp.json', 'mcp_config.json',
	'hooks', 'hooks.json', 'plugins', 'plugin', 'skills', 'agents', 'commands', 'rules', 'output-styles', 'extensions', 'prompts',
	'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'opencode.json', 'opencode.jsonc', 'models.json', 'keybindings.json', 'permissions.json', 'mcp-approvals.json', 'bin',
];

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
export function systemReadPaths(platform: string, env: Readonly<Record<string, string | undefined>> = {}): readonly string[] {
	if (platform === 'win32') {
		// Windows and Program Files only: never the drive root, ProgramData (service keys, host
		// keys) or the profile. Folders come from the environment, with the usual defaults.
		const get = (name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
		const drive = (get('SystemDrive') ?? 'C:').replace(/[\\/]+$/, '');
		return [...new Set([
			get('SystemRoot') ?? `${drive}\\Windows`,
			get('ProgramFiles') ?? `${drive}\\Program Files`,
			get('ProgramFiles(x86)') ?? `${drive}\\Program Files (x86)`,
			get('ProgramW6432') ?? `${drive}\\Program Files`,
			`${drive}\\Program Files (Arm)`,
		])];
	}
	if (platform === 'darwin') {
		return [
			'/usr', '/bin', '/sbin', '/System', '/Library/Apple', '/Library/Frameworks', '/Library/Developer/CommandLineTools',
			'/Library/Preferences/SystemConfiguration', '/private/etc', '/private/var/db/timezone', '/private/var/select',
			'/Applications/Xcode.app/Contents/Developer', '/opt/homebrew', '/usr/local', '/dev',
		];
	}
	if (platform === 'win32') {
		// For the MXC backend (J.3): Windows and Program Files, never `C:\` or the profile root.
		return ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'];
	}
	return ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/opt', '/nix/store', '/snap'];
}

/**
 * System files an agent CLI needs on top of `${system}` (it reaches OS services the workload
 * profiles do not): the resolver configuration DNS clients read, and on macOS the keychain and
 * security databases `security` and TLS stacks open themselves.
 */
export function agentSystemReadPaths(platform: string): readonly string[] {
	if (platform === 'darwin') {
		return ['/Library/Keychains', '/private/var/db/mds', '/private/var/run/resolv.conf', '/private/var/db/xcode_select_link', '/Library/Preferences/com.apple.security.plist', '/System/Volumes/Preboot/Cryptexes'];
	}
	if (platform === 'win32') {
		return [];
	}
	return ['/run/systemd/resolve', '/run/resolvconf', '/var/lib/ca-certificates'];
}
