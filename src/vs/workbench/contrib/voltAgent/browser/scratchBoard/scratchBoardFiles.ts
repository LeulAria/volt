/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../services/editor/common/editorResolverService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ITextEditorService } from '../../../../services/textfile/common/textEditorService.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { parseBoardDocument } from '../../common/scratchBoard/scratchDocument.js';
import { parseScratchFile, scratchAssetIds, SCRATCH_FILE_EXTENSION, serializeScratchFile } from '../../common/scratchBoard/scratchFile.js';
import { boardDisplayTitle } from '../../common/scratchBoard/scratchIndex.js';
import { IScratchBoardMeta, ScratchElement } from '../../common/scratchBoard/scratchTypes.js';
import { ScratchBoardEditorInput, SCRATCH_BOARD_EDITOR_ID } from './scratchBoardInput.js';
import { IScratchBoardService } from './scratchBoardService.js';

export const IScratchBoardFiles = createDecorator<IScratchBoardFiles>('voltScratchBoardFiles');

/**
 * Boards saved in a project as `.scratch` files. Saving links the board to its file: every edit
 * writes the file again, and opening the file (Explorer, Quick Open) shows the board in a Scratch
 * tab. A file changed outside Volt (a pull, another editor) replaces the board's content when it
 * is opened, as one step the user can undo.
 */
export interface IScratchBoardFiles {
	readonly _serviceBrand: undefined;
	/** The board for a `.scratch` file: the one saved to it, else a new board read from it. */
	boardForFile(file: URI): Promise<string>;
	/** Asks where, writes the file and links the board to it. Undefined when cancelled. */
	saveAs(boardId: string): Promise<URI | undefined>;
}

/** Edits reach the file this long after the board saved them. */
const WRITE_DELAY_MS = 800;
/** A board edit this much newer than the file's write time means the file missed it. */
const FILE_CLOCK_SLACK_MS = 2_000;

class ScratchBoardFiles extends Disposable implements IScratchBoardFiles {

	declare readonly _serviceBrand: undefined;

	private readonly writers = this._register(new DisposableMap<string, RunOnceScheduler>());
	/** Writes under way, so quitting waits for them. */
	private readonly writing = new Set<Promise<void>>();
	/** What this window last wrote to (or read from) each board's file. */
	private readonly written = new Map<string, string>();
	/** Base64 of the images, by asset id (content-hashed, so it never goes stale). */
	private readonly encoded = new Map<string, string>();

	constructor(
		@IScratchBoardService private readonly boards: IScratchBoardService,
		@IFileService private readonly fileService: IFileService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@ILabelService private readonly labelService: ILabelService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		this._register(boards.onDidEditBoard(id => {
			if (!this.boards.getBoard(id)?.file) {
				return;
			}
			let writer = this.writers.get(id);
			if (!writer) {
				writer = new RunOnceScheduler(() => void this.track(this.writeBack(id)), WRITE_DELAY_MS);
				this.writers.set(id, writer);
			}
			writer.schedule();
		}));
		// Quitting waits until the boards are saved and every edit has reached its project file.
		this._register(lifecycleService.onWillShutdown(e => e.join(this.flushForShutdown(), { id: 'voltScratchBoardFiles', label: localize('voltScratch.savingFiles', "Saving Scratch board files") })));
	}

	private track(write: Promise<void>): Promise<void> {
		this.writing.add(write);
		void write.finally(() => this.writing.delete(write));
		return write;
	}

	private async flushForShutdown(): Promise<void> {
		await this.boards.flush();
		const pending: Promise<void>[] = [...this.writing];
		for (const [id, writer] of this.writers) {
			if (writer.isScheduled()) {
				writer.cancel();
				pending.push(this.track(this.writeBack(id)));
			}
		}
		await Promise.all(pending);
	}

