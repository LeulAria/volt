/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { bareCapability } from '../../voltPlugins/common/capabilityCatalog.js';
import { GrantStoreStatus, IGrant, IRefusal } from './grants.js';
import { GESTURE_TOKEN_TTL_MS, isPluginSubject, IUserGestureToken, parseSubjectKey, SubjectKey, subjectExtensionId } from './principals.js';

/**
 * The permission UX's shared model (spec P4, G.4, G.7, G.12): what the window reads of the grant
 * store, the history it shows beside it (the Authority's decision log and the brokers' audit
 * logs), the prompt budget, gesture tokens and the signer pin. Pure: the store itself is
 * `node/grantStore.ts`, the windows reach it through the execution host (`IVoltStdioService`).
 */

/** A grant to add: its epoch is the commit's. */
export type TrustGrantDraft = Omit<IGrant, 'epoch'>;

/** The grant store as a window sees it. */
export interface ITrustState {
	readonly epoch: number;
	/** `torn`: permissions were reset (the Security page says so). */
	readonly status: GrantStoreStatus;
	readonly readOnly: boolean;
	readonly notes: readonly string[];
	readonly grants: readonly IGrant[];
	readonly refusals: readonly IRefusal[];
}

export const EMPTY_TRUST_STATE: ITrustState = Object.freeze({ epoch: 0, status: 'missing', readOnly: false, notes: [], grants: [], refusals: [] });

/** What a window may ask the store to change. */
export interface ITrustChange {
	readonly add?: readonly TrustGrantDraft[];
	/** Grant ids to remove. */
	readonly revoke?: readonly string[];
	readonly refuse?: readonly IRefusal[];
	/** Refusals to forget (the user allowed it after all). */
	readonly unrefuse?: readonly { readonly subject: SubjectKey; readonly capability: string }[];
	/** Every grant and refusal of these subjects goes (a signer change, an uninstall). */
	readonly dropSubjects?: readonly SubjectKey[];
}

export interface ITrustCommitResult {
	readonly epoch: number;
	readonly changed: boolean;
}

/**
 * A window's change, checked before it reaches the store: only user grants (an admin's or a
 * preset's never come from a window), never a first-party subject (its ceiling is compiled in),
 * never the `user` subject. Undefined when it is acceptable, else why not.
 */
export function trustChangeRefusal(change: ITrustChange): string | undefined {
	for (const draft of change.add ?? []) {
		if (draft.source !== 'user') {
			return `a window may only record the user's own grants, not ${draft.source} ones`;
		}
		const subject = parseSubjectKey(draft.subject);
		if (!subject || subject === 'user' || subject.startsWith('firstparty:')) {
			return `${draft.subject} can't be granted anything by the user`;
		}
	}
	return undefined;
}

// --- history: the decision log and the audit logs -----------------------------------------------

export type TrustHistorySource = 'network' | 'broker' | 'decision';

