/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IVoltFeatureModule, IVoltFeatureModuleHost } from '../../voltCustomize/browser/voltFeatureModules.js';
import { IDevicesPage, IDevicesPageHost, IVoltRemoteDevicesModule } from '../common/voltRemoteDevices.js';
import { DevicesPage } from './devicesPage.js';

/**
 * Volt Settings > Devices, as a module of the `volt.remote-devices` built-in extension. It
 * registers nothing: Settings asks it for the page. Pairing, tokens and tunnels stay core (the
 * agent server), so unloading it only takes the page away.
 */
class VoltRemoteDevicesModule implements IVoltFeatureModule, IVoltRemoteDevicesModule {

	activate(_host: IVoltFeatureModuleHost): void { }

	createDevicesPage(instantiationService: IInstantiationService, host: IDevicesPageHost): IDevicesPage {
		return new DevicesPage(instantiationService, host);
	}
}

export const voltRemoteDevicesModule: IVoltFeatureModule & IVoltRemoteDevicesModule = new VoltRemoteDevicesModule();
