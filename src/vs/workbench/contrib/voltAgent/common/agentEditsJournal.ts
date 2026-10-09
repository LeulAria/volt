/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { UriComponents } from '../../../../base/common/uri.js';

/** Where a binary file's pre-agent bytes live: a blob in a snapshot repo. */
export interface IAgentEditsJournalBinaryBaseline {
	readonly repoRoot: string;
	readonly blob: string;
	readonly path: string;
}

/**
 * What the Keep/Undo review in a Volt window must learn about the agent server's runs, in order.
 * `file`: an edit tool changed a file (`file.change`); `baseline`/`binary`: a checkpoint found a
 * change no tool reported; `finished`: the run ended. The server keeps them until a window
 * applies them, so edits made while no window was open are still reviewable.
 */
export type AgentEditsJournalEntry =
	| { readonly kind: 'file'; readonly sessionId: string; readonly uri: UriComponents; readonly before?: string }
	| { readonly kind: 'baseline'; readonly sessionId: string; readonly uri: UriComponents; readonly before?: string; readonly agentText?: string; readonly renamedFrom?: UriComponents }
	| { readonly kind: 'binary'; readonly sessionId: string; readonly uri: UriComponents; readonly baseline?: IAgentEditsJournalBinaryBaseline; readonly renamedFrom?: UriComponents }
	| { readonly kind: 'finished'; readonly sessionId: string };
