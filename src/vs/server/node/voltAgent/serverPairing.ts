/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes, randomInt, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import type * as http from 'http';
import { arch, hostname, networkInterfaces, platform } from 'os';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { writeFileAtomic } from '../../../platform/voltAgentServer/node/agentServerFiles.js';
import {
	AGENT_SERVER_PROTOCOL_VERSION, IVoltEnvironmentDescriptor, IVoltLocalLink, IVoltPairedDevice, IVoltPairingCode, IVoltPairRequest, IVoltPairResponse,
	IVoltPairingUrl, IVoltRefreshResponse, VOLT_ENVIRONMENT_PATH, VOLT_LOCAL_SESSION_PATH, VOLT_PAIR_PATH, VOLT_REFRESH_PATH, VoltPairingClientKind, VoltRouteKind, VoltTunnelKind
} from '../../../platform/voltAgentServer/common/protocol.js';
import { AgentServerTokenScope, IAgentServerAuth } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { bearerToken, hostAllowed, isLoopbackAddress as isLoopbackPeer, loopbackHostNames, originAllowed, requestSource, SourceRateLimiter } from '../../../platform/voltListeners/node/listenerAuth.js';

/** No 0/O, 1/I/L: a code read off a screen and typed by hand has nothing to confuse. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60_000;
/**
 * Wrong codes allowed per minute from one address before pairing refuses that address for the
 * rest of it. Per source: one device on the network can't lock everyone else out (B-24).
 */
const MAX_FAILURES_PER_SOURCE = 12;
const FAILURE_WINDOW_MS = 60_000;
/** Local sign-in nonces: single use, this long. */
export const LOCAL_NONCE_TTL_MS = 60_000;
const MAX_LOCAL_NONCES = 32;
/** A paired device's token works this long; the client refreshes it before (`/api/auth/refresh`). */
export const DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A browser on this computer signed in with a local nonce: a week, renewed while it is used. */
export const LOCAL_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** After a refresh, the previous token keeps working this long (requests already in flight). */
export const REFRESH_GRACE_MS = 60_000;
/** Browsers on this computer kept at most; the oldest is signed out first. */
const MAX_LOCAL_SESSIONS = 8;
const MAX_BODY_BYTES = 8 * 1024;
const LAST_SEEN_SAVE_MS = 60_000;

interface IStoredDevice {
	readonly id: string;
	label: string;
	readonly kind: VoltPairingClientKind;
	readonly role: 'owner' | 'device';
	readonly scopes: readonly AgentServerTokenScope[];
	/** Signed in with a local nonce (a browser on this computer), not paired with a code. */
	readonly local?: boolean;
	readonly os?: string;
	readonly model?: string;
	readonly createdAt: number;
	lastSeenAt?: number;
	/** SHA-256 of the token; the token itself is never written down. */
	tokenHash: string;
	expiresAt: number;
	/** The token before the last refresh, accepted until `previousValidUntil`. */
	previousTokenHash?: string;
	previousValidUntil?: number;
}

interface IDevicesFile {
	readonly version: 2;
	readonly environmentId: string;
	devices: IStoredDevice[];
}

export class PairingError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message);
	}
}

export interface IPairingHttpContext {
	readonly port: number;
	readonly network: boolean;
	readonly serverVersion: string;
	/** This build serves Volt's workbench to browsers. */
	readonly workbench?: boolean;
	/**
	 * The request came in on the tunnel listener (cloudflared, an SSH forward). Those arrive from
	 * loopback too, so they never get the local session: anyone with the tunnel's address would.
	 */
	readonly viaTunnel?: boolean;
	/** The request came in on the network (TLS) listener: never the local session either. */
	readonly viaNetwork?: boolean;
	/** Base URLs of the tunnels that are up, added to pairing links. */
	readonly tunnelUrls?: () => readonly { readonly via: VoltTunnelKind; readonly url: string }[];
	/** The network listener: its port and its certificate's pin, put into pairing links. */
	readonly tls?: { readonly port: number; readonly fingerprint: string; readonly fingerprintHex: string };
}

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

function newCode(): string {
	let code = '';
	for (let i = 0; i < CODE_LENGTH; i++) {
		code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
	}
	return code;
}

