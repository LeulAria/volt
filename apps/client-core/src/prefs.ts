/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IStorage } from './client';

/**
 * How much of the agent's tool work a transcript shows, as on the desktop (Settings > Appearance >
 * Agent Conversations): compact folds it into one summary line, standard lists a line per call,
 * detailed draws each edit and command as a card with its diff or output.
 */
export type ToolDensity = 'compact' | 'standard' | 'detailed';

export const TOOL_DENSITIES: readonly ToolDensity[] = ['compact', 'standard', 'detailed'];

/** The conversation choices this device keeps (per install, not synced with the computer). */
export interface IConversationPrefs {
	readonly toolDensity: ToolDensity;
	/** Wrap long lines in code blocks instead of scrolling them sideways. */
	readonly codeWrap: boolean;
	/** Tint added and removed lines in diffs; off leaves only the +/- markers coloured. */
	readonly themedDiffs: boolean;
}

export const DEFAULT_CONVERSATION_PREFS: IConversationPrefs = { toolDensity: 'compact', codeWrap: false, themedDiffs: true };

export const CONVERSATION_PREFS_KEY = 'volt.conversation';

export function parseConversationPrefs(raw: string | null | undefined): IConversationPrefs {
	if (!raw) {
		return DEFAULT_CONVERSATION_PREFS;
	}
	try {
		const value = JSON.parse(raw) as Partial<Record<keyof IConversationPrefs, unknown>>;
		return {
			toolDensity: TOOL_DENSITIES.includes(value.toolDensity as ToolDensity) ? value.toolDensity as ToolDensity : DEFAULT_CONVERSATION_PREFS.toolDensity,
			codeWrap: typeof value.codeWrap === 'boolean' ? value.codeWrap : DEFAULT_CONVERSATION_PREFS.codeWrap,
			themedDiffs: typeof value.themedDiffs === 'boolean' ? value.themedDiffs : DEFAULT_CONVERSATION_PREFS.themedDiffs,
		};
	} catch {
		return DEFAULT_CONVERSATION_PREFS;
	}
}

/** A tiny store for {@link IConversationPrefs}: React apps read it with `useSyncExternalStore`. */
export interface IConversationPrefsStore {
	get(): IConversationPrefs;
	set(patch: Partial<IConversationPrefs>): void;
	subscribe(listener: () => void): () => void;
}

/** Starts on the defaults and loads what `storage` holds; each change is written back. */
export function createConversationPrefsStore(storage: IStorage): IConversationPrefsStore {
	let current = DEFAULT_CONVERSATION_PREFS;
	let touched = false;
	const listeners = new Set<() => void>();
	const emit = () => listeners.forEach(listener => listener());
	void storage.getItem(CONVERSATION_PREFS_KEY).then(raw => {
		// A change made before the load finished wins over what was stored.
		if (!touched && raw) {
			current = parseConversationPrefs(raw);
			emit();
		}
	}, () => undefined);
	return {
		get: () => current,
		set: patch => {
			touched = true;
			current = { ...current, ...patch };
			void storage.setItem(CONVERSATION_PREFS_KEY, JSON.stringify(current)).catch(() => undefined);
			emit();
		},
		subscribe: listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** A made-up stretch of tool work the density setting previews: two edits, two commands. */
export interface IDensityPreviewStep {
	readonly kind: 'edit' | 'run';
	readonly verb: string;
	readonly name: string;
	/** The command, after a run's title. */
	readonly command?: string;
	readonly additions?: number;
	readonly deletions?: number;
}

export const DENSITY_PREVIEW_STEPS: readonly IDensityPreviewStep[] = [
	{ kind: 'edit', verb: 'Edited', name: 'math.ts', additions: 4, deletions: 1 },
	{ kind: 'edit', verb: 'Edited', name: 'README.md', additions: 5, deletions: 1 },
	{ kind: 'run', verb: 'Ran', name: 'focused tests', command: 'npm test' },
	{ kind: 'run', verb: 'Ran', name: 'type-check', command: 'npm run' },
];

export const DENSITY_PREVIEW_SUMMARY = { verb: 'Edited', detail: '2 files, ran 2 commands' } as const;

export const TOOL_DENSITY_LABELS: Record<ToolDensity, string> = { compact: 'Compact', standard: 'Standard', detailed: 'Detailed' };
