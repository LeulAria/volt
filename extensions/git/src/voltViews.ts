/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { commands, env, Event, EventEmitter, FileDecoration, FileDecorationProvider, l10n, MarkdownString, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri, window, workspace } from 'vscode';
import { Change } from './api/git';
import { Commit, Stash } from './git';
import { Model } from './model';
import { OperationKind } from './operation';
import { Repository, Resource } from './repository';
import { toMultiFileDiffEditorUris } from './uri';
import { dispose, fromNow, IDisposable, subject, truncate } from './util';

/** Commits a page of the Commits view loads. */
const COMMITS_PAGE = 50;

interface RepositoryNode { readonly kind: 'repository'; readonly repository: Repository }
interface CommitNode { readonly kind: 'commit'; readonly repository: Repository; readonly commit: Commit }
interface StashNode { readonly kind: 'stash'; readonly repository: Repository; readonly stash: Stash; readonly date: Date | undefined }
interface FileNode { readonly kind: 'file'; readonly repository: Repository; readonly change: Change; readonly originalRef: string; readonly modifiedRef: string }
interface FolderNode { readonly kind: 'folder'; readonly repository: Repository; readonly uri: Uri; readonly label: string; readonly children: readonly (FolderNode | FileNode)[] }
interface MoreNode { readonly kind: 'more'; readonly repository: Repository }
type Node = RepositoryNode | CommitNode | StashNode | FolderNode | FileNode | MoreNode;

interface IFolderEntries { readonly folders: Map<string, IFolderEntries>; readonly files: FileNode[] }

/**
 * Files as a tree of their folders, folders first, as Source Control's tree view lists changes.
 * A folder holding nothing but one folder shares its row (`apps/docs/src`).
 */
function toFileTree(repository: Repository, files: readonly FileNode[]): (FolderNode | FileNode)[] {
	const root: IFolderEntries = { folders: new Map(), files: [] };
	for (const file of files) {
		const parts = path.relative(repository.root, file.change.uri.fsPath).split(path.sep);
		let folder = root;
		for (const part of parts.slice(0, -1)) {
			let next = folder.folders.get(part);
			if (!next) {
				next = { folders: new Map(), files: [] };
				folder.folders.set(part, next);
			}
			folder = next;
		}
		folder.files.push(file);
	}
	const build = (entries: IFolderEntries, relativePath: string): (FolderNode | FileNode)[] => {
		const folders = [...entries.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]): FolderNode => {
			let label = name;
			let folderPath = path.join(relativePath, name);
			let current = child;
			while (current.files.length === 0 && current.folders.size === 1) {
				const [nextName, next] = [...current.folders][0];
				label = `${label}/${nextName}`;
				folderPath = path.join(folderPath, nextName);
				current = next;
			}
			return { kind: 'folder', repository, uri: Uri.file(path.join(repository.root, folderPath)), label, children: build(current, folderPath) };
		});
		const sorted = [...entries.files].sort((a, b) => path.basename(a.change.uri.fsPath).localeCompare(path.basename(b.change.uri.fsPath)));
		return [...folders, ...sorted];
	};
	return build(root, '');
}

function shortHash(repository: Repository, hash: string): string {
	const length = workspace.getConfiguration('git', Uri.file(repository.root)).get<number>('commitShortHashLength', 7);
	return truncate(hash, length, false);
}

/** Status letters and colors for the files under a commit or stash, as the Changes view shows them. */
class ChangeDecorations implements FileDecorationProvider, IDisposable {

	private readonly decorations = new Map<string, FileDecoration>();
	private readonly _onDidChangeFileDecorations = new EventEmitter<Uri[]>();
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
	private readonly registration = window.registerFileDecorationProvider(this);

	set(uri: Uri, change: Change): void {
		const key = uri.toString();
		const letter = Resource.getStatusLetter(change.status);
		if (this.decorations.get(key)?.badge === letter) {
			return; // Rows render again on every refresh; only a new status needs an event.
		}
		this.decorations.set(key, new FileDecoration(letter, Resource.getStatusText(change.status), Resource.getStatusColor(change.status)));
		this._onDidChangeFileDecorations.fire([uri]);
	}

	provideFileDecoration(uri: Uri): FileDecoration | undefined {
		return this.decorations.get(uri.toString());
	}

	dispose(): void {
		this.registration.dispose();
		this._onDidChangeFileDecorations.dispose();
	}
}