/** Codes are typed as `ABCD-EFGH` or `abcd efgh`: only the letters count. */
export function normalizePairingCode(code: string): string {
	return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** `Leul's MacBook Pro` from `Leuls-MacBook-Pro.local`. */
export function machineLabel(): string {
	const name = hostname().replace(/\.(local|lan|home)$/i, '');
	return name.replace(/-/g, ' ').trim() || 'Volt';
}

export function isLoopbackAddress(address: string | undefined): boolean {
	return isLoopbackPeer(address);
}

/** Tailscale hands out 100.64.0.0/10; the private ranges are the local network. */
export function classifyAddress(ip: string): VoltRouteKind {
	const parts = ip.split('.').map(Number);
	if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) {
		return 'public';
	}
	const [a, b] = parts;
	if (a === 127) {
		return 'loopback';
	}
	if (a === 100 && b >= 64 && b <= 127) {
		return 'tailnet';
	}
	if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
		return 'lan';
	}
	return 'public';
}

const ROUTE_RANK: Record<VoltRouteKind, number> = { lan: 0, tailnet: 1, public: 2, loopback: 3 };

/** The machine's IPv4 addresses a phone could use, local network first. */
export function reachableAddresses(): { readonly kind: VoltRouteKind; readonly ip: string }[] {
	const found: { kind: VoltRouteKind; ip: string }[] = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family !== 'IPv4' || entry.internal) {
				continue;
			}
			const kind = classifyAddress(entry.address);
			// Link-local addresses (169.254/16) only exist when nothing else is configured.
			if (!entry.address.startsWith('169.254.') && !found.some(f => f.ip === entry.address)) {
				found.push({ kind, ip: entry.address });
			}
		}
	}
	return found.sort((a, b) => ROUTE_RANK[a.kind] - ROUTE_RANK[b.kind]);
}

/** Scopes of a device stored before scopes existed: everything a token could do then. */
const LEGACY_SCOPES: readonly AgentServerTokenScope[] = ['agent', 'usage'];

/**
 * Phones and browsers pair with the agent server the way T3's do: the server shows a one-time code
 * (in a QR with its address), the client trades it for its own token, and the server keeps a list
 * of paired devices that can be revoked one by one. The server's own token stays on this machine.
 *
 * Device tokens are scoped and expire ({@link DEVICE_TOKEN_TTL_MS}); a client refreshes its token
 * before then and the old one stops working a minute later. A revoked device's token stops at
 * once, and its sockets are closed within 5 s (INV-08). The browser on this computer signs in only
 * with a single-use nonce the desktop app puts in the URL it opens (B-01).
 */
export class ServerPairing extends Disposable {

	private readonly codes = new Map<string, number>();
	private readonly byHash = new Map<string, IStoredDevice>();
	/** Local sign-in nonces by their hash, with their expiry. */
	private readonly localNonces = new Map<string, number>();
	private readonly pairFailures: SourceRateLimiter;
	private readonly localFailures: SourceRateLimiter;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;

	private constructor(
		private readonly file: string,
		private readonly state: IDevicesFile,
		private readonly logService: ILogService,
		private readonly now: () => number,
	) {
		super();
		this.pairFailures = new SourceRateLimiter({ limit: MAX_FAILURES_PER_SOURCE, windowMs: FAILURE_WINDOW_MS, now });
		this.localFailures = new SourceRateLimiter({ limit: MAX_FAILURES_PER_SOURCE, windowMs: FAILURE_WINDOW_MS, now });
		this.reindex();
		this._register(toDisposable(() => {
			if (this.saveTimer) {
				clearTimeout(this.saveTimer);
				void this.save();
			}
		}));
	}

