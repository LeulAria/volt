/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';

export type AgentSuggestChipId = 'plan' | 'selectProject' | 'multitask' | 'cloud';

export interface IAgentSuggestChip {
	readonly id: AgentSuggestChipId;
	readonly label: string;
	readonly kb?: string;
}

/**
 * Empty-composer suggest chips. "Select project" is second when the agent
 * was opened without a repo/workspace; it is a placeholder (click is a no-op).
 */
export function agentEmptyComposerChips(options: {
	readonly mode: string;
	readonly needsProject: boolean;
}): IAgentSuggestChip[] {
	const chips: IAgentSuggestChip[] = [];
	if (options.mode !== 'Plan') {
		chips.push({
			id: 'plan',
			label: localize('voltAgent.planNewIdea', "Plan New Idea"),
			kb: localize('voltAgent.planKb', "⇧Tab"),
		});
	}
	if (options.needsProject) {
		chips.push({
			id: 'selectProject',
			label: localize('voltAgent.selectProject', "Select project"),
		});
	}
	if (options.mode !== 'Multitask') {
		chips.push({
			id: 'multitask',
			label: localize('voltAgent.multitaskChip', "Multitask"),
		});
	}
	chips.push({
		id: 'cloud',
		label: localize('voltAgent.runInCloud', "Run in Cloud"),
	});
	return chips;
}
