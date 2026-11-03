/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow, safeIntl } from '../../../../../base/common/date.js';
import { language } from '../../../../../base/common/platform.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, dirname, relativePath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { DEFAULT_LABELS_CONTAINER, ResourceLabels } from '../../../../browser/labels.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ISCMHistoryItem, ISCMHistoryItemChange } from '../../../scm/common/history.js';
import { ISCMRepository } from '../../../scm/common/scm.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { createAgentScrollable } from '../editor/agentScrollable.js';
import { createAgentMark } from './gitGraphIcons.js';
import { IGitGraphCommitRow } from './gitGraphModel.js';
import { GitGraphAgentAction } from './gitGraphPrompts.js';
import { paintRefChip, renderAvatar } from './gitGraphRenderers.js';

/** What the inspector asks of the editor around it. */
export interface IGitGraphInspectorHost {
	revealCommit(id: string): void;
	openCommitChanges(row: IGitGraphCommitRow): void;
	compare(newer: IGitGraphCommitRow, older: IGitGraphCommitRow): void;
	askAgent(action: GitGraphAgentAction, row: IGitGraphCommitRow): void;
	showCommitMenu(row: IGitGraphCommitRow, anchor: HTMLElement | StandardMouseEvent): void;
	close(): void;
}

/** Files past this many render behind "Show all", so a 5,000-file commit stays quick. */
const FILES_SHOWN = 300;

/**
 * The selected commit beside the graph: who and when, which agent (from its trailers), the full
 * message, refs, parents, stats, and its files; a file opens its diff in the native diff editor.
 * Two selected commits show a compare panel instead.
 */
export class GitGraphInspector extends Disposable {

	readonly element: HTMLElement;
	private readonly content: HTMLElement;
	private readonly scroll: DomScrollableElement;
	private readonly render = this._register(new DisposableStore());
	private readonly filesRequest = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly labels: ResourceLabels;
	private readonly dateFormat = safeIntl.DateTimeFormat(language, { dateStyle: 'full', timeStyle: 'short' });
	private shownId: string | undefined;

