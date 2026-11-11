/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { fromNow } from '../../../../base/common/date.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IVoltRelayService } from '../../../../platform/voltRelay/common/voltRelay.js';
import { IAgentCloudTasksService } from '../../../services/voltRuntime/browser/cloud/agentCloudTasksService.js';
import { describeMachine, IMachineCapacity, MACHINE_CAPACITY_CEILING, ORCH_MACHINE_CAPACITY_SETTING, ORCH_MEASURE_CAPACITY_COMMAND_ID, parseMachineCapacity } from '../../../services/voltRuntime/common/orchestration/machineCapacity.js';
import { IOrchestraMachine, localMachine, ORCHESTRA_COUNCIL_MODERATOR_SETTING, ORCHESTRA_COUNCIL_PARTICIPANTS_SETTING, runnerMachine } from '../../../services/voltRuntime/common/orchestration/orchestra.js';
import { DEFAULT_ORCH_LIMITS, ORCH_BUDGET_USD_SETTING, ORCH_DEFAULT_BUDGET_USD, ORCH_LIMIT_MAX, ORCH_MAX_PARALLEL_SETTING, ORCH_MAX_PARALLEL_TOTAL_SETTING, ORCH_MAX_TEAM_AGENTS_SETTING, readOrchLimits } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { VOLT_RELAY_CONNECT_COMMAND_ID } from '../../voltAgent/browser/automations/automationHooks.js';

export interface IOrchestrationPageHost {
	readonly store: DisposableStore;
	target(): HTMLElement;
	sectionLabel(label: string): void;
	settingsGroup(): HTMLElement;
	settingRow(parent: HTMLElement, title: string, desc: string | undefined, renderControl?: (host: HTMLElement) => void): HTMLElement;
	stepper(parent: HTMLElement, valueText: string, unit: string, onCommit: (next: number) => number, step: number): void;
	rerender(): void;
}

const RUNNERS_TIMEOUT_MS = 4_000;

/**
 * Volt Settings > Orchestration: how many agents this machine runs at once (measured on first
 * launch, editable, measured again on request), the limits a team or council works within, the
 * council's default seats, and the machines work can run on: this one and the remote servers
 * (Volt runners) connected through the user's relay, with Add Remote Server.
 */
export class OrchestrationPage {

	private readonly configuration: IConfigurationService;
	private readonly commands: ICommandService;
	private readonly quickInput: IQuickInputService;
	private readonly dialogs: IDialogService;
	private readonly clipboard: IClipboardService;
	private readonly notifications: INotificationService;
	private readonly runtime: IAgentRuntimeService | undefined;
	private readonly relay: IVoltRelayService | undefined;
	private readonly cloud: IAgentCloudTasksService | undefined;

	constructor(instantiationService: IInstantiationService, private readonly host: IOrchestrationPageHost) {
		const services = instantiationService.invokeFunction(accessor => ({
			configuration: accessor.get(IConfigurationService),
			commands: accessor.get(ICommandService),
			quickInput: accessor.get(IQuickInputService),
			dialogs: accessor.get(IDialogService),
			clipboard: accessor.get(IClipboardService),
			notifications: accessor.get(INotificationService),
			runtime: accessor.getIfExists(IAgentRuntimeService),
			relay: accessor.getIfExists(IVoltRelayService),
			cloud: accessor.getIfExists(IAgentCloudTasksService),
		}));
		this.configuration = services.configuration;
		this.commands = services.commands;
		this.quickInput = services.quickInput;
		this.dialogs = services.dialogs;
		this.clipboard = services.clipboard;
		this.notifications = services.notifications;
		this.runtime = services.runtime;
		this.relay = services.relay;
		this.cloud = services.cloud;
	}

	async render(isCurrent: () => boolean): Promise<void> {
		this.renderCapacity();
		this.renderLimits();
		this.renderCouncil();
		const machines = await this.loadMachines();
		if (!isCurrent()) {
			return;
		}
		await this.renderMachines(machines);
	}

	private get machineName(): string {
		return isMacintosh ? localize('orchestration.thisMac', "This Mac") : localize('orchestration.thisPC', "This PC");
	}

	private capacity(): IMachineCapacity | undefined {
		return parseMachineCapacity(this.configuration.getValue<unknown>(ORCH_MACHINE_CAPACITY_SETTING));
	}

