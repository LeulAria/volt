/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How each agent CLI Volt supports is installed, signed in, and asked whether it is signed in.
 * Install commands are the vendors' documented ones; when a vendor documents none that we could
 * verify, the wizard links the install guide instead of running a script.
 */

export type SetupPlatform = 'mac' | 'linux' | 'windows';

/** A non-interactive check that prints whether the CLI is signed in. */
export type AgentAuthCheck =
	/** `claude auth status`: JSON `{ loggedIn, email, subscriptionType }`, exit 1 when signed out. */
	| { readonly kind: 'claudeStatus' }
	/** `codex login status`: "Logged in using …" (exit 0) or "Not logged in" (exit 1). */
	| { readonly kind: 'codexStatus' }
	/** `cursor-agent status --format json`: `{ isAuthenticated, userInfo.email }`; exit 0 either way. */
	| { readonly kind: 'cursorStatus' }
	/** A credentials file below the home folder; present means signed in, absent means signed out. */
	| { readonly kind: 'file'; readonly path: string }
	/** Nothing to ask: the CLI signs in inside its own UI and keeps the token where Volt cannot see it. */
	| { readonly kind: 'none' };

export interface IAgentSetupInfo {
	/** Matches `ICliAgentDefinition.id`. */
	readonly id: string;
	/** Per platform; undefined when there is no verified one-liner. */
	readonly install?: Partial<Record<SetupPlatform, string>>;
	/** Shown when there is no install command (or next to it). */
	readonly docsUrl: string;
	/** Runs the sign-in. Undefined when signing in happens inside the CLI's own session. */
	readonly login?: string;
	/** For CLIs that sign in from their own prompt: what to type there. */
	readonly loginHint?: string;
	readonly authCheck: AgentAuthCheck;
}

const CURL_CLAUDE = 'curl -fsSL https://claude.ai/install.sh | bash';

