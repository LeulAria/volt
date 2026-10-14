/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { IVoltUsageLimitGroup, IVoltUsageLimitWindow } from '../common/voltUsage.js';

/**
 * Subscriptions that report limits but leave no transcripts Volt reads: OpenCode Go and Grok
 * (the `grok` CLI's grok.com login). Neither has an account id in its answer, so the account is
 * named by a hash of the login: the same login on two machines still counts once.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isoMs(value: unknown): number | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

async function readText(path: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path, 'utf8');
	} catch {
		return undefined;
	}
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
	try {
		return text ? record(JSON.parse(text)) : undefined;
	} catch {
		return undefined;
	}
}

function fingerprint(prefix: string, secret: string): string {
	return createHash('sha256').update(`${prefix}\0`).update(secret).digest('hex').slice(0, 24);
}

//#region OpenCode Go

/** OpenCode keeps provider logins in `$XDG_DATA_HOME/opencode/auth.json`; stored keys win over `OPENCODE_API_KEY`. */
async function readOpenCodeGoKey(home: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const dataHome = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share');
	const auth = parseJson(env.OPENCODE_AUTH_CONTENT || await readText(join(dataHome, 'opencode', 'auth.json')));
	const go = record(auth?.['opencode-go']);
	const stored = go?.type === 'api' && typeof go.key === 'string' ? go.key : undefined;
	return (stored ?? env.OPENCODE_API_KEY)?.trim() || undefined;
}

export function openCodeGoWindows(body: unknown): IVoltUsageLimitWindow[] {
	const usage = record(record(body)?.usage);
	const rows: [string, string, number | undefined][] = [
		['rolling', 'Current session', 5 * HOUR_MS],
		['weekly', 'Weekly', 7 * DAY_MS],
		['monthly', 'Monthly', 30 * DAY_MS],
	];
	const windows: IVoltUsageLimitWindow[] = [];
	for (const [key, label, windowMs] of rows) {
		const window = record(usage?.[key]);
		const percent = finite(window?.percent);
		if (percent === undefined) {
			continue;
		}
		const resetsAt = isoMs(window?.resetsAt);
		windows.push({ id: `go_${key}`, label, usedPercent: clampPercent(percent), ...(windowMs ? { windowMs } : {}), ...(resetsAt ? { resetsAt } : {}) });
	}
	return windows;
}

/** OpenCode Go's session, weekly and monthly allowance. Undefined without a Go key or subscription. */
export async function readOpenCodeGoLimits(home: string, env: NodeJS.ProcessEnv): Promise<IVoltUsageLimitGroup | undefined> {
	const key = await readOpenCodeGoKey(home, env);
	if (!key) {
		return undefined;
	}
	const checkedAt = Date.now();
	const account = { id: `opencode:${fingerprint('opencode-go', key)}` };
	try {
		const response = await fetch('https://opencode.ai/zen/go/v1/usage', {
			headers: { 'Authorization': `Bearer ${key}` },
			signal: AbortSignal.timeout(8_000),
		});
		// A Zen key without a Go subscription.
		if (response.status === 403) {
			return undefined;
		}
		if (response.status === 401) {
			return { provider: 'opencode', account, plan: 'Go', windows: [], checkedAt, error: 'Sign in to OpenCode Go again to read your limits.' };
		}
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		return { provider: 'opencode', account, plan: 'Go', windows: openCodeGoWindows(await response.json()), checkedAt };
	} catch {
		return { provider: 'opencode', account, plan: 'Go', windows: [], checkedAt, error: 'OpenCode Go limits could not be read. Check your connection and refresh.' };
	}
}

//#endregion

//#region Grok

/** Settings that point the CLI at another account, endpoint or an API key; their limits aren't the grok.com subscription's. */
const GROK_CUSTOM_AUTH_ENV = [
	'XAI_API_KEY', 'GROK_OIDC_ISSUER', 'GROK_OIDC_CLIENT_ID', 'GROK_OAUTH2_ISSUER', 'GROK_OAUTH2_CLIENT_ID', 'GROK_OAUTH2_PRINCIPAL_TYPE',
	'GROK_OAUTH2_PRINCIPAL_ID', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_LOCAL_AUTH', 'GROK_CLI_CHAT_PROXY_BASE_URL', 'GROK_MODELS_BASE_URL', 'GROK_CONFIG', 'GROK_CONFIG_PATH',
];

