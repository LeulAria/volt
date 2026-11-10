/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { computeMachineCapacity, describeMachine, IMachineCapacity, ORCH_MACHINE_CAPACITY_SETTING, ORCH_MEASURE_CAPACITY_COMMAND_ID, parseMachineCapacity } from '../../../services/voltRuntime/common/orchestration/machineCapacity.js';

/** Reads memory and cores from the main process and saves what the machine can run in the user's settings. */
async function measureAndSave(nativeHostService: INativeHostService, configurationService: IConfigurationService): Promise<IMachineCapacity> {
	const [stats, props] = await Promise.all([nativeHostService.getOSStatistics(), nativeHostService.getOSProperties()]);
	const capacity = computeMachineCapacity({
		totalMemMb: stats.totalmem / (1024 * 1024),
		cpus: props.cpus.length || 1,
		cpuModel: props.cpus[0]?.model?.trim(),
		platform: props.platform,
		arch: props.arch,
	}, Date.now());
	await configurationService.updateValue(ORCH_MACHINE_CAPACITY_SETTING, capacity, ConfigurationTarget.USER);
	return capacity;
}

/**
 * Measures the machine once, on the first launch that finds no capacity in the settings. After
 * that the saved numbers stand (the user edits them or measures again in Settings > Orchestration),
 * so a launch never rewrites what the user chose.
 */
class AgentMachineCapacityContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltMachineCapacity';

	constructor(
		@INativeHostService nativeHostService: INativeHostService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		super();
		const saved = configurationService.inspect<unknown>(ORCH_MACHINE_CAPACITY_SETTING);
		if (parseMachineCapacity(saved.userValue ?? saved.applicationValue)) {
			return;
		}
		measureAndSave(nativeHostService, configurationService).then(
			capacity => logService.info(`[volt orchestra] this machine runs ${capacity.recommended} agents at once (max ${capacity.max}): ${describeMachine(capacity)}`),
			err => logService.warn('[volt orchestra] could not measure this machine', err),
		);
	}
}

registerWorkbenchContribution2(AgentMachineCapacityContribution.ID, AgentMachineCapacityContribution, WorkbenchPhase.Eventually);

registerAction2(class MeasureMachineCapacityAction extends Action2 {
	constructor() {
		super({
			visibility: 'internal',
			id: ORCH_MEASURE_CAPACITY_COMMAND_ID,
			title: localize2('voltOrchestra.measureCapacity', "Measure How Many Agents This Machine Can Run"),
			category: localize2('voltOrchestra.category', "Volt"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, options?: { readonly quiet?: boolean }): Promise<IMachineCapacity | undefined> {
		const notificationService = accessor.get(INotificationService);
		try {
			const capacity = await measureAndSave(accessor.get(INativeHostService), accessor.get(IConfigurationService));
			if (!options?.quiet) {
				notificationService.info(localize('voltOrchestra.measured', "This machine ({0}) runs {1} agents at once comfortably and {2} at most.", describeMachine(capacity), capacity.recommended, capacity.max));
			}
			return capacity;
		} catch (err) {
			notificationService.error(localize('voltOrchestra.measureFailed', "Could not measure this machine: {0}", err instanceof Error ? err.message : String(err)));
			return undefined;
		}
	}
});
