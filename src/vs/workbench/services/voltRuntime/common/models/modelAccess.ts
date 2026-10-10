/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { IVoltEvent } from '../events.js';
import { PredictorTask } from '../prediction/predictorSkill.js';
import { IVoltModelOptions, MODEL_OPTION_REASONING } from './modelOptions.js';
import { IModelMessage, IVoltCatalogItem } from '../providers.js';

/**
 * Narrow model-access seam shared by the Agent Runtime and the Prediction Runtime (D22).
 *
 * The Prediction Runtime depends on this interface only - never on sessions, runs, ACP,
 * or `IAgentRuntimeService.send()`. Tests substitute a fake implementation.
 */
export interface IVoltModelAccess {
	/**
	 * Streams one stateless completion for a catalog ref. Chat-model refs go through the HTTP
	 * provider with `messages` as they are. Agent refs go to the predictor: one text-only ACP
	 * session that knows every `task` from its skill, so it gets only the task and its context.
	 */
	streamModel(ref: string, messages: IModelMessage[], options: IVoltModelOptions | undefined, token: CancellationToken, task?: PredictorTask): AsyncIterable<IVoltEvent>;

	/**
	 * Starts the predictor agent for `ref` ahead of the first request (Volt starting, the Tab model
	 * changing), so no keystroke waits for an agent to boot. A chat-model ref or undefined stops it.
	 */
	warmPredictor(ref: string | undefined): void;

	resolveCatalogItem(ref: string): IVoltCatalogItem | undefined;

	/** The model/agent the user picked in the composer. Persisted across restarts. */
	getActiveCatalogRef(): string | undefined;
	setActiveCatalogRef(ref: string | undefined): Promise<void>;
	readonly onDidChangeActiveCatalog: Event<void>;

	/** The model the Tab predictor should use right now, or undefined to disable predictions. */
	resolveTabModelRef(): string | undefined;
}

/** Task-model slots the resolver consults. Kept structural to avoid a cycle with runtime.ts. */
export interface ITabTaskModels {
	tab?: string;
	ask?: string;
	agent?: string;
}

function isEnabledItem(catalog: readonly IVoltCatalogItem[], ref: string | undefined): IVoltCatalogItem | undefined {
	if (!ref) {
		return undefined;
	}
	const item = catalog.find(c => c.ref === ref);
	return item?.enabled ? item : undefined;
}

/**
 * Model ids that answer in a fraction of a second, best first. Ghost text is a few dozen tokens
 * of local code: the composer's frontier model is slower and far more expensive per keystroke.
 */
const FAST_TAB_MODELS: readonly RegExp[] = [
	/codestral/i,
	/haiku/i,
	/flash[-_ ]?lite/i,
	/flash/i,
	/(^|[-_ ./])(nano)([-_ .]|$)/i,
	/(^|[-_ ./])(mini)([-_ .]|$)/i,
	/(^|[-_ ./])(fast|turbo|instant|lite|small)([-_ .]|$)/i,
	/coder/i,
];

/** Reasoning levels from cheapest; a prediction takes the first one the model offers. */
const CHEAPEST_REASONING = ['off', 'none', 'minimal', 'low'];

/** The cheapest reasoning level `item` offers, or undefined when it has no reasoning option. */
export function cheapestReasoningLevel(item: IVoltCatalogItem): string | undefined {
	const levels = item.optionDescriptors?.find(descriptor => descriptor.id === MODEL_OPTION_REASONING)?.options?.map(option => option.value) ?? [];
	return CHEAPEST_REASONING.find(level => levels.includes(level));
}

/** Rank of `id` in {@link FAST_TAB_MODELS}, or undefined when it is not a fast model. */
export function fastModelRank(id: string): number | undefined {
	const rank = FAST_TAB_MODELS.findIndex(pattern => pattern.test(id));
	return rank < 0 ? undefined : rank;
}

/**
 * The fastest model offered by the same provider profile as `item` (same CLI login or API key),
 * or `item` itself when it is already fast or the profile offers nothing faster.
 */
