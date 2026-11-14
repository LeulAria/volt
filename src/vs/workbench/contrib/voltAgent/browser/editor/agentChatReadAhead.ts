/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IChatReadAheadOptions {
	/** How long the pointer (or keyboard focus) rests on a chat before it is read: a pointer passing over rows reads none. */
	readonly dwellMs: number;
	/** How long a chat read ahead and not opened is kept before it is let go. */
	readonly keepMs: number;
	/** Chats kept read ahead at once; the oldest goes first. */
	readonly max: number;
}

/**
 * Read-ahead for the chat list: the chat a pointer rests on (or keyboard focus reaches) is loaded before it is
 * pressed, so the press finds it ready and draws it in the same frame. One read runs at a time and the latest chat
 * asked for goes next; a chat read and not opened is let go after {@link IChatReadAheadOptions.keepMs}.
 */
export class ChatReadAhead<T> {

	private readonly kept = new Map<string, { readonly value: T; timer: ReturnType<typeof setTimeout> }>();
	private resting: { readonly id: string; readonly timer: ReturnType<typeof setTimeout> } | undefined;
	private reading = false;
	private next: string | undefined;
	private disposed = false;

	constructor(
		/** Starts a chat's read-ahead value; undefined when there is nothing to read ahead (the chat is open already). */
		private readonly start: (id: string) => T | undefined,
		/** Settles once the value is loaded (or failed to). */
		private readonly loaded: (value: T) => Promise<unknown>,
		/** Lets a value go that nobody took. */
		private readonly drop: (value: T) => void,
		private readonly options: IChatReadAheadOptions,
	) { }

	/** The pointer rests on chat `id` (or keyboard focus reached it). Asking again for the same chat keeps its wait. */
	intend(id: string): void {
		if (this.disposed) {
			return;
		}
		const kept = this.kept.get(id);
		if (kept) {
			this.keep(id, kept);
			return;
		}
		if (this.resting?.id === id || this.next === id) {
			return;
		}
		this.cancel();
		this.resting = { id, timer: setTimeout(() => { this.resting = undefined; this.read(id); }, this.options.dwellMs) };
	}

	/** The pointer left the list: a chat still waiting out its dwell is not read. */
	cancel(): void {
		if (this.resting) {
			clearTimeout(this.resting.timer);
			this.resting = undefined;
		}
	}

	/** Chat `id`'s value, read or still reading; the caller owns it from now on. */
	take(id: string): T | undefined {
		const kept = this.kept.get(id);
		if (!kept) {
			return undefined;
		}
		clearTimeout(kept.timer);
		this.kept.delete(id);
		return kept.value;
	}

	has(id: string): boolean {
		return this.kept.has(id);
	}

	dispose(): void {
		this.disposed = true;
		this.cancel();
		this.next = undefined;
		for (const id of [...this.kept.keys()]) {
			const value = this.take(id);
			if (value !== undefined) {
				this.drop(value);
			}
		}
	}

	private read(id: string): void {
		if (this.disposed || this.kept.has(id)) {
			return;
		}
		if (this.reading) {
			this.next = id;
			return;
		}
		const value = this.start(id);
		if (value === undefined) {
			return;
		}
		const entry = { value, timer: undefined! as ReturnType<typeof setTimeout> };
		this.keep(id, entry);
		this.kept.set(id, entry);
		while (this.kept.size > this.options.max) {
			const oldest = this.kept.keys().next().value!;
			const dropped = this.take(oldest);
			if (dropped !== undefined) {
				this.drop(dropped);
			}
		}
		this.reading = true;
		void this.loaded(value).catch(() => undefined).finally(() => {
			this.reading = false;
			const next = this.next;
			this.next = undefined;
			if (next !== undefined) {
				this.read(next);
			}
		});
	}

	private keep(id: string, entry: { readonly value: T; timer: ReturnType<typeof setTimeout> }): void {
		if (entry.timer !== undefined) {
			clearTimeout(entry.timer);
		}
		entry.timer = setTimeout(() => {
			if (this.kept.get(id) === entry) {
				this.kept.delete(id);
				this.drop(entry.value);
			}
		}, this.options.keepMs);
	}
}
