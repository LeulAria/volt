/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

export interface IBrowserHistoryEntry {
	readonly url: string;
	readonly title: string;
	readonly favicon?: string;
	readonly visitedAt: number;
	readonly visits: number;
}

export interface IBrowserBookmark {
	readonly url: string;
	readonly title: string;
	readonly favicon?: string;
}

export type BrowserAppearance = 'system' | 'light' | 'dark';

export const IVoltBrowserHistory = createDecorator<IVoltBrowserHistory>('voltBrowserHistory');

/** What the in-app browser remembers across tabs and windows: visits, bookmarks and a few preferences. */
export interface IVoltBrowserHistory {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;

	/** Most recent first. */
	recents(limit: number): readonly IBrowserHistoryEntry[];
	/** Pages whose address or title contains every word of `query`, best match first. */
	search(query: string, limit: number): readonly IBrowserHistoryEntry[];
	find(url: string): IBrowserHistoryEntry | undefined;
	/** A page was opened: count the visit and move it to the top. */
	visit(url: string, title?: string): void;
	/** The page's title or icon arrived; the entry keeps its place. */
	describe(url: string, details: { title?: string; favicon?: string }): void;
	clear(): void;

	readonly bookmarks: readonly IBrowserBookmark[];
	isBookmarked(url: string): boolean;
	/** Adds or removes the page; returns whether it is bookmarked now. */
	toggleBookmark(url: string, title: string, favicon?: string): boolean;
	removeBookmark(url: string): void;

	showBookmarkBar: boolean;
	appearance: BrowserAppearance;
}

const HISTORY_KEY = 'volt.browser.history';
const BOOKMARKS_KEY = 'volt.browser.bookmarks';
const BOOKMARK_BAR_KEY = 'volt.browser.bookmarkBar';
const APPEARANCE_KEY = 'volt.browser.appearance';
const MAX_HISTORY = 300;

/** The address a page is remembered under: no trailing slash on a bare host, no fragment. */
export function browserHistoryKey(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = '';
		const text = parsed.toString();
		return parsed.pathname === '/' && !parsed.search && text.endsWith('/') ? text.slice(0, -1) : text;
	} catch {
		return url;
	}
}

/** Pages worth remembering: real web pages, not blank or error pages. */
export function isRememberedUrl(url: string | undefined): url is string {
	return !!url && /^(https?|file):/i.test(url);
}

/** The address without its scheme, as Cursor lists recents (`localhost:8765/hello-js.html`). */
export function shortBrowserUrl(url: string): string {
	return browserHistoryKey(url).replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}

export class VoltBrowserHistory extends Disposable implements IVoltBrowserHistory {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private entries: IBrowserHistoryEntry[];
	private _bookmarks: IBrowserBookmark[];
	private readonly saveHistory = this._register(new RunOnceScheduler(() => this.write(HISTORY_KEY, this.entries), 400));
	private writing = false;

