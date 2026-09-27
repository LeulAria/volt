/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolResultView } from '../deepseek/protocol.js';
import type { CapabilityGroup } from '../harness/lanes.js';
import type { ToolKind } from '../harness/workLog.js';

export interface IToolSchema {
	readonly name: string;
	readonly description: string;
	readonly parameters: object;
}

export interface IToolCall {
	readonly id: string;
	readonly name: string;
	readonly args: unknown;
}

export interface IToolResult {
	readonly callId: string;
	readonly name: string;
	readonly kind: ToolKind;
	readonly text: string;
	readonly isError?: boolean;
	readonly image?: string;
	readonly durationMs?: number;
	/** Extra model-visible context injected after this result (DeepSeek additionalContexts). */
	readonly contexts?: readonly string[];
	/** How the editor draws the result. Never sent to the model. */
	readonly display?: ToolResultView;
	/** Shell exit code, for the terminal card. */
	readonly exitCode?: number;
}

export interface IToolContext {
	readonly cwd?: string;
	readonly signal: AbortSignal;
	readonly emit?: (event: { type: string;[key: string]: unknown }) => void;
	/** The call being run, so a long tool can report progress against its own card. */
	readonly callId?: string;
}

export interface IVoltTool {
	readonly name: string;
	readonly group: CapabilityGroup;
	readonly kind: ToolKind;
	readonly description: string;
	readonly schema: object;
	readonly parallelSafe: boolean;
	readonly snippet: string;
	/** Safe to run twice. Only these are retried after a transient failure. Defaults to `parallelSafe`. */
	readonly idempotent?: boolean;
	/** Hard ceiling for one call. The call's signal is aborted when it passes. */
	readonly timeoutMs?: number;
	execute(args: unknown, ctx: IToolContext): Promise<IToolResult>;
}

export function visibleTools(tools: readonly IVoltTool[], groups: readonly CapabilityGroup[]): IVoltTool[] {
	const granted = new Set(groups);
	return tools.filter(tool => granted.has(tool.group) || tool.group === 'meta');
}

export function toolSchemas(tools: readonly IVoltTool[]): IToolSchema[] {
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.schema,
	}));
}

export function toolSnippets(tools: readonly IVoltTool[]): string[] {
	return tools.map(tool => tool.snippet);
}
