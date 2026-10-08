/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { chatUrl, type IAgentChatView } from './agentState.ts';
import { ACTIVE_PHASES, type IWidgetAgent, type IWidgetLimitWindow, type IWidgetProviderUsage, type IWidgetSnapshot, toSeconds } from './model.ts';
import type { IUsageLimitGroupLike, IUsageLimitWindowLike, IUsageReportLike } from './serverShapes.ts';

// The widgets' data: usage limits pooled per provider exactly as the Usage page pools them
// (agentUsageModel.ts poolLimits / limitPace), and the chats that are working or need the user.

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Usage page order. */
const PROVIDER_ORDER = ['claude', 'codex', 'cursor', 'opencode', 'grok'];

const PROVIDER_LABELS: Record<string, string> = {
	claude: 'Claude', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode Go', grok: 'Grok',
};

export interface IPooledWindow extends IUsageLimitWindowLike {
	readonly accounts: number;
}

export interface IPooledProvider {
	readonly provider: string;
	readonly accounts: readonly IUsageLimitGroupLike[];
	readonly windows: readonly IPooledWindow[];
	readonly resetCredits: number;
	readonly checkedAt: number;
}

/**
 * Each provider once, every window averaged over the accounts that report it (two accounts at 20%
 * and 60% leave the pool at 40% of the combined allowance), resets the soonest.
 */
export function poolLimits(groups: readonly IUsageLimitGroupLike[]): IPooledProvider[] {
	const byProvider = new Map<string, IUsageLimitGroupLike[]>();
	for (const group of groups) {
		const list = byProvider.get(group.provider) ?? [];
		list.push(group);
		byProvider.set(group.provider, list);
	}
	const providers = [...PROVIDER_ORDER.filter(p => byProvider.has(p)), ...[...byProvider.keys()].filter(p => !PROVIDER_ORDER.includes(p))];
	return providers.map(provider => {
		const accounts = byProvider.get(provider)!;
		const windows = new Map<string, { first: IUsageLimitWindowLike; used: number; count: number; resetsAt?: number }>();
		for (const account of accounts) {
			for (const window of account.windows) {
				const held = windows.get(window.id);
				if (!held) {
					windows.set(window.id, { first: window, used: window.usedPercent, count: 1, resetsAt: window.resetsAt });
				} else {
					held.used += window.usedPercent;
					held.count++;
					if (window.resetsAt && (!held.resetsAt || window.resetsAt < held.resetsAt)) {
						held.resetsAt = window.resetsAt;
					}
				}
			}
		}
		const reading = accounts.filter(account => !account.error && account.windows.length);
		return {
			provider,
			accounts,
			windows: [...windows.values()].map(({ first, used, count, resetsAt }) => {
				const { resetsAt: _ignored, ...rest } = first;
				return { ...rest, usedPercent: used / count, accounts: count, ...(resetsAt ? { resetsAt } : {}) };
			}),
			resetCredits: accounts.reduce((sum, account) => sum + (account.resetCredits ?? 0), 0),
			checkedAt: Math.min(...(reading.length ? reading : accounts).map(account => account.checkedAt)),
		};
	});
}

/** Usage page pace: ahead of the refill rate, and when the window runs out before it resets. */
export function limitPace(window: IUsageLimitWindowLike, now: number): { readonly ahead: boolean; readonly runsOutInMs?: number } | undefined {
	if (!window.resetsAt || !window.windowMs || window.resetsAt <= now) {
		return undefined;
	}
	const elapsedMs = window.windowMs - (window.resetsAt - now);
	const elapsed = elapsedMs / window.windowMs;
	if (elapsed < 0.03 || elapsed > 1) {
		return undefined;
	}
	const used = window.usedPercent / 100;
	const projected = used / elapsed;
	const ahead = used > elapsed + 0.05;
	if (projected > 1 && used < 1 && used > 0 && elapsed >= 0.15) {
		const runsOutInMs = (1 - used) / (used / elapsedMs);
		if (runsOutInMs < window.resetsAt - now) {
			return { ahead, runsOutInMs };
		}
	}
	return { ahead };
}

/** `5h`, `Week`, `Month`: a window's name where a word fits. */
export function shortWindowLabel(window: IUsageLimitWindowLike): string {
	const ms = window.windowMs;
	if (!ms) {
		return window.label;
	}
	if (Math.abs(ms - 7 * DAY_MS) < HOUR_MS) {
		return 'Week';
	}
	if (ms >= 28 * DAY_MS && ms <= 31 * DAY_MS) {
		return 'Month';
	}
	if (ms % DAY_MS === 0) {
		return `${ms / DAY_MS}d`;
	}
	return `${Math.round(ms / HOUR_MS)}h`;
}

