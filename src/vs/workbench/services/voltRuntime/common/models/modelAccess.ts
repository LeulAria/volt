/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { IVoltEvent } from '../events.js';
import { IVoltModelOptions } from './modelOptions.js';
import { IModelMessage, IVoltCatalogItem } from '../providers.js';

/**
 * Narrow model-access seam shared by the Agent Runtime and the Prediction Runtime (D22).
 *
 * The Prediction Runtime depends on this interface only - never on sessions, runs, ACP,
 * or `IAgentRuntimeService.send()`. Tests substitute a fake implementation.
 */
export interface IVoltModelAccess {
	/**
	 * Streams one stateless completion for a catalog ref. Chat-model refs go through the
	 * HTTP provider. Agent refs use a dedicated ask-mode ACP session so the composer
	 * selection (e.g. Cursor Grok) can power Tab.
	 */
	streamModel(ref: string, messages: IModelMessage[], options: IVoltModelOptions | undefined, token: CancellationToken): AsyncIterable<IVoltEvent>;

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
 * Resolution order - the composer picker is the source of truth:
 *   1. the active composer selection (Cursor / Claude / Codex / a chat model)
 *   2. explicit Tab override (`taskModels.tab`)
 *   3. the first enabled ACP agent
 *   4. the fast slot (`taskModels.ask`)
 *   5. the first enabled chat model
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
		return item && usable(item) ? item.ref : undefined;
	};
	return pick(activeRef)
		?? pick(taskModels.tab)
		?? catalog.find(c => c.kind === 'agent' && c.enabled && usable(c))?.ref
		?? pick(taskModels.ask)
		?? catalog.find(c => c.kind === 'model' && c.enabled && usable(c))?.ref;
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
