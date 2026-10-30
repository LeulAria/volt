/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VoltClient } from './client';

/** Where a device keeps its own copy of drafts (localStorage on the web, AsyncStorage on phones). */
export interface IDraftStore {
	get(key: string): string | null | Promise<string | null>;
	set(key: string, value: string | null): void | Promise<void>;
}

/** A draft as a device caches it: when it was typed, and whether the computer has it. */
export interface ICachedDraft {
	readonly text: string;
	readonly at: number;
	readonly synced?: boolean;
}

/** Reads a cached draft; plain strings are drafts saved before drafts were shared. */
export function decodeCachedDraft(raw: string | null | undefined): ICachedDraft | undefined {
	if (!raw) {
		return undefined;
	}
	if (raw.startsWith('{"text":')) {
		try {
			const value = JSON.parse(raw) as { text?: unknown; at?: unknown; synced?: unknown };
			if (typeof value.text === 'string') {
				return { text: value.text, at: typeof value.at === 'number' ? value.at : 0, ...(value.synced ? { synced: true } : {}) };
			}
		} catch {
			// a plain draft that happens to look like JSON
		}
	}
	return { text: raw, at: 0 };
}

function encodeCachedDraft(draft: ICachedDraft): string {
	return JSON.stringify({ text: draft.text, at: draft.at, ...(draft.synced ? { synced: true } : {}) });
}

const SAVE_MS = 400;
const LIVE_WAIT_MS = 60_000;

/**
 * One composer's draft: the device's copy shows at once, the computer's copy (what the desktop
 * composer and every other device read) follows and wins when it is newer. Typing is saved to both,
 * debounced; sending clears both.
 *
 * Without a chat (the new chat page) the draft stays on the device.
 */
export class ComposerDraft {

	private text = '';
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private loaded = false;

	constructor(
		private readonly store: IDraftStore,
		private readonly storeKey: string,
		private readonly client: VoltClient | undefined,
		private readonly chatId: string | undefined,
		/** The computer had a newer draft: show it (only called while the text is the loaded one). */
		private readonly onRemote: (text: string) => void,
	) { }

	/** The draft kept on this device. */
	async load(): Promise<string> {
		const local = decodeCachedDraft(await this.store.get(this.storeKey));
		this.text = local?.text ?? '';
		this.loaded = true;
		if (this.client && this.chatId && !this.disposed) {
			void this.reconcile(this.client, this.chatId, local);
		}
		return this.text;
	}

	/** The composer's text changed (ignored until {@link load} has read the device's copy). */
	change(text: string): void {
		if (this.disposed || !this.loaded || text === this.text) {
			return;
		}
		this.text = text;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => this.save(), SAVE_MS);
	}

	/** Sent: the draft is gone everywhere. */
	clear(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.text = '';
		void this.store.set(this.storeKey, null);
		if (this.client && this.chatId) {
			void this.client.saveDraft(this.chatId, '');
		}
	}

	/** Writes what is pending at once and stops listening. */
	dispose(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.save();
		}
		this.disposed = true;
	}

	private save(): void {
		this.timer = undefined;
		const text = this.text;
		this.writeLocal(text, false);
		if (this.client && this.chatId) {
			void this.client.saveDraft(this.chatId, text).then(ok => {
				if (ok && this.text === text && this.timer === undefined) {
					this.writeLocal(text, true);
				}
			});
		}
	}

	private writeLocal(text: string, synced: boolean): void {
		void this.store.set(this.storeKey, text ? encodeCachedDraft({ text, at: Date.now(), synced }) : null);
	}

	/** Opening a chat right after launch: the computer answers once the connection is up. */
	private whenLive(client: VoltClient): Promise<boolean> {
		if (client.getStatus().live) {
			return Promise.resolve(true);
		}
		return new Promise(resolve => {
			const done = (live: boolean) => {
				clearTimeout(timer);
				unsubscribe();
				resolve(live);
			};
			const timer = setTimeout(() => done(false), LIVE_WAIT_MS);
			const unsubscribe = client.subscribe('status', () => {
				if (this.disposed) {
					done(false);
				} else if (client.getStatus().live) {
					done(true);
				}
			});
		});
	}

	private async reconcile(client: VoltClient, chatId: string, local: ICachedDraft | undefined): Promise<void> {
		let remote: Awaited<ReturnType<VoltClient['loadDraft']>>;
		try {
			if (!await this.whenLive(client)) {
				return;
			}
			remote = await client.loadDraft(chatId);
		} catch {
			return; // offline: the device's copy stands until the next open
		}
		const localText = local?.text ?? '';
		if (this.disposed || this.text !== localText) {
			return; // typed meanwhile: that is saved over it
		}
		const remoteText = remote?.text ?? '';
		if (remoteText === localText) {
			if (local && !local.synced) {
				this.writeLocal(localText, true);
			}
			return;
		}
		// Typed here and never stored there (offline, or from before drafts were shared): it goes up.
		if (local && localText && !local.synced && (!remote || local.at > remote.updatedAt)) {
			this.text = localText;
			this.save();
			return;
		}
		// Typed or sent elsewhere since.
		this.text = remoteText;
		this.writeLocal(remoteText, true);
		this.onRemote(remoteText);
	}
}
