/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentCommitPlan.css';
import { $, addDisposableListener, append, EventHelper, EventType } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IIdentityProvider, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { TriStateCheckbox } from '../../../../../base/browser/ui/toggle/toggle.js';
import { ITreeElement, ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, dirname } from '../../../../../base/common/path.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelContentProvider } from '../../../../../editor/common/services/resolverService.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { IVoltGitService } from '../../../../../platform/voltGit/common/voltGit.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { defaultCheckboxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IVoltGitStatusFile } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { ResourceLabels } from '../../../../browser/labels.js';
import { EditorsOrder } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { MultiDiffEditorInput } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';
import { IMultiDiffSourceResolver, IResolvedMultiDiffSource, MultiDiffEditorItem } from '../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { splitCommitMessage } from '../../common/agentCommitPlan.js';
import { AgentTooltip, IAgentTooltipRow, setAgentTooltip } from '../chrome/agentTooltip.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { IAgentComposerTerminalRuns } from '../composer/agentComposerChips.js';
import { IAgentCommitPlan, IAgentCommitPlanService, IAgentPlannedCommit } from './agentCommitPlanService.js';

const ROW_HEIGHT = 24;
/** The tree scrolls past this many rows; the tray never pushes the composer off the window. */
const MAX_TREE_ROWS = 11;

interface ICommitNode {
	readonly kind: 'commit';
	readonly plan: IAgentCommitPlan;
	readonly commit: IAgentPlannedCommit;
	readonly number: number;
}

interface IFolderNode {
	readonly kind: 'folder';
	readonly plan: IAgentCommitPlan;
	readonly commit: IAgentPlannedCommit;
	readonly path: string;
	readonly label: string;
	/** Every file under it, for its checkbox. */
	readonly files: readonly string[];
}

interface IFileNode {
	readonly kind: 'file';
	readonly plan: IAgentCommitPlan;
	readonly commit: IAgentPlannedCommit;
	readonly path: string;
	readonly file: IVoltGitStatusFile | undefined;
	/** Shown as a list, not a tree: the row names its folder. */
	readonly flat?: boolean;
}

type CommitPlanNode = ICommitNode | IFolderNode | IFileNode;

function included(commit: IAgentPlannedCommit, paths: readonly string[]): boolean | 'partial' {
	const left = paths.filter(path => !commit.excluded.has(path)).length;
	return left === paths.length ? true : left === 0 ? false : 'partial';
}

function stats(plan: IAgentCommitPlan, paths: readonly string[]): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const path of paths) {
		const file = plan.files.get(path);
		additions += file?.additions ?? 0;
		deletions += file?.deletions ?? 0;
	}
	return { additions, deletions };
}

function renderStats(element: HTMLElement, value: { additions: number; deletions: number }): void {
	element.replaceChildren();
	if (value.additions) {
		append(element, $('span.add')).textContent = `+${value.additions}`;
	}
	if (value.deletions) {
		append(element, $('span.del')).textContent = `-${value.deletions}`;
	}
}

/** A commit's files as folders and files, folders first; a folder holding only one folder shares its row. */
function fileTree(plan: IAgentCommitPlan, commit: IAgentPlannedCommit): ITreeElement<CommitPlanNode>[] {
	interface IEntries { readonly folders: Map<string, IEntries>; readonly files: string[] }
	const top: IEntries = { folders: new Map(), files: [] };
	for (const path of commit.paths) {
		let folder = top;
		for (const part of path.split('/').slice(0, -1)) {
			let next = folder.folders.get(part);
			if (!next) {
				next = { folders: new Map(), files: [] };
				folder.folders.set(part, next);
			}
			folder = next;
		}
		folder.files.push(path);
	}
	const all = (entries: IEntries): string[] => [...entries.files, ...[...entries.folders.values()].flatMap(all)];
	const build = (entries: IEntries, prefix: string): ITreeElement<CommitPlanNode>[] => {
		const folders = [...entries.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]): ITreeElement<CommitPlanNode> => {
			let label = name;
			let current = child;
			while (current.files.length === 0 && current.folders.size === 1) {
				const [nextName, next] = [...current.folders][0];
				label = `${label}/${nextName}`;
				current = next;
			}
			const path = prefix ? `${prefix}/${label}` : label;
			return {
				element: { kind: 'folder', plan, commit, path, label, files: all(current) },
				children: build(current, path),
				collapsed: false,
			};
		});
		const files = [...entries.files].sort((a, b) => basename(a).localeCompare(basename(b))).map((path): ITreeElement<CommitPlanNode> => ({
			element: { kind: 'file', plan, commit, path, file: plan.files.get(path) },
		}));
		return [...folders, ...files];
	};
	return build(top, '');
}

/** A commit's files as one list by path, each row naming its folder (View as List). */
function fileList(plan: IAgentCommitPlan, commit: IAgentPlannedCommit): ITreeElement<CommitPlanNode>[] {
	return [...commit.paths].sort((a, b) => a.localeCompare(b)).map((path): ITreeElement<CommitPlanNode> => ({
		element: { kind: 'file', plan, commit, path, file: plan.files.get(path), flat: true },
	}));
}

