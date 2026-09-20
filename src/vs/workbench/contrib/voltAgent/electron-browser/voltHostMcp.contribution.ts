/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line local/code-import-patterns
import * as http from 'http';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';

class VoltHostMcpContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltHostMcp';

	private server: http.Server | undefined;

	constructor(
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		void this.listen();
		this._register({ dispose: () => this.shutdown() });
	}

	private listen(): void {
		const server = http.createServer((req, res) => {
			void this.handle(req, res);
		});
		this.server = server;
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				return;
			}
			const url = `http://127.0.0.1:${address.port}/mcp`;
			this.hostTools.setMcpEndpoint(url);
			this.logService.trace('[volt] host MCP listening', url);
		});
	}

	private shutdown(): void {
		this.hostTools.setMcpEndpoint(undefined);
		this.server?.close();
		this.server = undefined;
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, MCP-Protocol-Version');
		res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
		if (req.method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return;
		}
		if (req.method !== 'POST') {
			res.writeHead(405);
			res.end();
			return;
		}
		try {
			const body = await readBody(req);
			const message = body ? JSON.parse(body) as IJsonRpc : {};
			const result = await this.dispatch(message);
			if (result === undefined) {
				res.writeHead(202);
				res.end();
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(result));
		} catch (err) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				jsonrpc: '2.0',
				id: null,
				error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
			}));
		}
	}

	private async dispatch(message: IJsonRpc): Promise<unknown> {
		const id = message.id ?? null;
		if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
			return undefined;
		}
		if (message.method === 'initialize') {
			return ok(id, {
				protocolVersion: '2025-03-26',
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: 'volt', version: '0.1.0' },
			});
		}
		if (message.method === 'ping') {
			return ok(id, {});
		}
		if (message.method === 'tools/list') {
			return ok(id, {
				tools: this.hostTools.listTools().map(tool => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema,
				})),
			});
		}
		if (message.method === 'tools/call') {
			const params = (message.params ?? {}) as { name?: string; arguments?: unknown };
			const result = await this.hostTools.invokeTool(params.name ?? '', params.arguments);
			if (result.error) {
				return ok(id, { content: [{ type: 'text', text: result.error }], isError: true });
			}
			const content: unknown[] = [];
			if (result.text) {
				content.push({ type: 'text', text: result.text });
			}
			const image = asMcpImage(result.image);
			if (image) {
				content.push(image);
			}
			return ok(id, { content });
		}
		return {
			jsonrpc: '2.0',
			id,
			error: { code: -32601, message: `Unknown method ${message.method ?? ''}` },
		};
	}
}

interface IJsonRpc {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: unknown;
}

function ok(id: string | number | null, result: unknown): unknown {
	return { jsonrpc: '2.0', id, result };
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

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

registerWorkbenchContribution2(VoltHostMcpContribution.ID, VoltHostMcpContribution, WorkbenchPhase.AfterRestored);
