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
	AGENT_SERVER_PROTOCOL_VERSION, IVoltEnvironmentDescriptor, IVoltPairedDevice, IVoltPairingCode, IVoltPairRequest, IVoltPairResponse,
	VOLT_ENVIRONMENT_PATH, VOLT_LOCAL_SESSION_PATH, VOLT_PAIR_PATH, VoltPairingClientKind, VoltRouteKind
} from '../../../platform/voltAgentServer/common/protocol.js';
import { IAgentServerAuth } from '../../../platform/voltAgentServer/common/protocolServer.js';

/** No 0/O, 1/I/L: a code read off a screen and typed by hand has nothing to confuse. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60_000;
/** Wrong codes allowed per minute across all callers before pairing refuses for the rest of it. */
const MAX_FAILURES_PER_MINUTE = 12;
const MAX_BODY_BYTES = 8 * 1024;
const LAST_SEEN_SAVE_MS = 60_000;

interface IStoredDevice {
	readonly id: string;
	label: string;
	readonly kind: VoltPairingClientKind;
	readonly role: 'owner' | 'device';
	readonly os?: string;
	readonly model?: string;
	readonly createdAt: number;
	lastSeenAt?: number;
	/** SHA-256 of the token; the token itself is never written down. */
	readonly tokenHash: string;
}