interface ITrayHost {
	toggle(node: CommitPlanNode, value: boolean): void;
	regenerate(node: ICommitNode): void;
	edit(node: ICommitNode): void;
	openChanges(node: ICommitNode): void;
	readonly tooltip: AgentTooltip;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A 24-unit outline icon drawn at 16px; the 1.5 stroke reads as a 1px line at that size. */
function outlineIcon(doc: Document, d: string, linecap: 'round' | 'square'): SVGElement {
	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.classList.add('volt-commit-plan-svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = doc.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', d);
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.5');
	path.setAttribute('stroke-linecap', linecap);
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	return svg;
}

/** The composer's Stop square (agentEditor.ts createStopIcon). */
function stopIcon(doc: Document): SVGElement {
	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 384 512');
	svg.setAttribute('aria-hidden', 'true');
	const path = doc.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', 'M0 128c0-35.3 28.7-64 64-64h256c35.3 0 64 28.7 64 64v256c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64z');
	path.setAttribute('fill', 'currentColor');
	svg.appendChild(path);
	return svg;
}

/** Commit's icon: two commits and the line joining them. */
function commitIcon(doc: Document): SVGElement {
	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.classList.add('volt-commit-plan-svg', 'volt-commit-plan-commit-icon');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1.2');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	for (const [cx, cy] of [[18, 18], [6, 6]]) {
		const circle = doc.createElementNS(SVG_NS, 'circle');
		circle.setAttribute('cx', String(cx));
		circle.setAttribute('cy', String(cy));
		circle.setAttribute('r', '3');
		svg.appendChild(circle);
	}
	const path = doc.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', 'M6 21V9a9 9 0 0 0 9 9');
	svg.appendChild(path);
	return svg;
}

const SPARKLE_PATH = 'M3 12C7.97053 12 12 7.97053 12 3C12 7.97053 16.0295 12 21 12C16.0295 12 12 16.0295 12 21C12 16.0295 7.97053 12 3 12Z';
const RENAME_PATH = 'M16.5 3v18m0-18H14m2.5 0H19m-2.5 18H19m-2.5 0H14M11 7H1v10h10M22 7h1v10h-1M5 12h4';

/** Colours come from the stylesheet (agentCommitPlan.css), not the widget's inline styles. */
const CHECKBOX_STYLES = {
	...defaultCheckboxStyles,
	checkboxBackground: undefined,
	checkboxBorder: undefined,
	checkboxForeground: undefined,
	checkboxDisabledBackground: undefined,
	checkboxDisabledForeground: undefined,
	size: 14,
};

/** The checkbox at the start of every row: a click toggles it, never the row. */
function createCheckbox(row: HTMLElement, store: DisposableStore, onChange: (checked: boolean) => void): TriStateCheckbox {
	const checkbox = store.add(new TriStateCheckbox('', false, CHECKBOX_STYLES));
	const slot = append(row, $('span.volt-commit-plan-check'));
	slot.appendChild(checkbox.domNode);
	for (const type of [EventType.MOUSE_DOWN, EventType.CLICK, EventType.DBLCLICK]) {
		store.add(addDisposableListener(checkbox.domNode, type, e => e.stopPropagation()));
	}
	store.add(checkbox.onChange(() => onChange(checkbox.checked === true)));
	return checkbox;
}

interface ICommitTemplate {
	readonly row: HTMLElement;
	readonly checkbox: TriStateCheckbox;
	readonly message: HTMLElement;
	readonly description: HTMLElement;
	readonly regenerate: HTMLElement;
	readonly edit: HTMLElement;
	readonly stats: HTMLElement;
	readonly store: DisposableStore;
	readonly hover: MutableDisposable<DisposableStore>;
	/** The row's element while it is rendered (the template's listeners read it). */
	readonly ref: { current?: ICommitNode };
}

class CommitRenderer implements ITreeRenderer<CommitPlanNode, void, ICommitTemplate> {
	static readonly ID = 'commit';
	readonly templateId = CommitRenderer.ID;

	constructor(private readonly host: ITrayHost) { }

	renderTemplate(container: HTMLElement): ICommitTemplate {
		const store = new DisposableStore();
		const ref: ICommitTemplate['ref'] = {};
		const row = append(container, $('.volt-commit-plan-row.commit'));
		const checkbox = createCheckbox(row, store, checked => ref.current && this.host.toggle(ref.current, checked));
		append(row, $('span.volt-commit-plan-icon')).appendChild(renderIcon(Codicon.gitCommit));
		const message = append(row, $('span.volt-commit-plan-message'));
		const description = append(row, $('span.volt-commit-plan-description'));
		const actions = append(row, $('span.volt-commit-plan-actions'));
		const action = (icon: () => Element, label: string, run: (node: ICommitNode) => void) => {
			const button = append(actions, $('span.volt-commit-plan-action')) as HTMLElement;
			button.setAttribute('role', 'button');
			button.tabIndex = 0;
			button.setAttribute('aria-label', label);
			button.appendChild(icon());
			setAgentTooltip(button, label);
			const fire = (e: MouseEvent | KeyboardEvent) => {
				EventHelper.stop(e, true);
				if (ref.current && !ref.current.plan.busy) {
					run(ref.current);
				}
			};
			store.add(addDisposableListener(button, EventType.MOUSE_DOWN, e => e.stopPropagation()));
			store.add(addDisposableListener(button, EventType.CLICK, fire));
			store.add(addDisposableListener(button, EventType.KEY_DOWN, e => {
				if (e.key === 'Enter' || e.key === ' ') {
					fire(e);
				}
			}));
			return button;
		};
		const doc = row.ownerDocument;
		const regenerate = action(() => outlineIcon(doc, SPARKLE_PATH, 'round'), localize('voltCommitPlan.regenerate', "Regenerate commit message"), node => this.host.regenerate(node));
		const edit = action(() => outlineIcon(doc, RENAME_PATH, 'square'), localize('voltCommitPlan.editMessage', "Edit commit message"), node => this.host.edit(node));
		action(() => renderIcon(Codicon.diffMultiple), localize('voltCommitPlan.openChanges', "Open Changes"), node => this.host.openChanges(node));
		const statsEl = append(row, $('span.volt-commit-plan-stats'));
		return { row, checkbox, message, description, regenerate, edit, stats: statsEl, store, hover: store.add(new MutableDisposable<DisposableStore>()), ref };
	}

