/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { adaptModelStream } from '../../common/deepseek/llmAdapter.js';
import { StreamChunk } from '../../common/deepseek/protocol.js';
import { IModelMessage, IModelProvider, IModelRequest } from '../../common/providers.js';
import { IToolSchema } from '../../common/tools/tool.js';

/**
 * DeepSeek `LlmAdapter` backed by Volt's existing model providers.
 * This does not open a second HTTP client. Claude, OpenAI, Gemini, and Ollama keep their transports.
 * `adaptModelStream` yields text deltas immediately and orders usage before finish.
 */
export class VoltLlmAdapter {
	constructor(private readonly provider: IModelProvider) { }

	stream(request: IModelRequest & { messages: IModelMessage[]; tools?: IToolSchema[] }, token: CancellationToken): AsyncIterable<StreamChunk> {
		return adaptModelStream(this.provider.stream(request, token));
	}
}
