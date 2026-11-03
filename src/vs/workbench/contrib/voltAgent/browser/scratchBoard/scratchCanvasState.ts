/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { isValidColor } from '../../common/scratchBoard/scratchColor.js';
import { DEFAULT_SCRATCH_STYLE, IScratchStyleDefaults, ScratchShapeKind } from '../../common/scratchBoard/scratchTypes.js';

export type ScratchTool = 'hand' | 'select' | 'shape' | 'arrow' | 'line' | 'draw' | 'text' | 'note' | 'card' | 'image' | 'eraser' | 'laser' | 'frame' | 'comment';

const STYLE_KEY = 'volt.scratchBoard.style';

/** The style new elements are drawn with, as every board in the profile shares it. */
export function readScratchStyle(storageService: IStorageService): IScratchStyleDefaults {
	return readStyle(storageService.get(STYLE_KEY, StorageScope.PROFILE));
}

/** Changes the shared style (Settings > Canvas & Scratch); open boards pick it up. `undefined` resets it. */
export function writeScratchStyle(storageService: IStorageService, patch: Partial<IScratchStyleDefaults> | undefined): void {
	if (!patch) {
		storageService.remove(STYLE_KEY, StorageScope.PROFILE);
		return;
	}
	storageService.store(STYLE_KEY, JSON.stringify({ ...readScratchStyle(storageService), ...patch }), StorageScope.PROFILE, StorageTarget.USER);
}

/** The canvas's UI state: tool, style for new elements, selection, what is being edited. */
export class ScratchCanvasState extends Disposable {

	private _tool: ScratchTool = 'select';
	private _shapeKind: ScratchShapeKind = 'rectangle';
	private _toolLocked = false;
	private _style: IScratchStyleDefaults;
	private _selection: ReadonlySet<string> = new Set();
	private _editingGroupId: string | null = null;
	private _editingTextId: string | null = null;

	private readonly _onDidChangeTool = this._register(new Emitter<void>());
	readonly onDidChangeTool: Event<void> = this._onDidChangeTool.event;
	private readonly _onDidChangeStyle = this._register(new Emitter<void>());
	readonly onDidChangeStyle: Event<void> = this._onDidChangeStyle.event;
	private readonly _onDidChangeSelection = this._register(new Emitter<void>());
	readonly onDidChangeSelection: Event<void> = this._onDidChangeSelection.event;
	private readonly _onDidChangeEditing = this._register(new Emitter<void>());
	readonly onDidChangeEditing: Event<void> = this._onDidChangeEditing.event;

	constructor(private readonly storageService: IStorageService) {
		super();
		this._style = readStyle(storageService.get(STYLE_KEY, StorageScope.PROFILE));
		// Another board, or Settings, changed it.
		this._register(storageService.onDidChangeValue(StorageScope.PROFILE, STYLE_KEY, this._store)(() => {
			const next = readStyle(storageService.get(STYLE_KEY, StorageScope.PROFILE));
			if (JSON.stringify(next) !== JSON.stringify(this._style)) {
				this._style = next;
				this._onDidChangeStyle.fire();
			}
		}));
	}

	get tool(): ScratchTool { return this._tool; }
	get shapeKind(): ScratchShapeKind { return this._shapeKind; }
	get toolLocked(): boolean { return this._toolLocked; }
	get style(): IScratchStyleDefaults { return this._style; }
	get selection(): ReadonlySet<string> { return this._selection; }
	get editingGroupId(): string | null { return this._editingGroupId; }
	get editingTextId(): string | null { return this._editingTextId; }

	setTool(tool: ScratchTool, shapeKind?: ScratchShapeKind): void {
		const kind = tool === 'shape' ? (shapeKind ?? this._shapeKind) : this._shapeKind;
		if (tool === this._tool && kind === this._shapeKind) {
			return;
		}
		this._tool = tool;
		this._shapeKind = kind;
		this._onDidChangeTool.fire();
	}

	setToolLocked(locked: boolean): void {
		if (locked !== this._toolLocked) {
			this._toolLocked = locked;
			this._onDidChangeTool.fire();
		}
	}

	setStyle(patch: Partial<IScratchStyleDefaults>): void {
		const next = { ...this._style, ...patch };
		if ((Object.keys(patch) as (keyof IScratchStyleDefaults)[]).every(key => next[key] === this._style[key])) {
			return;
		}
		this._style = next;
		this.storageService.store(STYLE_KEY, JSON.stringify(next), StorageScope.PROFILE, StorageTarget.USER);
		this._onDidChangeStyle.fire();
	}

	setSelection(ids: Iterable<string>): void {
		const next = new Set(ids);
		if (next.size === this._selection.size && [...next].every(id => this._selection.has(id))) {
			return;
		}
		this._selection = next;
		this._onDidChangeSelection.fire();
	}

	setEditingGroup(groupId: string | null): void {
		if (groupId !== this._editingGroupId) {
			this._editingGroupId = groupId;
			this._onDidChangeSelection.fire();
		}
	}

	setEditingText(id: string | null): void {
		if (id !== this._editingTextId) {
			this._editingTextId = id;
			this._onDidChangeEditing.fire();
		}
	}
}

function readStyle(raw: string | undefined): IScratchStyleDefaults {
	if (!raw) {
		return DEFAULT_SCRATCH_STYLE;
	}
	try {
		const v = JSON.parse(raw) as Partial<Record<keyof IScratchStyleDefaults, unknown>>;
		const d = DEFAULT_SCRATCH_STYLE;
		const pick = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => typeof value === 'string' && (options as readonly string[]).includes(value) ? value as T : fallback;
		const color = (value: unknown, fallback: string) => typeof value === 'string' && isValidColor(value) ? value : fallback;
		const num = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
		return {
			stroke: color(v.stroke, d.stroke),
			fill: color(v.fill, d.fill),
			fillStyle: pick(v.fillStyle, ['hachure', 'cross-hatch', 'solid'] as const, d.fillStyle),
			strokeWidth: num(v.strokeWidth, d.strokeWidth, 0.5, 16),
			strokeStyle: pick(v.strokeStyle, ['solid', 'dashed', 'dotted'] as const, d.strokeStyle),
			roughness: num(v.roughness, d.roughness, 0, 2),
			opacity: num(v.opacity, d.opacity, 0, 100),
			roundness: pick(v.roundness, ['sharp', 'round'] as const, d.roundness),
			arrowType: pick(v.arrowType, ['sharp', 'round', 'elbow'] as const, d.arrowType),
			startArrowhead: pick(v.startArrowhead, ['none', 'arrow', 'triangle', 'triangle-outline', 'dot', 'circle', 'bar', 'diamond', 'diamond-outline', 'crowfoot-one', 'crowfoot-many', 'crowfoot-one-or-many'] as const, d.startArrowhead),
			endArrowhead: pick(v.endArrowhead, ['none', 'arrow', 'triangle', 'triangle-outline', 'dot', 'circle', 'bar', 'diamond', 'diamond-outline', 'crowfoot-one', 'crowfoot-many', 'crowfoot-one-or-many'] as const, d.endArrowhead),
			fontFamily: pick(v.fontFamily, ['hand', 'sans', 'serif', 'mono'] as const, d.fontFamily),
			fontSize: num(v.fontSize, d.fontSize, 8, 200),
			textAlign: pick(v.textAlign, ['left', 'center', 'right'] as const, d.textAlign),
			noteColor: color(v.noteColor, d.noteColor),
			pen: pick(v.pen, ['pen', 'highlighter'] as const, d.pen),
		};
	} catch {
		return DEFAULT_SCRATCH_STYLE;
	}
}
