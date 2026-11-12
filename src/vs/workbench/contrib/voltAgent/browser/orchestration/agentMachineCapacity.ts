/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { computeMachineCapacity, describeMachine, IMachineCapacity, IMachineProfile, ORCH_MACHINE_CAPACITY_SETTING, ORCH_MEASURE_CAPACITY_COMMAND_ID, parseMachineCapacity } from '../../../../services/voltRuntime/common/orchestration/machineCapacity.js';

/** Reads the machine's memory and cores: the desktop from its main process, the browser workbench from the agent server. */
export type MachineProfileReader = (accessor: ServicesAccessor) => Promise<IMachineProfile>;

/** Measures the machine and saves what it can run in the user's settings. */
async function measureAndSave(readMachine: MachineProfileReader, instantiationService: IInstantiationService, configurationService: IConfigurationService): Promise<IMachineCapacity> {
	const capacity = computeMachineCapacity(await instantiationService.invokeFunction(readMachine), Date.now());
	await configurationService.updateValue(ORCH_MACHINE_CAPACITY_SETTING, capacity, ConfigurationTarget.USER);
	return capacity;
}

/**
 * Measures the machine once, on the first launch that finds no capacity in the settings. After
 * that the saved numbers stand (the user edits them or measures again in Settings > Orchestration),
 * so a launch never rewrites what the user chose. Also registers the command that measures again.
 */
export function registerMachineCapacity(readMachine: MachineProfileReader): void {

	class AgentMachineCapacityContribution extends Disposable implements IWorkbenchContribution {

		static readonly ID = 'workbench.contrib.voltMachineCapacity';

		constructor(
			@IInstantiationService instantiationService: IInstantiationService,
			@IConfigurationService configurationService: IConfigurationService,
			@ILogService logService: ILogService,
		) {
			super();
			const saved = configurationService.inspect<unknown>(ORCH_MACHINE_CAPACITY_SETTING);
			if (parseMachineCapacity(saved.userValue ?? saved.applicationValue)) {
				return;
			}
			measureAndSave(readMachine, instantiationService, configurationService).then(
				capacity => logService.info(`[volt orchestra] this machine runs ${capacity.recommended} agents at once (max ${capacity.max}): ${describeMachine(capacity)}`),
				err => logService.warn('[volt orchestra] could not measure this machine', err),
			);
		}
	}

	registerWorkbenchContribution2(AgentMachineCapacityContribution.ID, AgentMachineCapacityContribution, WorkbenchPhase.Eventually);

	registerAction2(class MeasureMachineCapacityAction extends Action2 {
		constructor() {
			super({
				id: ORCH_MEASURE_CAPACITY_COMMAND_ID,
				title: localize2('voltOrchestra.measureCapacity', "Measure How Many Agents This Machine Can Run"),
				category: localize2('voltOrchestra.category', "Volt"),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor, options?: { readonly quiet?: boolean }): Promise<IMachineCapacity | undefined> {
			const notificationService = accessor.get(INotificationService);
			try {
				const capacity = await measureAndSave(readMachine, accessor.get(IInstantiationService), accessor.get(IConfigurationService));
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
}
