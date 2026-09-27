/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentTooltipRow } from '../chrome/agentTooltip.js';
import { createSessionHoverFolderIcon } from './agentHomeIcons.js';
import { IAgentRepoInfo, repoSlug } from './agentRepoInfo.js';

/** Folder facts the chat-row hover card can show. */
export interface IAgentSessionHoverFolder {
	readonly pathLabel: string;
	readonly repo?: Pick<IAgentRepoInfo, 'name' | 'owner' | 'branch'>;
}

/** Why a tab is in Needs Attention or what the last run did, for the hover card. */
export function agentSessionStatusNote(session: Pick<IAgentSessionMeta, 'attention' | 'status'>): string | undefined {
	switch (session.attention) {
		case 'approval': return localize('voltAgent.home.waitingApproval', "Waiting for your approval");
		case 'question': return localize('voltAgent.home.askedQuestion', "Asked you a question");
		case undefined: break;
		default: {
			const unexpected: never = session.attention;
			return unexpected;
		}
	}
	switch (session.status) {
		case 'error': return localize('voltAgent.home.runFailed', "The last run failed");
		case 'interrupted': return localize('voltAgent.home.runInterrupted', "The last run was interrupted");
		case 'idle':
		case 'running':
		case 'done':
		case 'cancelled':
			return undefined;
		default: {
			const unexpected: never = session.status;
			return unexpected;
		}
	}
}

/**
 * Rows for the details card beside a chat tab: title, last-run/attention note
 * (clock), git branch when the folder has one, then the folder path.
 */
export function agentSessionHoverRows(
	title: string,
	statusNote: string | undefined,
	folders: readonly IAgentSessionHoverFolder[],
	workspaceLabelFallback?: string,
): IAgentTooltipRow[] {
	const rows: IAgentTooltipRow[] = [{ label: title }];
	if (statusNote) {
		rows.push({ label: statusNote, icon: Codicon.clock });
	}
	for (const folder of folders) {
		const branch = folder.repo?.branch?.trim();
		if (folder.repo && branch) {
			rows.push({ label: repoSlug(folder.repo), detail: branch, icon: Codicon.gitBranch });
		}
		rows.push({ label: folder.pathLabel, icon: createSessionHoverFolderIcon, muted: true });
	}
	if (!folders.length && workspaceLabelFallback) {
		rows.push({ label: workspaceLabelFallback, icon: createSessionHoverFolderIcon, muted: true });
	}
	return rows;
}
