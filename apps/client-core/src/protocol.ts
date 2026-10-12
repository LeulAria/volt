/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The agent server's wire protocol, mirrored from src/vs/platform/voltAgentServer/common/protocol.ts
// (this package cannot import src/vs). JSON text frames over one WebSocket at `/ws`.

export const AGENT_SERVER_PROTOCOL_VERSION = 1;

export const CloseCode = {
	BadHello: 4400,
	Unauthorized: 4401,
	ProtocolMismatch: 4426,
	Overflow: 4429,
	ShuttingDown: 4503,
} as const;

export type ClientKind = 'desktop' | 'web' | 'mobile' | 'test';
export type Topic = 'col' | 'session' | 'runtime.event' | 'hostTools' | 'server';

/** What a remote client follows: replicated state, transcripts and notices. */
export const CLIENT_TOPICS: readonly Topic[] = ['col', 'session', 'server'];

export interface IHello {
	readonly t: 'hello';
	readonly protocol: number;
	readonly token: string;
	readonly client: {
		readonly kind: ClientKind;
		readonly id: string;
		readonly topics?: readonly Topic[];
	};
	readonly resume?: { readonly epoch: string; readonly seq: number };
}

export interface ISnapshot {
	readonly seq: number;
	readonly epoch: string;
	readonly collections: Record<string, Record<string, unknown>>;
}

export interface IWelcome {
	readonly t: 'welcome';
	readonly epoch: string;
	readonly seq: number;
	readonly resumed: boolean;
	readonly snapshot?: ISnapshot;
	readonly serverVersion: string;
	readonly pid: number;
}

export interface ICall {
	readonly t: 'call';
	readonly id: number;
	readonly method: string;
	readonly params?: readonly unknown[];
}

export interface IRemoteError {
	readonly code: string;
	readonly message: string;
}

export interface IReturn {
	readonly t: 'ret';
	readonly id: number;
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: IRemoteError;
}

export interface IEvent {
	readonly t: 'evt';
	readonly seq: number;
	readonly after?: number;
	readonly topic: Topic;
	readonly data: unknown;
}

export type ServerFrame = IWelcome | ICall | IReturn | IEvent;

export interface ICollectionDelta {
	readonly col: string;
	readonly put?: Record<string, unknown>;
	readonly del?: readonly string[];
}

export interface ISessionPatch {
	readonly id: string;
	readonly rev: number;
	readonly len: number;
	readonly set: readonly { readonly i: number; readonly message: unknown }[];
	readonly contextUsed?: number;
	readonly contextWindow?: number;
}

export type SessionTopicData =
	| ({ readonly type: 'patch' } & ISessionPatch)
	| { readonly type: 'change'; readonly id: string; readonly change: { readonly kind: string; readonly turnId?: string; readonly aborted?: boolean; readonly failed?: boolean } }
	| { readonly type: 'idle'; readonly id: string };

export interface ISessionState {
	readonly id: string;
	readonly rev: number;
	readonly messages: readonly unknown[];
	readonly contextUsed?: number;
	readonly contextWindow?: number;
	readonly running: boolean;
}

//#region Pairing

export const VOLT_ENVIRONMENT_PATH = '/.well-known/volt/environment';
export const VOLT_PAIR_PATH = '/api/auth/pair';
export const VOLT_LOCAL_SESSION_PATH = '/api/auth/local';

export interface IEnvironmentDescriptor {
	readonly environmentId: string;
	readonly label: string;
	readonly platform: { readonly os: string; readonly arch: string };
	readonly serverVersion: string;
	readonly protocol: number;
	readonly network: boolean;
	/** `workbench`: browsers can open Volt's workbench at `/code/` (older servers leave it out). */
	readonly capabilities: { readonly pairing: boolean; readonly workbench?: boolean };
}

export type PairingClientKind = 'mobile' | 'tablet' | 'web';

export interface IPairRequest {
	readonly code: string;
	readonly client: { readonly label: string; readonly kind: PairingClientKind; readonly os?: string; readonly model?: string };
}

export type Role = 'owner' | 'device';

export interface IPairResponse {
	readonly token: string;
	readonly deviceId: string;
	readonly environmentId: string;
	readonly label: string;
	readonly role: Role;
}

export type RouteKind = 'loopback' | 'lan' | 'tailnet' | 'public';

export interface IPairingCode {
	readonly code: string;
	readonly expiresAt: number;
	readonly urls: readonly { readonly kind: RouteKind; readonly url: string }[];
	readonly network: boolean;
}

export interface IPairedDevice {
	readonly id: string;
	readonly label: string;
	readonly kind: PairingClientKind;
	readonly role: Role;
	readonly os?: string;
	readonly model?: string;
	readonly createdAt: number;
	readonly lastSeenAt?: number;
	readonly connected: boolean;
	readonly current?: boolean;
}

//#endregion

export function parseFrame(text: unknown): ServerFrame | undefined {
	if (typeof text !== 'string') {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object' || typeof (value as { t?: unknown }).t !== 'string') {
		return undefined;
	}
	return value as ServerFrame;
}

export class RemoteError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'RemoteError';
	}
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return typeof err === 'string' ? err : 'Something went wrong.';
}
