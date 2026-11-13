/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Volt's capability catalog (spec G.8): every capability id and its class. Pure, and in `platform/`
 * so the Policy Authority (`voltSandbox/common/authority.ts`) and the extension API share one list.
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

/** A capability id without its version: `net.connect@1` is `net.connect`. */
export function bareCapability(id: string): string {
	return id.replace(/@\d+$/, '');
}

/** The version of a capability id (`@2`); an id without one is version 1. */
export function capabilityVersion(id: string): number {
	const match = /@(\d+)$/.exec(id);
	return match ? Number(match[1]) : 1;
}

/** The id with its version: `net.connect` is `net.connect@1`. */
export function versionedCapability(id: string): string {
	return `${bareCapability(id)}@${capabilityVersion(id)}`;
}

/** The catalog class of a capability id (`net.connect@1` and `secrets.use:github` too); undefined: not a Volt capability. */
export function capabilityClass(id: string): VoltCapabilityClass | undefined {
	const bare = bareCapability(id);
	if (Object.prototype.hasOwnProperty.call(CATALOG, bare)) {
		return CATALOG[bare];
	}
	const colon = bare.indexOf(':');
	const base = colon > 0 ? bare.slice(0, colon) : undefined;
	return base && Object.prototype.hasOwnProperty.call(PARAMETERIZED, base) ? PARAMETERIZED[base] : undefined;
}

/** Whether a declared or granted id (`secrets.use:*` holds `secrets.use:github`) holds `capability`. */
export function capabilityIdCovers(held: string, capability: string): boolean {
	const id = bareCapability(held);
	const wanted = bareCapability(capability);
	return id === wanted || (id.endsWith(':*') && wanted.startsWith(id.slice(0, -1)));
}

/** `*` matches any run of characters. */
export function capabilityTargetMatches(pattern: string, target: string): boolean {
	if (!pattern.includes('*')) {
		return pattern === target;
	}
	const escaped = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
	return new RegExp(`^${escaped}$`).test(target);
}
