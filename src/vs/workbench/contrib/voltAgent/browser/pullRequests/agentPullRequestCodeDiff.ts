/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, Dimension } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Limiter } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, ValueWithChangeEvent } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { RefCounted } from '../../../../../editor/browser/widget/diffEditor/utils.js';
import { IDocumentDiffItem, IMultiDiffEditorModel } from '../../../../../editor/browser/widget/multiDiffEditor/model.js';
import { MultiDiffEditorViewModel } from '../../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel.js';
import { MultiDiffEditorWidget } from '../../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js';
import { IResourceLabel, IWorkbenchUIElementFactory } from '../../../../../editor/browser/widget/multiDiffEditor/workbenchUIElementFactory.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVoltPrFilePatch, IVoltPrRepoRef } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { ResourceLabel } from '../../../../browser/labels.js';
import { originalFromPatch, parseUnifiedPatch } from '../../common/agentPrDiff.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createAgentReviewDiffLook } from '../review/agentChangesEditor.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';

/** The Code tab's text models: one per side of each file, per pull request and commit. */
export const PR_CODE_SCHEME = 'volt-agent-pr-code';

/** Files longer than this many changed lines start folded. */
const LARGE_FILE_LINES = 400;
/** Blob reads running at once. */
const READ_CONCURRENCY = 6;

export type PrCodeFile = Pick<IVoltPrFilePatch, 'path' | 'previousPath' | 'change' | 'additions' | 'deletions' | 'patch' | 'blob'>;

export interface IPrCodeDiffSource {
	/** Changes when the files change: another pull request, head or commit. */
	readonly key: string;
	readonly repo: IVoltPrRepoRef;
	/** A local clone, read before asking the host. */
	readonly folder?: string;
	readonly files: readonly PrCodeFile[];
}

export interface IPrCodeDiffDelegate {
	/** Undefined: no Viewed box (one commit's files). */
	viewed(path: string): boolean | undefined;
	toggleViewed(path: string, viewed: boolean): void;
	/** The file's name in its header was clicked. */
	openFile(path: string): void;
	/** Ask the chat's agent about lines of a file: a selection on the new side, else the whole change (its patch). */
	ask(path: string, start: number, end: number, code: string): void;
}

/** A file the diff can show: it has hunks, or it only moved. */
export function canShowInCodeDiff(file: PrCodeFile): boolean {
	return !!file.patch || (file.change === 'renamed' && !file.additions && !file.deletions && !!file.blob);
}

function codeUri(source: IPrCodeDiffSource, path: string, side: 'original' | 'modified'): URI {
	return URI.from({ scheme: PR_CODE_SCHEME, path: `/${path}`, query: `key=${encodeURIComponent(source.key)}&side=${side}` });
}

/**
 * The pull request's changes in the workbench's own multi-file diff (the one "Open in Diff Editor"
 * shows), in the agent review's look: one line number column, red and green bars, Monaco's colors,
 * "N hidden lines" folds with the symbol they sit in. Each file's new side is read once (from the
 * clone, else GitHub) and its old side is rebuilt from the patch.
 */
export class AgentPullRequestCodeDiff extends Disposable {

	readonly element: HTMLElement;
	private readonly widget: MultiDiffEditorWidget;
	private readonly loadStore = this._register(new DisposableStore());
	private readonly viewModel = this._register(new MutableDisposable<MultiDiffEditorViewModel>());
	private readonly _onDidChangeViewed = this._register(new Emitter<void>());
	private source: IPrCodeDiffSource | undefined;
	private documents = new ValueWithChangeEvent<readonly RefCounted<IDocumentDiffItem>[] | 'loading'>('loading');
	private loadSeq = 0;
	private failed: string[] = [];
	private readonly _onDidLoad = this._register(new Emitter<void>());
	/** Fires when the files of a new source are read (or failed to). */
	readonly onDidLoad = this._onDidLoad.event;

	constructor(
		private readonly delegate: IPrCodeDiffDelegate,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IAgentPullRequestService private readonly pullRequests: IAgentPullRequestService,
	) {
		super();
		this.element = $('.volt-pr-code-diff');
		const look = this._register(createAgentReviewDiffLook(instantiationService, this.element));
		const labels: IWorkbenchUIElementFactory = {
			diffEditorOptions: look.diffEditorOptions,
			createResourceLabel: element => this.createLabel(element),
		};
		this.widget = this._register(instantiationService.createInstance(MultiDiffEditorWidget, this.element, labels));
	}

