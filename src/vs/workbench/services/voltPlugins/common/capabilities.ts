/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { capabilityClass, VoltCapabilityClass } from '../../../../platform/voltPlugins/common/capabilityCatalog.js';
import { hostToolClassCapability, HostToolSandboxClass } from '../../voltRuntime/common/hostToolSandbox.js';
import type { IVoltCapabilitiesContribution, IVoltCapabilityDeclaration } from './voltContributions.js';

/**
 * Volt's capability catalog (spec G.8) and the seam the plugin API checks every call through.
 *
 * The catalog itself lives in `platform/voltPlugins/common/capabilityCatalog.ts`, shared with the
 * Policy Authority. Report mode (`ReportModeCapabilityReporter`) compares each call with the
 * manifest and logs what would be denied; the enforcing check is `VoltExtensionCapabilityPolicy`,
 * which asks the Policy Authority behind the same `ICapabilityReporter` interface.
 */

export { capabilityClass, VOLT_CAPABILITY_CLASSES, voltCapabilityClassRank } from '../../../../platform/voltPlugins/common/capabilityCatalog.js';
export type { VoltCapabilityClass } from '../../../../platform/voltPlugins/common/capabilityCatalog.js';

/**
 * The capability a tool of this class needs on top of `tools.register` (G.8: a plugin can't declare a
 * tool class lower than its capabilities imply). `tools.register` alone covers tools that only read.
 */
export function toolClassCapability(toolClass: HostToolSandboxClass): string {
	return hostToolClassCapability(toolClass);
}

/** Who is calling: set by core when it creates the plugin's context, never taken from a payload. */
export interface IVoltPluginPrincipal {
	/** `volt.usage`. */
	readonly extensionId: string;
	/** Its display name, for what the user sees. */
	readonly label?: string;
	readonly firstParty: boolean;
	readonly capabilities: IVoltCapabilitiesContribution;
	/** Setting keys (or prefixes ending in `.`) the extension contributes itself: `config.own`, like `voltModule.settings`. */
	readonly ownSettings?: readonly string[];
}

export interface ICapabilityRequest {
	readonly capability: string;
	/** A host, command id, chat id, setting key, tool name. */
	readonly target?: string;
	/** The API method, e.g. `agents.send`. */
	readonly api: string;
}

/**
 * Which layer would refuse it (H.3 `deniedBy`). `ceiling`: a built-in asked beyond its first-party
 * ceiling (G.10). `consent`: a third party's medium or high capability the user hasn't allowed
 * (or refused). `critical`: never granted through the API (G.8). `floor`, `workspace`, `admin`,
 * `platform`: the Policy Authority's other layers (G.2), e.g. a target in a credential folder.
 */
export type CapabilityDeniedBy = 'manifest' | 'catalog' | 'ceiling' | 'consent' | 'critical' | 'floor' | 'workspace' | 'admin' | 'platform';

export interface IWouldBeDenial {
	readonly extensionId: string;
	readonly api: string;
	readonly capability: string;
	readonly target?: string;
	readonly class?: VoltCapabilityClass;
	readonly deniedBy: CapabilityDeniedBy;
	readonly reason: string;
	/** The user may be asked for it (G.3): a declared medium or high capability never answered. */
	readonly promptable?: boolean;
}

export interface ICapabilityVerdict {
	readonly allowed: boolean;
	/** Set when the call goes beyond the manifest: refused when enforcing, only logged in report mode. */
	readonly denial?: IWouldBeDenial;
}

/**
 * The check behind every plugin API call. Report mode allows everything and records what it would
 * deny; the Policy Authority (C2) implements `enforce`.
 */
export interface ICapabilityReporter {
	/** `per-feature`: enforced for the built-ins on `FIRST_PARTY_ENFORCED`, report mode for the rest (M5). */
	readonly mode: 'report' | 'enforce' | 'per-feature';
	readonly onDidReport: Event<IWouldBeDenial>;
	check(principal: IVoltPluginPrincipal, request: ICapabilityRequest): ICapabilityVerdict;
}

/** A typed refusal (H.3). Report mode never throws it. */
export class VoltCapabilityError extends Error {
	static readonly NAME = 'VoltCapabilityError';

