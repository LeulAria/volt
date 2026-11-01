/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProjectsList } from '../../src/home/Projects';
import { useOptionalClient } from '../../src/state/client';

/** Home's Projects row: the project list as its own screen, with a back button to Home. */
export default function ProjectsScreen() {
	return useOptionalClient() ? <ProjectsList pushed /> : null;
}
