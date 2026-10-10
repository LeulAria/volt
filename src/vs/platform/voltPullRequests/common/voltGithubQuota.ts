/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GitHub's rate limits as GitHub itself reports them, per account and quota (REST `core`,
 * `graphql`, `search`, ...). Every answer carries `x-ratelimit-limit/remaining/reset/resource`, and
 * that count already includes everything else spending the same token (the user's own `gh`, an
 * agent's commands in a terminal). Nothing is debited here: a 304 or a request that never reached
 * GitHub spends nothing.
 *
 * The last tenth of each quota is kept for what the user asks for: background reads are refused
 * once a quota is down to it, and everything is refused once GitHub says a quota is empty or told
 * us to back off (a secondary limit). A refusal sends no request, so waiting out a limit is free.
 *
 * Modeled on T3 Code's githubQuota.ts (pingdotgg/t3code#16986, #16203).
 */

/** `x-ratelimit-resource`: `core` (REST), `graphql`, `search`, ... */
export type VoltGithubQuotaResource = 'core' | 'graphql' | 'search' | (string & {});

/** Background reads (sync, watch and discovery passes) leave the reserve alone; the user's requests may spend it. */
export type VoltGithubPriority = 'background' | 'interactive';

/** Share of each quota kept for interactive requests. */
export const GITHUB_QUOTA_RESERVE = 0.1;
/** GitHub asks for at least a minute after a secondary limit that does not say how long. */
const SECONDARY_PAUSE_MS = 60_000;
/** Answers of one window name the same reset; clocks and rounding move it by a second at most. */
const SAME_WINDOW_MS = 1_000;

export interface IVoltGithubQuotaReading {
	readonly resource: VoltGithubQuotaResource;
	readonly limit: number;
	readonly remaining: number;
	/** When the window ends (epoch ms). */
	readonly resetAt: number;
}

export interface IVoltGithubRefusal {
	readonly resource: VoltGithubQuotaResource;
	/** When asking again can work (epoch ms). */
	readonly retryAt: number;
	/** `reserve`: only background requests wait; `exhausted`: the quota is empty; `paused`: GitHub said to back off. */
	readonly reason: 'reserve' | 'exhausted' | 'paused';
}

/** Response headers with lowercase names. */
export type VoltGithubHeaders = ReadonlyMap<string, string>;

/** Lowercases header names and joins repeated values (Node's `IncomingHttpHeaders`, a plain record). */
export function githubHeaders(raw: Readonly<Record<string, string | readonly string[] | undefined>> | undefined): Map<string, string> {
	const headers = new Map<string, string>();
	for (const [name, value] of Object.entries(raw ?? {})) {
		if (value !== undefined) {
			headers.set(name.toLowerCase(), typeof value === 'string' ? value : value.join(', '));
		}
	}
	return headers;
}

/** The quota an answer reports; undefined when the host sends none (GitHub Enterprise with rate limiting off). */
export function readGithubRateLimit(headers: VoltGithubHeaders): IVoltGithubQuotaReading | undefined {
	if (!headers.has('x-ratelimit-remaining') || !headers.has('x-ratelimit-reset')) {
		return undefined;
	}
	const limit = Number(headers.get('x-ratelimit-limit'));
	const remaining = Number(headers.get('x-ratelimit-remaining'));
	const reset = Number(headers.get('x-ratelimit-reset'));
	if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining) || !Number.isFinite(reset)) {
		return undefined;
	}
	return { resource: headers.get('x-ratelimit-resource') || 'core', limit, remaining: Math.max(0, remaining), resetAt: reset * 1000 };
}

/**
 * Whether an answer is GitHub refusing for a rate limit: a 429, or a 403 that has nothing left, a
 * `retry-after`, or says so in its message. (GraphQL answers 200 with a `RATE_LIMITED` error; the
 * caller checks that.)
 */
export function isGithubRateLimitAnswer(status: number, headers: VoltGithubHeaders, message: string): boolean {
	if (status === 429) {
		return true;
	}
	return status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after') || /rate limit|abuse detection/i.test(message));
}

export class VoltGithubQuota {

	private readonly readings = new Map<string, IVoltGithubQuotaReading>();
	/** Account-wide (secondary limits) under the account's key; one quota's under `account\0resource`. */
	private readonly pauses = new Map<string, number>();

	constructor(private readonly reserve = GITHUB_QUOTA_RESERVE) { }