interface IDevicesFile {
	readonly version: 1;
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

function isLoopbackAddress(address: string | undefined): boolean {
	return !!address && (address === '::1' || address.startsWith('127.') || address === '::ffff:127.0.0.1');
}

function isLoopbackHost(host: string | undefined, port: number): boolean {
	return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
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

/**
 * Phones and browsers pair with the agent server the way T3's do: the server shows a one-time code
 * (in a QR with its address), the client trades it for its own token, and the server keeps a list
 * of paired devices that can be revoked one by one. The server's own token stays on this machine.
 */
export class ServerPairing extends Disposable {

	private readonly codes = new Map<string, number>();
	private readonly byHash = new Map<string, IStoredDevice>();
	private failures: number[] = [];
	private saveTimer: ReturnType<typeof setTimeout> | undefined;

	private constructor(
		private readonly file: string,
		private readonly state: IDevicesFile,
		private readonly logService: ILogService,
	) {
		super();
		for (const device of state.devices) {
			this.byHash.set(device.tokenHash, device);
		}
		this._register(toDisposable(() => {
			if (this.saveTimer) {
				clearTimeout(this.saveTimer);
				void this.save();
			}
		}));
	}

	static async load(dir: string, logService: ILogService): Promise<ServerPairing> {
		const file = join(dir, 'devices.json');
		let state: IDevicesFile | undefined;
		try {
			const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<IDevicesFile>;
			if (parsed.version === 1 && typeof parsed.environmentId === 'string' && Array.isArray(parsed.devices)) {
				state = { version: 1, environmentId: parsed.environmentId, devices: parsed.devices.filter(d => d && typeof d.tokenHash === 'string' && typeof d.id === 'string') };
			}
		} catch {
			// first start
		}
		const pairing = new ServerPairing(file, state ?? { version: 1, environmentId: `env-${randomBytes(9).toString('base64url')}`, devices: [] }, logService);
		if (!state) {
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

	/** Who a device token belongs to; undefined for anything not issued here (or revoked). */
	authorize(token: string): IAgentServerAuth | undefined {
		if (!token || token.length > 256) {
			return undefined;
		}
		const device = this.byHash.get(hashToken(token));
		return device ? { role: device.role, deviceId: device.id } : undefined;
	}

	/** A device connected: remembered as "last seen" (written at most once a minute). */
	touch(deviceId: string): void {
		const device = this.state.devices.find(d => d.id === deviceId);
		if (!device) {
			return;
		}
		device.lastSeenAt = Date.now();
		this.scheduleSave();
	}

	createCode(ctx: IPairingHttpContext): IVoltPairingCode {
		this.pruneCodes();
		const code = newCode();
		const expiresAt = Date.now() + CODE_TTL_MS;
		this.codes.set(code, expiresAt);
		const pairPath = `/pair#code=${code}`;
		const urls = ctx.network
			? reachableAddresses().filter(a => a.kind !== 'loopback').map(a => ({ kind: a.kind, url: `http://${a.ip}:${ctx.port}${pairPath}` }))
			: [];
		return { code, expiresAt, urls: [...urls, { kind: 'loopback' as const, url: `http://127.0.0.1:${ctx.port}${pairPath}` }], network: ctx.network };
	}

	async pair(request: IVoltPairRequest): Promise<IVoltPairResponse> {
		const now = Date.now();
		this.failures = this.failures.filter(at => now - at < 60_000);
		if (this.failures.length >= MAX_FAILURES_PER_MINUTE) {
			throw new PairingError(429, 'rate_limited', 'Too many wrong codes. Wait a minute, then try again.');
		}
		this.pruneCodes();
		const code = normalizePairingCode(typeof request.code === 'string' ? request.code : '');
		if (!this.codes.has(code)) {
			this.failures.push(now);
			throw new PairingError(401, 'invalid_code', 'That pairing code is wrong or has expired. Make a new one on your computer.');
		}
		this.codes.delete(code);
		const client = request.client ?? { label: 'Device', kind: 'mobile' };
		const kind: VoltPairingClientKind = client.kind === 'web' || client.kind === 'tablet' ? client.kind : 'mobile';
		return this.issue({
			label: String(client.label || (kind === 'web' ? 'Browser' : 'Phone')).slice(0, 80),
			kind,
			role: 'device',
			...(client.os ? { os: String(client.os).slice(0, 40) } : {}),
			...(client.model ? { model: String(client.model).slice(0, 80) } : {}),
		});
	}

	/** The browser on this machine: trusted like a Volt window. */
	issueLocal(userAgent: string | undefined): Promise<IVoltPairResponse> {
		return this.issue({ label: `Browser on ${machineLabel()}`, kind: 'web', role: 'owner', ...(userAgent ? { model: browserName(userAgent) } : {}) });
	}

	private async issue(device: Pick<IStoredDevice, 'label' | 'kind' | 'role' | 'os' | 'model'>): Promise<IVoltPairResponse> {
		const token = randomBytes(32).toString('base64url');
		const stored: IStoredDevice = { ...device, id: randomUUID(), createdAt: Date.now(), lastSeenAt: Date.now(), tokenHash: hashToken(token) };
		this.state.devices.push(stored);
		this.byHash.set(stored.tokenHash, stored);
		await this.save();
		this.logService.info(`[volt agent server] paired ${stored.kind} "${stored.label}" (${stored.id})`);
		return { token, deviceId: stored.id, environmentId: this.state.environmentId, label: machineLabel(), role: stored.role };
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
		const index = this.state.devices.findIndex(d => d.id === id);
		if (index < 0) {
			return false;
		}
		const [device] = this.state.devices.splice(index, 1);
		this.byHash.delete(device.tokenHash);
		await this.save();
		this.logService.info(`[volt agent server] revoked ${device.kind} "${device.label}" (${device.id})`);
		return true;
	}

	/**
	 * Answers the pairing routes. Resolves false for any other path. Nothing here needs a token:
	 * the descriptor is public, pairing spends a one-time code, and the local session is only
	 * handed to a page this server served on loopback.
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
				sendJson(res, 200, await this.pair(body));
			} catch (err) {
				sendError(res, err);
			}
			return true;
		}
		if (path === VOLT_LOCAL_SESSION_PATH) {
			// Same machine, addressed as loopback (not a rebound DNS name), from this server's own page.
			const origin = req.headers.origin;
			const sameOrigin = !origin || origin === `http://${req.headers.host}`;
			if (req.method !== 'POST' || !isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host, ctx.port) || !sameOrigin) {
				sendJson(res, 403, { error: 'forbidden', message: 'Open this page from the computer Volt runs on, or pair with a code.' });
				return true;
			}
			try {
				sendJson(res, 200, await this.issueLocal(req.headers['user-agent']));
			} catch (err) {
				sendError(res, err);
			}
			return true;
		}
		return false;
	}

	private pruneCodes(): void {
		const now = Date.now();
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
