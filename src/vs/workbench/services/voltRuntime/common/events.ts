/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IAccessRequest } from './access/accessTypes.js';
import { VoltMode } from './modes.js';

export type IVoltEvent =
	| { type: 'run.start'; runId: string; mode: VoltMode }
	| { type: 'text.start' | 'text.delta' | 'text.end'; id: string; delta?: string }
	| { type: 'reasoning.start' | 'reasoning.delta' | 'reasoning.end'; id: string; delta?: string }
	| { type: 'tool.start'; callId: string; name: string; title?: string; input?: string; cwd?: string }
	| { type: 'tool.input.delta'; callId: string; delta: string }
	| { type: 'tool.end'; callId: string; result?: unknown; error?: string }
	| { type: 'plan'; entries: { content: string; status: 'pending' | 'in_progress' | 'completed'; priority?: string }[] }
	| { type: 'file.change'; uri: URI; kind: 'edit' | 'create' | 'delete' }
	| { type: 'access.ask'; request: IAccessRequest }
	| { type: 'access.resolved'; requestId: string; effect: 'allow' | 'deny'; scope: 'once' | 'always' }
	| { type: 'access.blocked'; request: IAccessRequest; policySource: string }
	| { type: 'usage'; input: number; output: number; used?: number; cache?: number; size?: number }
	| { type: 'error'; message: string; retryable?: boolean }
	| { type: 'run.end'; runId: string; reason: 'done' | 'abort' | 'fail' };

export interface IVoltEventEnvelope {
	seq: number;
	runId: string;
	sessionId: string;
	timestamp: number;
	event: IVoltEvent;
	provider?: {
		rawType: string;
		raw?: unknown;
	};
}

export function isLiveOnlyEvent(event: IVoltEvent): boolean {
	return event.type === 'text.delta' || event.type === 'reasoning.delta' || event.type === 'tool.input.delta';
}
