/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { dirname, join } from '../../../base/common/path.js';
import { IVoltUsageLimitGroup, IVoltUsageLimitWindow } from '../common/voltUsage.js';
import { ICodexRateLimitSample, IUsageRecord } from './usageTranscripts.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): number | undefined {
	const n = typeof value === 'string' && value.trim() ? Number(value) : value;
	return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function isoMs(value: unknown): number | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/** Reads a generic password the way the CLIs store them. `security` is on each item's access list, so no prompt. */
function readKeychain(service: string, account?: string): Promise<string | undefined> {
	if (process.platform !== 'darwin') {
		return Promise.resolve(undefined);
	}
	const args = ['find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w'];
	return new Promise(resolve => {
		execFile('/usr/bin/security', args, { timeout: 10_000 }, (error, stdout) => {
			const value = stdout?.trim();
			resolve(error || !value ? undefined : value);
		});
	});
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		return record(JSON.parse(await fs.readFile(path, 'utf8')));
	} catch {
		return undefined;
	}
}

//#region Claude

interface IClaudeCredentials {
	readonly accessToken: string;
	readonly expiresAt?: number;
	readonly subscriptionType?: string;
	readonly rateLimitTier?: string;
}

async function readClaudeCredentials(home: string): Promise<IClaudeCredentials | undefined> {
	const fromKeychain = await readKeychain('Claude Code-credentials');
	let parsed: Record<string, unknown> | undefined;
	if (fromKeychain) {
		try {
			parsed = record(JSON.parse(fromKeychain));
		} catch {
			parsed = undefined;
		}
	}
	parsed ??= await readJson(join(home, '.claude', '.credentials.json'));
	const oauth = record(parsed?.claudeAiOauth);
	const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken : undefined;
	if (!accessToken) {
		return undefined;
	}
	return {
		accessToken,
		expiresAt: finite(oauth?.expiresAt),
		subscriptionType: typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
		rateLimitTier: typeof oauth?.rateLimitTier === 'string' ? oauth.rateLimitTier : undefined,
	};
}

/** "default_claude_max_5x" → "Max 5x"; falls back to the subscription type. */
function claudePlan(credentials: IClaudeCredentials): string | undefined {
	const tier = credentials.rateLimitTier?.match(/(max|pro|team|enterprise)_?(\d+x)?$/i);
	if (tier) {
		return [tier[1][0].toUpperCase() + tier[1].slice(1).toLowerCase(), tier[2]].filter(Boolean).join(' ');
	}
	const type = credentials.subscriptionType;
	return type ? type[0].toUpperCase() + type.slice(1) : undefined;
}

interface IClaudeFetch {
	readonly group?: IVoltUsageLimitGroup;
	/** The endpoint said 429; wait this long before asking again. */
	readonly retryAfterMs?: number;
	/** A network or server failure worth papering over with the last good reading. */
	readonly transient?: boolean;
}