	renderElement(node: ITreeNode<CommitPlanNode, void>, _index: number, template: ICommitTemplate): void {
		const element = node.element;
		if (element.kind !== 'commit') {
			return;
		}
		template.ref.current = element;
		const { plan, commit } = element;
		const { subject, body } = splitCommitMessage(commit.message);
		const state = included(commit, commit.paths);
		template.checkbox.checked = state;
		template.checkbox.domNode.classList.toggle('partial', state === 'partial');
		template.checkbox.setTitle(commit.leftover ? localize('voltCommitPlan.includeLeftover', "Commit these files too") : localize('voltCommitPlan.include', "Include this commit"));
		template.row.classList.toggle('leftover', commit.leftover);
		template.row.classList.toggle('excluded', included(commit, commit.paths) === false);
		template.row.classList.toggle('generating', commit.generating);
		template.message.textContent = commit.generating
			? localize('voltCommitPlan.writing', "Writing a commit message…")
			: subject || (commit.leftover ? localize('voltCommitPlan.leftover', "Not in any commit") : localize('voltCommitPlan.noMessage', "No message"));
		template.message.classList.toggle('placeholder', !subject || commit.generating);
		const count = commit.paths.length;
		template.description.textContent = commit.leftover
			? localize('voltCommitPlan.leftoverFiles', "{0} files left out", count)
			: count === 1 ? localize('voltCommitPlan.oneFile', "1 file") : localize('voltCommitPlan.files', "{0} files", count);
		template.regenerate.replaceChildren(commit.generating ? renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')) : outlineIcon(template.row.ownerDocument, SPARKLE_PATH, 'round'));
		template.regenerate.classList.toggle('busy', commit.generating);
		template.edit.classList.toggle('hidden', commit.generating);
		renderStats(template.stats, stats(plan, commit.paths.filter(path => !commit.excluded.has(path))));
		// The whole message in a card that stays while the pointer reads or scrolls it.
		const hover = new DisposableStore();
		template.hover.value = hover;
		if (subject && !commit.generating) {
			hover.add(this.host.tooltip.bind(template.message, () => {
				const rows: IAgentTooltipRow[] = [{ label: subject, body: true }];
				if (body) {
					rows.push({ label: body, body: true, separator: true });
				}
				rows.push({ label: localize('voltCommitPlan.commitNumber', "Commit {0} of {1} · {2}", element.number, plan.commits.filter(item => !item.leftover).length, template.description.textContent ?? ''), icon: Codicon.gitCommit, muted: true, separator: true });
				return rows;
			}, { placement: 'above', variant: 'card', delay: 350, interactive: true }));
		}
	}

	disposeElement(_node: ITreeNode<CommitPlanNode, void>, _index: number, template: ICommitTemplate): void {
		template.ref.current = undefined;
		template.hover.clear();
	}

	disposeTemplate(template: ICommitTemplate): void {
		template.store.dispose();
	}
}

interface IFileTemplate {
	readonly row: HTMLElement;
	readonly checkbox: TriStateCheckbox;
	readonly label: ReturnType<ResourceLabels['create']>;
	readonly status: HTMLElement;
	readonly hunks: HTMLElement;
	readonly stats: HTMLElement;
	readonly store: DisposableStore;
	readonly ref: { current?: IFolderNode | IFileNode };
}

/** Folder and file rows: a checkbox, the name with its icon, and the line counts. */
class FileRenderer implements ITreeRenderer<CommitPlanNode, void, IFileTemplate> {
	static readonly ID = 'file';
	readonly templateId = FileRenderer.ID;

	constructor(private readonly host: ITrayHost, private readonly labels: ResourceLabels) { }

	renderTemplate(container: HTMLElement): IFileTemplate {
		const store = new DisposableStore();
		const ref: IFileTemplate['ref'] = {};
		const row = append(container, $('.volt-commit-plan-row.file'));
		const checkbox = createCheckbox(row, store, checked => ref.current && this.host.toggle(ref.current, checked));
		const label = store.add(this.labels.create(append(row, $('.volt-commit-plan-file-label')), { supportHighlights: false, supportIcons: true }));
		const status = append(row, $('span.volt-commit-plan-status'));
		const statsEl = append(row, $('span.volt-commit-plan-stats'));
		const hunks = append(row, $('span.volt-commit-plan-hunks'));
		return { row, checkbox, label, status, hunks, stats: statsEl, store, ref };
	}

