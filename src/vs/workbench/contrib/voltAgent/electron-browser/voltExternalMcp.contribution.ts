/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { FocusMode } from '../../../../platform/native/common/native.js';
import { externalToolScope } from '../../../../platform/voltExternalMcp/common/externalMcpOAuth.js';
import {
	DEFAULT_EXTERNAL_MCP_PORT, EXTERNAL_MCP_ENABLED_SETTING, EXTERNAL_MCP_PORT_SETTING, EXTERNAL_MCP_PUBLIC_URL_SETTING, IExternalMcpCall, IExternalMcpConsentRequest,
	IExternalMcpResult, IExternalMcpToolInfo, IVoltExternalMcpService, VOLT_EXTERNAL_MCP_CHANNEL_NAME,
} from '../../../../platform/voltExternalMcp/common/voltExternalMcp.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IVoltHostToolResult, IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../voltSettings/browser/voltSettingsEditorInput.js';
import { showExternalMcpConsent } from '../browser/externalMcp/externalMcpConsent.js';
import { OPEN_CONNECTED_AGENTS_COMMAND_ID } from '../browser/orchestration/agentExternalCaller.js';

registerMainProcessRemoteService(IVoltExternalMcpService, VOLT_EXTERNAL_MCP_CHANNEL_NAME);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'voltExternalMcp',
	title: localize('externalMcp.settings', "Volt: Connected agents"),
	type: 'object',
	properties: {
		[EXTERNAL_MCP_ENABLED_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('externalMcp.enabled', "Let agents outside Volt (Claude Code, Codex, Cursor, connectors) list, read, message and start your chats over MCP. Each agent asks you first; the server listens on this computer only."),
		},
		[EXTERNAL_MCP_PORT_SETTING]: {
			type: 'number',
			default: DEFAULT_EXTERNAL_MCP_PORT,
			minimum: 1024,
			maximum: 65535,
			scope: ConfigurationScope.APPLICATION,
			description: localize('externalMcp.port', "The loopback port of Volt's MCP server for outside agents. Agents you connected keep this address, so change it only if another program uses it."),
		},
		[EXTERNAL_MCP_PUBLIC_URL_SETTING]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('externalMcp.publicUrl', "An https address (a tunnel such as cloudflared, ngrok or Tailscale Funnel) that forwards to the server, for agents that cannot reach this computer (ChatGPT and Claude connectors). Empty: loopback only."),
		},
	},
});

/** Opens Volt Settings on Connected agents. */
CommandsRegistry.registerCommand(OPEN_CONNECTED_AGENTS_COMMAND_ID, async accessor => {
	const editorService = accessor.get(IEditorService);
	await accessor.get(ICommandService).executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
	const pane = editorService.activeEditorPane as unknown as { showSection?: (id: string) => void } | undefined;
	pane?.showSection?.('connected');
});

/**
 * Serves Volt's orchestrator tools to outside agents through the main process's OAuth MCP
 * server, and asks the user before an agent connects. The window the user focused last answers.
 */
class VoltExternalMcpContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltExternalMcp';

	private readonly windowId = generateUuid();
	private readonly calls = this._register(new DisposableMap<string, CancellationTokenSource>());
	private readonly consents = this._register(new DisposableMap<string, IDisposable>());

	constructor(
		@IVoltExternalMcpService private readonly mcp: IVoltExternalMcpService,
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHostService private readonly hostService: IHostService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.mcp.onDidCall(call => {
			if (call.windowId === this.windowId) {
				void this.answer(call);
			}
		}));
		this._register(this.mcp.onDidCancel(({ id, windowId }) => {
			if (windowId === this.windowId) {
				this.calls.get(id)?.cancel();
			}
		}));
		this._register(this.mcp.onDidRequestConsent(request => {
			if (request.windowId === this.windowId) {
				this.ask(request);
			}
		}));
		this._register(this.mcp.onDidEndConsent(({ id }) => this.consents.deleteAndDispose(id)));
		this._register(this.hostService.onDidChangeFocus(focused => {
			if (focused) {
				void this.mcp.focus(this.windowId);
			}
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(EXTERNAL_MCP_ENABLED_SETTING) || e.affectsConfiguration(EXTERNAL_MCP_PORT_SETTING) || e.affectsConfiguration(EXTERNAL_MCP_PUBLIC_URL_SETTING)) {
				void this.configure();
			}
		}));
		this._register(this.hostTools.onDidChangeTools(() => void this.attach()));
		this._register(toDisposable(() => void this.mcp.detach(this.windowId)));
		void this.start();
	}

	private async start(): Promise<void> {
		await this.attach();
		await this.configure();
		if (this.hostService.hasFocus) {
			await this.mcp.focus(this.windowId);
		}
		// Requests that came in before this window was up.
		for (const request of await this.mcp.pendingConsents()) {
			if (request.windowId === this.windowId) {
				this.ask(request);
			}
		}
	}

	private async configure(): Promise<void> {
		try {
			await this.mcp.configure({
				enabled: this.configurationService.getValue<boolean>(EXTERNAL_MCP_ENABLED_SETTING) === true,
				port: this.configurationService.getValue<number>(EXTERNAL_MCP_PORT_SETTING) ?? DEFAULT_EXTERNAL_MCP_PORT,
				publicUrl: this.configurationService.getValue<string>(EXTERNAL_MCP_PUBLIC_URL_SETTING) ?? '',
			});
		} catch (err) {
			this.logService.error('[volt] external MCP: could not configure', err);
		}
	}

	private async attach(): Promise<void> {
		const tools: IExternalMcpToolInfo[] = [];
		for (const tool of this.hostTools.listTools()) {
			const scope = externalToolScope(tool.name);
			if (scope) {
				tools.push({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, scope });
			}
		}
		await this.mcp.attach(this.windowId, tools);
	}

	private ask(request: IExternalMcpConsentRequest): void {
		if (this.consents.has(request.id)) {
			return;
		}
		// The agent opened a browser tab that waits on this; bring Volt forward so the user sees why.
		void this.hostService.focus(mainWindow, { mode: FocusMode.Force });
		this.consents.set(request.id, showExternalMcpConsent(this.layoutService, request, decision => {
			void this.mcp.answerConsent(request.id, decision);
		}));
	}

	private async answer(call: IExternalMcpCall): Promise<void> {
		const cancel = new CancellationTokenSource();
		this.calls.set(call.id, cancel);
		let result: IVoltHostToolResult;
		try {
			result = await this.hostTools.invokeTool(call.name, call.args, {
				token: cancel.token,
				source: 'mcp',
				external: { grantId: call.grantId, clientId: call.clientId, name: call.clientName, scopes: call.scopes },
			});
		} catch (err) {
			result = { error: err instanceof Error ? err.message : String(err) };
		}
		this.calls.deleteAndDispose(call.id);
		await this.mcp.respond(call.id, toResult(result));
	}
}

function toResult(result: IVoltHostToolResult): IExternalMcpResult {
	if (result.error) {
		return { content: [{ type: 'text', text: result.error }], isError: true };
	}
	return { content: result.text ? [{ type: 'text', text: result.text }] : [] };
}

registerWorkbenchContribution2(VoltExternalMcpContribution.ID, VoltExternalMcpContribution, WorkbenchPhase.AfterRestored);
