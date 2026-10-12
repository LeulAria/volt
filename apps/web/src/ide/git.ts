/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { GitChangeStatus, IGitStatus, VoltClient } from '@volt/client-core';
import { useEffect, useSyncExternalStore } from 'react';
import { useClient, useStatus } from '../app/client';
import { useWorkbench } from './workbench';

/**
 * Git status per root, shared by the explorer's decorations, source control and the status bar.
 * Fetched when a view asks and again whenever files may have changed (focus, an agent's edit).
 */

const cache = new Map<string, { readonly status?: IGitStatus; readonly at: number; readonly tick: number; loading?: Promise<void> }>();
const listeners = new Set<() => void>();

function notify(): void {
	listeners.forEach(listener => listener());
}

export function refreshGit(client: VoltClient, root: string, tick: number, force = false): Promise<void> {
	const hit = cache.get(root);
	if (hit?.loading) {
		return hit.loading;
	}
	if (!force && hit && hit.tick === tick && Date.now() - hit.at < 4_000) {
		return Promise.resolve();
	}
	const loading = client.gitStatus(root).then(status => {
		cache.set(root, { status, at: Date.now(), tick });
		notify();
	}, () => {
		cache.set(root, { ...(hit?.status ? { status: hit.status } : {}), at: Date.now(), tick });
		notify();
	});
	cache.set(root, { ...(hit ?? { at: 0, tick }), loading });
	return loading;
}

export function useGitStatus(root: string | undefined): IGitStatus | undefined {
	const client = useClient();
	const live = useStatus().live;
	const tick = useWorkbench(s => s.refresh);
	useEffect(() => {
		if (root && live) {
			void refreshGit(client, root, tick);
		}
	}, [client, root, tick, live]);
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => (root ? cache.get(root)?.status : undefined),
		() => undefined,
	);
}

export const GIT_LETTER: Record<GitChangeStatus, string> = { M: 'M', A: 'A', D: 'D', R: 'R', U: '!', '?': 'U' };
export const GIT_LABEL: Record<GitChangeStatus, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Conflict', '?': 'Untracked' };

/** Decorations by absolute path; folders take the strongest change under them. */
export function gitDecorations(status: IGitStatus | undefined): ReadonlyMap<string, GitChangeStatus> {
	const map = new Map<string, GitChangeStatus>();
	if (!status?.repoRoot) {
		return map;
	}
	for (const change of status.changes) {
		map.set(change.path, change.status);
		let dir = change.path.slice(0, change.path.lastIndexOf('/'));
		while (dir.length >= status.repoRoot.length) {
			const known = map.get(dir);
			if (known === 'U' || known === change.status) {
				break;
			}
			map.set(dir, known && known !== '?' && change.status === '?' ? known : change.status === 'D' ? (known ?? 'M') : change.status);
			const cut = dir.lastIndexOf('/');
			if (cut <= 0) {
				break;
			}
			dir = dir.slice(0, cut);
		}
	}
	return map;
}
