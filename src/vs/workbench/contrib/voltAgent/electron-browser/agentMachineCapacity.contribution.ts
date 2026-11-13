/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeHostService } from '../../../../platform/native/common/native.js';
import { registerMachineCapacity } from '../browser/orchestration/agentMachineCapacity.js';

// Memory and cores from the main process.
registerMachineCapacity(async accessor => {
	const nativeHostService = accessor.get(INativeHostService);
	const [stats, props] = await Promise.all([nativeHostService.getOSStatistics(), nativeHostService.getOSProperties()]);
	return {
		totalMemMb: stats.totalmem / (1024 * 1024),
		cpus: props.cpus.length || 1,
		cpuModel: props.cpus[0]?.model?.trim(),
		platform: props.platform,
		arch: props.arch,
	};
});
