/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';

export type AgentSuggestChipId = 'plan' | 'multitask';

export interface IAgentSuggestChip {
	readonly id: AgentSuggestChipId;
	readonly label: string;
	readonly kb?: string;
}

/** Empty-composer suggest chips; the project is picked from the picker above the composer. */
export function agentEmptyComposerChips(options: {
	readonly mode: string;
}): IAgentSuggestChip[] {
	const chips: IAgentSuggestChip[] = [];
	if (options.mode !== 'Plan') {
		chips.push({
			id: 'plan',
			label: localize('voltAgent.planNewIdea', "Plan New Idea"),
			kb: localize('voltAgent.planKb', "⇧Tab"),
		});
	}
	if (options.mode !== 'Multitask') {
		chips.push({
			id: 'multitask',
			label: localize('voltAgent.multitaskChip', "Multitask"),
		});
	}
	return chips;
}
