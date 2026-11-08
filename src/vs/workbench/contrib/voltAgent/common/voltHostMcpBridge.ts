/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVoltHostMcpResult, IVoltHostMcpService } from '../../../../platform/voltHostMcp/common/voltHostMcp.js';
import { IVoltSandboxSettings, SandboxStrategy, sandboxStrategy } from '../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { CHAT_SANDBOX_PLATFORM } from '../../../services/voltRuntime/common/access/chatSandbox.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolResult, IVoltHostToolService, LEGACY_TOOL_NAMES } from '../../../services/voltRuntime/common/hostTools.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';

/**
 * Serves Volt's host tools to the agents this process launches over the host MCP server: a
 * window (whose HTTP server lives in the main process, the renderer is sandboxed) or the agent
 * server (in-process). Registers one server and answers its tool calls.
 */
export class VoltHostMcpBridge extends Disposable {

	private readonly serverId = generateUuid();
	private readonly calls = this._register(new DisposableMap<string, CancellationTokenSource>());
	/** Session ids that called a tool, and the chat each serves. */
	private readonly callers = new Map<string, string>();
	/** Chats among those that the history has stored, so a later absence means a deletion. */
	private readonly storedChats = new Set<string>();

	constructor(
		@IVoltHostMcpService private readonly mcp: IVoltHostMcpService,
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@ILogService private readonly logService: ILogService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
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
		// A revoked chat's tokens die on the server too (B-07).
		this._register(this.hostTools.onDidRevokeMcpSession(({ sessionId, epoch }) => {
			void this.mcp.revokeSession(this.serverId, sessionId, epoch).catch(err => this.logService.warn('[volt] could not revoke a chat\'s host MCP token', err));
		}));
		// A deleted chat is closed for good: its agents' tokens are revoked.
		this._register(this.history.onDidChange(() => this.revokeDeletedChats()));
		// The gate judges calls that prompt another chat by that chat's sandbox and folder.
		this.hostTools.setSandboxResolver({
			settings: sessionId => this.sandboxOf(this.runtime.chatFor(sessionId)),
			folder: sessionId => this.runtime.workingFolder(this.runtime.chatFor(sessionId)),
			strategy: sessionId => this.strategyOf(this.runtime.chatFor(sessionId)),
		});
		this._register(toDisposable(() => {
			this.hostTools.setSandboxResolver(undefined);
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

	/** Revokes the sessions that called in for a chat the history knew and no longer has. */
	private revokeDeletedChats(): void {
		for (const [sessionId, chat] of this.callers) {
			if (this.history.get(chat)) {
				this.storedChats.add(chat);
			} else if (this.storedChats.has(chat)) {
				this.callers.delete(sessionId);
				this.hostTools.revokeMcpSession(sessionId);
			}
		}
		const live = new Set(this.callers.values());
		for (const chat of this.storedChats) {
			if (!live.has(chat)) {
				this.storedChats.delete(chat);
			}
		}
	}

	private async answer(id: string, name: string, args: unknown, sessionId: string | undefined): Promise<void> {
		if (sessionId && !this.callers.has(sessionId)) {
			const chat = this.runtime.chatFor(sessionId);
			this.callers.set(sessionId, chat);
			if (this.history.get(chat)) {
				this.storedChats.add(chat);
			}
		}
		const cancel = new CancellationTokenSource();
		this.calls.set(id, cancel);
		let result: IVoltHostToolResult;
		try {
			// A warm spare agent was started under a pool alias before any chat adopted it, and its
			// MCP URL still carries that alias: name the chat, or the browser, questions and mode
			// gates act for a chat that does not exist. The server checked the session against the
			// agent's token, so this is the chat the agent serves, and its sandbox comes from Volt.
			const chat = sessionId ? this.runtime.chatFor(sessionId) : undefined;
			const sandbox = chat ? this.sandboxOf(chat) : undefined;
			result = await this.hostTools.invokeTool(name, args, { sessionId: chat, token: cancel.token, source: 'mcp', ...(sandbox && sandbox.level !== 'off' ? { sandbox } : {}) });
		} catch (err) {
			result = { error: err instanceof Error ? err.message : String(err) };
		}
		this.calls.deleteAndDispose(id);
		await this.mcp.respond(id, toMcpResult(result));
	}

	/** How the chat's agent is sandboxed: its provider's strategy at its level. */
	private strategyOf(chatId: string): SandboxStrategy | undefined {
		try {
			const ref = this.runtime.getOrCreateSession(chatId).providerRef;
			const providerId = ref ? this.runtime.listCatalog().find(item => item.ref === ref)?.providerId : undefined;
			return providerId ? sandboxStrategy(providerId, this.sandboxOf(chatId).level, CHAT_SANDBOX_PLATFORM) : undefined;
		} catch {
			return undefined;
		}
	}

	/** A chat's sandbox; when the runtime cannot say, the strictest one (fail closed). */
	private sandboxOf(chatId: string): IVoltSandboxSettings {
		try {
			return this.runtime.getSandboxSettings(chatId) ?? UNKNOWN_SANDBOX;
		} catch (err) {
			this.logService.warn('[volt] could not read a chat\'s sandbox for a host tool call', err);
			return UNKNOWN_SANDBOX;
		}
	}
}

/** What a call gets when the chat's sandbox cannot be read. */
const UNKNOWN_SANDBOX: IVoltSandboxSettings = { level: 'read-only', network: false };

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