	/**
	 * Keeps GitHub's latest count. Answers can arrive out of order: within one window the lowest
	 * count wins, and an answer from a window that already ended is ignored.
	 */
	observe(account: string, reading: IVoltGithubQuotaReading | undefined, now = Date.now()): void {
		if (!reading) {
			return;
		}
		const key = quotaKey(account, reading.resource);
		const known = this.readings.get(key);
		if (known && known.resetAt > now) {
			if (reading.resetAt < known.resetAt - SAME_WINDOW_MS) {
				return;
			}
			if (Math.abs(reading.resetAt - known.resetAt) <= SAME_WINDOW_MS && reading.limit === known.limit && reading.remaining >= known.remaining) {
				return;
			}
		}
		this.readings.set(key, reading);
	}

	/**
	 * GitHub refused a request for a rate limit. Without a `resource` it is a secondary limit and
	 * holds every quota of the account.
	 */
	pause(account: string, until: number, resource?: VoltGithubQuotaResource): void {
		const key = resource ? quotaKey(account, resource) : account;
		this.pauses.set(key, Math.max(this.pauses.get(key) ?? 0, until));
	}

	/** Until when to wait after a refusal: `retry-after`, else the quota's reset, else a minute. */
	pauseEnd(headers: VoltGithubHeaders | undefined, now = Date.now()): number {
		const retryAfter = Number(headers?.get('retry-after'));
		if (headers?.has('retry-after') && Number.isFinite(retryAfter) && retryAfter >= 0) {
			return now + retryAfter * 1000;
		}
		const reading = headers ? readGithubRateLimit(headers) : undefined;
		if (reading && reading.remaining <= 0 && reading.resetAt > now) {
			return reading.resetAt;
		}
		return now + SECONDARY_PAUSE_MS;
	}

	/** Why a request may not go out now; undefined when it may. */
	admit(account: string, resource: VoltGithubQuotaResource, priority: VoltGithubPriority, now = Date.now()): IVoltGithubRefusal | undefined {
		const paused = Math.max(this.pauses.get(account) ?? 0, this.pauses.get(quotaKey(account, resource)) ?? 0);
		if (paused > now) {
			return { resource, retryAt: paused, reason: 'paused' };
		}
		const reading = this.readings.get(quotaKey(account, resource));
		if (!reading || reading.resetAt <= now) {
			return undefined;
		}
		if (reading.remaining <= 0) {
			return { resource, retryAt: reading.resetAt, reason: 'exhausted' };
		}
		if (priority === 'background' && reading.remaining <= Math.ceil(reading.limit * this.reserve)) {
			return { resource, retryAt: reading.resetAt, reason: 'reserve' };
		}
		return undefined;
	}

	/** What is left of a quota, 0 to 1: 1 when nothing is known or its window has ended. */
	headroom(account: string, resource: VoltGithubQuotaResource, now = Date.now()): number {
		if (this.admit(account, resource, 'interactive', now)) {
			return 0;
		}
		const reading = this.readings.get(quotaKey(account, resource));
		return reading && reading.resetAt > now ? reading.remaining / reading.limit : 1;
	}

	reading(account: string, resource: VoltGithubQuotaResource, now = Date.now()): IVoltGithubQuotaReading | undefined {
		const reading = this.readings.get(quotaKey(account, resource));
		return reading && reading.resetAt > now ? reading : undefined;
	}
}

function quotaKey(account: string, resource: VoltGithubQuotaResource): string {
	return `${account}\u0000${resource}`;
}

/** "GraphQL", "REST", "search": the quota's name for people. */
export function githubQuotaLabel(resource: VoltGithubQuotaResource): string {
	switch (resource) {
		case 'graphql': return 'GraphQL';
		case 'core': return 'REST';
		default: return resource;
	}
}

/** What to tell the user about a refusal: which quota, and when it frees up. */
export function describeGithubRefusal(refusal: IVoltGithubRefusal, host: string, now = Date.now()): string {
	const minutes = Math.max(1, Math.ceil((refusal.retryAt - now) / 60_000));
	const when = minutes === 1 ? 'in about a minute' : `in about ${minutes} minutes`;
	const quota = `GitHub's ${githubQuotaLabel(refusal.resource)} rate limit on ${host}`;
	switch (refusal.reason) {
		case 'reserve':
			return `${quota} is nearly used up; background reads wait until it resets ${when}, keeping the rest for what you ask for.`;
		case 'exhausted':
			return `${quota} is used up. It resets ${when}.`;
		default:
			return `GitHub asked Volt to slow down on ${host}. Trying again ${when}.`;
	}
}
