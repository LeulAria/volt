/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IProjectItem } from '@volt/client-core';

/** `~/code/app` with the home folder known projects live under (the server has no shell to expand it). */
export function expandHome(path: string, projects: readonly IProjectItem[]): string {
	const trimmed = path.trim();
	if (!trimmed.startsWith('~')) {
		return trimmed;
	}
	const home = projects.map(pr => /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(pr.path)?.[1]).find(Boolean);
	return home ? `${home}${trimmed.slice(1)}` : trimmed;
}
