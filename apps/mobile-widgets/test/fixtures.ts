/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IOrchThreadLike, ISessionMetaLike } from '../src/serverShapes.ts';

export const NOW = Date.UTC(2026, 9, 8, 14, 0, 0);

export function meta(id: string, overrides: Partial<ISessionMetaLike> = {}): ISessionMetaLike {
	return { id, title: `Chat ${id}`, updatedAt: NOW - 60_000, status: 'idle', workspaceFolder: '/Users/me/code/volt', ...overrides };
}

export function thread(id: string, overrides: Partial<IOrchThreadLike> = {}): IOrchThreadLike {
	return { id, queue: [], inputs: [], ...overrides };
}

export function running(id: string, startedAgoMs: number, overrides: Partial<IOrchThreadLike> = {}): IOrchThreadLike {
	return thread(id, { modelRef: 'agent:claude', modelLabel: 'Claude Opus 5.5', active: { id: `turn-${id}`, kind: 'prompt', at: NOW - startedAgoMs, phase: 'running' }, ...overrides });
}
