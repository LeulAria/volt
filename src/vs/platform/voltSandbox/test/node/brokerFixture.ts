/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IChatView, IManifestView, IPolicySnapshotInput, PolicyAuthority } from '../../common/authority.js';
import { BrokerError, BrokerErrorCode, MemoryBrokerAudit } from '../../common/broker.js';
import { IGrant } from '../../common/grants.js';
import { ICallContext, IPrincipal, PrincipalKind, SubjectKey } from '../../common/principals.js';
import { PrincipalRegistry } from '../../node/principalRegistry.js';

/** One execution host as the brokers' tests need it: a registry, an Authority and an audit sink. */

export const NOW = 1_800_000_000_000;

export function grant(subject: SubjectKey, capability: string, extra: Partial<IGrant> = {}): IGrant {
	return { id: `g:${subject}:${capability}:${extra.sessionId ?? ''}`, subject, capability, scope: {}, kind: 'persistent', source: 'user', grantedAt: NOW - 1000, lastUsedAt: NOW - 1000, epoch: 1, ...extra };
}

export class BrokerHost {

	readonly registry: PrincipalRegistry;
	readonly authority: PolicyAuthority;
	readonly audit = new MemoryBrokerAudit(target => `#${target.length}`);
	private input: IPolicySnapshotInput;
	private channels = 0;

	constructor(store: DisposableStore, input: { manifests?: IManifestView[]; chats?: IChatView[]; grants?: IGrant[]; home?: string }) {
		this.registry = store.add(new PrincipalRegistry('test-host', () => NOW));
		this.input = { epoch: 1, asOf: NOW, manifests: input.manifests ?? [], chats: input.chats ?? [], grants: input.grants ?? [], ...(input.home ? { home: input.home } : {}) };
		this.authority = store.add(new PolicyAuthority(this.input));
	}

	/** A principal minted and bound to a fresh channel, and the context of a request on that channel. */
	connect(subject: SubjectKey, kind: PrincipalKind = 't3'): { readonly principal: IPrincipal; readonly channel: string; readonly context: ICallContext } {
		const principal = this.registry.mint({ subject, kind, launchPolicyHash: 'test' });
		const channel = `channel-${++this.channels}`;
		this.registry.bind(channel, principal);
		return { principal, channel, context: this.registry.contextFor(channel, `r${this.channels}`)! };
	}

	/** A new snapshot: the grant store changed (a revoke, a new grant). */
	update(change: Partial<IPolicySnapshotInput>): void {
		this.input = { ...this.input, ...change, epoch: this.input.epoch + 1 };
		this.authority.update(this.input);
	}

	get grants(): readonly IGrant[] {
		return this.input.grants ?? [];
	}
}

/** The broker error code a call ends with, or `ok`. */
export async function outcome(promise: Promise<unknown>): Promise<BrokerErrorCode | 'ok' | string> {
	try {
		await promise;
		return 'ok';
	} catch (err) {
		return err instanceof BrokerError ? err.code : `other: ${err instanceof Error ? err.message : String(err)}`;
	}
}