/** One line of the Access page's history. */
export interface ITrustHistoryEntry {
	readonly at: number;
	readonly source: TrustHistorySource;
	readonly subject: SubjectKey;
	/** The capability asked for, or the broker and method (`files.read`, `CONNECT`). */
	readonly action: string;
	/** A host, or a salted hash for the brokers' targets (they never log the path). */
	readonly target?: string;
	readonly decision: 'allow' | 'deny' | 'close';
	readonly reason?: string;
	readonly epoch?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseLine(line: string): Record<string, unknown> | undefined {
	try {
		return record(JSON.parse(line));
	} catch {
		return undefined;
	}
}

function subjectOf(value: unknown): SubjectKey | undefined {
	return typeof value === 'string' ? parseSubjectKey(value) : undefined;
}

/** A line of `~/.volt/trust/audit/network.log` (the network broker, C3). */
export function parseNetworkAuditLine(line: string): ITrustHistoryEntry | undefined {
	const raw = parseLine(line);
	const subject = subjectOf(raw?.subject);
	if (!raw || !subject || typeof raw.ts !== 'number' || (raw.decision !== 'allow' && raw.decision !== 'deny' && raw.decision !== 'close')) {
		return undefined;
	}
	const port = typeof raw.port === 'number' ? raw.port : undefined;
	const destination = typeof raw.destination === 'string' ? raw.destination : undefined;
	return {
		at: raw.ts,
		source: 'network',
		subject,
		action: typeof raw.method === 'string' ? raw.method : 'CONNECT',
		...(destination ? { target: port && port !== 443 && port !== 80 ? `${destination}:${port}` : destination } : {}),
		decision: raw.decision,
		...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
		...(typeof raw.epoch === 'number' ? { epoch: raw.epoch } : {}),
	};
}

/** A line of `~/.volt/trust/audit/brokers.log` (files, secrets, git and terminals brokers, P3). */
export function parseBrokerAuditLine(line: string): ITrustHistoryEntry | undefined {
	const raw = parseLine(line);
	const subject = subjectOf(raw?.subject);
	if (!raw || !subject || typeof raw.ts !== 'number' || (raw.decision !== 'allow' && raw.decision !== 'deny')) {
		return undefined;
	}
	return {
		at: raw.ts,
		source: 'broker',
		subject,
		action: `${typeof raw.broker === 'string' ? raw.broker : 'broker'}.${typeof raw.method === 'string' ? raw.method : '?'}`,
		...(typeof raw.target === 'string' ? { target: raw.target } : {}),
		decision: raw.decision,
		...(typeof raw.deniedBy === 'string' ? { reason: raw.deniedBy } : typeof raw.code === 'string' ? { reason: raw.code } : {}),
		...(typeof raw.epoch === 'number' ? { epoch: raw.epoch } : {}),
	};
}

/** A `decision` line of `~/.volt/trust/decisions/decisions.log` (the Authority, C2); snapshot lines are skipped. */
export function parseDecisionLogLine(line: string): ITrustHistoryEntry | undefined {
	const raw = parseLine(line);
	if (!raw || raw.type !== 'decision' || typeof raw.at !== 'number') {
		return undefined;
	}
	const request = record(raw.request);
	const decision = record(raw.decision);
	const principal = record(record(raw.context)?.principal);
	const subject = subjectOf(principal?.subject);
	if (!request || !decision || !subject || typeof request.capability !== 'string') {
		return undefined;
	}
	return {
		at: raw.at,
		source: 'decision',
		subject,
		action: request.capability,
		...(typeof request.target === 'string' ? { target: request.target } : {}),
		decision: decision.allow === true ? 'allow' : 'deny',
		...(typeof decision.reason === 'string' && decision.allow !== true ? { reason: decision.reason } : {}),
		...(typeof raw.epoch === 'number' ? { epoch: raw.epoch } : {}),
	};
}

/** The parser for each history file. */
export const TRUST_HISTORY_PARSERS: Readonly<Record<TrustHistorySource, (line: string) => ITrustHistoryEntry | undefined>> = {
	network: parseNetworkAuditLine,
	broker: parseBrokerAuditLine,
	decision: parseDecisionLogLine,
};

/** The newest `limit` entries of every source, newest first; `subject` keeps one subject's. */
export function mergeTrustHistory(sources: readonly (readonly ITrustHistoryEntry[])[], limit: number, subject?: SubjectKey): ITrustHistoryEntry[] {
	return sources.flat().filter(entry => !subject || entry.subject === subject).sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit));
}

// --- the prompt budget (G.12) ---------------------------------------------------------------------

export interface IPromptBudgetLimits {
	readonly perMinute: number;
	readonly perDay: number;
	/** Refusals after which nothing more is offered until the Access page is opened. */
	readonly refusalsToAutoDeny: number;
	/** Prompts within this window are one prompt (coalesced). */
	readonly coalesceMs: number;
}

export const DEFAULT_PROMPT_BUDGET: IPromptBudgetLimits = Object.freeze({ perMinute: 1, perDay: 3, refusalsToAutoDeny: 2, coalesceMs: 2_000 });

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface IPromptBudgetState {
	readonly promptsToday: number;
	readonly refusals: number;
	/** Two refusals: nothing is offered until the Access page is opened. */
	readonly autoDenied: boolean;
	/** The day's or the minute's prompts are spent. */
	readonly exhausted: boolean;
}

/**
 * G.12 per subject: at most one prompt a minute and three a day, prompts within 2 s coalesce into
 * one, and two refusals auto-deny until the Access page is opened ({@link reset}). The network
 * broker keeps the same budget per route (`NetworkRoute.takePrompt`).
 */
