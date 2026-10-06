/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow, nativeImage, type NativeImage } from 'electron';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isWindows } from '../../../base/common/platform.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltBadgeService, totalBadgeCount } from '../common/voltBadge.js';

/** Side of the Windows taskbar overlay, in pixels. */
const OVERLAY_SIZE = 16;

export class VoltBadgeMainService extends Disposable implements IVoltBadgeService {

	declare readonly _serviceBrand: undefined;

	private readonly counts = new Map<number, number>();
	private shown = 0;
	private overlay: NativeImage | undefined;

	constructor(@ILogService private readonly logService: ILogService) {
		super();
		const watch = (win: BrowserWindow) => {
			const id = win.id;
			win.once('closed', () => {
				if (this.counts.delete(id)) {
					this.apply();
				}
			});
		};
		for (const win of BrowserWindow.getAllWindows()) {
			watch(win);
		}
		const onCreated = (_event: unknown, win: BrowserWindow) => watch(win);
		app.on('browser-window-created', onCreated);
		this._register({ dispose: () => app.off('browser-window-created', onCreated) });
	}

	async setCount(windowId: number, count: number): Promise<void> {
		const next = totalBadgeCount([count]);
		if (next > 0) {
			this.counts.set(windowId, next);
		} else if (!this.counts.delete(windowId)) {
			return;
		}
		this.apply();
	}

	async getCount(): Promise<number> {
		return this.shown;
	}

	private apply(): void {
		const total = totalBadgeCount(this.counts.values());
		if (total === this.shown) {
			return;
		}
		this.shown = total;
		this.logService.info(`[volt] app badge: ${total}`);
		if (isWindows) {
			// Windows has no badge count; the taskbar button gets an overlay dot with the count as its label.
			const label = total > 0 ? `${total}` : '';
			for (const win of BrowserWindow.getAllWindows()) {
				win.setOverlayIcon(total > 0 ? this.overlayIcon() : null, label);
			}
			return;
		}
		// macOS draws the number on the dock icon; Linux shows it where the launcher supports counts (Unity).
		app.setBadgeCount(total);
	}

	/** A filled red circle, drawn once. */
	private overlayIcon(): NativeImage {
		if (!this.overlay) {
			const buffer = Buffer.alloc(OVERLAY_SIZE * OVERLAY_SIZE * 4);
			const center = (OVERLAY_SIZE - 1) / 2;
			const radius = OVERLAY_SIZE / 2;
			for (let y = 0; y < OVERLAY_SIZE; y++) {
				for (let x = 0; x < OVERLAY_SIZE; x++) {
					const distance = Math.hypot(x - center, y - center);
					// One pixel of antialiasing at the edge.
					const alpha = Math.max(0, Math.min(1, radius - distance));
					const offset = (y * OVERLAY_SIZE + x) * 4;
					// BGRA
					buffer[offset] = 0x3c;
					buffer[offset + 1] = 0x3c;
					buffer[offset + 2] = 0xe5;
					buffer[offset + 3] = Math.round(alpha * 255);
				}
			}
			this.overlay = nativeImage.createFromBitmap(buffer, { width: OVERLAY_SIZE, height: OVERLAY_SIZE });
		}
		return this.overlay;
	}
}
