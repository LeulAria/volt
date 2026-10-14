/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentSkillEditor.css';
import '../media/agentMarkdownToggle.css';
import { $, addDisposableListener, append, EventType, isHTMLElement } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { dirname, extname, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IEditorGroupView } from '../../../../browser/parts/editor/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { EditorResourceAccessor } from '../../../../common/editor.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { FILE_EDITOR_INPUT_ID } from '../../../files/common/files.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { voltButtonClasses } from '../chrome/voltButton.js';
import { renderEditableMarkdown } from '../customize/agentMarkdownWysiwyg.js';
import { onDidChangeAgentToolEditors } from './agentSurfaceHost.js';
import { AgentToolsEditorPart } from './agentToolsEditorPart.js';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdx']);

/** The markdown file a tools group shows as text, if any. Diffs and custom editors have no toggle. */
function markdownFileOf(group: IEditorGroupView): URI | undefined {
	const editor = group.activeEditor;
	if (!editor || editor.typeId !== FILE_EDITOR_INPUT_ID) {
		return undefined;
	}
	const resource = EditorResourceAccessor.getOriginalUri(editor);
	return resource && MARKDOWN_EXTENSIONS.has(extname(resource).toLowerCase()) ? resource : undefined;
}

/**
 * Preview / Code for a markdown file open in a chat's tools: a button at the right end of the
 * breadcrumbs row, and the rendered file laid over the text editor in place. The tab stays the
 * file's text editor, so the breadcrumbs, dirty state and undo keep working; edits re-render live.
 * Not the markdown extension's webview preview: that opens a second tab with no breadcrumbs row.
 */
class MarkdownGroupToggle extends Disposable {

	private readonly button: HTMLButtonElement;
	private readonly icon: HTMLElement;
	private readonly label: HTMLElement;
	private readonly previewStore = this._register(new DisposableStore());
	private preview: HTMLElement | undefined;
	private resource: URI | undefined;

	constructor(
		private readonly group: IEditorGroupView,
		private readonly previewed: Set<string>,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.button = $('button.volt-md-toggle', { type: 'button' }) as HTMLButtonElement;
		this.button.classList.add(...voltButtonClasses('ghost'));
		this.icon = append(this.button, $('span.volt-md-toggle-icon'));
		this.label = append(this.button, $('span.volt-md-toggle-label'));
		this._register(addDisposableListener(this.button, EventType.CLICK, () => this.setPreview(!this.isPreview())));
		this._register({
			dispose: () => {
				this.button.parentElement?.classList.remove('volt-md-toggle-host');
				this.button.remove();
			}
		});
	}

	show(resource: URI): void {
		if (this.resource?.toString() !== resource.toString()) {
			this.resource = resource;
			this.hidePreview();
		}
		this.mountButton();
		this.render();
	}

	private isPreview(): boolean {
		return !!this.resource && this.previewed.has(this.resource.toString());
	}

	private setPreview(preview: boolean): void {
		if (!this.resource) {
			return;
		}
		if (preview) {
			this.previewed.add(this.resource.toString());
		} else {
			this.previewed.delete(this.resource.toString());
		}
		this.render();
		// Keys go to what shows: typing into the hidden text editor behind the preview would edit unseen.
		if (preview) {
			this.preview?.focus();
		} else {
			this.group.focus();
		}
	}

	/** Last in the breadcrumbs row, after the breadcrumbs control (which is remade when breadcrumbs are toggled). */
	private mountButton(): void {
		const row = this.group.element.querySelector<HTMLElement>(':scope > .title > .breadcrumbs-below-tabs');
		if (!row) {
			this.button.remove();
			return;
		}
		row.classList.add('volt-md-toggle-host');
		if (row.lastElementChild !== this.button) {
			row.appendChild(this.button);
		}
	}

	private render(): void {
		const preview = this.isPreview();
		this.icon.replaceChildren(renderIcon(preview ? Codicon.code : Codicon.openPreview));
		this.label.textContent = preview ? localize('voltMdToggle.code', "Code") : localize('voltMdToggle.preview', "Preview");
		const tip = preview ? localize('voltMdToggle.codeTip', "Show the Markdown Source") : localize('voltMdToggle.previewTip', "Show the Rendered Markdown");
		this.button.setAttribute('aria-label', tip);
		this.button.setAttribute('aria-pressed', String(preview));
		setAgentTooltip(this.button, tip);
		if (preview) {
			void this.showPreview();
		} else {
			this.hidePreview();
		}
	}