	static async load(dir: string, logService: ILogService, now: () => number = Date.now): Promise<ServerPairing> {
		const file = join(dir, 'devices.json');
		let state: IDevicesFile | undefined;
		let migrated = false;
		try {
			const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { version?: number; environmentId?: unknown; devices?: unknown };
			if ((parsed.version === 1 || parsed.version === 2) && typeof parsed.environmentId === 'string' && Array.isArray(parsed.devices)) {
				const devices: IStoredDevice[] = [];
				for (const raw of parsed.devices as Partial<IStoredDevice>[]) {
					if (!raw || typeof raw.tokenHash !== 'string' || typeof raw.id !== 'string') {
						continue;
					}
					const role = raw.role === 'owner' ? 'owner' : 'device';
					// Tokens from before expiry existed get a full term from now: their clients keep
					// working and refresh (or pair again) before it ends, nobody is signed out at once.
					const expiresAt = typeof raw.expiresAt === 'number' ? raw.expiresAt : now() + (role === 'owner' ? LOCAL_SESSION_TTL_MS : DEVICE_TOKEN_TTL_MS);
					migrated ||= typeof raw.expiresAt !== 'number' || !Array.isArray(raw.scopes);
					devices.push({
						...raw,
						id: raw.id,
						label: String(raw.label ?? 'Device'),
						kind: raw.kind === 'web' || raw.kind === 'tablet' ? raw.kind : 'mobile',
						role,
						scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((scope): scope is AgentServerTokenScope => scope === 'agent' || scope === 'usage') : LEGACY_SCOPES,
						createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now(),
						tokenHash: raw.tokenHash,
						expiresAt,
					});
				}
				state = { version: 2, environmentId: parsed.environmentId, devices };
			}
		} catch {
			// first start
		}
		const pairing = new ServerPairing(file, state ?? { version: 2, environmentId: `env-${randomBytes(9).toString('base64url')}`, devices: [] }, logService, now);
		if (!state || migrated) {
			await pairing.save();
		}
		return pairing;
	}

	get environmentId(): string {
		return this.state.environmentId;
	}

	descriptor(ctx: IPairingHttpContext): IVoltEnvironmentDescriptor {
		return {
			environmentId: this.state.environmentId,
			label: machineLabel(),
			platform: { os: platform(), arch: arch() },
			serverVersion: ctx.serverVersion,
			protocol: AGENT_SERVER_PROTOCOL_VERSION,
			network: ctx.network,
			capabilities: { pairing: true, workbench: !!ctx.workbench },
		};
	}

	/**
	 * Who a device token belongs to; undefined for anything not issued here, revoked, expired, or
	 * (with `scope`) not allowed to do that.
	 */
	authorize(token: string, scope?: AgentServerTokenScope): IAgentServerAuth | undefined {
		if (!token || token.length > 256) {
			return undefined;
		}
		const hash = hashToken(token);
		const now = this.now();
		let device = this.byHash.get(hash);
		if (device && device.tokenHash !== hash && (device.previousTokenHash !== hash || (device.previousValidUntil ?? 0) <= now)) {
			device = undefined;
		}
		if (!device || device.expiresAt <= now || (scope && !device.scopes.includes(scope))) {
			return undefined;
		}
		return { role: device.role, deviceId: device.id, scopes: device.scopes, expiresAt: device.expiresAt };
	}

	/** Whether a device is still paired and its token unexpired (connections of others are closed). */
	isActive(deviceId: string): boolean {
		const device = this.state.devices.find(d => d.id === deviceId);
		return !!device && device.expiresAt > this.now();
	}

	/** A device connected: remembered as "last seen" (written at most once a minute). */
	touch(deviceId: string): void {
		const device = this.state.devices.find(d => d.id === deviceId);
		if (!device) {
			return;
		}
		device.lastSeenAt = this.now();
		this.scheduleSave();
	}

	createCode(ctx: IPairingHttpContext): IVoltPairingCode {
		this.pruneCodes();
		const code = newCode();
		const expiresAt = this.now() + CODE_TTL_MS;
		this.codes.set(code, expiresAt);
		const pairPath = `/pair#code=${code}`;
		// The network listener speaks TLS with this server's own certificate: its links carry the pin.
		const urls: IVoltPairingUrl[] = ctx.network && ctx.tls
			? reachableAddresses().filter(a => a.kind !== 'loopback').map(a => ({ kind: a.kind, url: `https://${a.ip}:${ctx.tls!.port}${pairPath}&fp=${ctx.tls!.fingerprint}` }))
			: [];
		for (const tunnel of ctx.tunnelUrls?.() ?? []) {
			urls.push({ kind: 'public', url: `${tunnel.url}${pairPath}`, via: tunnel.via });
		}
		return {
			code,
			expiresAt,
			urls: [...urls, { kind: 'loopback' as const, url: `http://127.0.0.1:${ctx.port}${pairPath}` }],
			network: ctx.network,
			...(ctx.network && ctx.tls ? { fingerprint: ctx.tls.fingerprintHex, pin: ctx.tls.fingerprint } : {}),
		};
	}

