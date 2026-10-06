/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { basename, dirname, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { getPathForFile } from '../../../../../platform/dnd/browser/dnd.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { formatAttachmentSize, MAX_FILE_ATTACHMENT_BYTES } from '../../../../services/voltRuntime/common/fileAttachments.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { attachmentRoute, heicJpegName, storageMime } from './agentFileAttachments.js';

/** A file attached to a question's answer, saved and ready to name in the reply. */
export interface IAgentPreparedAttachment {
	readonly id: string;
	readonly kind: 'image' | 'file';
	readonly name: string;
	readonly mime: string;
	readonly size: number;
	/** The saved copy the agent opens. */
	readonly path: string;
	/** An image's pixels, for when the answers go out as the next prompt with images. */
	readonly bytes?: Uint8Array;
}

const HEIC_TIMEOUT_MS = 30_000;

function shellQuote(arg: string): string {
	if (/^[\w@%+=:,./~^-]+$/.test(arg)) {
		return arg;
	}
	return isWindows ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Saves attachments into the agent history's attachment store (content-addressed, so the same
 * file twice is one copy), converts HEIC photos to JPEG and tells the user what could not be
 * attached. Shared by the composer and the question tray.
 */
export class AgentAttachmentStore {

	constructor(
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IFileService private readonly fileService: IFileService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
	) { }

	/** Saves `bytes`; resolves to the saved file's path, or undefined when the write failed. */
	async save(bytes: Uint8Array, mime: string): Promise<string | undefined> {
		try {
			const ref = await this.history.putAttachment(bytes, mime);
			return this.history.attachmentResource(ref)?.fsPath;
		} catch {
			return undefined;
		}
	}

	/**
	 * HEIC/HEIF → JPEG with macOS's `sips` (Chromium cannot decode HEIC). The original is saved
	 * first, which gives `sips` a file to read; undefined when conversion is not possible here.
	 */
	async heicToJpeg(bytes: Uint8Array): Promise<{ bytes: Uint8Array; path: string } | undefined> {
		if (!isMacintosh) {
			return undefined;
		}
		const source = await this.save(bytes, 'image/heic');
		if (!source) {
			return undefined;
		}
		const out = joinPath(dirname(URI.file(source)), `heic-${generateUuid()}.jpg`);
		try {
			const result = await this.stdio.exec({
				id: `heic-${generateUuid().slice(0, 8)}`,
				command: ['sips', '-s', 'format', 'jpeg', source, '--out', out.fsPath].map(shellQuote).join(' '),
				timeoutMs: HEIC_TIMEOUT_MS,
				inlineChars: 2_000,
			});
			if (result.exitCode !== 0) {
				return undefined;
			}
			const jpeg = (await this.fileService.readFile(out)).value.buffer;
			const path = await this.save(jpeg, 'image/jpeg');
			return path && jpeg.byteLength ? { bytes: jpeg, path } : undefined;
		} catch {
			return undefined;
		} finally {
			void this.fileService.del(out).catch(() => undefined);
		}
	}

	/** The OS file dialog for any file type. */
	async pickFiles(defaultUri?: URI): Promise<URI[] | undefined> {
		return this.fileDialogService.showOpenDialog({
			title: localize('voltAgent.pickFilesTitle', "Attach Files"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			defaultUri: defaultUri ?? await this.fileDialogService.defaultFilePath(),
		});
	}

	notifyTooLarge(name: string, size: number, referenced: boolean): void {
		this.notificationService.info(referenced
			? localize('voltAgent.fileTooLargeReferenced', "{0} is {1}. Files up to {2} can be attached, so it is referenced at its location instead.", name, formatAttachmentSize(size), formatAttachmentSize(MAX_FILE_ATTACHMENT_BYTES))
			: localize('voltAgent.fileTooLarge', "{0} is {1}. Files up to {2} can be attached.", name, formatAttachmentSize(size), formatAttachmentSize(MAX_FILE_ATTACHMENT_BYTES)));
	}

	notifyNotSentAsImage(name: string): void {
		this.notificationService.info(localize('voltAgent.imageSentAsFile', "{0} can't be sent to the model as an image (only PNG, JPEG, WebP and GIF can). It is attached as a file instead.", name));
	}

	notifyHeicFailed(name: string): void {
		this.notificationService.info(localize('voltAgent.heicFailed', "{0} could not be converted to JPEG. It is attached as a file instead.", name));
	}

	notifySaveFailed(name: string): void {
		this.notificationService.warn(localize('voltAgent.attachFailed', "{0} could not be attached.", name));
	}

	/**
	 * A dropped, pasted or picked file for a question's answer: PNG/JPEG/WebP/GIF stay images,
	 * HEIC becomes JPEG, everything else (videos included) is saved as a file up to
	 * {@link MAX_FILE_ATTACHMENT_BYTES}. Undefined, after telling the user, when it cannot be attached.
	 */
	async prepare(source: File | URI): Promise<IAgentPreparedAttachment | undefined> {
		const path = URI.isUri(source) ? undefined : getPathForFile(source);
		const resource = URI.isUri(source) ? source : path ? URI.file(path) : undefined;
		const name = resource ? basename(resource) : (source as File).name || 'file';
		const type = URI.isUri(source) ? undefined : (source as File).type;
		let size: number;
		try {
			size = resource ? (await this.fileService.stat(resource)).size ?? 0 : (source as File).size;
		} catch {
			this.notifySaveFailed(name);
			return undefined;
		}
		if (size > MAX_FILE_ATTACHMENT_BYTES) {
			this.notifyTooLarge(name, size, false);
			return undefined;
		}
		let bytes: Uint8Array;
		try {
			bytes = resource ? (await this.fileService.readFile(resource)).value.buffer : new Uint8Array(await (source as File).arrayBuffer());
		} catch {
			this.notifySaveFailed(name);
			return undefined;
		}
		const route = attachmentRoute(name, type);
		const id = `answer-${generateUuid()}`;
		if (route === 'heic') {
			const jpeg = await this.heicToJpeg(bytes);
			if (jpeg) {
				return { id, kind: 'image', name: heicJpegName(name), mime: 'image/jpeg', size: jpeg.bytes.byteLength, path: jpeg.path, bytes: jpeg.bytes };
			}
			this.notifyHeicFailed(name);
		} else if (route === 'otherImage') {
			this.notifyNotSentAsImage(name);
		}
		const mime = route === 'image' ? (type || storageMime(name, type)) : storageMime(name, type);
		const saved = await this.save(bytes, mime);
		if (!saved) {
			this.notifySaveFailed(name);
			return undefined;
		}
		return route === 'image'
			? { id, kind: 'image', name, mime, size, path: saved, bytes }
			: { id, kind: 'file', name, mime, size, path: saved };
	}
}