	private renderCapacity(): void {
		const { host } = this;
		host.sectionLabel(this.machineName);
		const group = host.settingsGroup();
		const capacity = this.capacity();
		const canMeasure = !!CommandsRegistry.getCommand(ORCH_MEASURE_CAPACITY_COMMAND_ID);
		if (!capacity) {
			host.settingRow(group, localize('orchestration.notMeasured', "Not measured yet"), localize('orchestration.notMeasuredDesc', "Volt measures memory and cores to know how many agents this machine runs at once. Until then a chat runs {0} at a time and {1} in total.", DEFAULT_ORCH_LIMITS.runningPerParent, DEFAULT_ORCH_LIMITS.runningTotal), canMeasure ? control => this.measureButton(control, 'primary') : undefined);
			return;
		}
		const facts = [describeMachine(capacity), capacity.cpuModel, capacity.measuredAt ? localize('orchestration.measuredAgo', "measured {0}", fromNow(capacity.measuredAt, true)) : undefined].filter(Boolean).join(' · ');
		host.settingRow(group, localize('orchestration.comfortable', "Agents at once"), localize('orchestration.comfortableDesc', "How many agents run at once without asking you ({0}). A request for more at once asks how many to run at a time.", facts), control => host.stepper(control, String(capacity.recommended), '', next => this.writeCapacity({ recommended: next }).recommended, 1));
		host.settingRow(group, localize('orchestration.most', "Most at once"), localize('orchestration.mostDesc', "The ceiling Volt offers when a request asks for more: past it, builds and the editor slow down. About {0} MB per agent, {1} GB kept for you.", capacity.perAgentMb, Math.round(capacity.reservedMb / 1024)), control => host.stepper(control, String(capacity.max), '', next => this.writeCapacity({ max: next }).max, 1));
		if (canMeasure) {
			host.settingRow(group, localize('orchestration.measureAgain', "Measure again"), localize('orchestration.measureAgainDesc', "After adding memory, or to undo your changes above."), control => this.measureButton(control, 'secondary'));
		}
	}

	private measureButton(control: HTMLElement, kind: 'primary' | 'secondary'): void {
		const button = this.host.store.add(createVoltButton(control, kind));
		button.label = localize('orchestration.measure', "Measure");
		this.host.store.add(button.onDidClick(async () => {
			await this.commands.executeCommand(ORCH_MEASURE_CAPACITY_COMMAND_ID);
			this.host.rerender();
		}));
	}

	/** Saves one of the two numbers; `recommended` never passes `max`. Returns what was saved. */
	private writeCapacity(change: { readonly recommended?: number; readonly max?: number }): IMachineCapacity {
		const current = this.capacity()!;
		const clamp = (value: number) => Math.max(1, Math.min(MACHINE_CAPACITY_CEILING, Math.floor(value) || 1));
		const max = change.max !== undefined ? clamp(change.max) : current.max;
		const recommended = Math.min(max, change.recommended !== undefined ? clamp(change.recommended) : current.recommended);
		const next = { ...current, recommended, max };
		void this.configuration.updateValue(ORCH_MACHINE_CAPACITY_SETTING, next);
		return next;
	}

	private renderLimits(): void {
		const { host } = this;
		const limits = readOrchLimits(key => this.configuration.getValue<unknown>(key));
		host.sectionLabel(localize('orchestration.limits', "Teams and subagents"));
		const group = host.settingsGroup();
		const number = (key: string, value: number, min: number, max: number) => (next: number) => {
			const clamped = Math.max(min, Math.min(max, Math.floor(next) || 0));
			void this.configuration.updateValue(key, clamped);
			return clamped;
		};
		const raw = (key: string) => {
			const value = this.configuration.getValue<unknown>(key);
			return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
		};
		host.settingRow(group, localize('orchestration.perChat', "Per chat at once"), localize('orchestration.perChatDesc', "Subagents and team members one chat runs at once. 0 follows this machine (now {0}).", limits.runningPerParent), control => host.stepper(control, String(raw(ORCH_MAX_PARALLEL_SETTING)), '', number(ORCH_MAX_PARALLEL_SETTING, limits.runningPerParent, 0, ORCH_LIMIT_MAX.runningPerParent), 1));
		host.settingRow(group, localize('orchestration.total', "In total at once"), localize('orchestration.totalDesc', "Across every chat. 0 follows this machine (now {0}).", limits.runningTotal), control => host.stepper(control, String(raw(ORCH_MAX_PARALLEL_TOTAL_SETTING)), '', number(ORCH_MAX_PARALLEL_TOTAL_SETTING, limits.runningTotal, 0, ORCH_LIMIT_MAX.runningTotal), 1));
		host.settingRow(group, localize('orchestration.perRequest', "Agents per request"), localize('orchestration.perRequestDesc', "The most agents one request may start as a team or council. They run as many at a time as allowed above; the rest wait their turn."), control => host.stepper(control, String(limits.maxTeamAgents), '', number(ORCH_MAX_TEAM_AGENTS_SETTING, limits.maxTeamAgents, 1, ORCH_LIMIT_MAX.teamAgents), 5));
		const budget = this.configuration.getValue<unknown>(ORCH_BUDGET_USD_SETTING);
		host.settingRow(group, localize('orchestration.budget', "Budget per request (USD)"), localize('orchestration.budgetDesc', "What a request's subagents and team members may spend together; past it Volt stops them and starts no more until your next message. 0 turns it off. A team of 30 needs more than the default."), control => host.stepper(control, String(typeof budget === 'number' ? budget : ORCH_DEFAULT_BUDGET_USD), '', next => {
			const value = Math.max(0, Math.round(next));
			void this.configuration.updateValue(ORCH_BUDGET_USD_SETTING, value);
			return value;
		}, 5));
	}

