/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { firstPartyCapabilityMode } from '../../../../platform/voltPlugins/common/firstPartyCeilings.js';
import { ICapabilityReporter, ICapabilityRequest, ICapabilityVerdict, IVoltPluginPrincipal, IWouldBeDenial, ReportModeCapabilityReporter } from './capabilities.js';
import { IExtensionCapabilityPolicyOptions, VoltExtensionCapabilityPolicy } from './extensionCapabilityPolicy.js';

/**
 * The check behind in-process feature code's `volt` API (M5): per feature, report mode or
 * enforcement. A built-in on `FIRST_PARTY_ENFORCED` (`firstPartyCeilings.ts`) is judged by the
 * Policy Authority: what its manifest declares within its compiled ceiling is allowed with no
 * prompt and no consent lookup, anything else is refused with a typed error. Every other caller
 * runs in report mode, as before: allowed, with each would-be denial logged once.
 *
 * The switch is compiled into core, never a setting: moving a feature to enforcement is a reviewed
 * change to the ceiling table, and nothing at runtime can move it back.
 */
export class VoltFeatureCapabilityReporter implements ICapabilityReporter {

	readonly mode = 'per-feature';
	readonly report: ReportModeCapabilityReporter;
	private readonly enforcing: VoltExtensionCapabilityPolicy;
	readonly onDidReport: Event<IWouldBeDenial>;

	constructor(log: (message: string) => void, options: Omit<IExtensionCapabilityPolicyOptions, 'mode'> = {}) {
		this.report = new ReportModeCapabilityReporter(log);
		// First party never asks and is never looked up in the consent store (G.10, G.12).
		this.enforcing = new VoltExtensionCapabilityPolicy({ state: () => undefined }, options);
		this.onDidReport = Event.any(this.report.onDidReport, this.enforcing.onDidReport);
	}

	/** What a principal's calls get: `enforce` only for an enforced built-in. */
	modeFor(principal: IVoltPluginPrincipal): 'enforce' | 'report' {
		return principal.firstParty ? firstPartyCapabilityMode(principal.extensionId) : 'report';
	}

	/** Would-be denials logged in report mode (the evidence for moving a feature, M5). */
	get reports(): readonly IWouldBeDenial[] {
		return this.report.reports;
	}

	check(principal: IVoltPluginPrincipal, request: ICapabilityRequest): ICapabilityVerdict {
		return this.modeFor(principal) === 'enforce' ? this.enforcing.check(principal, request) : this.report.check(principal, request);
	}

	dispose(): void {
		this.report.dispose();
		this.enforcing.dispose();
	}
}