	/** Trades a one-time code for a device token. `source` is the caller's address, for its failure limit. */
	async pair(request: IVoltPairRequest, source = 'unknown'): Promise<IVoltPairResponse> {
		if (this.pairFailures.blocked(source)) {
			throw new PairingError(429, 'rate_limited', 'Too many wrong codes. Wait a minute, then try again.');
		}
		this.pruneCodes();
		const code = normalizePairingCode(typeof request.code === 'string' ? request.code : '');
		if (!this.codes.has(code)) {
			this.pairFailures.fail(source);
			throw new PairingError(401, 'invalid_code', 'That pairing code is wrong or has expired. Make a new one on your computer.');
		}
		this.codes.delete(code);
		const client = request.client ?? { label: 'Device', kind: 'mobile' };
		const kind: VoltPairingClientKind = client.kind === 'web' || client.kind === 'tablet' ? client.kind : 'mobile';
		return this.issue({
			label: String(client.label || (kind === 'web' ? 'Browser' : 'Phone')).slice(0, 80),
			kind,
			role: 'device',
			scopes: request.scope === 'usage' ? ['usage'] : ['agent', 'usage'],
			...(client.os ? { os: String(client.os).slice(0, 40) } : {}),
			...(client.model ? { model: String(client.model).slice(0, 80) } : {}),
		}, DEVICE_TOKEN_TTL_MS);
	}

	/**
	 * A one-time nonce the desktop app (or another holder of the server's own token) puts in the
	 * fragment of the local web page it opens: `POST /api/auth/local` spends it for a session.
	 */
	createLocalNonce(): IVoltLocalLink {
		const now = this.now();
		for (const [hash, expiresAt] of this.localNonces) {
			if (expiresAt <= now) {
				this.localNonces.delete(hash);
			}
		}
		while (this.localNonces.size >= MAX_LOCAL_NONCES) {
			this.localNonces.delete(this.localNonces.keys().next().value!);
		}
		const nonce = randomBytes(32).toString('base64url');
		const expiresAt = now + LOCAL_NONCE_TTL_MS;
		this.localNonces.set(hashToken(nonce), expiresAt);
		return { nonce, expiresAt };
	}

