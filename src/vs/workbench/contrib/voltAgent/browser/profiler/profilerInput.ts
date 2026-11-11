/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { basename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

export const PROFILER_EDITOR_ID = 'workbench.editor.voltProfiler';
export const PROFILER_INPUT_ID = 'workbench.input.voltProfiler';

/**
 * The Profiler tab for one profile file, or for two (`compareWith`: the run before, shown as a
 * differential flame graph). `chatId` is the chat whose agent made it: notes and "Ask Agent" go there.
 */
export class VoltProfilerInput extends EditorInput {

	static readonly TypeID = PROFILER_INPUT_ID;

	constructor(readonly file: URI, readonly compareWith: URI | undefined, readonly chatId: string | undefined, private title: string | undefined) {
		super();
	}

	override get typeId(): string { return PROFILER_INPUT_ID; }
	override get editorId(): string { return PROFILER_EDITOR_ID; }

	override get resource(): URI {
		return URI.from({ scheme: 'volt-profiler', path: this.file.path, query: this.compareWith ? `compare=${encodeURIComponent(this.compareWith.toString())}` : '' });
	}

	override getName(): string {
		const name = this.title ?? basename(this.file);
		return this.compareWith ? `${basename(this.compareWith)} \u2192 ${name}` : name;
	}

	override getIcon(): ThemeIcon {
		return this.compareWith ? Codicon.diff : Codicon.flame;
	}

	setTitle(title: string): void {
		if (title !== this.title) {
			this.title = title;
			this._onDidChangeLabel.fire();
		}
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof VoltProfilerInput
			? other.file.toString() === this.file.toString() && other.compareWith?.toString() === this.compareWith?.toString()
			: super.matches(other);
	}
}

interface ISerializedProfilerInput {
	readonly file: string;
	readonly compareWith?: string;
	readonly chatId?: string;
	readonly title?: string;
}

/** A Profiler tab survives a reload: the file is read again (profiles are files, never only in memory). */
export class VoltProfilerInputSerializer implements IEditorSerializer {

	canSerialize(): boolean {
		return true;
	}

	serialize(input: VoltProfilerInput): string {
		const data: ISerializedProfilerInput = { file: input.file.toString(), ...(input.compareWith ? { compareWith: input.compareWith.toString() } : {}), ...(input.chatId ? { chatId: input.chatId } : {}), title: input.getName() };
		return JSON.stringify(data);
	}

	deserialize(_instantiationService: IInstantiationService, raw: string): VoltProfilerInput | undefined {
		try {
			const data = JSON.parse(raw) as ISerializedProfilerInput;
			if (typeof data.file !== 'string') {
				return undefined;
			}
			return new VoltProfilerInput(URI.parse(data.file), typeof data.compareWith === 'string' ? URI.parse(data.compareWith) : undefined, typeof data.chatId === 'string' ? data.chatId : undefined, undefined);
		} catch {
			return undefined;
		}
	}
}
