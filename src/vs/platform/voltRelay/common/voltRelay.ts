/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltRelayService = createDecorator<IVoltRelayService>('voltRelayService');
export const VOLT_RELAY_CHANNEL_NAME = 'voltRelay';

/** Port the direct local webhook URL listens on when it is free (else a random one). */
export const VOLT_LOCAL_WEBHOOK_PORT = 47615;

export type VoltRelayStatus = 'off' | 'connecting' | 'online' | 'offline';

export interface IVoltRelayState {
	readonly status: VoltRelayStatus;
	/** The relay's public origin, e.g. `https://relay.example.com`. */
	readonly url?: string;
	readonly relayId?: string;
	readonly relayName?: string;
	/** This Volt's device id on the relay (also its machine id there). */
	readonly deviceId?: string;
	readonly deviceName?: string;
	/** Why it is offline ("connection refused", "token revoked"). */
	readonly error?: string;
	readonly connectedAt?: number;
	/** `http://127.0.0.1:<port>`: the direct local webhook base, while Volt runs. */
	readonly localWebhookBase?: string;
}

/** An event from the relay's stream (see apps/relay/src/server.mjs). `resync`: re-read every list. */
export interface IVoltRelayEvent {
	readonly seq: number;
	readonly at: number;
	readonly type: string;
	readonly id?: string;
	readonly data?: unknown;
}

export type VoltRelaySignatureKind = 'none' | 'github' | 'slack' | 'sentry' | 'linear' | 'pagerduty' | 'teams' | 'generic';

/** HMAC settings of a hook; same shape the relay stores. */
export interface IVoltRelaySignature {
	readonly kind: VoltRelaySignatureKind;
	readonly secret?: string;
	readonly header?: string;
	readonly prefix?: string;
	readonly encoding?: 'hex' | 'base64';
	readonly timestampHeader?: string;
	readonly toleranceSec?: number;
}

/** A hook the direct local URL answers: `http://127.0.0.1:<port>/h/<token>`. */
export interface IVoltLocalHook {
	readonly hookId: string;
	readonly token: string;
	readonly signature: IVoltRelaySignature;
}

/** A webhook delivery handed to a window to run: claimed from the relay, or received locally. */
export interface IVoltHeldDelivery {
	readonly id: string;
	readonly source: 'relay' | 'local';
	readonly hookId: string;
	readonly receivedAt: number;
	readonly event?: string;
	readonly externalId?: string;
	readonly redeliveryOf?: string;
	readonly signature?: 'verified' | 'none' | 'failed';
	readonly attempts?: number;
	readonly body: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly query: Readonly<Record<string, string>>;
}

export interface IVoltDeliveryOutcome {
	readonly status: 'ran' | 'filtered' | 'failed';
	readonly threadId?: string;
	readonly error?: string;
	readonly note?: string;
}

export type VoltCloudAgent = 'claude' | 'codex';

/** How a cloud task gets the code: a git URL the runner clones, or a bundle uploaded through the relay. */
export type VoltCloudSourceMode = 'auto' | 'bundle' | 'remote';

export interface IVoltCloudTaskInput {
	readonly repoRoot: string;
	readonly prompt: string;
	readonly title?: string;
	readonly agent: VoltCloudAgent;
	readonly model?: string;
	/** A runner's machine id; absent: any runner. */
	readonly machineId?: string;
	/** Picked by Auto (shown in the task, and lets the relay hand it on sooner). */
	readonly autoPicked?: boolean;
	readonly fallbackAfterSec?: number;
	/** Push the result branch to the task's remote (when the runner may push). */
	readonly push?: boolean;
	readonly chatId?: string;
	readonly sourceMode?: VoltCloudSourceMode;
}

/** What `createCloudTask` sent along, for the task's detail view. */
export interface IVoltCloudSourceSummary {
	readonly mode: 'bundle' | 'remote';
	readonly baseCommit: string;
	readonly baseBranch?: string;
	readonly repoUrl?: string;
	/** Uncommitted changes went along as a patch. */
	readonly dirty: boolean;
	readonly bundleBytes?: number;
}

export interface IVoltAppliedCloudResult {
	/** `refs/volt-cloud/<task id>` in the local repository. */
	readonly ref: string;
	readonly commit: string;
	/** The branch the runner made. */
	readonly branch: string;
}

/**
 * Volt's link to a self-hosted Volt Relay (apps/relay). The main process holds the connection,
 * because the renderer is sandboxed and must not hold the device token: one outbound event
 * stream, heartbeats with this machine's load, the held-webhook queue the windows drain, the
 * direct local webhook server, and the git work around cloud tasks (bundles, patches, results).
 */
export interface IVoltRelayService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<IVoltRelayState>;
	readonly onDidEvent: Event<IVoltRelayEvent>;
	getState(): Promise<IVoltRelayState>;
	/** Pairs with a link like `https://relay.example.com/#pair=ABCD-EFGH` (or the URL plus a code). */
	connect(link: string, deviceName?: string): Promise<IVoltRelayState>;
	disconnect(): Promise<void>;
	/** An authenticated JSON call: `request('GET', '/machines')`. Throws the relay's error text. */
	request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
	/** The hooks the local URL answers (the full list; replaces the last one). */
	setLocalHooks(hooks: readonly IVoltLocalHook[]): Promise<void>;
	/**
	 * The next webhook delivery to run, oldest first, claimed for this caller only; waits up to
	 * `waitMs` for one. Answer with {@link ackDelivery}; an unanswered relay claim returns to
	 * held when its lease runs out (at-least-once).
	 */
	nextDelivery(waitMs: number): Promise<IVoltHeldDelivery | undefined>;
	ackDelivery(id: string, source: 'relay' | 'local', outcome: IVoltDeliveryOutcome): Promise<void>;
	/** Packs the code (bundle or git URL, plus uncommitted changes) and queues the task. */
	createCloudTask(input: IVoltCloudTaskInput): Promise<{ readonly task: unknown; readonly source: IVoltCloudSourceSummary }>;
	/** Fetches a finished task's result bundle into `repoRoot` as `refs/volt-cloud/<id>`. */
	fetchCloudResult(taskId: string, repoRoot: string): Promise<IVoltAppliedCloudResult>;
	/** A blob as text (a result patch), cut at `maxBytes`. */
	readBlobText(blobId: string, maxBytes: number): Promise<string>;
}
