/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { lookup as dnsLookup } from 'dns';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as net from 'net';
import { homedir, networkInterfaces } from 'os';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { dirname, join } from '../../../base/common/path.js';
import { evaluate, IAccessRequest, IAdminPolicy, IChatView, IDecision, IManifestView, PolicySnapshot } from '../common/authority.js';
import { grantValid, IGrant } from '../common/grants.js';
import { classifyAddress } from '../common/networkAddress.js';
import { INormalizedHost, normalizeNetworkHost, parseNetworkRule, splitAuthority } from '../common/networkRules.js';
import { chatSubject, ICallContext, IPrincipal, isChatSubject, PrincipalKind, SubjectKey, subjectChatId } from '../common/principals.js';
import { GrantCommitResult, IGrantStoreChange, IGrantStoreChangeEvent } from './grantStore.js';

/**
 * The network broker (spec I.4, B-31, INV-19): the only way a sandboxed principal reaches the
 * network when its policy says `proxy`. It replaces `sandboxProxy.ts` (kept behind
 * `volt.sandbox.networkBroker: legacy` for one release).
 *
 * - **Routes.** One per principal: its own loopback listener and its own `Proxy-Authorization`
 *   token. The OS sandbox lets the principal reach its route's port and nothing else (Seatbelt
 *   `remote ip "localhost:<port>"`, the bubblewrap holder's bridge, MXC proxy-only egress). A token
 *   is valid only on its route: another route's token gets 407 and an audit event (B-31).
 * - **Decisions** come from the Policy Authority (`evaluate`, C2) over a snapshot of the route's
 *   chat view and the subject's grants: `net.connect` for names and public addresses,
 *   `net.local.connect` for LAN addresses, `net.loopback.connect:<port>` for loopback. Volt's own
 *   listener ports are never reachable.
 * - **Resolution.** The broker is the only resolver: one lookup per connection, every answer judged
 *   by the special-range table (`common/networkAddress.ts`), and the connection goes to the address
 *   that was checked (no second lookup: DNS rebinding can't swap one in). No cache across
 *   connections.
 * - **Protocols.** `CONNECT host:port` (authority form, port required) and plain-HTTP forwarding
 *   (absolute form; a `Host` header that disagrees is refused). After `200` a tunnel is opaque
 *   bytes to the checked address: what the client pipelines after `CONNECT` is tunnel payload,
 *   never parsed as another request. Redirects are never followed: a `3xx` goes back to the client,
 *   whose next request is a new connection, checked again.
 * - **Live grants.** "Allow host" commits a session grant with compare-and-swap on the grant epoch
 *   and applies to the running process's next connection. A revocation (or narrower rules)
 *   re-judges every open tunnel of the subject and closes those no longer allowed, at once.
 * - **Budgets.** Per route: concurrent connections, bytes per day, and prompt-worthy denials per
 *   G.12 (one per minute, three per day, coalesced over 2 s, auto-deny after two refusals).
 * - **Audit.** Every connect, denial and close: `{ts, principal, chain, method, destination, port,
 *   decision, reason, epoch}` (I.1 row 6).
 *
 * TLS is not inspected: a client can still front a request through an allowed CDN (a residual).
 */

export const BROKER_TUNNEL_IDLE_MS = 120_000;
export const BROKER_HEADER_TIMEOUT_MS = 15_000;
export const BROKER_MAX_CONNECTIONS = 64;
const DAY_MS = 24 * 60 * 60 * 1000;
const COALESCE_MS = 2_000;
const MAX_DENIAL_RECORDS = 256;
/** How long a closed route's denial can still be allowed for its chat. */
const ENDED_DENIAL_MS = DAY_MS;

/** Why the broker refused (I.4 "Denials"). */
export type NetworkRefusal = 'not-allowed' | 'private-address' | 'metadata' | 'port' | 'transport' | 'rate-limit' | 'unresolvable' | 'auth';

export interface IResolvedAddress {
	readonly address: string;
	readonly family: 4 | 6;
}

export type NetworkLookup = (host: string) => Promise<readonly IResolvedAddress[]>;

/** One refusal, as the transcript and the approval flow see it (I.4 "Denials"). */
export interface INetworkDenial {
	readonly denialId: string;
	/** The route's principal id. */
	readonly principal: string;
	readonly subject: SubjectKey;
	readonly epoch: number;
	readonly destination: string;
	readonly port: number;
	readonly reason: NetworkRefusal;
	/** Volt-authored text, also the body of the 403. */
	readonly message: string;
	/** Whether an "Allow" may be offered for it: a host rule could open it, and the prompt budget (G.12) is not spent. */
	readonly promptable: boolean;
}

/** What an approval holds for: this run of the principal, or every run of its chat (P4 denial card). */
export type NetworkApprovalScope = 'run' | 'chat';

export type NetworkApprovalResult = { readonly ok: true; readonly epoch: number } | { readonly ok: false; readonly epoch: number; readonly reason: string };

export interface INetworkAuditEvent {
	readonly ts: number;
	readonly principal: string;
	readonly subject: SubjectKey;
	/** Subjects this principal acts for, outermost first. */
	readonly chain: readonly SubjectKey[];
	readonly method: 'CONNECT' | 'HTTP';
	readonly destination: string;
	readonly port: number;
	/** The address connected to (allowed connections). */
	readonly address?: string;
	readonly decision: 'allow' | 'deny' | 'close';
	readonly reason?: NetworkRefusal | 'revoked' | 'idle' | 'budget' | 'done';
	readonly epoch: number;
	readonly denialId?: string;
	/** Bytes both ways, on close. */
	readonly bytes?: number;
	/** `auth` with another route's token: whose (B-31 cross-principal reuse). */
	readonly tokenOf?: SubjectKey;
}

/**
 * Where grants come from: the in-memory store by default, or a `GrantStore` (`~/.volt/trust`),
 * whose `data`, `commit` and `onDidChange` have exactly this shape.
 */
export interface INetworkGrantSource {
	readonly data: { readonly epoch: number; readonly grants: readonly IGrant[] };
	commit(expectedEpoch: number, change: IGrantStoreChange): Promise<GrantCommitResult>;
	readonly onDidChange?: (listener: (event: IGrantStoreChangeEvent) => void) => IDisposable;
}

/** The broker's own grants: session grants live as long as Volt does. Commits apply synchronously. */
export class MemoryGrantSource implements INetworkGrantSource {

	private _data: { epoch: number; grants: readonly IGrant[] } = { epoch: 0, grants: [] };

	get data(): { readonly epoch: number; readonly grants: readonly IGrant[] } {
		return this._data;
	}

	commit(expectedEpoch: number, change: IGrantStoreChange): Promise<GrantCommitResult> {
		if (expectedEpoch !== this._data.epoch) {
			return Promise.resolve({ committed: false, epoch: this._data.epoch });
		}
		const epoch = this._data.epoch + 1;
		const revoke = new Set(change.revoke ?? []);
		const kept = this._data.grants.filter(grant => !revoke.has(grant.id));
		const added = (change.add ?? []).filter(draft => !kept.some(grant => grant.id === draft.id)).map(draft => ({ ...draft, epoch }));
		if (kept.length === this._data.grants.length && !added.length) {
			return Promise.resolve({ committed: true, epoch: this._data.epoch, changed: false });
		}
		this._data = { epoch, grants: [...kept, ...added] };
		return Promise.resolve({ committed: true, epoch, changed: true });
	}
}