	renderElement(node: ITreeNode<CommitPlanNode, void>, _index: number, template: IFileTemplate): void {
		const element = node.element;
		if (element.kind === 'commit') {
			return;
		}
		template.ref.current = element;
		const root = URI.file(element.plan.root);
		const paths = element.kind === 'folder' ? element.files : [element.path];
		const state = included(element.commit, paths);
		template.checkbox.checked = state;
		template.checkbox.domNode.classList.toggle('partial', state === 'partial');
		template.checkbox.setTitle(element.kind === 'folder' ? localize('voltCommitPlan.includeFolder', "Include this folder") : localize('voltCommitPlan.includeFile', "Include this file"));
		template.row.classList.toggle('excluded', state === false);
		if (element.kind === 'folder') {
			template.label.setResource({ resource: URI.joinPath(root, element.path), name: element.label }, { fileKind: FileKind.FOLDER });
			template.status.textContent = '';
			template.hunks.textContent = '';
			renderStats(template.stats, { additions: 0, deletions: 0 });
			return;
		}
		const file = element.file;
		const folder = element.flat ? dirname(element.path) : '.';
		template.label.setResource({ resource: URI.joinPath(root, element.path), name: basename(element.path), description: folder === '.' ? undefined : folder }, {
			fileKind: FileKind.FILE,
			strikethrough: file?.status === 'deleted',
			title: file?.previousPath ? `${file.previousPath} → ${element.path}` : element.path,
		});
		template.status.textContent = statusLetter(file);
		template.status.className = `volt-commit-plan-status status-${file?.status ?? 'modified'}`;
		const split: readonly number[] | undefined = element.commit.parts[element.path];
		template.hunks.textContent = split ? localize('voltCommitPlan.hunkCount', "{0} of {1} hunks", split.length, element.plan.hunks.get(element.path)?.length ?? split.length) : '';
		renderStats(template.stats, { additions: file?.additions ?? 0, deletions: file?.deletions ?? 0 });
	}

	disposeElement(_node: ITreeNode<CommitPlanNode, void>, _index: number, template: IFileTemplate): void {
		template.ref.current = undefined;
	}

	disposeTemplate(template: IFileTemplate): void {
		template.store.dispose();
	}
}

function statusLetter(file: IVoltGitStatusFile | undefined): string {
	switch (file?.status) {
		case 'added': return 'A';
		case 'untracked': return 'U';
		case 'deleted': return 'D';
		case 'renamed': return 'R';
		case 'conflicted': return '!';
		default: return 'M';
	}
}

/** A file as HEAD has it, read by Volt's own git: the Git extension may not have the worktree open, or not run. */
export const COMMIT_PLAN_HEAD_SCHEME = 'volt-commit-head';

/** The file's HEAD version. Its path is the working tree file's, so the diff does not read it as a rename. */
function headUri(root: string, path: string): URI {
	return URI.from({
		scheme: COMMIT_PLAN_HEAD_SCHEME,
		path: URI.joinPath(URI.file(root), path).path,
		query: new URLSearchParams({ repo: root, file: path }).toString(),
	});
}

export class CommitPlanHeadContentProvider implements ITextModelContentProvider {

	constructor(
		@IVoltGitService private readonly git: IVoltGitService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) { }

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const params = new URLSearchParams(resource.query);
		const repoRoot = params.get('repo');
		const path = params.get('file') ?? '';
		const text = repoRoot && path ? (await this.git.readBlob({ repoRoot, sha: `HEAD:${path}`, path }).catch(() => undefined))?.toString() ?? '' : '';
		const existing = this.modelService.getModel(resource);
		if (existing && !existing.isDisposed()) {
			if (existing.getValue() !== text) {
				existing.setValue(text);
			}
			return existing;
		}
		const language = this.languageService.createByFilepathOrFirstLine(URI.file(path || '/file'), text.split(/\r?\n/, 1)[0]);
		return this.modelService.createModel(text, language, resource);
	}
}

/** A file split by hunks as one commit of the plan leaves it: before that commit, or after it. */
export const COMMIT_PLAN_CONTENT_SCHEME = 'volt-commit-content';

function hunkContentUri(planId: string, commitId: string, path: string, side: 'before' | 'after'): URI {
	return URI.from({
		scheme: COMMIT_PLAN_CONTENT_SCHEME,
		path: `/${planId}/${commitId}`,
		query: new URLSearchParams({ file: path, side }).toString(),
	});
}

export class CommitPlanContentProvider extends Disposable implements ITextModelContentProvider {

	constructor(
		@IAgentCommitPlanService private readonly plans: IAgentCommitPlanService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		super();
		this._register(plans.onDidChange(() => this.refresh()));
	}

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const text = this.textOf(resource);
		const existing = this.modelService.getModel(resource);
		if (existing && !existing.isDisposed()) {
			if (existing.getValue() !== text) {
				existing.setValue(text);
			}
			return existing;
		}
		const file = new URLSearchParams(resource.query).get('file') ?? '';
		const language = this.languageService.createByFilepathOrFirstLine(URI.file(file || '/file'), text.split(/\r?\n/, 1)[0]);
		return this.modelService.createModel(text, language, resource);
	}

	private textOf(resource: URI): string {
		const [, planId, commitId] = resource.path.split('/');
		const params = new URLSearchParams(resource.query);
		return this.plans.hunkContent(planId, commitId, params.get('file') ?? '', params.get('side') === 'after' ? 'after' : 'before') ?? '';
	}

	/** Open diffs follow the review: a commit's hunks leave the diff when another commit takes them. */
	private refresh(): void {
		for (const model of this.modelService.getModels()) {
			if (model.uri.scheme === COMMIT_PLAN_CONTENT_SCHEME && !model.isDisposed()) {
				model.setValue(this.textOf(model.uri));
			}
		}
	}
}

export const COMMIT_PLAN_DIFF_SCHEME = 'volt-commit-plan';

/** A commit's diff, or with `file`, that one file's diff alone. */
function commitDiffUri(sessionId: string, commitId: string, file?: string): URI {
	return URI.from({
		scheme: COMMIT_PLAN_DIFF_SCHEME,
		path: `/${sessionId}/${commitId}`,
		query: file === undefined ? undefined : new URLSearchParams({ file }).toString(),
	});
}

