/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Files the user attaches to a prompt or to an answer. The agent never gets their bytes inline:
 * each is saved in the agent history's attachment store and the prompt names the saved path,
 * which every agent's tools can open (like T3's attachments).
 */

/** Largest file copied into the attachment store (T3's limit for files other than images). */
export const MAX_FILE_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** What the prompt or the answer says about one attachment. */
export interface IFileAttachmentInfo {
	readonly kind: 'image' | 'file';
	/** The name the user knows it by (`report.pdf`, `Pasted text`). */
	readonly name: string;
	readonly size: number;
	readonly mime?: string;
	/** The saved copy. Without one there is nothing for the agent to open, so no line is written. */
	readonly path?: string;
	/** Pasted text folded into a file: its line count. */
	readonly lines?: number;
	readonly pasted?: boolean;
}

/** `812 B`, `41 KB`, `2.1 MB`. */
export function formatAttachmentSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `PDF`, `ZIP`, `MOV`, `Text`: the kind of file in a word, from its name and else its type. */
export function fileTypeLabel(name: string, mime?: string): string {
	const dot = name.lastIndexOf('.');
	const ext = dot > 0 ? name.slice(dot + 1) : '';
	if (/^[a-z0-9]{1,8}$/i.test(ext)) {
		return ext.toUpperCase();
	}
	const type = mime?.split(';')[0].trim().toLowerCase();
	if (type === 'text/plain') {
		return 'Text';
	}
	const subtype = type?.split('/')[1]?.replace(/^x-/, '');
	return subtype && /^[a-z0-9]{1,8}$/.test(subtype) ? subtype.toUpperCase() : 'File';
}

/** `PDF, 2.1 MB` or, for a folded paste, `pasted text, 41 KB, 812 lines`. */
export function fileAttachmentFacts(info: IFileAttachmentInfo): string {
	if (info.pasted) {
		return [`pasted text`, formatAttachmentSize(info.size), info.lines !== undefined ? `${info.lines} ${info.lines === 1 ? 'line' : 'lines'}` : undefined].filter(Boolean).join(', ');
	}
	return `${fileTypeLabel(info.name, info.mime)}, ${formatAttachmentSize(info.size)}`;
}

/**
 * `[File #1 "report.pdf" (PDF, 2.1 MB) is saved at: /path]`, matching the image lines
 * (`[Image #1 "x.png" is saved at: /path]`). `index` is left out for answers, where the
 * attachments sit under one question.
 */
export function attachmentSavedLine(info: IFileAttachmentInfo, index?: number): string | undefined {
	if (!info.path) {
		return undefined;
	}
	const number = index !== undefined ? ` #${index}` : '';
	if (info.kind === 'image') {
		return `[Image${number} "${info.name}" is saved at: ${info.path}]`;
	}
	return `[File${number} "${info.name}" (${fileAttachmentFacts(info)}) is saved at: ${info.path}]`;
}