/**
 * The repositories a view lists: the ones selected in Source Control (the agent window selects the
 * chat's), or the first one. With several, each gets its own row.
 */
abstract class RepositoryTree implements TreeDataProvider<Node>, IDisposable {

	protected readonly _onDidChangeTreeData = new EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData: Event<Node | undefined> = this._onDidChangeTreeData.event;
	private readonly repositoryDisposables = new Map<Repository, IDisposable[]>();
	private readonly disposables: IDisposable[] = [];

	constructor(protected readonly model: Model, protected readonly decorations: ChangeDecorations) {
		this.disposables.push(model.onDidOpenRepository(repository => { this.watch(repository); this.refresh(); }));
		this.disposables.push(model.onDidCloseRepository(repository => {
			dispose(this.repositoryDisposables.get(repository) ?? []);
			this.repositoryDisposables.delete(repository);
			this.refresh();
		}));
		model.repositories.forEach(repository => this.watch(repository));
	}

	refresh(node?: Node): void {
		this._onDidChangeTreeData.fire(node);
	}

	private watch(repository: Repository): void {
		const disposables = [repository.sourceControl.onDidChangeSelection(() => this.refresh())];
		disposables.push(...this.watchRepository(repository));
		this.repositoryDisposables.set(repository, disposables);
	}

	protected abstract watchRepository(repository: Repository): IDisposable[];
	protected abstract getRepositoryChildren(repository: Repository): Promise<Node[]>;
	protected abstract getItemChildren(node: Node): Promise<Node[]>;
	protected abstract getItem(node: Node): TreeItem;

	private repositories(): Repository[] {
		const selected = this.model.repositories.filter(repository => repository.sourceControl.selected);
		return selected.length > 0 ? selected : this.model.repositories.slice(0, 1);
	}

	async getChildren(node?: Node): Promise<Node[]> {
		if (!node) {
			const repositories = this.repositories();
			if (repositories.length > 1) {
				return repositories.map(repository => ({ kind: 'repository', repository }));
			}
			return repositories.length ? this.getRepositoryChildren(repositories[0]) : [];
		}
		if (node.kind === 'repository') {
			return this.getRepositoryChildren(node.repository);
		}
		if (node.kind === 'folder') {
			return [...node.children];
		}
		return this.getItemChildren(node);
	}

	getTreeItem(node: Node): TreeItem {
		if (node.kind === 'repository') {
			const item = new TreeItem(path.basename(node.repository.root), TreeItemCollapsibleState.Expanded);
			item.iconPath = new ThemeIcon('repo');
			item.description = node.repository.HEAD?.name;
			item.tooltip = node.repository.root;
			return item;
		}
		if (node.kind === 'file') {
			return this.getFileItem(node);
		}
		if (node.kind === 'folder') {
			const item = new TreeItem(node.uri, TreeItemCollapsibleState.Expanded);
			item.label = node.label;
			item.iconPath = ThemeIcon.Folder;
			item.contextValue = 'voltGitFolder';
			return item;
		}
		return this.getItem(node);
	}

	/** The files under a commit or stash, in their folders: each opens as a diff of the two refs. */
	protected async getFiles(repository: Repository, changes: Change[], originalRef: string, modifiedRef: string): Promise<(FolderNode | FileNode)[]> {
		return toFileTree(repository, changes.map(change => ({ kind: 'file', repository, change, originalRef, modifiedRef })));
	}

	private getFileItem(node: FileNode): TreeItem {
		const uri = node.change.uri.with({ query: `volt-ref=${node.modifiedRef}` });
		this.decorations.set(uri, node.change);
		const item = new TreeItem(uri, TreeItemCollapsibleState.None);
		item.label = path.basename(node.change.uri.fsPath);
		// The folder rows above say where it is.
		item.description = false;
		item.contextValue = 'voltGitFile';
		item.command = { command: 'git.volt.openFileChange', title: l10n.t('Open Changes'), arguments: [node] };
		return item;
	}

	dispose(): void {
		this.repositoryDisposables.forEach(disposables => dispose(disposables));
		this.repositoryDisposables.clear();
		dispose(this.disposables);
		this._onDidChangeTreeData.dispose();
	}
}

/** The current branch's commits, newest first, a page at a time; each opens to its files. */
class CommitsTree extends RepositoryTree {

