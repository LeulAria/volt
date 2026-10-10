/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltSkillsDirectoryService = createDecorator<IVoltSkillsDirectoryService>('voltSkillsDirectoryService');
export const VOLT_SKILLS_DIRECTORY_CHANNEL_NAME = 'voltSkillsDirectory';

/**
 * skills.sh sends no CORS headers, so the window cannot read its API with fetch. The main process
 * asks it instead. Only the search endpoint is reachable: this is not a general proxy.
 */
export interface IVoltSkillsDirectoryService {
	readonly _serviceBrand: undefined;

	/** The `skills` array of skills.sh's search for `query` (at least two characters), as the site returns it. */
	search(query: string, limit: number): Promise<readonly unknown[]>;
}