	get isLoading(): boolean {
		return this.documents.value === 'loading';
	}

	/** Paths whose new side could not be read. */
	get failedPaths(): readonly string[] {
		return this.failed;
	}

	setSource(source: IPrCodeDiffSource): void {
		if (this.source?.key === source.key) {
			this._onDidChangeViewed.fire();
			return;
		}
		this.source = source;
		this.failed = [];
		// Each source gets its own value: the last view model goes with its documents.
		this.documents = new ValueWithChangeEvent<readonly RefCounted<IDocumentDiffItem>[] | 'loading'>('loading');
		const model: IMultiDiffEditorModel = { documents: this.documents };
		this.viewModel.value = this.widget.createViewModel(model);
		this.widget.setViewModel(this.viewModel.value);
		// The last files' models go once nothing shows them.
		this.loadStore.clear();
		void this.load(source, ++this.loadSeq);
	}

	/** The Viewed boxes read their state again. */
	refreshViewed(): void {
		this._onDidChangeViewed.fire();
	}

	layout(width: number, height: number): void {
		this.widget.layout(new Dimension(width, height));
	}

	collapseAll(): void {
		this.viewModel.value?.collapseAll();
	}

	expandAll(): void {
		this.viewModel.value?.expandAll();
	}

	allCollapsed(): boolean {
		const items = this.viewModel.value?.items.get() ?? [];
		return items.length > 0 && items.every(item => item.collapsed.get());
	}

	setCollapsed(path: string, collapsed: boolean): void {
		const item = this.itemFor(path);
		item?.collapsed.set(collapsed, undefined);
	}

	reveal(path: string): void {
		const item = this.itemFor(path);
		if (!item) {
			return;
		}
		item.collapsed.set(false, undefined);
		this.widget.reveal({ original: item.originalUri, modified: item.modifiedUri }, { highlight: false });
	}

	private itemFor(path: string) {
		return this.viewModel.value?.items.get().find(item => (item.modifiedUri ?? item.originalUri)?.path === `/${path}`);
	}

	private async load(source: IPrCodeDiffSource, seq: number): Promise<void> {
		const store = this.loadStore;
		const limiter = new Limiter<string | undefined>(READ_CONCURRENCY);
		const files = source.files.filter(canShowInCodeDiff);
		const texts = await Promise.all(files.map(file => file.blob
			? limiter.queue(() => this.pullRequests.api.readBlob({ repo: source.repo, sha: file.blob!, ...(source.folder ? { folder: source.folder } : {}) }).catch(() => undefined))
			: Promise.resolve(file.change === 'deleted' ? '' : undefined)));
		limiter.dispose();
		if (seq !== this.loadSeq) {
			return;
		}
		const documents: RefCounted<IDocumentDiffItem>[] = [];
		const failed: string[] = [];
		files.forEach((file, index) => {
			const modifiedText = texts[index];
			const originalText = modifiedText === undefined ? undefined
				: file.patch ? originalFromPatch(modifiedText, file.patch) : modifiedText;
			if (modifiedText === undefined || originalText === undefined) {
				failed.push(file.path);
				return;
			}
			const original = file.change === 'added' ? undefined : this.createModel(source, file.previousPath ?? file.path, 'original', originalText, store);
			const modified = file.change === 'deleted' ? undefined : this.createModel(source, file.path, 'modified', modifiedText, store);
			const item: IDocumentDiffItem = {
				original,
				modified,
				renderHeaderExtras: container => this.renderHeaderExtras(container, file),
			};
			documents.push(RefCounted.createOfNonDisposable(item, toDisposable(() => { /* the models live in loadStore */ }), this));
		});
		this.failed = failed;
		this.documents.value = documents;
		// Viewed files and long ones start folded, as on GitHub.
		for (const file of files) {
			if (this.delegate.viewed(file.path) || file.additions + file.deletions > LARGE_FILE_LINES) {
				this.setCollapsed(file.path, true);
			}
		}
		this._onDidLoad.fire();
	}