function commitDiffItem(plan: IAgentCommitPlan, item: string, commit?: IAgentPlannedCommit): MultiDiffEditorItem {
	const file = plan.files.get(item);
	const uri = URI.joinPath(URI.file(plan.root), item);
	if (commit?.parts[item]) {
		return new MultiDiffEditorItem(hunkContentUri(plan.id, commit.id, item, 'before'), hunkContentUri(plan.id, commit.id, item, 'after'), uri);
	}
	const added = file?.status === 'added' || file?.status === 'untracked';
	return new MultiDiffEditorItem(
		added ? undefined : headUri(plan.root, file?.previousPath ?? item),
		file?.status === 'deleted' ? undefined : uri,
		uri,
	);
}

/** A commit's diff editor follows its checkboxes: the files left in are listed as they change. */
export class CommitPlanDiffSourceResolver extends Disposable implements IMultiDiffSourceResolver {

	private readonly _onDidChange = this._register(new Emitter<void>());

	constructor(@IAgentCommitPlanService private readonly plans: IAgentCommitPlanService) {
		super();
		this._register(plans.onDidChange(() => this._onDidChange.fire()));
	}

	canHandleUri(uri: URI): boolean {
		return uri.scheme === COMMIT_PLAN_DIFF_SCHEME;
	}

	async resolveDiffSource(uri: URI): Promise<IResolvedMultiDiffSource> {
		const [, sessionId, commitId] = uri.path.split('/');
		const file = new URLSearchParams(uri.query).get('file') ?? undefined;
		const plans = this.plans;
		return {
			resources: {
				onDidChange: this._onDidChange.event,
				get value(): readonly MultiDiffEditorItem[] {
					const plan = plans.pending(sessionId);
					if (!plan) {
						return [];
					}
					if (file !== undefined) {
						return plan.files.has(file) ? [commitDiffItem(plan, file, plan.commits.find(item => item.id === commitId))] : [];
					}
					const commit = plan.commits.find(item => item.id === commitId);
					return commit ? commit.paths.filter(item => !commit.excluded.has(item)).map(item => commitDiffItem(plan, item, commit)) : [];
				},
			},
		};
	}
}

const VIEW_AS_TREE_KEY = 'volt.commitPlan.viewAsTree';

/** An icon-only header button: the icon, and its name as the hover and for screen readers. */
function setIconButton(button: Button, icon: ThemeIcon, label: string): void {
	button.label = `$(${icon.id})`;
	button.setTitle(label);
	button.element.setAttribute('aria-label', label);
}

export interface IAgentCommitPlanTrayOptions {
	/** The tray changed height; the composer relayouts. */
	onLayout(): void;
}

/**
 * The commits an agent proposed (propose_commits), docked above the composer until the user
 * commits or closes them: each commit's message (the whole of it on hover), its files as a tree
 * that opens their diffs, checkboxes to leave commits, folders or files out, Regenerate and Edit
 * for the message, then Commit. A solid card over the thread, like the question tray.
 */
export class AgentCommitPlanTray extends Disposable {

	readonly element: HTMLElement;

	private sessionId: string | undefined;
	private plan: IAgentCommitPlan | undefined;
	private editing: string | undefined;
	private readonly title: HTMLElement;
	private readonly summary: HTMLElement;
	private readonly editor: HTMLElement;
	private readonly editorLabel: HTMLElement;
	private readonly editorArea: HTMLTextAreaElement;
	private readonly treeHost: HTMLElement;
	private readonly tree: WorkbenchObjectTree<CommitPlanNode, void>;
	private readonly status: HTMLElement;
	private readonly errorRow: HTMLElement;
	private readonly viewButton;
	private readonly collapseButton;
	private readonly minimizeButton;
	private readonly cancelButton;
	private readonly commitButton;
	private readonly stopButton: HTMLButtonElement;
	private readonly chip: HTMLButtonElement;
	private readonly chipCount: HTMLElement;
	private readonly onDidChangeChip = this._register(new Emitter<void>());
	/** The review shrunk to a chip, for the row above the composer (AgentComposerChips). */
	readonly rowChip: IAgentComposerTerminalRuns;
	private readonly tooltip = this._register(new AgentTooltip());
	/** Files as folders (the default) or one list by path; kept for the next review too. */
	private viewAsTree: boolean;
	/** Reviews the user shrank to the "Draft Commits" chip; a new review opens full again. */
	private readonly minimized = new Set<string>();
	private height = 0;

	constructor(
		private readonly options: IAgentCommitPlanTrayOptions,
		@IAgentCommitPlanService private readonly plans: IAgentCommitPlanService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
	) {
		super();
		this.viewAsTree = storageService.getBoolean(VIEW_AS_TREE_KEY, StorageScope.PROFILE, true);
		this.element = $('.volt-commit-plan.hidden');
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('voltCommitPlan.aria', "Review Draft Commits"));

		// Shrunk: a chip in the row above the composer (rowChip); a click opens the review again.
		this.chip = $('button.volt-agent-composer-chip.volt-commit-plan-chip.hidden') as HTMLButtonElement;
		this.chip.type = 'button';
		append(this.chip, $('span.volt-commit-plan-chip-icon')).appendChild(renderIcon(Codicon.gitCommit));
		append(this.chip, $('span.volt-agent-composer-chip-label')).textContent = localize('voltCommitPlan.chip', "Draft Commits");
		this.chipCount = append(this.chip, $('span.volt-commit-plan-chip-count'));
		append(this.chip, $('span.volt-commit-plan-chip-icon')).appendChild(renderIcon(Codicon.chevronUp));
		setAgentTooltip(this.chip, localize('voltCommitPlan.expand', "Show Draft Commits"));
		this._register(addDisposableListener(this.chip, EventType.CLICK, () => this.setMinimized(false)));
		const chip = this.chip;
		this.rowChip = { element: chip, get visible() { return !chip.classList.contains('hidden'); }, onDidChange: this.onDidChangeChip.event };

