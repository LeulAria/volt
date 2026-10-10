/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { IVoltHostToolInfo, IVoltHostToolResult, IVoltHostToolService } from '../../common/hostTools.js';
import { TERMINAL_READ_TOOL_NAMES, TERMINAL_START_TOOL_NAME, TERMINAL_TOOLS } from '../../common/terminalTools.js';
import { IToolContext, IToolResult, IVoltTool } from '../../common/tools/tool.js';

/** terminal_start waits for readiness up to a minute; the reads up to their own timeout_ms. */
const TIMEOUT_MS = 11 * 60_000;

/**
 * The managed-terminal tools for Volt's own loop, with the names, schemas and behaviour the ACP
 * agents get over MCP. Reads run alongside other tools; starting, typing and stopping go through
 * the chat's access mode like any command.
 */
export function createTerminalTools(hostTools: IVoltHostToolService): IVoltTool[] {
	return TERMINAL_TOOLS.map(info => terminalTool(hostTools, info));
}

function terminalTool(hostTools: IVoltHostToolService, info: IVoltHostToolInfo): IVoltTool {
	const readOnly = TERMINAL_READ_TOOL_NAMES.has(info.name);
	return {
		name: info.name,
		group: 'shell',
		kind: 'execute',
		parallelSafe: readOnly,
		idempotent: readOnly,
		timeoutMs: TIMEOUT_MS,
		snippet: `${info.name} - ${info.title.toLowerCase()}`,
		description: info.description,
		schema: info.inputSchema,
		execute: (args, ctx) => runTerminalTool(hostTools, info.name, args, ctx),
	};
}

/** Runs a terminal host tool for a native call: tied to the run's chat, cancelled with the step. */
export async function runTerminalTool(hostTools: IVoltHostToolService, name: string, args: unknown, ctx: IToolContext): Promise<IToolResult> {
	const cancel = new CancellationTokenSource();
	const onAbort = () => cancel.cancel();
	if (ctx.signal.aborted) {
		cancel.cancel();
	} else {
		ctx.signal.addEventListener('abort', onAbort, { once: true });
	}
	try {
		const result: IVoltHostToolResult = await hostTools.invokeTool(name, args, {
			sessionId: ctx.sessionId,
			mode: ctx.mode,
			cwd: ctx.cwd,
			token: cancel.token,
			source: 'native',
		});
		if (result.error) {
			return { callId: '', name, kind: 'execute', text: result.error, isError: true };
		}
		return { callId: '', name, kind: 'execute', text: result.text || 'Done.' };
	} catch (err) {
		return { callId: '', name, kind: 'execute', text: err instanceof Error ? err.message : String(err), isError: true };
	} finally {
		ctx.signal.removeEventListener('abort', onAbort);
		cancel.dispose();
	}
}

/** Whether this window offers managed terminals (the contribution registered them). */
export function hasManagedTerminals(hostTools: IVoltHostToolService): boolean {
	return hostTools.listTools().some(tool => tool.name === TERMINAL_START_TOOL_NAME);
}
