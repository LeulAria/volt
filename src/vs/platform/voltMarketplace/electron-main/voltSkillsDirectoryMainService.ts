/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { net } from 'electron';
import { VoltSkillsDirectoryService } from '../node/voltSkillsDirectoryService.js';

/** The skills directory over Electron's network stack (the system proxy and certificates). */
export class VoltSkillsDirectoryMainService extends VoltSkillsDirectoryService {
	constructor() {
		super((url, init) => net.fetch(url, init));
	}
}
