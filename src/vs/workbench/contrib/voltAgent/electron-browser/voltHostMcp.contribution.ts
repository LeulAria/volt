/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVoltBrowserService, VOLT_BROWSER_CHANNEL_NAME } from '../../../../platform/voltBrowser/common/voltBrowser.js';
import { IVoltHostMcpResult, IVoltHostMcpService, VOLT_HOST_MCP_CHANNEL_NAME } from '../../../../platform/voltHostMcp/common/voltHostMcp.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoltHostToolResult, IVoltHostToolService, LEGACY_TOOL_NAMES } from '../../../services/voltRuntime/common/hostTools.js';
// The device, window capture and desktop host tools (and their UI) are served on this window's MCP server too.
import './voltDevices.contribution.js';
import './voltDesktop.contribution.js';

registerMainProcessRemoteService(IVoltHostMcpService, VOLT_HOST_MCP_CHANNEL_NAME);
// The in-app browser's session and DevTools protocol live in the main process too.
registerMainProcessRemoteService(IVoltBrowserService, VOLT_BROWSER_CHANNEL_NAME);

/**
 * Serves Volt's host tools to the agents this window launches. The HTTP server lives in the main
 * process (the renderer is sandboxed); this window registers one and answers its tool calls.
 */
class VoltHostMcpContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltHostMcp';

	private readonly serverId = generateUuid();
	private readonly calls = this._register(new DisposableMap<string, CancellationTokenSource>());

	constructor(
		@IVoltHostMcpService private readonly mcp: IVoltHostMcpService,
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.mcp.onDidCall(call => {
			if (call.serverId === this.serverId) {
				void this.answer(call.id, call.name, call.args, call.sessionId);
			}
		}));
		this._register(this.mcp.onDidCancel(({ id, serverId }) => {
			if (serverId === this.serverId) {
				this.calls.get(id)?.cancel();
			}
		}));
		this._register(toDisposable(() => {
			this.hostTools.setMcpEndpoint(undefined);
			void this.mcp.stop(this.serverId);
		}));
		void this.start();
		// The orchestrator's task tools register after startup; the server re-reads the list.
		this._register(this.hostTools.onDidChangeTools(() => void this.start()));
	}

	private async start(): Promise<void> {
		try {
			const tools = this.hostTools.listTools().map(tool => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, group: tool.group, ...aliasesOf(tool.name) }));
			const endpoint = await this.mcp.start(this.serverId, tools);
			this.hostTools.setMcpEndpoint(endpoint.url, endpoint.token);
		} catch (err) {
			this.logService.error('[volt] host MCP failed to start', err);
		}
	}

	private async answer(id: string, name: string, args: unknown, sessionId: string | undefined): Promise<void> {
		const cancel = new CancellationTokenSource();
		this.calls.set(id, cancel);
		let result: IVoltHostToolResult;
		try {
			result = await this.hostTools.invokeTool(name, args, { sessionId, token: cancel.token, source: 'mcp' });
		} catch (err) {
			result = { error: err instanceof Error ? err.message : String(err) };
		}
		this.calls.deleteAndDispose(id);
		await this.mcp.respond(id, toMcpResult(result));
	}
}

function toMcpResult(result: IVoltHostToolResult): IVoltHostMcpResult {
	if (result.error) {
		return { content: [{ type: 'text', text: result.error }], isError: true };
	}
	const content: unknown[] = [];
	if (result.text) {
		content.push({ type: 'text', text: result.text });
	}
	const image = asMcpImage(result.image);
	if (image) {
		content.push(image);
	}
	return { content };
}

function asMcpImage(image: string | undefined): { type: 'image'; data: string; mimeType: string } | undefined {
	if (!image) {
		return undefined;
	}
	const match = image.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
	if (match) {
		return { type: 'image', mimeType: match[1], data: match[2] };
	}
	return { type: 'image', mimeType: 'image/png', data: image };
}

/** Earlier names of a tool, so an agent that listed tools before a rename can still call it. */
function aliasesOf(name: string): { aliases?: string[] } {
	const aliases = Object.keys(LEGACY_TOOL_NAMES).filter(alias => LEGACY_TOOL_NAMES[alias] === name);
	return aliases.length ? { aliases } : {};
}

registerWorkbenchContribution2(VoltHostMcpContribution.ID, VoltHostMcpContribution, WorkbenchPhase.AfterRestored);
