/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { commands, env, Event, EventEmitter, FileDecoration, FileDecorationProvider, l10n, MarkdownString, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri, window, workspace } from 'vscode';
import { Branch, Change, GitErrorCodes, Ref, RefType, Remote } from './api/git';
import { Commit, GitError, Stash } from './git';
import { Model } from './model';
import { OperationKind } from './operation';
import { Repository, Resource } from './repository';
import { toMultiFileDiffEditorUris } from './uri';
import { dispose, fromNow, IDisposable, pathEquals, subject, truncate } from './util';

/** Commits a page of the Commits view loads. */
const COMMITS_PAGE = 50;
/** How far back `git.volt.revealCommit` looks on the branch for a commit to show. */
const REVEAL_COMMITS = 1000;

interface RepositoryNode { readonly kind: 'repository'; readonly repository: Repository }
interface CommitNode { readonly kind: 'commit'; readonly repository: Repository; readonly commit: Commit }
interface StashNode { readonly kind: 'stash'; readonly repository: Repository; readonly stash: Stash; readonly date: Date | undefined }
interface FileNode { readonly kind: 'file'; readonly repository: Repository; readonly change: Change; readonly originalRef: string; readonly modifiedRef: string }
interface FolderNode { readonly kind: 'folder'; readonly repository: Repository; readonly uri: Uri; readonly label: string; readonly children: readonly (FolderNode | FileNode)[] }
interface MoreNode { readonly kind: 'more'; readonly repository: Repository }
interface BranchNode { readonly kind: 'branch'; readonly repository: Repository; readonly branch: Branch; readonly current: boolean }
interface RemoteNode { readonly kind: 'remote'; readonly repository: Repository; readonly remote: Remote }
/** `origin/main`: `ref.name` carries the remote's name first, `ref.remote` the remote. */
interface RemoteBranchNode { readonly kind: 'remoteBranch'; readonly repository: Repository; readonly ref: Ref }
interface TagNode { readonly kind: 'tag'; readonly repository: Repository; readonly ref: Ref }
interface WorktreeNode { readonly kind: 'worktree'; readonly repository: Repository; readonly worktree: IWorktreeEntry }
type Node = RepositoryNode | CommitNode | StashNode | FolderNode | FileNode | MoreNode | BranchNode | RemoteNode | RemoteBranchNode | TagNode | WorktreeNode;

/** One entry of `git worktree list --porcelain`. */
interface IWorktreeEntry {
	readonly path: string;
	readonly head?: string;
	readonly branch?: string;
	readonly detached: boolean;
	readonly locked: boolean;
	readonly prunable: boolean;
	/** The first entry: the repository's own checkout. */
	readonly main: boolean;
}

