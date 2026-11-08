/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * First-party ceilings (spec G.10): the most each built-in `volt.*` extension may ever be granted.
 * A built-in gets what its manifest declares, intersected with this table, with no prompt. The
 * table is compiled into core, so widening a built-in needs a core release: a changed
 * `package.json` alone can't (the CI check `build/volt/ci/manifestCeiling.mjs` fails any manifest
 * that declares more, and the policy refuses at call time what the table doesn't hold).
 *
 * Owned through CODEOWNERS. Keep each entry exactly as narrow as the feature's manifest.
 */

export interface IVoltCeilingEntry {
	/** A G.8 capability id, `secrets.use:*` style for a family. */
	readonly id: string;
	/** Targets it is limited to (`*` globs). None: any target. */
	readonly targets?: readonly string[];
}

const PROVIDER = (name: string): readonly IVoltCeilingEntry[] => [{ id: `secrets.use:${name}` }];

/** Keyed by extension id, lower case. */
export const FIRST_PARTY_CEILINGS: Readonly<Record<string, readonly IVoltCeilingEntry[]>> = Object.freeze({
	'volt.agent-resources': [
		{ id: 'files.read:workspace' },
		{ id: 'files.read:home', targets: ['~/.claude/*', '~/.codex/*', '~/.cursor/*', '~/.config/opencode/*', '~/.agents/*'] },
	],
	'volt.automations': [
		{ id: 'tools.register' }, { id: 'automations.schedule' }, { id: 'agents.create' }, { id: 'net.connect' },
		{ id: 'hosting.write' }, { id: 'secrets.use:*' }, { id: 'spawn.unsandboxed' },
	],
	'volt.browser': [{ id: 'tools.register' }, { id: 'browser.drive' }, { id: 'browser.read' }, { id: 'files.read:workspace' }, { id: 'files.write' }],
	'volt.claude-accounts': [{ id: 'secrets.manage' }],
	'volt.code-intelligence': [{ id: 'tools.register' }, { id: 'files.read:workspace' }],
	'volt.commit-review': [{ id: 'tools.register' }, { id: 'git.read' }, { id: 'git.write' }, { id: 'spawn.unsandboxed' }],
	'volt.computer-use': [{ id: 'tools.register' }, { id: 'desktop.control' }, { id: 'screen.capture' }, { id: 'spawn.unsandboxed' }],
	'volt.customize': [{ id: 'files.write', targets: ['~/.volt/customize/*'] }],
	'volt.devices': [{ id: 'tools.register' }, { id: 'devices.drive' }, { id: 'screen.capture' }, { id: 'spawn.unsandboxed' }],
	'volt.git-graph': [{ id: 'git.read' }, { id: 'git.write' }, { id: 'agents.send' }],
	'volt.memory': [{ id: 'tools.register' }, { id: 'agents.context' }],
	'volt.playgrounds': [{ id: 'tools.register' }, { id: 'net.listen:*' }],
	'volt.provider-antigravity': PROVIDER('antigravity'),
	'volt.provider-claude': PROVIDER('claude'),
	'volt.provider-codex': PROVIDER('codex'),
	'volt.provider-cursor': PROVIDER('cursor'),
	'volt.provider-fx': PROVIDER('fx'),
	'volt.provider-grok': PROVIDER('grok'),
	'volt.provider-kimi': PROVIDER('kimi'),
	'volt.provider-local': [{ id: 'net.loopback.connect:11434' }, { id: 'net.loopback.connect:1234' }],
	'volt.provider-muse': PROVIDER('muse'),
	'volt.provider-opencode': PROVIDER('opencode'),
	'volt.provider-openrouter': [{ id: 'net.connect', targets: ['openrouter.ai'] }, { id: 'secrets.use:openrouter' }],
	'volt.provider-pi': PROVIDER('pi'),
	'volt.pull-requests': [
		{ id: 'tools.register' }, { id: 'git.read' }, { id: 'hosting.read' }, { id: 'hosting.write' }, { id: 'git.write' }, { id: 'git.push' }, { id: 'spawn.unsandboxed' },
	],
	'volt.remote-devices': [{ id: 'net.listen:*' }],
	'volt.scratch-board': [{ id: 'tools.register' }],
	'volt.skills-and-plugins': [
		{ id: 'files.read:workspace' }, { id: 'files.write' },
		{ id: 'net.connect', targets: ['skills.sh', '*.skills.sh', 'github.com', '*.githubusercontent.com'] },
	],
	'volt.usage': [{ id: 'usage.report' }, { id: 'net.connect' }, { id: 'secrets.use:*' }],
	'volt.visuals': [{ id: 'tools.register' }, { id: 'files.read:workspace' }, { id: 'browser.drive' }, { id: 'devices.drive' }],
});

