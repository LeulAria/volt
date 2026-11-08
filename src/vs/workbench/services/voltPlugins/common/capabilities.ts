/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { HostToolSandboxClass } from '../../voltRuntime/common/hostToolSandbox.js';
import type { IVoltCapabilitiesContribution, IVoltCapabilityDeclaration } from './voltContributions.js';

/**
 * Volt's capability catalog (spec G.8) and the seam the plugin API checks every call through.
 *
 * Until the Policy Authority exists, the API runs in report mode: `ReportModeCapabilityReporter`
 * compares each call with the capabilities the plugin's manifest declares and logs what would be
 * denied, but every call goes ahead as it does today. The Authority replaces the reporter behind
 * the same `ICapabilityReporter` interface; the API code doesn't change.
 */

export const VOLT_CAPABILITY_CLASSES = ['none', 'low', 'medium', 'high', 'critical'] as const;
export type VoltCapabilityClass = typeof VOLT_CAPABILITY_CLASSES[number];

export function voltCapabilityClassRank(value: VoltCapabilityClass): number {
	return VOLT_CAPABILITY_CLASSES.indexOf(value);
}

/** G.8, exact ids. */
const CATALOG: Readonly<Record<string, VoltCapabilityClass>> = {
	// none: automatic for everyone.
	'ui.contribute': 'none',
	'storage.own': 'none',
	'config.own': 'none',
	'commands.own': 'none',
	'files.read:picked': 'none',
	// low: the install sheet.
	'files.read:workspace': 'low',
	// Named non-exfil hosts. Exfil-capable hosts are high; the Authority classes hosts (C2).
	'net.connect': 'low',
	'agents.read:current': 'low',
	'tools.register': 'low',
	'usage.report': 'low',
	// medium: the install sheet and first use.
	'agents.read:any': 'medium',
	'agents.send': 'medium',
	'git.read': 'medium',
	'hosting.read': 'medium',
	'files.write': 'medium',
	'terminals.read': 'medium',
	'terminals.run': 'medium',
	'browser.read': 'medium',
	'clipboard.read': 'medium',
	// high: asked at runtime, in context.
	'agents.create': 'high',
	'agents.context': 'high',
	'agents.hooks': 'high',
	'agents.read:other': 'high',
	'git.write': 'high',
	'git.push': 'high',
	'hosting.write': 'high',
	'net.local.connect': 'high',
	'browser.drive': 'high',
	'devices.drive': 'high',
	'automations.schedule': 'high',
	// critical: never by prompt.
	'desktop.control': 'critical',
	'screen.capture': 'critical',
	'secrets.read': 'critical',
	'secrets.manage': 'critical',
	'files.read:home': 'critical',
	'spawn.unsandboxed': 'critical',
	'network.host': 'critical',
	'commands.execute:*': 'critical',
	'full': 'critical',
};

/** G.8, ids with a target after the colon. */
const PARAMETERIZED: Readonly<Record<string, VoltCapabilityClass>> = {
	'secrets.use': 'high',
	'net.loopback.connect': 'high',
	'net.listen': 'high',
	'commands.execute': 'high',
};

/** The catalog class of a capability id (`net.connect@1` and `secrets.use:github` too); undefined: not a Volt capability. */
export function capabilityClass(id: string): VoltCapabilityClass | undefined {
	const bare = id.replace(/@\d+$/, '');
	if (Object.prototype.hasOwnProperty.call(CATALOG, bare)) {
		return CATALOG[bare];
	}
	const colon = bare.indexOf(':');
	const base = colon > 0 ? bare.slice(0, colon) : undefined;
	return base && Object.prototype.hasOwnProperty.call(PARAMETERIZED, base) ? PARAMETERIZED[base] : undefined;
}

/**
 * The capability a tool of this class needs on top of `tools.register` (G.8: a plugin can't declare a
 * tool class lower than its capabilities imply). `tools.register` alone covers tools that only read.
 */
export function toolClassCapability(toolClass: HostToolSandboxClass): string {
	switch (toolClass) {
		case 'safe': return 'tools.register';
		case 'browser': return 'browser.drive';
		case 'reads': return 'files.read:workspace';
		case 'network': return 'net.connect';
		case 'writes': return 'files.write';
		case 'sandboxed': return 'terminals.run';
		case 'reads-other': return 'agents.read:other';
		case 'persists': return 'agents.context';
		case 'delegates': return 'agents.send';
		case 'spawns': return 'agents.create';
		case 'escapes': return 'spawn.unsandboxed';
	}
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
 * (or refused). `critical`: never granted through the API (G.8).
 */
export type CapabilityDeniedBy = 'manifest' | 'catalog' | 'ceiling' | 'consent' | 'critical';

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
	readonly mode: 'report' | 'enforce';
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