	private readonly limits = new Map<Repository, number>();
	private readonly heads = new Map<Repository, string>();

	protected watchRepository(repository: Repository): IDisposable[] {
		return [repository.onDidRunGitStatus(() => {
			const head = `${repository.HEAD?.name ?? ''}@${repository.HEAD?.commit ?? ''}`;
			if (this.heads.get(repository) !== head) {
				this.heads.set(repository, head);
				this.refresh();
			}
		})];
	}

	loadMore(repository: Repository): void {
		this.limits.set(repository, (this.limits.get(repository) ?? COMMITS_PAGE) + COMMITS_PAGE);
		this.refresh();
	}

	protected async getRepositoryChildren(repository: Repository): Promise<Node[]> {
		const limit = this.limits.get(repository) ?? COMMITS_PAGE;
		let commits: Commit[];
		try {
			commits = await repository.log({ maxEntries: limit + 1, silent: true });
		} catch {
			return []; // No commits yet
		}
		const nodes: Node[] = commits.slice(0, limit).map(commit => ({ kind: 'commit', repository, commit }));
		if (commits.length > limit) {
			nodes.push({ kind: 'more', repository });
		}
		return nodes;
	}

	protected async getItemChildren(node: Node): Promise<Node[]> {
		if (node.kind !== 'commit') {
			return [];
		}
		const { repository, commit } = node;
		const parent = commit.parents[0] ?? await repository.getEmptyTree();
		return this.getFiles(repository, await repository.diffTrees(parent, commit.hash), parent, commit.hash);
	}

	protected getItem(node: Node): TreeItem {
		if (node.kind === 'more') {
			const item = new TreeItem(l10n.t('Load More Commits'), TreeItemCollapsibleState.None);
			item.iconPath = new ThemeIcon('more');
			item.command = { command: 'git.volt.loadMoreCommits', title: l10n.t('Load More Commits'), arguments: [node] };
			return item;
		}
		if (node.kind !== 'commit') {
			throw new Error(`Unexpected node: ${node.kind}`);
		}
		const { repository, commit } = node;
		const item = new TreeItem(subject(commit.message), TreeItemCollapsibleState.Collapsed);
		item.id = `${repository.root}#commit#${commit.hash}`;
		item.iconPath = new ThemeIcon('git-commit');
		item.description = [commit.authorName, commit.authorDate ? fromNow(commit.authorDate, true, true) : undefined].filter(Boolean).join(', ');
		item.contextValue = 'voltGitCommit';
		const tooltip = new MarkdownString('', true);
		tooltip.appendMarkdown(`$(git-commit) \`${shortHash(repository, commit.hash)}\``);
		if (commit.authorName) {
			tooltip.appendMarkdown(` · ${commit.authorName}`);
		}
		if (commit.authorDate) {
			tooltip.appendMarkdown(` · ${commit.authorDate.toLocaleString()}`);
		}
		tooltip.appendMarkdown('\n\n');
		tooltip.appendText(commit.message.trim());
		item.tooltip = tooltip;
		return item;
	}
}

/** The repository's stashes; each opens to its files, with apply, pop and drop on the row. */
class StashesTree extends RepositoryTree {

	protected watchRepository(repository: Repository): IDisposable[] {
		// Stash operations change the list (push, pop, apply, drop); this view reads it as Show.
		return [repository.onDidRunOperation(({ operation }) => {
			if (operation.kind === OperationKind.Stash) {
				this.refresh();
			}
		})];
	}

	protected async getRepositoryChildren(repository: Repository): Promise<Node[]> {
		const stashes = await repository.readStashes();
		return Promise.all(stashes.map(async (stash): Promise<Node> => {
			const date = await repository.getCommit(stash.hash).then(commit => commit.commitDate, () => undefined);
			return { kind: 'stash', repository, stash, date };
		}));
	}

	protected async getItemChildren(node: Node): Promise<Node[]> {
		if (node.kind !== 'stash') {
			return [];
		}
		const { repository, stash } = node;
		const parent = stash.parents[0] ?? `${stash.hash}^`;
		return this.getFiles(repository, await repository.readStashFiles(stash.index) ?? [], parent, stash.hash);
	}

