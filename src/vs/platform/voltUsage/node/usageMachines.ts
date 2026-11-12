/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir, hostname, platform, userInfo } from 'os';
import { dirname } from '../../../base/common/path.js';
import { IVoltPairRequest, IVoltPairResponse, IVoltRefreshResponse, VOLT_PAIR_PATH, VOLT_REFRESH_PATH } from '../../voltAgentServer/common/protocol.js';
import { PinMismatchError, pinnedRequest } from '../../voltListeners/node/listenerTls.js';
import {
	IVoltUsageActivity, IVoltUsageLimitGroup, IVoltUsageMachine, IVoltUsageMachineReport, IVoltUsageMachineStatus, IVoltUsageNote, IVoltUsageSnapshot,
	VoltResetCreditOutcome, VoltUsageProvider
} from '../common/voltUsage.js';
import { ResetCreditError } from './usageAccounts.js';

/**
 * Other machines' usage, read from their Volt agent servers. A machine is added with a pairing
 * link its server made (`http://host:port/pair#code=ABCD-EFGH`): the one-time code is traded for
 * a device key, which the other machine lists under its paired devices and can remove. Its server
 * answers `GET /api/usage` with that machine's own usage and limits, and `POST /api/usage/redeem`
 * spends a reset credit for a login only that machine holds. The key travels in the Authorization
 * header, as with `/health`.
 */

export const MACHINE_USAGE_PATH = '/api/usage';
export const MACHINE_REDEEM_PATH = '/api/usage/redeem';

/** The name other machines show for this one: the host name without `.local`. */
export function localMachineName(): string {
	return hostname().replace(/\.local$/i, '') || 'This computer';
}

/** One id per computer and user: every Volt profile there reads the same transcripts and logins. */
export function localMachineId(): string {
	return createHash('sha256').update(`${hostname()}\0${userInfo().uid}\0${homedir()}`).digest('hex').slice(0, 24);
}

export interface IStoredMachine extends IVoltUsageMachine {
	readonly token: string;
	/** When `token` stops working unless refreshed; unknown for keys from older servers. */
	readonly tokenExpiresAt?: number;
	/** The SHA-256 (base64url) of the certificate an `https://` machine must present, from its pairing link. */
	readonly pin?: string;
}

/** A key with less than this left is refreshed before it is used. */
const MACHINE_TOKEN_REFRESH_WHEN_LEFT_MS = 15 * 24 * 60 * 60 * 1000;

/**
 * A pairing link (`http://host:port/pair#code=...`, or `https://...#code=...&fp=<pin>` from a server's
 * network listener) or an address with the server's key (`#token=...`) to the server's origin and
 * the code, key and certificate pin in it.
 */
export function parsePairingUrl(text: string): { url: string; code?: string; token?: string; pin?: string } | undefined {
	let parsed: URL;
	try {
		parsed = new URL(text.trim());
	} catch {
		return undefined;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return undefined;
	}
	const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
	const fp = hash.get('fp');
	const pin = parsed.protocol === 'https:' && fp && /^[A-Za-z0-9_-]{43}$/.test(fp) ? { pin: fp } : {};
	const code = hash.get('code') ?? parsed.searchParams.get('code');
	if (code?.trim()) {
		return { url: parsed.origin, code: code.trim(), ...pin };
	}
	const token = hash.get('token') ?? parsed.searchParams.get('token');
	return token ? { url: parsed.origin, token, ...pin } : undefined;
}

interface IMachineResponse {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}

/**
 * One request to another machine's server: over a pinned TLS connection when its link carried
 * a certificate pin (the server's own self-signed certificate), else with `fetch`.
 */
async function machineFetch(target: { readonly url: string; readonly pin?: string }, path: string, init: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string; readonly timeoutMs: number }): Promise<IMachineResponse> {
	if (target.pin) {
		const response = await pinnedRequest(`${target.url}${path}`, target.pin, { method: init.method, headers: init.headers, body: init.body, timeoutMs: init.timeoutMs });
		return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => JSON.parse(response.body) };
	}
	return fetch(`${target.url}${path}`, { method: init.method, headers: init.headers, body: init.body, redirect: 'error', signal: AbortSignal.timeout(init.timeoutMs) });
}

/** Trades a one-time pairing code for a key on the machine at `url` that can only read its usage. */
export async function pairWithMachine(url: string, code: string, pin?: string): Promise<IVoltPairResponse> {
	const request: IVoltPairRequest = { code, client: { label: `Volt usage on ${localMachineName()}`, kind: 'web', os: platform() }, scope: 'usage' };
	let response: IMachineResponse;
	try {
		response = await machineFetch({ url, ...(pin ? { pin } : {}) }, VOLT_PAIR_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), timeoutMs: 15_000 });
	} catch (err) {
		if (err instanceof PinMismatchError) {
			throw err;
		}
		throw new Error(`Volt could not reach ${url}. Check the other machine is awake, on the same network, and shares Volt on it.`);
	}
	const body = await response.json().catch(() => undefined) as Partial<IVoltPairResponse> & { message?: string } | undefined;
	if (!response.ok || typeof body?.token !== 'string') {
		throw new Error(body?.message ?? `${url} did not accept the pairing code. Make a new one on that machine and try again.`);
	}
	return body as IVoltPairResponse;
}

