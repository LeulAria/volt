/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64 } from '../../../../../base/common/buffer.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { antigravityModelsToInfo, parseAntigravityModelLines } from '../../common/models/antigravityModels.js';
import { grokModelsToInfo, IGrokCachedModel, parseGrokModelLines } from '../../common/models/grokModels.js';
import { parseOpenCodeModelLines } from '../../common/models/harnessCatalog.js';
import { isSignInNotice } from '../../common/acpNotices.js';
import { providerFamily } from '../providers/providerBrands.js';
import { IDetectResult, IModelInfo } from '../../common/providers.js';

/** A separate ACP server for a CLI that has no ACP mode of its own. It drives the CLI with the same login. */
export interface IAcpAdapter {
	/** Executable name when the adapter is installed globally. */
	readonly command: string;
	/** Pinned npm package run through npx otherwise. */
	readonly package: string;
}

export interface ICliAgentDefinition {
	readonly id: string;
	readonly label: string;
	/** Executables to look for, in order of preference. */
	readonly commands: readonly string[];
	readonly versionArgs: readonly string[];
	/** Arguments that put the CLI into Agent Client Protocol mode. */
	readonly acpArgs: readonly string[];
	readonly earlyAccess?: boolean;
	readonly acpAdapter?: IAcpAdapter;
	/** Extra environment for the ACP process. */
	readonly acpEnv?: Readonly<Record<string, string>>;
	/** Reads the CLI's own config to work out who is signed in. */
	readonly probeAuth?: (stdio: IVoltStdioService) => Promise<{ account?: string; plan?: string } | undefined>;
}

const CLI_TIMEOUT_MS = 4000;
const MODEL_LIST_TIMEOUT_MS = 15_000;

/**
 * Runs a short lived command and returns its stdout, or undefined if it failed or timed out.
 *
 * Listeners go on before the spawn: the IPC event subscription is lazy, so a fast command
 * (a `cat` of an auth file, a `--version`) can print and exit before a listener attached
 * after `spawn()` resolves, and its output would be lost.
 */
export async function runCli(stdio: IVoltStdioService, command: string, args: readonly string[], timeoutMs = CLI_TIMEOUT_MS): Promise<string | undefined> {
	let id: string | undefined;
	let output = '';
	const early = new Map<string, string>();
	const exitedEarly = new Set<string>();
	let finish: (value: string | undefined) => void = () => { };
	const done = new Promise<string | undefined>(resolve => {
		let settled = false;
		finish = value => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
	});
	const dataListener = stdio.onData(e => {
		if (id === undefined) {
			early.set(e.id, (early.get(e.id) ?? '') + e.data);
		} else if (e.id === id) {
			output += e.data;
		}
	});
	const exitListener = stdio.onExit(e => {
		if (id === undefined) {
			exitedEarly.add(e.id);
		} else if (e.id === id) {
			finish(output);
		}
	});
	try {
		try {
			id = await stdio.spawn({ command, args: [...args] });
		} catch {
			return undefined;
		}
		output = early.get(id) ?? '';
		early.clear();
		if (exitedEarly.has(id)) {
			return output;
		}
		const spawned = id;
		const timer = setTimeout(() => {
			void stdio.kill(spawned);
			finish(output || undefined);
		}, timeoutMs);
		try {
			return await done;
		} finally {
			clearTimeout(timer);
		}
	} finally {
		dataListener.dispose();
		exitListener.dispose();
	}
}

/**
 * Grok's ACP server is `grok agent stdio`. Profiles saved before that was known still
 * say `acp`, which prints the TUI help and never lists a model.
 */
export function grokAcpArgs(args: readonly string[]): string[] {
	if (args.length === 0 || (args.length === 1 && args[0] === 'acp')) {
		return ['agent', 'stdio'];
	}
	return [...args];
}

/**
 * What to spawn for an ACP session. A profile still pointing at the bare CLI of an agent that
 * needs an adapter (including stored `claude acp` and `codex acp` profiles) launches the adapter
 * instead; a custom command is left alone. Stored `grok acp` is rewritten to `grok agent stdio`.
 */
