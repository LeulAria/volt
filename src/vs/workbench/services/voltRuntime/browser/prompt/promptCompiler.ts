/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buildSystemPrompt, IContextPackInput } from '../../common/harness/contextPack.js';
import { IModelMessage } from '../../common/providers.js';

/**
 * Turns the context pack plus the transcript into the message list a model provider consumes.
 * The system prompt is rebuilt every turn from sections; cacheable sections render identically
 * across turns so provider-side prompt caching keeps hitting.
 */
export function compilePrompt(input: IContextPackInput, history: IModelMessage[], userText: string): IModelMessage[] {
	return [
		{ role: 'system', content: buildSystemPrompt(input) },
		...history.filter(m => m.role !== 'system'),
		{ role: 'user', content: userText },
	];
}