		// While the agent drafts: the composer's dictation glow, moving along the bottom of the card.
		append(append(this.element, $('.volt-commit-plan-glow')), $('.volt-commit-plan-aurora'));

		const head = append(this.element, $('.volt-commit-plan-head'));
		append(head, $('span.volt-commit-plan-head-icon')).appendChild(renderIcon(Codicon.gitCommit));
		this.title = append(head, $('span.volt-commit-plan-title'));
		this.summary = append(head, $('span.volt-commit-plan-summary'));
		this.status = append(head, $('span.volt-commit-plan-status-text'));
		const headActions = append(head, $('span.volt-commit-plan-head-actions'));
		const tools = append(headActions, $('span.volt-commit-plan-tools'));
		const iconButton = (parent: HTMLElement) => {
			const button = this._register(createVoltButton(parent, 'ghost', { supportIcons: true }));
			button.element.classList.add('volt-commit-plan-tool');
			return button;
		};
		this.viewButton = iconButton(tools);
		this.collapseButton = iconButton(tools);
		setIconButton(this.collapseButton, Codicon.collapseAll, localize('voltCommitPlan.collapseAll', "Collapse All"));
		this.renderViewButton();
		this._register(this.viewButton.onDidClick(() => {
			this.viewAsTree = !this.viewAsTree;
			this.storageService.store(VIEW_AS_TREE_KEY, this.viewAsTree, StorageScope.PROFILE, StorageTarget.USER);
			this.renderViewButton();
			this.render();
		}));
		this._register(this.collapseButton.onDidClick(() => this.tree.collapseAll()));
		this.cancelButton = this._register(createVoltButton(headActions, 'secondary'));
		this.cancelButton.label = localize('voltCommitPlan.dismiss', "Don't Commit");
		this.commitButton = this._register(createVoltButton(headActions, 'primary'));
		// Last in the row, after Commit.
		this.minimizeButton = iconButton(headActions);
		setIconButton(this.minimizeButton, Codicon.chevronDown, localize('voltCommitPlan.minimize', "Minimize"));
		this._register(this.minimizeButton.onDidClick(() => this.setMinimized(true)));
		this._register(this.cancelButton.onDidClick(() => this.plan && this.plans.dismiss(this.plan.id)));
		// Drafting: the composer's round Stop, which stops the agent's turn too.
		this.stopButton = append(headActions, $('button.volt-commit-plan-stop')) as HTMLButtonElement;
		this.stopButton.type = 'button';
		this.stopButton.appendChild(stopIcon(this.element.ownerDocument));
		const stopLabel = localize('voltCommitPlan.stop', "Stop Generating");
		this.stopButton.setAttribute('aria-label', stopLabel);
		setAgentTooltip(this.stopButton, stopLabel);
		this._register(addDisposableListener(this.stopButton, EventType.CLICK, () => {
			const sessionId = this.sessionId;
			if (sessionId) {
				this.plans.cancelDrafting(sessionId);
				void this.orchestrator.cancel(sessionId);
			}
		}));
		// Why the last Commit stopped, under the head and in full: the head has no room for a reason.
		this.errorRow = append(this.element, $('.volt-commit-plan-error.hidden'));
		this.errorRow.setAttribute('role', 'alert');
		this._register(this.commitButton.onDidClick(() => {
			const plan = this.plan;
			if (!plan || plan.busy || !this.commitButton.enabled) {
				return;
			}
			// Off at once: a second click before the service says it is busy commits nothing twice.
			this.commitButton.enabled = false;
			this.cancelButton.enabled = false;
			void this.plans.commit(plan.id, plan.hookFailed ? { skipHooks: true } : undefined);
		}));