function widgetWindow(window: IPooledWindow, now: number): IWidgetLimitWindow {
	// A window that already reset is back to zero, even if the reading predates the reset.
	const expired = window.resetsAt !== undefined && window.resetsAt <= now;
	const pace = expired ? undefined : limitPace(window, now);
	return {
		id: window.id,
		label: window.label,
		short: shortWindowLabel(window),
		...(window.scope ? { scope: window.scope } : {}),
		usedPercent: expired ? 0 : Math.round(Math.max(0, Math.min(100, window.usedPercent)) * 10) / 10,
		...(window.resetsAt && !expired ? { resetsAt: toSeconds(window.resetsAt) } : {}),
		...(window.windowMs ? { windowSeconds: Math.round(window.windowMs / 1000) } : {}),
		// A projection moves with the clock: rounded to 5 minutes so an unchanged reading doesn't reload widgets.
		...(pace?.runsOutInMs !== undefined ? { runsOutAt: Math.round((now + pace.runsOutInMs) / 300_000) * 300 } : {}),
		...(pace?.ahead ? { ahead: true } : {}),
	};
}

/** Shortest window first (session, then week, then month): the one that bites soonest leads. */
function windowOrder(a: IPooledWindow, b: IPooledWindow): number {
	return (a.windowMs ?? Number.MAX_SAFE_INTEGER) - (b.windowMs ?? Number.MAX_SAFE_INTEGER);
}

export function widgetUsage(report: IUsageReportLike, now: number): IWidgetProviderUsage[] {
	return poolLimits(report.limits).map(pool => {
		const plans = [...new Set(pool.accounts.map(account => account.plan).filter((plan): plan is string => !!plan))];
		const errors = pool.accounts.filter(account => account.error);
		const windows = [...pool.windows].sort(windowOrder).map(window => widgetWindow(window, now));
		return {
			provider: pool.provider,
			label: PROVIDER_LABELS[pool.provider] ?? pool.provider,
			...(plans.length ? { plan: plans.join(' + ') } : {}),
			windows,
			...(pool.resetCredits ? { resetCredits: pool.resetCredits } : {}),
			...(!windows.length && errors.length ? { error: errors[0].error } : {}),
			checkedAt: toSeconds(pool.checkedAt),
		};
	});
}

function widgetAgent(view: IAgentChatView, scheme: string): IWidgetAgent {
	return {
		chatId: view.chatId,
		title: view.title,
		provider: view.provider,
		phase: view.phase,
		...(view.phase === 'input' && view.inputPrompt ? { step: view.inputPrompt } : view.step ? { step: view.step } : {}),
		startedAt: toSeconds(view.startedAt),
		...(view.inputKind ? { inputKind: view.inputKind } : {}),
		...(view.workspace ? { workspace: view.workspace } : {}),
		...(view.model ? { model: view.model } : {}),
		url: chatUrl(view.chatId, scheme),
	};
}

export interface IWidgetSnapshotInput {
	readonly now: number;
	readonly views: readonly IAgentChatView[];
	readonly report?: IUsageReportLike;
	/** When the report was read (ms); the widget says "as of" from here. */
	readonly reportAt?: number;
	readonly connected: boolean;
	readonly scheme?: string;
	/** Recently finished chats stay listed this long. */
	readonly recentMs?: number;
}

export const MAX_WIDGET_AGENTS = 8;

export function widgetSnapshot(input: IWidgetSnapshotInput): IWidgetSnapshot {
	const scheme = input.scheme ?? 'volt';
	const recentMs = input.recentMs ?? 30 * 60_000;
	const active = input.views.filter(view => ACTIVE_PHASES.has(view.phase));
	const weight = (view: IAgentChatView) => view.phase === 'input' ? 0 : ACTIVE_PHASES.has(view.phase) ? 1 : 2;
	const listed = input.views
		.filter(view => ACTIVE_PHASES.has(view.phase) || (view.endedAt !== undefined && input.now - view.endedAt < recentMs))
		.sort((a, b) => weight(a) - weight(b) || (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt) || (a.chatId < b.chatId ? -1 : 1))
		.slice(0, MAX_WIDGET_AGENTS);
	return {
		version: 1,
		generatedAt: toSeconds(input.now),
		server: { ...(input.report?.machineName ? { name: input.report.machineName } : {}), connected: input.connected },
		...(input.report ? { usage: { checkedAt: toSeconds(input.reportAt ?? input.now), providers: widgetUsage(input.report, input.now) } } : {}),
		agents: {
			working: active.filter(view => view.phase !== 'input').length,
			needsInput: active.filter(view => view.phase === 'input').length,
			items: listed.map(view => widgetAgent(view, scheme)),
		},
		links: { home: `${scheme}://`, usage: `${scheme}://settings`, newChat: `${scheme}://chat/new` },
	};
}

/** Equal for snapshots that draw the same, so unchanged data neither rewrites the file nor spends a widget reload. */
export function snapshotFingerprint(snapshot: IWidgetSnapshot): string {
	const { generatedAt: _generated, ...rest } = snapshot;
	return JSON.stringify(rest);
}