/**
 * M5: the built-ins whose `volt` API calls from in-process feature code are enforced (what the
 * manifest declares within the ceiling, refused beyond it, no prompt). Every other built-in runs in
 * report mode: calls go through and each would-be denial is logged once
 * (`ReportModeCapabilityReporter`).
 *
 * The rule: a feature moves here only after its report log shows 0 would-be denials over one
 * release, and `featureCapabilityMode.test.ts` (M5-MODE-1) shows 0 for its manifest and its own API
 * namespace under enforcement. A feature whose manifest declares a critical capability can't move
 * until that capability leaves the API (critical is never granted through it, G.8). M5-MODE-1 also
 * fails when a built-in shows 0 and is left out, so the list can't silently fall behind.
 *
 * Extension hosts (`vscode.volt`) are always enforced; this list is only for trusted-core code.
 *
 * Still in report mode (each has a would-be denial in M5-MODE-1 today): agent-resources,
 * automations, claude-accounts, commit-review, computer-use, devices, memory, pull-requests,
 * visuals.
 */
export const FIRST_PARTY_ENFORCED: ReadonlySet<string> = new Set([
	'volt.browser',
	'volt.code-intelligence',
	'volt.customize',
	'volt.git-graph',
	'volt.playgrounds',
	'volt.remote-devices',
	'volt.scratch-board',
	'volt.skills-and-plugins',
	'volt.usage',
	// The 12 providers: each declares only its own secret (or loopback ports, or openrouter.ai).
	'volt.provider-antigravity',
	'volt.provider-claude',
	'volt.provider-codex',
	'volt.provider-cursor',
	'volt.provider-fx',
	'volt.provider-grok',
	'volt.provider-kimi',
	'volt.provider-local',
	'volt.provider-muse',
	'volt.provider-opencode',
	'volt.provider-openrouter',
	'volt.provider-pi',
]);

/** `enforce` or `report` for a built-in's in-process `volt` API calls (M5). */
export function firstPartyCapabilityMode(extensionId: string): 'enforce' | 'report' {
	return FIRST_PARTY_ENFORCED.has(extensionId.toLowerCase()) && !!firstPartyCeiling(extensionId) ? 'enforce' : 'report';
}

/** The ceiling of a built-in extension; undefined for any extension the table doesn't name. */
export function firstPartyCeiling(extensionId: string): readonly IVoltCeilingEntry[] | undefined {
	const key = extensionId.toLowerCase();
	return Object.prototype.hasOwnProperty.call(FIRST_PARTY_CEILINGS, key) ? FIRST_PARTY_CEILINGS[key] : undefined;
}

function bare(id: string): string {
	return id.replace(/@\d+$/, '');
}

/** `*` matches any run of characters. */
function matches(pattern: string, value: string): boolean {
	if (!pattern.includes('*')) {
		return pattern === value;
	}
	const escaped = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
	return new RegExp(`^${escaped}$`).test(value);
}

/** Whether a ceiling entry's id holds `capability` (`secrets.use:*` holds `secrets.use:github`). */
function idCovers(entry: string, capability: string): boolean {
	const id = bare(entry);
	const wanted = bare(capability);
	return id === wanted || (id.endsWith(':*') && wanted.startsWith(id.slice(0, -1)));
}

/** Whether the ceiling of `extensionId` allows `capability` on `target`. Pure; false for an extension with no ceiling. */
export function ceilingCovers(extensionId: string, capability: string, target: string | undefined): boolean {
	const ceiling = firstPartyCeiling(extensionId);
	return !!ceiling?.some(entry => idCovers(entry.id, capability)
		&& (!entry.targets?.length || (target !== undefined && entry.targets.some(pattern => matches(pattern, target)))));
}

/**
 * What a built-in's manifest declares beyond its ceiling, one line each: the CI check and the
 * load-time tamper backstop. Empty: the manifest is within its ceiling.
 */
export function declarationsOutsideCeiling(extensionId: string, declarations: readonly { readonly id: string; readonly targets?: readonly string[] }[]): string[] {
	const ceiling = firstPartyCeiling(extensionId);
	if (!ceiling) {
		return declarations.length ? [`${extensionId} has no first-party ceiling`] : [];
	}
	const problems: string[] = [];
	for (const declared of declarations) {
		// A family (`secrets.use:*`) is held only by a family entry; `idCovers` never widens the other way.
		const within = ceiling.filter(entry => idCovers(entry.id, declared.id)).some(entry => {
			if (!entry.targets?.length) {
				return true;
			}
			// A declaration with no targets asks for every target, which a limited entry doesn't hold.
			return !!declared.targets?.length && declared.targets.every(target => entry.targets!.some(pattern => matches(pattern, target)));
		});
		if (!within) {
			problems.push(`${extensionId} declares ${declared.id}${declared.targets?.length ? ` on ${declared.targets.join(', ')}` : ''} beyond its first-party ceiling`);
		}
	}
	return problems;
}