/**
 * What the broker judges a principal that is not a chat by (a T2 plugin, a T3 extension, an MCP
 * server): core's record of it, never anything the principal sent. The Authority reads it as the
 * snapshot's manifest, its own grants and, when it acts for chats, those chats: G.2 step 6 then
 * holds its connections to what each chat in its chain may reach, so a view is never wider than
 * its parent chat's.
 */
export interface INetworkPrincipalView {
	/** Its manifest: `net.connect` targets it declares; `network: 'none'` refuses every connection. */
	readonly manifest: IManifestView;
	/** Grants core holds for it beyond the broker's own (an MCP server's approved hosts, recorded when the user approved the server). */
	readonly grants?: readonly IGrant[];
	/** The principals it acts for, outermost first, each with its chat view when it is a chat. */
	readonly onBehalfOf?: readonly { readonly principal: IPrincipal; readonly chat?: IChatView }[];
}

/**
 * Supplies the view of a principal that is not a chat. Providers are asked in the order they were
 * registered; the first that knows the principal answers. None knows it: the broker has no manifest
 * for it and refuses every connection (fail closed).
 */
export type NetworkViewProvider = (principal: IPrincipal) => INetworkPrincipalView | undefined;

export interface INetworkBrokerOptions {
	/** Name resolution; tests replace it. */
	readonly lookup?: NetworkLookup;
	/** Opens the upstream connection to a checked address; tests replace it. */
	readonly connect?: (address: IResolvedAddress, port: number) => net.Socket;
	readonly tunnelIdleMs?: number;
	readonly headerTimeoutMs?: number;
	readonly grants?: INetworkGrantSource;
	/** Every connect, denial and close. */
	readonly audit?: (event: INetworkAuditEvent) => void;
	/** Volt's own listener ports: never reachable through the broker, whatever is granted. */
	readonly reservedPorts?: () => readonly number[];
	readonly admin?: IAdminPolicy;
	/** The managed policy as it is now (it can change while Volt runs); wins over `admin`. See {@link NetworkBroker.adminChanged}. */
	readonly adminPolicy?: () => IAdminPolicy | undefined;
	readonly now?: () => number;
}

export interface INetworkRouteLimits {
	/** Upstream connections open at once. */
	readonly maxConnections: number;
	/** Bytes both ways per day; undefined: no byte budget (agents, H.8 "chat grants"). */
	readonly bytesPerDay?: number;
	/** Prompt-worthy denials (G.12). */
	readonly promptsPerMinute: number;
	readonly promptsPerDay: number;
	/** Refusals after which nothing more is offered until {@link NetworkRoute.resetPromptBudget}. */
	readonly refusalsToAutoDeny: number;
}

/** H.8's network budget per principal kind. */
export function defaultRouteLimits(kind: PrincipalKind): INetworkRouteLimits {
	const bytesPerDay = kind === 't2' ? 50 * 1024 * 1024 : kind === 't3' || kind === 't3-web' ? 200 * 1024 * 1024 : undefined;
	return { maxConnections: BROKER_MAX_CONNECTIONS, ...(bytesPerDay ? { bytesPerDay } : {}), promptsPerMinute: 1, promptsPerDay: 3, refusalsToAutoDeny: 2 };
}

export interface INetworkRouteOptions {
	readonly principal: IPrincipal;
	/** Principals it acts for, outermost first (built by core). */
	readonly onBehalfOf?: readonly IPrincipal[];
	/** The launch-time host rules: the chat's allowed hosts and its agent's API hosts. */
	readonly allow: readonly string[];
	/** Loopback ports reachable through the broker (`net.loopback.connect:<port>`); none by default. */
	readonly loopbackPorts?: readonly number[];
	readonly level?: 'workspace-write' | 'read-only';
	/**
	 * A principal that is not a chat: its view, given by the launcher. Absent: the broker's
	 * registered providers are asked ({@link NetworkBroker.registerViewProvider}).
	 */
	readonly view?: INetworkPrincipalView;
	readonly limits?: Partial<INetworkRouteLimits>;
	readonly onDenial?: (denial: INetworkDenial) => void;
}

interface IOpenConnection {
	readonly client: net.Socket;
	readonly upstream: net.Socket;
	readonly method: 'CONNECT' | 'HTTP';
	readonly destination: string;
	readonly port: number;
	readonly address: string;
	/** The requests that allowed it: re-judged on every narrowing. */
	readonly requests: readonly IAccessRequest[];
	bytes: number;
	closed: boolean;
}

interface IDenialRecord {
	readonly denial: INetworkDenial;
	readonly at: number;
	/** The normalised destination the broker refused: what an approval grants, never the client's text. */
	readonly target: INormalizedHost;
}

type Verdict = { readonly ok: true; readonly address: IResolvedAddress; readonly requests: readonly IAccessRequest[]; readonly epoch: number } | { readonly ok: false; readonly reason: NetworkRefusal; readonly message: string; readonly decision?: IDecision; readonly target?: INormalizedHost; readonly epoch: number };

export class NetworkBroker {

	private readonly grants: INetworkGrantSource;
	private readonly routes = new Set<NetworkRoute>();
	private readonly listener: IDisposable | undefined;
	private readonly viewProviders: NetworkViewProvider[] = [];
	/**
	 * Approvable denials of routes that closed, by id: a chat's denial card is usually answered after
	 * the agent process that was refused has ended (a turn ends, the next one gets a fresh process).
	 * Kept for chats only, newest {@link MAX_DENIAL_RECORDS}, for {@link ENDED_DENIAL_MS}.
	 */
	private readonly endedDenials = new Map<string, IDenialRecord & { readonly subject: SubjectKey }>();
	private disposed = false;

	constructor(readonly options: INetworkBrokerOptions = {}) {
		this.grants = options.grants ?? new MemoryGrantSource();
		this.listener = this.grants.onDidChange?.(event => this.changed(event.subjects, event.narrowed));
	}

	get epoch(): number {
		return this.grants.data.epoch;
	}

	now(): number {
		return (this.options.now ?? Date.now)();
	}

	/** Opens a route for `options.principal`: its own listener and token. */
	async openRoute(options: INetworkRouteOptions): Promise<NetworkRoute> {
		if (this.disposed) {
			throw new Error('the network broker is shut down');
		}
		const route = await NetworkRoute.open(this, options);
		this.routes.add(route);
		return route;
	}

	/** @internal `denials`: the closed route's approvable records, kept for "Allow for This Chat". */
	routeClosed(route: NetworkRoute, denials: Iterable<[string, IDenialRecord]> = []): void {
		this.routes.delete(route);
		if (!isChatSubject(route.subject)) {
			return;
		}
		for (const [id, record] of denials) {
			this.endedDenials.set(id, { ...record, subject: route.subject });
		}
		const oldest = this.now() - ENDED_DENIAL_MS;
		for (const [id, record] of this.endedDenials) {
			if (this.endedDenials.size > MAX_DENIAL_RECORDS || record.at < oldest) {
				this.endedDenials.delete(id);
			}
		}
	}