	private modelItems(): IQuickPickItem[] {
		return (this.runtime?.listCatalog() ?? []).filter(item => item.enabled).map(item => ({ id: item.ref, label: item.label, description: [item.qualifier, item.providerId].filter(Boolean).join(' · ') }));
	}

	private renderCouncil(): void {
		const { host } = this;
		host.sectionLabel(localize('orchestration.council', "Councils"));
		const group = host.settingsGroup();
		const items = this.modelItems();
		const labelOf = (value: string) => items.find(item => item.id === value)?.label ?? value;
		const participants = this.configuration.getValue<unknown>(ORCHESTRA_COUNCIL_PARTICIPANTS_SETTING);
		const seats = Array.isArray(participants) ? participants.filter((value): value is string => typeof value === 'string' && !!value) : [];
		host.settingRow(group, localize('orchestration.seats', "Council members"), seats.length
			? seats.map(labelOf).join(', ')
			: localize('orchestration.seatsAuto', "One model per connected provider, at most four. A council asks each on its own, has them review each other anonymously, then writes a decision."), control => {
				const button = host.store.add(createVoltButton(control, 'secondary'));
				button.label = localize('orchestration.choose', "Choose...");
				host.store.add(button.onDidClick(async () => {
					const picked = await this.quickInput.pick(items.map(item => ({ ...item, picked: seats.includes(item.id!) })), { canPickMany: true, placeHolder: localize('orchestration.seatsPick', "Models a council asks when the request names none (none: one per provider)") });
					if (picked) {
						await this.configuration.updateValue(ORCHESTRA_COUNCIL_PARTICIPANTS_SETTING, picked.map(item => item.id!));
						host.rerender();
					}
				}));
			});
		const moderator = this.configuration.getValue<unknown>(ORCHESTRA_COUNCIL_MODERATOR_SETTING);
		host.settingRow(group, localize('orchestration.moderator', "Moderator"), typeof moderator === 'string' && moderator ? labelOf(moderator) : localize('orchestration.moderatorChat', "The chat's own model writes the decision."), control => {
			const button = host.store.add(createVoltButton(control, 'secondary'));
			button.label = localize('orchestration.choose', "Choose...");
			host.store.add(button.onDidClick(async () => {
				const chat: IQuickPickItem = { id: '', label: localize('orchestration.moderatorChatItem', "The chat's own model") };
				const picked = await this.quickInput.pick([chat, ...items], { placeHolder: localize('orchestration.moderatorPick', "Model that writes a council's decision") });
				if (picked) {
					await this.configuration.updateValue(ORCHESTRA_COUNCIL_MODERATOR_SETTING, picked.id ?? '');
					host.rerender();
				}
			}));
		});
	}

