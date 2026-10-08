/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../voltAgent/browser/media/externalMcp.css';
import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IInputBoxStyles, InputBox, MessageType } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { fromNow } from '../../../../base/common/date.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { connectSnippets } from '../../../../platform/voltExternalMcp/common/externalMcpConnect.js';
import { describeRedirect, normalizePublicUrl } from '../../../../platform/voltExternalMcp/common/externalMcpOAuth.js';
import {
	DEFAULT_EXTERNAL_MCP_PORT, EXTERNAL_MCP_ENABLED_SETTING, EXTERNAL_MCP_PORT_SETTING, EXTERNAL_MCP_PUBLIC_URL_SETTING, IExternalMcpGrantView, IExternalMcpStatus, IVoltExternalMcpService,
} from '../../../../platform/voltExternalMcp/common/voltExternalMcp.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { scopeCopy } from '../../voltAgent/browser/externalMcp/externalMcpScopes.js';

export interface IConnectedAgentsPageHost {
	readonly store: DisposableStore;
	target(): HTMLElement;
	sectionLabel(label: string): void;
	settingsGroup(): HTMLElement;
	settingRow(parent: HTMLElement, title: string, desc: string | undefined, renderControl?: (host: HTMLElement) => void): HTMLElement;
	empty(text: string): void;
	switch(parent: HTMLElement, on: boolean, label: string, onClick: () => void): HTMLButtonElement;
	inputBoxStyles(): IInputBoxStyles;
	rerender(): void;
}

/**
 * Volt Settings > Connected agents: turn the OAuth MCP server for outside agents on, copy the
 * setup for Claude Code, Codex, Cursor and connectors, and see or revoke every agent the user
 * allowed (with when it last called and what).
 */
export class ConnectedAgentsPage {

	private readonly mcp: IVoltExternalMcpService | undefined;
	private readonly configuration: IConfigurationService;
	private readonly clipboard: IClipboardService;
	private readonly contextView: IContextViewService;

	constructor(instantiationService: IInstantiationService, private readonly host: IConnectedAgentsPageHost) {
		const services = instantiationService.invokeFunction(accessor => {
			let mcp: IVoltExternalMcpService | undefined;
			try {
				mcp = accessor.get(IVoltExternalMcpService);
			} catch {
				mcp = undefined; // web: no main process
			}
			return { mcp, configuration: accessor.get(IConfigurationService), clipboard: accessor.get(IClipboardService), contextView: accessor.get(IContextViewService) };
		});
		this.mcp = services.mcp;
		this.configuration = services.configuration;
		this.clipboard = services.clipboard;
		this.contextView = services.contextView;
	}

	/** Grants and server state changed: the editor re-renders this page while it shows. */
	onDidChange(listener: () => void): DisposableStore {
		const store = new DisposableStore();
		if (this.mcp) {
			store.add(this.mcp.onDidChangeGrants(listener));
			store.add(this.mcp.onDidChangeStatus(listener));
			store.add(this.mcp.onDidEndConsent(listener));
		}
		return store;
	}

	async render(isCurrent: () => boolean): Promise<void> {
		if (!this.mcp) {
			this.host.empty(localize('connectedAgents.unavailable', "Connected agents need the Volt desktop app."));
			return;
		}
		const [status, grants] = await Promise.all([this.mcp.getStatus(), this.mcp.listGrants()]);
		if (!isCurrent()) {
			return;
		}
		this.renderServer(status);
		this.renderGrants(grants);
		this.renderConnect(status);
	}

