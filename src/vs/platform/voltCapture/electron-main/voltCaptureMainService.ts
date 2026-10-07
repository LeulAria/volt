/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { BrowserWindow, desktopCapturer, nativeImage, type DesktopCapturerSource, type NativeImage } from 'electron';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import { fitSize, IVoltCaptureImage, IVoltCaptureService, IVoltCaptureSource, platformCaptureCommand } from '../common/voltCapture.js';

const DEFAULT_MAX_SIDE = 1920;

export class VoltCaptureMainService implements IVoltCaptureService {

	declare readonly _serviceBrand: undefined;

	constructor(@ILogService private readonly logService: ILogService) { }

	private ownSourceIds(): Map<string, BrowserWindow> {
		const own = new Map<string, BrowserWindow>();
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed()) {
				try {
					own.set(window.getMediaSourceId(), window);
				} catch {
					// a window without a native handle yet
				}
			}
		}
		return own;
	}

	private toSource(source: DesktopCapturerSource, own: Map<string, BrowserWindow>): IVoltCaptureSource {
		return {
			id: source.id,
			name: source.name || (source.id.startsWith('screen:') ? 'Screen' : 'Window'),
			kind: source.id.startsWith('screen:') ? 'screen' : 'window',
			own: own.has(source.id),
		};
	}

	async listSources(kinds: readonly ('window' | 'screen')[] = ['window', 'screen']): Promise<IVoltCaptureSource[]> {
		const own = this.ownSourceIds();
		let sources: DesktopCapturerSource[] = [];
		try {
			sources = await desktopCapturer.getSources({ types: [...kinds], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
		} catch (err) {
			this.logService.warn('[volt-capture] desktopCapturer.getSources failed', err);
		}
		const listed = sources.map(source => this.toSource(source, own));
		// Without the screen recording permission the OS may hide even our own windows; they are always capturable.
		if (kinds.includes('window')) {
			for (const [id, window] of own) {
				if (!listed.some(source => source.id === id)) {
					listed.push({ id, name: window.getTitle() || 'Volt', kind: 'window', own: true });
				}
			}
		}
		return listed;
	}

	async sourceIdOfWindow(windowId: number): Promise<string | undefined> {
		const window = BrowserWindow.fromId(windowId);
		return window && !window.isDestroyed() ? window.getMediaSourceId() : undefined;
	}

	async capture(sourceId: string, maxSide = DEFAULT_MAX_SIDE): Promise<IVoltCaptureImage> {
		const side = Math.max(256, Math.min(4096, Math.round(maxSide)));
		const own = this.ownSourceIds();
		const window = own.get(sourceId);
		// Volt's own windows: their page, no OS permission needed.
		if (window) {
			const image = await window.webContents.capturePage();
			if (!image.isEmpty()) {
				return this.result(image, side, { id: sourceId, name: window.getTitle() || 'Volt', kind: 'window', own: true }, 'capturePage');
			}
		}
		let source: IVoltCaptureSource | undefined;
		try {
			const sources = await desktopCapturer.getSources({ types: [sourceId.startsWith('screen:') ? 'screen' : 'window'], thumbnailSize: { width: side, height: side }, fetchWindowIcons: false });
			const found = sources.find(candidate => candidate.id === sourceId);
			if (found) {
				source = this.toSource(found, own);
				if (!found.thumbnail.isEmpty()) {
					return this.result(found.thumbnail, side, source, 'desktopCapturer');
				}
			}
		} catch (err) {
			this.logService.warn('[volt-capture] desktopCapturer capture failed', err);
		}
		const fallback = await this.platformCapture(sourceId);
		if (fallback && !fallback.isEmpty()) {
			return this.result(fallback, side, source ?? { id: sourceId, name: 'Window', kind: sourceId.startsWith('screen:') ? 'screen' : 'window', own: false }, process.platform === 'darwin' ? 'screencapture' : 'import');
		}
		if (!source) {
			throw new Error(`No window or screen with id ${sourceId}. List them again with window_list.`);
		}
		throw new Error(process.platform === 'darwin'
			? 'The window could not be captured: allow Volt in System Settings > Privacy & Security > Screen & System Audio Recording, then restart Volt.'
			: 'The window could not be captured (it may be minimized or the system blocks screen capture).');
	}

	private result(image: NativeImage, side: number, source: IVoltCaptureSource, method: string): IVoltCaptureImage {
		const size = image.getSize();
		const fit = fitSize(size.width, size.height, side);
		const scaled = fit.width !== size.width || fit.height !== size.height ? image.resize({ width: fit.width, height: fit.height, quality: 'best' }) : image;
		const final = scaled.getSize();
		return { pngBase64: scaled.toPNG().toString('base64'), width: final.width, height: final.height, source, method };
	}

	private async platformCapture(sourceId: string): Promise<NativeImage | undefined> {
		const out = join(tmpdir(), `volt-capture-${generateUuid()}.png`);
		const command = platformCaptureCommand(process.platform, sourceId, out);
		if (!command) {
			return undefined;
		}
		try {
			await new Promise<void>((resolve, reject) => execFile(command.file, command.args, { timeout: 15_000 }, error => error ? reject(error) : resolve()));
			return nativeImage.createFromBuffer(await fs.readFile(out));
		} catch (err) {
			this.logService.trace('[volt-capture] platform capture failed', err);
			return undefined;
		} finally {
			await fs.rm(out, { force: true });
		}
	}
}
