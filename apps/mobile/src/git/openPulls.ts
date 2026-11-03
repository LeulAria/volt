/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IPullRequestSummary, selectProjects, type VoltClient } from '@volt/client-core';
import { useEffect, useSyncExternalStore } from 'react';
import { useCollections, useOptionalClient } from '../state/client';

/** One open pull request and the project it was found from (the first, when two share a repo). */
export interface IOpenPull {
	readonly pr: IPullRequestSummary;
	readonly root: string;
	readonly project: string;
}

interface IState {
	readonly pulls: readonly IOpenPull[];
	readonly loading: boolean;
	readonly loadedAt: number;
}

/** Open pull requests change slowly; past this a tab switch or a new project fetches them again. */
const FRESH_MS = 2 * 60_000;
/** gh runs per project on the computer: a few at a time keeps it from flooding. */
const PARALLEL = 3;

let state: IState = { pulls: [], loading: false, loadedAt: 0 };
let loadedFor = '';
const listeners = new Set<() => void>();

function set(next: IState): void {
	state = next;
	listeners.forEach(listener => listener());
}

/**
 * Every open pull request across the projects Volt knows, newest first, for the Pull requests tab
 * and its badge. Projects that aren't GitHub repositories are skipped quietly.
 */
export async function loadOpenPulls(client: VoltClient, projects: readonly { readonly path: string; readonly name: string }[], force = false): Promise<void> {
	const key = projects.map(project => project.path).sort().join('\n');
	if (state.loading || (!force && key === loadedFor && Date.now() - state.loadedAt < FRESH_MS)) {
		return;
	}
	loadedFor = key;
	set({ ...state, loading: true });
	const found = new Map<string, IOpenPull>();
	const queue = [...projects];
	await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
		for (let project = queue.shift(); project; project = queue.shift()) {
			try {
				for (const pr of await client.listPullRequests(project.path, { state: 'open', limit: 30 })) {
					if (!found.has(pr.key)) {
						found.set(pr.key, { pr, root: project.path, project: project.name });
					}
				}
			} catch {
				// Not a GitHub repository, or gh isn't signed in there.
			}
		}
	}));
	const pulls = [...found.values()].sort((a, b) => b.pr.updatedAt - a.pr.updatedAt);
	set({ pulls, loading: false, loadedAt: Date.now() });
}

/** The open pull requests, loaded on first use and again when stale. */
export function useOpenPulls(): IState & { readonly refresh: () => void } {
	const client = useOptionalClient();
	const projects = selectProjects(useCollections(['projects']));
	const snapshot = useSyncExternalStore(listener => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}, () => state);
	const key = projects.map(project => project.path).join('\n');
	useEffect(() => {
		if (client && projects.length) {
			void loadOpenPulls(client, projects);
		}
		// Keyed on the project paths, not the array identity.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client, key]);
	return { ...snapshot, refresh: () => client && void loadOpenPulls(client, projects, true) };
}
