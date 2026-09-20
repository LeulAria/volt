/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helpers that turn what a run did into the short labels the UI shows. Shared between the
 * runtime (result synthesis) and the agent editor so both name the same work the same way.
 */
export interface IWorkCounts {
	readonly filesChanged: number;
	readonly commands: number;
	readonly reads: number;
	readonly searches: number;
	readonly browser: number;
	readonly webFetches: number;
	readonly subagents: number;
}

export const EMPTY_WORK: IWorkCounts = { filesChanged: 0, commands: 0, reads: 0, searches: 0, browser: 0, webFetches: 0, subagents: 0 };

export type ToolKind = 'read' | 'search' | 'edit' | 'execute' | 'fetch' | 'browser' | 'think' | 'delegate' | 'other';

/** ACP `ToolKind` → Volt semantic kind. Unknown or `other` stays undefined so the UI falls back. */
export function mapAcpToolKind(kind: string | undefined): ToolKind | undefined {
	switch (kind) {
		case 'read': return 'read';
		case 'search': return 'search';
		case 'edit':
		case 'delete':
		case 'move': return 'edit';
		case 'execute': return 'execute';
		case 'fetch': return 'fetch';
		case 'think': return 'think';
		default: return undefined;
	}
}

export function countWork(kinds: readonly ToolKind[], filesChanged = 0): IWorkCounts {
	let commands = 0, reads = 0, searches = 0, browser = 0, webFetches = 0, subagents = 0, edits = 0;
	for (const kind of kinds) {
		switch (kind) {
			case 'execute': commands++; break;
			case 'read': reads++; break;
			case 'search': searches++; break;
			case 'browser': browser++; break;
			case 'fetch': webFetches++; break;
			case 'delegate': subagents++; break;
			case 'edit': edits++; break;
		}
	}
	return { filesChanged: Math.max(filesChanged, edits), commands, reads, searches, browser, webFetches, subagents };
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) {
		return '<1s';
	}
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) {
		return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

/**
 * "Edited 3 files · ran 2 commands" / "Explored 4 files · 1 search" / "Answered". The most
 * consequential work comes first; exploration is only mentioned when nothing was changed.
 */
export function summarizeWork(counts: IWorkCounts): string {
	const parts: string[] = [];
	if (counts.filesChanged) {
		parts.push(`Edited ${plural(counts.filesChanged, 'file')}`);
	}
	if (counts.commands) {
		parts.push(`${parts.length ? 'ran' : 'Ran'} ${plural(counts.commands, 'command')}`);
	}
	if (counts.subagents) {
		parts.push(`${parts.length ? 'delegated' : 'Delegated'} ${plural(counts.subagents, 'task')}`);
	}
	if (!parts.length) {
		const explored: string[] = [];
		if (counts.reads) {
			explored.push(`Explored ${plural(counts.reads, 'file')}`);
		}
		if (counts.searches) {
			explored.push(`${explored.length ? '' : 'Ran '}${plural(counts.searches, 'search', 'searches')}`.trim());
		}
		if (counts.webFetches) {
			explored.push(`${explored.length ? '' : 'Fetched '}${plural(counts.webFetches, 'page')}`.trim());
		}
		if (counts.browser) {
			explored.push(`${explored.length ? '' : 'Took '}${plural(counts.browser, 'snapshot')}`.trim());
		}
		if (explored.length) {
			return explored.join(' · ');
		}
		return 'Answered';
	}
	if (counts.browser) {
		parts.push(`checked the browser`);
	}
	return parts.join(' · ');
}

/** Status line for a finished run: "Worked for 27s · Edited 3 files · ran 2 commands". */
export function runStatusLine(counts: IWorkCounts, durationMs: number, cancelled = false): string {
	if (cancelled) {
		return 'Cancelled';
	}
	const work = summarizeWork(counts);
	if (work === 'Answered' && durationMs < 8000) {
		return work;
	}
	return `Worked for ${formatDuration(durationMs)} · ${work}`;
}
