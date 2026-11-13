/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { firstPartyCeiling } from '../../../../platform/voltPlugins/common/firstPartyCeilings.js';
import type { IAgentOverlaySpec } from '../../../../platform/voltSandbox/common/agentState.js';
import { VOLT_BUILTIN_AGENTS } from './voltBuiltinAgents.generated.js';
import { IVoltAgentContribution, IVoltCapabilityDeclaration, validateVoltContribution, VOLT_AGENTS_EXTENSION_POINT, VoltAgentAuthProbe } from './voltContributions.js';

/**
 * Providers as data (spec H.12, M2): the agent CLIs Volt runs, built from the built-in provider
 * extensions' `contributes.voltAgents`. The manifests are compiled into core at build time
 * (`voltBuiltinAgents.generated.ts`, checked equal to `extensions/volt-provider-*` by
 * `voltFeatureExtensions.test.ts`), and the shipped manifests are checked against
 * `builtin-manifest.json` when the app loads them (H.10).
 *
 * Only a `volt.*` built-in with a first-party ceiling contributes an agent Volt runs. A third
 * party's `voltAgents` entry is never launched: it is accepted only as the capability requests
 * it implies (`thirdPartyAgentRequests`), which the Policy Authority judges like any other.
 */

/** One agent CLI, as data: `cliAgents.ts` adds the core sign-in probe it names. */
export interface IVoltAgentDefinitionData {
	/** The runtime provider id (`claude-code`). */
	readonly id: string;
	/** The model picker's family (`claude`). */
	readonly family: string;
	/** The built-in extension it comes from. */
	readonly extensionId: string;
	readonly label: string;
	/** Executables to look for, in order of preference. */
	readonly commands: readonly string[];
	readonly versionArgs: readonly string[];
	readonly acpArgs: readonly string[];
	readonly earlyAccess?: boolean;
	readonly acpAdapter?: { readonly command: string; readonly package: string };
	readonly acpEnv?: Readonly<Record<string, string>>;
	readonly authProbe?: VoltAgentAuthProbe;
	readonly login?: readonly string[];
}

export interface IVoltBuiltinAgentSource {
	readonly extensionId: string;
	readonly agents: readonly IVoltAgentContribution[];
}

/** Whether `extensionId` may contribute agents Volt runs: a `volt.*` built-in with a compiled ceiling. */
export function mayContributeAgents(extensionId: string): boolean {
	return extensionId.toLowerCase().startsWith('volt.') && !!firstPartyCeiling(extensionId);
}

/**
 * The agent CLIs of the built-in manifests, in manifest order. An entry with no binary is an API
 * provider (OpenRouter, local models), not a CLI. A source that may not contribute agents, or
 * whose entries don't validate, is left out whole.
 */
export function builtinAgentDefinitions(sources: readonly IVoltBuiltinAgentSource[] = VOLT_BUILTIN_AGENTS): IVoltAgentDefinitionData[] {
	const definitions: { readonly data: IVoltAgentDefinitionData; readonly order: number }[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		if (!mayContributeAgents(source.extensionId) || validateVoltContribution(VOLT_AGENTS_EXTENSION_POINT, source.agents).length) {
			continue;
		}
		for (const agent of source.agents) {
			const id = agent.provider ?? agent.id;
			if (!agent.binary || seen.has(id)) {
				continue;
			}
			seen.add(id);
			const data: IVoltAgentDefinitionData = {
				id,
				family: agent.id,
				extensionId: source.extensionId,
				label: agent.label ?? agent.id,
				commands: [agent.binary, ...agent.fallbackBinaries ?? []],
				versionArgs: agent.versionArgs ?? ['--version'],
				acpArgs: agent.args ?? [],
				...(agent.earlyAccess ? { earlyAccess: true } : {}),
				...(agent.acpAdapter ? { acpAdapter: { command: agent.acpAdapter.command, package: agent.acpAdapter.package } } : {}),
				...(agent.env && Object.keys(agent.env).length ? { acpEnv: { ...agent.env } } : {}),
				...(agent.authProbe ? { authProbe: agent.authProbe } : {}),
				...(agent.login ? { login: [...agent.login] } : {}),
			};
			definitions.push({ order: agent.order ?? Number.MAX_SAFE_INTEGER, data });
		}
	}
	// Stable: equal orders keep manifest order.
	return definitions.sort((a, b) => a.order - b.order).map(entry => entry.data);
}