	protected getItem(node: Node): TreeItem {
		if (node.kind !== 'stash') {
			throw new Error(`Unexpected node: ${node.kind}`);
		}
		const { repository, stash, date } = node;
		const item = new TreeItem(stash.description, TreeItemCollapsibleState.Collapsed);
		item.id = `${repository.root}#stash#${stash.hash}`;
		item.iconPath = new ThemeIcon('git-stash');
		item.description = [stash.branchName, date ? fromNow(date, true, true) : undefined].filter(Boolean).join(', ');
		item.tooltip = `stash@{${stash.index}}: ${stash.description}`;
		item.contextValue = 'voltGitStash';
		return item;
	}
}

/** Volt's Commits and Stashes views in Source Control, beside Changes and Graph. */
export class VoltGitViews implements IDisposable {

	private readonly disposables: IDisposable[] = [];

	constructor(model: Model) {
		const decorations = new ChangeDecorations();
		const commitsTree = new CommitsTree(model, decorations);
		const stashesTree = new StashesTree(model, decorations);
		this.disposables.push(decorations, commitsTree, stashesTree);

		const commitsView = window.createTreeView('git.volt.commits', { treeDataProvider: commitsTree, showCollapseAll: true });
		const stashesView = window.createTreeView('git.volt.stashes', { treeDataProvider: stashesTree, showCollapseAll: true });
		this.disposables.push(commitsView, stashesView);
		// Stashes change outside a stash operation too (another tool, the terminal): look again when shown.
		this.disposables.push(stashesView.onDidChangeVisibility(e => e.visible && stashesTree.refresh()));

		this.disposables.push(
			commands.registerCommand('git.volt.refreshCommits', () => commitsTree.refresh()),
			commands.registerCommand('git.volt.refreshStashes', () => stashesTree.refresh()),
			commands.registerCommand('git.volt.loadMoreCommits', (node: MoreNode) => commitsTree.loadMore(node.repository)),
			commands.registerCommand('git.volt.openFileChange', (node: FileNode) => this.openFileChange(node)),
			commands.registerCommand('git.volt.openCommitChanges', (node: CommitNode) =>
				commands.executeCommand('git.viewCommit', node.repository.sourceControl, node.commit.hash)),
			commands.registerCommand('git.volt.copyCommitId', (node: CommitNode) => env.clipboard.writeText(node.commit.hash)),
			commands.registerCommand('git.volt.copyCommitMessage', (node: CommitNode) => env.clipboard.writeText(node.commit.message)),
			commands.registerCommand('git.volt.openStashChanges', (node: StashNode) => this.openStashChanges(node)),
			commands.registerCommand('git.volt.stashApply', (node: StashNode) => node.repository.applyStash(node.stash.index)),
			commands.registerCommand('git.volt.stashPop', (node: StashNode) => node.repository.popStash(node.stash.index)),
			commands.registerCommand('git.volt.stashDrop', (node: StashNode) => this.dropStash(node)),
		);
	}

	private async openFileChange(node: FileNode): Promise<void> {
		const { originalUri, modifiedUri } = toMultiFileDiffEditorUris(node.change, node.originalRef, node.modifiedRef);
		if (originalUri && modifiedUri) {
			const title = `${path.basename(node.change.uri.fsPath)} (${shortHash(node.repository, node.modifiedRef)})`;
			await commands.executeCommand('vscode.diff', originalUri, modifiedUri, title);
		} else {
			await commands.executeCommand('vscode.open', modifiedUri ?? originalUri);
		}
	}

	private async openStashChanges(node: StashNode): Promise<void> {
		const { repository, stash } = node;
		const changes = await repository.readStashFiles(stash.index) ?? [];
		const parent = stash.parents[0] ?? `${stash.hash}^`;
		await commands.executeCommand('_workbench.openMultiDiffEditor', {
			multiDiffSourceUri: Uri.from({ scheme: 'git-stash', path: `${repository.root}/stash@{${stash.index}}` }),
			title: `Git Stash #${stash.index}: ${stash.description}`,
			resources: changes.map(change => toMultiFileDiffEditorUris(change, parent, stash.hash)),
		});
	}

	private async dropStash(node: StashNode): Promise<void> {
		const yes = l10n.t('Yes');
		const result = await window.showWarningMessage(
			l10n.t('Are you sure you want to drop the stash: {0}?', node.stash.description),
			{ modal: true }, yes);
		if (result === yes) {
			await node.repository.dropStash(node.stash.index);
		}
	}

	dispose(): void {
		dispose(this.disposables);
	}
}