export class PromptBudget {

	private readonly prompts = new Map<SubjectKey, number[]>();
	private readonly refusals = new Map<SubjectKey, number>();

	constructor(private readonly limits: IPromptBudgetLimits = DEFAULT_PROMPT_BUDGET, private readonly now: () => number = Date.now) { }

	/** Whether a prompt for `subject` may be shown now; if so it is counted. */
	take(subject: SubjectKey): boolean {
		const now = this.now();
		if ((this.refusals.get(subject) ?? 0) >= this.limits.refusalsToAutoDeny) {
			return false;
		}
		const recent = (this.prompts.get(subject) ?? []).filter(at => now - at < DAY_MS);
		this.prompts.set(subject, recent);
		const last = recent.at(-1);
		if (last !== undefined && now - last < this.limits.coalesceMs) {
			return true;
		}
		if (recent.length >= this.limits.perDay || recent.filter(at => now - at < MINUTE_MS).length >= this.limits.perMinute) {
			return false;
		}
		recent.push(now);
		return true;
	}

	/** The user refused (Skip, Don't Allow). */
	refused(subject: SubjectKey): void {
		this.refusals.set(subject, (this.refusals.get(subject) ?? 0) + 1);
	}

	state(subject: SubjectKey): IPromptBudgetState {
		const now = this.now();
		const recent = (this.prompts.get(subject) ?? []).filter(at => now - at < DAY_MS);
		const refusals = this.refusals.get(subject) ?? 0;
		const last = recent.at(-1);
		const coalescing = last !== undefined && now - last < this.limits.coalesceMs;
		return {
			promptsToday: recent.length,
			refusals,
			autoDenied: refusals >= this.limits.refusalsToAutoDeny,
			exhausted: !coalescing && (recent.length >= this.limits.perDay || recent.filter(at => now - at < MINUTE_MS).length >= this.limits.perMinute),
		};
	}

	/** Subjects with a spent budget (the Authority's `promptBudgetExhausted`). */
	spent(): SubjectKey[] {
		return [...new Set([...this.prompts.keys(), ...this.refusals.keys()])].filter(subject => {
			const state = this.state(subject);
			return state.autoDenied || state.exhausted;
		});
	}

	/** The Access page was opened: prompts may be offered again (G.12). One subject, or all. */
	reset(subject?: SubjectKey): void {
		if (subject) {
			this.prompts.delete(subject);
			this.refusals.delete(subject);
		} else {
			this.prompts.clear();
			this.refusals.clear();
		}
	}
}

// --- gesture tokens (G.7) -------------------------------------------------------------------------

/**
 * Core's record of the gesture tokens its UI minted (G.7): a token counts only if this registry
 * minted it, for that principal, under 1 s ago, and it was not used before. A token is minted
 * only for a real input event inside a Volt-owned element (`gestureTokens.ts` in the window), so a
 * payload, a webview or an extension can't produce one: an object of the same shape is not in the
 * registry.
 */
export class GestureTokenRegistry {

	private readonly live = new Map<string, { readonly principal: string; readonly issuedAt: number }>();
	private counter = 0;

	constructor(private readonly now: () => number = Date.now, private readonly random: () => string = () => Math.random().toString(36).slice(2)) { }

	mint(principal: string): IUserGestureToken {
		const issuedAt = this.now();
		this.sweep(issuedAt);
		const id = `g${++this.counter}.${this.random()}`;
		this.live.set(id, { principal, issuedAt });
		return Object.freeze({ id, principal, issuedAt, consumed: false });
	}

	/** Uses the token for `principal`: true once, for a token this registry minted for it under 1 s ago. */
	consume(token: IUserGestureToken | undefined, principal: string): boolean {
		if (!token || typeof token.id !== 'string') {
			return false;
		}
		const minted = this.live.get(token.id);
		this.live.delete(token.id);
		const now = this.now();
		return !!minted && minted.principal === principal && token.principal === principal && minted.issuedAt === token.issuedAt
			&& now >= minted.issuedAt && now - minted.issuedAt <= GESTURE_TOKEN_TTL_MS;
	}

	private sweep(now: number): void {
		for (const [id, token] of this.live) {
			if (now - token.issuedAt > GESTURE_TOKEN_TTL_MS) {
				this.live.delete(id);
			}
		}
	}
}

