/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { raceTimeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { sandboxPlatformUnavailable } from '../../../../services/voltRuntime/common/access/sandboxRefusal.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { describeSandbox, IVoltSandboxSettings, VoltSandboxLevel } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import type { ISandboxPolicyFilesInfo } from '../../../../../platform/voltSandbox/common/sandboxPolicyFiles.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { ACCESS_MODE_OPTIONS, accessModeOption, VoltAccessMode } from '../../../../services/voltRuntime/common/access/accessModes.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { createAccessIcon, createSandboxIcon } from '../chrome/accessIcons.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';

export interface IAgentAccessPickerHost {
	/** The chat the picks apply to. */
	sessionId(): string;
	/** CLI agents run in the chat's OS sandbox, so the menu offers its level too. */
	isAgent(): boolean;
}

/**
 * Why no sandbox level can be used where the agents run, or undefined. The workbench's own OS:
 * the agent runtime runs on this machine in the desktop app.
 */
function sandboxUnavailableHere(): string | undefined {
	const reason = sandboxPlatformUnavailable(isWindows ? 'win32' : '');
	return reason ? localize('voltAgent.sandbox.unavailableWindows', "OS sandboxing isn't available on Windows yet.") : undefined;
}

type AccessPick =
	| { readonly kind: 'mode'; readonly mode: VoltAccessMode }
	| { readonly kind: 'sandbox'; readonly level: VoltSandboxLevel }
	| { readonly kind: 'network' }
	/** A quiet line about the sandbox policy files; not pickable. */
	| { readonly kind: 'info' };

const USER_POLICY_FILE = '~/.volt/sandbox.json';
const REPO_POLICY_FILE = '.volt/sandbox.json';

/**
 * Quiet lines under the sandbox levels: the policy files in effect, a broken one, and what was
 * ignored from them (a repository's widenings, the user's the managed policy denies).
 */
function policyFileItems(info: ISandboxPolicyFilesInfo | undefined): IVoltMenuItem<AccessPick>[] {
	if (!info) {
		return [];
	}
	const items: IVoltMenuItem<AccessPick>[] = [];
	const line = (id: string, label: string, warning: boolean, subtitle?: string, tooltip?: string): void => {
		items.push({ id: `policy-file:${id}`, label, ...(subtitle ? { subtitle } : {}), icon: warning ? Codicon.warning : Codicon.info, disabled: true, ...(tooltip ? { tooltip } : {}), data: { kind: 'info' } });
	};
	for (const file of info.files) {
		const name = file.source === 'user' ? USER_POLICY_FILE : REPO_POLICY_FILE;
		if (file.state === 'error') {
			line(`${file.source}:${file.path}`, file.source === 'user'
				? localize('voltAgent.sandbox.userPolicyError', "{0} has an error; the agent won't start", name)
				: localize('voltAgent.sandbox.repoPolicyError', "Ignored {0}: it has an error", name), true, file.problem, file.path);
		} else {
			line(`${file.source}:${file.path}`, file.source === 'user'
				? localize('voltAgent.sandbox.userPolicy', "Rules from {0}", name)
				: localize('voltAgent.sandbox.repoPolicy', "Narrowed by {0}", name), false, undefined, file.path);
		}
	}
	for (const source of ['workspace', 'user'] as const) {
		const notes = info.ignored.filter(note => note.source === source);
		if (notes.length) {
			const name = source === 'user' ? USER_POLICY_FILE : REPO_POLICY_FILE;
			line(`ignored:${source}`, localize('voltAgent.sandbox.policyIgnored', "Ignored from {0}: {1}", name, notes.map(note => `${note.field} ${note.value}`).join(', ')), false, undefined, notes.map(note => `${note.field} ${note.value}: ${note.reason}`).join('\n'));
		}
	}
	return items;
}

/**
 * The chat's permissions under the composer: Supervised (default), Auto-accept edits, Auto or
 * Full access. A pick holds for this chat only; Settings keeps the default for new chats.
 */
export class AgentAccessPicker extends Disposable {

	readonly element: HTMLButtonElement;
	private readonly icon: HTMLElement;
	private readonly label: HTMLElement;
	/** The sandbox level's glyph after the label while the chat's agent is sandboxed. */
	private readonly sandboxIcon: HTMLElement;
	/** In a new chat's picker row it has no tooltip, like project, branch and machine beside it. */
	private inLandingRow = false;

	constructor(
		private readonly host: IAgentAccessPickerHost,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
	) {
		super();
		this.element = $('button.volt-agent-status-access') as HTMLButtonElement;
		this.element.type = 'button';
		this.element.setAttribute('aria-haspopup', 'menu');
		this.icon = append(this.element, $('span.icon'));
		this.label = append(this.element, $('span.label'));
		this.sandboxIcon = append(this.element, $('span.sandbox'));
		this.element.appendChild(renderIcon(Codicon.chevronDown)).classList.add('chevron');
		this._register(addDisposableListener(this.element, 'click', e => {
			EventHelper.stop(e, true);
			void this.open();
		}));
		this._register(this.runtime.onDidChangeAccess(() => this.render()));
		this.render();
	}

	/** Re-reads the chat's mode, e.g. after the editor switched to another chat. */
	render(): void {
		const sessionId = this.host.sessionId();
		const option = accessModeOption(this.runtime.getAccessMode(sessionId));
		// The branch and worktree icons' weight beside it (1.5 on the 24px grid, drawn at 14px).
		this.icon.replaceChildren(createAccessIcon(option.id, '1.5'));
		this.label.textContent = option.label;
		this.element.dataset.mode = option.id;
		const sandbox = this.runtime.getSandboxSettings(sessionId);
		const unavailable = sandboxUnavailableHere();
		const sandboxed = this.host.isAgent() && sandbox.level !== 'off';
		const tooltip = sandboxed
			? `${option.description}\n${unavailable ? localize('voltAgent.sandbox.unavailableTooltip', "{0} This chat's agent will not start until its sandbox is off.", unavailable) : describeSandbox(sandbox)}`
			: option.description;
		setAgentTooltip(this.element, this.inLandingRow ? undefined : tooltip);
		// The permissions say what is asked first; the sandbox what the agent can reach at all. Both show.
		this.sandboxIcon.replaceChildren(...(sandboxed ? [createSandboxIcon(sandbox.level)] : []));
		this.sandboxIcon.classList.toggle('hidden', !sandboxed);
		this.element.classList.toggle('sandboxed', sandboxed);
		this.element.setAttribute('aria-label', sandboxed
			? localize('voltAgent.accessSandboxAria', "Permissions: {0}. Sandbox: {1}", option.label, sandbox.level === 'read-only' ? localize('voltAgent.sandbox.readOnly', "Read-only") : localize('voltAgent.sandbox.workspace', "Workspace write"))
			: localize('voltAgent.accessAria', "Permissions: {0}", option.label));
	}

	/** What the sandbox policy files do to the chat's sandbox, read as its next launch would (a few stats). */
	private async readPolicyFiles(sessionId: string): Promise<ISandboxPolicyFilesInfo | undefined> {
		const request = this.host.isAgent() ? this.runtime.chatExec(sessionId, 'agent').sandbox : undefined;
		return request && this.stdio.sandboxPolicyFiles ? this.stdio.sandboxPolicyFiles(request).catch(() => undefined) : undefined;
	}

	/** The editor moved it into or out of a new chat's picker row (placeAccess in agentEditor.ts). */
	setInLandingRow(inLandingRow: boolean): void {
		if (this.inLandingRow !== inLandingRow) {
			this.inLandingRow = inLandingRow;
			this.render();
		}
	}

	private async open(): Promise<void> {
		const sessionId = this.host.sessionId();
		// A slow execution host never holds the menu up: it opens without the lines.
		const policyFiles = await raceTimeout(this.readPolicyFiles(sessionId), 250);
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
			sections.push(this.sandboxSection(this.runtime.getSandboxSettings(sessionId), policyFiles));
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

	private sandboxSection(settings: IVoltSandboxSettings, policyFiles: ISandboxPolicyFilesInfo | undefined): IVoltMenuSection<AccessPick> {
		// No OS sandbox on this machine: the levels show why instead of silently running unconfined. Off stays pickable.
		const unavailable = sandboxUnavailableHere();
		const level = (id: VoltSandboxLevel, label: string, subtitle: string): IVoltMenuItem<AccessPick> => ({
			id: `sandbox:${id}`, label, subtitle: unavailable && id !== 'off' ? unavailable : subtitle, icon: () => createSandboxIcon(id), checked: settings.level === id, data: { kind: 'sandbox', level: id },
			...(unavailable && id !== 'off' ? { disabled: true, tooltip: unavailable } : {}),
		});
		const items: IVoltMenuItem<AccessPick>[] = [
			level('off', localize('voltAgent.sandbox.off', "Off"), localize('voltAgent.sandbox.off.desc', "The agent runs with your permissions")),
			level('workspace-write', localize('voltAgent.sandbox.workspace', "Workspace write"), localize('voltAgent.sandbox.workspace.desc', "Writes stay in this project, its worktree and temp folders")),
			level('read-only', localize('voltAgent.sandbox.readOnly', "Read-only"), localize('voltAgent.sandbox.readOnly.desc', "Nothing is written except temp folders and folders you allow")),
		];
		if (settings.level !== 'off') {
			items.push({
				id: 'network',
				label: localize('voltAgent.sandbox.networkAccess', "Network access"),
				subtitle: settings.network
					? localize('voltAgent.sandbox.network.on', "The agent can reach the internet")
					: localize('voltAgent.sandbox.network.off', "Only the agent's own API and the hosts you allow"),
				icon: () => createSandboxIcon('network'),
				checked: settings.network,
				data: { kind: 'network' },
			});
			items.push(...policyFileItems(policyFiles));
		}
		return { id: 'sandbox', title: localize('voltAgent.sandbox.heading', "Sandbox"), items };
	}

	private async pick(sessionId: string, pick: AccessPick): Promise<void> {
		if (pick.kind === 'info') {
			return;
		}
		if (pick.kind === 'mode') {
			await this.runtime.setAccessMode(pick.mode, sessionId);
			return;
		}
		if (pick.kind === 'sandbox' && pick.level !== 'off' && sandboxUnavailableHere()) {
			return;
		}
		const settings = this.runtime.getSandboxSettings(sessionId);
		const next: IVoltSandboxSettings = pick.kind === 'sandbox' ? { ...settings, level: pick.level } : { ...settings, network: !settings.network };
		await this.runtime.setSandboxSettings(sessionId, next);
		this.render();
	}
}
