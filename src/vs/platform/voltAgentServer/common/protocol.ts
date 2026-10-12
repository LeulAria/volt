/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wire protocol between the Volt agent server and its clients (the desktop agent window, the web app,
 * tests). JSON text frames over one WebSocket at `/ws`.
 *
 * Ordering: the server numbers every event it publishes with `seq`, contiguous within one server
 * boot (`epoch`). A client that sees a hole reconnects and resumes from the last `seq` it applied;
 * the server replays the gap from its ring buffer or answers `resumed: false`, and the client reloads
 * snapshots. A new epoch (the server restarted) always means a reload: durable state lives in the
 * history and orchestrator files, not in the event log.
 */

export const AGENT_SERVER_PROTOCOL_VERSION = 1;

/** WebSocket close codes the server uses. */
export const enum AgentServerCloseCode {
	/** The first frame was not a valid `hello`. */
	BadHello = 4400,
	/** Missing or wrong token. */
	Unauthorized = 4401,
	/** The client speaks another protocol version. */
	ProtocolMismatch = 4426,
	/** The client could not keep up (send buffer over budget); it should resume. */
	Overflow = 4429,
	/** The server is shutting down. */
	ShuttingDown = 4503,
}

export type AgentServerClientKind = 'desktop' | 'web' | 'mobile' | 'test';

/** Things only a client can do; the server asks a connected client that advertised them. */
export type AgentServerCapability = 'browser' | 'codeIntel' | 'surface';

export interface IAgentServerHello {
	readonly t: 'hello';
	readonly protocol: number;
	readonly token: string;
	readonly client: {
		readonly kind: AgentServerClientKind;
		readonly id: string;
		readonly capabilities?: readonly AgentServerCapability[];
		/** Topics the client wants (default: all except `runtime.event`). */
		readonly topics?: readonly AgentServerTopic[];
	};
	/** The last event the client applied, to replay what it missed. */
	readonly resume?: { readonly epoch: string; readonly seq: number };
}

export interface IAgentServerWelcome {
	readonly t: 'welcome';
	readonly epoch: string;
	/** The newest event `seq` when the server answered. With `resumed`, replayed events follow. */
	readonly seq: number;
	/** The gap was replayed (events follow). When false, `snapshot` holds the state as of `seq`. */
	readonly resumed: boolean;
	readonly snapshot?: IAgentServerSnapshot;
	readonly serverVersion: string;
	readonly pid: number;
}

export interface IAgentServerCall {
	readonly t: 'call';
	readonly id: number;
	/** `<service>.<member>`; the server only answers methods on its allowlist. */
	readonly method: string;
	readonly params?: readonly unknown[];
}

export interface IAgentServerReturn {
	readonly t: 'ret';
	readonly id: number;
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: IAgentServerError;
}

export interface IAgentServerError {
	readonly code: string;
	readonly message: string;
}

export interface IAgentServerEvent {
	readonly t: 'evt';
	readonly seq: number;
	/**
	 * The `seq` of the previous event sent to this client. Clients skip topics they didn't ask for,
	 * so their stream has holes in `seq`; `after` must equal the last event they applied or they
	 * missed one.
	 */
	readonly after?: number;
	readonly topic: AgentServerTopic;
	readonly data: unknown;
}

export type AgentServerClientFrame = IAgentServerHello | IAgentServerCall | IAgentServerReturn;
export type AgentServerServerFrame = IAgentServerWelcome | IAgentServerCall | IAgentServerReturn | IAgentServerEvent;

/**
 * - `col`: a replicated collection changed ({@link ICollectionDelta}).
 * - `session`: a chat's transcript changed ({@link ISessionPatch}) or one of its lifecycle changes.
 * - `runtime.event`: a raw runtime event envelope (opt-in; deltas are many).
 * - `hostTools`: a host tool was invoked (desktop attaches page state to the row).
 * - `server`: server notices (shutting down, version).
 */
export type AgentServerTopic = 'col' | 'session' | 'runtime.event' | 'hostTools' | 'server';

export const DEFAULT_TOPICS: readonly AgentServerTopic[] = ['col', 'session', 'hostTools', 'server'];

/** Put and delete entries of one replicated collection. */
export interface ICollectionDelta {
	readonly col: string;
	readonly put?: Record<string, unknown>;
	readonly del?: readonly string[];
}

