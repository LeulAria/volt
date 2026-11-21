/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../../../base/common/async.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { sanitizeTitle } from '../../../../services/voltRuntime/common/history/titleGeneration.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { describeForAgent } from '../../common/scratchBoard/scratchDescribe.js';
import { isUntitledBoardTitle } from '../../common/scratchBoard/scratchIndex.js';
import { IScratchBoardMeta } from '../../common/scratchBoard/scratchTypes.js';
import { ScratchBoardEditorInput } from './scratchBoardInput.js';
import { IScratchBoardService } from './scratchBoardService.js';

/** The name comes once the edits pause this long. */
const SETTLE_MS = 5_000;
const TITLE_TIMEOUT_MS = 30_000;
const MAX_BOARD_CHARS = 3_000;

const BOARD_TITLE_INSTRUCTIONS = [
	'Name this whiteboard so the user can find it again in a list of boards.',
	'Reply with the title only: one line, 2 to 6 words, under 40 characters, sentence case, no quotes, no trailing period.',
	'Say what the board is about, not what is drawn on it ("OAuth sign-in flow", not "Boxes and arrows").',
	'Use the language the board is written in.',
].join('\n');

/**
 * Names an untitled board from what is on it, with the text generation model (Settings > Models),
 * once its edits pause. Only boards open in this window, once each per window: a name given by
 * hand, or by an agent's first drawing, is never replaced.
 */
export class ScratchBoardTitlesContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltScratchBoardTitles';

	private readonly timers = this._register(new DisposableMap<string>());
	/** The `edited` time each timer waits on; a later edit starts it again. */
	private readonly waitingOn = new Map<string, number>();
	private readonly tried = new Set<string>();

	constructor(
		@IScratchBoardService private readonly boards: IScratchBoardService,
		@IEditorService private readonly editorService: IEditorService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
	) {
		super();
		this._register(boards.onDidChangeIndex(() => this.schedule()));
		this._register(editorService.onDidEditorsChange(() => this.schedule()));
		void boards.whenReady.then(() => this.schedule());
	}

	private schedule(): void {
		for (const id of this.openBoards()) {
			const meta = this.boards.getBoard(id);
			if (!meta || !this.wantsName(meta) || this.waitingOn.get(id) === meta.edited) {
				continue;
			}
			this.waitingOn.set(id, meta.edited);
			this.timers.set(id, disposableTimeout(() => void this.name(id), SETTLE_MS));
		}
	}

	private openBoards(): Set<string> {
		return new Set(this.editorService.editors.flatMap(input => input instanceof ScratchBoardEditorInput && input.boardId ? [input.boardId] : []));
	}

	/** Untitled, not tried yet, and enough on it to say what it is about. */
	private wantsName(meta: IScratchBoardMeta): boolean {
		return !meta.deleted && !this.tried.has(meta.id) && isUntitledBoardTitle(meta.title)
			&& ((meta.excerpt?.trim().length ?? 0) >= 12 || (meta.elementCount ?? 0) >= 4);
	}

	private async name(id: string): Promise<void> {
		this.timers.deleteAndDispose(id);
		this.waitingOn.delete(id);
		const meta = this.boards.getBoard(id);
		if (!meta || !this.wantsName(meta)) {
			return;
		}
		this.tried.add(id);
		const doc = await this.boards.readBoardDocument(id).catch(() => undefined);
		if (!doc?.elements.length) {
			this.tried.delete(id);
			return;
		}
		const board = describeForAgent(doc.elements, { boardTitle: '', whole: true }).slice(0, MAX_BOARD_CHARS);
		const title = sanitizeTitle(await this.runtime.generateText(`${BOARD_TITLE_INSTRUCTIONS}\n\nBoard:\n${board}`, { timeoutMs: TITLE_TIMEOUT_MS }));
		// Renamed while the model was thinking: the user's name stays.
		const current = this.boards.getBoard(id);
		if (title && current && !current.deleted && isUntitledBoardTitle(current.title)) {
			this.boards.renameBoard(id, title);
		}
	}
}
