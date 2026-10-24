/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, fileUri, type IPromptFile, type IPromptMention, SENDABLE_IMAGE_MIMES, type VoltClient } from '@volt/client-core';
import * as DocumentPicker from 'expo-document-picker';

/** The server keeps files up to 50 MB; a phone sends them over the socket as base64, so less. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 8;

/** A file from the device in the composer: uploading, saved on the computer, or failed. */
export interface IComposerFile {
	readonly key: string;
	readonly name: string;
	readonly mime: string;
	readonly size: number;
	readonly state: 'uploading' | 'ready' | 'failed';
	readonly file?: IPromptFile;
	readonly error?: string;
}

/** A project file picked with `@`: `rel` is what the agent reads (from its folder), `path` the file. */
export interface IComposerMention {
	readonly rel: string;
	readonly path: string;
}

export interface IPickedFile {
	readonly name: string;
	readonly mime: string;
	readonly size: number;
	readonly base64: string;
}

const TEXT_EXTENSIONS = new Set(['txt', 'log', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'sh', 'sql', 'env', 'diff', 'patch']);
const MIME_BY_EXTENSION: Record<string, string> = { pdf: 'application/pdf', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', mov: 'video/quicktime', mp4: 'video/mp4', json: 'application/json' };

/** The picker's type, or one from the name when it gave none (a `.log` arrives as octet-stream). */
function mimeOf(name: string, picked: string | undefined): string {
	if (picked && picked !== 'application/octet-stream') {
		return picked;
	}
	const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
	return MIME_BY_EXTENSION[ext] ?? (TEXT_EXTENSIONS.has(ext) ? 'text/plain' : 'application/octet-stream');
}

let nextKey = 1;

export function fileKey(): string {
	return `file-${Date.now().toString(36)}-${nextKey++}`;
}

async function readBase64(asset: DocumentPicker.DocumentPickerAsset): Promise<string> {
	if (asset.base64) {
		return asset.base64.replace(/^data:[^,]*,/, '');
	}
	const blob = await (await fetch(asset.uri)).blob();
	return await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
		reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
		reader.readAsDataURL(blob);
	});
}

/** Lets the user pick files (any type); too-large ones are reported and left out. */
export async function pickFiles(limit: number, onTooLarge: (name: string) => void): Promise<IPickedFile[]> {
	const result = await DocumentPicker.getDocumentAsync({ multiple: limit > 1, copyToCacheDirectory: true, type: '*/*', base64: true });
	if (result.canceled || !result.assets?.length) {
		return [];
	}
	const out: IPickedFile[] = [];
	for (const asset of result.assets.slice(0, limit)) {
		if ((asset.size ?? 0) > MAX_FILE_BYTES) {
			onTooLarge(asset.name);
			continue;
		}
		try {
			const base64 = await readBase64(asset);
			out.push({ name: asset.name, mime: mimeOf(asset.name, asset.mimeType), size: asset.size ?? Math.floor(base64.length * 0.75), base64 });
		} catch {
			onTooLarge(asset.name);
		}
	}
	return out;
}

/** Images the model can see go with the images; everything else is a saved file the agent opens. */
export function isSendableImage(mime: string): boolean {
	return SENDABLE_IMAGE_MIMES.includes(mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mime.toLowerCase());
}

export async function uploadFile(client: VoltClient, picked: IPickedFile, key: string, update: (file: IComposerFile) => void): Promise<void> {
	const base = { key, name: picked.name, mime: picked.mime, size: picked.size };
	update({ ...base, state: 'uploading' });
	try {
		const file = await client.uploadFile({ base64: picked.base64, mime: picked.mime, name: picked.name, size: picked.size });
		update({ ...base, state: 'ready', file });
	} catch (err) {
		update({ ...base, state: 'failed', error: err instanceof Error ? err.message : 'Upload failed' });
	}
}

function sizeLabel(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function typeLabel(name: string, mime: string): string {
	const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1];
	if (ext) {
		return ext.toUpperCase();
	}
	return mime === 'text/plain' ? 'Text' : mime.split('/')[1]?.replace(/^x-/, '').toUpperCase() || 'File';
}

export function fileFacts(file: Pick<IComposerFile, 'name' | 'mime' | 'size'>): string {
	return `${typeLabel(file.name, file.mime)}, ${sizeLabel(file.size)}`;
}

/**
 * What the prompt carries for `@` files and attached files, the way the desktop's composer writes
 * it (agentMentions.ts `serialize`): the model reads `@src/app.ts` and, after the text, a line per
 * attached file naming its saved path; the transcript shows the file names as chips.
 */
export function promptParts(text: string, mentions: readonly IComposerMention[], files: readonly IPromptFile[], slash?: { readonly name: string }): { readonly text: string; readonly displayText: string; readonly mentions: IPromptMention[] } {
	const out: IPromptMention[] = [];
	let display = text;
	const seen = new Set<string>();
	for (const mention of mentions) {
		const token = `@${mention.rel}`;
		if (!text.includes(token) || seen.has(mention.rel)) {
			continue;
		}
		seen.add(mention.rel);
		const label = basename(mention.rel);
		display = display.split(token).join(label);
		out.push({ label, kind: 'file', resource: fileUri(mention.path) });
	}
	if (slash && text.startsWith(`/${slash.name}`)) {
		out.push({ label: `/${slash.name}`, kind: 'skill', value: slash.name });
	}
	const lines: string[] = [];
	files.forEach((file, index) => {
		out.push({ label: file.name, kind: 'file', file: { id: file.id, name: file.name, mime: file.mime, size: file.size, ...(file.path ? { path: file.path } : {}) } });
		if (file.path) {
			lines.push(`[File #${index + 1} "${file.name}" (${fileFacts(file)}) is saved at: ${file.path}]`);
		}
	});
	const body = text || (files.length ? (files.length === 1 ? 'See the attached file.' : `See the ${files.length} attached files.`) : '');
	return {
		text: [body, lines.join('\n')].filter(Boolean).join('\n\n'),
		displayText: display || body,
		mentions: out,
	};
}