// --- signer pinning (G.9) -------------------------------------------------------------------------

/**
 * G.9 "a signer change drops all grants" (TOFU): the subjects of `extensionId` under any signer but
 * `signer` that still hold grants or refusals. Dropping them means the extension starts from
 * nothing, and going back to the old signer doesn't bring them back.
 */
export function signerChangeDrops(state: Pick<ITrustState, 'grants' | 'refusals'>, extensionId: string, signer: string): SubjectKey[] {
	const id = extensionId.toLowerCase();
	const current = `plugin:${id}@${signer}`;
	const subjects = new Set<SubjectKey>();
	for (const entry of [...state.grants, ...state.refusals]) {
		if (isPluginSubject(entry.subject) && entry.subject !== current && subjectExtensionId(entry.subject) === id) {
			subjects.add(entry.subject);
		}
	}
	return [...subjects];
}

// --- the Access page's model ----------------------------------------------------------------------

export type AccessSubjectKind = 'builtin' | 'extension' | 'chat' | 'other';

export interface IAccessSubject {
	readonly subject: SubjectKey;
	readonly kind: AccessSubjectKind;
	readonly label: string;
	readonly grants: readonly IGrant[];
	readonly refusals: readonly IRefusal[];
	/** When a grant was last used or the subject was last allowed something (the history). */
	readonly lastUsedAt?: number;
	/** Built-ins: what Volt's ceiling allows, without prompts. */
	readonly ceiling?: readonly string[];
}

export interface IAccessSubjectInput {
	readonly subject: SubjectKey;
	readonly label: string;
	readonly kind: AccessSubjectKind;
	readonly ceiling?: readonly string[];
}

/**
 * Every subject the Access page lists: the known ones (built-ins with their ceilings, extensions)
 * and every subject the store holds grants or refusals for (chats' standing grants, extensions
 * no longer installed), with the last time each was used.
 */
export function accessSubjects(state: Pick<ITrustState, 'grants' | 'refusals'>, known: readonly IAccessSubjectInput[], history: readonly ITrustHistoryEntry[], label: (subject: SubjectKey) => string): IAccessSubject[] {
	const out = new Map<SubjectKey, IAccessSubjectInput>();
	for (const entry of known) {
		out.set(entry.subject, entry);
	}
	for (const entry of [...state.grants, ...state.refusals]) {
		if (!out.has(entry.subject)) {
			out.set(entry.subject, { subject: entry.subject, label: label(entry.subject), kind: entry.subject.startsWith('chat:') ? 'chat' : isPluginSubject(entry.subject) ? 'extension' : 'other' });
		}
	}
	const used = new Map<SubjectKey, number>();
	for (const entry of history) {
		if (entry.decision === 'allow' && entry.at > (used.get(entry.subject) ?? 0)) {
			used.set(entry.subject, entry.at);
		}
	}
	const order: Record<AccessSubjectKind, number> = { extension: 0, chat: 1, other: 2, builtin: 3 };
	return [...out.values()].map(entry => {
		const grants = state.grants.filter(grant => grant.subject === entry.subject && !grant.revoked);
		const refusals = state.refusals.filter(refusal => refusal.subject === entry.subject);
		const lastUsedAt = Math.max(0, used.get(entry.subject) ?? 0, ...grants.map(grant => grant.lastUsedAt));
		return { ...entry, grants, refusals, ...(lastUsedAt > 0 ? { lastUsedAt } : {}) };
	}).sort((a, b) => order[a.kind] - order[b.kind] || (b.grants.length > 0 ? 1 : 0) - (a.grants.length > 0 ? 1 : 0) || a.label.localeCompare(b.label));
}

/** "net.connect api.linear.app", "agents.send" : how a grant reads in a list. */
export function describeGrantScope(grant: Pick<IGrant, 'capability' | 'scope'>): string {
	const targets = grant.scope.targets?.length ? ` ${grant.scope.targets.join(', ')}` : '';
	const hosts = grant.scope.hosts?.length ? ` (${grant.scope.hosts.includes('*') ? 'any host' : grant.scope.hosts.join(', ')})` : '';
	return `${bareCapability(grant.capability)}${targets}${hosts}`;
}
