/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ICallContext, IPrincipal, IUserGestureToken, MAX_CALL_CHAIN, PrincipalKind, SubjectKey } from '../common/principals.js';

/**
 * The Principal Registry (spec C.5, F.1, INV-01, INV-13): mints principals, binds each to the one
 * channel the supervisor created for it, builds the on-behalf-of chain when core routes a call, and
 * revokes. Identity is the channel: nothing a workload sends (an id, a subject, a chain) is read.
 *
 * Call contexts are minted here only. `verify` accepts a context only if this registry built it and
 * every principal on it is still live, so a context copied, extended or replayed from a payload is
 * refused.
 */

export interface IMintOptions {
	readonly subject: SubjectKey;
	readonly kind: PrincipalKind;
	readonly launchPolicyHash: string;
	readonly packageDigest?: string;
	readonly signer?: string;
	/** The principal id it was started for. */
	readonly parent?: string;
}

export class PrincipalRegistry extends Disposable {

	private readonly principals = new Map<string, IPrincipal>();
	private readonly channels = new Map<string, string>();
	private readonly channelOf = new Map<string, string>();
	private readonly revoked = new Set<string>();
	/** Channels whose principal was revoked: never bound again. */
	private readonly closedChannels = new Set<string>();
	/** Contexts this registry built; anything else is a payload's claim. */
	private readonly minted = new WeakSet<ICallContext>();
	private readonly _onDidRevoke = this._register(new Emitter<IPrincipal>());
	readonly onDidRevoke = this._onDidRevoke.event;

	constructor(
		private readonly executionHost: string,
		private readonly now: () => number = Date.now,
	) {
		super();
	}

	mint(options: IMintOptions): IPrincipal {
		if (options.subject === 'user') {
			throw new Error('the user subject is never minted for a sandbox');
		}
		if (options.parent !== undefined && !this.isLive(options.parent)) {
			throw new Error(`parent principal ${options.parent} is not live`);
		}
		const principal: IPrincipal = Object.freeze({
			id: randomBytes(16).toString('base64url'),
			subject: options.subject,
			kind: options.kind,
			executionHost: this.executionHost,
			launchPolicyHash: options.launchPolicyHash,
			createdAt: this.now(),
			...(options.packageDigest ? { packageDigest: options.packageDigest } : {}),
			...(options.signer ? { signer: options.signer } : {}),
			...(options.parent ? { parent: options.parent } : {}),
		});
		this.principals.set(principal.id, principal);
		return principal;
	}

	/** Binds `principal` to the channel the supervisor created for it. A channel belongs to one principal for its life. */
	bind(channelId: string, principal: IPrincipal): void {
		if (this.principals.get(principal.id) !== principal || !this.isLive(principal.id)) {
			throw new Error(`principal ${principal.id} was not minted here or is revoked`);
		}
		if (this.channels.has(channelId) || this.revokedChannel(channelId)) {
			throw new Error(`channel ${channelId} already belongs to a principal`);
		}
		if (this.channelOf.has(principal.id)) {
			throw new Error(`principal ${principal.id} is already bound to a channel`);
		}
		this.channels.set(channelId, principal.id);
		this.channelOf.set(principal.id, channelId);
	}

	/** Who is on `channelId`; undefined for an unknown, closed or revoked channel (INV-13). */
	principalOf(channelId: string): IPrincipal | undefined {
		const id = this.channels.get(channelId);
		return id !== undefined && this.isLive(id) ? this.principals.get(id) : undefined;
	}

	isLive(principalId: string): boolean {
		return this.principals.has(principalId) && !this.revoked.has(principalId);
	}

	/** Closing a channel revokes its principal. */
	closeChannel(channelId: string): void {
		const id = this.channels.get(channelId);
		if (id !== undefined) {
			this.revoke(id);
		}
	}

	/** Revokes `principalId` and every principal started for it. */
	revoke(principalId: string): void {
		const principal = this.principals.get(principalId);
		if (!principal || this.revoked.has(principalId)) {
			return;
		}
		this.revoked.add(principalId);
		const channel = this.channelOf.get(principalId);
		if (channel !== undefined) {
			this.channels.delete(channel);
			this.channelOf.delete(principalId);
			this.closedChannels.add(channel);
		}
		this._onDidRevoke.fire(principal);
		for (const child of [...this.principals.values()].filter(candidate => candidate.parent === principalId)) {
			this.revoke(child.id);
		}
	}

	private revokedChannel(channelId: string): boolean {
		return this.closedChannels.has(channelId);
	}

	/**
	 * The context of a request that arrived on `channelId`: the principal on that channel and no
	 * chain. Whatever the request's payload claims about who sent it is not an argument here.
	 */
	contextFor(channelId: string, requestId: string, gesture?: IUserGestureToken): ICallContext | undefined {
		const principal = this.principalOf(channelId);
		if (!principal) {
			return undefined;
		}
		return this.remember({ principal, onBehalfOf: [], requestId, ...(gesture ? { gesture } : {}) });
	}

	/**
	 * Core routes a call from `caller` (a context this registry built) to the principal on
	 * `calleeChannelId`: the callee runs on behalf of the caller's chain plus the caller.
	 */
	route(caller: ICallContext, calleeChannelId: string, requestId: string): ICallContext | undefined {
		if (!this.verify(caller)) {
			return undefined;
		}
		const callee = this.principalOf(calleeChannelId);
		if (!callee || caller.onBehalfOf.length + 2 > MAX_CALL_CHAIN) {
			return undefined;
		}
		return this.remember({ principal: callee, onBehalfOf: Object.freeze([...caller.onBehalfOf, caller.principal]), requestId });
	}

	/** Whether `context` was built here and every principal on it is still live. */
	verify(context: ICallContext): boolean {
		return this.minted.has(context) && [...context.onBehalfOf, context.principal].every(principal => this.principals.get(principal.id) === principal && this.isLive(principal.id));
	}

	private remember(context: ICallContext): ICallContext {
		const frozen = Object.freeze(context);
		this.minted.add(frozen);
		return frozen;
	}
}