	/** Spends a local nonce: true once, within its minute; false for anything else. */
	consumeLocalNonce(nonce: unknown): boolean {
		if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
			return false;
		}
		const hash = hashToken(nonce);
		const expiresAt = this.localNonces.get(hash);
		this.localNonces.delete(hash);
		return expiresAt !== undefined && expiresAt > this.now();
	}

	/** The browser on this machine, signed in with a local nonce: trusted like a Volt window. */
	async issueLocal(userAgent: string | undefined): Promise<IVoltPairResponse> {
		// Each sign-in adds an entry: keep only the most recent few.
		const locals = this.state.devices.filter(d => d.local).sort((a, b) => (a.lastSeenAt ?? a.createdAt) - (b.lastSeenAt ?? b.createdAt));
		for (const stale of locals.slice(0, Math.max(0, locals.length - MAX_LOCAL_SESSIONS + 1))) {
			this.remove(stale);
		}
		return this.issue({ label: `Browser on ${machineLabel()}`, kind: 'web', role: 'owner', scopes: ['agent', 'usage'], local: true, ...(userAgent ? { model: browserName(userAgent) } : {}) }, LOCAL_SESSION_TTL_MS);
	}

	/**
	 * The same device's next token for a valid one: the old token keeps working for
	 * {@link REFRESH_GRACE_MS}, then stops. Undefined when the token isn't valid now.
	 */
	async refresh(token: string): Promise<IVoltRefreshResponse | undefined> {
		const auth = this.authorize(token);
		const device = auth?.deviceId ? this.state.devices.find(d => d.id === auth.deviceId) : undefined;
		// Only the current token refreshes: a superseded one in its grace minute can't fork a second line of tokens.
		if (!device || device.tokenHash !== hashToken(token)) {
			return undefined;
		}
		const next = randomBytes(32).toString('base64url');
		const now = this.now();
		if (device.previousTokenHash) {
			this.byHash.delete(device.previousTokenHash);
		}
		device.previousTokenHash = device.tokenHash;
		device.previousValidUntil = now + REFRESH_GRACE_MS;
		device.tokenHash = hashToken(next);
		device.expiresAt = now + (device.local ? LOCAL_SESSION_TTL_MS : DEVICE_TOKEN_TTL_MS);
		device.lastSeenAt = now;
		this.byHash.set(device.tokenHash, device);
		await this.save();
		return { token: next, expiresAt: device.expiresAt };
	}

	private async issue(device: Pick<IStoredDevice, 'label' | 'kind' | 'role' | 'scopes' | 'local' | 'os' | 'model'>, ttl: number): Promise<IVoltPairResponse> {
		const token = randomBytes(32).toString('base64url');
		const now = this.now();
		const stored: IStoredDevice = { ...device, id: randomUUID(), createdAt: now, lastSeenAt: now, tokenHash: hashToken(token), expiresAt: now + ttl };
		this.state.devices.push(stored);
		this.byHash.set(stored.tokenHash, stored);
		await this.save();
		this.logService.info(`[volt agent server] paired ${stored.kind} "${stored.label}" (${stored.id})`);
		return { token, deviceId: stored.id, environmentId: this.state.environmentId, label: machineLabel(), role: stored.role, expiresAt: stored.expiresAt };
	}

	list(connected: ReadonlySet<string>, current: string | undefined): IVoltPairedDevice[] {
		return this.state.devices
			.map(device => ({
				id: device.id,
				label: device.label,
				kind: device.kind,
				role: device.role,
				...(device.os ? { os: device.os } : {}),
				...(device.model ? { model: device.model } : {}),
				createdAt: device.createdAt,
				...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
				connected: connected.has(device.id),
				...(device.id === current ? { current: true } : {}),
			}))
			.sort((a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt));
	}

	async rename(id: string, label: string): Promise<boolean> {
		const device = this.state.devices.find(d => d.id === id);
		const next = label.trim().slice(0, 80);
		if (!device || !next) {
			return false;
		}
		device.label = next;
		await this.save();
		return true;
	}

	async revoke(id: string): Promise<boolean> {
		const device = this.state.devices.find(d => d.id === id);
		if (!device) {
			return false;
		}
		this.remove(device);
		await this.save();
		this.logService.info(`[volt agent server] revoked ${device.kind} "${device.label}" (${device.id})`);
		return true;
	}

	private remove(device: IStoredDevice): void {
		this.state.devices = this.state.devices.filter(d => d !== device);
		this.byHash.delete(device.tokenHash);
		if (device.previousTokenHash) {
			this.byHash.delete(device.previousTokenHash);
		}
	}

	private reindex(): void {
		this.byHash.clear();
		for (const device of this.state.devices) {
			this.byHash.set(device.tokenHash, device);
			if (device.previousTokenHash) {
				this.byHash.set(device.previousTokenHash, device);
			}
		}
	}

	/**
	 * Answers the pairing routes. Resolves false for any other path. The descriptor is public;
	 * pairing spends a one-time code (failures limited per source); a refresh needs a valid token;
	 * the local session needs a single-use nonce, on loopback, from this server's own page.
	 */
	async handleHttp(req: http.IncomingMessage, res: http.ServerResponse, ctx: IPairingHttpContext): Promise<boolean> {
		const path = new URL(req.url ?? '/', 'http://localhost').pathname;
		if (path === VOLT_ENVIRONMENT_PATH) {
			if (req.method === 'OPTIONS') {
				res.writeHead(204, corsHeaders()).end();
				return true;
			}
			sendJson(res, 200, this.descriptor(ctx), corsHeaders());
			return true;
		}
		if (path === VOLT_PAIR_PATH) {
			if (req.method !== 'POST') {
				sendJson(res, 405, { error: 'method_not_allowed' });
				return true;
			}
			try {
				const body = await readJson(req) as IVoltPairRequest;
				sendJson(res, 200, await this.pair(body, pairingSource(req, ctx)));
			} catch (err) {
				sendError(res, err);
			}
			return true;
		}
		if (path === VOLT_REFRESH_PATH) {
			if (req.method !== 'POST') {
				sendJson(res, 405, { error: 'method_not_allowed' });
				return true;
			}
			const source = pairingSource(req, ctx);
			if (this.pairFailures.blocked(source)) {
				sendJson(res, 429, { error: 'rate_limited', message: 'Too many failed attempts. Wait a minute, then try again.' });
				return true;
			}
			try {
				const refreshed = await this.refresh(bearerToken(req) ?? '');
				if (!refreshed) {
					this.pairFailures.fail(source);
					sendJson(res, 401, { error: 'unauthorized', message: 'This device is not paired with Volt any more. Pair it again.' });
					return true;
				}
				sendJson(res, 200, refreshed);
			} catch (err) {
				sendError(res, err);
			}
			return true;
		}
		if (path === VOLT_LOCAL_SESSION_PATH) {
			// Same machine, addressed as loopback (not a rebound DNS name), from this server's own
			// page (an Origin is required: curl and other processes send none), with a nonce only
			// the desktop app could have put in the page's URL.
			const source = requestSource(req);
			const local = req.method === 'POST' && !ctx.viaTunnel && !ctx.viaNetwork && isLoopbackPeer(req.socket.remoteAddress)
				&& hostAllowed(req.headers.host, { names: loopbackHostNames(ctx.port) }) && originAllowed(req, ['self']);
			if (!local || this.localFailures.blocked(source)) {
				sendJson(res, 403, { error: 'forbidden', message: 'Open Volt in the browser from Volt on this computer, or pair with a code.' });
				return true;
			}
			try {
				const body = await readJson(req) as { nonce?: unknown };
				if (!this.consumeLocalNonce(body?.nonce)) {
					this.localFailures.fail(source);
					sendJson(res, 403, { error: 'forbidden', message: 'This sign-in link has expired or was already used. Open Volt in the browser again from Volt, or pair with a code.' });
					return true;
				}
				sendJson(res, 200, await this.issueLocal(req.headers['user-agent']));
			} catch (err) {
				sendError(res, err);
			}
			return true;
		}
		return false;
	}

	private pruneCodes(): void {
		const now = this.now();
		for (const [code, expiresAt] of this.codes) {
			if (expiresAt <= now) {
				this.codes.delete(code);
			}
		}
	}

	private scheduleSave(): void {
		this.saveTimer ??= setTimeout(() => {
			this.saveTimer = undefined;
			void this.save();
		}, LAST_SEEN_SAVE_MS);
	}

	private async save(): Promise<void> {
		try {
			await fs.mkdir(join(this.file, '..'), { recursive: true, mode: 0o700 });
			await writeFileAtomic(this.file, JSON.stringify(this.state, undefined, '\t'), 0o600);
		} catch (err) {
			this.logService.error('[volt agent server] could not save the paired devices', err);
		}
	}
}

