/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { decisionRecord, IAccessRequest, IChatView, IDecision, IDecisionLogRecord, IManifestView, PolicySnapshot, evaluate } from '../../../../platform/voltSandbox/common/authority.js';
import { FLOW_CAPABILITY, IGrant } from '../../../../platform/voltSandbox/common/grants.js';
import { chatSubject, corePrincipal, extensionSubject, ICallContext, SubjectKey } from '../../../../platform/voltSandbox/common/principals.js';
import { IVoltSandboxSettings, SandboxStrategy } from '../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { hostToolClassCapability, HostToolSandboxClass, IHostToolSandboxUse } from './hostToolSandbox.js';

/**
 * The host-tool gate's side of the Policy Authority (spec C2, M.3): every class decision the gate
 * makes for a sandboxed chat (`hostToolSandbox.ts`) is a request to `evaluate`, over a snapshot of
 * the chats involved and the chat's flow approvals.
 *
 * Shadow mode (M.3 step 2, kept switchable for one release): both the old rules and the Authority
 * decide every call; `shadow` acts on the old one, `enforce` on the Authority's; either way every
 * difference is recorded (`diffs`, `onDidDiff`) with the decision that explains it.
 *
 * Path, page and port rules stay where they are (`sandboxReadRefusal`, `sandboxWriteRefusal`,
 * `sandboxBrowserUrlRefusal`): they are the files and network brokers' job (later packages).
 */

export type PolicyAuthorityMode = 'enforce' | 'shadow';

export const POLICY_AUTHORITY_MODE_SETTING = 'volt.sandbox.policyAuthority.mode';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.sandbox.policyAuthority',
	title: localize('voltPolicyAuthority.title', "Sandbox Policy Authority"),
	type: 'object',
	properties: {
		[POLICY_AUTHORITY_MODE_SETTING]: {
			type: 'string',
			enum: ['enforce', 'shadow'],
			enumDescriptions: [
				localize('voltPolicyAuthority.enforce', "The Policy Authority decides what a sandboxed chat's host tool calls and extensions may do."),
				localize('voltPolicyAuthority.shadow', "The earlier rules decide; the Policy Authority's decision is only compared and differences are logged. For one release, to roll back."),
			],
			default: 'enforce',
			description: localize('voltPolicyAuthority.mode', "Whether Volt's single permission decision function (the Policy Authority) decides, or only runs alongside the earlier rules."),
		},
	},
});

export function readPolicyAuthorityMode(value: unknown): PolicyAuthorityMode {
	return value === 'shadow' ? 'shadow' : 'enforce';
}

/** One call where the old rules and the Authority disagreed. */
export interface IPolicyShadowDiff {
	readonly at: number;
	/** The tool, or `api:<method>` for the extension API. */
	readonly what: string;
	readonly subject: SubjectKey;
	readonly legacy: 'allow' | 'deny';
	readonly authority: IDecision;
	/** Which one acted. */
	readonly mode: PolicyAuthorityMode;
}

/** A chat as the gate knows it: its settings, its agent's strategy, its folder (a real path). */
export interface IGateChat {
	readonly id: string | undefined;
	readonly settings: IVoltSandboxSettings | undefined;
	readonly strategy?: SandboxStrategy;
	readonly folder?: string;
}

/** Who serves a tool that is not Volt's own: an extension's registration, as core recorded it. */
export interface IGateToolOwner {
	readonly extensionId: string;
	readonly label: string;
	readonly firstParty: boolean;
	readonly toolClass: HostToolSandboxClass;
	readonly declared: readonly { readonly id: string; readonly targets?: readonly string[] }[];
	readonly sandboxed?: boolean;
}

const MAX_KEPT = 500;

function chatView(chat: IGateChat): IChatView | undefined {
	return chat.settings ? { subject: chatSubject(chat.id ?? '(none)'), settings: chat.settings, ...(chat.strategy ? { strategy: chat.strategy } : {}), ...(chat.folder ? { folder: chat.folder } : {}) } : undefined;
}

export class HostToolAuthority extends Disposable {

