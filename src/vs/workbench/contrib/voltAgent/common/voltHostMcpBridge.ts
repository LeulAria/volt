/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVoltHostMcpResult, IVoltHostMcpService } from '../../../../platform/voltHostMcp/common/voltHostMcp.js';
import { IVoltHostToolResult, IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';

/**
 * Serves Volt's host tools to every agent over MCP: starts the loopback MCP server with the
 * current tool list and answers its calls through the host tool service. The desktop runs it
 * against the main process's server; the agent server runs it in-process.
 */
export class VoltHostMcpBridge extends Disposable {

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
			const tools = this.hostTools.listTools().map(tool => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, group: tool.group }));
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