/** The built-in contribution of one runtime provider id, if a built-in declares it. */
export function builtinAgentContribution(providerId: string, sources: readonly IVoltBuiltinAgentSource[] = VOLT_BUILTIN_AGENTS): IVoltAgentContribution | undefined {
	for (const source of sources) {
		const agent = source.agents.find(entry => (entry.provider ?? entry.id) === providerId);
		if (agent && mayContributeAgents(source.extensionId)) {
			return agent;
		}
	}
	return undefined;
}

/** A manifest's overlay fields as `agentState.ts` spells them; undefined when it declares no overlay. */
export function agentOverlayFromContribution(agent: IVoltAgentContribution): IAgentOverlaySpec | undefined {
	const state = agent.state;
	if (!state?.configOverlay || !state.configHome) {
		return undefined;
	}
	return {
		env: state.configOverlay,
		home: state.configHome,
		link: state.link ?? [],
		seed: (state.seed ?? []).map(seed => ({ name: seed.name, from: seed.from, mergeBack: seed.mergeBack })),
		...(state.loginFiles ? { credentials: state.loginFiles.map(file => ({ name: file.name, freshness: file.freshness, identity: file.identity })) } : {}),
		...(state.secureStorage ? { secureStorage: { ...state.secureStorage } } : {}),
		...(state.setEnv ? { setEnv: { ...state.setEnv } } : {}),
	};
}

/** A manifest's footprint fields as `sandboxPolicy.ts` spells them (`tmpDirs` filled in for `uid`). */
export function agentFootprintFromContribution(agent: IVoltAgentContribution, uid: number | undefined): {
	readonly writable: readonly string[];
	readonly writableFiles?: readonly string[];
	readonly readable: readonly string[];
	readonly credentials?: readonly string[];
	readonly tmpDirs?: readonly string[];
	readonly domains: readonly string[];
	readonly envKeys?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly quietPaths?: { readonly processes: readonly string[]; readonly paths: readonly string[]; readonly readPaths?: readonly string[] };
} {
	const state = agent.state ?? {};
	return {
		writable: state.writable ?? [],
		...(state.writableFiles ? { writableFiles: state.writableFiles } : {}),
		readable: state.readable ?? [],
		...(state.credentials ? { credentials: state.credentials } : {}),
		...(state.tmpDirs ? { tmpDirs: state.tmpDirs.map(dir => dir.replace(/\$\{uid\}/g, String(uid ?? 0))) } : {}),
		domains: agent.apiHosts ?? [],
		...(state.envKeys ? { envKeys: state.envKeys } : {}),
		...(state.env ? { env: { ...state.env } } : {}),
		...(state.quietPaths ? { quietPaths: { processes: [...state.quietPaths.processes], paths: [...state.quietPaths.paths], ...(state.quietPaths.readPaths ? { readPaths: [...state.quietPaths.readPaths] } : {}) } } : {}),
	};
}

/**
 * What a third party's `voltAgents` entry amounts to: requests, never a launch. Its API hosts are
 * `net.connect` requests on those hosts; the rest (binary, args, state) is ignored, because only
 * core's compiled tables decide what an agent process may touch.
 */
export function thirdPartyAgentRequests(agent: IVoltAgentContribution): IVoltCapabilityDeclaration[] {
	return agent.apiHosts?.length ? [{ id: 'net.connect', class: 'low', targets: [...agent.apiHosts], reason: `API hosts of the ${agent.label ?? agent.id} agent` }] : [];
}
