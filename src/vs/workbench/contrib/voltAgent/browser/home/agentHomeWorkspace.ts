/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';

/** A local folder the Open Workspace menu offers. */
export interface IAgentHomeWorkspaceEntry {
	readonly uri: URI;
	/** Folder name, shown under Recents. */
	readonly name: string;
	/** Full path with the home folder written as ~, shown under On This Mac. */
	readonly path: string;
}

/** Folders listed under Recents before the rest move to On This Mac. */
export const AGENT_HOME_RECENT_LIMIT = 6;

/**
 * Local folders, most recent first: recently opened folders in their order,
 * then registered projects that are not in that list yet. One entry per folder.
 */
export function agentHomeWorkspaceEntries(
	recent: readonly { readonly uri: URI; readonly name: string }[],
	projects: readonly { readonly uri: URI; readonly name: string }[],
	pathLabel: (uri: URI) => string,
): IAgentHomeWorkspaceEntry[] {
	const entries = new Map<string, IAgentHomeWorkspaceEntry>();
	for (const folder of [...recent, ...projects]) {
		const key = folder.uri.toString();
		if (!entries.has(key)) {
			entries.set(key, { uri: folder.uri, name: folder.name, path: pathLabel(folder.uri) });
		}
	}
	return [...entries.values()];
}

/**
 * Folders whose path holds every word of the query, ignoring case. Folders
 * whose own name matches come first; the order inside each group is kept.
 */
export function filterAgentHomeWorkspaceEntries(entries: readonly IAgentHomeWorkspaceEntry[], query: string): IAgentHomeWorkspaceEntry[] {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) {
		return [...entries];
	}
	const byName: IAgentHomeWorkspaceEntry[] = [];
	const byPath: IAgentHomeWorkspaceEntry[] = [];
	for (const entry of entries) {
		const path = entry.path.toLowerCase();
		if (!words.every(word => path.includes(word))) {
			continue;
		}
		const name = entry.name.toLowerCase();
		(words.every(word => name.includes(word)) ? byName : byPath).push(entry);
	}
	return [...byName, ...byPath];
}

export type AgentCloneProvider = 'github' | 'gitlab' | 'bitbucket' | 'url';

export const AGENT_CLONE_PROVIDERS: readonly AgentCloneProvider[] = ['github', 'gitlab', 'bitbucket', 'url'];

const PROVIDER_HOSTS: Readonly<Record<Exclude<AgentCloneProvider, 'url'>, string>> = {
	github: 'github.com',
	gitlab: 'gitlab.com',
	bitbucket: 'bitbucket.org',
};

export function cloneProviderLabel(provider: AgentCloneProvider): string {
	switch (provider) {
		case 'github': return localize('voltAgent.clone.github', "GitHub");
		case 'gitlab': return localize('voltAgent.clone.gitlab', "GitLab");
		case 'bitbucket': return localize('voltAgent.clone.bitbucket', "Bitbucket");
		case 'url': return localize('voltAgent.clone.url', "Git URL");
		default: {
			const unexpected: never = provider;
			return unexpected;
		}
	}
}

export function cloneProviderPlaceholder(provider: AgentCloneProvider): string {
	switch (provider) {
		case 'github':
		case 'gitlab':
		case 'bitbucket':
			return localize('voltAgent.clone.hostPlaceholder', "owner/repo or https://{0}/owner/repo", PROVIDER_HOSTS[provider]);
		case 'url':
			return localize('voltAgent.clone.urlPlaceholder', "https://… or git@…");
		default: {
			const unexpected: never = provider;
			return unexpected;
		}
	}
}

/**
 * The URL `git clone` gets for what was pasted. Full URLs and `git@host:path`
 * pass through; `host.tld/owner/repo` gains https; on a hosted provider a bare
 * `owner/repo` (GitLab: `group/subgroup/repo`) points at that host.
 */
export function resolveCloneUrl(provider: AgentCloneProvider, input: string): string | undefined {
	const value = input.trim();
	if (!value || /\s/.test(value) || value.startsWith('-')) {
		return undefined;
	}
	if (/^(https?|ssh|git|file):\/\/\S+$/i.test(value) || /^[\w.-]+@[\w.-]+:\S+$/.test(value)) {
		return value;
	}
	if (/^[\w-]+(\.[\w-]+)+\/[\w.-]+\/\S+$/.test(value)) {
		return `https://${value}`;
	}
	if (provider !== 'url' && /^[\w.-]+(\/[\w.-]+)+$/.test(value)) {
		return `https://${PROVIDER_HOSTS[provider]}/${value}`;
	}
	return undefined;
}

/** Folder name a clone of this URL gets: the last path segment without `.git`. */
export function cloneFolderName(url: string): string | undefined {
	const trimmed = url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
	const last = trimmed.split(/[/:]/).pop() ?? '';
	const name = last.replace(/[^\w.-]/g, '-');
	return name && name !== '.' && name !== '..' ? name : undefined;
}

/** `name`, then `name-2`, `name-3`, …: the first one `taken` says is free. */
export async function freeFolderName(name: string, taken: (candidate: string) => Promise<boolean>): Promise<string> {
	for (let index = 1; ; index++) {
		const candidate = index === 1 ? name : `${name}-${index}`;
		if (!await taken(candidate)) {
			return candidate;
		}
	}
}

/** Why a new folder cannot have this name, or undefined when it can. */
export function newFolderNameProblem(name: string): string | undefined {
	const value = name.trim();
	if (!value) {
		return localize('voltAgent.newFolder.empty', "Enter a folder name.");
	}
	if (value === '.' || value === '..' || /[/\\:*?"<>|]/.test(value)) {
		return localize('voltAgent.newFolder.invalid', "A folder name cannot contain / \\ : * ? \" < > |.");
	}
	return undefined;
}

/** Last meaningful line of git's error output, for the inline message. */
export function gitErrorSummary(stderr: string): string | undefined {
	const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^Cloning into /.test(line));
	const fatal = lines.find(line => /^(fatal|error):/i.test(line));
	return (fatal ?? lines.at(-1))?.replace(/^(fatal|error):\s*/i, '');
}
