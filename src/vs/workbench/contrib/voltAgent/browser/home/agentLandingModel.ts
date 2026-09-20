/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';

export interface ILandingProject {
	readonly uri: URI;
	readonly name: string;
	readonly current: boolean;
	readonly workspace: boolean;
}

export function landingWorkspaceName(options: {
	readonly folderName?: string;
	readonly workspaceLabel?: string;
	readonly multiRoot?: boolean;
}): string {
	if (options.multiRoot) {
		return options.workspaceLabel?.trim() || options.folderName?.trim() || '';
	}
	return options.folderName?.trim() || options.workspaceLabel?.trim() || '';
}

export function buildLandingProjectList(current: ILandingProject | undefined, recents: readonly ILandingProject[]): ILandingProject[] {
	const seen = new Set<string>();
	const out: ILandingProject[] = [];
	const push = (item: ILandingProject) => {
		const key = item.uri.toString();
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		out.push(item);
	};
	if (current) {
		push(current);
	}
	for (const recent of recents) {
		push(recent);
	}
	return out;
}