	/**
	 * "Allow for This Chat" by denial id, whether or not the refused run is still open (P4 denial
	 * card). The denial must be one the broker recorded for `chatId` (B-34) at `deniedEpoch` (the
	 * epoch the card was shown with), and approvable; the rule is re-derived from the broker's own
	 * record, never the client's text. The grant is the chat's (a session grant bound to the chat,
	 * kept in the grant store until revoked), applied on the latest epoch: unrelated approvals since
	 * the denial don't make the card ask again. Every open route of the chat re-judges at once, and
	 * its later runs get it from their first connection. A denial is approved once.
	 */
	async approveForChat(chatId: string, denialId: string, deniedEpoch: number): Promise<NetworkApprovalResult> {
		const subject = chatSubject(chatId);
		const route = this.routeOfDenial(denialId);
		const ended = route ? undefined : this.endedDenials.get(denialId);
		const record = route?.subject === subject ? route.denialRecord(denialId) : ended?.subject === subject ? ended : undefined;
		if (!record) {
			return { ok: false, epoch: this.epoch, reason: 'Volt has no record of this denial for this chat (it may be too old); allow the host when it is blocked again' };
		}
		if (record.denial.epoch !== deniedEpoch) {
			return { ok: false, epoch: this.epoch, reason: 'this is not the denial Volt recorded' };
		}
		if (record.denial.reason !== 'not-allowed' && record.denial.reason !== 'port') {
			return { ok: false, epoch: this.epoch, reason: `a ${record.denial.reason} refusal can't be approved` };
		}
		const now = this.now();
		const draft = networkGrantDraft(subject, chatId, `chat:${chatId}`, approvalEntry(record), now);
		route?.forgetDenial(denialId);
		this.endedDenials.delete(denialId);
		const epoch = await this.update({ add: [draft] });
		return { ok: true, epoch };
	}

	/** The route that recorded `denialId`, if it is still open. */
	routeOfDenial(denialId: string): NetworkRoute | undefined {
		for (const route of this.routes) {
			if (route.hasDenial(denialId)) {
				return route;
			}
		}
		return undefined;
	}

	/**
	 * Registers where the views of principals that are not chats come from (plugin hosts, MCP
	 * servers). Disposing it takes the provider back; routes it answered for re-judge their tunnels.
	 */
	registerViewProvider(provider: NetworkViewProvider): IDisposable {
		this.viewProviders.push(provider);
		return {
			dispose: () => {
				const at = this.viewProviders.indexOf(provider);
				if (at >= 0) {
					this.viewProviders.splice(at, 1);
					this.changed([], true);
				}
			}
		};
	}

	/** The view of `principal` from the first provider that knows it. */
	viewOf(principal: IPrincipal): INetworkPrincipalView | undefined {
		for (const provider of this.viewProviders) {
			const view = provider(principal);
			if (view) {
				return view;
			}
		}
		return undefined;
	}

	/** I.4 "Approval" by denial id: the route that recorded it re-derives the rule from its own record. */
	approve(denialId: string, expectedEpoch: number, scope: NetworkApprovalScope = 'run'): Promise<NetworkApprovalResult> {
		const route = this.routeOfDenial(denialId);
		return route ? route.approve(denialId, expectedEpoch, scope) : Promise.resolve({ ok: false, epoch: this.epoch, reason: 'no such denial: its run has ended' });
	}

	refuse(denialId: string): boolean {
		return this.routeOfDenial(denialId)?.refuse(denialId) ?? this.endedDenials.delete(denialId);
	}

	/** The Access page was opened (G.12): prompts may be offered again, for one subject's routes or all. */
	resetPromptBudget(subject?: SubjectKey): void {
		for (const route of this.routes) {
			if (!subject || route.subject === subject) {
				route.resetPromptBudget();
			}
		}
	}

	/** Each open route's subject and prompt budget, for the Access page. */
	promptBudgets(): { readonly subject: SubjectKey; readonly refusals: number; readonly autoDenied: boolean; readonly promptsToday: number }[] {
		return [...this.routes].map(route => ({ subject: route.subject, ...route.promptBudget() }));
	}

	/** A provider's answer changed for `subjects` (an approval was revoked, a manifest narrowed): their routes re-judge. */
	viewsChanged(subjects: readonly SubjectKey[], narrowed: boolean): void {
		this.changed(subjects, narrowed);
	}

	/** The managed policy changed: every route re-judges, and closes what it no longer allows. */
	adminChanged(): void {
		for (const route of [...this.routes]) {
			route.invalidate(true);
		}
	}

	/** The grants of `subject` at the current epoch. */
	grantsOf(subject: SubjectKey): readonly IGrant[] {
		return this.grants.data.grants.filter(grant => grant.subject === subject);
	}

	/** Whose route a token is (B-31: a token used on another route is cross-principal reuse). */
	tokenOwner(token: string, except: NetworkRoute): NetworkRoute | undefined {
		for (const route of this.routes) {
			if (route !== except && route.hasToken(token)) {
				return route;
			}
		}
		return undefined;
	}

	reservedPorts(): ReadonlySet<number> {
		return new Set([...(this.options.reservedPorts?.() ?? []), ...[...this.routes].map(route => route.port)]);
	}

	/**
	 * Compare-and-swap on the grant epoch (F.9): applies `change` only if the epoch is still
	 * `expectedEpoch`. Then every route of a changed subject re-judges its tunnels.
	 */
	async commit(expectedEpoch: number, change: IGrantStoreChange): Promise<GrantCommitResult> {
		const before = this.grants.data.grants;
		const result = await this.grants.commit(expectedEpoch, change);
		if (result.committed && result.changed) {
			const revoked = new Set(change.revoke ?? []);
			const subjects = new Set<SubjectKey>([...before.filter(grant => revoked.has(grant.id)), ...(change.add ?? [])].map(grant => grant.subject));
			this.changed([...subjects], revoked.size > 0);
		}
		return result;
	}

	/** CAS retried on the latest epoch: concurrent approvals both land, in order (F.9). */
	async update(change: IGrantStoreChange): Promise<number> {
		for (let attempt = 0; attempt < 16; attempt++) {
			const result = await this.commit(this.epoch, change);
			if (result.committed) {
				return result.epoch;
			}
		}
		throw new Error('the grant epoch kept changing under this commit');
	}

	private changed(subjects: readonly SubjectKey[], narrowed: boolean): void {
		for (const route of this.routes) {
			if (!subjects.length || subjects.includes(route.subject)) {
				route.invalidate(narrowed);
			}
		}
	}

	audit(event: INetworkAuditEvent): void {
		try {
			this.options.audit?.(event);
		} catch {
			// The audit sink must not break a connection.
		}
	}

	resolve(host: string): Promise<readonly IResolvedAddress[]> {
		return (this.options.lookup ?? defaultLookup)(host);
	}

	open(address: IResolvedAddress, port: number): net.Socket {
		return this.options.connect ? this.options.connect(address, port) : net.connect({ host: address.address, port, family: address.family });
	}

	dispose(): void {
		this.disposed = true;
		this.listener?.dispose();
		for (const route of [...this.routes]) {
			route.dispose();
		}
		this.endedDenials.clear();
	}
}

/** The rule an approval of `record` adds: the host as the broker normalised it, its port unless 443. */
function approvalEntry(record: IDenialRecord): string {
	return record.target.ip
		? `${record.target.ip === 6 ? `[${record.target.host}]` : record.target.host}:${record.denial.port}`
		: record.denial.port === 443 ? record.target.host : `${record.target.host}:${record.denial.port}`;
}