export function acpLaunchFor(def: ICliAgentDefinition | undefined, command: string, args: readonly string[], adapterOnPath: boolean): { command: string; args: string[] } {
	const launchArgs = def?.id === 'grok' ? grokAcpArgs(args) : args;
	const adapter = def?.acpAdapter;
	if (!adapter || !def.commands.includes(command)) {
		return { command, args: [...launchArgs] };
	}
	if (adapterOnPath) {
		return { command: adapter.command, args: [] };
	}
	return { command: isWindows ? 'npx.cmd' : 'npx', args: ['-y', adapter.package] };
}

/** Reads a file below the user's home directory through the shell, since the renderer has no home path. */
export async function readHomeFile(stdio: IVoltStdioService, posixPath: string): Promise<string | undefined> {
	const output = isWindows
		? await runCli(stdio, 'cmd', ['/c', `type "%USERPROFILE%\\${posixPath.replace(/\//g, '\\')}"`])
		: await runCli(stdio, '/bin/sh', ['-c', `cat "$HOME/${posixPath}" 2>/dev/null`]);
	const trimmed = output?.trim();
	return trimmed || undefined;
}

async function readHomeJson<T>(stdio: IVoltStdioService, posixPath: string): Promise<T | undefined> {
	const raw = await readHomeFile(stdio, posixPath);
	if (!raw) {
		return undefined;
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const segment = token.split('.')[1];
	if (!segment) {
		return undefined;
	}
	const base64 = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
	try {
		return JSON.parse(decodeBase64(base64).toString()) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function titleCase(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

export async function probeCodexAuth(stdio: IVoltStdioService): Promise<{ account?: string; plan?: string } | undefined> {
	const auth = await readHomeJson<{ tokens?: { id_token?: string } }>(stdio, '.codex/auth.json');
	const idToken = auth?.tokens?.id_token;
	if (!idToken) {
		return undefined;
	}
	const payload = decodeJwtPayload(idToken);
	if (!payload) {
		return undefined;
	}
	const claims = payload['https://api.openai.com/auth'] as { chatgpt_plan_type?: string } | undefined;
	const planType = claims?.chatgpt_plan_type;
	return {
		account: typeof payload.email === 'string' ? payload.email : undefined,
		plan: planType ? `ChatGPT ${titleCase(planType)} Subscription` : undefined,
	};
}

export async function probeClaudeAuth(stdio: IVoltStdioService): Promise<{ account?: string; plan?: string } | undefined> {
	const config = await readHomeJson<{ oauthAccount?: { emailAddress?: string } }>(stdio, '.claude.json');
	const credentials = await readHomeJson<{ claudeAiOauth?: { subscriptionType?: string } }>(stdio, '.claude/.credentials.json');
	const account = config?.oauthAccount?.emailAddress;
	const subscription = credentials?.claudeAiOauth?.subscriptionType;
	if (!account && !subscription) {
		return undefined;
	}
	return {
		account,
		plan: subscription ? `Claude ${titleCase(subscription)} Subscription` : undefined,
	};
}

async function probeHomeConfig(stdio: IVoltStdioService, posixPath: string, account: string, plan: string): Promise<{ account?: string; plan?: string } | undefined> {
	const raw = await readHomeFile(stdio, posixPath);
	if (!raw) {
		return undefined;
	}
	return { account, plan };
}

async function probeKimiAuth(stdio: IVoltStdioService): Promise<{ account?: string; plan?: string } | undefined> {
	return probeHomeConfig(stdio, '.kimi-code/config.toml', 'kimi', 'Kimi Code');
}

async function probeMuseAuth(stdio: IVoltStdioService): Promise<{ account?: string; plan?: string } | undefined> {
	return probeHomeConfig(stdio, '.config/muse/settings.json', 'muse', 'Muse Code');
}

async function probeGrokAuth(stdio: IVoltStdioService): Promise<{ account?: string; plan?: string } | undefined> {
	return probeHomeConfig(stdio, '.grok/auth.json', 'grok.com', 'Signed in');
}

/** `grok models`, enriched from the CLI's model cache when it has effort and context. */
export async function listGrokModels(stdio: IVoltStdioService, command: string): Promise<IModelInfo[]> {
	const [output, cache] = await Promise.all([
		runCli(stdio, command, ['models'], MODEL_LIST_TIMEOUT_MS),
		readHomeJson<{ models?: Record<string, { info?: { name?: string; description?: string; context_window?: number; hidden?: boolean; reasoning_effort?: string; reasoning_efforts?: { value?: string; default?: boolean }[] } }> }>(stdio, '.grok/models_cache.json'),
	]);
	const cached: Record<string, IGrokCachedModel> = {};
	for (const [id, entry] of Object.entries(cache?.models ?? {})) {
		const info = entry?.info;
		if (!info || info.hidden) {
			continue;
		}
		const efforts = (info.reasoning_efforts ?? []).flatMap(effort => effort.value ? [effort.value] : []);
		cached[id] = {
			name: info.name,
			description: info.description,
			contextWindow: info.context_window,
			defaultEffort: info.reasoning_effort,
			...(efforts.length ? { efforts } : {}),
		};
	}
	return grokModelsToInfo(parseGrokModelLines(output ?? ''), cached);
}

/** Synara's discovery path: `agy models` rather than a throwaway ACP session. */
export async function listAntigravityModels(stdio: IVoltStdioService, command: string): Promise<IModelInfo[]> {
	const output = await runCli(stdio, command, ['models'], MODEL_LIST_TIMEOUT_MS);
	return antigravityModelsToInfo(parseAntigravityModelLines(output ?? ''));
}

export async function probeOpenCodeAuth(stdio: IVoltStdioService): Promise<{ account?: string; plan?: string } | undefined> {
	const auth = await readHomeJson<Record<string, unknown>>(stdio, '.local/share/opencode/auth.json');
	const upstream = auth ? Object.keys(auth).length : 0;
	if (!upstream) {
		return undefined;
	}
	return {
		account: 'opencode',
		plan: `${upstream} upstream provider${upstream === 1 ? '' : 's'} connected through OpenCode`,
	};
}

export const CLI_AGENT_DEFINITIONS: readonly ICliAgentDefinition[] = [
	{
		id: 'codex',
		label: 'Codex',
		commands: ['codex'],
		versionArgs: ['--version'],
		// Codex has no `acp` subcommand. `codex acp` starts the TUI, which exits with
		// "stdin is not a terminal" when Volt pipes stdio. The adapter speaks ACP for it.
		acpArgs: [],
		acpAdapter: { command: 'codex-acp', package: '@agentclientprotocol/codex-acp@1.13.1' },
		probeAuth: probeCodexAuth,
	},
	{
		id: 'claude-code',
		label: 'Claude',
		commands: ['claude'],
		versionArgs: ['--version'],
		// Claude Code has no `acp` subcommand; the official adapter speaks ACP for it.
		acpArgs: [],
		acpAdapter: { command: 'claude-agent-acp', package: '@agentclientprotocol/claude-agent-acp@0.81.2' },
		// Claude Code turns its to-do tools (TodoWrite / TaskCreate) on only for older models, so Opus 5.5
		// and newer had no list to show in the Tasks card. This switch turns them on for every model.
		acpEnv: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
		probeAuth: probeClaudeAuth,
	},
	{
		id: 'cursor-acp',
		label: 'Cursor',
		commands: ['cursor-agent', 'agent'],
		versionArgs: ['--version'],
		acpArgs: ['acp'],
		earlyAccess: true,
	},
	{
		id: 'grok',
		label: 'Grok',
		commands: ['grok'],
		versionArgs: ['--version'],
		// `grok acp` is not a command. ACP is `grok agent stdio`.
		acpArgs: ['agent', 'stdio'],
		earlyAccess: true,
		probeAuth: probeGrokAuth,
	},
	{
		id: 'opencode',
		label: 'OpenCode',
		commands: ['opencode'],
		versionArgs: ['--version'],
		acpArgs: ['acp'],
		probeAuth: probeOpenCodeAuth,
	},
	{
		id: 'antigravity',
		label: 'Antigravity',
		commands: ['agy'],
		versionArgs: ['--version'],
		acpArgs: ['acp'],
	},
	{
		id: 'kimi',
		label: 'Kimi Code',
		commands: ['kimi'],
		versionArgs: ['--version'],
		acpArgs: ['acp'],
		probeAuth: probeKimiAuth,
	},
	{
		id: 'muse',
		label: 'Muse Code',
		commands: ['muse'],
		versionArgs: ['--version'],
		acpArgs: ['acp'],
		probeAuth: probeMuseAuth,
	},
];

/** OpenCode's model command. Empty when the CLI is missing or nobody is signed in. */
export async function listOpenCodeModels(stdio: IVoltStdioService, command = 'opencode'): Promise<IModelInfo[]> {
	const auth = await probeOpenCodeAuth(stdio).catch(() => undefined);
	if (!auth) {
		return [];
	}
	const output = await runCli(stdio, command, ['models'], MODEL_LIST_TIMEOUT_MS);
	return parseOpenCodeModelLines(output ?? '');
}

export function cliAgentDefinition(providerId: string): ICliAgentDefinition | undefined {
	return CLI_AGENT_DEFINITIONS.find(def => def.id === providerId);
}

/**
 * Commands that actually start a sign-in. `claude login` is a prompt, not a command;
 * Claude Code's login is `claude auth login`.
 */
const CLI_LOGIN_COMMANDS: Record<string, string> = {
	'claude-code': 'claude auth login',
	codex: 'codex login',
	'cursor-acp': 'cursor-agent login',
	opencode: 'opencode auth login',
};

export interface ICliLogin {
	readonly providerId: string;
	readonly label: string;
	readonly command: string;
}

/** Login for a sign-in notice. The named CLI wins; otherwise the chat's current provider. */
export function cliLoginForNotice(title: string, description: string | undefined, providerId: string | undefined): ICliLogin | undefined {
	if (!isSignInNotice(title, description)) {
		return undefined;
	}
	const text = `${title}\n${description ?? ''}`;
	const named = CLI_AGENT_DEFINITIONS.find(def => mentionsCli(text, def));
	const def = named ?? cliAgentForProvider(providerId);
	const command = def ? CLI_LOGIN_COMMANDS[def.id] : undefined;
	if (!def || !command) {
		return undefined;
	}
	return { providerId: def.id, label: def.label, command };
}

function mentionsCli(text: string, def: ICliAgentDefinition): boolean {
	const tokens = [def.label, ...def.commands.filter(command => command !== 'agent')];
	return tokens.some(token => new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(text));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cliAgentForProvider(providerId: string | undefined): ICliAgentDefinition | undefined {
	if (!providerId) {
		return undefined;
	}
	return cliAgentDefinition(providerId) ?? CLI_AGENT_DEFINITIONS.find(def => providerFamily(def.id) === providerFamily(providerId));
}

/** Pulls a semver-ish token out of `--version` output, which is rarely just the number. */
function parseVersion(output: string | undefined): string | undefined {
	const match = output?.match(/\d+\.\d+(\.\d+)?([-.][0-9A-Za-z]+)*/);
	return match ? `v${match[0]}` : undefined;
}

export async function detectCliAgent(stdio: IVoltStdioService, def: ICliAgentDefinition, preferredCommand?: string): Promise<IDetectResult> {
	const candidates = preferredCommand ? [preferredCommand, ...def.commands] : def.commands;
	let command: string | undefined;
	let path: string | undefined;
	for (const candidate of candidates) {
		const resolved = await stdio.which(candidate);
		if (resolved) {
			command = candidate;
			path = resolved;
			break;
		}
	}

	if (!command) {
		return {
			available: false,
			detail: `Not installed - ${def.commands[0]} was not found on PATH.`,
		};
	}

	const [version, auth] = await Promise.all([
		runCli(stdio, command, def.versionArgs).then(parseVersion),
		def.probeAuth?.(stdio).catch(() => undefined) ?? Promise.resolve(undefined),
	]);

	if (auth?.account || auth?.plan) {
		const detail = [auth.account ? `Authenticated as ${auth.account}` : 'Authenticated', auth.plan].filter(Boolean).join(' - ');
		return { available: true, authenticated: true, version, path, account: auth.account, plan: auth.plan, detail };
	}

	return {
		available: true,
		authenticated: false,
		version,
		path,
		detail: 'Available - Installed and ready, but authentication could not be verified.',
	};
}