/** The state a client loads when it can't resume. */
export interface IAgentServerSnapshot {
	/** Events after this `seq` follow the snapshot on the same socket. */
	readonly seq: number;
	readonly epoch: string;
	readonly collections: Record<string, Record<string, unknown>>;
}

export interface IAgentServerRuntimeInfo {
	readonly version: 1;
	readonly pid: number;
	readonly host: string;
	readonly port: number;
	readonly epoch: string;
	readonly serverVersion: string;
	readonly startedAt: number;
	/** The app root the server runs from (dev builds: the checkout). */
	readonly appRoot: string;
	/** The build's commit (packaged builds); undefined out of sources. */
	readonly commit?: string;
}

//#region Pairing (phones and browsers)

/** Public, unauthenticated: what a client checks before it pairs with or connects to a server. */
export const VOLT_ENVIRONMENT_PATH = '/.well-known/volt/environment';
/** `POST`: trade a one-time pairing code for a device token ({@link IVoltPairRequest}). */
export const VOLT_PAIR_PATH = '/api/auth/pair';
/** `POST`, loopback only: a token for the browser on the server's own machine. */
export const VOLT_LOCAL_SESSION_PATH = '/api/auth/local';

export interface IVoltEnvironmentDescriptor {
	/** Stable per profile: a client never sends its token to an address that answers with another id. */
	readonly environmentId: string;
	/** The machine's name ("Leul's MacBook Pro"). */
	readonly label: string;
	readonly platform: { readonly os: string; readonly arch: string };
	readonly serverVersion: string;
	readonly protocol: number;
	/** The server listens on the network, not only on loopback: phones can reach it. */
	readonly network: boolean;
	/** `workbench`: browsers can open Volt's workbench at `/code/` (older servers leave it out). */
	readonly capabilities: { readonly pairing: boolean; readonly workbench?: boolean };
}

export type VoltPairingClientKind = 'mobile' | 'tablet' | 'web';

export interface IVoltPairRequest {
	readonly code: string;
	readonly client: {
		readonly label: string;
		readonly kind: VoltPairingClientKind;
		readonly os?: string;
		readonly model?: string;
	};
}

export interface IVoltPairResponse {
	readonly token: string;
	readonly deviceId: string;
	readonly environmentId: string;
	readonly label: string;
	readonly role: 'owner' | 'device';
}

export type VoltRouteKind = 'loopback' | 'lan' | 'tailnet' | 'public';

export interface IVoltPairingCode {
	readonly code: string;
	readonly expiresAt: number;
	/** Pairing links for each address the server can be reached at, best first. */
	readonly urls: readonly { readonly kind: VoltRouteKind; readonly url: string }[];
	readonly network: boolean;
}

export interface IVoltPairedDevice {
	readonly id: string;
	readonly label: string;
	readonly kind: VoltPairingClientKind;
	readonly role: 'owner' | 'device';
	readonly os?: string;
	readonly model?: string;
	readonly createdAt: number;
	readonly lastSeenAt?: number;
	readonly connected: boolean;
	/** The device asking. */
	readonly current?: boolean;
}

//#endregion

/** Parses one frame; returns undefined for anything that isn't a well-formed frame object. */
export function parseFrame<T extends { t: string }>(text: string): T | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object' || typeof (value as { t?: unknown }).t !== 'string') {
		return undefined;
	}
	return value as T;
}

export function isValidHello(frame: { t: string } | undefined): frame is IAgentServerHello {
	if (!frame || frame.t !== 'hello') {
		return false;
	}
	const hello = frame as Partial<IAgentServerHello>;
	return typeof hello.protocol === 'number'
		&& typeof hello.token === 'string'
		&& !!hello.client && typeof hello.client.id === 'string' && typeof hello.client.kind === 'string'
		&& (hello.resume === undefined || (typeof hello.resume.epoch === 'string' && Number.isInteger(hello.resume.seq)));
}

export function toAgentServerError(err: unknown): IAgentServerError {
	if (err && typeof err === 'object') {
		const e = err as { code?: unknown; message?: unknown; name?: unknown };
		return {
			code: typeof e.code === 'string' ? e.code : typeof e.name === 'string' ? e.name : 'Error',
			message: typeof e.message === 'string' ? e.message : String(err),
		};
	}
	return { code: 'Error', message: String(err) };
}

export class AgentServerRemoteError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'AgentServerRemoteError';
	}
}