	private async showPreview(): Promise<void> {
		const resource = this.resource;
		if (!resource || this.preview) {
			return;
		}
		const host = this.group.element.querySelector<HTMLElement>(':scope > .editor-container');
		if (!host) {
			return;
		}
		const preview = append(host, $('.volt-md-preview'));
		preview.tabIndex = -1;
		const body = append(preview, $('.volt-md-preview-body.volt-skill-markdown'));
		this.preview = preview;
		host.classList.add('volt-md-preview-host');
		this.previewStore.add({
			dispose: () => {
				preview.remove();
				host.classList.remove('volt-md-preview-host');
			}
		});
		this.previewStore.add(addDisposableListener(preview, EventType.CLICK, e => this.onClick(e, resource)));
		const store = this.previewStore;
		const reference = await this.textModelService.createModelReference(resource).catch(() => undefined);
		if (!reference) {
			return;
		}
		if (this.preview !== preview) {
			reference.dispose();
			return;
		}
		store.add(reference);
		const model = reference.object.textEditorModel;
		const folder = dirname(resource);
		const paint = () => {
			renderEditableMarkdown(body, model.getValue().replace(/\r\n/g, '\n'), src => {
				try {
					return FileAccess.uriToBrowserUri(joinPath(folder, decodeURIComponent(src))).toString(true);
				} catch {
					return undefined;
				}
			});
		};
		paint();
		const repaint = store.add(new RunOnceScheduler(paint, 150));
		store.add(model.onDidChangeContent(() => repaint.schedule()));
	}

	private hidePreview(): void {
		this.preview = undefined;
		this.previewStore.clear();
	}

	/** Links open like links in a chat: in-page anchors scroll, relative paths resolve beside the file. */
	private onClick(e: MouseEvent, resource: URI): void {
		const target = e.target;
		const anchor = isHTMLElement(target) ? target.closest('a') : null;
		const href = anchor?.getAttribute('href');
		if (!anchor || !href) {
			return;
		}
		e.preventDefault();
		if (href.startsWith('#')) {
			const id = decodeURIComponent(href.slice(1)).toLowerCase();
			const heading = [...(this.preview?.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6') ?? [])]
				.find(h => (h.textContent ?? '').trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/\s+/g, '-') === id);
			heading?.scrollIntoView({ block: 'start' });
			return;
		}
		const absolute = /^[a-z][\w+.-]*:/i.test(href);
		const uri = absolute ? URI.parse(href) : joinPath(dirname(resource), decodeURIComponent(href.split('#')[0]));
		void this.openerService.open(uri, { fromUserGesture: true });
	}
}

class AgentMarkdownToggleContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentMarkdownToggle';

	private readonly toggles = this._register(new DisposableMap<IEditorGroupView, MarkdownGroupToggle>());
	/** Files shown rendered, kept across tab switches for the window's lifetime. */
	private readonly previewed = new Set<string>();
	private scheduled = false;

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(onDidChangeAgentToolEditors(() => this.schedule()));
		this._register(this.editorGroupsService.onDidRemoveGroup(() => this.schedule()));
	}

	private schedule(): void {
		if (this.scheduled) {
			return;
		}
		this.scheduled = true;
		// After the group's title and breadcrumbs caught up with the new tab.
		mainWindow.requestAnimationFrame(() => {
			this.scheduled = false;
			this.sync();
		});
	}

	private sync(): void {
		const live = new Set<IEditorGroupView>();
		for (const part of this.editorGroupsService.parts) {
			if (!(part instanceof AgentToolsEditorPart)) {
				continue;
			}
			for (const group of part.groups) {
				const resource = markdownFileOf(group);
				if (!resource) {
					continue;
				}
				live.add(group);
				let toggle = this.toggles.get(group);
				if (!toggle) {
					toggle = this.instantiationService.createInstance(MarkdownGroupToggle, group, this.previewed);
					this.toggles.set(group, toggle);
				}
				toggle.show(resource);
			}
		}
		for (const group of [...this.toggles.keys()]) {
			if (!live.has(group)) {
				this.toggles.deleteAndDispose(group);
			}
		}
	}
}

registerWorkbenchContribution2(AgentMarkdownToggleContribution.ID, AgentMarkdownToggleContribution, WorkbenchPhase.Eventually);