	private async loadMachines(): Promise<{ readonly machines: readonly IOrchestraMachine[]; readonly relayOnline: boolean; readonly relayUrl?: string; readonly error?: string }> {
		const local = localMachine(this.machineName, this.capacity(), 0);
		const state = await this.relay?.getState().catch(() => undefined);
		if (!this.cloud || state?.status !== 'online') {
			return { machines: [local], relayOnline: false };
		}
		try {
			const runners = await Promise.race([this.cloud.runners(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(localize('orchestration.relaySlow', "The relay did not answer."))), RUNNERS_TIMEOUT_MS))]);
			return { machines: [local, ...runners.map(machine => runnerMachine(machine, Date.now()))], relayOnline: true, relayUrl: state.url };
		} catch (err) {
			return { machines: [local], relayOnline: true, relayUrl: state.url, error: toErrorMessage(err) };
		}
	}

	private async renderMachines(loaded: Awaited<ReturnType<OrchestrationPage['loadMachines']>>): Promise<void> {
		const { host } = this;
		host.sectionLabel(localize('orchestration.machines', "Machines"));
		append(host.target(), $('.volt-settings-section-hint')).textContent = localize('orchestration.machinesHint', "Where agents' work runs. Mention one in a chat with @ > Machines (\"@{0} run the tests\"); agents send work to a remote server with machine_run and get a branch back.", this.machineName);
		const group = host.settingsGroup();
		for (const machine of loaded.machines) {
			host.settingRow(group, machine.name, machine.kind === 'local'
				? localize('orchestration.localRow', "This machine · {0}", machine.detail)
				: localize('orchestration.remoteRow', "{0} · {1}", machine.online ? localize('orchestration.online', "Online") : localize('orchestration.offline', "Offline"), machine.detail));
		}
		if (loaded.error) {
			host.settingRow(group, localize('orchestration.runnersError', "Remote servers"), loaded.error);
		}
		if (!this.relay) {
			return;
		}
		if (!loaded.relayOnline) {
			host.settingRow(group, localize('orchestration.addServer', "Add a remote server"), localize('orchestration.needsRelay', "Remote servers reach Volt through your Volt Relay (apps/relay, self-hosted). Connect to it first; then add servers here."), control => {
				const button = host.store.add(createVoltButton(control, 'primary'));
				button.label = localize('orchestration.connectRelay', "Connect to Relay...");
				host.store.add(button.onDidClick(async () => {
					await this.commands.executeCommand(VOLT_RELAY_CONNECT_COMMAND_ID);
					host.rerender();
				}));
			});
			return;
		}
		host.settingRow(group, localize('orchestration.addServer', "Add a remote server"), localize('orchestration.addServerDesc', "A Mac, a Linux box or a cloud VM with Claude Code or Codex signed in. Volt gives you one command to run there; it shows up here once it connects."), control => {
			const button = host.store.add(createVoltButton(control, 'primary'));
			button.label = localize('orchestration.addServerButton', "Add Remote Server");
			host.store.add(button.onDidClick(() => void this.addServer(loaded.relayUrl)));
		});
	}

	private async addServer(relayUrl: string | undefined): Promise<void> {
		const name = await this.quickInput.input({
			prompt: localize('orchestration.serverName', "Name the server (shown in @ Machines)"),
			placeHolder: 'mac-studio',
			validateInput: async value => /^[\w .-]{1,40}$/.test(value.trim()) ? undefined : localize('orchestration.serverNameBad', "Letters, numbers, spaces, dots and dashes; up to 40."),
		});
		if (!name?.trim() || !this.relay) {
			return;
		}
		let code: string;
		try {
			const pairing = await this.relay.request<{ readonly code: string }>('POST', '/pairings', { kind: 'runner', name: name.trim() });
			code = pairing.code;
		} catch (err) {
			this.notifications.error(localize('orchestration.pairFailed', "Could not create a pairing code: {0}. Only the relay's first (admin) device can add servers; on the relay host, `volt-relay pair --runner` makes one too.", toErrorMessage(err)));
			return;
		}
		const env = `VOLT_RELAY_URL=${relayUrl ?? '<relay url>'} VOLT_RELAY_PAIRING_CODE=${code} VOLT_RUNNER_NAME="${name.trim()}" VOLT_RUNNER_MAX_PARALLEL=2`;
		const command = `${env} node apps/relay/bin/volt-runner.mjs`;
		const { result } = await this.dialogs.prompt<boolean>({
			type: 'info',
			message: localize('orchestration.runOnServer', "Run this on {0}", name.trim()),
			detail: localize('orchestration.runOnServerDetail', "In a checkout of Volt on that machine (Node 20+, git, and Claude Code or Codex signed in):\n\n{0}\n\nThe code works once and expires soon. Or build apps/relay/Dockerfile.runner and pass the same variables. VOLT_RUNNER_MAX_PARALLEL is how many tasks it runs at once.", command),
			buttons: [{ label: localize('orchestration.copyCommand', "Copy Command"), run: () => true }],
			cancelButton: localize('orchestration.done', "Done"),
		});
		if (result) {
			await this.clipboard.writeText(command);
			this.notifications.info(localize('orchestration.copied', "Copied. {0} shows up under Machines once it connects.", name.trim()));
		}
		this.host.rerender();
	}
}
