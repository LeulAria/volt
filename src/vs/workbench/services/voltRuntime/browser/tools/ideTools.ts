/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { IVoltHostToolInfo, IVoltHostToolService } from '../../common/hostTools.js';
import { IDE_TOOLS, isIdeReadOnlyCall } from '../../common/ide/ideTools.js';
import { IToolContext, IToolResult, IVoltTool } from '../../common/tools/tool.js';

/** A test suite or a debug wait can take a while; the tool's own waits are shorter. */
const TIMEOUT_MS = 31 * 60_000;

/**
 * The IDE tools (tests, debug, tasks) for Volt's own loop, with the names, schemas and behaviour
 * the ACP agents get over MCP. They run code, so they sit in the shell group (off in Ask and
 * Plan); calls that only read state (list, results, state, variables, output) skip approval.
 */
export function createIdeTools(hostTools: IVoltHostToolService): IVoltTool[] {
	const offered = new Set(hostTools.listTools().map(tool => tool.name));
	return IDE_TOOLS.filter(info => offered.has(info.name)).map(info => ideTool(hostTools, info));
}

function ideTool(hostTools: IVoltHostToolService, info: IVoltHostToolInfo): IVoltTool {
	return {
		name: info.name,
		group: 'shell',
		kind: 'execute',
		parallelSafe: false,
		readOnly: args => isIdeReadOnlyCall(info.name, args),
		timeoutMs: TIMEOUT_MS,
		snippet: `${info.name} - ${info.title.toLowerCase()}`,
		description: info.description,
		schema: info.inputSchema,
		execute: (args, ctx) => run(hostTools, info.name, args, ctx),
	};
}

async function run(hostTools: IVoltHostToolService, name: string, args: unknown, ctx: IToolContext): Promise<IToolResult> {
	const cancel = new CancellationTokenSource();
	const onAbort = () => cancel.cancel();
	if (ctx.signal.aborted) {
		cancel.cancel();
	} else {
		ctx.signal.addEventListener('abort', onAbort, { once: true });
	}
	try {
		const result = await hostTools.invokeTool(name, args, { sessionId: ctx.sessionId, mode: ctx.mode, cwd: ctx.cwd, token: cancel.token, source: 'native' });
		return result.error
			? { callId: '', name, kind: 'execute', text: result.error, isError: true }
			: { callId: '', name, kind: 'execute', text: result.text || 'Done.' };
	} catch (err) {
		return { callId: '', name, kind: 'execute', text: err instanceof Error ? err.message : String(err), isError: true };
	} finally {
		ctx.signal.removeEventListener('abort', onAbort);
		cancel.dispose();
	}
}