	mode: PolicyAuthorityMode = 'enforce';
	private epoch = 0;
	private flowGrants: IGrant[] = [];
	private readonly _diffs: IPolicyShadowDiff[] = [];
	private readonly _decisions: { readonly snapshot: PolicySnapshot; readonly request: IAccessRequest; readonly context: ICallContext; readonly decision: IDecision }[] = [];
	private readonly _onDidDiff = this._register(new Emitter<IPolicyShadowDiff>());
	readonly onDidDiff = this._onDidDiff.event;

	constructor(private readonly now: () => number = Date.now) {
		super();
	}

	get diffs(): readonly IPolicyShadowDiff[] {
		return this._diffs;
	}

	/** The last decisions as decision-log records (G.11), with their snapshots, for replay. */
	decisionLog(): { readonly snapshot: PolicySnapshot; readonly record: IDecisionLogRecord }[] {
		return this._decisions.map(entry => ({ snapshot: entry.snapshot, record: decisionRecord(entry.snapshot, entry.request, entry.context, entry.decision) }));
	}

	/**
	 * The class decision for a call of one of Volt's own tools (`use` undefined: a tool the gate does
	 * not know) by a sandboxed chat. `target`: what Volt knows of the chat a `delegates` call prompts
	 * (undefined when it knows nothing).
	 */
	classDecision(use: IHostToolSandboxUse | undefined, caller: IGateChat, target?: IGateChat): IDecision {
		const callerView = chatView(caller);
		const chats = [callerView, target ? chatView(target) : undefined].filter((view): view is IChatView => !!view);
		const snapshot = this.snapshot(chats, []);
		// The prompted chat is named by the call; a chat Volt has no record of stays out of the snapshot and is refused.
		const request = this.classRequest(use, caller.id, use?.kind === 'delegates' ? use.target : undefined);
		const context = this.context(chatSubject(caller.id ?? '(none)'), []);
		return this.decide(snapshot, request, context);
	}

	private classRequest(use: IHostToolSandboxUse | undefined, callerId: string | undefined, targetId: string | undefined): IAccessRequest {
		if (!use) {
			return { capability: 'full', surface: 'host-tool' };
		}
		switch (use.kind) {
			case 'reads-other': {
				const other = use.readsAnyChat || (use.target !== undefined && use.target !== callerId);
				return { capability: other ? 'agents.read:other' : 'agents.read:current', surface: 'host-tool', ...(use.target ? { target: chatSubject(use.target) } : {}) };
			}
			case 'delegates':
				// Prompting another chat moves this chat's words into it: a data-flow edge, judged by INV-11.
				return targetId && targetId !== callerId
					? { capability: 'agents.send', target: chatSubject(targetId), edge: 'send', surface: 'host-tool' }
					: { capability: 'agents.send', surface: 'host-tool' };
			default:
				return { capability: hostToolClassCapability(use.kind), surface: 'host-tool' };
		}
	}

	/**
	 * An extension's tool called by a chat (G.6, PERM-FLOW-1): the extension must hold the tool's
	 * capability, the chat must too (attenuation), and the extension must not be able to send the
	 * chat's data anywhere the chat couldn't, unless the user approved that flow.
	 */
	extensionToolDecision(name: string, owner: IGateToolOwner, caller: IGateChat): IDecision {
		const subject = this.ownerSubject(owner);
		// A tool that only reaches the network (`network`) is judged as the call itself plus where the
		// extension can send what it is given (G.6): its hosts are its `net.connect` declarations, so the
		// request is not a `net.connect` to the tool's name. Other classes need their own capability.
		const capability = owner.toolClass === 'network' ? 'tools.register' : hostToolClassCapability(owner.toolClass);
		const manifest: IManifestView = {
			subject,
			// Registration checked the tool's class against the extension's own policy (createVoltApi).
			declared: [...owner.declared, { id: capability, targets: [name] }],
			// Unsandboxed extension code can reach anything; a first-party one is held to its ceiling (G.10).
			network: owner.sandboxed || owner.firstParty ? 'broker' : 'host',
		};
		const callerView = chatView(caller);
		const snapshot = this.snapshot(callerView ? [callerView] : [], [manifest]);
		const request: IAccessRequest = { capability, target: name, edge: 'tool', surface: 'host-tool' };
		const context = this.context(subject, [chatSubject(caller.id ?? '(none)')]);
		return this.decide(snapshot, request, context);
	}

