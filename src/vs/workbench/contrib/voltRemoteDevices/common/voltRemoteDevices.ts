/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * The Remote devices feature's contract: what the rest of Volt may use of it. Its page (Volt
 * Settings > Devices, with Add Device and its QR codes) is a module of the `volt.remote-devices`
 * built-in extension (`browser/voltRemoteDevices.module.ts`), loaded when Settings first shows the
 * page and unloaded when the extension is disabled. Pairing, device tokens and tunnels are core:
 * they live in the agent server (`IAgentServerClientService`), and Pair a Phone or Browser stays a
 * core command that opens the page.
 */

export const REMOTE_DEVICES_FEATURE_ID = 'remoteDevices';

/** How a device connects: on this network, over Tailscale, through a Cloudflare tunnel, or SSH. */
export type VoltConnectionKind = 'lan' | 'tailscale' | 'cloudflare' | 'ssh';

/** What Volt Settings lends the page to draw with (its rows, groups and labels). */
export interface IDevicesPageHost {
	readonly store: DisposableStore;
	target(): HTMLElement;
	sectionLabel(label: string): void;
	settingsGroup(): HTMLElement;
	settingRow(parent: HTMLElement, title: string, desc: string | undefined, renderControl?: (host: HTMLElement) => void): HTMLElement;
	empty(text: string): void;
	rerender(): void;
}

/** Volt Settings > Devices. */
export interface IDevicesPage {
	/** Opens Add Device once the page is on screen. */
	requestAddDevice(kind?: VoltConnectionKind): void;
	/** Draws into the host's target; `isCurrent` turns false when Settings moved on while it waited. */
	render(isCurrent: () => boolean): Promise<void>;
}

/** What the loaded module gives core (`IVoltFeatureModuleService.activate('remoteDevices')`). */
export interface IVoltRemoteDevicesModule {
	createDevicesPage(instantiationService: IInstantiationService, host: IDevicesPageHost): IDevicesPage;
}
