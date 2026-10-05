/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

const BrowserEditorIcon = registerIcon('volt-browser-editor-label-icon', Codicon.globe, localize('voltBrowserEditorLabelIcon', 'Icon of the Browser editor tab.'));
export const OpenBrowserIcon = registerIcon('volt-open-browser', Codicon.browser, localize('voltOpenBrowserIcon', 'Icon of the Open Browser title-bar action.'));

export const BROWSER_EDITOR_ID = 'workbench.editor.voltBrowser';
export const BROWSER_EDITOR_INPUT_ID = 'workbench.input.voltBrowser';
export const OPEN_BROWSER_COMMAND_ID = 'workbench.action.openBrowser';
/** A new tab's address: empty, so it opens on the start page instead of loading a site. */
export const DEFAULT_BROWSER_URL = '';

/** Where a browser tab is drawn in the agent window: beside the chat, floating over it, or across the window. */
export type BrowserPresentation = 'split' | 'floating' | 'fullscreen';
/** Fired by a browser tab (bubbling) to ask the tools area holding it for another presentation. */
export const BROWSER_PRESENT_EVENT = 'volt-browser-present';
/** Fired by the tools area on each browser tab it holds when its presentation changes. */
export const BROWSER_PRESENTATION_EVENT = 'volt-browser-presentation';

export class VoltBrowserEditorInput extends EditorInput {

	static readonly countsInUse = new Set<number>();

	static readonly TypeID = BROWSER_EDITOR_INPUT_ID;
	static readonly EditorID = BROWSER_EDITOR_ID;

	private readonly inputCount: number;
	private title = localize('voltBrowser.tab', "Browser");
	private _favicon: string | undefined;
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

	/** The page's icon (http or data URL), shown on the tab in place of the globe. */
	get favicon(): string | undefined {
		return this._favicon;
	}

	setFavicon(favicon: string | undefined): void {
		if (this._favicon === favicon) {
			return;
		}
		this._favicon = favicon;
		this._onDidChangeLabel.fire();
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
		if (this._favicon) {
			try {
				// Tab labels draw a URI icon as an image (see `IResourceLabelOptions.icon`).
				return URI.parse(this._favicon) as unknown as ThemeIcon;
			} catch {
				// A malformed icon address falls back to the globe.
			}
		}
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
		return JSON.stringify({ resource: editorInput.resource.toString(), url: editorInput.url, title: editorInput.getName(), favicon: editorInput.favicon });
	}

	deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		try {
			const data = JSON.parse(serializedEditorInput) as { resource: string; url?: string; title?: string; favicon?: string };
			const input = instantiationService.createInstance(VoltBrowserEditorInput, URI.parse(data.resource));
			if (data.url) {
				input.url = data.url;
			}
			if (data.title) {
				input.setTitle(data.title);
			}
			if (data.favicon) {
				input.setFavicon(data.favicon);
			}
			return input;
		} catch {
			return undefined;
		}
	}
}