/** A user's `net.connect` session grant of `subject` for `target`, bound to session `sessionId` (a principal or a chat). */
function networkGrantDraft(subject: SubjectKey, sessionId: string, idOf: string, target: string, at: number): IGrant {
	const capability = 'net.connect@1';
	return {
		id: `net:${idOf}:${createHash('sha256').update(`${capability}|${target}|session|${at}|${randomBytes(4).toString('hex')}`).digest('hex').slice(0, 16)}`,
		subject, capability, scope: { targets: [target] }, kind: 'session', sessionId,
		source: 'user', grantedAt: at, lastUsedAt: at, epoch: 0,
	};
}

/** Whether `address` (canonical text) is one of this machine's own interface addresses. */
function ownAddress(address: string): boolean {
	const bare = address.replace(/^\[|\]$/g, '').toLowerCase();
	return Object.values(networkInterfaces()).some(list => list?.some(entry => entry.address.toLowerCase() === bare || entry.address.toLowerCase() === bare.replace(/^::ffff:/, '')));
}

/** One principal's way out: its listener, token, rules, live grants, budgets and open connections. */
export class NetworkRoute {

	private readonly connections = new Set<IOpenConnection>();
	/** Requests judged but not yet tracked (a lookup in flight): they hold a connection slot too. */
	private inFlight = 0;
	private readonly clients = new Set<net.Socket>();
	private readonly denials = new Map<string, IDenialRecord>();
	private readonly expectedAuth: Buffer;
	private allow: readonly string[];
	private snapshot: PolicySnapshot | undefined;
	private bytesToday = 0;
	private dayStarted: number;
	private prompts: number[] = [];
	private lastPromptAt = -Infinity;
	private refusals = 0;
	private disposed = false;
	readonly limits: INetworkRouteLimits;
	readonly subject: SubjectKey;