/**
 * The machine with a fresh key when its key has less than half its life left; the same machine
 * when it needn't (or can't: an older server, or offline; the old key is tried as it is).
 */
export async function refreshMachineToken(machine: IStoredMachine, now = Date.now()): Promise<IStoredMachine> {
	if (machine.tokenExpiresAt !== undefined && machine.tokenExpiresAt - now >= MACHINE_TOKEN_REFRESH_WHEN_LEFT_MS) {
		return machine;
	}
	try {
		const response = await machineFetch(machine, VOLT_REFRESH_PATH, { method: 'POST', headers: { 'Authorization': `Bearer ${machine.token}` }, timeoutMs: 15_000 });
		if (response.status === 404) {
			// An older server: its keys don't expire. Asked again in a day.
			return { ...machine, tokenExpiresAt: now + MACHINE_TOKEN_REFRESH_WHEN_LEFT_MS + 24 * 60 * 60 * 1000 };
		}
		const body = await response.json().catch(() => undefined) as Partial<IVoltRefreshResponse> | undefined;
		if (response.ok && typeof body?.token === 'string' && typeof body.expiresAt === 'number') {
			return { ...machine, token: body.token, tokenExpiresAt: body.expiresAt };
		}
	} catch {
		// offline: tried again next time
	}
	return machine;
}

/** The machines added on this one, kept beside the usage cache. Tokens are secrets: the file is the user's only. */
export class MachineStore {

	private machines: IStoredMachine[] | undefined;

	constructor(private readonly path: string) { }

	async list(): Promise<readonly IStoredMachine[]> {
		if (!this.machines) {
			try {
				const parsed = JSON.parse(await fs.readFile(this.path, 'utf8'));
				this.machines = Array.isArray(parsed) ? parsed.filter((m): m is IStoredMachine =>
					!!m && typeof m.id === 'string' && typeof m.url === 'string' && typeof m.token === 'string' && typeof m.name === 'string') : [];
			} catch {
				this.machines = [];
			}
		}
		return this.machines;
	}

	/** Adds the machine, or updates the one already at that address. */
	async put(machine: Omit<IStoredMachine, 'id'>): Promise<IStoredMachine> {
		const machines = [...await this.list()];
		const existing = machines.findIndex(m => m.url === machine.url);
		const stored: IStoredMachine = { id: existing === -1 ? randomUUID() : machines[existing].id, ...machine };
		if (existing === -1) {
			machines.push(stored);
		} else {
			machines[existing] = stored;
		}
		await this.save(machines);
		return stored;
	}

	async remove(id: string): Promise<void> {
		await this.save((await this.list()).filter(m => m.id !== id));
	}

	private async save(machines: IStoredMachine[]): Promise<void> {
		this.machines = machines;
		await fs.mkdir(dirname(this.path), { recursive: true });
		await fs.writeFile(this.path, JSON.stringify(machines, undefined, '\t'), { mode: 0o600 });
	}
}

export interface IMachineAnswer {
	readonly status: IVoltUsageMachineStatus;
	readonly report?: IVoltUsageMachineReport;
}

function publicMachine(machine: IStoredMachine): IVoltUsageMachine {
	return { id: machine.id, name: machine.name, url: machine.url };
}

/** Asks one machine for its usage. Never throws: an unreachable machine is reported as offline. */
export async function fetchMachineReport(machine: IStoredMachine, force: boolean, timeoutMs = 20_000): Promise<IMachineAnswer> {
	try {
		const response = await machineFetch(machine, `${MACHINE_USAGE_PATH}${force ? '?force=1' : ''}`, { headers: { 'Authorization': `Bearer ${machine.token}` }, timeoutMs });
		if (response.status === 401 || response.status === 403) {
			return { status: { ...publicMachine(machine), state: 'unauthorized' } };
		}
		if (!response.ok) {
			return { status: { ...publicMachine(machine), state: 'error' } };
		}
		const report = await response.json() as IVoltUsageMachineReport;
		if (!report || !report.usage || !Array.isArray(report.usage.buckets) || !Array.isArray(report.limits)) {
			return { status: { ...publicMachine(machine), state: 'error' } };
		}
		return { status: { ...publicMachine(machine), state: 'ok', checkedAt: Date.now() }, report };
	} catch {
		return { status: { ...publicMachine(machine), state: 'offline' } };
	}
}