async function fetchClaudeLimits(home: string): Promise<IClaudeFetch> {
	const checkedAt = Date.now();
	const credentials = await readClaudeCredentials(home);
	if (!credentials) {
		return {};
	}
	const plan = claudePlan(credentials);
	if (credentials.expiresAt && credentials.expiresAt < checkedAt) {
		return { group: { provider: 'claude', plan, windows: [], checkedAt, error: 'Claude Code\u2019s sign-in has expired. Send any Claude message to renew it, then refresh.' } };
	}
	try {
		const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
			headers: {
				'Authorization': `Bearer ${credentials.accessToken}`,
				'anthropic-beta': 'oauth-2025-04-20',
				'Content-Type': 'application/json',
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (response.status === 429) {
			const seconds = Number(response.headers.get('retry-after'));
			return { retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0, transient: true };
		}
		if (response.status === 401 || response.status === 403) {
			return { group: { provider: 'claude', plan, windows: [], checkedAt, error: 'Sign in to Claude Code again to read your limits.' } };
		}
		if (!response.ok) {
			return { group: { provider: 'claude', plan, windows: [], checkedAt, error: 'Claude limits could not be read. Refresh to try again.' }, transient: true };
		}
		return { group: { provider: 'claude', plan, windows: claudeWindows(await response.json()), checkedAt } };
	} catch {
		return { group: { provider: 'claude', plan, windows: [], checkedAt, error: 'Claude limits could not be read. Check your connection and refresh.' }, transient: true };
	}
}

/** Claude's usage endpoint is asked at most this often, refresh button included. */
const CLAUDE_MIN_INTERVAL_MS = 60_000;
/** After a 429, wait at least this long. */
const CLAUDE_BACKOFF_MS = 3 * 60_000;

/**
 * Reads Claude's limits without tripping its rate limit. Claude Code, T3 Code and Volt all poll
 * the same endpoint with the same sign-in, and it answers 429 when they add up. The last good
 * reading is kept (on disk too, so a restart has numbers at once) and shown with its age while
 * the endpoint cools down, instead of an error.
 */
export class ClaudeLimitsReader {

	private last: IVoltUsageLimitGroup | undefined;
	private backoffUntil = 0;
	private loaded = false;

	constructor(private readonly home: string, private readonly cachePath: string) { }

	async read(): Promise<IVoltUsageLimitGroup | undefined> {
		await this.load();
		const now = Date.now();
		if (this.last && (now < this.backoffUntil || now - this.last.checkedAt < CLAUDE_MIN_INTERVAL_MS)) {
			return this.last;
		}
		if (now < this.backoffUntil) {
			return this.coolingDown(now);
		}
		const result = await fetchClaudeLimits(this.home);
		if (result.retryAfterMs !== undefined) {
			this.backoffUntil = now + Math.max(result.retryAfterMs, CLAUDE_BACKOFF_MS);
			return this.last ?? this.coolingDown(now);
		}
		if (result.group && !result.group.error) {
			this.last = result.group;
			void this.save(result.group);
			return result.group;
		}
		return result.transient && this.last ? this.last : result.group;
	}

	private coolingDown(now: number): IVoltUsageLimitGroup {
		return { provider: 'claude', windows: [], checkedAt: now, error: 'Claude is limiting how often usage can be checked. Volt will try again in a few minutes.' };
	}

	private async load(): Promise<void> {
		if (this.loaded) {
			return;
		}
		this.loaded = true;
		const cached = await readJson(this.cachePath);
		if (cached?.provider === 'claude' && Array.isArray(cached.windows) && typeof cached.checkedAt === 'number') {
			this.last = cached as unknown as IVoltUsageLimitGroup;
		}
	}

	private async save(group: IVoltUsageLimitGroup): Promise<void> {
		try {
			await fs.mkdir(dirname(this.cachePath), { recursive: true });
			await fs.writeFile(this.cachePath, JSON.stringify(group));
		} catch {
			// Only a warm start is lost.
		}
	}
}

/** Prefers the `limits` list (session, weekly, per-model weekly); older payloads only had the named windows. */
export function claudeWindows(body: unknown): IVoltUsageLimitWindow[] {
	const data = record(body);
	const windows: IVoltUsageLimitWindow[] = [];
	const limits = Array.isArray(data?.limits) ? data.limits : [];
	for (const raw of limits) {
		const limit = record(raw);
		const percent = finite(limit?.percent);
		if (!limit || percent === undefined) {
			continue;
		}
		const kind = String(limit.kind ?? '');
		const resetsAt = isoMs(limit.resets_at);
		const scopeName = record(record(limit.scope)?.model)?.display_name;
		const session = limit.group === 'session' || kind === 'session';
		// Claude Code's /usage wording: "Current session", "Current week (all models)", "Current week (Fable)".
		const label = session ? 'Current session' : 'Current week';
		const scope = session ? undefined : kind === 'weekly_all' || !scopeName ? 'All models' : String(scopeName);
		windows.push({
			id: `${kind}:${typeof scopeName === 'string' ? scopeName : ''}`,
			label,
			...(scope ? { scope } : {}),
			usedPercent: clampPercent(percent),
			windowMs: session ? 5 * HOUR_MS : 7 * DAY_MS,
			...(resetsAt ? { resetsAt } : {}),
		});
	}
	if (windows.length) {
		return windows;
	}
	const named: [string, string, string | undefined, number][] = [['five_hour', 'Current session', undefined, 5 * HOUR_MS], ['seven_day', 'Current week', 'All models', 7 * DAY_MS], ['seven_day_opus', 'Current week', 'Opus', 7 * DAY_MS], ['seven_day_sonnet', 'Current week', 'Sonnet', 7 * DAY_MS]];
	for (const [key, label, scope, windowMs] of named) {
		const window = record(data?.[key]);
		const utilization = finite(window?.utilization);
		if (utilization === undefined) {
			continue;
		}
		const resetsAt = isoMs(window?.resets_at);
		windows.push({ id: key, label, ...(scope ? { scope } : {}), usedPercent: clampPercent(utilization), windowMs, ...(resetsAt ? { resetsAt } : {}) });
	}
	return windows;
}

//#endregion

//#region Codex

const CODEX_COMMANDS = (home: string) => [
	join(home, '.codex', 'plugins', '.plugin-appserver', 'codex-cli', 'bin', 'codex'),
	'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
	'/Applications/Conductor.app/Contents/Resources/bin/codex',
	'codex',
];

/** Codex's /status wording: "5h limit", "Weekly limit". */
function codexWindowLabel(minutes: number | undefined): string {
	if (minutes === 10080) {
		return 'Weekly limit';
	}
	if (!minutes) {
		return 'Limit';
	}
	return minutes % 1440 === 0 ? `${minutes / 1440}-day limit` : `${Math.round(minutes / 60)}-hour limit`;
}

function codexPlan(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value[0].toUpperCase() + value.slice(1) : undefined;
}

/** Normalizes both the app-server (camelCase) and rollout (snake_case) shapes. */
export function codexGroup(raw: Record<string, unknown>, checkedAt: number, resetCredits?: number): IVoltUsageLimitGroup {
	const windows: IVoltUsageLimitWindow[] = [];
	for (const key of ['primary', 'secondary']) {
		const window = record(raw[key]);
		const used = finite(window?.usedPercent ?? window?.used_percent);
		if (!window || used === undefined) {
			continue;
		}
		const minutes = finite(window.windowDurationMins ?? window.window_minutes);
		const resetsAtSeconds = finite(window.resetsAt ?? window.resets_at);
		const resetsAt = resetsAtSeconds ? resetsAtSeconds * 1000 : undefined;
		// A window that already reset is back to zero, even if the sample predates the reset.
		const expired = resetsAt !== undefined && resetsAt <= Date.now();
		windows.push({
			id: key,
			label: codexWindowLabel(minutes),
			usedPercent: expired ? 0 : clampPercent(used),
			...(minutes ? { windowMs: minutes * 60_000 } : {}),
			...(resetsAt && !expired ? { resetsAt } : {}),
		});
	}
	return {
		provider: 'codex',
		plan: codexPlan(raw.planType ?? raw.plan_type),
		windows,
		checkedAt,
		...(resetCredits ? { resetCredits } : {}),
	};
}

/** Asks `codex app-server` for the live numbers; it reads them from the account, not from a transcript. */
async function readCodexAppServer(home: string, env: NodeJS.ProcessEnv): Promise<IVoltUsageLimitGroup | undefined> {
	for (const command of CODEX_COMMANDS(home)) {
		if (command.startsWith('/')) {
			try {
				await fs.access(command);
			} catch {
				continue;
			}
		}
		const result = await new Promise<Record<string, unknown> | undefined>(resolve => {
			let settled = false;
			let buffer = '';
			const child = spawn(command, ['app-server', '--stdio'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
			const finish = (value: Record<string, unknown> | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				child.kill();
				resolve(value);
			};
			const timer = setTimeout(() => finish(undefined), 12_000);
			child.on('error', () => finish(undefined));
			child.on('exit', () => finish(undefined));
			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => {
				buffer += chunk;
				let newline: number;
				while ((newline = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					try {
						const message = record(JSON.parse(line));
						if (message?.id === 2) {
							finish(record(message.result));
						} else if (message?.id !== undefined && message.method) {
							// The server can ask us things (approvals); answer with nothing.
							child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n');
						}
					} catch {
						// Not JSON-RPC; ignore.
					}
				}
			});
			child.stdin.on('error', () => finish(undefined));
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'volt', title: 'Volt', version: '0.1.0' } } }) + '\n');
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} }) + '\n');
		});
		const limits = record(result?.rateLimits);
		if (limits) {
			const credits = finite(record(result?.rateLimitResetCredits)?.availableCount);
			return codexGroup(limits, Date.now(), credits);
		}
	}
	return undefined;
}