	private createModel(source: IPrCodeDiffSource, path: string, side: 'original' | 'modified', text: string, store: DisposableStore): ITextModel {
		const uri = codeUri(source, path, side);
		this.modelService.getModel(uri)?.dispose();
		const language = this.languageService.createByFilepathOrFirstLine(URI.file(`/${path}`), text.split(/\r?\n/, 1)[0]);
		return store.add(this.modelService.createModel(text, language, uri));
	}

	/** "+3 -1", ask the agent, and Viewed, beside the file's name. */
	private renderHeaderExtras(container: HTMLElement, file: PrCodeFile): IDisposable {
		const store = new DisposableStore();
		const stats = append(container, $('span.volt-pr-code-stats'));
		append(stats, $('span.add')).textContent = `+${file.additions}`;
		// allow-any-unicode-next-line
		append(stats, $('span.del')).textContent = `−${file.deletions}`;
		if (file.change !== 'deleted') {
			const ask = append(container, $('button.volt-pr-code-ask')) as HTMLButtonElement;
			ask.type = 'button';
			ask.appendChild(renderIcon(Codicon.commentDiscussion));
			const askLabel = localize('voltPr.askFile', "Ask the agent about the selected lines, or about this file's changes");
			ask.setAttribute('aria-label', askLabel);
			setAgentTooltip(ask, askLabel);
			store.add(addDisposableListener(ask, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.ask(file);
			}));
		}
		if (this.delegate.viewed(file.path) !== undefined) {
			const box = append(container, $('button.volt-pr-viewed')) as HTMLButtonElement;
			box.type = 'button';
			box.setAttribute('role', 'checkbox');
			const check = append(box, $('span.volt-pr-viewed-box'));
			append(box, $('span')).textContent = localize('voltPr.viewed', "Viewed");
			const sync = () => {
				const viewed = !!this.delegate.viewed(file.path);
				box.setAttribute('aria-checked', String(viewed));
				box.classList.toggle('checked', viewed);
				check.replaceChildren(renderIcon(viewed ? Codicon.check : Codicon.blank));
			};
			sync();
			store.add(this._onDidChangeViewed.event(sync));
			store.add(addDisposableListener(box, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				const viewed = !this.delegate.viewed(file.path);
				// Marking a file viewed folds it, like GitHub; unmarking opens it again.
				this.setCollapsed(file.path, viewed);
				this.delegate.toggleViewed(file.path, viewed);
			}));
		}
		store.add(toDisposable(() => container.replaceChildren()));
		return store;
	}

	/** The new side's selected lines, else the file's whole change. */
	private ask(file: PrCodeFile): void {
		const item = this.itemFor(file.path);
		const editor = item?.modifiedUri ? this.widget.tryGetCodeEditor(item.modifiedUri)?.editor : undefined;
		const selection = editor?.getSelection();
		const model = editor?.getModel();
		if (selection && model && !selection.isEmpty()) {
			const end = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
			const code = model.getValueInRange({ startLineNumber: selection.startLineNumber, startColumn: 1, endLineNumber: end, endColumn: model.getLineMaxColumn(end) });
			this.delegate.ask(file.path, selection.startLineNumber, end, code);
			return;
		}
		const hunks = parseUnifiedPatch(file.patch ?? '');
		const first = hunks[0];
		const last = hunks[hunks.length - 1];
		this.delegate.ask(file.path, first ? Math.max(1, first.newStart) : 1, last ? Math.max(1, last.newStart + last.newLines - 1) : 1, file.patch ?? '');
	}

	private createLabel(element: HTMLElement): IResourceLabel {
		const label = this.instantiationService.createInstance(ResourceLabel, element, {});
		let current: URI | undefined;
		element.style.cursor = 'pointer';
		const click = addDisposableListener(element, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if (current) {
				this.delegate.openFile(current.path.replace(/^\//, ''));
			}
		});
		return {
			setUri(uri, options = {}) {
				current = uri;
				if (!uri) {
					label.element.clear();
				} else {
					label.element.setFile(uri, { strikethrough: options.strikethrough });
				}
			},
			dispose() {
				click.dispose();
				label.dispose();
			},
		};
	}
}
