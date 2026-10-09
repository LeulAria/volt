/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltTokenRates } from '../../../../../platform/voltUsage/common/voltUsage.js';

/**
 * What one chat has spent: tokens and cost per turn and per model, for the Session Usage panel
 * beside the context meter. The context meter says how full the window is now; this sums what
 * every turn was billed for. A turn's cost is what the agent reported (Claude's ACP session
 * cost), else its tokens at the model's list price, else unknown.
 */

export type SessionSpendKind = 'input' | 'cacheRead' | 'cacheWrite' | 'output';

/** Display order: the prompt side first, then what the model wrote. */
export const SESSION_SPEND_KINDS: readonly SessionSpendKind[] = ['input', 'cacheRead', 'cacheWrite', 'output'];

export type SessionSpend = Record<SessionSpendKind, number>;

export interface ISessionUsageModelRef {
	readonly ref: string;
	readonly id?: string;
	readonly label?: string;
}

export interface ISessionUsageMessage {
	readonly kind: 'user' | 'agent';
	readonly id?: string;
	readonly text?: string;
	readonly model?: ISessionUsageModelRef;
	readonly spend?: Readonly<SessionSpend>;
	/** Replies recorded before `spend` existed: the last usage report only. */
	readonly tokensIn?: number;
	readonly tokensOut?: number;
	readonly tokensCache?: number;
	readonly costUsd?: number;
	readonly durationMs?: number;
}

export interface ISessionUsageOptions {
	/** List prices by model id; undefined when unknown. */
	readonly rates: (modelId: string) => IVoltTokenRates | undefined;
	/** Today's catalog entry for a ref, for replies that did not record their label or id. */
	readonly describe?: (ref: string) => { readonly id?: string; readonly label?: string } | undefined;
	/** The chat's model, for replies recorded before turns kept theirs. */
	readonly fallbackModel?: ISessionUsageModelRef;
}

export interface ISessionUsageTurn {
	/** 1-based position among the chat's prompts. */
	readonly index: number;
	readonly turnId?: string;
	/** First line of the prompt, for the chart's readout. */
	readonly prompt: string;
	readonly modelKey: string;
	readonly modelLabel: string;
	readonly tokens: SessionSpend;
	readonly total: number;
	/** Undefined when neither the agent nor the price list gave a price. */
	readonly costUsd?: number;
	/** `costUsd` split by token kind at list rates (scaled to a reported cost); absent without rates. */
	readonly costByKind?: SessionSpend;
	/** The agent reported the cost; otherwise it is a list-price estimate. */
	readonly reported: boolean;
	readonly durationMs?: number;
}

export interface ISessionUsageModelRow {
	readonly key: string;
	readonly label: string;
	readonly turns: number;
	readonly tokens: SessionSpend;
	readonly total: number;
	readonly costUsd: number;
	readonly unpricedTurns: number;
}

export interface ISessionUsageSummary {
	readonly turns: readonly ISessionUsageTurn[];
	/** Most expensive first, then most tokens. */
	readonly models: readonly ISessionUsageModelRow[];
	readonly tokens: SessionSpend;
	readonly total: number;
	readonly costUsd: number;
	/** Cost split by token kind, over the turns whose split is known. */
	readonly costByKind: SessionSpend;
	readonly unpricedTurns: number;
	readonly reportedTurns: number;
}