/** The two keys the CLI stores its grok.com login under; never an arbitrary other deployment's. */
const GROK_LOGIN_KEYS = ['https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828', 'https://accounts.x.ai/sign-in'];

interface IGrokLogin {
	readonly token: string;
	readonly email?: string;
}

async function readGrokLogin(home: string, env: NodeJS.ProcessEnv): Promise<IGrokLogin | undefined> {
	if (GROK_CUSTOM_AUTH_ENV.some(name => env[name]?.trim())) {
		return undefined;
	}
	const grokHome = env.GROK_HOME?.trim() || join(home, '.grok');
	for (const configPath of [join(grokHome, 'config.toml'), join(grokHome, 'managed_config.toml'), join(grokHome, 'requirements.toml'), '/etc/grok/managed_config.toml', '/etc/grok/requirements.toml']) {
		// These sections can change the selected account or endpoint.
		if (/^\s*(?:\[\[?\s*)?["']?(?:auth|grok_com_config|endpoints)["']?\s*[.\]=]/m.test(await readText(configPath) ?? '')) {
			return undefined;
		}
	}
	const logins = parseJson(env.GROK_AUTH?.trim() || await readText(join(grokHome, 'auth.json')));
	const login = GROK_LOGIN_KEYS.map(key => record(logins?.[key])).find(Boolean);
	const token = typeof login?.key === 'string' ? login.key.trim() : '';
	if (!login || !token || login.auth_mode === 'api_key') {
		return undefined;
	}
	const email = typeof login.email === 'string' && login.email.trim() ? login.email.trim() : undefined;
	return { token, ...(email ? { email } : {}) };
}

/**
 * Grok's one allowance for the billing period. xAI leaves the percentage out until something is
 * metered, which reads as nothing used rather than as no limit.
 */
export function grokWindows(body: unknown): IVoltUsageLimitWindow[] {
	const config = record(record(body)?.config);
	const period = record(config?.currentPeriod);
	const type = typeof period?.type === 'string' ? period.type.replace(/^USAGE_PERIOD_TYPE_/, '') : '';
	const resetsAt = isoMs(period?.end);
	const label = type === 'WEEKLY' ? 'Weekly' : type === 'MONTHLY' ? 'Monthly' : 'Subscription';
	const windowMs = type === 'WEEKLY' ? 7 * DAY_MS : type === 'MONTHLY' ? 30 * DAY_MS : undefined;
	return [{ id: 'subscription', label, usedPercent: clampPercent(finite(config?.creditUsagePercent) ?? 0), ...(windowMs ? { windowMs } : {}), ...(resetsAt ? { resetsAt } : {}) }];
}

/** The `grok` CLI's grok.com subscription allowance. Undefined without that login. */
export async function readGrokLimits(home: string, env: NodeJS.ProcessEnv): Promise<IVoltUsageLimitGroup | undefined> {
	const login = await readGrokLogin(home, env);
	if (!login) {
		return undefined;
	}
	const checkedAt = Date.now();
	const account = { id: `grok:${fingerprint('grok', login.email ?? login.token)}`, ...(login.email ? { label: login.email } : {}) };
	try {
		const response = await fetch('https://cli-chat-proxy.grok.com/v1/billing?format=credits', {
			headers: { 'Authorization': `Bearer ${login.token}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (response.status === 401 || response.status === 403) {
			return { provider: 'grok', account, windows: [], checkedAt, error: 'Run `grok login` again to read your limits.' };
		}
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		return { provider: 'grok', account, windows: grokWindows(await response.json()), checkedAt };
	} catch {
		return { provider: 'grok', account, windows: [], checkedAt, error: 'Grok limits could not be read. Check your connection and refresh.' };
	}
}

//#endregion
