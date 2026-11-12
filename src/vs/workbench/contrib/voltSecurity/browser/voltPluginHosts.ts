/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IVoltPluginStatus, PLUGIN_SANDBOXED_HOSTS_SETTING, PLUGIN_UNSANDBOXED_FALLBACK_SETTING, readUnsandboxedFallback } from '../../../../platform/voltPlugins/common/pluginHosts.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

/**
 * T2 plugin hosts in the window (spec H.9, F.13): the two settings, the once-per-machine question
 * when the OS can't sandbox Volt's own plugins, a status-bar count of broken plugins with
 * "Restart" and the last stderr lines, and a badge while Volt's plugins run unsandboxed.
 */

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.plugins.hosts',
	title: localize('voltPlugins.hosts.title', "Plugin Hosts"),
	type: 'object',
	properties: {
		[PLUGIN_SANDBOXED_HOSTS_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltPlugins.sandboxedHosts', "Run Volt's own plugins (Memory) in sandboxed plugin hosts: a separate process the OS sandbox confines, started when a plugin is first used. When off, they run inside Volt as before, without a sandbox."),
		},
		[PLUGIN_UNSANDBOXED_FALLBACK_SETTING]: {
			type: 'string',
			enum: ['ask', 'allow', 'deny'],
			enumDescriptions: [
				localize('voltPlugins.fallback.ask', "Ask once, the first time Volt finds this system can't sandbox."),
				localize('voltPlugins.fallback.allow', "Run Volt's own plugins without a sandbox, as before, labelled Not sandboxed."),
				localize('voltPlugins.fallback.deny', "Turn those features off."),
			],
			default: 'ask',
			scope: ConfigurationScope.MACHINE,
			description: localize('voltPlugins.unsandboxedFallback', "When this system can't sandbox at all (no OS sandbox, or an unsupported platform), whether Volt's own plugins run without one. Never applies when a sandbox exists but fails to start: then the feature refuses."),
		},
	},
});

const SHOW_BROKEN_COMMAND = 'volt.plugins.showStopped';

class VoltPluginHostsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltPluginHosts';

	private readonly broken = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly unsandboxed = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		if (!stdio.pluginStatus || !stdio.pluginAvailability) {
			return; // No execution host here (a browser): nothing runs in a plugin host.
		}
		if (stdio.onDidChangePlugins) {
			this._register(stdio.onDidChangePlugins(() => void this.refresh()));
		}
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PLUGIN_SANDBOXED_HOSTS_SETTING) || e.affectsConfiguration(PLUGIN_UNSANDBOXED_FALLBACK_SETTING)) {
				void this.checkSandbox(false);
			}
		}));
		void this.checkSandbox(true);
		void this.refresh();
	}

	/** F.13: decided from static facts before any launch, asked once per machine, shown while it applies. */
	private async checkSandbox(ask: boolean): Promise<void> {
		const availability = await this.stdio.pluginAvailability!().catch(() => undefined);
		const off = this.configurationService.getValue(PLUGIN_SANDBOXED_HOSTS_SETTING) === false;
		const unsupported = !availability?.sandboxed ? availability?.unsupported : undefined;
		const fallback = readUnsandboxedFallback(this.configurationService.getValue(PLUGIN_UNSANDBOXED_FALLBACK_SETTING));
		if (unsupported !== undefined && fallback === 'ask' && ask && !off) {
			this.notificationService.prompt(Severity.Warning, localize('voltPlugins.askDegraded', "Volt can't sandbox its own plugins on this system ({0}). Run them without a sandbox, as before?", unsupported), [
				{ label: localize('voltPlugins.askDegraded.yes', "Run Without a Sandbox"), run: () => this.configurationService.updateValue(PLUGIN_UNSANDBOXED_FALLBACK_SETTING, 'allow', ConfigurationTarget.USER_LOCAL) },
				{ label: localize('voltPlugins.askDegraded.no', "Turn Them Off"), run: () => this.configurationService.updateValue(PLUGIN_UNSANDBOXED_FALLBACK_SETTING, 'deny', ConfigurationTarget.USER_LOCAL) },
			], { sticky: true });
		}
		const label = off
			? localize('voltPlugins.notSandboxed.setting', "Not sandboxed (setting)")
			: unsupported !== undefined && fallback === 'allow' ? localize('voltPlugins.notSandboxed.os', "Not sandboxed (OS unsupported)") : undefined;
		if (!label) {
			this.unsandboxed.clear();
			return;
		}
		const tooltip = off
			? localize('voltPlugins.notSandboxed.settingTooltip', "Volt's own plugins (Memory) run inside Volt without a sandbox because {0} is off.", PLUGIN_SANDBOXED_HOSTS_SETTING)
			: localize('voltPlugins.notSandboxed.osTooltip', "This system can't sandbox ({0}), so Volt's own plugins (Memory) run inside Volt without one, as you allowed ({1}).", unsupported ?? '', PLUGIN_UNSANDBOXED_FALLBACK_SETTING);
		const entry = { name: localize('voltPlugins.notSandboxed.name', "Plugins Not Sandboxed"), text: `$(unverified) ${label}`, ariaLabel: label, tooltip, kind: 'warning' as const };
		if (this.unsandboxed.value) {
			this.unsandboxed.value.update(entry);
		} else {
			this.unsandboxed.value = this.statusbarService.addEntry(entry, `${VoltPluginHostsContribution.ID}.unsandboxed`, StatusbarAlignment.LEFT, -1001);
		}
	}

	/** H.9: a count of broken plugins; clicking it offers Restart with each one's last stderr lines. */
	private async refresh(): Promise<void> {
		const rows = await this.stdio.pluginStatus!().catch(() => [] as readonly IVoltPluginStatus[]);
		const broken = rows.filter(row => row.state === 'broken');
		if (!broken.length) {
			this.broken.clear();
			return;
		}
		const text = broken.length === 1
			? localize('voltPlugins.stopped.one', "{0} stopped", broken[0].label)
			: localize('voltPlugins.stopped.many', "{0} plugins stopped", broken.length);
		const entry = {
			name: localize('voltPlugins.stopped.name', "Stopped Plugins"),
			text: `$(error) ${text}`,
			ariaLabel: text,
			tooltip: localize('voltPlugins.stopped.tooltip', "Stopped after repeated crashes: {0}. Click to restart.", broken.map(row => row.label).join(', ')),
			command: SHOW_BROKEN_COMMAND,
			kind: 'error' as const,
		};
		if (this.broken.value) {
			this.broken.value.update(entry);
		} else {
			this.broken.value = this.statusbarService.addEntry(entry, `${VoltPluginHostsContribution.ID}.broken`, StatusbarAlignment.LEFT, -1002);
		}
	}
}

registerWorkbenchContribution2(VoltPluginHostsContribution.ID, VoltPluginHostsContribution, WorkbenchPhase.Eventually);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: SHOW_BROKEN_COMMAND, visibility: 'internal', title: localize2('voltPlugins.showStopped', "Show Stopped Plugins"), f1: true, category: localize2('voltPlugins.category', "Volt") });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const stdio = accessor.get(IVoltStdioService);
		const notifications = accessor.get(INotificationService);
		const rows = await stdio.pluginStatus?.().catch(() => []) ?? [];
		const broken = rows.filter(row => row.state === 'broken');
		if (!broken.length) {
			notifications.info(localize('voltPlugins.noneStopped', "No plugin is stopped."));
			return;
		}
		for (const row of broken) {
			const tail = row.stderr ? `\n${row.stderr.split('\n').slice(-5).join('\n')}` : row.detail ? `\n${row.detail}` : '';
			notifications.prompt(Severity.Error, localize('voltPlugins.stoppedRow', "{0} stopped after repeated crashes.{1}", row.label, tail), [
				{ label: localize('voltPlugins.restart', "Restart"), run: () => void stdio.restartPlugin?.(row.id) },
			]);
		}
	}
});
