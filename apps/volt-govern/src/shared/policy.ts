/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentCliId } from './providers.js';

/**
 * A policy document is attached to a scope: the organization, a team, or one member. A developer's
 * effective policy is every layer that applies to them merged so that a lower layer can only
 * narrow what a higher one allows: allow lists intersect, deny lists add up, switches AND, limits
 * take the smallest. Budgets are not merged; each scope's budget is checked against that scope's
 * own spend.
 */
export type AccessPreset = 'supervised' | 'auto-edits' | 'auto' | 'full';
export const ACCESS_PRESETS: readonly { readonly id: AccessPreset; readonly label: string }[] = [
	{ id: 'supervised', label: 'Supervised' },
	{ id: 'auto-edits', label: 'Auto-accept edits' },
	{ id: 'auto', label: 'Auto' },
	{ id: 'full', label: 'Full access' },
];

export type DlpAction = 'redact' | 'block';

export interface IDlpPattern {
	readonly name: string;
	/** A JavaScript regular expression source, matched globally and case-sensitively. */
	readonly regex: string;
	readonly action: DlpAction;
}

export interface IPolicyDocument {
	readonly models?: {
		/** `provider/model` globs. Absent: everything the organization's keys offer. */
		readonly allow?: readonly string[];
		readonly deny?: readonly string[];
	};
	readonly capabilities?: {
		/** The most permissive access preset a developer may pick in Volt. */
		readonly maxAccessPreset?: AccessPreset;
		readonly shell?: boolean;
		readonly webAccess?: boolean;
		readonly browser?: boolean;
		/** Agent CLIs Volt may launch. Absent: all. */
		readonly agents?: readonly AgentCliId[];
		/** Whether developers may also sign in to agents with their own accounts or keys. */
		readonly personalAccounts?: boolean;
	};
	readonly mcp?: {
		/** `allowlist`: only approved servers in `allow`. `blocklist`: everything but `deny`. */
		readonly mode?: 'allowlist' | 'blocklist';
		/** `server` or `server:tool` globs. */
		readonly allow?: readonly string[];
		readonly deny?: readonly string[];
		/** What the gateway does with a blocked MCP tool found in a model request. */
		readonly enforcement?: 'strip' | 'block';
	};
	readonly skills?: {
		/** Published org skills every developer in scope receives. */
		readonly required?: readonly string[];
		/** Whether developers' own skills/rules (repo or home folder) load too. */
		readonly allowLocal?: boolean;
	};
	readonly data?: {
		readonly redactSecrets?: boolean;
		readonly dlpPatterns?: readonly IDlpPattern[];
		/** Path globs agents may not read or send (`.env*`, `**\/secrets/**`). */
		readonly blockedPaths?: readonly string[];
	};
	readonly budget?: {
		readonly monthlyUsd?: number;
		readonly monthlyTokens?: number;
		readonly onExceed?: 'block' | 'alert';
	};
	readonly limits?: {
		readonly requestsPerMinute?: number;
		readonly maxOutputTokens?: number;
	};
}

export type ScopeType = 'org' | 'team' | 'user';

export interface IPolicyLayer {
	readonly scopeType: ScopeType;
	readonly scopeId: string;
	readonly label: string;
	readonly document: IPolicyDocument;
}

export interface IEffectivePolicy {
	readonly models: { readonly allow?: readonly (readonly string[])[]; readonly deny: readonly string[] };
	readonly capabilities: {
		readonly maxAccessPreset: AccessPreset;
		readonly shell: boolean;
		readonly webAccess: boolean;
		readonly browser: boolean;
		readonly agents?: readonly AgentCliId[];
		readonly personalAccounts: boolean;
	};
	readonly mcp: { readonly mode: 'allowlist' | 'blocklist'; readonly allow?: readonly (readonly string[])[]; readonly deny: readonly string[]; readonly enforcement: 'strip' | 'block' };
	readonly skills: { readonly required: readonly string[]; readonly allowLocal: boolean };
	readonly data: { readonly redactSecrets: boolean; readonly dlpPatterns: readonly IDlpPattern[]; readonly blockedPaths: readonly string[] };
	readonly limits: { readonly requestsPerMinute?: number; readonly maxOutputTokens?: number };
	/** Each layer's budget, for checking against that layer's spend. */
	readonly budgets: readonly { readonly scopeType: ScopeType; readonly scopeId: string; readonly label: string; readonly budget: NonNullable<IPolicyDocument['budget']> }[];
	/** Which layer set each tightened value, for "why can't I" answers. */
	readonly sources: readonly string[];
}

