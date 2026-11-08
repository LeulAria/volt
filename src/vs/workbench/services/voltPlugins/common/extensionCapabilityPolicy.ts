/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { ceilingCovers } from '../../../../platform/voltPlugins/common/firstPartyCeilings.js';
import { capabilityClass, ICapabilityReporter, ICapabilityRequest, ICapabilityVerdict, IVoltPluginPrincipal, IWouldBeDenial, manifestDenial } from './capabilities.js';

/** What the user said about one capability of one extension; undefined: never asked. */
export type VoltConsentState = 'granted' | 'refused' | undefined;

/** Where consents live (persisted, revocable from the extension's page). */
export interface IVoltConsentStore {
	state(extensionId: string, capability: string): VoltConsentState;
}

/** The capability a consent is kept under: the id without its version (one consent per capability, any target). */
export function consentKey(capability: string): string {
	return capability.replace(/@\d+$/, '');
}

/**
 * The enforcing check behind the `volt` extension API (it replaces M1's report mode for code that
 * runs in an extension host). Pure apart from reading the consent store, so the later Policy
 * Authority (C2) can replace it behind `ICapabilityReporter`:
 *
 * - not in the catalog: refused (`catalog`);
 * - class `none` (own storage, own settings, own commands, UI): allowed;
 * - class `critical`: never through the API (`critical`), whoever asks;
 * - not declared in `contributes.voltCapabilities` (or not for this target): refused (`manifest`);
 * - a built-in `volt.*` extension: what it declares, capped by its compiled ceiling (`ceiling`), no prompt;
 * - a third party: `low` while enabled; `medium` and `high` once the user allowed them for this
 *   extension (`consent`; promptable when never answered).
 */
export class VoltExtensionCapabilityPolicy implements ICapabilityReporter {

	readonly mode = 'enforce';
	private readonly _onDidReport = new Emitter<IWouldBeDenial>();
	readonly onDidReport = this._onDidReport.event;

	constructor(private readonly consents: IVoltConsentStore) { }

	check(principal: IVoltPluginPrincipal, request: ICapabilityRequest): ICapabilityVerdict {
		const denial = this.denial(principal, request);
		if (denial) {
			this._onDidReport.fire(denial);
			return { allowed: false, denial };
		}
		return { allowed: true };
	}

	private denial(principal: IVoltPluginPrincipal, request: ICapabilityRequest): IWouldBeDenial | undefined {
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
		const state = this.consents.state(principal.extensionId, consentKey(request.capability));
		if (state === 'granted') {
			return undefined;
		}
		return state === 'refused'
			? { ...base, class: cls, deniedBy: 'consent', reason: `the user did not allow ${principal.extensionId} to use ${request.capability} (change it on the extension's page)` }
			: { ...base, class: cls, deniedBy: 'consent', reason: `${request.capability} (${cls}) needs the user's consent`, promptable: true };
	}

	dispose(): void {
		this._onDidReport.dispose();
	}
}