export function fastTabSibling(item: IVoltCatalogItem, catalog: readonly IVoltCatalogItem[], usable: (item: IVoltCatalogItem) => boolean = () => true): IVoltCatalogItem {
	if (fastModelRank(item.id) !== undefined) {
		return item;
	}
	let best: { item: IVoltCatalogItem; rank: number } | undefined;
	for (const candidate of catalog) {
		if (candidate.profileId !== item.profileId || candidate.kind !== item.kind || !candidate.enabled || !usable(candidate)) {
			continue;
		}
		const rank = fastModelRank(candidate.id);
		// Catalog order breaks ties: providers list newer models first.
		if (rank !== undefined && (!best || rank < best.rank)) {
			best = { item: candidate, rank };
		}
	}
	return best?.item ?? item;
}

/**
 * Resolution order:
 *   1. explicit Tab model (`taskModels.tab`), exactly as pinned in Settings
 *   2. the active composer selection (Cursor / Claude / Codex / a chat model), stepped down to
 *      the fastest model of the same provider (Opus -> Haiku on the same Claude login)
 *   3. the fast slot (`taskModels.ask`)
 *   4. the fastest enabled chat model (an HTTP round trip beats an agent turn by seconds)
 *   5. the first enabled ACP agent, stepped down the same way
 *   6. undefined - predictions disabled; LSP completion is unaffected
 *
 * `usable` skips chat models that cannot be called (e.g. OpenAI with no API key).
 * Agent entries are usable when the CLI is connected.
 */
export function resolveTabModel(
	activeRef: string | undefined,
	taskModels: ITabTaskModels,
	catalog: readonly IVoltCatalogItem[],
	usable: (item: IVoltCatalogItem) => boolean = () => true,
): string | undefined {
	const pick = (ref: string | undefined) => {
		const item = isEnabledItem(catalog, ref);
		return item && usable(item) ? item : undefined;
	};
	const active = pick(activeRef);
	const models = catalog.filter(c => c.kind === 'model' && c.enabled && usable(c));
	const fastestModel = models.map(item => ({ item, rank: fastModelRank(item.id) ?? FAST_TAB_MODELS.length })).sort((a, b) => a.rank - b.rank)[0]?.item;
	const agent = catalog.find(c => c.kind === 'agent' && c.enabled && usable(c));
	return pick(taskModels.tab)?.ref
		?? (active && fastTabSibling(active, catalog, usable).ref)
		?? pick(taskModels.ask)?.ref
		?? fastestModel?.ref
		?? (agent && fastTabSibling(agent, catalog, usable).ref);
}

/**
 * The model a run Volt starts on its own (a schedule, a webhook, a PR review or fix, a notification)
 * gets: the model the run names, else the chat's model, else the last model the user picked. Never
 * the catalog's first entry: on a fresh profile that is a local model that may not serve the run.
 * Undefined means the run must not start.
 */
export function resolveRunModelRef(candidates: { readonly explicit?: string; readonly chat?: string; readonly lastUsed?: string }, catalog: readonly IVoltCatalogItem[]): string | undefined {
	return [candidates.explicit, candidates.chat, candidates.lastUsed].find(ref => !!isEnabledItem(catalog, ref));
}

/** Turns a provider throw (often raw OpenAI JSON) into a short status line. */
export function formatPredictionError(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	try {
		const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
		const message = parsed.error?.message ?? parsed.message;
		if (typeof message === 'string' && /api key/i.test(message)) {
			return 'No API key. Add one in Volt Settings -> Models (OpenAI / Anthropic / Gemini), or use Ollama.';
		}
		if (typeof message === 'string' && message.trim()) {
			return message.trim();
		}
	} catch {
		// not JSON
	}
	if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|fetch failed/i.test(raw)) {
		return 'Could not reach the model. Start Ollama, or check the endpoint in Volt Settings.';
	}
	return raw.replace(/\s+/g, ' ').slice(0, 220);
}
