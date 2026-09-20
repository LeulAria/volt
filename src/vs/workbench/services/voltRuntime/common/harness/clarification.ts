/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAmbiguity, ITaskIntel, shouldClarify } from './taskIntel.js';

/**
 * Clarification diamond from the control graph:
 *
 *   Ambiguity → Resolvable without the user? → Yes: context engine
 *                                            → No:  ask one focused question
 *
 * A dangling "fix it" with no prior turn and no attachment cannot be resolved by
 * opening the workspace - the workspace does not name *it*. A vague quality ask
 * ("make it nicer") with a workspace *can*: the code is the spec. Contradictions
 * never are: no amount of reading the repo picks a side.
 */

export type ClarifyPath = 'none' | 'ask' | 'context';

export interface IClarificationContext {
	readonly hasWorkspace?: boolean;
	readonly hasPriorTurns?: boolean;
	readonly attachments?: readonly string[];
}

export interface IClarification {
	readonly path: ClarifyPath;
	readonly resolvable: boolean;
	readonly question?: string;
	readonly reason: string;
}

export function decideClarification(intel: ITaskIntel, context: IClarificationContext = {}): IClarification {
	return decideAmbiguity(intel.ambiguity, context);
}

export function decideAmbiguity(ambiguity: IAmbiguity, context: IClarificationContext = {}): IClarification {
	if (!shouldClarify(ambiguity) || !ambiguity.question) {
		return { path: 'none', resolvable: true, reason: 'The request is specified enough to start.' };
	}

	const contradiction = ambiguity.reasons.some(reason =>
		reason.includes('at once') || reason.includes('forbids') || reason.includes('conflict'));
	if (contradiction) {
		return {
			path: 'ask',
			resolvable: false,
			question: ambiguity.question,
			reason: 'Contradictory requirements cannot be resolved by reading the workspace.',
		};
	}

	const dangling = ambiguity.reasons.some(reason => reason.startsWith('refers to'));
	if (dangling && !context.hasPriorTurns && !(context.attachments?.length)) {
		return {
			path: 'ask',
			resolvable: false,
			question: ambiguity.question,
			reason: 'A dangling reference has no earlier turn or attachment to resolve against.',
		};
	}

	if (context.hasWorkspace || context.hasPriorTurns || (context.attachments?.length ?? 0) > 0) {
		return {
			path: 'context',
			resolvable: true,
			reason: 'The remaining ambiguity can be resolved from the workspace, history, or attachments.',
		};
	}

	return {
		path: 'ask',
		resolvable: false,
		question: ambiguity.question,
		reason: 'Nothing in the environment resolves the ambiguity.',
	};
}
