/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IVoltHostToolService = createDecorator<IVoltHostToolService>('voltHostToolService');

export const BROWSER_SNAPSHOT_TOOL_NAME = 'browser_snapshot';
export const CAPTURE_BROWSER_SNAPSHOT_COMMAND_ID = 'volt.browser.captureSnapshot';

export interface IVoltHostToolInfo {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: object;
}

export interface IVoltHostToolResult {
	readonly text?: string;
	readonly image?: string;
	readonly error?: string;
}

export interface IVoltMcpServer {
	readonly type: 'http';
	readonly name: string;
	readonly url: string;
}

export const VOLT_HOST_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: BROWSER_SNAPSHOT_TOOL_NAME,
		title: 'Took snapshot',
		description: 'Capture a screenshot of the current page in Volt\'s in-app browser.',
		inputSchema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
	},
];

export function isVoltHostTool(name?: string): boolean {
	const id = (name ?? '').trim().toLowerCase();
	return VOLT_HOST_TOOLS.some(tool => tool.name === id);
}

export interface IVoltHostToolService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeMcp: Event<void>;
	listTools(): readonly IVoltHostToolInfo[];
	invokeTool(name: string, input?: unknown): Promise<IVoltHostToolResult>;
	getMcpServers(): readonly IVoltMcpServer[];
	setMcpEndpoint(url: string | undefined): void;
}