/**
 * Whose failures a pairing attempt counts against. Through cloudflared every request comes from
 * loopback, so there the client's address Cloudflare reports is used.
 */
function pairingSource(req: http.IncomingMessage, ctx: IPairingHttpContext): string {
	if (ctx.viaTunnel) {
		const forwarded = req.headers['cf-connecting-ip'];
		return `tunnel:${typeof forwarded === 'string' && forwarded.length < 64 ? forwarded : 'unknown'}`;
	}
	return requestSource(req);
}

function browserName(userAgent: string): string {
	if (/Edg\//.test(userAgent)) {
		return 'Edge';
	}
	if (/Chrome\//.test(userAgent)) {
		return 'Chrome';
	}
	if (/Firefox\//.test(userAgent)) {
		return 'Firefox';
	}
	if (/Safari\//.test(userAgent)) {
		return 'Safari';
	}
	return 'Browser';
}

function corsHeaders(): Record<string, string> {
	return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
	res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, err: unknown): void {
	if (err instanceof PairingError) {
		sendJson(res, err.status, { error: err.code, message: err.message });
	} else {
		sendJson(res, 500, { error: 'internal', message: err instanceof Error ? err.message : String(err) });
	}
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new PairingError(413, 'too_large', 'The request is too large.'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
			} catch {
				reject(new PairingError(400, 'bad_json', 'The request is not JSON.'));
			}
		});
		req.on('error', reject);
	});
}