		this.editor = append(this.element, $('.volt-commit-plan-editor.hidden'));
		this.editorLabel = append(this.editor, $('.volt-commit-plan-editor-label'));
		this.editorArea = append(this.editor, $('textarea.volt-commit-plan-editor-input')) as HTMLTextAreaElement;
		this.editorArea.rows = 4;
		this.editorArea.setAttribute('aria-label', localize('voltCommitPlan.messageAria', "Commit message"));
		const editorActions = append(this.editor, $('.volt-commit-plan-editor-actions'));
		append(editorActions, $('span.volt-commit-plan-editor-hint')).textContent = localize('voltCommitPlan.editHint', "⌘Enter to save, Esc to cancel");
		const editCancel = this._register(createVoltButton(editorActions, 'ghost'));
		editCancel.label = localize('voltCommitPlan.cancelEdit', "Cancel");
		const editSave = this._register(createVoltButton(editorActions, 'secondary'));
		editSave.label = localize('voltCommitPlan.saveEdit', "Save");
		this._register(editCancel.onDidClick(() => this.stopEditing()));
		this._register(editSave.onDidClick(() => this.saveEdit()));
		this._register(addDisposableListener(this.editorArea, EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				EventHelper.stop(e, true);
				this.stopEditing();
			} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				EventHelper.stop(e, true);
				this.saveEdit();
			}
		}));

		this.treeHost = append(this.element, $('.volt-commit-plan-tree.file-icon-themable-tree.show-file-icons'));
		const labels = this._register(instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility: Event.None }));
		const host: ITrayHost = {
			toggle: (node, value) => this.toggle(node, value),
			regenerate: node => void this.plans.regenerate(node.plan.id, node.commit.id),
			edit: node => this.startEditing(node.commit),
			openChanges: node => void this.openDiff(node.plan, node.commit, undefined, false),
			tooltip: this.tooltip,
		};
		const delegate: IListVirtualDelegate<CommitPlanNode> = {
			getHeight: () => ROW_HEIGHT,
			getTemplateId: element => element.kind === 'commit' ? CommitRenderer.ID : FileRenderer.ID,
		};
		const identityProvider: IIdentityProvider<CommitPlanNode> = {
			getId: element => element.kind === 'commit' ? element.commit.id : `${element.commit.id}:${element.kind}:${element.path}`,
		};
		this.tree = this._register(instantiationService.createInstance(
			WorkbenchObjectTree<CommitPlanNode, void>,
			'VoltCommitPlan',
			this.treeHost,
			delegate,
			[new CommitRenderer(host), new FileRenderer(host, labels)],
			{
				identityProvider,
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				accessibilityProvider: {
					getAriaLabel: element => element.kind === 'commit'
						? splitCommitMessage(element.commit.message).subject || localize('voltCommitPlan.leftover', "Not in any commit")
						: element.kind === 'folder' ? element.label : element.path,
					getWidgetAriaLabel: () => localize('voltCommitPlan.treeAria', "Proposed commits"),
				},
			},
		));
		this._register(this.tree.onDidOpen(e => {
			const element = e.element;
			if (element?.kind === 'file') {
				void this.openDiff(element.plan, element.commit, element.path, !!e.editorOptions.preserveFocus);
			}
		}));
		this._register(this.tree.onDidChangeContentHeight(() => this.layout()));

		this._register(this.plans.onDidChange(sessionId => {
			if (sessionId === this.sessionId) {
				this.render();
			}
		}));
	}

	get active(): boolean {
		return !!this.plan;
	}

	setSession(sessionId: string | undefined): void {
		if (sessionId === this.sessionId) {
			return;
		}
		this.sessionId = sessionId;
		this.editing = undefined;
		this.render();
	}

	private render(): void {
		const plan = this.sessionId ? this.plans.pending(this.sessionId) : undefined;
		const drafting = !plan && !!this.sessionId && this.plans.drafting(this.sessionId);
		const was = !!this.plan || this.element.classList.contains('drafting');
		const samePlan = plan && plan.id === this.plan?.id;
		if (this.plan && !samePlan) {
			this.closeDiffs(this.plan.sessionId);
		}
		this.plan = plan;
		const minimized = !!plan && this.minimized.has(plan.id);
		this.element.classList.toggle('hidden', (!plan && !drafting) || minimized);
		this.element.classList.toggle('drafting', drafting);
		if (this.chip.classList.contains('hidden') === minimized) {
			this.chip.classList.toggle('hidden', !minimized);
			this.onDidChangeChip.fire();
		}
		for (const button of [this.commitButton, this.cancelButton, this.viewButton, this.collapseButton, this.minimizeButton]) {
			button.element.classList.toggle('hidden', drafting);
		}
		this.stopButton.classList.toggle('hidden', !drafting);
		this.treeHost.classList.toggle('hidden', !plan);
		this.title.textContent = drafting ? localize('voltCommitPlan.generating', "Generating Drafts…") : localize('voltCommitPlan.title', "Review Draft Commits");
		if (!plan) {
			this.tooltip.hide();
			this.tree.setChildren(null, []);
			this.editing = undefined;
			this.editor.classList.add('hidden');
			this.element.classList.remove('busy');
			this.status.textContent = '';
			this.errorRow.classList.add('hidden');
			// Asked for, not proposed yet (drafting): the title and the glow say the agent is on it.
			this.summary.replaceChildren();
			if (was || drafting) {
				this.layout();
			}
			return;
		}
		const commits = plan.commits.filter(commit => !commit.leftover);
		const chosen = plan.commits.filter(commit => commit.paths.some(path => !commit.excluded.has(path)));
		const total = stats(plan, plan.commits.flatMap(commit => commit.paths.filter(path => !commit.excluded.has(path))));
		this.summary.replaceChildren();
		append(this.summary, $('span')).textContent = [
			commits.length === 1 ? localize('voltCommitPlan.oneCommit', "1 commit") : localize('voltCommitPlan.commits', "{0} commits", commits.length),
			plan.branch ? localize('voltCommitPlan.onBranch', "on {0}", plan.branch) : undefined,
		].filter(Boolean).join(' · ');
		renderStats(append(this.summary, $('span.volt-commit-plan-stats')), total);

		const editing = this.editing ? plan.commits.find(commit => commit.id === this.editing) : undefined;
		if (!editing) {
			this.editing = undefined;
		}
		this.editor.classList.toggle('hidden', !editing);

		// The first commit opens when the review appears; later updates keep what the user opened.
		let number = 0;
		this.tree.setChildren(null, plan.commits.map((commit): ITreeElement<CommitPlanNode> => ({
			element: { kind: 'commit', plan, commit, number: commit.leftover ? 0 : ++number },
			children: this.viewAsTree ? fileTree(plan, commit) : fileList(plan, commit),
			collapsed: samePlan ? undefined : true,
		})));

		this.element.classList.toggle('busy', !!plan.busy);
		const error = !plan.busy ? plan.error : undefined;
		this.status.textContent = plan.busy ?? (error ? '' : plan.notice) ?? (plan.done.length
			? localize('voltCommitPlan.madeSome', "{0} committed. The rest is still here.", plan.done.length)
			: '');
		this.errorRow.textContent = error ?? '';
		this.errorRow.classList.toggle('hidden', !error);
		this.chipCount.textContent = String(commits.length);
		// A new label replaces the button's content, an unchanged one keeps it: one icon in front either way.
		this.commitButton.label = plan.busy
			? localize('voltCommitPlan.committingButton', "Committing…")
			: plan.hookFailed
				? localize('voltCommitPlan.commitSkipHooks', "Commit Without Hooks")
				: chosen.length === 1
					? localize('voltCommitPlan.commitOne', "Commit")
					: localize('voltCommitPlan.commitMany', "Commit {0}", chosen.length);
		this.commitButton.setTitle(plan.hookFailed && !plan.busy ? localize('voltCommitPlan.commitSkipHooksTitle', "Commit again with git commit --no-verify, skipping the hook that failed") : '');
		this.commitButton.element.querySelector('.volt-commit-plan-commit-icon, .volt-commit-plan-busy-icon')?.remove();
		this.commitButton.element.prepend(plan.busy ? renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')) : commitIcon(this.element.ownerDocument));
		this.commitButton.element.firstElementChild?.classList.add(plan.busy ? 'volt-commit-plan-busy-icon' : 'volt-commit-plan-commit-icon');
		this.commitButton.enabled = !plan.busy && chosen.length > 0 && !plan.commits.some(commit => commit.generating);
		this.cancelButton.enabled = !plan.busy;
		this.layout();
	}

	/** The button offers the other view: a list while the files show as folders, and back. */
	private renderViewButton(): void {
		setIconButton(this.viewButton, this.viewAsTree ? Codicon.listFlat : Codicon.listTree, this.viewAsTree
			? localize('voltCommitPlan.viewAsList', "View as List")
			: localize('voltCommitPlan.viewAsTree', "View as Tree"));
	}

	private setMinimized(value: boolean): void {
		if (!this.plan) {
			return;
		}
		if (value) {
			this.minimized.add(this.plan.id);
			this.tooltip.hide();
		} else {
			this.minimized.delete(this.plan.id);
		}
		this.render();
		if (value) {
			this.chip.focus();
		} else {
			this.tree.domFocus();
		}
	}

	private toggle(node: CommitPlanNode, value: boolean): void {
		if (!this.plan || this.plan.busy) {
			return;
		}
		if (node.kind === 'folder') {
			for (const path of node.files) {
				this.plans.setIncluded(node.plan.id, node.commit.id, path, value);
			}
			return;
		}
		this.plans.setIncluded(node.plan.id, node.commit.id, node.kind === 'file' ? node.path : undefined, value);
	}

	private startEditing(commit: IAgentPlannedCommit): void {
		this.editing = commit.id;
		const number = this.plan ? this.plan.commits.filter(item => !item.leftover).indexOf(commit) + 1 : 0;
		this.editorLabel.textContent = commit.leftover
			? localize('voltCommitPlan.editLeftover', "Message for the files left out")
			: localize('voltCommitPlan.editLabel', "Message for commit {0}", number);
		this.editorArea.value = commit.message;
		this.editor.classList.remove('hidden');
		this.layout();
		this.editorArea.focus();
		this.editorArea.setSelectionRange(this.editorArea.value.length, this.editorArea.value.length);
	}

	private saveEdit(): void {
		if (this.plan && this.editing && this.editorArea.value.trim()) {
			this.plans.setMessage(this.plan.id, this.editing, this.editorArea.value);
		}
		this.stopEditing();
	}

	private stopEditing(): void {
		this.editing = undefined;
		this.editor.classList.add('hidden');
		this.layout();
		this.tree.domFocus();
	}

	/**
	 * This commit's changes alone, side by side with HEAD (the files left in; all of them when none
	 * are), like a commit opened from Agent Turns or the history. Scrolled to `path` when given.
	 */
	private async openDiff(plan: IAgentCommitPlan, commit: IAgentPlannedCommit, path: string | undefined, preserveFocus: boolean): Promise<void> {
		const input = this.instantiationService.createInstance(
			MultiDiffEditorInput,
			commitDiffUri(plan.sessionId, commit.id, path),
			path ? basename(path) : splitCommitMessage(commit.message).subject || localize('voltCommitPlan.leftover', "Not in any commit"),
			undefined,
			true,
		);
		await this.editorService.openEditor(input, { pinned: true, preserveFocus });
	}

	/** The review ended (committed, closed or replaced): its diffs would only say "No Changed Files". */
	private closeDiffs(sessionId: string): void {
		const prefix = `/${sessionId}/`;
		const stale = this.editorService.getEditors(EditorsOrder.SEQUENTIAL)
			.filter(({ editor }) => editor.resource?.scheme === COMMIT_PLAN_DIFF_SCHEME && editor.resource.path.startsWith(prefix));
		if (stale.length) {
			void this.editorService.closeEditors(stale, { preserveFocus: true });
		}
	}

	private layout(): void {
		if (this.plan) {
			const rows = Math.min(Math.max(this.tree.contentHeight / ROW_HEIGHT, 1), MAX_TREE_ROWS);
			const height = Math.round(rows * ROW_HEIGHT);
			this.treeHost.style.height = `${height}px`;
			this.tree.layout(height, this.treeHost.clientWidth || undefined);
		}
		const next = this.element.offsetHeight;
		if (next !== this.height) {
			this.height = next;
			this.options.onLayout();
		}
	}
}
