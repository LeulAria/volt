/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IFileRoot, projectOf, sessionsOf, uriPath } from '@volt/client-core';
import { useEffect, useMemo, useState } from 'react';
import { useClient, useCollections, useStatus } from '../app/client';
import { setResolvedRoot, useWorkbench } from './workbench';

/** The folders the IDE can browse: every project and chat worktree on the computer. */
export function useRoots(): readonly IFileRoot[] {
	const client = useClient();
	const status = useStatus();
	const cols = useCollections(['projects', 'sessions']);
	const [roots, setRoots] = useState<readonly IFileRoot[]>([]);
	const projects = cols['projects'];
	const sessions = cols['sessions'];
	useEffect(() => {
		if (!status.live) {
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			client.listRoots().then(next => !cancelled && setRoots(next.filter(root => !root.scratch)), () => undefined);
		}, 120);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [client, status.live, projects, sessions]);
	return roots;
}

/**
 * The root the explorer, search and source control use: the one picked, else the folder of the
 * chat in front (its worktree when it has one), else the first project.
 */
export function useActiveRoot(): { readonly root: IFileRoot | undefined; readonly roots: readonly IFileRoot[] } {
	const roots = useRoots();
	const picked = useWorkbench(s => s.root);
	const agentChatId = useWorkbench(s => s.agentChatId);
	const cols = useCollections(['projects', 'sessions']);
	const root = useMemo(() => {
		const byPath = picked ? roots.find(r => r.path === picked) : undefined;
		if (byPath) {
			return byPath;
		}
		if (agentChatId) {
			const session = sessionsOf(cols)[agentChatId];
			const folder = session?.worktreePath ?? uriPath(projectOf(cols, agentChatId)?.root);
			const hit = folder ? roots.find(r => r.path === folder) : undefined;
			if (hit) {
				return hit;
			}
		}
		return roots.find(r => r.kind === 'project') ?? roots[0];
	}, [roots, picked, agentChatId, cols]);
	useEffect(() => {
		setResolvedRoot(root?.path);
	}, [root]);
	return { root, roots };
}

/** `path` relative to `root` (with `/`), or the path itself outside it. */
export function relativeTo(root: string | undefined, path: string): string {
	if (root && (path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`))) {
		return path.slice(root.length).replace(/^[\\/]+/, '');
	}
	return path;
}

export function joinPath(dir: string, name: string): string {
	return `${dir.replace(/[\\/]+$/, '')}/${name}`;
}