export function emptySpend(): SessionSpend {
	return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

function spendTotal(spend: SessionSpend): number {
	return spend.input + spend.cacheRead + spend.cacheWrite + spend.output;
}

function addSpend(into: SessionSpend, add: SessionSpend): void {
	for (const kind of SESSION_SPEND_KINDS) {
		into[kind] += add[kind];
	}
}

function count(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function messageSpend(message: ISessionUsageMessage): SessionSpend {
	if (message.spend) {
		return { input: count(message.spend.input), cacheRead: count(message.spend.cacheRead), cacheWrite: count(message.spend.cacheWrite), output: count(message.spend.output) };
	}
	return { input: count(message.tokensIn), cacheRead: count(message.tokensCache), cacheWrite: 0, output: count(message.tokensOut) };
}

function promptLine(text: string | undefined): string {
	const line = (text ?? '').trim().split('\n', 1)[0].trim();
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** A reported cost wins; list rates then only split it by token kind. */
function priceTurn(tokens: SessionSpend, rates: IVoltTokenRates | undefined, reported: number | undefined): { costUsd?: number; costByKind?: SessionSpend } {
	const list = rates ? { input: tokens.input * rates.input, cacheRead: tokens.cacheRead * rates.cacheRead, cacheWrite: tokens.cacheWrite * rates.cacheWrite, output: tokens.output * rates.output } : undefined;
	const listCost = list ? spendTotal(list) : 0;
	if (reported !== undefined) {
		if (!list || listCost <= 0) {
			return { costUsd: reported };
		}
		const scale = reported / listCost;
		return { costUsd: reported, costByKind: { input: list.input * scale, cacheRead: list.cacheRead * scale, cacheWrite: list.cacheWrite * scale, output: list.output * scale } };
	}
	return list ? { costUsd: listCost, costByKind: list } : {};
}

export function buildSessionUsage(messages: readonly ISessionUsageMessage[], options: ISessionUsageOptions): ISessionUsageSummary {
	const turns: ISessionUsageTurn[] = [];
	const models = new Map<string, { key: string; label: string; turns: number; tokens: SessionSpend; costUsd: number; unpricedTurns: number }>();
	const tokens = emptySpend();
	const costByKind = emptySpend();
	let costUsd = 0;
	let unpricedTurns = 0;
	let reportedTurns = 0;
	let prompts = 0;
	let prompt: ISessionUsageMessage | undefined;

	for (const message of messages) {
		if (message.kind === 'user') {
			prompts++;
			prompt = message;
			continue;
		}
		const spent = messageSpend(message);
		const reported = message.costUsd !== undefined && Number.isFinite(message.costUsd) && message.costUsd >= 0 ? message.costUsd : undefined;
		if (spendTotal(spent) <= 0 && !reported) {
			continue;
		}
		const ref = message.model ?? options.fallbackModel;
		const today = ref ? options.describe?.(ref.ref) : undefined;
		const modelId = ref?.id ?? today?.id;
		const modelKey = ref?.ref ?? 'unknown';
		const modelLabel = ref?.label ?? today?.label ?? modelId ?? 'Unknown model';
		const price = priceTurn(spent, modelId ? options.rates(modelId) : undefined, reported);
		const turn: ISessionUsageTurn = {
			index: Math.max(prompts, 1),
			turnId: message.id ?? prompt?.id,
			prompt: promptLine(prompt?.text),
			modelKey,
			modelLabel,
			tokens: spent,
			total: spendTotal(spent),
			...price,
			reported: reported !== undefined,
			...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
		};
		turns.push(turn);

		addSpend(tokens, spent);
		if (turn.costUsd !== undefined) {
			costUsd += turn.costUsd;
		} else {
			unpricedTurns++;
		}
		if (turn.costByKind) {
			addSpend(costByKind, turn.costByKind);
		}
		if (turn.reported) {
			reportedTurns++;
		}
		let row = models.get(modelKey);
		if (!row) {
			row = { key: modelKey, label: modelLabel, turns: 0, tokens: emptySpend(), costUsd: 0, unpricedTurns: 0 };
			models.set(modelKey, row);
		}
		row.label = modelLabel;
		row.turns++;
		addSpend(row.tokens, spent);
		row.costUsd += turn.costUsd ?? 0;
		if (turn.costUsd === undefined) {
			row.unpricedTurns++;
		}
	}

	const modelRows = [...models.values()]
		.map(row => ({ ...row, total: spendTotal(row.tokens) }))
		.sort((a, b) => b.costUsd - a.costUsd || b.total - a.total);
	return { turns, models: modelRows, tokens, total: spendTotal(tokens), costUsd, costByKind, unpricedTurns, reportedTurns };
}

/** The model ids whose prices the summary needs. */
export function sessionModelIds(messages: readonly ISessionUsageMessage[], options: Pick<ISessionUsageOptions, 'describe' | 'fallbackModel'>): string[] {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.kind !== 'agent') {
			continue;
		}
		const ref = message.model ?? options.fallbackModel;
		const id = ref?.id ?? (ref ? options.describe?.(ref.ref)?.id : undefined);
		if (id) {
			ids.add(id);
		}
	}
	return [...ids];
}
