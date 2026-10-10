/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellation } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IVoltPageState, IVoltVisualPreviewService } from '../../../../../platform/voltVisualPreview/common/voltVisualPreview.js';
import type { IActDriver } from '../preview/browserAct.js';

/** `/settings` on the page's own origin, `localhost:3000` as http; anything with a scheme stays. */
export function absolutePageUrl(url: string, current: string): string {
	const raw = url.trim();
	if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^localhost:/i.test(raw)) {
		return raw;
	}
	if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(raw)) {
		return `http://${raw}`;
	}
	try {
		return new URL(raw, current).toString();
	} catch {
		return raw;
	}
}

/**
 * browser_act's steps against a headless page (see `IVoltVisualPreviewService.openPage`): the
 * same locators, waits and verification as in the in-app browser, without its tab. Input is sent
 * in order with the scripts that check it (the main process runs a page's calls one at a time),
 * so the fire-and-forget input methods of `IActDriver` stay ordered.
 */
export class HeadlessActDriver implements IActDriver {

	private loading = false;

	constructor(
		private readonly pages: IVoltVisualPreviewService,
		private readonly id: string,
		private url: string,
	) { }

	get currentUrl(): string {
		return this.url;
	}

	async run<T>(code: string, timeoutMs: number): Promise<T | undefined> {
		const result = await this.pages.evaluatePage<T>(this.id, code, timeoutMs).catch(() => undefined);
		if (!result) {
			return undefined;
		}
		this.loading = result.loading;
		return result.error ? undefined : result.value;
	}

	canSendInput(): boolean {
		return true;
	}

	click(x: number, y: number, button: 'left' | 'right' | 'middle', double: boolean): void {
		void this.pages.inputPage(this.id, [{ kind: 'click', x, y, button, clickCount: double ? 2 : 1 }]).catch(() => undefined);
	}

	move(x: number, y: number): void {
		void this.pages.inputPage(this.id, [{ kind: 'move', x, y }]).catch(() => undefined);
	}

	press(combo: string): void {
		void this.pages.inputPage(this.id, [{ kind: 'key', combo }]).catch(() => undefined);
	}

	insertText(text: string): Promise<boolean> {
		return this.pages.insertPageText(this.id, text).catch(() => false);
	}

	isLoading(): boolean {
		return this.loading;
	}

	async waitForLoad(timeoutMs: number, token: CancellationToken): Promise<boolean> {
		return this.settled(await raceCancellation(this.pages.waitForPage(this.id, timeoutMs).catch(() => undefined), token));
	}

	async navigate(url: string, token: CancellationToken): Promise<boolean> {
		this.loading = true;
		return this.settled(await raceCancellation(this.pages.navigatePage(this.id, absolutePageUrl(url, this.url), 20_000).catch(() => undefined), token));
	}

	async history(action: 'back' | 'reload', token: CancellationToken): Promise<void> {
		this.loading = true;
		this.settled(await raceCancellation(this.pages.navigatePage(this.id, action, 15_000).catch(() => undefined), token));
	}

	private settled(state: IVoltPageState | undefined): boolean {
		this.loading = !!state?.loading;
		if (state?.url) {
			this.url = state.url;
		}
		return !!state?.loaded;
	}
}