	async boardForFile(file: URI): Promise<string> {
		await this.boards.whenReady;
		const read = await this.fileService.readFile(file);
		const text = read.value.toString();
		const content = parseScratchFile(text);
		if (!content) {
			throw new Error(localize('voltScratch.notBoardFile', "{0} is not a Scratch board file.", basename(file)));
		}
		const elements = await this.importAssets(content.elements, content.assets);
		const key = file.toString();
		const linked = this.boards.index.boards.find(b => b.file === key && !b.deleted);
		if (linked) {
			if (linked.edited > read.mtime + FILE_CLOCK_SLACK_MS) {
				// The board was edited after the file was last written (Volt quit before it caught up):
				// the board is newer, so it updates the file rather than being replaced by it.
				await this.track(this.writeBack(linked.id));
			} else if (this.written.get(linked.id) !== text) {
				await this.applyFile(linked.id, elements, content.settings);
				this.written.set(linked.id, text);
			}
			return linked.id;
		}
		const doc = parseBoardDocument({ elements, settings: content.settings }, 'file').document;
		const title = content.title.trim() || basename(file).replace(/\.scratch$/i, '');
		const id = await this.boards.createBoard({ title, document: { elements: doc.elements, settings: doc.settings } });
		this.boards.setBoardFile(id, key);
		this.written.set(id, text);
		return id;
	}

	async saveAs(boardId: string): Promise<URI | undefined> {
		const meta = this.boards.getBoard(boardId);
		if (!meta) {
			return undefined;
		}
		const current = meta.file ? URI.parse(meta.file) : undefined;
		const target = await this.fileDialogService.showSaveDialog({
			title: localize('voltScratch.saveAsFileTitle', "Save Board as File"),
			defaultUri: current ?? joinPath(await this.defaultFolder(meta), `${safeFileName(boardDisplayTitle(meta))}${SCRATCH_FILE_EXTENSION}`),
			filters: [{ name: localize('voltScratch.boardFile', "Scratch board"), extensions: [SCRATCH_FILE_EXTENSION.slice(1)] }],
		});
		if (!target) {
			return undefined;
		}
		try {
			const content = await this.contentFor(boardId);
			if (content === undefined) {
				return undefined;
			}
			await this.fileService.writeFile(target, VSBuffer.fromString(content));
			const key = target.toString();
			// One board per file: an older board saved there lets go of it.
			for (const other of this.boards.index.boards) {
				if (other.id !== boardId && other.file === key) {
					this.boards.setBoardFile(other.id, undefined);
				}
			}
			this.boards.setBoardFile(boardId, key);
			this.written.set(boardId, content);
			this.notificationService.info(localize('voltScratch.savedAsFile', "Saved the board to {0}. Your edits keep the file up to date, and opening it shows the board.", this.labelService.getUriLabel(target, { relative: true })));
			return target;
		} catch (err) {
			this.notificationService.error(localize('voltScratch.saveAsFileFailed', "Could not save the board as a file: {0}", err instanceof Error ? err.message : String(err)));
			return undefined;
		}
	}

	/** The board's project, else the active one, else the workspace, else home. */
	private async defaultFolder(meta: IScratchBoardMeta): Promise<URI> {
		const project = (meta.projectId ? this.sessionContext.getProject(meta.projectId) : undefined) ?? this.sessionContext.activeProject;
		return project?.root ?? this.workspaceContext.getWorkspace().folders[0]?.uri ?? await this.pathService.userHome();
	}

	private async writeBack(id: string): Promise<void> {
		const meta = this.boards.getBoard(id);
		if (!meta?.file || meta.deleted) {
			return;
		}
		const file = URI.parse(meta.file);
		try {
			// Gone from the project (deleted, or another branch checked out): not written back. The
			// link stays, so the file opens on this board again when it returns.
			if (!await this.fileService.exists(file)) {
				return;
			}
			const content = await this.contentFor(id);
			if (content === undefined || content === this.written.get(id)) {
				return;
			}
			await this.fileService.writeFile(file, VSBuffer.fromString(content));
			this.written.set(id, content);
		} catch (err) {
			this.logService.warn(`[volt scratch] could not write ${file.toString()}`, err);
		}
	}

	private async contentFor(id: string): Promise<string | undefined> {
		const meta = this.boards.getBoard(id);
		const doc = meta ? await this.boards.readBoardDocument(id) : undefined;
		if (!meta || !doc) {
			return undefined;
		}
		const assets: Record<string, { mime: string; data: string }> = {};
		for (const assetId of scratchAssetIds(doc.elements)) {
			const image = doc.elements.find(el => el.type === 'image' && el.assetId === assetId);
			const data = this.encoded.get(assetId) ?? await this.boards.readAsset(assetId).then(bytes => bytes ? encodeBase64(bytes) : undefined);
			if (image?.type === 'image' && data) {
				this.encoded.set(assetId, data);
				assets[assetId] = { mime: image.mime, data };
			}
		}
		return serializeScratchFile({ title: boardDisplayTitle(meta), elements: doc.elements, settings: doc.settings, assets });
	}