/** Spends a reset credit for a login only `machine` holds. */
export async function redeemOnMachine(machine: IStoredMachine, provider: VoltUsageProvider, accountId: string): Promise<VoltResetCreditOutcome> {
	let response: IMachineResponse;
	try {
		response = await machineFetch(machine, MACHINE_REDEEM_PATH, {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${machine.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider, accountId }),
			timeoutMs: 60_000,
		});
	} catch {
		throw new ResetCreditError(`${machine.name} could not be reached to redeem the reset.`, false);
	}
	const body = await response.json().catch(() => undefined) as { outcome?: VoltResetCreditOutcome; error?: string; settled?: boolean } | undefined;
	if (response.ok && body?.outcome) {
		return body.outcome;
	}
	throw new ResetCreditError(body?.error ?? `${machine.name} could not redeem the reset.`, body?.settled ?? false);
}

//#region Merging

/** `local` for this machine, else the machine's id. */
export type LimitHolder = 'local' | string;

export interface IMachineLimits {
	readonly holder: LimitHolder;
	readonly machineName: string;
	readonly groups: readonly IVoltUsageLimitGroup[];
}

export interface IMergedLimits {
	readonly groups: IVoltUsageLimitGroup[];
	/** Per `provider|accountId`: the holders that can redeem for it, this machine first. */
	readonly holders: Map<string, LimitHolder[]>;
}

export function accountKey(provider: VoltUsageProvider, accountId: string): string {
	return `${provider}|${accountId}`;
}

/**
 * One reading per account: an account signed in on several machines counts once, from the
 * freshest reading that has numbers. Readings without an account id can't be matched and stay
 * separate. `machines` lists where each account is signed in once more than one machine reports.
 */
export function mergeLimits(sources: readonly IMachineLimits[]): IMergedLimits {
	const byKey = new Map<string, { group: IVoltUsageLimitGroup; machines: string[] }>();
	const holders = new Map<string, LimitHolder[]>();
	const order: string[] = [];
	const multiple = sources.length > 1;
	sources.forEach((source, sourceIndex) => {
		source.groups.forEach((group, index) => {
			const key = group.account ? accountKey(group.provider, group.account.id) : `${group.provider}|unmatched|${sourceIndex}|${index}`;
			if (group.account) {
				const list = holders.get(key) ?? [];
				list.push(source.holder);
				holders.set(key, list);
			}
			const held = byKey.get(key);
			if (!held) {
				byKey.set(key, { group, machines: [source.machineName] });
				order.push(key);
				return;
			}
			held.machines.push(source.machineName);
			const better = (!!held.group.error && !group.error) || (!!held.group.error === !!group.error && group.checkedAt > held.group.checkedAt);
			if (better) {
				held.group = group;
			}
		});
	});
	const groups = order.map(key => {
		const { group, machines } = byKey.get(key)!;
		return multiple ? { ...group, machines: [...new Set(machines)] } : group;
	});
	return { groups, holders };
}

export interface IMachineUsage {
	readonly machineName: string;
	readonly usage: IVoltUsageSnapshot;
	readonly cursorAccount?: string;
}

/**
 * Adds other machines' history to this one's. Transcripts live on the machine that ran the agent,
 * so their rows simply add up; Cursor's rows are the account's, so each Cursor account counts once.
 * Session numbers are shifted so they stay unique across machines.
 */
export function mergeUsage(local: IMachineUsage, remotes: readonly IMachineUsage[], machines: readonly IVoltUsageMachineStatus[]): IVoltUsageSnapshot {
	if (!remotes.length) {
		return machines.length ? { ...local.usage, machines } : local.usage;
	}
	const cursorAccounts = new Set(local.cursorAccount ? [local.cursorAccount] : []);
	const buckets = [...local.usage.buckets];
	const activity: IVoltUsageActivity[] = [...local.usage.activity];
	const notes: IVoltUsageNote[] = [...local.usage.notes];
	let sessionOffset = local.usage.sessionCount;
	let sinceMs = local.usage.sinceMs;
	for (const remote of remotes) {
		const skipCursor = !!remote.cursorAccount && cursorAccounts.has(remote.cursorAccount);
		if (remote.cursorAccount) {
			cursorAccounts.add(remote.cursorAccount);
		}
		for (const bucket of remote.usage.buckets) {
			if (!(skipCursor && bucket.provider === 'cursor')) {
				buckets.push(bucket);
			}
		}
		for (const entry of remote.usage.activity) {
			if (!(skipCursor && entry.provider === 'cursor')) {
				activity.push({ ...entry, sessions: entry.sessions.map(session => session + sessionOffset) });
			}
		}
		for (const note of remote.usage.notes) {
			notes.push({ ...note, message: `${remote.machineName}: ${note.message}` });
		}
		sessionOffset += remote.usage.sessionCount;
		sinceMs = Math.min(sinceMs, remote.usage.sinceMs);
	}
	return {
		...local.usage,
		sinceMs,
		buckets: buckets.sort((a, b) => a.hour - b.hour),
		activity: activity.sort((a, b) => a.hour - b.hour),
		sessionCount: sessionOffset,
		notes,
		machines,
	};
}

//#endregion
