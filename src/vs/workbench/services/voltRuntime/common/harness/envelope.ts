/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltMode } from '../modes.js';

/**
 * Request envelope. Everything that happens after `send()` is attributed to this object:
 * the event store, the access broker, the governor, and a forked session all need the same
 * identity. Without it a run is a pile of events with no owner.
 *
 * The envelope is data, not a handle. Creating one does not start work.
 */

export type EnvelopePermission =
	| 'read'
	| 'search'
	| 'edit'
	| 'shell'
	| 'web'
	| 'browser'
	| 'git'
	| 'mcp'
	| 'agents'
	| 'memory';

export interface IRequestEnvelope {
	readonly id: string;
	readonly sessionId: string;
	readonly conversationId: string;
	readonly workspaceId?: string;
	readonly mode: VoltMode;
	readonly accessMode?: string;
	readonly permissions: readonly EnvelopePermission[];
	readonly parentRunId?: string;
	readonly forkedFrom?: string;
	readonly createdAt: number;
}

export interface IEnvelopeInput {
	readonly id: string;
	readonly sessionId: string;
	readonly conversationId: string;
	readonly mode: VoltMode;
	readonly workspaceId?: string;
	readonly accessMode?: string;
	readonly permissions?: readonly EnvelopePermission[];
	readonly parentRunId?: string;
	readonly forkedFrom?: string;
	readonly now?: number;
}

const DEFAULT_PERMISSIONS: readonly EnvelopePermission[] = ['read', 'search'];

export function createEnvelope(input: IEnvelopeInput): IRequestEnvelope {
	return {
		id: input.id,
		sessionId: input.sessionId,
		conversationId: input.conversationId,
		mode: input.mode,
		permissions: input.permissions?.length ? [...input.permissions] : [...DEFAULT_PERMISSIONS],
		createdAt: input.now ?? Date.now(),
		...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
		...(input.accessMode ? { accessMode: input.accessMode } : {}),
		...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
		...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}),
	};
}

/** A fork inherits identity except the run id, and records where it came from. */
export function forkEnvelope(source: IRequestEnvelope, nextId: string, now = Date.now()): IRequestEnvelope {
	return createEnvelope({
		id: nextId,
		sessionId: source.sessionId,
		conversationId: source.conversationId,
		mode: source.mode,
		permissions: source.permissions,
		now,
		...(source.workspaceId ? { workspaceId: source.workspaceId } : {}),
		...(source.accessMode ? { accessMode: source.accessMode } : {}),
		parentRunId: source.id,
		forkedFrom: source.id,
	});
}