/** Defaults when no layer says otherwise: safe for an enterprise, usable on day one. */
export const DEFAULT_ORG_POLICY: IPolicyDocument = {
	capabilities: { maxAccessPreset: 'auto-edits', shell: true, webAccess: true, browser: true, personalAccounts: false },
	mcp: { mode: 'allowlist', allow: [], deny: [], enforcement: 'strip' },
	skills: { required: [], allowLocal: true },
	data: { redactSecrets: true, dlpPatterns: [], blockedPaths: ['**/.env', '**/.env.*', '**/*.pem', '**/id_rsa*', '**/secrets/**'] },
	budget: { onExceed: 'alert' },
};

const PRESET_RANK: Record<AccessPreset, number> = { supervised: 0, 'auto-edits': 1, auto: 2, full: 3 };

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
	return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

export function mergePolicy(layers: readonly IPolicyLayer[]): IEffectivePolicy {
	const modelAllow: (readonly string[])[] = [];
	const modelDeny: string[] = [];
	const mcpAllow: (readonly string[])[] = [];
	const mcpDeny: string[] = [];
	const required = new Set<string>();
	const dlp: IDlpPattern[] = [];
	const blockedPaths = new Set<string>();
	const sources: string[] = [];
	let preset: AccessPreset = 'full';
	let shell = true, webAccess = true, browser = true, personalAccounts = true, allowLocal = true, redactSecrets = false;
	let agents: AgentCliId[] | undefined;
	let mcpMode: 'allowlist' | 'blocklist' = 'blocklist';
	let enforcement: 'strip' | 'block' = 'strip';
	let rpm: number | undefined, maxOut: number | undefined;
	const budgets: IEffectivePolicy['budgets'][number][] = [];

	for (const layer of layers) {
		const d = layer.document;
		if (d.models?.allow) {
			modelAllow.push(d.models.allow);
			sources.push(`models.allow ← ${layer.label}`);
		}
		modelDeny.push(...(d.models?.deny ?? []));
		const c = d.capabilities;
		if (c?.maxAccessPreset && PRESET_RANK[c.maxAccessPreset] < PRESET_RANK[preset]) {
			preset = c.maxAccessPreset;
			sources.push(`capabilities.maxAccessPreset ← ${layer.label}`);
		}
		if (c?.shell === false) { shell = false; }
		if (c?.webAccess === false) { webAccess = false; }
		if (c?.browser === false) { browser = false; }
		if (c?.personalAccounts === false) { personalAccounts = false; }
		if (c?.agents) {
			agents = agents ? agents.filter(a => c.agents!.includes(a)) : [...c.agents];
		}
		if (d.mcp?.mode === 'allowlist') {
			mcpMode = 'allowlist';
		}
		if (d.mcp?.allow && (d.mcp.mode === 'allowlist' || mcpMode === 'allowlist')) {
			mcpAllow.push(d.mcp.allow);
		}
		mcpDeny.push(...(d.mcp?.deny ?? []));
		if (d.mcp?.enforcement === 'block') {
			enforcement = 'block';
		}
		d.skills?.required?.forEach(s => required.add(s));
		if (d.skills?.allowLocal === false) { allowLocal = false; }
		if (d.data?.redactSecrets) { redactSecrets = true; }
		dlp.push(...(d.data?.dlpPatterns ?? []));
		d.data?.blockedPaths?.forEach(p => blockedPaths.add(p));
		if (d.budget && (d.budget.monthlyUsd !== undefined || d.budget.monthlyTokens !== undefined)) {
			budgets.push({ scopeType: layer.scopeType, scopeId: layer.scopeId, label: layer.label, budget: d.budget });
		}
		rpm = minDefined(rpm, d.limits?.requestsPerMinute);
		maxOut = minDefined(maxOut, d.limits?.maxOutputTokens);
	}

	return {
		models: { allow: modelAllow.length ? modelAllow : undefined, deny: modelDeny },
		capabilities: { maxAccessPreset: preset, shell, webAccess, browser, agents, personalAccounts },
		mcp: { mode: mcpMode, allow: mcpMode === 'allowlist' ? mcpAllow : undefined, deny: mcpDeny, enforcement },
		skills: { required: [...required], allowLocal },
		data: { redactSecrets, dlpPatterns: dlp, blockedPaths: [...blockedPaths] },
		limits: { requestsPerMinute: rpm, maxOutputTokens: maxOut },
		budgets,
		sources,
	};
}

