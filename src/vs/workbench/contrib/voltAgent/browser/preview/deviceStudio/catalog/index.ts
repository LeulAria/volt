/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDeviceCatalogEntry } from '../deviceModel.js';
import { DEV_DEVICES } from './dev.js';

/** Every device the browser's device menu offers, by group, newest first. */
export const DEVICE_CATALOG: readonly IDeviceCatalogEntry[] = [
	...DEV_DEVICES,
];
