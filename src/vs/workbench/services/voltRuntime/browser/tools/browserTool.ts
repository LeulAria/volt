/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BROWSER_SNAPSHOT_TOOL_NAME, IVoltHostToolService } from '../../common/hostTools.js';
import { IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { objectSchema } from './schema.js';

export function createBrowserTool(hostTools: IVoltHostToolService): IVoltTool {
	return {
		name: BROWSER_SNAPSHOT_TOOL_NAME,
		group: 'browser',
		kind: 'browser',
		parallelSafe: true,
		snippet: 'browser_snapshot - capture the in-app browser page',
		description: [
			'Capture a screenshot of the current page in Volt\'s in-app browser.',
			'Use after starting a local preview to see what the user sees.',
			'Do not use to open a system browser.',
		].join(' '),
		schema: objectSchema({}, []),
		execute: async () => runSnapshot(hostTools),
	};
}

async function runSnapshot(hostTools: IVoltHostToolService): Promise<IToolResult> {
	try {
		const result = await hostTools.invokeTool(BROWSER_SNAPSHOT_TOOL_NAME);
		if (result.error) {
			return { callId: '', name: BROWSER_SNAPSHOT_TOOL_NAME, kind: 'browser', text: result.error, isError: true };
		}
		return {
			callId: '',
			name: BROWSER_SNAPSHOT_TOOL_NAME,
			kind: 'browser',
			text: result.text || 'Captured the in-app browser.',
			image: result.image,
		};
	} catch (err) {
		return { callId: '', name: BROWSER_SNAPSHOT_TOOL_NAME, kind: 'browser', text: err instanceof Error ? err.message : String(err), isError: true };
	}
}