	private renderServer(status: IExternalMcpStatus): void {
		const { host } = this;
		const group = host.settingsGroup();
		host.settingRow(
			group,
			localize('connectedAgents.enable', "Allow outside agents"),
			localize('connectedAgents.enableDesc', "Agents running outside Volt can ask to list, read, message and start your chats over MCP. Each asks you first, and only programs on this computer can reach it unless you add a public address."),
			control => {
				host.switch(control, status.enabled, localize('connectedAgents.enable', "Allow outside agents"), () => {
					void this.configuration.updateValue(EXTERNAL_MCP_ENABLED_SETTING, !status.enabled);
				});
			},
		);
		const state = append(host.target(), $('.volt-external-mcp-status'));
		append(state, $('span.dot'));
		const label = append(state, $('span'));
		if (status.error) {
			state.classList.add('error');
			label.textContent = status.error;
		} else if (status.listening) {
			state.classList.add('on');
			label.textContent = localize('connectedAgents.listening', "Listening on {0}", status.url);
		} else {
			label.textContent = localize('connectedAgents.off', "Off");
		}
		const advanced = host.settingsGroup();
		host.settingRow(advanced, localize('connectedAgents.port', "Port"), localize('connectedAgents.portDesc', "Loopback port of the server. Connected agents keep this address."), control => {
			const box = host.store.add(new InputBox(append(control, $('.volt-settings-input')), this.contextView, { ariaLabel: localize('connectedAgents.port', "Port"), inputBoxStyles: host.inputBoxStyles() }));
			box.value = String(status.port);
			host.store.add(addDisposableListener(box.inputElement, 'change', () => {
				const port = Number(box.value);
				if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
					void this.configuration.updateValue(EXTERNAL_MCP_PORT_SETTING, port === DEFAULT_EXTERNAL_MCP_PORT ? undefined : port);
				} else {
					box.value = String(status.port);
				}
			}));
		});
		host.settingRow(advanced, localize('connectedAgents.public', "Public address"), localize('connectedAgents.publicDesc', "An https tunnel to this server (cloudflared, ngrok, Tailscale Funnel), for ChatGPT and Claude connectors. Empty keeps it on this computer."), control => {
			const box = host.store.add(new InputBox(append(control, $('.volt-settings-input.wide')), this.contextView, { placeholder: 'https://…', ariaLabel: localize('connectedAgents.public', "Public address"), inputBoxStyles: host.inputBoxStyles() }));
			box.value = this.configuration.getValue<string>(EXTERNAL_MCP_PUBLIC_URL_SETTING) ?? '';
			host.store.add(addDisposableListener(box.inputElement, 'change', () => {
				const value = box.value.trim();
				if (value && !normalizePublicUrl(value)) {
					box.showMessage({ content: localize('connectedAgents.publicInvalid', "Use an https address."), type: MessageType.ERROR });
					return;
				}
				void this.configuration.updateValue(EXTERNAL_MCP_PUBLIC_URL_SETTING, normalizePublicUrl(value));
			}));
		});
	}

	private renderGrants(grants: readonly IExternalMcpGrantView[]): void {
		const { host } = this;
		host.sectionLabel(localize('connectedAgents.connected', "Connected"));
		if (!grants.length) {
			host.empty(localize('connectedAgents.none', "No agents connected yet. Connect one below; it asks you here before it can do anything."));
			return;
		}
		const list = append(host.target(), $('.volt-settings-list'));
		for (const grant of grants) {
			const row = append(list, $('.volt-settings-card.volt-external-mcp-grant'));
			row.dataset.grant = grant.id;
			const copy = append(row, $('.volt-settings-card-copy'));
			const title = append(copy, $('div.title'));
			append(title, $('span.name')).textContent = grant.clientName;
			const unverified = append(title, $('span.volt-external-mcp-unverified'));
			unverified.textContent = localize('connectedAgents.unverified', "unverified name");
			setAgentTooltip(unverified, localize('connectedAgents.unverifiedTip', "The agent chose this name when it registered; Volt cannot check it."));
			const chips = append(copy, $('.volt-external-mcp-chips'));
			for (const scope of grant.scopes) {
				const chip = append(chips, $('span.volt-external-mcp-chip'));
				chip.textContent = scopeCopy(scope).title;
				setAgentTooltip(chip, scopeCopy(scope).detail);
			}
			const used = grant.lastUsedAt
				? localize('connectedAgents.lastUsed', "Last used {0}{1}", fromNow(grant.lastUsedAt, true), grant.lastTool ? ` (${grant.lastTool})` : '')
				: localize('connectedAgents.neverUsed', "Not used yet");
			append(copy, $('.meta')).textContent = [
				localize('connectedAgents.since', "Connected {0}", fromNow(grant.createdAt, true)),
				used,
				localize('connectedAgents.calls', "{0} calls", grant.calls),
				describeRedirect(grant.redirectUri).label,
			].join(' · ');
			const revoke = host.store.add(new Button(row, { ...defaultButtonStyles, secondary: true }));
			revoke.label = localize('connectedAgents.revoke', "Revoke");
			revoke.element.classList.add('revoke');
			host.store.add(revoke.onDidClick(() => void this.mcp?.revoke(grant.id).then(() => host.rerender())));
		}
	}

	private renderConnect(status: IExternalMcpStatus): void {
		const { host } = this;
		host.sectionLabel(localize('connectedAgents.connect', "Connect an agent"));
		append(host.target(), $('.volt-settings-section-hint')).textContent = status.enabled
			? localize('connectedAgents.connectHint', "Run the setup for your agent. It opens a browser tab to sign in, and Volt asks you to allow it.")
			: localize('connectedAgents.connectHintOff', "Turn on Allow outside agents first.");
		for (const snippet of connectSnippets(status.url, { port: status.port, publicMcpUrl: status.publicMcpUrl })) {
			append(host.target(), $('.volt-external-mcp-snippet-title')).textContent = snippet.title;
			const row = append(host.target(), $('.volt-external-mcp-snippet'));
			row.dataset.snippet = snippet.id;
			append(row, $('code.volt-external-mcp-code')).textContent = snippet.code;
			const copyButton = append(row, $('button.volt-external-mcp-copy')) as HTMLButtonElement;
			copyButton.type = 'button';
			copyButton.appendChild(renderIcon(Codicon.copy));
			copyButton.setAttribute('aria-label', localize('connectedAgents.copy', "Copy"));
			setAgentTooltip(copyButton, localize('connectedAgents.copy', "Copy"));
			host.store.add(addDisposableListener(copyButton, 'click', () => {
				void this.clipboard.writeText(snippet.code);
				copyButton.replaceChildren(renderIcon(Codicon.check));
			}));
			append(host.target(), $('.volt-settings-section-hint')).textContent = snippet.note;
		}
	}
}
