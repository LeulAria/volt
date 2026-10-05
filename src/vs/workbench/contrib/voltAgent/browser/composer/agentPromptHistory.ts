/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import type { IAgentDisplayMention } from './agentMentions.js';

export interface IAgentPromptHistoryEntry {
	readonly text: string;
	readonly mentions?: readonly IAgentDisplayMention[];
}

const STORAGE_KEY = 'volt.agent.promptHistory';
/** Prompts kept across chats; the chat's own prompts are always all there. */
const MAX_STORED = 100;
/** A pasted log does not belong in the shared list; it is still recalled in its own chat. */
const MAX_STORED_LENGTH = 20_000;

/**
 * Arrow Up/Down in the composer walks earlier prompts, like a shell. Browsing starts from what is in
 * the composer (kept aside and given back after the newest prompt) and stops as soon as the recalled
 * text is edited, so the edit becomes a normal draft.
 */
export class AgentPromptHistoryNavigator {

	private entries: readonly IAgentPromptHistoryEntry[] = [];
	/** Position in {@link entries}; -1 while not browsing. */
	private index = -1;
	private stash: IAgentPromptHistoryEntry | undefined;
	/** The text put in the composer, to tell an untouched recall from an edit. */
	private shown: string | undefined;

	/** True while the composer shows a recalled prompt the user has not changed. */
	isBrowsing(current: string): boolean {
		return this.index >= 0 && current === this.shown;
	}

	/** The next older prompt, or undefined at the oldest one. `load` runs once per browse, newest first. */
	older(current: IAgentPromptHistoryEntry, load: () => readonly IAgentPromptHistoryEntry[]): IAgentPromptHistoryEntry | undefined {
		if (!this.isBrowsing(current.text)) {
			this.reset();
			this.entries = uniqueEntries(load(), current.text);
			this.stash = current;
		}
		if (this.index + 1 >= this.entries.length) {
			return undefined;
		}
		this.index++;
		return this.show(this.entries[this.index]);
	}

	/** The next newer prompt, then the text that was in the composer before browsing. */
	newer(current: string): IAgentPromptHistoryEntry | undefined {
		if (!this.isBrowsing(current)) {
			return undefined;
		}
		this.index--;
		if (this.index < 0) {
			const stash = this.stash ?? { text: '' };
			this.reset();
			return stash;
		}
		return this.show(this.entries[this.index]);
	}

	reset(): void {
		this.entries = [];
		this.index = -1;
		this.stash = undefined;
		this.shown = undefined;
	}

	private show(entry: IAgentPromptHistoryEntry): IAgentPromptHistoryEntry {
		this.shown = entry.text;
		return entry;
	}
}

/** Newest first, one entry per text, skipping blanks and the text already in the composer. */
function uniqueEntries(entries: readonly IAgentPromptHistoryEntry[], current: string): IAgentPromptHistoryEntry[] {
	const seen = new Set<string>([current]);
	const result: IAgentPromptHistoryEntry[] = [];
	for (const entry of entries) {
		if (!entry.text.trim() || seen.has(entry.text)) {
			continue;
		}
		seen.add(entry.text);
		result.push(entry);
	}
	return result;
}

/** Prompts sent from any chat, newest first, so a new chat can recall them too. */
export function readStoredPrompts(storage: IStorageService): IAgentPromptHistoryEntry[] {
	let raw: unknown;
	try {
		raw = JSON.parse(storage.get(STORAGE_KEY, StorageScope.PROFILE) ?? '[]');
	} catch {
		return [];
	}
	if (!Array.isArray(raw)) {
		return [];
	}
	const entries: IAgentPromptHistoryEntry[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object' || typeof (item as { text?: unknown }).text !== 'string') {
			continue;
		}
		const { text, mentions } = item as { text: string; mentions?: unknown };
		entries.push({ text, mentions: Array.isArray(mentions) ? mentions.flatMap(reviveMention) : undefined });
	}
	return entries;
}

export function rememberPrompt(storage: IStorageService, entry: IAgentPromptHistoryEntry): void {
	if (!entry.text.trim() || entry.text.length > MAX_STORED_LENGTH) {
		return;
	}
	const mentions = entry.mentions
		?.filter(mention => !mention.image && !mention.video)
		.map(mention => ({ label: mention.label, accent: mention.accent, kind: mention.kind, value: mention.value, resource: mention.resource, range: mention.range }));
	const next = [
		{ text: entry.text, ...(mentions?.length ? { mentions } : {}) },
		...readStoredPrompts(storage).filter(stored => stored.text !== entry.text),
	].slice(0, MAX_STORED);
	// Machine only: prompts can quote private code and should not ride along with Settings Sync.
	storage.store(STORAGE_KEY, JSON.stringify(next), StorageScope.PROFILE, StorageTarget.MACHINE);
}

function reviveMention(raw: unknown): IAgentDisplayMention[] {
	if (!raw || typeof raw !== 'object') {
		return [];
	}
	const mention = raw as Partial<IAgentDisplayMention> & { resource?: unknown };
	if (typeof mention.label !== 'string' || typeof mention.kind !== 'string') {
		return [];
	}
	return [{
		label: mention.label,
		accent: typeof mention.accent === 'number' ? mention.accent : undefined,
		kind: mention.kind,
		value: typeof mention.value === 'string' ? mention.value : undefined,
		resource: mention.resource && typeof mention.resource === 'object' ? URI.revive(mention.resource as URI) : undefined,
		range: mention.range,
	}];
}
