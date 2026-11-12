/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WebContents, webContents, WebFrameMain } from 'electron';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { FindInFrameOptions, FoundInFrameResult, IWebviewManagerService, WebviewWebContentsId, WebviewWindowId } from '../common/webviewManagerService.js';
import { WebviewEgressRegistry } from '../common/voltWebviewEgress.js';
import { WebviewProtocolProvider } from './webviewProtocolProvider.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { ICodeWindow } from '../../window/electron-main/window.js';
import { IFileService } from '../../files/common/files.js';

export class WebviewMainService extends Disposable implements IWebviewManagerService {

	declare readonly _serviceBrand: undefined;

	private readonly _onFoundInFrame = this._register(new Emitter<FoundInFrameResult>());
	public readonly onFoundInFrame = this._onFoundInFrame.event;

	constructor(
		/** Shared with the session's request dispatcher (`app.ts`), which enforces it. */
		private readonly egress: WebviewEgressRegistry,
		@IFileService fileService: IFileService,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
	) {
		super();
		this._register(new WebviewProtocolProvider(fileService));
		// A window that closes or reloads takes its webviews along without unregistering them.
		const watch = (window: ICodeWindow) => this._register(window.onWillLoad(() => egress.deleteWindow(window.id)));
		windowsMainService.getWindows().forEach(watch);
		this._register(windowsMainService.onDidOpenWindow(watch));
		this._register(windowsMainService.onDidDestroyWindow(window => egress.deleteWindow(window.id)));
	}

	public async setWebviewEgress(windowId: WebviewWindowId, webviewId: string, encodedOrigin: string | undefined, hosts: readonly string[] | undefined): Promise<void> {
		if (typeof webviewId !== 'string' || !webviewId) {
			throw new Error('Invalid webview id');
		}
		if (hosts === undefined) {
			this.egress.delete(webviewId);
			return;
		}
		if (typeof windowId?.windowId !== 'number' || typeof encodedOrigin !== 'string' || !/^[a-z0-9]+$/i.test(encodedOrigin) || !Array.isArray(hosts) || hosts.some(host => typeof host !== 'string')) {
			throw new Error('Invalid webview egress rules');
		}
		this.egress.set(windowId.windowId, webviewId, encodedOrigin, hosts);
	}

	public async setIgnoreMenuShortcuts(id: WebviewWebContentsId | WebviewWindowId, enabled: boolean): Promise<void> {
		let contents: WebContents | undefined;

		if (typeof (id as WebviewWindowId).windowId === 'number') {
			const { windowId } = (id as WebviewWindowId);
			const window = this.windowsMainService.getWindowById(windowId);
			if (!window?.win) {
				throw new Error(`Invalid windowId: ${windowId}`);
			}
			contents = window.webContents;
		} else {
			const { webContentsId } = (id as WebviewWebContentsId);
			contents = webContents.fromId(webContentsId);
			if (!contents) {
				throw new Error(`Invalid webContentsId: ${webContentsId}`);
			}
		}

		if (!contents.isDestroyed()) {
			contents.setIgnoreMenuShortcuts(enabled);
		}
	}

	public async findInFrame(windowId: WebviewWindowId, frameName: string, text: string, options: { findNext?: boolean; forward?: boolean }): Promise<void> {
		const initialFrame = this.getFrameByName(windowId, frameName);

		type WebFrameMainWithFindSupport = WebFrameMain & {
			findInFrame?(text: string, findOptions: FindInFrameOptions): void;
			on(event: 'found-in-frame', listener: Function): WebFrameMain;
			removeListener(event: 'found-in-frame', listener: Function): WebFrameMain;
		};
		const frame = initialFrame as unknown as WebFrameMainWithFindSupport;
		if (typeof frame.findInFrame === 'function') {
			frame.findInFrame(text, {
				findNext: options.findNext,
				forward: options.forward,
			});
			const foundInFrameHandler = (_: unknown, result: FoundInFrameResult) => {
				if (result.finalUpdate) {
					this._onFoundInFrame.fire(result);
					frame.removeListener('found-in-frame', foundInFrameHandler);
				}
			};
			frame.on('found-in-frame', foundInFrameHandler);
		}
	}

	public async stopFindInFrame(windowId: WebviewWindowId, frameName: string, options: { keepSelection?: boolean }): Promise<void> {
		const initialFrame = this.getFrameByName(windowId, frameName);

		type WebFrameMainWithFindSupport = WebFrameMain & {
			stopFindInFrame?(stopOption: 'keepSelection' | 'clearSelection'): void;
		};

		const frame = initialFrame as unknown as WebFrameMainWithFindSupport;
		if (typeof frame.stopFindInFrame === 'function') {
			frame.stopFindInFrame(options.keepSelection ? 'keepSelection' : 'clearSelection');
		}
	}

	private getFrameByName(windowId: WebviewWindowId, frameName: string): WebFrameMain {
		const window = this.windowsMainService.getWindowById(windowId.windowId);
		if (!window?.win) {
			throw new Error(`Invalid windowId: ${windowId}`);
		}
		const frame = window.webContents.mainFrame.framesInSubtree.find(frame => {
			return frame.name === frameName;
		});
		if (!frame) {
			throw new Error(`Unknown frame: ${frameName}`);
		}
		return frame;
	}
}