	constructor(@IStorageService private readonly storageService: IStorageService) {
		super();
		this.entries = this.read<IBrowserHistoryEntry>(HISTORY_KEY);
		this._bookmarks = this.read<IBrowserBookmark>(BOOKMARKS_KEY);
		// Other windows browse too; pick up what they saved.
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, undefined, this._store)(e => {
			if (this.writing) {
				return;
			}
			if (e.key === HISTORY_KEY) {
				this.entries = this.read<IBrowserHistoryEntry>(HISTORY_KEY);
				this._onDidChange.fire();
			} else if (e.key === BOOKMARKS_KEY || e.key === BOOKMARK_BAR_KEY || e.key === APPEARANCE_KEY) {
				this._bookmarks = this.read<IBrowserBookmark>(BOOKMARKS_KEY);
				this._onDidChange.fire();
			}
		}));
		this._register({ dispose: () => this.saveHistory.isScheduled() && this.write(HISTORY_KEY, this.entries) });
	}

	recents(limit: number): readonly IBrowserHistoryEntry[] {
		return this.entries.slice(0, limit);
	}

	search(query: string, limit: number): readonly IBrowserHistoryEntry[] {
		const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
		if (!words.length) {
			return this.recents(limit);
		}
		const scored: { entry: IBrowserHistoryEntry; score: number }[] = [];
		for (const entry of this.entries) {
			const address = shortBrowserUrl(entry.url).toLowerCase();
			const title = entry.title.toLowerCase();
			if (!words.every(word => address.includes(word) || title.includes(word) || entry.url.toLowerCase().includes(word))) {
				continue;
			}
			// An address that starts with the query is what the user is typing toward.
			const first = words[0];
			const prefix = address.startsWith(first) || entry.url.toLowerCase().startsWith(first) ? 100 : 0;
			scored.push({ entry, score: prefix + Math.min(entry.visits, 50) });
		}
		return scored.sort((a, b) => b.score - a.score || b.entry.visitedAt - a.entry.visitedAt).slice(0, limit).map(item => item.entry);
	}

	find(url: string): IBrowserHistoryEntry | undefined {
		const key = browserHistoryKey(url);
		return this.entries.find(entry => entry.url === key);
	}

	visit(url: string, title?: string): void {
		if (!isRememberedUrl(url)) {
			return;
		}
		const key = browserHistoryKey(url);
		const index = this.entries.findIndex(entry => entry.url === key);
		const previous = index >= 0 ? this.entries.splice(index, 1)[0] : undefined;
		this.entries.unshift({
			url: key,
			title: title?.trim() || previous?.title || shortBrowserUrl(key),
			favicon: previous?.favicon,
			visitedAt: Date.now(),
			visits: (previous?.visits ?? 0) + 1,
		});
		if (this.entries.length > MAX_HISTORY) {
			this.entries.length = MAX_HISTORY;
		}
		this.saveHistory.schedule();
		this._onDidChange.fire();
	}

	describe(url: string, details: { title?: string; favicon?: string }): void {
		const key = browserHistoryKey(url);
		const index = this.entries.findIndex(entry => entry.url === key);
		if (index < 0) {
			return;
		}
		const previous = this.entries[index];
		const title = details.title?.trim() || previous.title;
		const favicon = details.favicon ?? previous.favicon;
		if (title === previous.title && favicon === previous.favicon) {
			return;
		}
		this.entries[index] = { ...previous, title, favicon };
		this.saveHistory.schedule();
		this._onDidChange.fire();
	}

	clear(): void {
		this.entries = [];
		this.saveHistory.cancel();
		this.write(HISTORY_KEY, this.entries);
		this._onDidChange.fire();
	}

	get bookmarks(): readonly IBrowserBookmark[] {
		return this._bookmarks;
	}

	isBookmarked(url: string): boolean {
		const key = browserHistoryKey(url);
		return this._bookmarks.some(bookmark => bookmark.url === key);
	}

	toggleBookmark(url: string, title: string, favicon?: string): boolean {
		const key = browserHistoryKey(url);
		if (this.isBookmarked(key)) {
			this.removeBookmark(key);
			return false;
		}
		this._bookmarks = [...this._bookmarks, { url: key, title: title.trim() || shortBrowserUrl(key), favicon }];
		this.write(BOOKMARKS_KEY, this._bookmarks);
		this._onDidChange.fire();
		return true;
	}

	removeBookmark(url: string): void {
		const key = browserHistoryKey(url);
		this._bookmarks = this._bookmarks.filter(bookmark => bookmark.url !== key);
		this.write(BOOKMARKS_KEY, this._bookmarks);
		this._onDidChange.fire();
	}

	get showBookmarkBar(): boolean {
		return this.storageService.getBoolean(BOOKMARK_BAR_KEY, StorageScope.APPLICATION, false);
	}

	set showBookmarkBar(show: boolean) {
		this.writing = true;
		try {
			this.storageService.store(BOOKMARK_BAR_KEY, show, StorageScope.APPLICATION, StorageTarget.USER);
		} finally {
			this.writing = false;
		}
		this._onDidChange.fire();
	}

	get appearance(): BrowserAppearance {
		const value = this.storageService.get(APPEARANCE_KEY, StorageScope.APPLICATION);
		return value === 'light' || value === 'dark' ? value : 'system';
	}

	set appearance(value: BrowserAppearance) {
		this.writing = true;
		try {
			this.storageService.store(APPEARANCE_KEY, value === 'system' ? undefined : value, StorageScope.APPLICATION, StorageTarget.USER);
		} finally {
			this.writing = false;
		}
		this._onDidChange.fire();
	}

	private read<T extends { readonly url: string }>(key: string): T[] {
		try {
			const raw: unknown = JSON.parse(this.storageService.get(key, StorageScope.APPLICATION, '[]'));
			return Array.isArray(raw) ? raw.filter((item: { url?: unknown } | null): item is T => !!item && typeof item.url === 'string') : [];
		} catch {
			return [];
		}
	}

	private write(key: string, value: unknown): void {
		this.writing = true;
		try {
			this.storageService.store(key, JSON.stringify(value), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} finally {
			this.writing = false;
		}
	}
}

registerSingleton(IVoltBrowserHistory, VoltBrowserHistory, InstantiationType.Delayed);