	static async open(broker: NetworkBroker, options: INetworkRouteOptions): Promise<NetworkRoute> {
		// No Host header is fine for a proxy: the request line names the destination (and a Host that disagrees is refused).
		const serverOptions: http.ServerOptions & { readonly requireHostHeader?: boolean } = { maxHeaderSize: 16 * 1024, requireHostHeader: false, connectionsCheckingInterval: 1000 };
		const server = http.createServer(serverOptions);
		const route = new NetworkRoute(broker, server, options, randomBytes(24).toString('base64url'));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				server.off('error', reject);
				resolve();
			});
		});
		// Accept errors (EMFILE under load) drop that connection, never the process.
		server.on('error', () => undefined);
		return route;
	}

	private constructor(
		private readonly broker: NetworkBroker,
		private readonly server: http.Server,
		private readonly options: INetworkRouteOptions,
		readonly token: string,
	) {
		this.subject = options.principal.subject;
		this.allow = normalizeEntries(options.allow);
		this.limits = { ...defaultRouteLimits(options.principal.kind), ...options.limits };
		this.dayStarted = broker.now();
		this.expectedAuth = Buffer.from(`Basic ${Buffer.from(`volt:${token}`).toString('base64')}`);
		const headerTimeout = broker.options.headerTimeoutMs ?? BROKER_HEADER_TIMEOUT_MS;
		server.headersTimeout = headerTimeout;
		server.requestTimeout = headerTimeout * 4;
		server.on('connection', socket => {
			if (this.clients.size >= this.limits.maxConnections * 2) {
				socket.destroy();
				return;
			}
			this.clients.add(socket);
			socket.on('error', () => undefined);
			socket.once('close', () => this.clients.delete(socket));
			// Slowloris: a client that does not finish its request headers in time is dropped.
			const timer = setTimeout(() => socket.destroy(), headerTimeout);
			const parsed = () => clearTimeout(timer);
			socket.once('volt-parsed', parsed);
			socket.once('close', parsed);
		});
		server.on('connect', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
			socket.emit('volt-parsed');
			void this.tunnel(req, socket, head);
		});
		server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
			req.socket.emit('volt-parsed');
			void this.forward(req, res);
		});
		// Malformed requests (CL/TE conflicts, bad framing): 400 and closed, never forwarded.
		server.on('clientError', (_err, socket: net.Socket) => {
			if (socket.writable) {
				socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nVolt sandbox proxy: malformed request\r\n');
			} else {
				socket.destroy();
			}
		});
	}

	get principal(): IPrincipal {
		return this.options.principal;
	}

	get port(): number {
		const address = this.server.address();
		return typeof address === 'object' && address ? address.port : 0;
	}

	get url(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** Upstream connections open now. */
	get openConnections(): number {
		return this.connections.size;
	}

	get bytes(): number {
		return this.bytesToday;
	}

	hasToken(token: string): boolean {
		const given = Buffer.from(token);
		const mine = Buffer.from(this.token);
		return given.length === mine.length && timingSafeEqual(given, mine);
	}

	// --- grants ------------------------------------------------------------------------------

	/** The session grants this route committed (sessionId = the principal id). */
	private ownGrants(): readonly IGrant[] {
		return this.broker.grantsOf(this.subject).filter(grant => grant.sessionId === this.principal.id && grant.kind === 'session');
	}

	/**
	 * "Allow host" for the running process (F.9, B-31): a session grant per entry, committed with
	 * CAS on the grant epoch; the next connection uses it. Entries naming a private, loopback or
	 * metadata address are dropped: "Allow host" never allows a private address.
	 */
	async allowHosts(entries: readonly string[]): Promise<number> {
		const targets = normalizeEntries(entries).filter(entry => {
			if (!isChatSubject(this.subject) && entry === '*') {
				return false; // H.7: never public `*` for a plugin, extension or MCP server.
			}
			const rule = parseNetworkRule(entry);
			return rule && (rule.kind !== 'ip' || classifyAddress(rule.cidr.slice(0, rule.cidr.lastIndexOf('/')))?.class === 'public');
		}).filter(entry => !this.ownGrants().some(grant => grant.capability === 'net.connect@1' && grant.scope.targets?.[0] === entry));
		if (!targets.length) {
			return this.broker.epoch;
		}
		return this.broker.update({ add: targets.map(target => this.grantDraft('net.connect@1', target, 'session')) });
	}

	/** Revokes this route's live grants for `entries`: open tunnels they allowed close now. */
	async revokeHosts(entries: readonly string[]): Promise<number> {
		const targets = new Set(normalizeEntries(entries));
		const ids = this.ownGrants().filter(grant => grant.scope.targets?.some(target => targets.has(target))).map(grant => grant.id);
		return ids.length ? this.broker.update({ revoke: ids }) : this.broker.epoch;
	}

	/**
	 * The client approves a denial (I.4 "Approval"): it names the denial and the epoch it saw, and
	 * the broker re-derives the rule from its own record, so a client can't swap the host. Private
	 * and metadata refusals are never approvable. CAS: refused as stale when the epoch moved.
	 */
	async approve(denialId: string, expectedEpoch: number, scope: NetworkApprovalScope = 'run'): Promise<NetworkApprovalResult> {
		const record = this.denials.get(denialId);
		if (!record) {
			return { ok: false, epoch: this.broker.epoch, reason: 'no such denial on this route' };
		}
		if (record.denial.reason !== 'not-allowed' && record.denial.reason !== 'port') {
			return { ok: false, epoch: this.broker.epoch, reason: `a ${record.denial.reason} refusal can't be approved` };
		}
		const chatId = subjectChatId(this.subject);
		if (scope === 'chat' && !chatId) {
			return { ok: false, epoch: this.broker.epoch, reason: 'this principal is not a chat' };
		}
		const entry = approvalEntry(record);
		// "Allow": this run (the route's own session, revoked when it closes). "Allow for This Chat": a
		// session grant of the chat, kept in the grant store for every later run of it until revoked.
		const draft = scope === 'chat' ? { ...this.grantDraft('net.connect@1', entry, 'session'), sessionId: chatId! } : this.grantDraft('net.connect@1', entry, 'session');
		const result = await this.broker.commit(expectedEpoch, { add: [draft] });
		if (!result.committed) {
			return { ok: false, epoch: result.epoch, reason: 'the permissions changed since this denial; ask again' };
		}
		this.denials.delete(denialId);
		return { ok: true, epoch: result.epoch };
	}

	/** The user refused a prompt: after `refusalsToAutoDeny` of them nothing more is offered (G.12). */
	refuse(denialId: string): boolean {
		if (this.denials.delete(denialId)) {
			this.refusals++;
			return true;
		}
		return false;
	}

	/** Whether `denialId` is one of this route's approvable denials. */
	hasDenial(denialId: string): boolean {
		return this.denials.has(denialId);
	}

	/** @internal The broker's record of approvable denial `denialId`. */
	denialRecord(denialId: string): IDenialRecord | undefined {
		return this.denials.get(denialId);
	}

	/** @internal Approved elsewhere (for the chat): approved once. */
	forgetDenial(denialId: string): void {
		this.denials.delete(denialId);
	}

	/** G.12 as the Access page shows it. */
	promptBudget(): { readonly refusals: number; readonly autoDenied: boolean; readonly promptsToday: number } {
		const now = this.broker.now();
		return { refusals: this.refusals, autoDenied: this.refusals >= this.limits.refusalsToAutoDeny, promptsToday: this.prompts.filter(at => now - at < DAY_MS).length };
	}

	/** The Access page was opened: prompts may be offered again (G.12). */
	resetPromptBudget(): void {
		this.refusals = 0;
		this.prompts = [];
	}

	/**
	 * New launch-time rules (the chat's allowed hosts changed): a widening applies to the next
	 * connection, a narrowing also closes the tunnels it no longer allows.
	 */
	setRules(allow: readonly string[]): void {
		const next = normalizeEntries(allow);
		const narrowed = this.allow.some(entry => !next.includes(entry));
		this.allow = next;
		this.invalidate(narrowed);
	}

	private grantDraft(_capability: 'net.connect@1', target: string, _kind: 'session'): IGrant {
		return networkGrantDraft(this.subject, this.principal.id, this.principal.id, target, this.broker.now());
	}

	/** @internal The grants or rules changed: rebuild the snapshot, and on a narrowing close what is no longer allowed. */
	invalidate(narrowed: boolean): void {
		this.snapshot = undefined;
		if (!narrowed) {
			return;
		}
		for (const connection of [...this.connections]) {
			if (connection.requests.some(request => !this.decide(request).allow)) {
				this.close(connection, 'revoked');
			}
		}
	}

	// --- decisions ---------------------------------------------------------------------------

	private currentSnapshot(): PolicySnapshot {
		const now = this.broker.now();
		if (this.snapshot && (this.snapshot.epoch !== this.broker.epoch || (this.snapshot.rebuildAt !== undefined && now >= this.snapshot.rebuildAt))) {
			this.snapshot = undefined;
		}
		if (!this.snapshot) {
			const policy = this.broker.options.adminPolicy?.() ?? this.broker.options.admin;
			const admin = policy ? { admin: policy } : {};
			if (isChatSubject(this.subject)) {
				this.snapshot = PolicySnapshot.build({
					epoch: this.broker.epoch,
					asOf: now,
					grants: this.broker.grantsOf(this.subject),
					chats: [{ subject: this.subject, settings: { level: this.options.level ?? 'workspace-write', network: false, allowedDomains: this.allow, listenPorts: this.options.loopbackPorts ?? [] } }],
					...admin,
				});
			} else {
				// Any other principal is judged by core's view of it; with none, by no manifest: refused.
				const view = this.view();
				const callers = view?.onBehalfOf ?? [];
				const chats = callers.map(caller => caller.chat).filter((chat): chat is IChatView => !!chat);
				const grants = [this.subject, ...callers.map(caller => caller.principal.subject)].flatMap(subject => this.broker.grantsOf(subject));
				this.snapshot = PolicySnapshot.build({
					epoch: this.broker.epoch,
					asOf: now,
					grants: [...grants, ...(view?.grants ?? []).filter(grant => grant.subject === this.subject)],
					...(view ? { manifests: [this.routeManifest({ ...view.manifest, subject: this.subject }, grants.filter(grant => grant.subject === this.subject), now)] } : {}),
					...(chats.length ? { chats } : {}),
					...admin,
				});
			}
		}
		return this.snapshot;
	}

	/** Core's view of a principal that is not a chat: the launcher's, else a registered provider's. */
	private view(): INetworkPrincipalView | undefined {
		return this.options.view ?? this.broker.viewOf(this.principal);
	}

	/**
	 * A plugin's manifest as this route judges it: `net.connect` only for hosts named (never an
	 * untargeted or `*` declaration), plus the hosts its valid grants name. `net.connect` is low, so
	 * a named host is an install-time grant (G.4); the user's "Allow host" names the rest.
	 */
	private routeManifest(manifest: IManifestView, grants: readonly IGrant[], now: number): IManifestView {
		const context = { asOf: now, epoch: this.broker.epoch, sessionIds: [this.principal.id] };
		// Host rules only (I.4): `**`, `*.*`, `*.com` or `*example.com` name no host, and `*` is never a plugin's (H.7).
		const named = (targets: readonly string[] | undefined) => (targets ?? []).filter(target => {
			const rule = parseNetworkRule(target);
			return !!rule && rule.kind !== 'any';
		});
		const granted = grants.filter(grant => !grant.revoked && grant.capability.split('@')[0] === 'net.connect' && grantValid(grant, context)).flatMap(grant => named(grant.scope.targets));
		const declared = manifest.declared.flatMap(entry => {
			if (entry.id.split('@')[0] !== 'net.connect') {
				return [entry];
			}
			const targets = named(entry.targets);
			return targets.length ? [{ ...entry, targets }] : [];
		});
		return { ...manifest, declared: granted.length ? [...declared, { id: 'net.connect', targets: granted }] : declared };
	}

	private context(): ICallContext {
		const onBehalfOf = this.options.onBehalfOf ?? (isChatSubject(this.subject) ? undefined : this.view()?.onBehalfOf?.map(caller => caller.principal)) ?? [];
		return { principal: this.principal, onBehalfOf, requestId: randomBytes(8).toString('hex') };
	}

	private decide(request: IAccessRequest): IDecision {
		return evaluate(this.currentSnapshot(), request, this.context());
	}

	/** The address to connect to, or why not. One lookup, every answer judged, the checked address returned. */
	async destination(rawHost: string, port: number): Promise<Verdict> {
		const epoch = this.broker.epoch;
		const refuse = (reason: NetworkRefusal, message: string, extra: { decision?: IDecision; target?: INormalizedHost } = {}): Verdict => ({ ok: false, reason, message, epoch, ...extra });
		if (this.disposed) {
			return refuse('transport', 'Volt sandbox proxy: this route is closed.');
		}
		this.rollDay();
		if (this.limits.bytesPerDay !== undefined && this.bytesToday >= this.limits.bytesPerDay) {
			return refuse('rate-limit', `Blocked by Volt sandbox: this principal used its network budget for today (${Math.round(this.limits.bytesPerDay / 1024 / 1024)} MB).`);
		}
		if (this.connections.size + this.inFlight >= this.limits.maxConnections) {
			return refuse('rate-limit', `Blocked by Volt sandbox: more than ${this.limits.maxConnections} connections at once.`);
		}
		// Pipelined requests arrive together: each holds its slot from here until it is tracked or refused.
		this.inFlight++;
		try {
			return await this.judgeDestination(rawHost, port, epoch, refuse);
		} finally {
			this.inFlight--;
		}
	}

	private async judgeDestination(rawHost: string, port: number, epoch: number, refuse: (reason: NetworkRefusal, message: string, extra?: { decision?: IDecision; target?: INormalizedHost }) => Verdict): Promise<Verdict> {
		const target = normalizeNetworkHost(rawHost);
		if (typeof target === 'string') {
			return refuse('transport', `Blocked by Volt sandbox: ${target}.`);
		}
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			return refuse('port', `Blocked by Volt sandbox: ${port} is not a port.`, { target });
		}
		const requests: IAccessRequest[] = [];
		if (target.ip) {
			const judged = this.judgeAddress(target.host, port, requests);
			return judged ? refuse(judged.reason, judged.message, { target, ...(judged.decision ? { decision: judged.decision } : {}) }) : { ok: true, address: { address: target.host, family: target.ip }, requests, epoch };
		}
		const named: IAccessRequest = { capability: 'net.connect', target: target.host, port, surface: 'broker' };
		const decision = this.decide(named);
		if (!decision.allow) {
			const text = decision.code === 'chat-sandbox'
				? `network access to ${target.host} is off for this chat. Ask the user to allow it.`
				: !isChatSubject(this.subject) && (decision.code === 'undeclared' || decision.code === 'undeclared-target')
					? `network access to ${target.host} is off for this extension or plugin. The user can allow the host.`
					: `${decision.reason}.`;
			return refuse(decision.code === 'port' ? 'port' : 'not-allowed', `Blocked by Volt sandbox: ${text}`, { decision, target });
		}
		requests.push(named);
		let answers: readonly IResolvedAddress[];
		try {
			answers = await this.broker.resolve(target.host);
		} catch {
			return refuse('unresolvable', `Volt sandbox proxy could not resolve ${target.host}.`, { target });
		}
		if (!answers.length) {
			return refuse('unresolvable', `Volt sandbox proxy could not resolve ${target.host}.`, { target });
		}
		// Every answer must be public (I.4 "DNS"): a name that also resolves to a local, private or
		// metadata address is a rebinding attempt, whatever local permission the principal holds (those
		// name an address, never a name). The allowed name covers its public answers.
		for (const answer of answers) {
			const classification = classifyAddress(answer.address);
			if (classification?.class !== 'public') {
				const metadata = classification?.class === 'metadata';
				return refuse(metadata ? 'metadata' : 'private-address', `Blocked by Volt sandbox: ${target.host} resolves to ${metadata ? 'a cloud metadata address' : 'a local, private or reserved address'}.`, { target });
			}
		}
		// A revocation (or narrower rules) during the lookup is not missed: judged again before connecting.
		if (this.disposed) {
			return refuse('transport', 'Volt sandbox proxy: this route is closed.');
		}
		const again = this.decide(named);
		if (!again.allow) {
			return refuse(again.code === 'port' ? 'port' : 'not-allowed', `Blocked by Volt sandbox: ${again.reason}.`, { decision: again, target });
		}
		return { ok: true, address: answers[0], requests, epoch: this.broker.epoch };
	}

	/** Undefined when the address may be reached; the requests that allowed it are appended. */
	private judgeAddress(address: string, port: number, requests: IAccessRequest[]): { readonly reason: NetworkRefusal; readonly message: string; readonly decision?: IDecision } | undefined {
		const classification = classifyAddress(address);
		if (!classification) {
			return { reason: 'transport', message: `Blocked by Volt sandbox: ${address} is not an address.` };
		}
		switch (classification.class) {
			case 'metadata':
				return { reason: 'metadata', message: `Blocked by Volt sandbox: ${address} is a cloud metadata address.` };
			case 'special':
				return { reason: 'private-address', message: `Blocked by Volt sandbox: ${address} is a reserved address.` };
			case 'loopback': {
				if (this.broker.reservedPorts().has(port)) {
					return { reason: 'private-address', message: `Blocked by Volt sandbox: port ${port} on this machine is Volt's own.` };
				}
				const request: IAccessRequest = { capability: `net.loopback.connect:${port}`, target: classification.judged, port, surface: 'broker' };
				const decision = this.decide(request);
				if (!decision.allow) {
					return { reason: 'private-address', message: `Blocked by Volt sandbox: ${address} is this machine, and port ${port} was not granted.`, decision };
				}
				requests.push(request);
				return undefined;
			}
			case 'local': {
				// A Volt listener on all interfaces is reachable at this machine's LAN address as well.
				if (this.broker.reservedPorts().has(port) && ownAddress(classification.judged)) {
					return { reason: 'private-address', message: `Blocked by Volt sandbox: port ${port} on this machine is Volt's own.` };
				}
				const request: IAccessRequest = { capability: 'net.local.connect', target: classification.judged, port, surface: 'broker' };
				const decision = this.decide(request);
				if (!decision.allow) {
					return { reason: 'private-address', message: `Blocked by Volt sandbox: ${address} is on the local network, which was not granted.`, decision };
				}
				requests.push(request);
				return undefined;
			}
			case 'public': {
				if (this.broker.reservedPorts().has(port) && ownAddress(classification.judged)) {
					return { reason: 'private-address', message: `Blocked by Volt sandbox: port ${port} on this machine is Volt's own.` };
				}
				const request: IAccessRequest = { capability: 'net.connect', target: classification.judged, port, surface: 'broker' };
				const decision = this.decide(request);
				if (!decision.allow) {
					return { reason: decision.code === 'port' ? 'port' : 'not-allowed', message: `Blocked by Volt sandbox: ${address} is not allowed (an address needs an address rule).`, decision };
				}
				requests.push(request);
				return undefined;
			}
		}
	}

	private rollDay(): void {
		const now = this.broker.now();
		if (now - this.dayStarted >= DAY_MS) {
			this.dayStarted = now;
			this.bytesToday = 0;
		}
	}

	// --- denials and prompts -----------------------------------------------------------------

	private deny(method: 'CONNECT' | 'HTTP', destination: string, port: number, verdict: Extract<Verdict, { ok: false }>, tokenOf?: SubjectKey): INetworkDenial {
		const now = this.broker.now();
		// Coalesced per principal over 2 s: the same refusal again is the same denial.
		for (const record of this.denials.values()) {
			if (now - record.at < COALESCE_MS && record.denial.destination === destination && record.denial.port === port && record.denial.reason === verdict.reason) {
				this.broker.audit({ ts: now, principal: this.principal.id, subject: this.subject, chain: this.chain(), method, destination, port, decision: 'deny', reason: verdict.reason, epoch: verdict.epoch, denialId: record.denial.denialId });
				return record.denial;
			}
		}
		const approvable = (verdict.reason === 'not-allowed' || verdict.reason === 'port') && !!verdict.target;
		const denial: INetworkDenial = {
			denialId: randomBytes(12).toString('base64url'),
			principal: this.principal.id,
			subject: this.subject,
			epoch: verdict.epoch,
			destination,
			port,
			reason: verdict.reason,
			message: verdict.message,
			promptable: approvable && this.takePrompt(now),
		};
		if (approvable) {
			this.denials.set(denial.denialId, { denial, at: now, target: verdict.target! });
			while (this.denials.size > MAX_DENIAL_RECORDS) {
				this.denials.delete(this.denials.keys().next().value!);
			}
		}
		this.broker.audit({ ts: now, principal: this.principal.id, subject: this.subject, chain: this.chain(), method, destination, port, decision: 'deny', reason: verdict.reason, epoch: verdict.epoch, denialId: denial.denialId, ...(tokenOf ? { tokenOf } : {}) });
		try {
			this.options.onDenial?.(denial);
		} catch {
			// The listener is the transcript; a failure there must not break the request.
		}
		return denial;
	}

	/** G.12: one prompt per minute and three per day, coalesced over 2 s; none after two refusals. */
	private takePrompt(now: number): boolean {
		if (this.refusals >= this.limits.refusalsToAutoDeny) {
			return false;
		}
		if (now - this.lastPromptAt < COALESCE_MS) {
			return true;
		}
		this.prompts = this.prompts.filter(at => now - at < DAY_MS);
		if (this.prompts.length >= this.limits.promptsPerDay || this.prompts.filter(at => now - at < 60_000).length >= this.limits.promptsPerMinute) {
			return false;
		}
		this.prompts.push(now);
		this.lastPromptAt = now;
		return true;
	}

	private chain(): readonly SubjectKey[] {
		return this.context().onBehalfOf.map(principal => principal.subject);
	}

	// --- protocol ----------------------------------------------------------------------------

	/** Whether the request carries this route's token; on a mismatch, whose token it was (B-31). */
	private authorize(req: http.IncomingMessage): { readonly ok: true } | { readonly ok: false; readonly tokenOf?: SubjectKey } {
		const given = Buffer.from(String(req.headers['proxy-authorization'] ?? ''));
		if (given.length === this.expectedAuth.length && timingSafeEqual(given, this.expectedAuth)) {
			return { ok: true };
		}
		const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(given.toString('latin1').trim());
		const password = basic ? Buffer.from(basic[1], 'base64').toString('utf8').replace(/^[^:]*:/, '') : '';
		const owner = password ? this.broker.tokenOwner(password, this) : undefined;
		return owner ? { ok: false, tokenOf: owner.subject } : { ok: false };
	}

	private refuseAuth(method: 'CONNECT' | 'HTTP', destination: string, port: number, tokenOf: SubjectKey | undefined): void {
		this.deny(method, destination, port, { ok: false, reason: 'auth', message: 'Volt sandbox proxy: this proxy serves only the sandboxed run it was started for.', epoch: this.broker.epoch }, tokenOf);
	}

	private async tunnel(req: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
		client.on('error', () => undefined);
		const raw = req.url ?? '';
		// Authority form only, port required: `host:port` or `[v6]:port`. Nothing else is a CONNECT target.
		const authority = /^(\[[0-9A-Fa-f:.]+\]|[^\s:/?#@[\]\\]+):(\d{1,5})$/.exec(raw);
		const { host, port } = authority ? splitAuthority(raw, 443) : { host: raw, port: NaN };
		const auth = this.authorize(req);
		if (!auth.ok) {
			this.refuseAuth('CONNECT', host, port, auth.tokenOf);
			client.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="volt-sandbox"\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nVolt sandbox proxy: this proxy serves only the sandboxed run it was started for.\r\n`);
			return;
		}
		const verdict: Verdict = authority ? await this.destination(host, port) : { ok: false, reason: 'transport', message: 'Blocked by Volt sandbox: CONNECT needs host:port.', epoch: this.broker.epoch };
		if (!verdict.ok) {
			this.deny('CONNECT', host, port, verdict);
			client.end(`HTTP/1.1 ${verdict.reason === 'transport' ? '400 Bad Request' : verdict.reason === 'rate-limit' ? '429 Too Many Requests' : '403 Forbidden'}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${verdict.message}\r\n`);
			return;
		}
		if (client.destroyed) {
			return;
		}
		const upstream = this.broker.open(verdict.address, port);
		const connection = this.track(client, upstream, 'CONNECT', host, port, verdict);
		upstream.once('connect', () => {
			client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			// Bytes the client sent after the CONNECT headers are tunnel payload for the checked address, never another request.
			if (head.length) {
				connection.bytes += head.length;
				this.count(head.length);
				upstream.write(head);
			}
			upstream.pipe(client);
			client.pipe(upstream);
		});
		upstream.on('error', () => {
			if (!client.destroyed) {
				client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
			}
		});
	}

	private async forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		let url: URL | undefined;
		try {
			url = new URL(req.url ?? '');
		} catch {
			url = undefined;
		}
		const port = url ? (url.port ? Number(url.port) : 80) : NaN;
		const destination = url?.hostname ?? '';
		const auth = this.authorize(req);
		if (!auth.ok) {
			this.refuseAuth('HTTP', destination, port, auth.tokenOf);
			res.writeHead(407, { 'Content-Type': 'text/plain', 'Proxy-Authenticate': 'Basic realm="volt-sandbox"', 'Connection': 'close' }).end('Volt sandbox proxy: this proxy serves only the sandboxed run it was started for.\n');
			return;
		}
		const bad = (message: string) => {
			this.deny('HTTP', destination, port, { ok: false, reason: 'transport', message, epoch: this.broker.epoch });
			res.writeHead(400, { 'Content-Type': 'text/plain', 'Connection': 'close' }).end(`${message}\n`);
		};
		if (!url) {
			return bad('Volt sandbox proxy: absolute URL expected');
		}
		if (url.protocol !== 'http:' || url.username || url.password) {
			return bad(`Blocked by Volt sandbox: unsupported request for ${url.hostname} (plain http:// only; https goes through CONNECT).`);
		}
		// The request line decides where it goes; a Host header naming somewhere else is a smuggling attempt.
		const hostHeader = req.headers.host;
		if (hostHeader !== undefined && !sameAuthority(hostHeader, url)) {
			return bad(`Blocked by Volt sandbox: the Host header (${hostHeader}) does not match the request's ${url.host}.`);
		}
		if (req.headers['transfer-encoding'] !== undefined && req.headers['content-length'] !== undefined) {
			return bad('Blocked by Volt sandbox: Content-Length and Transfer-Encoding together.');
		}
		const verdict = await this.destination(url.hostname, port);
		if (!verdict.ok) {
			this.deny('HTTP', url.hostname, port, verdict);
			res.writeHead(verdict.reason === 'transport' ? 400 : verdict.reason === 'rate-limit' ? 429 : 403, { 'Content-Type': 'text/plain', 'Connection': 'close' }).end(`${verdict.message}\n`);
			return;
		}
		const headers = { ...req.headers };
		delete headers['proxy-authorization'];
		delete headers['proxy-connection'];
		let connection: IOpenConnection | undefined;
		const upstream = http.request({
			method: req.method,
			path: `${url.pathname}${url.search}`,
			headers: { ...headers, host: url.host },
			// The checked address, never a second lookup; one connection per request (no agent pool across rules).
			createConnection: () => {
				const socket = this.broker.open(verdict.address, port);
				connection = this.track(req.socket, socket, 'HTTP', url!.hostname, port, verdict);
				return socket;
			},
		}, reply => {
			// Redirects are the client's to follow: a 3xx goes back as is, and its next request is checked again.
			res.writeHead(reply.statusCode ?? 502, reply.headers);
			reply.pipe(res);
		});
		upstream.setTimeout(this.broker.options.tunnelIdleMs ?? BROKER_TUNNEL_IDLE_MS, () => upstream.destroy(new Error('idle')));
		upstream.on('error', () => {
			if (!res.headersSent) {
				res.writeHead(502, { 'Connection': 'close' }).end();
			} else {
				res.destroy();
			}
		});
		res.once('close', () => {
			if (connection) {
				this.close(connection, 'done');
			}
		});
		// The request body is what leaves: it counts against the day's budget as a download does.
		req.on('data', (data: Buffer) => {
			if (connection) {
				connection.bytes += data.length;
			}
			this.count(data.length);
		});
		req.pipe(upstream);
	}

	private track(client: net.Socket, upstream: net.Socket, method: 'CONNECT' | 'HTTP', destination: string, port: number, verdict: Extract<Verdict, { ok: true }>): IOpenConnection {
		const connection: IOpenConnection = { client, upstream, method, destination, port, address: verdict.address.address, requests: verdict.requests, bytes: 0, closed: false };
		this.connections.add(connection);
		this.broker.audit({ ts: this.broker.now(), principal: this.principal.id, subject: this.subject, chain: this.chain(), method, destination, port, address: verdict.address.address, decision: 'allow', epoch: verdict.epoch });
		const onData = (data: Buffer) => {
			connection.bytes += data.length;
			this.count(data.length);
		};
		upstream.on('error', () => undefined);
		upstream.on('data', onData);
		if (method === 'CONNECT') {
			client.on('data', onData);
			// A tunnel nobody uses is closed: slow or abandoned tunnels must not pile up.
			const idle = this.broker.options.tunnelIdleMs ?? BROKER_TUNNEL_IDLE_MS;
			for (const socket of [client, upstream]) {
				socket.setTimeout(idle, () => this.close(connection, 'idle'));
			}
			client.once('close', () => this.close(connection, 'done', true));
		}
		upstream.once('close', () => this.close(connection, 'done', true));
		return connection;
	}

	private count(bytes: number): void {
		this.bytesToday += bytes;
		if (this.limits.bytesPerDay !== undefined && this.bytesToday > this.limits.bytesPerDay) {
			for (const connection of [...this.connections]) {
				this.close(connection, 'budget');
			}
		}
	}

	/**
	 * `graceful`: one side finished on its own, and the client still gets what is in flight (the
	 * tail of a download) before its end; a client that stops reading is cut at the idle timeout.
	 * Otherwise (revoked, idle, budget, the route closing) both sides are cut at once.
	 */
	private close(connection: IOpenConnection, reason: 'revoked' | 'idle' | 'budget' | 'done', graceful = false): void {
		if (connection.closed) {
			return;
		}
		connection.closed = true;
		this.connections.delete(connection);
		connection.upstream.destroy();
		if (graceful && connection.method === 'CONNECT') {
			const client = connection.client;
			client.end();
			client.setTimeout(this.broker.options.tunnelIdleMs ?? BROKER_TUNNEL_IDLE_MS, () => client.destroy());
		} else if (connection.method === 'CONNECT' || reason !== 'done') {
			connection.client.destroy();
		}
		this.broker.audit({ ts: this.broker.now(), principal: this.principal.id, subject: this.subject, chain: this.chain(), method: connection.method, destination: connection.destination, port: connection.port, address: connection.address, decision: 'close', reason, epoch: this.broker.epoch, bytes: connection.bytes });
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const connection of [...this.connections]) {
			this.close(connection, 'done');
		}
		for (const socket of this.clients) {
			socket.destroy();
		}
		this.clients.clear();
		this.server.close();
		this.broker.routeClosed(this, this.denials);
		this.denials.clear();
		// Its session grants end with it: no other principal can use them, and they must not pile up.
		const own = this.ownGrants().map(grant => grant.id);
		if (own.length) {
			void this.broker.update({ revoke: own }).catch(() => undefined);
		}
	}
}

/** Entries as rule text: trimmed, lower case, deduplicated; empty ones dropped. */
function normalizeEntries(entries: readonly string[]): readonly string[] {
	return [...new Set(entries.map(entry => entry.trim().toLowerCase()).filter(Boolean))];
}

/** Whether a Host header names the same host and port as the request's absolute URL. */
function sameAuthority(header: string, url: URL): boolean {
	const { host, port } = splitAuthority(header.trim(), 80);
	const a = normalizeNetworkHost(host);
	const b = normalizeNetworkHost(url.hostname);
	return typeof a === 'object' && typeof b === 'object' && a.host === b.host && port === (url.port ? Number(url.port) : 80);
}

function defaultLookup(host: string): Promise<IResolvedAddress[]> {
	return new Promise((resolve, reject) => dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
		if (err) {
			reject(err);
		} else {
			resolve(addresses.map(a => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
		}
	}));
}

// --- the audit log -------------------------------------------------------------------------------

export const DEFAULT_NETWORK_AUDIT_FILE = join(homedir(), '.volt', 'trust', 'audit', 'network.log');

/**
 * The broker's audit log on the execution host (I.1 row 6): one JSON object per line, 0600, under
 * `~/.volt/trust` (denied to every sandbox), rotated by size. Lines are batched per tick.
 */
export class NetworkAuditLog {

	private pending: string[] = [];
	private scheduled = false;
	private queue: Promise<void> = Promise.resolve();
	private size = -1;

	constructor(readonly file = DEFAULT_NETWORK_AUDIT_FILE, private readonly maxBytes = 5 * 1024 * 1024, private readonly keep = 3) { }

	readonly append = (event: INetworkAuditEvent): void => {
		this.pending.push(JSON.stringify(event));
		if (!this.scheduled) {
			this.scheduled = true;
			this.queue = this.queue.then(() => new Promise<void>(resolve => setTimeout(resolve, 0))).then(() => {
				this.scheduled = false;
				return this.write();
			});
		}
	};

	/** Resolves once every line appended so far is written. */
	flush(): Promise<void> {
		return this.queue;
	}

	private async write(): Promise<void> {
		const lines = this.pending.splice(0);
		if (!lines.length) {
			return;
		}
		const text = lines.join('\n') + '\n';
		try {
			if (this.size < 0) {
				await fs.mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
				this.size = (await fs.stat(this.file).catch(() => undefined))?.size ?? 0;
			}
			if (this.size + text.length > this.maxBytes) {
				await fs.unlink(`${this.file}.${this.keep}`).catch(() => undefined);
				for (let i = this.keep - 1; i >= 1; i--) {
					await fs.rename(`${this.file}.${i}`, `${this.file}.${i + 1}`).catch(() => undefined);
				}
				await fs.rename(this.file, `${this.file}.1`).catch(() => undefined);
				this.size = 0;
			}
			await fs.appendFile(this.file, text, { mode: 0o600 });
			this.size += Buffer.byteLength(text);
		} catch {
			// An unwritable audit log must not take the network down; the decision log still records decisions.
		}
	}
}
