/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { extensionForMime, mimeForExtension } from '../../../../services/voltRuntime/common/history/agentHistoryLog.js';
import { formatAttachmentSize } from '../../../../services/voltRuntime/common/fileAttachments.js';
import { videoMimeForExtension, VIDEO_EXTENSIONS } from './agentVideoAttachments.js';

/**
 * What the composer does with a file the user drops, pastes or picks. The rule, in one place:
 *
 * - Every attachment reaches the agent as a file on disk; the prompt names the saved path.
 * - PNG, JPEG, WebP and GIF are also sent as images. HEIC/HEIF photos are converted to JPEG
 *   first (Chromium cannot decode them). Other image types (SVG, BMP, TIFF...) are attached as
 *   files, with a notice, since no model takes them as images.
 * - Videos Chromium can play (mp4, mov, webm...) up to `MAX_VIDEO_BYTES` get the video chip:
 *   preview, trim and stills sent as images. A clip whose stills cannot be extracted keeps its
 *   saved path, so it still reaches the agent as a file.
 * - Everything else (PDF, ZIP, other videos...) is copied into the attachment store up to
 *   `MAX_FILE_ATTACHMENT_BYTES`. A bigger file that has a path of its own is referenced in
 *   place (`@path`); one without (a pasted blob) is refused with a notice.
 * - Project files keep their `@path` mention: the agent reads them from the workspace.
 */
export type AttachmentRoute = 'image' | 'heic' | 'otherImage' | 'video' | 'file';

/** A file attached to the prompt, saved in the attachment store. */
export interface IAgentFilePayload {
	id: string;
	name: string;
	/** The type it is stored under; decides the saved file's extension. */
	mime: string;
	size: number;
	/** The saved copy; set once the save finished. */
	path?: string;
	/** Pasted text folded into a file. */
	pasted?: boolean;
	lines?: number;
}

/** A paste this large (UTF-8) becomes a text attachment instead of composer text (T3: 32 KiB). */
export const LARGE_PASTE_BYTES = 32 * 1024;

/** The longest prompt the composer holds; a paste that would push past it is folded too. */
export const MAX_COMPOSER_CHARS = 120_000;

/** The chip label of a folded paste. */
export const PASTED_TEXT_NAME = 'Pasted text';

/** Image types every vision provider takes. */
const SENDABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const SENDABLE_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const HEIC_EXTS = new Set(['heic', 'heif']);
/** Images Volt knows by extension that are not sent as images. */
const OTHER_IMAGE_EXTS = new Set(['svg', 'bmp', 'tif', 'tiff', 'ico', 'avif', 'jxl']);

/** Text that is opened in an editor when its chip is clicked; anything else opens in its own app. */
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'jsonc', 'csv', 'tsv', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'sql', 'diff', 'patch']);

export function fileExtension(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function normalizeMime(mime: string | undefined): string {
	const type = (mime ?? '').split(';')[0].trim().toLowerCase();
	return type === 'image/jpg' ? 'image/jpeg' : type;
}

/** True for the image types sent to the model as image blocks. */
export function isSendableImageMime(mime: string): boolean {
	return SENDABLE_IMAGE_TYPES.has(normalizeMime(mime));
}

export function attachmentRoute(name: string, mime: string | undefined): AttachmentRoute {
	const type = normalizeMime(mime);
	const ext = fileExtension(name);
	if (HEIC_TYPES.has(type) || HEIC_EXTS.has(ext)) {
		return 'heic';
	}
	if (SENDABLE_IMAGE_TYPES.has(type) || (!type.startsWith('image/') && SENDABLE_IMAGE_EXTS.has(ext))) {
		return 'image';
	}
	if (type.startsWith('image/') || OTHER_IMAGE_EXTS.has(ext)) {
		return 'otherImage';
	}
	// Only the containers the video viewer can play get the video chip.
	if (videoMimeForExtension(ext) || (type.startsWith('video/') && VIDEO_EXTENSIONS.some(known => videoMimeForExtension(known) === type))) {
		return 'video';
	}
	return 'file';
}

/**
 * The type a file is stored under. The attachment store names files by content hash and an
 * extension derived from the type, so keep the original extension (`report.pdf` → `….pdf`).
 */
export function storageMime(name: string, mime: string | undefined): string {
	const ext = fileExtension(name);
	if (/^[a-z0-9]{1,8}$/.test(ext)) {
		const byExt = mimeForExtension(ext);
		if (extensionForMime(byExt) === ext || (ext === 'jpeg' && byExt === 'image/jpeg')) {
			return byExt;
		}
	}
	const type = normalizeMime(mime);
	return type === 'text/plain' ? type : 'application/bin';
}

/** Whether a chip click opens the file in an editor (text) or in its own app (PDF, ZIP...). */
export function isTextAttachment(name: string, mime: string | undefined): boolean {
	const type = normalizeMime(mime);
	return type.startsWith('text/') || type === 'application/json' || TEXT_EXTS.has(fileExtension(name));
}

/** `IMG_0042.HEIC` → `IMG_0042.jpg`. */
export function heicJpegName(name: string): string {
	const stem = name.replace(/\.(heic|heif)$/i, '');
	return `${stem || 'image'}.jpg`;
}

function utf8Length(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			// A surrogate pair is one 4-byte code point.
			bytes += 4;
			i++;
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

/**
 * T3's rule: a paste of {@link LARGE_PASTE_BYTES} or more, or one that would push the composer
 * past {@link MAX_COMPOSER_CHARS}, becomes a text attachment the agent reads with its tools.
 * `replacedChars` is the selection the paste replaces.
 */
export function shouldFoldPaste(text: string, composerChars: number, replacedChars = 0): boolean {
	if (!text) {
		return false;
	}
	if (composerChars - replacedChars + text.length > MAX_COMPOSER_CHARS) {
		return true;
	}
	// A UTF-16 unit is 1 to 3 UTF-8 bytes: most pastes are decided without encoding.
	if (text.length >= LARGE_PASTE_BYTES) {
		return true;
	}
	if (text.length * 3 < LARGE_PASTE_BYTES) {
		return false;
	}
	return utf8Length(text) >= LARGE_PASTE_BYTES;
}

/** Lines of pasted text; a trailing newline does not start another. */
export function countLines(text: string): number {
	if (!text) {
		return 0;
	}
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10 && i < text.length - 1) {
			lines++;
		}
	}
	return lines;
}

/** `41 KB · 812 lines` after a folded paste's chip, `2.1 MB` after a file's. */
export function fileChipDetail(file: Pick<IAgentFilePayload, 'size' | 'lines' | 'pasted'>): string {
	const size = formatAttachmentSize(file.size);
	return file.pasted && file.lines !== undefined ? `${size} · ${file.lines} ${file.lines === 1 ? 'line' : 'lines'}` : size;
}
