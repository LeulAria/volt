/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64 } from '../../../../base/common/buffer.js';
import { isWindows } from '../../../../base/common/platform.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { IDetectResult } from '../common/providers.js';

export interface ICliAgentDefinition {
	readonly id: string;
	readonly label: string;
	/** Executables to look for, in order of preference. */
	readonly commands: readonly string[];
	readonly versionArgs: readonly string[];
	/** Arguments that put the CLI into Agent Client Protocol mode. */
	readonly acpArgs: readonly string[];
	readonly earlyAccess?: boolean;
	/** Reads the CLI's own config to work out who is signed in. */
	readonly probeAuth?: (stdio: IVoltStdioService) => Promise<{ account?: string; plan?: string } | undefined>;
}

const CLI_TIMEOUT_MS = 4000;

/** Runs a short lived command and returns its stdout, or undefined if it failed or timed out. */
export async function runCli(stdio: IVoltStdioService, command: string, args: readonly string[]): Promise<string | undefined> {
	let id: string;
	try {
		id = await stdio.spawn({ command, args: [...args] });
	} catch {
		return undefined;
	}

	return new Promise<string | undefined>(resolve => {
		let output = '';
		let settled = false;
		const finish = (value: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			dataListener.dispose();
			exitListener.dispose();
			resolve(value);
		};
		const dataListener = stdio.onData(e => {
			if (e.id === id) {
				output += e.data;
			}
		});
		const exitListener = stdio.onExit(e => {
			if (e.id === id) {
				finish(output);
			}
		});
		const timer = setTimeout(() => {
			void stdio.kill(id);
			finish(output || undefined);
		}, CLI_TIMEOUT_MS);
	});
}

/** Reads a file below the user's home directory through the shell, since the renderer has no home path. */
async function readHomeFile(stdio: IVoltStdioService, posixPath: string): Promise<string | undefined> {
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

async function probeCodexAuth(stdio: IVoltStdioService): Promise<{ account?: string; plan?: string } | undefined> {
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

async function probeClaudeAuth(stdio: IVoltStdioService): Promise<{ account?: string; plan?: string } | undefined> {
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

async function probeOpenCodeAuth(stdio: IVoltStdioService): Promise<{ account?: string; plan?: string } | undefined> {
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
		acpArgs: ['acp'],
		probeAuth: probeCodexAuth,
	},
	{
		id: 'claude-code',
		label: 'Claude',
		commands: ['claude'],
		versionArgs: ['--version'],
		acpArgs: ['acp'],
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
		acpArgs: ['acp'],
		earlyAccess: true,
	},
	{
		id: 'opencode',
		label: 'OpenCode',
		commands: ['opencode'],
		versionArgs: ['--version'],
		acpArgs: ['acp'],
		probeAuth: probeOpenCodeAuth,
	},
];

export function cliAgentDefinition(providerId: string): ICliAgentDefinition | undefined {
	return CLI_AGENT_DEFINITIONS.find(def => def.id === providerId);
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
