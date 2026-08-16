/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IProviderCapabilities {
	streaming: boolean;
	reasoning: boolean;
	toolCalling: boolean;
	parallelToolCalls: boolean;
	vision: boolean;
	attachments: boolean;
	promptCaching: boolean;
	structuredOutput: boolean;
	cancellation: boolean;
	contextWindow: number;
	mcp: boolean;
	nativeAgent: boolean;
}

export const DEFAULT_MODEL_CAPABILITIES: IProviderCapabilities = {
	streaming: true,
	reasoning: false,
	toolCalling: true,
	parallelToolCalls: false,
	vision: false,
	attachments: false,
	promptCaching: false,
	structuredOutput: false,
	cancellation: true,
	contextWindow: 128_000,
	mcp: false,
	nativeAgent: false,
};

export const DEFAULT_ACP_CAPABILITIES: IProviderCapabilities = {
	streaming: true,
	reasoning: true,
	toolCalling: true,
	parallelToolCalls: true,
	vision: true,
	attachments: true,
	promptCaching: false,
	structuredOutput: false,
	cancellation: true,
	contextWindow: 200_000,
	mcp: true,
	nativeAgent: true,
};