/** `fallback` supplies the newest sample from the rollouts, used only when app-server cannot be reached. */
export async function readCodexLimits(home: string, env: NodeJS.ProcessEnv, fallback: () => Promise<ICodexRateLimitSample | undefined>): Promise<IVoltUsageLimitGroup | undefined> {
	const live = await readCodexAppServer(home, env);
	if (live) {
		return live;
	}
	const sample = await fallback();
	return sample ? codexGroup(sample.raw, sample.timestampMs) : undefined;
}

//#endregion

//#region Cursor

async function readCursorToken(home: string): Promise<string | undefined> {
	const fromEnv = process.env.CURSOR_AUTH_TOKEN?.trim();
	if (fromEnv) {
		return fromEnv;
	}
	const fromKeychain = await readKeychain('cursor-access-token', 'cursor-user');
	if (fromKeychain) {
		return fromKeychain;
	}
	const file = await readJson(join(home, '.cursor', 'auth.json')) ?? await readJson(join(home, '.config', 'cursor', 'auth.json'));
	return typeof file?.accessToken === 'string' ? file.accessToken : undefined;
}

/** The user id in the token's `sub` (`auth0|user_…`), needed for the dashboard cookie. */
function cursorUserId(token: string): string | undefined {
	try {
		const payload = record(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')));
		const subject = typeof payload?.sub === 'string' ? payload.sub : undefined;
		return subject?.split('|').at(-1) || undefined;
	} catch {
		return undefined;
	}
}

export async function readCursorLimits(home: string): Promise<IVoltUsageLimitGroup | undefined> {
	const checkedAt = Date.now();
	const token = await readCursorToken(home);
	if (!token) {
		return undefined;
	}
	try {
		const response = await fetch('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json',
				'connect-protocol-version': '1',
				'x-cursor-client-type': 'cli',
			},
			body: '{}',
			signal: AbortSignal.timeout(10_000),
		});
		if (response.status === 401 || response.status === 403) {
			return { provider: 'cursor', windows: [], checkedAt, error: 'Sign in to Cursor again to read your limits.' };
		}
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		return { provider: 'cursor', windows: cursorWindows(await response.json()), checkedAt };
	} catch {
		return { provider: 'cursor', windows: [], checkedAt, error: 'Cursor limits could not be read. Check your connection and refresh.' };
	}
}