	/** The file's images into the board's asset store; elements follow if an image's id changed. */
	private async importAssets(elements: readonly unknown[], assets: Readonly<Record<string, { mime: string; data: string }>>): Promise<readonly unknown[]> {
		const renamed = new Map<string, string>();
		for (const [assetId, asset] of Object.entries(assets)) {
			try {
				const stored = await this.boards.putAsset(decodeBase64(asset.data).buffer, asset.mime);
				this.encoded.set(stored, asset.data);
				if (stored !== assetId) {
					renamed.set(assetId, stored);
				}
			} catch (err) {
				this.logService.warn(`[volt scratch] could not read image ${assetId} from a board file`, err);
			}
		}
		if (!renamed.size) {
			return elements;
		}
		return elements.map(el => {
			const assetId = (el as { assetId?: unknown } | null)?.assetId;
			return typeof assetId === 'string' && renamed.has(assetId) ? { ...el as object, assetId: renamed.get(assetId) } : el;
		});
	}

	/** The file's content onto its board (open or not), unless the board already holds it. */
	private async applyFile(id: string, elements: readonly unknown[], settings: unknown): Promise<void> {
		const ref = await this.boards.acquireModel(id);
		try {
			const current = ref.object.toDocument();
			const incoming = parseBoardDocument({ ...current, elements, settings: settings ?? current.settings }, id).document;
			if (sameContent(current.elements, incoming.elements)) {
				return;
			}
			ref.object.restore(incoming);
			await ref.object.flush();
		} finally {
			ref.dispose();
		}
	}
}

/** Equal but for the edit counters (`version`, `updated`), which every restore bumps. */
function sameContent(a: readonly ScratchElement[], b: readonly ScratchElement[]): boolean {
	const plain = (elements: readonly ScratchElement[]) => JSON.stringify(elements.map(({ version: _version, updated: _updated, ...rest }) => rest));
	return a.length === b.length && plain(a) === plain(b);
}

function safeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'scratch';
}

registerSingleton(IScratchBoardFiles, ScratchBoardFiles, InstantiationType.Delayed);

/**
 * `.scratch` files open as a Scratch tab (in a chat's right panel when a chat is in front), and
 * the board files service starts, so edits to boards saved in a project reach their files.
 */
export class ScratchBoardFilesContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltScratchBoardFiles';

	constructor(
		@IScratchBoardFiles files: IScratchBoardFiles,
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IFileService fileService: IFileService,
		@ITextEditorService textEditorService: ITextEditorService,
		@INotificationService notificationService: INotificationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(editorResolverService.registerEditor(
			`**/*${SCRATCH_FILE_EXTENSION}`,
			{
				id: SCRATCH_BOARD_EDITOR_ID,
				label: localize('voltScratch.fileEditorLabel', "Scratch Board"),
				detail: localize('voltScratch.fileEditorDetail', "Open the board saved in this file"),
				priority: RegisteredEditorPriority.default,
			},
			{ canSupportResource: resource => fileService.hasProvider(resource), singlePerResource: true },
			{
				createEditorInput: async ({ resource, options }, group) => {
					let boardId: string;
					try {
						boardId = await files.boardForFile(resource);
					} catch (err) {
						// Not a board (or unreadable): the file's text, as any other file.
						notificationService.warn(err instanceof Error ? err.message : String(err));
						return { editor: textEditorService.createTextEditor({ resource }), options };
					}
					// A group shows one Scratch tab: it switches to this board.
					const open = group.editors.find((editor): editor is ScratchBoardEditorInput => editor instanceof ScratchBoardEditorInput);
					const input = open ?? instantiationService.createInstance(ScratchBoardEditorInput);
					input.boardId = boardId;
					return { editor: input, options: { ...options, pinned: true } };
				},
			},
		));
	}
}