export function parseWorktreeList(output: string): IWorktreeEntry[] {
	const entries: IWorktreeEntry[] = [];
	for (const block of output.split(/\n\n+/)) {
		const lines = block.split('\n').filter(Boolean);
		const worktreeLine = lines.find(line => line.startsWith('worktree '));
		if (!worktreeLine || lines.includes('bare')) {
			continue;
		}
		const value = (key: string) => lines.find(line => line.startsWith(`${key} `))?.slice(key.length + 1);
		entries.push({
			path: worktreeLine.slice('worktree '.length),
			head: value('HEAD'),
			branch: value('branch')?.replace(/^refs\/heads\//, ''),
			detached: lines.includes('detached'),
			locked: lines.some(line => line === 'locked' || line.startsWith('locked ')),
			prunable: lines.some(line => line === 'prunable' || line.startsWith('prunable ')),
			main: entries.length === 0,
		});
	}
	return entries;
}

/** Git's own words for a failed command: its last stderr lines, else the message. */
function gitErrorText(err: unknown): string {
	const error = err as Partial<GitError> | undefined;
	return error?.stderr?.trim() || error?.message || String(err);
}

async function runGit(task: () => Promise<unknown>): Promise<void> {
	try {
		await task();
	} catch (err) {
		void window.showErrorMessage(gitErrorText(err));
	}
}

async function confirm(message: string, action: string): Promise<boolean> {
	return await window.showWarningMessage(message, { modal: true }, action) === action;
}

/** "↑2 ↓1": how far a branch is ahead of and behind its upstream. */
function trackLabel(branch: Branch): string | undefined {
	const parts = [branch.ahead ? `\u2191${branch.ahead}` : '', branch.behind ? `\u2193${branch.behind}` : ''].filter(Boolean);
	return parts.length ? parts.join(' ') : undefined;
}

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

	protected repositories(): Repository[] {
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
			// A fresh node for the same repository finds this row again, for reveal.
			item.id = `${node.repository.root}#repository`;
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

	/**
	 * The row of `hash` (full or abbreviated), loading pages until it is listed. Undefined when the view
	 * lists other repositories or the branch's last REVEAL_COMMITS commits don't hold it.
	 */
	async find(repository: Repository, hash: string): Promise<CommitNode | undefined> {
		if (!this.repositories().includes(repository)) {
			return undefined;
		}
		const commits = await repository.log({ maxEntries: REVEAL_COMMITS, silent: true }).catch(() => [] as Commit[]);
		const index = commits.findIndex(commit => commit.hash.startsWith(hash));
		if (index < 0) {
			return undefined;
		}
		if (index >= (this.limits.get(repository) ?? COMMITS_PAGE)) {
			this.limits.set(repository, Math.ceil((index + 1) / COMMITS_PAGE) * COMMITS_PAGE);
			this.refresh();
		}
		return { kind: 'commit', repository, commit: commits[index] };
	}

	/** Only commits are revealed: under their repository's row when several are listed. */
	getParent(node: Node): Node | undefined {
		return node.kind === 'commit' && this.repositories().length > 1 ? { kind: 'repository', repository: node.repository } : undefined;
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

/** What a branch, remote or tag list shows changed: its refs, remotes or HEAD. Status runs refresh it. */
abstract class RefsTree extends RepositoryTree {

	private readonly signatures = new Map<Repository, string>();

	protected abstract signature(repository: Repository): string;

	protected watchRepository(repository: Repository): IDisposable[] {
		return [repository.onDidRunGitStatus(() => {
			const signature = this.signature(repository);
			if (this.signatures.get(repository) !== signature) {
				this.signatures.set(repository, signature);
				this.refresh();
			}
		})];
	}

	protected refsSignature(repository: Repository, type: RefType): string {
		return repository.refs.filter(ref => ref.type === type).map(ref => `${ref.name}@${ref.commit}`).join(',');
	}

	protected async getItemChildren(_node: Node): Promise<Node[]> {
		return [];
	}
}

/** Local branches, the checked-out one first: check out, merge, rebase, rename, delete, publish. */
class BranchesTree extends RefsTree {

	protected signature(repository: Repository): string {
		const head = repository.HEAD;
		return `${head?.name}@${head?.commit}:${head?.ahead}/${head?.behind}|${this.refsSignature(repository, RefType.Head)}`;
	}

	protected async getRepositoryChildren(repository: Repository): Promise<Node[]> {
		const refs = await repository.getRefs({ pattern: 'refs/heads', includeCommitDetails: true }).catch(() => []);
		const head = repository.HEAD?.name;
		const nodes = refs.filter(ref => ref.type === RefType.Head && ref.name).map((ref): BranchNode => ({ kind: 'branch', repository, branch: ref as Branch, current: ref.name === head }));
		return [...nodes.filter(node => node.current), ...nodes.filter(node => !node.current)];
	}

	protected getItem(node: Node): TreeItem {
		if (node.kind !== 'branch') {
			throw new Error(`Unexpected node: ${node.kind}`);
		}
		const { repository, branch, current } = node;
		const name = branch.name!;
		const item = new TreeItem(name, TreeItemCollapsibleState.None);
		item.id = `${repository.root}#branch#${name}`;
		item.iconPath = new ThemeIcon(current ? 'check' : 'git-branch');
		const upstream = current ? repository.HEAD?.upstream : undefined;
		const date = branch.commitDetails?.commitDate;
		item.description = [
			trackLabel(current && repository.HEAD ? repository.HEAD : branch),
			upstream ? `${upstream.remote}/${upstream.name}` : undefined,
			date ? fromNow(date, true, true) : undefined,
		].filter(Boolean).join(' \u00b7 ');
		const tooltip = new MarkdownString('', true);
		tooltip.appendMarkdown(`$(git-branch) **${name}**${current ? ` (${l10n.t('current')})` : ''}`);
		if (branch.commit) {
			tooltip.appendMarkdown(`\n\n$(git-commit) \`${shortHash(repository, branch.commit)}\``);
		}
		if (branch.commitDetails?.message) {
			tooltip.appendMarkdown(' ');
			tooltip.appendText(subject(branch.commitDetails.message));
		}
		item.tooltip = tooltip;
		item.contextValue = current ? 'voltGitBranchCurrent' : 'voltGitBranch';
		return item;
	}
}

/** The remotes, each opening to its branches: fetch, remove; check out or merge a remote branch. */
class RemotesTree extends RefsTree {

	protected signature(repository: Repository): string {
		return `${repository.remotes.map(remote => `${remote.name}=${remote.fetchUrl}`).join(',')}|${this.refsSignature(repository, RefType.RemoteHead)}`;
	}

	protected async getRepositoryChildren(repository: Repository): Promise<Node[]> {
		return [...repository.remotes].sort((a, b) => a.name.localeCompare(b.name)).map((remote): RemoteNode => ({ kind: 'remote', repository, remote }));
	}

	protected override async getItemChildren(node: Node): Promise<Node[]> {
		if (node.kind !== 'remote') {
			return [];
		}
		const { repository, remote } = node;
		const refs = await repository.getRefs({ pattern: `refs/remotes/${remote.name}/`, includeCommitDetails: true }).catch(() => []);
		return refs.filter(ref => ref.type === RefType.RemoteHead && ref.name && ref.name !== `${remote.name}/HEAD`)
			.map((ref): RemoteBranchNode => ({ kind: 'remoteBranch', repository, ref }));
	}

	protected getItem(node: Node): TreeItem {
		if (node.kind === 'remote') {
			const { repository, remote } = node;
			const item = new TreeItem(remote.name, TreeItemCollapsibleState.Collapsed);
			item.id = `${repository.root}#remote#${remote.name}`;
			item.iconPath = new ThemeIcon('cloud');
			item.description = remote.fetchUrl;
			item.tooltip = [remote.fetchUrl && `${l10n.t('Fetch')}: ${remote.fetchUrl}`, remote.pushUrl && `${l10n.t('Push')}: ${remote.pushUrl}`].filter(Boolean).join('\n') || remote.name;
			item.contextValue = remote.isReadOnly ? 'voltGitRemoteReadOnly' : 'voltGitRemote';
			return item;
		}
		if (node.kind !== 'remoteBranch') {
			throw new Error(`Unexpected node: ${node.kind}`);
		}
		const { repository, ref } = node;
		const prefix = `${ref.remote}/`;
		const name = ref.name!.startsWith(prefix) ? ref.name!.slice(prefix.length) : ref.name!;
		const item = new TreeItem(name, TreeItemCollapsibleState.None);
		item.id = `${repository.root}#remoteBranch#${ref.name}`;
		item.iconPath = new ThemeIcon('git-branch');
		const date = ref.commitDetails?.commitDate;
		item.description = date ? fromNow(date, true, true) : undefined;
		item.tooltip = ref.commitDetails?.message ? `${ref.name}\n${subject(ref.commitDetails.message)}` : ref.name;
		item.contextValue = 'voltGitRemoteBranch';
		return item;
	}
}

/** The repository's tags, newest first: check out, push, delete. */
class TagsTree extends RefsTree {

	protected signature(repository: Repository): string {
		return this.refsSignature(repository, RefType.Tag);
	}

	protected async getRepositoryChildren(repository: Repository): Promise<Node[]> {
		const refs = await repository.getRefs({ pattern: 'refs/tags', sort: 'committerdate', includeCommitDetails: true }).catch(() => []);
		return refs.filter(ref => ref.type === RefType.Tag && ref.name).map((ref): TagNode => ({ kind: 'tag', repository, ref }));
	}

	protected getItem(node: Node): TreeItem {
		if (node.kind !== 'tag') {
			throw new Error(`Unexpected node: ${node.kind}`);
		}
		const { repository, ref } = node;
		const item = new TreeItem(ref.name!, TreeItemCollapsibleState.None);
		item.id = `${repository.root}#tag#${ref.name}`;
		item.iconPath = new ThemeIcon('tag');
		const date = ref.commitDetails?.commitDate;
		item.description = [ref.commit ? shortHash(repository, ref.commit) : undefined, date ? fromNow(date, true, true) : undefined].filter(Boolean).join(' \u00b7 ');
		item.tooltip = ref.commitDetails?.message ? `${ref.name}\n${subject(ref.commitDetails.message)}` : ref.name;
		item.contextValue = 'voltGitTag';
		return item;
	}
}

/** Every worktree of the repository, its own checkout first: open, open in a new window, delete. */
class WorktreesTree extends RefsTree {

	protected signature(repository: Repository): string {
		return `${repository.worktrees.map(worktree => `${worktree.path}@${worktree.ref}`).join(',')}|${this.refsSignature(repository, RefType.Head)}`;
	}

	protected async getRepositoryChildren(repository: Repository): Promise<Node[]> {
		const output = await repository.listWorktreesPorcelain().catch(() => '');
		return parseWorktreeList(output).map((worktree): WorktreeNode => ({ kind: 'worktree', repository, worktree }));
	}

	protected getItem(node: Node): TreeItem {
		if (node.kind !== 'worktree') {
			throw new Error(`Unexpected node: ${node.kind}`);
		}
		const { repository, worktree } = node;
		const open = workspace.workspaceFolders?.some(folder => path.relative(folder.uri.fsPath, worktree.path) === '') ?? false;
		const item = new TreeItem(path.basename(worktree.path), TreeItemCollapsibleState.None);
		item.id = `${repository.root}#worktree#${worktree.path}`;
		item.iconPath = new ThemeIcon(open ? 'check' : worktree.main ? 'repo' : 'worktree');
		item.description = [
			worktree.branch ?? (worktree.head ? shortHash(repository, worktree.head) : undefined),
			worktree.main ? l10n.t('main') : undefined,
			worktree.locked ? l10n.t('locked') : undefined,
			worktree.prunable ? l10n.t('prunable') : undefined,
		].filter(Boolean).join(' \u00b7 ');
		item.tooltip = worktree.path;
		item.contextValue = worktree.main ? 'voltGitWorktreeMain' : 'voltGitWorktree';
		return item;
	}
}

/** Volt's Commits, Branches, Remotes, Stashes, Tags and Worktrees views in Source Control, beside Changes and Graph. */
export class VoltGitViews implements IDisposable {

	private readonly disposables: IDisposable[] = [];

	constructor(private readonly model: Model) {
		const decorations = new ChangeDecorations();
		const commitsTree = new CommitsTree(model, decorations);
		const stashesTree = new StashesTree(model, decorations);
		const branchesTree = new BranchesTree(model, decorations);
		const remotesTree = new RemotesTree(model, decorations);
		const tagsTree = new TagsTree(model, decorations);
		const worktreesTree = new WorktreesTree(model, decorations);
		this.disposables.push(decorations, commitsTree, stashesTree, branchesTree, remotesTree, tagsTree, worktreesTree);

		const commitsView = window.createTreeView('git.volt.commits', { treeDataProvider: commitsTree, showCollapseAll: true });
		const stashesView = window.createTreeView('git.volt.stashes', { treeDataProvider: stashesTree, showCollapseAll: true });
		const branchesView = window.createTreeView('git.volt.branches', { treeDataProvider: branchesTree });
		const remotesView = window.createTreeView('git.volt.remotes', { treeDataProvider: remotesTree, showCollapseAll: true });
		const tagsView = window.createTreeView('git.volt.tags', { treeDataProvider: tagsTree });
		const worktreesView = window.createTreeView('git.volt.worktrees', { treeDataProvider: worktreesTree });
		this.disposables.push(commitsView, stashesView, branchesView, remotesView, tagsView, worktreesView);
		// Stashes change outside a stash operation too (another tool, the terminal): look again when shown.
		this.disposables.push(stashesView.onDidChangeVisibility(e => e.visible && stashesTree.refresh()));
		this.disposables.push(worktreesView.onDidChangeVisibility(e => e.visible && worktreesTree.refresh()));

		// The views' title actions run Git's own commands on the repository the views list, so the
		// agent window's chat repository is used without asking which one.
		const onRepository = (gitCommand: string) => () => {
			const repository = this.repository();
			return repository ? commands.executeCommand(gitCommand, repository.sourceControl) : commands.executeCommand(gitCommand);
		};
		const titleCommands: [string, string][] = [
			['git.volt.createBranch', 'git.branch'],
			['git.volt.createBranchFrom', 'git.branchFrom'],
			['git.volt.renameCurrentBranch', 'git.renameBranch'],
			['git.volt.fetch', 'git.fetch'],
			['git.volt.fetchPrune', 'git.fetchPrune'],
			['git.volt.fetchAll', 'git.fetchAll'],
			['git.volt.pull', 'git.pull'],
			['git.volt.push', 'git.push'],
			['git.volt.sync', 'git.sync'],
			['git.volt.publish', 'git.publish'],
			['git.volt.addRemote', 'git.addRemote'],
			['git.volt.stash', 'git.stash'],
			['git.volt.stashIncludeUntracked', 'git.stashIncludeUntracked'],
			['git.volt.stashStaged', 'git.stashStaged'],
			['git.volt.stashApplyLatest', 'git.stashApplyLatest'],
			['git.volt.stashPopLatest', 'git.stashPopLatest'],
			['git.volt.stashDropAll', 'git.stashDropAll'],
			['git.volt.createTag', 'git.createTag'],
			['git.volt.pushTags', 'git.pushTags'],
			['git.volt.createWorktree', 'git.createWorktree'],
		];
		for (const [id, gitCommand] of titleCommands) {
			this.disposables.push(commands.registerCommand(id, onRepository(gitCommand)));
		}

		this.disposables.push(
			commands.registerCommand('git.volt.refreshCommits', () => commitsTree.refresh()),
			commands.registerCommand('git.volt.refreshStashes', () => stashesTree.refresh()),
			commands.registerCommand('git.volt.loadMoreCommits', (node: MoreNode) => commitsTree.loadMore(node.repository)),
			// The agent window's pull request timeline: a commit's row, selected and opened to its files.
			commands.registerCommand('git.volt.revealCommit', async (root: string, hash: string): Promise<boolean> => {
				// A chat's folder can differ from git's root in case alone on macOS, which `getRepository` misses.
				const repository = this.model.repositories.find(candidate => pathEquals(candidate.root, root)) ?? this.model.getRepository(Uri.file(root));
				const node = repository && await commitsTree.find(repository, hash);
				if (!node) {
					return false;
				}
				await commitsView.reveal(node, { select: true, focus: true, expand: true });
				return true;
			}),
			commands.registerCommand('git.volt.openFileChange', (node: FileNode) => this.openFileChange(node)),
			commands.registerCommand('git.volt.openCommitChanges', (node: CommitNode) =>
				commands.executeCommand('git.viewCommit', node.repository.sourceControl, node.commit.hash)),
			commands.registerCommand('git.volt.copyCommitId', (node: CommitNode) => env.clipboard.writeText(node.commit.hash)),
			commands.registerCommand('git.volt.copyCommitMessage', (node: CommitNode) => env.clipboard.writeText(node.commit.message)),
			commands.registerCommand('git.volt.openStashChanges', (node: StashNode) => this.openStashChanges(node)),
			commands.registerCommand('git.volt.stashApply', (node: StashNode) => node.repository.applyStash(node.stash.index)),
			commands.registerCommand('git.volt.stashPop', (node: StashNode) => node.repository.popStash(node.stash.index)),
			commands.registerCommand('git.volt.stashDrop', (node: StashNode) => this.dropStash(node)),
			// A commit: the same actions as the Graph's.
			commands.registerCommand('git.volt.checkoutCommit', (node: CommitNode) =>
				commands.executeCommand('git.graph.checkoutDetached', node.repository.sourceControl, { id: node.commit.hash })),
			commands.registerCommand('git.volt.branchFromCommit', (node: CommitNode) =>
				commands.executeCommand('git.branch', node.repository.sourceControl, { id: node.commit.hash })),
			commands.registerCommand('git.volt.tagCommit', (node: CommitNode) =>
				commands.executeCommand('git.createTag', node.repository.sourceControl, { id: node.commit.hash })),
			commands.registerCommand('git.volt.cherryPickCommit', (node: CommitNode) =>
				commands.executeCommand('git.graph.cherryPick', node.repository.sourceControl, { id: node.commit.hash })),
			commands.registerCommand('git.volt.refreshBranches', () => branchesTree.refresh()),
			commands.registerCommand('git.volt.refreshRemotes', () => remotesTree.refresh()),
			commands.registerCommand('git.volt.refreshTags', () => tagsTree.refresh()),
			commands.registerCommand('git.volt.refreshWorktrees', () => worktreesTree.refresh()),
			// A branch.
			commands.registerCommand('git.volt.checkoutBranch', (node: BranchNode) => runGit(() => node.repository.checkout(node.branch.name!))),
			commands.registerCommand('git.volt.mergeBranch', (node: BranchNode | RemoteBranchNode) =>
				runGit(() => node.repository.merge(node.kind === 'branch' ? node.branch.name! : node.ref.name!))),
			commands.registerCommand('git.volt.rebaseOntoBranch', (node: BranchNode | RemoteBranchNode) =>
				runGit(() => node.repository.rebase(node.kind === 'branch' ? node.branch.name! : node.ref.name!))),
			commands.registerCommand('git.volt.deleteBranch', (node: BranchNode) => this.deleteBranch(node)),
			commands.registerCommand('git.volt.copyBranchName', (node: BranchNode | RemoteBranchNode | TagNode) =>
				env.clipboard.writeText(node.kind === 'branch' ? node.branch.name! : node.ref.name!)),
			// A remote and its branches.
			commands.registerCommand('git.volt.fetchRemote', (node: RemoteNode) => runGit(() => node.repository.fetch({ remote: node.remote.name }))),
			commands.registerCommand('git.volt.removeRemote', (node: RemoteNode) => this.removeRemote(node)),
			commands.registerCommand('git.volt.copyRemoteUrl', (node: RemoteNode) => env.clipboard.writeText(node.remote.fetchUrl ?? node.remote.pushUrl ?? '')),
			commands.registerCommand('git.volt.checkoutRemoteBranch', (node: RemoteBranchNode) => this.checkoutRemoteBranch(node)),
			commands.registerCommand('git.volt.deleteRemoteBranch', (node: RemoteBranchNode) => this.deleteRemoteBranch(node)),
			// A tag.
			commands.registerCommand('git.volt.checkoutTag', (node: TagNode) => runGit(() => node.repository.checkout(node.ref.name!, { detached: true }))),
			commands.registerCommand('git.volt.pushTag', (node: TagNode) => this.pushTag(node)),
			commands.registerCommand('git.volt.deleteTag', (node: TagNode) => this.deleteTag(node)),
			// A worktree.
			commands.registerCommand('git.volt.openWorktree', (node: WorktreeNode) =>
				commands.executeCommand('vscode.openFolder', Uri.file(node.worktree.path), { forceReuseWindow: true })),
			commands.registerCommand('git.volt.openWorktreeInNewWindow', (node: WorktreeNode) =>
				commands.executeCommand('vscode.openFolder', Uri.file(node.worktree.path), { forceNewWindow: true })),
			commands.registerCommand('git.volt.revealWorktree', (node: WorktreeNode) => commands.executeCommand('revealFileInOS', Uri.file(node.worktree.path))),
			commands.registerCommand('git.volt.deleteWorktree', (node: WorktreeNode) => this.deleteWorktree(node)),
		);
	}

	/** The repository the views list: the one selected in Source Control, else the first. */
	private repository(): Repository | undefined {
		return this.model.repositories.find(repository => repository.sourceControl.selected) ?? this.model.repositories[0];
	}

	private async deleteBranch(node: BranchNode): Promise<void> {
		const name = node.branch.name!;
		if (!await confirm(l10n.t('Are you sure you want to delete the branch "{0}"?', name), l10n.t('Delete Branch'))) {
			return;
		}
		try {
			await node.repository.deleteBranch(name, false);
		} catch (err) {
			if ((err as GitError).gitErrorCode !== GitErrorCodes.BranchNotFullyMerged) {
				void window.showErrorMessage(gitErrorText(err));
				return;
			}
			if (await confirm(l10n.t('The branch "{0}" is not fully merged. Delete anyway?', name), l10n.t('Delete Branch'))) {
				await runGit(() => node.repository.deleteBranch(name, true));
			}
		}
	}

	/** `origin/feature` checks out a local `feature` tracking it, or the existing local one. */
	private async checkoutRemoteBranch(node: RemoteBranchNode): Promise<void> {
		const { repository, ref } = node;
		const local = ref.name!.slice(`${ref.remote}/`.length);
		const exists = repository.refs.some(candidate => candidate.type === RefType.Head && candidate.name === local);
		await runGit(() => exists ? repository.checkout(local) : repository.checkoutTracking(ref.name!));
	}

	private async deleteRemoteBranch(node: RemoteBranchNode): Promise<void> {
		const { repository, ref } = node;
		const name = ref.name!.slice(`${ref.remote}/`.length);
		if (await confirm(l10n.t('Are you sure you want to delete the branch "{0}" on the remote "{1}"?', name, ref.remote!), l10n.t('Delete Remote Branch'))) {
			await runGit(() => repository.deleteRemoteRef(ref.remote!, name));
		}
	}

	private async removeRemote(node: RemoteNode): Promise<void> {
		if (await confirm(l10n.t('Are you sure you want to remove the remote "{0}"?', node.remote.name), l10n.t('Remove Remote'))) {
			await runGit(() => node.repository.removeRemote(node.remote.name));
		}
	}

	private async pushTag(node: TagNode): Promise<void> {
		const { repository, ref } = node;
		const remotes = repository.remotes.filter(remote => !remote.isReadOnly);
		if (!remotes.length) {
			void window.showErrorMessage(l10n.t('Your repository has no remotes configured to push to.'));
			return;
		}
		const remote = remotes.length === 1 ? remotes[0].name : (await window.showQuickPick(remotes.map(candidate => candidate.name), { placeHolder: l10n.t('Pick a remote to push the tag "{0}" to:', ref.name!) }));
		if (remote) {
			await runGit(() => repository.pushTo(remote, `refs/tags/${ref.name}`));
		}
	}

	private async deleteTag(node: TagNode): Promise<void> {
		if (await confirm(l10n.t('Are you sure you want to delete the tag "{0}"?', node.ref.name!), l10n.t('Delete Tag'))) {
			await runGit(() => node.repository.deleteTag(node.ref.name!));
		}
	}

	private async deleteWorktree(node: WorktreeNode): Promise<void> {
		const { repository, worktree } = node;
		if (!await confirm(l10n.t('Are you sure you want to delete the worktree at "{0}"?', worktree.path), l10n.t('Delete Worktree'))) {
			return;
		}
		try {
			await repository.deleteWorktree(worktree.path);
		} catch (err) {
			if ((err as GitError).gitErrorCode !== GitErrorCodes.WorktreeContainsChanges) {
				void window.showErrorMessage(gitErrorText(err));
				return;
			}
			if (await confirm(l10n.t('The worktree at "{0}" has changes. Delete it anyway?', worktree.path), l10n.t('Delete Worktree'))) {
				await runGit(() => repository.deleteWorktree(worktree.path, { force: true }));
			}
		}
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
