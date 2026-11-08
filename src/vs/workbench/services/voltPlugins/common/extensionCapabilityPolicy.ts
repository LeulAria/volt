/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { ceilingCovers } from '../../../../platform/voltPlugins/common/firstPartyCeilings.js';
import { evaluate, IDecision, IDeclaredCapability, PolicySnapshot } from '../../../../platform/voltSandbox/common/authority.js';
import { consentsToGrants } from '../../../../platform/voltSandbox/common/grants.js';
import { corePrincipal, extensionSubject } from '../../../../platform/voltSandbox/common/principals.js';
import { PolicyAuthorityMode } from '../../voltRuntime/common/hostToolAuthority.js';
import { capabilityClass, CapabilityDeniedBy, ICapabilityReporter, ICapabilityRequest, ICapabilityVerdict, IVoltPluginPrincipal, IWouldBeDenial, manifestDenial } from './capabilities.js';

/** What the user said about one capability of one extension; undefined: never asked. */
export type VoltConsentState = 'granted' | 'refused' | undefined;

/** Where consents live (persisted, revocable from the extension's page). */
export interface IVoltConsentStore {
	state(extensionId: string, capability: string): VoltConsentState;
	/** A consent changed: the Authority's snapshot moves to a new epoch. */
	readonly onDidChange?: Event<unknown>;
}

/** The capability a consent is kept under: the id without its version (one consent per capability, any target). */
export function consentKey(capability: string): string {
	return capability.replace(/@\d+$/, '');
}

/** One call where the earlier policy and the Authority disagreed (shadow mode, M.3). */
export interface IExtensionPolicyShadowDiff {
	readonly extensionId: string;
	readonly api: string;
	readonly capability: string;
	readonly target?: string;
	readonly legacy?: IWouldBeDenial;
	readonly authority?: IWouldBeDenial;
	readonly decision: IDecision;
}

export interface IExtensionCapabilityPolicyOptions {
	/** `shadow`: the earlier rules decide and the Authority only runs alongside. Default `enforce`. */
	readonly mode?: () => PolicyAuthorityMode;
	readonly onDiff?: (diff: IExtensionPolicyShadowDiff) => void;
	readonly now?: () => number;
}

/**
 * The enforcing check behind the `volt` extension API, backed by the Policy Authority (C2): each
 * call is `evaluate` over a snapshot of the extension's manifest and its consents (which become
 * grants and refusals), on the extension API surface:
 *
 * - not in the catalog: refused (`catalog`, the floor);
 * - class `critical`: never through the API (`critical`, the floor), whoever asks;
 * - class `none` (own storage, own settings, own commands, UI): allowed;
 * - not declared in `contributes.voltCapabilities` (or not for this target): refused (`manifest`);
 * - a built-in `volt.*` extension: what it declares, capped by its compiled ceiling (`ceiling`), no prompt;
 * - a third party: `low` while enabled (an install-time grant); `medium` and `high` once the user
 *   allowed them for this extension (`consent`; promptable when never answered).
 *
 * The earlier implementation stays as `legacyExtensionDenial` for shadow mode, one release.
 */
export class VoltExtensionCapabilityPolicy implements ICapabilityReporter {

	readonly mode = 'enforce';
	private readonly _onDidReport = new Emitter<IWouldBeDenial>();
	readonly onDidReport = this._onDidReport.event;
	private epoch = 0;
	private readonly listener: { dispose(): void } | undefined;

	constructor(private readonly consents: IVoltConsentStore, private readonly options: IExtensionCapabilityPolicyOptions = {}) {
		this.listener = consents.onDidChange?.(() => this.epoch++);
	}

	check(principal: IVoltPluginPrincipal, request: ICapabilityRequest): ICapabilityVerdict {
		const decision = this.decide(principal, request);
		const denial = decision.allow ? undefined : denialOf(principal, request, decision);
		const legacy = legacyExtensionDenial(principal, request, this.consents);
		if (!sameVerdict(legacy, denial)) {
			this.options.onDiff?.({ extensionId: principal.extensionId, api: request.api, capability: request.capability, ...(request.target !== undefined ? { target: request.target } : {}), legacy, authority: denial, decision });
		}
		const acting = this.options.mode?.() === 'shadow' ? legacy : denial;
		if (acting) {
			this._onDidReport.fire(acting);
			return { allowed: false, denial: acting };
		}
		return { allowed: true };
	}