export const AGENT_SETUP: readonly IAgentSetupInfo[] = [
	{
		id: 'claude-code',
		install: { mac: CURL_CLAUDE, linux: CURL_CLAUDE, windows: 'irm https://claude.ai/install.ps1 | iex' },
		docsUrl: 'https://code.claude.com/docs/en/setup',
		login: 'claude auth login',
		authCheck: { kind: 'claudeStatus' },
	},
	{
		id: 'codex',
		install: { mac: 'npm install -g @openai/codex', linux: 'npm install -g @openai/codex', windows: 'npm install -g @openai/codex' },
		docsUrl: 'https://github.com/openai/codex',
		login: 'codex login',
		authCheck: { kind: 'codexStatus' },
	},
	{
		id: 'cursor-acp',
		install: { mac: 'curl https://cursor.com/install -fsS | bash', linux: 'curl https://cursor.com/install -fsS | bash', windows: `irm 'https://cursor.com/install?win32=true' | iex` },
		docsUrl: 'https://cursor.com/docs/cli/installation',
		login: 'cursor-agent login',
		authCheck: { kind: 'cursorStatus' },
	},
	{
		id: 'opencode',
		install: { mac: 'curl -fsSL https://opencode.ai/install | bash', linux: 'curl -fsSL https://opencode.ai/install | bash', windows: 'npm install -g opencode-ai' },
		docsUrl: 'https://opencode.ai/docs/',
		login: 'opencode auth login',
		authCheck: { kind: 'file', path: '.local/share/opencode/auth.json' },
	},
	{
		id: 'antigravity',
		install: { mac: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', linux: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', windows: 'irm https://antigravity.google/cli/install.ps1 | iex' },
		docsUrl: 'https://antigravity.google/docs/cli/install',
		// The first `agy` run signs in through the browser.
		login: 'agy',
		authCheck: { kind: 'file', path: '.gemini/antigravity-cli/antigravity-oauth-token' },
	},
	{
		id: 'kimi',
		install: { mac: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', linux: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', windows: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex' },
		docsUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started',
		login: 'kimi',
		loginHint: '/login',
		authCheck: { kind: 'none' },
	},
	{
		id: 'grok',
		// Only third-party guides show an install script; the official page is linked instead.
		docsUrl: 'https://docs.x.ai/build/cli/reference',
		login: 'grok login',
		authCheck: { kind: 'file', path: '.grok/auth.json' },
	},
	{
		id: 'muse',
		install: { mac: 'curl -fsSL https://dev.meta.ai/install.sh | sh', linux: 'curl -fsSL https://dev.meta.ai/install.sh | sh' },
		docsUrl: 'https://dev.meta.ai/docs/muse-code',
		login: 'muse',
		loginHint: '/login',
		authCheck: { kind: 'none' },
	},
];

export function agentSetupInfo(id: string): IAgentSetupInfo | undefined {
	return AGENT_SETUP.find(info => info.id === id);
}

export function installCommand(info: IAgentSetupInfo, platform: SetupPlatform): string | undefined {
	return info.install?.[platform];
}

/** The command line that asks a CLI whether it is signed in (`command` is the resolved executable name). */
export function authCheckCommand(check: AgentAuthCheck, command: string): string | undefined {
	switch (check.kind) {
		case 'claudeStatus': return `${command} auth status`;
		case 'codexStatus': return `${command} login status`;
		case 'cursorStatus': return `${command} status --format json`;
		default: return undefined;
	}
}

export type AgentSignIn =
	| { readonly kind: 'signedIn'; readonly account?: string; readonly plan?: string }
	| { readonly kind: 'signedOut' }
	/** The CLI could not say (an error, an unexpected answer, or nothing to ask). */
	| { readonly kind: 'unknown' };

function firstJsonObject(text: string): Record<string, unknown> | undefined {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text.slice(start, end + 1));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function titleCase(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Reads a status command's answer. `exitCode` is null when it timed out or could not start. */
export function parseAuthCheck(check: AgentAuthCheck, exitCode: number | null, stdout: string, stderr: string): AgentSignIn {
	const text = `${stdout}\n${stderr}`;
	switch (check.kind) {
		case 'claudeStatus': {
			const json = firstJsonObject(stdout);
			if (json && typeof json.loggedIn === 'boolean') {
				if (!json.loggedIn) {
					return { kind: 'signedOut' };
				}
				const subscription = typeof json.subscriptionType === 'string' && json.subscriptionType ? `Claude ${titleCase(json.subscriptionType)}` : undefined;
				return { kind: 'signedIn', account: typeof json.email === 'string' ? json.email : undefined, plan: subscription };
			}
			if (/not logged in/i.test(text)) {
				return { kind: 'signedOut' };
			}
			return exitCode === 0 && /logged in/i.test(text) ? { kind: 'signedIn' } : { kind: 'unknown' };
		}
		case 'codexStatus': {
			if (/not logged in/i.test(text)) {
				return { kind: 'signedOut' };
			}
			const match = /logged in using (.+)/i.exec(text);
			if (match && exitCode === 0) {
				const method = match[1].trim();
				return { kind: 'signedIn', plan: method ? (/api key/i.test(method) ? 'API key' : method) : undefined };
			}
			return { kind: 'unknown' };
		}
		case 'cursorStatus': {
			const json = firstJsonObject(stdout);
			if (json && typeof json.isAuthenticated === 'boolean') {
				if (!json.isAuthenticated) {
					return { kind: 'signedOut' };
				}
				const user = json.userInfo as { email?: unknown } | undefined;
				return { kind: 'signedIn', account: typeof user?.email === 'string' ? user.email : undefined };
			}
			if (/not logged in/i.test(text)) {
				return { kind: 'signedOut' };
			}
			const match = /logged in as\s+(\S+)/i.exec(text);
			return match ? { kind: 'signedIn', account: match[1] } : { kind: 'unknown' };
		}
		default:
			return { kind: 'unknown' };
	}
}

/** A credentials file check: the file is there (signed in) or not (signed out). Its content is never read. */
export function parseCredentialsFile(present: boolean | undefined): AgentSignIn {
	return present === undefined ? { kind: 'unknown' } : present ? { kind: 'signedIn' } : { kind: 'signedOut' };
}

/** Terminal title for an install or sign-in run. */
export function setupTerminalName(action: 'install' | 'login', label: string): string {
	return action === 'install' ? `Install ${label}` : `${label} Sign In`;
}