	ownerSubject(owner: IGateToolOwner): SubjectKey {
		return extensionSubject(owner.extensionId, owner.firstParty);
	}

	/** Records the user's "Allow once" or "Allow for this chat" on a flow card (a grant on the chat, G.6). */
	approveFlow(chatId: string, to: SubjectKey, hosts: readonly string[] | 'all', kind: 'once' | 'session'): IGrant {
		const at = this.now();
		const grant: IGrant = {
			id: `flow:${chatId}:${to}:${++this.epoch}`,
			subject: chatSubject(chatId),
			capability: FLOW_CAPABILITY,
			scope: { targets: [to], hosts: hosts === 'all' ? ['*'] : [...hosts] },
			kind,
			...(kind === 'session' ? { sessionId: chatId } : {}),
			source: 'user',
			grantedAt: at,
			lastUsedAt: at,
			epoch: this.epoch,
		};
		this.flowGrants = [...this.flowGrants, grant];
		return grant;
	}

	/** A once grant is spent by the call it allowed. */
	consume(grant: IGrant): void {
		if (grant.kind === 'once') {
			this.revoke(candidate => candidate.id === grant.id);
		}
	}

	/** The flow approvals a chat holds: shown with the chat, revocable. */
	flowApprovals(chatId: string): readonly IGrant[] {
		return this.flowGrants.filter(grant => grant.subject === chatSubject(chatId));
	}

	/** Revokes a chat's flow approvals (to one subject, or all): a new epoch, so the next call asks again. */
	revokeFlowApprovals(chatId: string, to?: SubjectKey): number {
		return this.revoke(grant => grant.subject === chatSubject(chatId) && (!to || !!grant.scope.targets?.includes(to)));
	}

	private revoke(match: (grant: IGrant) => boolean): number {
		const before = this.flowGrants.length;
		this.flowGrants = this.flowGrants.filter(grant => !match(grant));
		if (this.flowGrants.length !== before) {
			this.epoch++;
		}
		return before - this.flowGrants.length;
	}

	/** Compares the old rule's verdict with the Authority's; returns whether the call is refused under the current mode. */
	compare(what: string, subject: SubjectKey, legacyRefused: boolean, decision: IDecision): boolean {
		if (legacyRefused === decision.allow) {
			const diff: IPolicyShadowDiff = { at: this.now(), what, subject, legacy: legacyRefused ? 'deny' : 'allow', authority: decision, mode: this.mode };
			if (this._diffs.length >= MAX_KEPT) {
				this._diffs.shift();
			}
			this._diffs.push(diff);
			this._onDidDiff.fire(diff);
		}
		return this.mode === 'enforce' ? !decision.allow : legacyRefused;
	}

	private snapshot(chats: readonly IChatView[], manifests: readonly IManifestView[]): PolicySnapshot {
		return PolicySnapshot.build({ epoch: this.epoch, asOf: this.now(), grants: this.flowGrants, chats, manifests });
	}

	private context(subject: SubjectKey, chain: readonly SubjectKey[]): ICallContext {
		return {
			principal: corePrincipal(`core:${subject}`, subject, subject.startsWith('chat:') ? 'agent' : 't3'),
			onBehalfOf: chain.map(link => corePrincipal(`core:${link}`, link, 'agent')),
			requestId: `gate:${this.epoch}`,
		};
	}

	private decide(snapshot: PolicySnapshot, request: IAccessRequest, context: ICallContext): IDecision {
		const decision = evaluate(snapshot, request, context);
		if (this._decisions.length >= MAX_KEPT) {
			this._decisions.shift();
		}
		this._decisions.push({ snapshot, request, context, decision });
		return decision;
	}
}