export function cursorWindows(body: unknown): IVoltUsageLimitWindow[] {
	const data = record(body);
	const usage = record(data?.planUsage);
	const start = finite(data?.billingCycleStart);
	const end = finite(data?.billingCycleEnd);
	const windowMs = start && end && end > start ? end - start : undefined;
	const windows: IVoltUsageLimitWindow[] = [];
	// The two pools Cursor's dashboard shows, in its words. Its blended total is not shown there, so not here.
	const rows: [string, string, string | undefined, string][] = [
		['autoPercentUsed', 'Cursor Models', 'Includes Cursor Grok and Composer', 'Additional usage beyond limits consumes Other Models quota or on-demand spend.'],
		['apiPercentUsed', 'Other Models', undefined, 'Additional usage beyond limits consumes on-demand spend.'],
	];
	for (const [key, label, scope, note] of rows) {
		const used = finite(usage?.[key]);
		if (used === undefined) {
			continue;
		}
		windows.push({ id: key, label, ...(scope ? { scope } : {}), note, usedPercent: clampPercent(used), ...(end ? { resetsAt: end } : {}), ...(windowMs ? { windowMs } : {}) });
	}
	return windows;
}

/** `cursor-grok-4.7-high-fast` → `xai/grok-4.7`, so cache savings can be priced from the table. */
export function cursorRateModel(model: string): string {
	const base = model.replace(/^cursor-/, '').replace(/(?:-thinking)?(?:-(?:none|minimal|low|medium|high|xhigh|max))?(?:-fast)?$/, '');
	return base.startsWith('grok-') ? `xai/${base}` : base;
}

