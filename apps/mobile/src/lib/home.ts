import { useEffect, useMemo, useRef, useState } from 'react';
import {
	AgentClientServices, buildAgentHomeTree, defaultAgentHomeViewState, homeSessions, repoInitials, sessionFolders,
	type IAgentHomeNode, type IAgentRepoInfo, type IAgentSessionMeta,
} from '@/core/voltCore';

export interface IHomeSection {
	readonly key: string;
	readonly title: string;
	readonly data: readonly IAgentSessionMeta[];
	readonly collapsible: boolean;
}

function labelOf(node: IAgentHomeNode): string {
	const element = node.element;
	switch (element.type) {
		case 'bucket': return element.label;
		case 'group': return element.id === 'snooze' ? 'Snoozed' : 'Settled';
		default: return '';
	}
}

function sessionsUnder(node: IAgentHomeNode): IAgentSessionMeta[] {
	const out: IAgentSessionMeta[] = [];
	for (const child of node.children ?? []) {
		if (child.element.type === 'session') {
			out.push(child.element.session);
			out.push(...sessionsUnder(child));
		} else if (child.element.type !== 'more') {
			out.push(...sessionsUnder(child));
		}
	}
	return out;
}

/**
 * The home list, grouped by the agent window's own tree (Needs Attention, Working, Done, Pinned,
 * Settled…), flattened into sections for a native list.
 */
export function useHomeSections(services: AgentClientServices, version: number, now: number): { sections: IHomeSection[]; repos: ReadonlyMap<string, IAgentRepoInfo> } {
	const view = useMemo(() => defaultAgentHomeViewState(), []);
	const asked = useRef(new Set<string>());
	const [repos, setRepos] = useState<ReadonlyMap<string, IAgentRepoInfo>>(new Map());
	const sessions = useMemo(() => homeSessions(services), [services, version]);

	// Branch names and project initials, read on the server as the window reads them.
	useEffect(() => {
		for (const session of sessions) {
			for (const path of sessionFolders(session)) {
				if (asked.current.has(path)) {
					continue;
				}
				asked.current.add(path);
				services.client.call<IAgentRepoInfo | undefined>('repos.resolve', path).then(repo => {
					if (repo) {
						setRepos(previous => new Map(previous).set(path, repo));
					}
				}, () => undefined);
			}
		}
	}, [services, sessions]);

	const sections = useMemo(() => {
		const tree = buildAgentHomeTree([], sessions, view, { now, repos });
		return tree
			.filter(node => node.element.type === 'bucket' || node.element.type === 'group')
			.map(node => ({ key: node.element.type === 'bucket' ? node.element.id : `group:${labelOf(node)}`, title: labelOf(node), data: sessionsUnder(node), collapsible: node.element.type === 'group' }))
			.filter(section => section.data.length);
	}, [sessions, view, now, repos]);
	return { sections, repos };
}

/** What the second line of a row says: the branch (or folder) a chat works in, and its project's initials. */
export function sessionPlace(session: IAgentSessionMeta, repos: ReadonlyMap<string, IAgentRepoInfo>): { branch?: string; workspace?: string; initials: string } {
	const primary = sessionFolders(session)[0];
	const repo = primary ? repos.get(primary) : undefined;
	const folderName = primary ? primary.replace(/\/+$/, '').split('/').pop() : undefined;
	const name = repo?.name || folderName || session.workspaceLabel;
	return { branch: repo?.branch, workspace: name || undefined, initials: name ? repoInitials(name) : '' };
}