	constructor(
		parent: HTMLElement,
		private readonly host: IGitGraphInspectorHost,
		@IInstantiationService instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this.element = append(parent, $('.vgg-inspector'));
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('voltGitGraph.inspector', "Commit details"));
		this.content = $('.vgg-inspector-content');
		this.scroll = this._register(createAgentScrollable(this.content));
		this.element.appendChild(this.scroll.getDomNode());
		this.labels = this._register(instantiationService.createInstance(ResourceLabels, DEFAULT_LABELS_CONTAINER));
	}

	get commitId(): string | undefined {
		return this.shownId;
	}

	layout(): void {
		this.scroll.scanDomNode();
	}

	clear(): void {
		this.shownId = undefined;
		this.render.clear();
		this.filesRequest.clear();
		this.labels.clear();
		this.content.replaceChildren();
		this.scroll.scanDomNode();
	}

	showCompare(newer: IGitGraphCommitRow, older: IGitGraphCommitRow): void {
		this.clear();
		const store = this.render;
		this.header(localize('voltGitGraph.compareTitle', "Compare commits"));
		const body = append(this.content, $('.vgg-section'));
		for (const row of [newer, older]) {
			const item = row.vm.historyItem;
			const line = append(body, $('button.vgg-compare-row')) as HTMLButtonElement;
			line.type = 'button';
			append(line, $('span.vgg-sha-pill')).textContent = item.displayId ?? item.id.slice(0, 7);
			append(line, $('span.vgg-compare-subject')).textContent = item.subject;
			store.add(addDisposableListener(line, EventType.CLICK, () => this.host.revealCommit(item.id)));
		}
		const actions = append(this.content, $('.vgg-actions'));
		const compare = store.add(createVoltButton(actions, 'secondary', { supportIcons: true }));
		compare.element.classList.add('vgg-btn');
		compare.label = `$(diff-multiple) ${localize('voltGitGraph.compareOpen', "Open Changes Between")}`;
		store.add(compare.onDidClick(() => this.host.compare(newer, older)));
		this.scroll.scanDomNode();
	}

	showCommit(repository: ISCMRepository, row: IGitGraphCommitRow): void {
		const item = row.vm.historyItem;
		if (this.shownId === item.id) {
			return;
		}
		this.clear();
		this.shownId = item.id;
		const store = this.render;

		// Who and when.
		const head = append(this.content, $('.vgg-inspector-head'));
		const avatar = append(head, $('span.vgg-avatar.large'));
		renderAvatar(avatar, item.author ?? '', item.authorEmail, item.authorIcon, 28);
		const who = append(head, $('.vgg-who'));
		append(who, $('.vgg-who-name')).textContent = item.author ?? localize('voltGitGraph.unknownAuthor', "Unknown author");
		const when = append(who, $('.vgg-who-when'));
		if (item.timestamp) {
			when.textContent = fromNow(item.timestamp, true, true);
			store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), when, this.dateFormat.value.format(item.timestamp)));
		}
		if (item.authorEmail) {
			append(who, $('.vgg-who-email')).textContent = item.authorEmail;
		}
		// Git's commit menu (checkout, branch, tag, cherry-pick, revert, copy) and close, top right.
		const more = append(head, $('button.vgg-icon-button')) as HTMLButtonElement;
		more.type = 'button';
		more.setAttribute('aria-label', localize('voltGitGraph.more', "More Actions"));
		more.appendChild(renderIcon(Codicon.ellipsis));
		store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), more, localize('voltGitGraph.more', "More Actions")));
		store.add(addDisposableListener(more, EventType.CLICK, () => this.host.showCommitMenu(row, more)));
		const close = append(head, $('button.vgg-icon-button')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('voltGitGraph.closeInspector', "Close details"));
		close.appendChild(renderIcon(Codicon.close));
		store.add(addDisposableListener(close, EventType.CLICK, () => this.host.close()));

		// Actions, right under the header so a long message never pushes them out of sight.
		// Three equal buttons of one weight, side by side across the inspector.
		const actions = append(this.content, $('.vgg-actions.vgg-commit-actions'));
		const button = (icon: ThemeIcon, label: string, run: () => void, tooltip: string) => {
			const b = store.add(createVoltButton(actions, 'secondary', { supportIcons: true, ariaLabel: tooltip, title: tooltip }));
			b.element.classList.add('vgg-btn', 'vgg-action');
			b.label = `$(${icon.id}) ${label}`;
			store.add(b.onDidClick(run));
			return b;
		};
		button(Codicon.diffMultiple, localize('voltGitGraph.openChanges', "Open Changes"), () => this.host.openCommitChanges(row),
			localize('voltGitGraph.openChangesHover', "Every file's diff in this commit"));
		button(Codicon.sparkle, localize('voltGitGraph.explain', "Explain"), () => this.host.askAgent('explain', row),
			localize('voltGitGraph.explainHover', "A side chat describes this commit like a pull request: files, summary, hunk by hunk"));
		button(Codicon.checklist, localize('voltGitGraph.review', "Review"), () => this.host.askAgent('review', row),
			localize('voltGitGraph.reviewHover', "A side chat reviews this commit: findings with file and line evidence, and tests to run"));

		// Message: the body folds after a few lines.
		const message = append(this.content, $('.vgg-message-full'));
		append(message, $('.vgg-message-subject')).textContent = item.subject;
		const body = messageBody(item);
		if (body) {
			const bodyElement = append(message, $('.vgg-message-body'));
			bodyElement.textContent = body;
			if (body.length > 360 || body.split('\n').length > 7) {
				bodyElement.classList.add('folded');
				const toggle = append(message, $('button.vgg-show-all')) as HTMLButtonElement;
				toggle.type = 'button';
				toggle.textContent = localize('voltGitGraph.showMore', "Show more");
				store.add(addDisposableListener(toggle, EventType.CLICK, () => {
					const folded = bodyElement.classList.toggle('folded');
					toggle.textContent = folded ? localize('voltGitGraph.showMore', "Show more") : localize('voltGitGraph.showLess', "Show less");
					this.scroll.scanDomNode();
				}));
			}
		}

		// Details, label / value rows: commit, parents, agents (from trailers only), refs.
		const details = append(this.content, $('.vgg-details'));
		const detail = (label: string) => {
			append(details, $('.vgg-detail-label')).textContent = label;
			return append(details, $('.vgg-detail-value'));
		};
		const sha = append(detail(localize('voltGitGraph.commit', "Commit")), $('button.vgg-sha-pill')) as HTMLButtonElement;
		sha.type = 'button';
		append(sha, $('span')).textContent = item.displayId ?? item.id.slice(0, 7);
		const shaIcon = append(sha, $('span.vgg-sha-pill-icon'));
		shaIcon.appendChild(renderIcon(Codicon.copy));
		store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), sha, localize('voltGitGraph.copySha', "Copy {0}", item.id)));
		store.add(addDisposableListener(sha, EventType.CLICK, () => {
			void this.clipboardService.writeText(item.id);
			shaIcon.replaceChildren(renderIcon(Codicon.check));
			sha.classList.add('copied');
		}));
		if (item.parentIds.length) {
			const parents = detail(item.parentIds.length > 1 ? localize('voltGitGraph.parents', "Parents") : localize('voltGitGraph.parent', "Parent"));
			for (const parent of item.parentIds) {
				const link = append(parents, $('button.vgg-sha-link')) as HTMLButtonElement;
				link.type = 'button';
				link.textContent = parent.slice(0, (item.displayId ?? '').length || 7);
				store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), link, localize('voltGitGraph.goToParent', "Go to {0}", parent)));
				store.add(addDisposableListener(link, EventType.CLICK, () => this.host.revealCommit(parent)));
			}
		}
		if (row.agents.length) {
			const agents = detail(localize('voltGitGraph.writtenWithLabel', "Written with"));
			for (const agent of row.agents) {
				const chip = append(agents, $('span.vgg-agent-chip'));
				chip.appendChild(createAgentMark(agent.id, 12));
				append(chip, $('span')).textContent = agent.name;
				store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), chip,
					localize('voltGitGraph.agentEvidence', "From the commit's trailer: {0}", agent.evidence)));
			}
		}
		if (item.references?.length) {
			const refs = detail(localize('voltGitGraph.refs', "Refs"));
			for (const ref of item.references) {
				paintRefChip(append(refs, $('span.vgg-ref-chip.static')), ref);
			}
		}

		// Stats and files.
		const filesSection = append(this.content, $('.vgg-section'));
		const filesTitle = append(filesSection, $('.vgg-section-title'));
		const stats = item.statistics;
		append(filesTitle, $('span')).textContent = stats
			? (stats.files === 1 ? localize('voltGitGraph.oneFile', "1 file changed") : localize('voltGitGraph.files', "{0} files changed", stats.files))
			: localize('voltGitGraph.filesTitle', "Files");
		if (stats?.insertions) {
			append(filesTitle, $('span.vgg-added')).textContent = `+${stats.insertions}`;
		}
		if (stats?.deletions) {
			// allow-any-unicode-next-line
			append(filesTitle, $('span.vgg-removed')).textContent = `−${stats.deletions}`;
		}
		// show-file-icons: the file icon theme only draws inside it.
		const list = append(filesSection, $('.vgg-files-list.show-file-icons'));
		append(list, $('.vgg-files-loading')).textContent = localize('voltGitGraph.filesLoading', "Loading files…");
		this.scroll.scanDomNode();
		void this.loadFiles(repository, row, list);
	}

	private async loadFiles(repository: ISCMRepository, row: IGitGraphCommitRow, list: HTMLElement): Promise<void> {
		const item = row.vm.historyItem;
		const history = repository.provider.historyProvider.get();
		const source = new CancellationTokenSource();
		this.filesRequest.value = source;
		let changes: ISCMHistoryItemChange[] = [];
		try {
			changes = await history?.provideHistoryItemChanges(item.id, item.parentIds[0], source.token) ?? [];
		} catch {
			// Shown as empty below.
		}
		if (source.token.isCancellationRequested || this.shownId !== item.id) {
			return;
		}
		list.replaceChildren();
		if (!changes.length) {
			append(list, $('.vgg-files-loading')).textContent = localize('voltGitGraph.noFiles', "No file changes");
			this.scroll.scanDomNode();
			return;
		}
		const root = repository.provider.rootUri;
		const draw = (from: number, to: number) => {
			for (const change of changes.slice(from, to)) {
				this.renderFile(list, root, item, change);
			}
		};
		draw(0, FILES_SHOWN);
		if (changes.length > FILES_SHOWN) {
			const all = append(list, $('button.vgg-show-all')) as HTMLButtonElement;
			all.type = 'button';
			all.textContent = localize('voltGitGraph.showAllFiles', "Show all {0} files", changes.length);
			this.render.add(addDisposableListener(all, EventType.CLICK, () => {
				all.remove();
				draw(FILES_SHOWN, changes.length);
				this.scroll.scanDomNode();
			}));
		}
		this.scroll.scanDomNode();
	}

	private renderFile(list: HTMLElement, root: URI | undefined, item: ISCMHistoryItem, change: ISCMHistoryItemChange): void {
		const status = !change.originalUri ? 'A' : !change.modifiedUri ? 'D' : 'M';
		const row = append(list, $('button.vgg-file')) as HTMLButtonElement;
		row.type = 'button';
		const labelHost = append(row, $('span.vgg-file-label'));
		const label = this.labels.create(labelHost, { supportIcons: true });
		const dir = dirname(change.uri);
		const relativeDir = root ? relativePath(root, dir) : undefined;
		label.setResource({ resource: change.uri, name: basename(change.uri), description: relativeDir || undefined }, { fileKind: FileKind.FILE });
		const badge = append(row, $(`span.vgg-file-status.status-${status}`));
		badge.textContent = status;
		this.render.add(addDisposableListener(row, EventType.CLICK, () => void this.openFile(item, change)));
	}

	/** The file's diff in the native diff editor, titled like the SCM graph's: `file (parent) ↔ file (commit)`. */
	private async openFile(item: ISCMHistoryItem, change: ISCMHistoryItemChange): Promise<void> {
		const id = item.displayId ?? item.id.slice(0, 7);
		const parent = item.parentIds[0]?.slice(0, id.length);
		if (change.originalUri && change.modifiedUri) {
			await this.editorService.openEditor({
				label: `${basename(change.modifiedUri)} (${parent} ↔ ${id})`,
				original: { resource: change.originalUri },
				modified: { resource: change.modifiedUri },
				options: { preserveFocus: true },
			});
		} else {
			const resource = change.modifiedUri ?? change.originalUri;
			if (resource) {
				await this.editorService.openEditor({
					resource,
					label: change.modifiedUri
						? localize('voltGitGraph.addedIn', "{0} (Added in {1})", basename(resource), id)
						: localize('voltGitGraph.deletedIn', "{0} (Deleted in {1})", basename(resource), id),
					options: { preserveFocus: true },
				});
			}
		}
	}

	private header(text: string): void {
		const head = append(this.content, $('.vgg-inspector-head.title'));
		append(head, $('.vgg-who-name')).textContent = text;
		const close = append(head, $('button.vgg-icon-button')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('voltGitGraph.closeInspector', "Close details"));
		close.appendChild(renderIcon(Codicon.close));
		this.render.add(addDisposableListener(close, EventType.CLICK, () => this.host.close()));
	}
}

/** The message past its subject line, trailers included (they are part of what was committed). */
function messageBody(item: ISCMHistoryItem): string {
	const message = item.message ?? '';
	const subjectEnd = message.indexOf('\n');
	return subjectEnd === -1 ? '' : message.slice(subjectEnd + 1).trim();
}
