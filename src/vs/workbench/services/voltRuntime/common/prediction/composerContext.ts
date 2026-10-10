/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';

/** Scheme of the agent composers' text models (the prompt box, editing a sent message, the browser's). */
export const AGENT_COMPOSER_SCHEME = 'volt-agent-input';

/** What a composer's chat offers its ghost text. Read on each prediction, so it is always current. */
export interface IComposerPredictionContext {
	/** Recent messages of the chat, oldest first, each already shortened. */
	readonly transcript: readonly string[];
	/** Prompts the user sent (this chat's first), newest first. */
	readonly prompts: readonly string[];
	/** Names the chat is about: files mentioned or changed, the project. */
	readonly vocabulary: readonly string[];
}

const contexts = new Map<string, () => IComposerPredictionContext>();

/**
 * The agent editor owns its composers' text models; the prediction provider only sees the model.
 * This hands the provider the chat behind a composer without either importing the other.
 */
export function registerComposerContext(uri: URI, provide: () => IComposerPredictionContext): IDisposable {
	const key = uri.toString();
	contexts.set(key, provide);
	return toDisposable(() => {
		if (contexts.get(key) === provide) {
			contexts.delete(key);
		}
	});
}

export function composerContextFor(uri: URI): IComposerPredictionContext | undefined {
	return contexts.get(uri.toString())?.();
}