	constructor(
		public readonly capability: string,
		public readonly target: string | undefined,
		public readonly deniedBy: CapabilityDeniedBy,
		message: string,
		/** The user may be asked for it (see `IWouldBeDenial.promptable`). */
		public readonly promptable = false,
	) {
		super(message);
		this.name = VoltCapabilityError.NAME;
	}

	/** Kept by RPC error serialization (`code`), so the extension host can rebuild the fields. */
	get code(): string {
		return JSON.stringify({ capability: this.capability, target: this.target, deniedBy: this.deniedBy });
	}
}

/** `*` matches any run of characters. */
function targetMatches(pattern: string, target: string): boolean {
	if (!pattern.includes('*')) {
		return pattern === target;
	}
	const escaped = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
	return new RegExp(`^${escaped}$`).test(target);
}

/** The declaration that covers the request, if the manifest has one. */
function covering(declared: readonly IVoltCapabilityDeclaration[], capability: string, target: string | undefined): IVoltCapabilityDeclaration | undefined {
	const bare = capability.replace(/@\d+$/, '');
	return declared.find(entry => {
		const id = entry.id.replace(/@\d+$/, '');
		if (id !== bare && !(id.endsWith(':*') && bare.startsWith(id.slice(0, -1)))) {
			return false;
		}
		return !entry.targets?.length || (target !== undefined && entry.targets.some(pattern => targetMatches(pattern, target)));
	});
}

/** What a manifest-only check says about one request: undefined when the manifest covers it. Pure. */
export function manifestDenial(principal: IVoltPluginPrincipal, request: ICapabilityRequest): IWouldBeDenial | undefined {
	const cls = capabilityClass(request.capability);
	const base = { extensionId: principal.extensionId, api: request.api, capability: request.capability, ...(request.target !== undefined ? { target: request.target } : {}) };
	if (!cls) {
		return { ...base, deniedBy: 'catalog', reason: `${request.capability} is not in Volt's capability catalog` };
	}
	if (cls === 'none') {
		return undefined;
	}
	const declared = [...principal.capabilities.required ?? [], ...principal.capabilities.optional ?? []];
	if (covering(declared, request.capability, request.target)) {
		return undefined;
	}
	const scoped = declared.some(entry => entry.id.replace(/@\d+$/, '') === request.capability.replace(/@\d+$/, ''));
	return {
		...base,
		class: cls,
		deniedBy: 'manifest',
		reason: scoped
			? `${request.capability} is declared for other targets than ${request.target ?? '(none)'}`
			: `${request.capability} (${cls}) is not declared in contributes.voltCapabilities`,
	};
}

/** Keeps at most this many reports for the Capabilities tab and tests. */
const MAX_REPORTS = 500;

/**
 * Report mode (H.13): every call is allowed; a call the manifest doesn't cover is logged once per
 * plugin, capability and target, and kept in `reports`.
 */
export class ReportModeCapabilityReporter implements ICapabilityReporter {

	readonly mode = 'report';
	private readonly _onDidReport = new Emitter<IWouldBeDenial>();
	readonly onDidReport = this._onDidReport.event;
	private readonly seen = new Set<string>();
	private readonly _reports: IWouldBeDenial[] = [];

	constructor(private readonly log: (message: string) => void) { }

	get reports(): readonly IWouldBeDenial[] {
		return this._reports;
	}

	check(principal: IVoltPluginPrincipal, request: ICapabilityRequest): ICapabilityVerdict {
		const denial = manifestDenial(principal, request);
		if (!denial) {
			return { allowed: true };
		}
		const key = `${denial.extensionId}\u0000${denial.capability}\u0000${denial.target ?? ''}`;
		if (!this.seen.has(key)) {
			this.seen.add(key);
			if (this._reports.length >= MAX_REPORTS) {
				this._reports.shift();
			}
			this._reports.push(denial);
			this.log(`[volt plugins] report mode: ${denial.extensionId} would be denied ${denial.capability}${denial.target !== undefined ? ` on ${denial.target}` : ''} (${denial.api}, by ${denial.deniedBy}): ${denial.reason}`);
			this._onDidReport.fire(denial);
		}
		return { allowed: true, denial };
	}

	dispose(): void {
		this._onDidReport.dispose();
	}
}
