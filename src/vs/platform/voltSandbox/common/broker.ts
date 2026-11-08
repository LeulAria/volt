/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IAccessRequest, IDecision, IPolicyAuthority } from './authority.js';
import { ICallContext, IPrincipal, SubjectKey } from './principals.js';

/**
 * The contract every broker follows (spec I.1):
 *
 *   1 authenticated caller: the `ICallContext` core built from the channel (`verify`), nothing else
 *   2 capability check: `authority.evaluate` on every call, no allow list of the broker's own
 *   3 attenuation: the chain is in the context, and `evaluate` applies it
 *   4 input validation: every method validates its own arguments (they are `unknown`)
 *   5 limits: per-principal rate, concurrency and byte budgets
 *   6 audit: `{ts, principal, chain, method, target (redacted), decision, epoch}`
 *   7 revocation: re-evaluated on `onDidChange`; long operations check the epoch between chunks
 *   8 adversarial tests: each broker has a suite named by the spec's ids
 */

export type BrokerErrorCode =
	/** No context this execution host built, or a principal that is no longer live (INV-01, INV-13). */
	| 'unauthenticated'
	/** The Authority (or the broker's floor) refused. */
	| 'denied'
	/** The arguments are not what the method takes. */
	| 'invalid'
	/** A per-principal budget is spent. */
	| 'limit'
	/** A handle or reference that is not the caller's, not this mode's, closed or revoked. */
	| 'handle'
	/** The operation failed (not a permission question). */
	| 'io';

export class BrokerError extends Error {
	constructor(
		readonly code: BrokerErrorCode,
		message: string,
		readonly decision?: IDecision,
	) {
		super(message);
		this.name = 'BrokerError';
	}
}

export interface IBroker {
	readonly id: string;
	/** Validates `args` itself: they come from the caller. */
	handle(context: ICallContext, method: string, args: unknown): Promise<unknown>;
}

/** What a broker needs of the Policy Authority: the decision function, its epoch and its changes. */
export type IBrokerAuthority = Pick<IPolicyAuthority, 'evaluate' | 'epoch' | 'onDidChange'>;

/** Who checks that a context came from the channel (the Principal Registry on the execution host). */
export interface IBrokerCallers {
	verify(context: ICallContext): boolean;
	/** Fires when a principal is revoked: its handles and references stop working. */
	readonly onDidRevoke?: Event<IPrincipal>;
}

/** One audit record (I.1 #6). The target is a salted hash; the full value stays out of the record. */
export interface IBrokerAuditEvent {
	readonly ts: number;
	readonly broker: string;
	readonly method: string;
	readonly principal: string;
	readonly subject: SubjectKey;
	readonly chain: readonly SubjectKey[];
	/** Salted hash of the target (a path, a repository, a secret's service, a terminal). */
	readonly target?: string;
	readonly decision: 'allow' | 'deny';
	readonly deniedBy?: string;
	readonly code?: BrokerErrorCode;
	readonly epoch: number;
}

export interface IBrokerAudit {
	record(event: Omit<IBrokerAuditEvent, 'target'> & { readonly target?: string }): void;
}

/** An audit sink that keeps records in memory (tests, and a host that has no log yet). */
export class MemoryBrokerAudit implements IBrokerAudit {
	readonly events: IBrokerAuditEvent[] = [];
	constructor(private readonly redact: (target: string) => string = target => target) { }
	record(event: Omit<IBrokerAuditEvent, 'target'> & { readonly target?: string }): void {
		this.events.push({ ...event, ...(event.target !== undefined ? { target: this.redact(event.target) } : {}) });
	}
}

/** Asks the Authority and turns a refusal into a typed error. */
export function brokerEvaluate(authority: IBrokerAuthority, request: IAccessRequest, context: ICallContext): IDecision {
	const decision = authority.evaluate({ surface: 'broker', ...request }, context);
	if (!decision.allow) {
		throw new BrokerError('denied', decision.reason, decision);
	}
	return decision;
}

/** The subjects on a context, outermost first (for audit). */
export function contextChain(context: ICallContext): SubjectKey[] {
	return context.onBehalfOf.map(principal => principal.subject);
}

/**
 * A rolling byte budget per principal over a window (`limit` bytes per `windowMs`): `take` refuses
 * the bytes that would pass it.
 */
export class ByteBudget {
	private readonly spent = new Map<string, { at: number; bytes: number }[]>();

	constructor(
		private readonly limit: number,
		private readonly windowMs: number,
		private readonly now: () => number,
	) { }

	take(principal: string, bytes: number): boolean {
		const at = this.now();
		const recent = (this.spent.get(principal) ?? []).filter(entry => at - entry.at < this.windowMs);
		const used = recent.reduce((sum, entry) => sum + entry.bytes, 0);
		if (used + bytes > this.limit) {
			this.spent.set(principal, recent);
			return false;
		}
		recent.push({ at, bytes });
		this.spent.set(principal, recent);
		return true;
	}

	forget(principal: string): void {
		this.spent.delete(principal);
	}
}
