/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { describeSandbox, IVoltSandboxSettings, VoltSandboxLevel } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { ACCESS_MODE_OPTIONS, accessModeOption, VoltAccessMode } from '../../../../services/voltRuntime/common/access/accessModes.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { createAccessIcon } from '../chrome/accessIcons.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';

export interface IAgentAccessPickerHost {
	/** The chat the picks apply to. */
	sessionId(): string;
	/** CLI agents run in the chat's OS sandbox, so the menu offers its level too. */
	isAgent(): boolean;
}

type AccessPick =
	| { readonly kind: 'mode'; readonly mode: VoltAccessMode }
	| { readonly kind: 'sandbox'; readonly level: VoltSandboxLevel }
	| { readonly kind: 'network' };

/**
 * The chat's permissions under the composer, as in Codex: Full access, Auto, Auto-accept edits or
 * Supervised. A pick holds for this chat only; Settings keeps the default for new chats.
 */
export class AgentAccessPicker extends Disposable {

	readonly element: HTMLButtonElement;
	private readonly icon: HTMLElement;
	private readonly label: HTMLElement;

	constructor(
		private readonly host: IAgentAccessPickerHost,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super();
		this.element = $('button.volt-agent-status-access') as HTMLButtonElement;
		this.element.type = 'button';
		this.element.setAttribute('aria-haspopup', 'menu');
		this.icon = append(this.element, $('span.icon'));
		this.label = append(this.element, $('span.label'));
		this.element.appendChild(renderIcon(Codicon.chevronDown)).classList.add('chevron');
		this._register(addDisposableListener(this.element, 'click', e => {
			EventHelper.stop(e, true);
			this.open();
		}));
		this._register(this.runtime.onDidChangeAccess(() => this.render()));
		this.render();
	}

	/** Re-reads the chat's mode, e.g. after the editor switched to another chat. */
	render(): void {
		const sessionId = this.host.sessionId();
		const option = accessModeOption(this.runtime.getAccessMode(sessionId));
		this.icon.replaceChildren(createAccessIcon(option.id));
		this.label.textContent = option.label;
		this.element.dataset.mode = option.id;
		const sandbox = this.runtime.getSandboxSettings(sessionId);
		const tooltip = this.host.isAgent() && sandbox.level !== 'off' ? `${option.description}\n${describeSandbox(sandbox)}` : option.description;
		setAgentTooltip(this.element, tooltip);
		this.element.setAttribute('aria-label', localize('voltAgent.accessAria', "Permissions: {0}", option.label));
	}

	private open(): void {
		const sessionId = this.host.sessionId();
		const current = this.runtime.getAccessMode(sessionId);
		const sections: IVoltMenuSection<AccessPick>[] = [{
			id: 'access',
			title: localize('voltAgent.permissions', "Permissions"),
			items: ACCESS_MODE_OPTIONS.map(option => ({
				id: option.id,
				label: option.label,
				subtitle: option.description,
				icon: () => createAccessIcon(option.id),
				checked: option.id === current,
				data: { kind: 'mode', mode: option.id },
			})),
		}];
		if (this.host.isAgent()) {
			sections.push(this.sandboxSection(this.runtime.getSandboxSettings(sessionId)));
		}
		this.element.setAttribute('aria-expanded', 'true');
		showVoltMenu<AccessPick>(this.contextViewService, {
			anchor: this.element,
			position: 'above',
			align: 'left',
			width: 300,
			ariaLabel: localize('voltAgent.permissions', "Permissions"),
			className: 'volt-agent-access-menu',
			sections,
			onPick: item => this.pick(sessionId, item.data),
			onHide: () => this.element.setAttribute('aria-expanded', 'false'),
		});
	}

	private sandboxSection(settings: IVoltSandboxSettings): IVoltMenuSection<AccessPick> {
		const level = (id: VoltSandboxLevel, icon: typeof Codicon.edit, label: string, subtitle: string): IVoltMenuItem<AccessPick> => ({
			id: `sandbox:${id}`, label, subtitle, icon, checked: settings.level === id, data: { kind: 'sandbox', level: id },
		});
		const items: IVoltMenuItem<AccessPick>[] = [
			level('off', Codicon.circleSlash, localize('voltAgent.sandbox.off', "Off"), localize('voltAgent.sandbox.off.desc', "The agent runs with your permissions")),
			level('workspace-write', Codicon.edit, localize('voltAgent.sandbox.workspace', "Workspace write"), localize('voltAgent.sandbox.workspace.desc', "Writes stay in this project, its worktree and temp folders")),
			level('read-only', Codicon.lock, localize('voltAgent.sandbox.readOnly', "Read-only"), localize('voltAgent.sandbox.readOnly.desc', "Nothing is written except temp folders and folders you allow")),
		];
		if (settings.level !== 'off') {
			items.push({
				id: 'network',
				label: localize('voltAgent.sandbox.networkAccess', "Network access"),
				subtitle: settings.network
					? localize('voltAgent.sandbox.network.on', "The agent can reach the internet")
					: localize('voltAgent.sandbox.network.off', "Only the agent's own API and the hosts you allow"),
				icon: Codicon.globe,
				checked: settings.network,
				data: { kind: 'network' },
			});
		}
		return { id: 'sandbox', title: localize('voltAgent.sandbox.heading', "Sandbox"), items };
	}

	private async pick(sessionId: string, pick: AccessPick): Promise<void> {
		if (pick.kind === 'mode') {
			await this.runtime.setAccessMode(pick.mode, sessionId);
			return;
		}
		const settings = this.runtime.getSandboxSettings(sessionId);
		const next: IVoltSandboxSettings = pick.kind === 'sandbox' ? { ...settings, level: pick.level } : { ...settings, network: !settings.network };
		await this.runtime.setSandboxSettings(sessionId, next);
		this.render();
	}
}
