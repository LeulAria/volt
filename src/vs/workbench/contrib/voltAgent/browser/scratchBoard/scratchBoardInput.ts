/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

export const OPEN_SCRATCH_BOARD_COMMAND_ID = 'workbench.action.voltScratchBoard.open';
export const NEW_SCRATCH_BOARD_COMMAND_ID = 'workbench.action.voltScratchBoard.new';
/** The Scratch button: a clean board (an untouched one is reused). */
export const OPEN_FRESH_SCRATCH_BOARD_COMMAND_ID = 'workbench.action.voltScratchBoard.openFresh';
/** Args: sessionId, boardId. The board as a tab in that chat's right panel. */
export const OPEN_SCRATCH_BOARD_BESIDE_COMMAND_ID = 'workbench.action.voltScratchBoard.openBeside';

const ScratchBoardIcon = registerIcon('volt-scratch-board-label-icon', Codicon.notebook, localize('voltScratchBoardIcon', 'Icon of the Scratch board tab.'));

export const SCRATCH_BOARD_EDITOR_ID = 'workbench.editor.voltScratchBoard';
export const SCRATCH_BOARD_INPUT_ID = 'workbench.input.voltScratchBoard';

/** The Scratch page: one tab for every board; the board it shows lives on the input. */
export class ScratchBoardEditorInput extends EditorInput {

	static readonly TypeID = SCRATCH_BOARD_INPUT_ID;
	static readonly EditorID = SCRATCH_BOARD_EDITOR_ID;

	readonly resource = URI.from({ scheme: Schemas.voltScratchBoard, path: 'scratch' });

	private readonly _onDidChangeBoard = this._register(new Emitter<void>());
	/** Another board shows in the tab; the title bar follows its project. */
	readonly onDidChangeBoard = this._onDidChangeBoard.event;

	/** A chat whose drawing comes into view the first time the tab shows (a tab added behind others). */
	revealSessionId: string | undefined;

	private _boardId: string | undefined;
	get boardId(): string | undefined {
		return this._boardId;
	}
	set boardId(boardId: string | undefined) {
		if (this._boardId !== boardId) {
			this._boardId = boardId;
			this._onDidChangeBoard.fire();
		}
	}

	override get typeId(): string {
		return ScratchBoardEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return ScratchBoardEditorInput.EditorID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('voltScratch.tab', "Scratch");
	}

	/** The notebook, as in the + menu; without it the tab falls back to a file icon. */
	override getIcon(): ThemeIcon {
		return ScratchBoardIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof ScratchBoardEditorInput;
	}
}

export class ScratchBoardEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(input: EditorInput): string {
		const boardId = input instanceof ScratchBoardEditorInput ? input.boardId : undefined;
		return boardId ? JSON.stringify({ boardId }) : '';
	}
	deserialize(instantiationService: IInstantiationService, raw: string): EditorInput {
		const input = instantiationService.createInstance(ScratchBoardEditorInput);
		try {
			const value = raw ? JSON.parse(raw) as { boardId?: unknown } : {};
			if (typeof value.boardId === 'string' && value.boardId) {
				input.boardId = value.boardId;
			}
		} catch {
			// The last opened board.
		}
		return input;
	}
}
