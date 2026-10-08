/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clip } from './agentThreadTools.js';

/** How many turns a fork keeps when it is cut at `turnId`: that turn and every one before it. */
export function turnsThroughId(turnIds: readonly string[], turnId: string): number {
	const index = turnIds.indexOf(turnId);
	return index < 0 ? 0 : index + 1;
}

export type MergeBackOutcome =
	| { readonly kind: 'shared' }
	| { readonly kind: 'summary' }
	| { readonly kind: 'nothing' }
	| { readonly kind: 'merged'; readonly commit: string }
	| { readonly kind: 'conflict' }
	| { readonly kind: 'failed'; readonly reason: string };

export interface IMergeBackNotice {
	readonly forkId: string;
	readonly forkTitle: string;
	readonly forkedAtTurns: number;
	readonly diffStat: string;
	readonly reply: string | undefined;
	readonly outcome: MergeBackOutcome;
}

/** The message a parent chat receives when a fork is merged back into it. */
export function mergeBackNotice(notice: IMergeBackNotice): string {
	const lines = [`[Volt] Merged back from "${notice.forkTitle}" (thread ${notice.forkId}), which was forked from this chat at turn ${notice.forkedAtTurns}.`];
	const stat = notice.diffStat.trim();
	lines.push(stat ? `Changes since the fork:\n${stat}` : 'It made no file changes since the fork.');
	lines.push(outcomeLine(notice.outcome));
	if (notice.reply?.trim()) {
		lines.push(`Its last reply:\n${clip(notice.reply, 1500)}`);
	}
	return lines.join('\n\n');
}

function outcomeLine(outcome: MergeBackOutcome): string {
	switch (outcome.kind) {
		case 'shared': return 'It worked in this checkout, so its changes are already here.';
		case 'summary': return 'Its changes are not in this checkout. thread_merge_back with apply true merges them here.';
		case 'nothing': return 'It has no commits to merge beyond the fork point.';
		case 'merged': return `They are merged into this checkout as commit ${outcome.commit}.`;
		case 'conflict': return 'Merging them would conflict with this checkout, so nothing changed here. Resolve it by hand, or have the fork bring its branch up to date with this one.';
		case 'failed': return `Merging failed: ${outcome.reason}`;
	}
}