export interface ICursorUsage {
	readonly records: IUsageRecord[];
	readonly error?: string;
}

/**
 * Account usage events from Cursor's dashboard API. They cover every Cursor surface (the
 * IDE, `cursor-agent`, Volt's Cursor runs) and carry the cost Cursor charged.
 */
export async function readCursorUsage(home: string, sinceMs: number): Promise<ICursorUsage | undefined> {
	const token = await readCursorToken(home);
	const userId = token && cursorUserId(token);
	if (!token || !userId) {
		return undefined;
	}
	const until = Date.now();
	const pageSize = 1000;
	const seen = new Set<string>();
	const records: IUsageRecord[] = [];
	try {
		for (let page = 1; page <= 200; page++) {
			const response = await fetch('https://cursor.com/api/dashboard/get-filtered-usage-events', {
				method: 'POST',
				redirect: 'error',
				headers: {
					'Content-Type': 'application/json',
					'Origin': 'https://cursor.com',
					'Cookie': `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`,
				},
				body: JSON.stringify({ page, pageSize, startDate: String(sinceMs), endDate: String(until) }),
				signal: AbortSignal.timeout(15_000),
			});
			if (response.status === 401 || response.status === 403) {
				return { records: [], error: 'Sign in to Cursor again to read its usage.' };
			}
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const body = record(await response.json());
			const events = Array.isArray(body?.usageEventsDisplay) ? body.usageEventsDisplay : [];
			for (const raw of events) {
				const event = record(raw);
				const usage = record(event?.tokenUsage);
				const timestampMs = finite(event?.timestamp);
				const model = typeof event?.model === 'string' ? event.model : '';
				if (!event || !usage || timestampMs === undefined || !model || timestampMs < sinceMs) {
					continue;
				}
				const conversation = typeof event.conversationId === 'string' ? event.conversationId : '';
				const key = JSON.stringify([timestampMs, model, conversation, usage]);
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				const cents = finite(usage.totalCents);
				records.push({
					provider: 'cursor',
					timestampMs,
					model,
					sessionId: conversation,
					uncached: Math.max(0, Math.trunc(finite(usage.inputTokens) ?? 0)),
					cached: Math.max(0, Math.trunc(finite(usage.cacheReadTokens) ?? 0)),
					cacheWrite: Math.max(0, Math.trunc(finite(usage.cacheWriteTokens) ?? 0)),
					output: Math.max(0, Math.trunc(finite(usage.outputTokens) ?? 0)),
					speed: 'standard',
					...(cents !== undefined ? { reportedCostUsd: cents / 100 } : {}),
				});
			}
			if (events.length < pageSize) {
				return { records };
			}
		}
		return { records };
	} catch {
		return { records, error: 'Cursor usage could not be read. Check your connection and refresh.' };
	}
}

//#endregion
