/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { BROWSER_COMPARE_IMAGE_TOOL_NAME, BROWSER_NETWORK_TOOL_NAME, BROWSER_SCREENSHOT_TOOL_NAME, IMAGE_INSPECT_TOOL_NAME, IVoltHostToolInfo, IVoltHostToolService, VOLT_HOST_TOOLS } from '../../common/hostTools.js';
import { IToolContext, IToolResult, IVoltTool } from '../../common/tools/tool.js';

/** Tools that only look: safe to run alongside others (the browser still runs one call per chat at a time). */
const READ_ONLY = new Set<string>(['browser_snapshot', BROWSER_SCREENSHOT_TOOL_NAME, 'browser_console_messages', BROWSER_NETWORK_TOOL_NAME, IMAGE_INSPECT_TOOL_NAME]);

const TIMEOUT_MS: Record<string, number> = {
	[BROWSER_COMPARE_IMAGE_TOOL_NAME]: 120_000,
	browser_navigate: 60_000,
	browser_wait_for: 45_000,
};

/**
 * The host's browser and image tools for Volt's own loop, with the same names, schemas and
 * behaviour the ACP agents get over MCP. Calls are tied to the run's chat through
 * `IToolContext.sessionId`, so each chat drives its own browser tab.
 */
export function createBrowserTools(hostTools: IVoltHostToolService): IVoltTool[] {
	return VOLT_HOST_TOOLS.filter(tool => tool.group === 'browser' || tool.group === 'image').map(tool => hostTool(hostTools, tool));
}

/** Only the screenshot tool, for tool lists that have not switched to `createBrowserTools` yet. */
export function createBrowserTool(hostTools: IVoltHostToolService): IVoltTool {
	return hostTool(hostTools, VOLT_HOST_TOOLS.find(tool => tool.name === BROWSER_SCREENSHOT_TOOL_NAME)!);
}

function hostTool(hostTools: IVoltHostToolService, info: IVoltHostToolInfo): IVoltTool {
	const readOnly = READ_ONLY.has(info.name);
	return {
		name: info.name,
		group: 'browser',
		kind: 'browser',
		parallelSafe: readOnly,
		idempotent: readOnly,
		timeoutMs: TIMEOUT_MS[info.name] ?? 30_000,
		snippet: `${info.name} - ${info.title.toLowerCase()}`,
		description: info.description,
		schema: info.inputSchema,
		execute: (args, ctx) => runHostTool(hostTools, info.name, args, ctx),
	};
}

async function runHostTool(hostTools: IVoltHostToolService, name: string, args: unknown, ctx: IToolContext): Promise<IToolResult> {
	const cancel = new CancellationTokenSource();
	const onAbort = () => cancel.cancel();
	if (ctx.signal.aborted) {
		cancel.cancel();
	} else {
		ctx.signal.addEventListener('abort', onAbort, { once: true });
	}
	try {
		const result = await hostTools.invokeTool(name, args, {
			sessionId: ctx.sessionId,
			mode: ctx.mode,
			cwd: ctx.cwd,
			token: cancel.token,
			source: 'native',
		});
		if (result.error) {
			return { callId: '', name, kind: 'browser', text: result.error, isError: true };
		}
		return { callId: '', name, kind: 'browser', text: result.text || 'Done.', ...(result.image ? { image: result.image } : {}) };
	} catch (err) {
		return { callId: '', name, kind: 'browser', text: err instanceof Error ? err.message : String(err), isError: true };
	} finally {
		ctx.signal.removeEventListener('abort', onAbort);
		cancel.dispose();
	}
}
