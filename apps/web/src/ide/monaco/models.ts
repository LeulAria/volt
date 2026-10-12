/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { errorMessage, type IFileContent, languageForPath, RemoteError, type VoltClient } from '@volt/client-core';
import { type EditorTab, getWorkbench, registerEditorHandlers, setDirty, subscribeWorkbench } from '../workbench';
import { monaco } from './setup';

/**
 * The open files as Monaco models, one per path, shared by a file's tab and its diffs. Saving
 * writes through the server (refused when the file changed on disk since it was read, unless
 * overwriting is confirmed); a file nobody edited here follows what the agent writes to it.
 */

interface IEntry {
	readonly path: string;
	readonly model: monaco.editor.ITextModel;
	savedVersion: number;
	mtime: number;
	readonly dispose: () => void;
}

export type FileLoad =
	| { readonly kind: 'text'; readonly model: monaco.editor.ITextModel }
	| Exclude<IFileContent, { kind: 'text' }>;

const entries = new Map<string, IEntry>();
const loads = new Map<string, Promise<FileLoad>>();
const others = new Map<string, Promise<FileLoad>>();
const originals = new Map<string, Promise<monaco.editor.ITextModel>>();
let client: VoltClient | undefined;

export function bindClient(next: VoltClient): void {
	client = next;
}

function key(path: string): string {
	return `file:${path}`;
}

/** The file's model (loaded once), or what it is when it isn't text. */
export function acquireFile(path: string): Promise<FileLoad> {
	const entry = entries.get(path);
	if (entry && !entry.model.isDisposed()) {
		return Promise.resolve({ kind: 'text', model: entry.model });
	}
	let load = loads.get(path) ?? others.get(path);
	if (!load) {
		load = loadFile(path).finally(() => loads.delete(path));
		loads.set(path, load);
	}
	return load;
}

async function loadFile(path: string): Promise<FileLoad> {
	if (!client) {
		throw new Error('Not connected.');
	}
	const content = await client.readFile(path);
	if (content.kind !== 'text') {
		const result: FileLoad = content;
		others.set(path, Promise.resolve(result));
		setTimeout(() => others.delete(path), 30_000);
		return result;
	}
	const uri = monaco.Uri.file(path);
	monaco.editor.getModel(uri)?.dispose();
	const model = monaco.editor.createModel(content.text, languageForPath(path).monaco, uri);
	const listener = model.onDidChangeContent(() => setDirty(key(path), model.getAlternativeVersionId() !== entry.savedVersion));
	const unregister = registerEditorHandlers(key(path), {
		save: () => saveFile(path),
		discard: () => releaseFile(path),
	});
	const entry: IEntry = {
		path,
		model,
		savedVersion: model.getAlternativeVersionId(),
		mtime: content.mtime,
		dispose: () => {
			listener.dispose();
			unregister();
			model.dispose();
		},
	};
	entries.set(path, entry);
	return { kind: 'text', model };
}

export function isLoaded(path: string): boolean {
	return entries.has(path);
}

/** Writes the model to disk. True when it was saved. */
export async function saveFile(path: string, overwrite = false): Promise<boolean> {
	const entry = entries.get(path);
	if (!entry || !client) {
		return false;
	}
	const version = entry.model.getAlternativeVersionId();
	try {
		const result = await client.writeFile(path, entry.model.getValue(), overwrite ? {} : { mtime: entry.mtime });
		entry.mtime = result.mtime;
		entry.savedVersion = version;
		setDirty(key(path), entry.model.getAlternativeVersionId() !== version);
		return true;
	} catch (err) {
		if (err instanceof RemoteError && err.code === 'Conflict') {
			if (window.confirm(`${path.split('/').pop()} changed on ${client.environment.label} since you opened it. Overwrite it with your version?`)) {
				return saveFile(path, true);
			}
			return false;
		}
		client.toast('error', `Couldn't save: ${errorMessage(err)}`);
		return false;
	}
}

/** Drops a file's model (its tab closed, or its changes were discarded). */
export function releaseFile(path: string): void {
	const entry = entries.get(path);
	if (entry) {
		entries.delete(path);
		setDirty(key(path), false);
		entry.dispose();
	}
}

/**
 * Re-reads open files nobody edited here: the agent (or the computer) may have changed them.
 * The model takes only the changed lines, so the cursor and undo stay.
 */
