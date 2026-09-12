/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

const BrowserEditorIcon = registerIcon('volt-browser-editor-label-icon', Codicon.globe, localize('voltBrowserEditorLabelIcon', 'Icon of the Browser editor tab.'));

export const BROWSER_EDITOR_ID = 'workbench.editor.voltBrowser';
export const BROWSER_EDITOR_INPUT_ID = 'workbench.input.voltBrowser';
export const OPEN_BROWSER_COMMAND_ID = 'workbench.action.openBrowser';
export const DEFAULT_BROWSER_URL = 'https://www.google.com';

export class VoltBrowserEditorInput extends EditorInput {

	static readonly countsInUse = new Set<number>();

	static readonly TypeID = BROWSER_EDITOR_INPUT_ID;
	static readonly EditorID = BROWSER_EDITOR_ID;

	private readonly inputCount: number;
	private title = localize('voltBrowser.tab', "Browser");
	url = DEFAULT_BROWSER_URL;

	static getNewEditorUri(): URI {
		const handle = Math.floor(Math.random() * 1e9);
		return URI.from({ scheme: Schemas.voltBrowser, path: `browser-${handle}` });
	}

	static getNextCount(): number {
		let count = 0;
		while (VoltBrowserEditorInput.countsInUse.has(count)) {
			count++;
		}
		return count;
	}

	constructor(readonly resource: URI) {
		super();
		this.inputCount = VoltBrowserEditorInput.getNextCount();
		VoltBrowserEditorInput.countsInUse.add(this.inputCount);
	}

	setTitle(title: string): void {
		const next = title.trim() || localize('voltBrowser.tab', "Browser");
		if (this.title === next) {
			return;
		}
		this.title = next;
		this._onDidChangeLabel.fire();
	}

	override get typeId(): string {
		return VoltBrowserEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return VoltBrowserEditorInput.EditorID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton | EditorInputCapabilities.CanDropIntoEditor;
	}

	override getName(): string {
		return this.title;
	}

	override getIcon(): ThemeIcon {
		return BrowserEditorIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof VoltBrowserEditorInput && other.resource.toString() === this.resource.toString();
	}

	override dispose(): void {
		VoltBrowserEditorInput.countsInUse.delete(this.inputCount);
		super.dispose();
	}
}

export class VoltBrowserEditorInputSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof VoltBrowserEditorInput;
	}

	serialize(editorInput: EditorInput): string | undefined {
		if (!(editorInput instanceof VoltBrowserEditorInput)) {
			return undefined;
		}
		return JSON.stringify({ resource: editorInput.resource.toString(), url: editorInput.url, title: editorInput.getName() });
	}

	deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditorInput) as { resource: string; url?: string; title?: string };
			const input = instantiationService.createInstance(VoltBrowserEditorInput, URI.parse(data.resource));
			if (data.url) {
				input.url = data.url;
			}
			if (data.title) {
				input.setTitle(data.title);
			}
			return input;
		} catch {
			return undefined;
		}
	}
}
