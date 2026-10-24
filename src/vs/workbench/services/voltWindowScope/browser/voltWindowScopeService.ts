/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IVoltWindowScopeService } from '../common/voltWindowScope.js';
import { VoltWindowScopeService } from '../common/voltWindowScopeService.js';

/** Web and agent-server clients have no main process: every window lists everything. */
class UnscopedWindowScopeService extends VoltWindowScopeService {
	constructor() {
		super(undefined, undefined, undefined);
	}
}

registerSingleton(IVoltWindowScopeService, UnscopedWindowScopeService, InstantiationType.Delayed);
