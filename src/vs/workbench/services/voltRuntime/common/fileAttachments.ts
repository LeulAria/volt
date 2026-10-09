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
	/** A folded paste's guessed language (`JSON`, `Log`); plain text has none. */
	readonly languageLabel?: string;
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

/** `PDF, 2.1 MB` or, for a folded paste, `pasted text, JSON, 41 KB, 1,203 lines`. */
export function fileAttachmentFacts(info: IFileAttachmentInfo): string {
	if (info.pasted) {
		const kind = info.languageLabel && info.languageLabel !== 'Text' ? info.languageLabel : undefined;
		return [`pasted text`, kind, formatAttachmentSize(info.size), info.lines !== undefined ? `${info.lines.toLocaleString('en-US')} ${info.lines === 1 ? 'line' : 'lines'}` : undefined].filter(Boolean).join(', ');
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

/**
 * A file the user attached, as the agent's prompt carries it next to the text: ACP `resource`
 * (the text itself, for agents with `promptCapabilities.embeddedContext`) or `resource_link`
 * (a reference every ACP agent must take). The prompt text names the saved path either way.
 */
export interface IVoltResourceAttachment {
	/** `file:///…` of the saved copy. */
	readonly uri: string;
	readonly name: string;
	readonly mimeType?: string;
	readonly size?: number;
	/** The file's text, when it should travel inside the prompt (a folded paste). */
	readonly text?: string;
}

/** Folded pastes up to this size travel inside the prompt; bigger ones only as a link. */
export const MAX_EMBEDDED_RESOURCE_CHARS = 512 * 1024;

export type AcpResourcePromptBlock =
	| { type: 'resource'; resource: { uri: string; mimeType?: string; text: string } }
	| { type: 'resource_link'; uri: string; name: string; mimeType?: string; size?: number };

/**
 * The ACP content block for an attachment. Claude and Codex wrap an embedded resource in
 * `<context ref="…">`, so the model reads the whole paste in this turn without a tool call;
 * agents without embeddedContext (Cursor) get the link and read the file with their tools.
 */
export function acpResourceBlock(resource: IVoltResourceAttachment, embeddedContext: boolean): AcpResourcePromptBlock {
	if (embeddedContext && resource.text !== undefined && resource.text.length <= MAX_EMBEDDED_RESOURCE_CHARS) {
		return { type: 'resource', resource: { uri: resource.uri, ...(resource.mimeType ? { mimeType: resource.mimeType } : {}), text: resource.text } };
	}
	return { type: 'resource_link', uri: resource.uri, name: resource.name, ...(resource.mimeType ? { mimeType: resource.mimeType } : {}), ...(resource.size !== undefined ? { size: resource.size } : {}) };
}

/**
 * For a model Volt runs itself (no ACP): a folded paste's text goes after the prompt the way
 * Claude's adapter frames embedded resources. Others stay as the saved-path line.
 */
export function inlineResourceContext(resources: readonly IVoltResourceAttachment[] | undefined): string {
	return (resources ?? [])
		.filter(resource => resource.text !== undefined && resource.text.length <= MAX_EMBEDDED_RESOURCE_CHARS)
		.map(resource => `<context ref="${resource.uri}">\n${resource.text}\n</context>`)
		.join('\n');
}
