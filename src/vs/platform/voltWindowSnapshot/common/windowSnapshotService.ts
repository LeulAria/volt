/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltWindowSnapshotService = createDecorator<IVoltWindowSnapshotService>('voltWindowSnapshotService');
export const VOLT_WINDOW_SNAPSHOT_CHANNEL_NAME = 'voltWindowSnapshot';

/** Keeps each window's last snapshot on disk, for its next start. */
export interface IVoltWindowSnapshotService {
	readonly _serviceBrand: undefined;
	/** Stores the window's snapshot (JSON of {@link IVoltWindowSnapshot}); undefined forgets it. */
	save(key: string, snapshot: string | undefined): Promise<void>;
}
