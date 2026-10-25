/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IVoltWindowScopesService, VOLT_WINDOW_SCOPES_CHANNEL_NAME } from '../../../../platform/voltWindowScope/common/voltWindowScope.js';
import { INativeWorkbenchEnvironmentService } from '../../environment/electron-browser/environmentService.js';
import { IVoltWindowScopeService } from '../common/voltWindowScope.js';
import { VoltWindowScopeService } from '../common/voltWindowScopeService.js';

registerMainProcessRemoteService(IVoltWindowScopesService, VOLT_WINDOW_SCOPES_CHANNEL_NAME);

/** The scope comes with the window's configuration; the main process keeps every window's in step. */
class NativeVoltWindowScopeService extends VoltWindowScopeService {
	constructor(
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
		@IVoltWindowScopesService host: IVoltWindowScopesService,
	) {
		super(environmentService.window.voltScope, environmentService.window.voltScopes, host);
	}
}

// Imported after the browser registration, so this one wins on desktop.
registerSingleton(IVoltWindowScopeService, NativeVoltWindowScopeService, InstantiationType.Delayed);