/** `*` matches within a segment (no `/` or `:`), `**` matches anything. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === '*') {
			if (glob[i + 1] === '*') {
				out += '.*';
				i++;
			} else {
				out += '[^/:]*';
			}
		} else if (ch === '?') {
			out += '[^/:]';
		} else {
			out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${out}$`, 'i');
}

export function matchesAny(value: string, globs: readonly string[] | undefined): boolean {
	return !!globs?.some(g => globToRegExp(g).test(value));
}

export interface IVerdict {
	readonly allowed: boolean;
	readonly reason?: string;
}

/** `provider/model` against the effective model rules. */
export function checkModel(policy: IEffectivePolicy, qualified: string): IVerdict {
	if (matchesAny(qualified, policy.models.deny)) {
		return { allowed: false, reason: `${qualified} is blocked by policy` };
	}
	const failing = policy.models.allow?.find(list => !matchesAny(qualified, list));
	if (failing) {
		return { allowed: false, reason: `${qualified} is not in the allowed models` };
	}
	return { allowed: true };
}

/** An MCP server, or one of its tools, against the effective MCP rules. */
export function checkMcp(policy: IEffectivePolicy, server: string, tool?: string): IVerdict {
	const label = tool ? `${server}:${tool}` : server;
	const names = tool ? [server, label] : [server];
	if (names.some(n => matchesAny(n, policy.mcp.deny))) {
		return { allowed: false, reason: `MCP ${label} is blocked` };
	}
	if (policy.mcp.mode === 'allowlist') {
		const lists = policy.mcp.allow ?? [];
		// A server is reachable when any entry names it; its tools must each be named.
		const inList = (list: readonly string[]) => names.some(n => matchesAny(n, list))
			|| (!tool && list.some(g => g.toLowerCase().startsWith(`${server.toLowerCase()}:`)));
		if (!lists.length || !lists.every(inList)) {
			return { allowed: false, reason: `MCP ${label} is not approved` };
		}
	}
	return { allowed: true };
}

/**
 * The MCP server and tool in a model-visible tool name. Claude Code and Volt use
 * `mcp__<server>__<tool>`; Codex and others prefix the server alone, which only counts when the
 * server is one the organization knows.
 */
export function parseMcpToolName(name: string, knownServers: readonly string[]): { readonly server: string; readonly tool: string } | undefined {
	const m = /^mcp__(.+?)__(.+)$/.exec(name);
	if (m) {
		return { server: m[1], tool: m[2] };
	}
	for (const server of knownServers) {
		for (const sep of ['__', '.', ':']) {
			if (name.toLowerCase().startsWith(`${server.toLowerCase()}${sep}`)) {
				return { server, tool: name.slice(server.length + sep.length) };
			}
		}
	}
	return undefined;
}