	/** The Authority's decision for one call (G.2), over this extension's manifest and consents. */
	decide(principal: IVoltPluginPrincipal, request: ICapabilityRequest): IDecision {
		const subject = extensionSubject(principal.extensionId, principal.firstParty);
		const declared: IDeclaredCapability[] = [
			...(principal.capabilities.required ?? []).map(entry => ({ id: entry.id, ...(entry.targets?.length ? { targets: entry.targets } : {}) })),
			...(principal.capabilities.optional ?? []).map(entry => ({ id: entry.id, optional: true, ...(entry.targets?.length ? { targets: entry.targets } : {}) })),
		];
		const at = this.options.now?.() ?? Date.now();
		const state = principal.firstParty || !capabilityClass(request.capability) ? undefined : this.consents.state(principal.extensionId, consentKey(request.capability));
		const { grants, refusals } = consentsToGrants(subject, state ? [{ capability: consentKey(request.capability), granted: state === 'granted' }] : [], at, this.epoch);
		const snapshot = PolicySnapshot.build({
			epoch: this.epoch,
			asOf: at,
			grants,
			refusals,
			// Extension hosts run unsandboxed unless the user opts an extension in (N.1).
			manifests: [{ subject, declared, network: 'host' }],
		});
		return evaluate(snapshot, { capability: request.capability, ...(request.target !== undefined ? { target: request.target } : {}), surface: 'extension-api' }, {
			principal: corePrincipal(`extension:${principal.extensionId}`, subject, 't3'),
			onBehalfOf: [],
			// Consent prompts are core's own dialog, shown when the extension asks Volt to ask (requestConsent).
			// G.3's gesture token is not carried from the extension host yet, so the API counts as in front.
			foreground: true,
			requestId: request.api,
		});
	}

	dispose(): void {
		this.listener?.dispose();
		this._onDidReport.dispose();
	}
}

/** The API's view of an Authority denial (H.3 `deniedBy`). */
function denialOf(principal: IVoltPluginPrincipal, request: ICapabilityRequest, decision: IDecision): IWouldBeDenial {
	const cls = capabilityClass(request.capability);
	const base = { extensionId: principal.extensionId, api: request.api, capability: request.capability, ...(request.target !== undefined ? { target: request.target } : {}) };
	let deniedBy: CapabilityDeniedBy;
	switch (decision.code) {
		case 'catalog': return { ...base, deniedBy: 'catalog', reason: decision.reason };
		case 'critical': deniedBy = 'critical'; break;
		case 'undeclared':
		case 'undeclared-target':
		case 'unknown-subject': deniedBy = 'manifest'; break;
		case 'ceiling': deniedBy = 'ceiling'; break;
		case 'consent':
		case 'refused': deniedBy = 'consent'; break;
		default: deniedBy = decision.deniedBy === 'workspace' || decision.deniedBy === 'admin' || decision.deniedBy === 'platform' ? decision.deniedBy : 'floor';
	}
	return { ...base, ...(cls ? { class: cls } : {}), deniedBy, reason: decision.reason, ...(decision.promptable ? { promptable: true } : {}) };
}

function sameVerdict(a: IWouldBeDenial | undefined, b: IWouldBeDenial | undefined): boolean {
	return (!a && !b) || (!!a && !!b && a.deniedBy === b.deniedBy && !!a.promptable === !!b.promptable);
}

/**
 * The extension API's rules before the Policy Authority (C2), kept for shadow mode for one release
 * (M.3): undefined when the call is allowed.
 */
export function legacyExtensionDenial(principal: IVoltPluginPrincipal, request: ICapabilityRequest, consents: IVoltConsentStore): IWouldBeDenial | undefined {
	const cls = capabilityClass(request.capability);
	const base = { extensionId: principal.extensionId, api: request.api, capability: request.capability, ...(request.target !== undefined ? { target: request.target } : {}) };
	if (!cls) {
		return { ...base, deniedBy: 'catalog', reason: `${request.capability} is not in Volt's capability catalog` };
	}
	if (cls === 'none') {
		return undefined;
	}
	if (cls === 'critical') {
		return { ...base, class: cls, deniedBy: 'critical', reason: `${request.capability} is critical: Volt never grants it through the extension API` };
	}
	const undeclared = manifestDenial(principal, request);
	if (undeclared) {
		return undeclared;
	}
	if (principal.firstParty) {
		return ceilingCovers(principal.extensionId, request.capability, request.target)
			? undefined
			: { ...base, class: cls, deniedBy: 'ceiling', reason: `${request.capability} is beyond ${principal.extensionId}'s first-party ceiling` };
	}
	if (cls === 'low') {
		return undefined;
	}
	const state = consents.state(principal.extensionId, consentKey(request.capability));
	if (state === 'granted') {
		return undefined;
	}
	return state === 'refused'
		? { ...base, class: cls, deniedBy: 'consent', reason: `the user did not allow ${principal.extensionId} to use ${request.capability} (change it on the extension's page)` }
		: { ...base, class: cls, deniedBy: 'consent', reason: `${request.capability} (${cls}) needs the user's consent`, promptable: true };
}