export async function refreshFiles(): Promise<void> {
	if (!client) {
		return;
	}
	await Promise.all([...entries.values()].map(async entry => {
		if (entry.model.getAlternativeVersionId() !== entry.savedVersion) {
			return;
		}
		try {
			const content = await client!.readFile(entry.path);
			if (content.kind !== 'text' || content.mtime === entry.mtime || entry.model.isDisposed()) {
				return;
			}
			entry.mtime = content.mtime;
			if (content.text !== entry.model.getValue()) {
				applyMinimalEdit(entry.model, content.text);
				entry.savedVersion = entry.model.getAlternativeVersionId();
				setDirty(key(entry.path), false);
			}
		} catch {
			// deleted or unreadable: the tab keeps what it had
		}
	}));
}

function applyMinimalEdit(model: monaco.editor.ITextModel, text: string): void {
	const before = model.getLinesContent();
	const after = text.split(/\r?\n/);
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) {
		start++;
	}
	let endBefore = before.length;
	let endAfter = after.length;
	while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
		endBefore--;
		endAfter--;
	}
	if (start === endBefore && start === endAfter) {
		return;
	}
	const eol = model.getEOL();
	const lines = after.slice(start, endAfter);
	let range: monaco.Range;
	let replacement: string;
	if (endBefore < before.length) {
		// Lines follow the change: replace whole lines up to the first unchanged one.
		range = new monaco.Range(start + 1, 1, endBefore + 1, 1);
		replacement = lines.map(line => line + eol).join('');
	} else if (start < before.length) {
		const last = before.length;
		range = new monaco.Range(start + 1, 1, last, model.getLineMaxColumn(last));
		replacement = lines.join(eol);
		if (!lines.length && start > 0) {
			// Trailing lines removed: take the break before them too.
			range = new monaco.Range(start, model.getLineMaxColumn(start), last, model.getLineMaxColumn(last));
		}
	} else {
		const last = before.length;
		range = new monaco.Range(last, model.getLineMaxColumn(last), last, model.getLineMaxColumn(last));
		replacement = eol + lines.join(eol);
	}
	model.pushEditOperations([], [{ range, text: replacement }], () => null);
}

/** The left side of a diff (git's HEAD, or the blob from before a chat's agent changed the file). */
export function originalModel(tab: Extract<EditorTab, { kind: 'diff' }>): Promise<monaco.editor.ITextModel> {
	const id = tab.id;
	let model = originals.get(id);
	if (!model) {
		model = (async () => {
			if (!client) {
				throw new Error('Not connected.');
			}
			const result = tab.base.kind === 'head'
				? await client.gitShow(tab.path)
				: tab.base.old ? await client.gitBlob(tab.base.repo, tab.base.old) : { text: '', exists: false };
			const uri = monaco.Uri.from({ scheme: 'volt-original', path: tab.path.startsWith('/') ? tab.path : `/${tab.path}`, query: id });
			monaco.editor.getModel(uri)?.dispose();
			return monaco.editor.createModel(result.text, languageForPath(tab.path).monaco, uri);
		})();
		originals.set(id, model);
		model.catch(() => originals.delete(id));
	}
	return model;
}

/** The right side of an agent diff when the file is gone (deleted, or not readable): the agent's blob. */
export async function agentModifiedModel(tab: Extract<EditorTab, { kind: 'diff' }>): Promise<monaco.editor.ITextModel> {
	const base = tab.base;
	const text = base.kind === 'agent' && base.new && client ? (await client.gitBlob(base.repo, base.new)).text : '';
	const uri = monaco.Uri.from({ scheme: 'volt-modified', path: tab.path.startsWith('/') ? tab.path : `/${tab.path}`, query: tab.id });
	monaco.editor.getModel(uri)?.dispose();
	return monaco.editor.createModel(text, languageForPath(tab.path).monaco, uri);
}

// Models of files no tab shows any more are let go (closing a tab with changes discards them first).
subscribeWorkbench(() => {
	const tabs = getWorkbench().tabs;
	const open = new Set<string>();
	const diffs = new Set<string>();
	for (const tab of tabs) {
		if (tab.kind === 'file' || tab.kind === 'diff') {
			open.add(tab.path);
		}
		if (tab.kind === 'diff') {
			diffs.add(tab.id);
		}
	}
	for (const [path, entry] of entries) {
		if (!open.has(path) && entry.model.getAlternativeVersionId() === entry.savedVersion) {
			releaseFile(path);
		}
	}
	for (const [id, model] of originals) {
		if (!diffs.has(id)) {
			originals.delete(id);
			void model.then(m => m.dispose(), () => undefined);
		}
	}
});
