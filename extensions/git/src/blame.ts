/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DecorationOptions, l10n, Position, Range, TextEditor, TextEditorChange, TextEditorDecorationType, TextEditorChangeKind, ThemeColor, Uri, window, workspace, EventEmitter, ConfigurationChangeEvent, StatusBarItem, StatusBarAlignment, Command, MarkdownString, languages, HoverProvider, CancellationToken, CancellationTokenSource, Hover, TextDocument } from 'vscode';
import { Model } from './model';
import { dispose, fromNow, getCommitShortHash, IDisposable, relativePath, truncate } from './util';
import { Repository } from './repository';
import { throttle } from './decorators';
import { BlameInformation, Commit } from './git';
import { fromGitUri, isGitUri, toGitUri } from './uri';
import { emojify, ensureEmojis } from './emoji';
import { getWorkingTreeAndIndexDiffInformation, getWorkingTreeDiffInformation } from './staging';
import { provideSourceControlHistoryItemAvatar, provideSourceControlHistoryItemHoverCommands, provideSourceControlHistoryItemMessageLinks } from './historyItemDetailsProvider';
import { AvatarQuery, AvatarQueryCommit } from './api/git';
import { LRUCache } from './cache';
import { detectCodingAgents } from './agentAttribution';

const AVATAR_SIZE = 20;

/** The subject length in the inline editor decoration. */
const EDITOR_DECORATION_SUBJECT_MAX_LENGTH = 60;

/** How long the hover waits for the branch of a commit (`git name-rev`). */
const BRANCH_NAME_TIMEOUT = 800;

/** Arguments of the `git.blame.openFileChanges` command, after the document and the commit hash. */
export interface BlameFileChangesDetails {
	/** The repository-relative path of the file in the commit. */
	readonly path?: string;
	/** The parent commit and the path of the file in it; missing when the commit added the file. */
	readonly previousHash?: string;
	readonly previousPath?: string;
}

function lineRangesContainLine(changes: readonly TextEditorChange[], lineNumber: number): boolean {
	return changes.some(c => c.modified.startLineNumber <= lineNumber && lineNumber < c.modified.endLineNumberExclusive);
}

function lineRangeLength(startLineNumber: number, endLineNumberExclusive: number): number {
	return endLineNumberExclusive - startLineNumber;
}

function mapModifiedLineNumberToOriginalLineNumber(lineNumber: number, changes: readonly TextEditorChange[]): number {
	if (changes.length === 0) {
		return lineNumber;
	}

	for (const change of changes) {
		// Do not process changes after the line number
		if (lineNumber < change.modified.startLineNumber) {
			break;
		}

		// Map line number to the original line number
		if (change.kind === TextEditorChangeKind.Addition) {
			// Addition
			lineNumber = lineNumber - lineRangeLength(change.modified.startLineNumber, change.modified.endLineNumberExclusive);
		} else if (change.kind === TextEditorChangeKind.Deletion) {
			// Deletion
			lineNumber = lineNumber + lineRangeLength(change.original.startLineNumber, change.original.endLineNumberExclusive);
		} else if (change.kind === TextEditorChangeKind.Modification) {
			// Modification
			const originalRangeLength = lineRangeLength(change.original.startLineNumber, change.original.endLineNumberExclusive);
			const modifiedRangeLength = lineRangeLength(change.modified.startLineNumber, change.modified.endLineNumberExclusive);

			if (originalRangeLength !== modifiedRangeLength) {
				lineNumber = lineNumber - (modifiedRangeLength - originalRangeLength);
			}
		} else {
			throw new Error('Unexpected change kind');
		}
	}

	return lineNumber;
}

function getEditorDecorationRange(lineNumber: number): Range {
	const position = new Position(lineNumber, Number.MAX_SAFE_INTEGER);
	return new Range(position, position);
}

function isResourceSchemeSupported(uri: Uri): boolean {
	return uri.scheme === 'file' || isGitUri(uri);
}

function isResourceBlameInformationEqual(a: ResourceBlameInformation | undefined, b: ResourceBlameInformation | undefined): boolean {
	if (a === b) {
		return true;
	}

	if (!a || !b ||
		a.resource.toString() !== b.resource.toString() ||
		a.blameInformation.length !== b.blameInformation.length) {
		return false;
	}

	for (let index = 0; index < a.blameInformation.length; index++) {
		if (a.blameInformation[index].lineNumber !== b.blameInformation[index].lineNumber ||
			a.blameInformation[index].blameLineNumber !== b.blameInformation[index].blameLineNumber) {
			return false;
		}

		const aBlameInformation = a.blameInformation[index].blameInformation;
		const bBlameInformation = b.blameInformation[index].blameInformation;

		if (typeof aBlameInformation === 'string' && typeof bBlameInformation === 'string') {
			if (aBlameInformation !== bBlameInformation) {
				return false;
			}
		} else if (typeof aBlameInformation !== 'string' && typeof bBlameInformation !== 'string') {
			if (aBlameInformation.hash !== bBlameInformation.hash) {
				return false;
			}
		} else {
			return false;
		}
	}

	return true;
}

type BlameInformationTemplateTokens = {
	readonly hash: string;
	readonly hashShort: string;
	readonly subject: string;
	readonly authorName: string;
	readonly authorEmail: string;
	readonly authorDate: string;
	readonly authorDateAgo: string;
};

interface ResourceBlameInformation {
	readonly resource: Uri;
	readonly repository?: Repository;
	readonly blameInformation: readonly LineBlameInformation[];
}

interface LineBlameInformation {
	/** 0-based line of the editor. */
	readonly lineNumber: number;
	/** 1-based line in the blamed revision of the file (HEAD for files on disk). */
	readonly blameLineNumber?: number;
	readonly blameInformation: BlameInformation | string;
}

function getRepositoryRelativePath(repository: Repository, uri: Uri): string {
	const fsPath = isGitUri(uri) ? fromGitUri(uri).path : uri.fsPath;
	return relativePath(repository.root, fsPath).replace(/\\/g, '/');
}

function commandLink(label: string, command: string, args: unknown, title: string): string {
	return `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))} "${title}")`;
}

class GitBlameInformationCache {
	private readonly _cache = new Map<Repository, LRUCache<string, BlameInformation[]>>();

	delete(repository: Repository): boolean {
		return this._cache.delete(repository);
	}

	get(repository: Repository, resource: Uri, commit: string): BlameInformation[] | undefined {
		const key = this._getCacheKey(resource, commit);
		return this._cache.get(repository)?.get(key);
	}

	set(repository: Repository, resource: Uri, commit: string, blameInformation: BlameInformation[]): void {
		if (!this._cache.has(repository)) {
			this._cache.set(repository, new LRUCache<string, BlameInformation[]>(100));
		}

		const key = this._getCacheKey(resource, commit);
		this._cache.get(repository)!.set(key, blameInformation);
	}

	private _getCacheKey(resource: Uri, commit: string): string {
		return toGitUri(resource, commit).toString();
	}
}

export class GitBlameController {
	private readonly _subjectMaxLength = 50;

	private readonly _onDidChangeBlameInformation = new EventEmitter<void>();
	public readonly onDidChangeBlameInformation = this._onDidChangeBlameInformation.event;

	private _textEditorBlameInformation: ResourceBlameInformation | undefined;
	get textEditorBlameInformation(): ResourceBlameInformation | undefined {
		return this._textEditorBlameInformation;
	}
	private set textEditorBlameInformation(blameInformation: ResourceBlameInformation | undefined) {
		if (isResourceBlameInformationEqual(this._textEditorBlameInformation, blameInformation)) {
			return;
		}

		this._textEditorBlameInformation = blameInformation;
		this._onDidChangeBlameInformation.fire();
	}

	private _HEAD: string | undefined;
	private readonly _commitInformationCache = new LRUCache<string, Commit>(100);
	private readonly _repositoryBlameCache = new GitBlameInformationCache();

	/** `user.email` of each repository, lower case; an empty string when it is not set. */
	private readonly _userEmails = new Map<Repository, string>();
	private readonly _userEmailRequests = new Map<Repository, Promise<string>>();

	/** The local branch of a commit per `root\0hash`; `null` when there is none (or it took too long). */
	private readonly _branchNameCache = new LRUCache<string, string | null>(500);

	private _editorDecoration: GitBlameEditorDecoration | undefined;
	private _statusBarItem: GitBlameStatusBarItem | undefined;

	private _repositoryDisposables = new Map<Repository, IDisposable[]>();
	private _enablementDisposables: IDisposable[] = [];
	private _disposables: IDisposable[] = [];

	constructor(private readonly _model: Model) {
		workspace.onDidChangeConfiguration(this._onDidChangeConfiguration, this, this._disposables);
		this._onDidChangeConfiguration();
	}

	formatBlameInformationMessage(documentUri: Uri, template: string, blameInformation: BlameInformation, repository?: Repository, subjectMaxLength = this._subjectMaxLength): string {
		const templateTokens = {
			hash: blameInformation.hash,
			hashShort: getCommitShortHash(documentUri, blameInformation.hash),
			subject: emojify(truncate(blameInformation.subject ?? '', subjectMaxLength)),
			authorName: this._getAuthorDisplayName(repository, blameInformation.authorName, blameInformation.authorEmail) ?? '',
			authorEmail: blameInformation.authorEmail ?? '',
			authorDate: new Date(blameInformation.authorDate ?? new Date()).toLocaleString(),
			authorDateAgo: fromNow(blameInformation.authorDate ?? new Date(), true, true)
		} satisfies BlameInformationTemplateTokens;

		return template.replace(/\$\{(.+?)\}/g, (_, token) => {
			return token in templateTokens ? templateTokens[token as keyof BlameInformationTemplateTokens] : `\${${token}}`;
		});
	}

	/**
	 * @param lineNumber 1-based line in the blamed revision of the file, for the line history and explain actions.
	 */
	async getBlameInformationHover(documentUri: Uri, blameInformation: BlameInformation, lineNumber?: number): Promise<MarkdownString> {
		const remoteHoverCommands: Command[] = [];
		let commitAvatar: string | undefined;
		let commitInformation: Commit | undefined;
		let commitMessageWithLinks: string | undefined;
		let branchName: string | undefined;

		const repository = this._model.getRepository(documentUri);
		if (repository) {
			// The branch is only needed here, and resolved next to the other details
			const branchNamePromise = this._getBranchName(repository, blameInformation.hash);

			try {
				// Commit details
				commitInformation = this._commitInformationCache.get(blameInformation.hash);
				if (!commitInformation) {
					commitInformation = await repository.getCommit(blameInformation.hash);
					this._commitInformationCache.set(blameInformation.hash, commitInformation);
				}

				// Avatar
				const avatarQuery = {
					commits: [{
						hash: blameInformation.hash,
						authorName: blameInformation.authorName,
						authorEmail: blameInformation.authorEmail
					} satisfies AvatarQueryCommit],
					size: AVATAR_SIZE
				} satisfies AvatarQuery;

				const avatarResult = await provideSourceControlHistoryItemAvatar(this._model, repository, avatarQuery);
				commitAvatar = avatarResult?.get(blameInformation.hash);
			} catch { }

			// Remote hover commands
			const unpublishedCommits = await repository.getUnpublishedCommits();
			if (!unpublishedCommits.has(blameInformation.hash)) {
				remoteHoverCommands.push(...await provideSourceControlHistoryItemHoverCommands(this._model, repository) ?? []);
			}

			// Message links
			commitMessageWithLinks = await provideSourceControlHistoryItemMessageLinks(
				this._model, repository, commitInformation?.message ?? blameInformation.subject ?? '');

			branchName = await branchNamePromise;
		}

		const markdownString = new MarkdownString();
		markdownString.isTrusted = {
			enabledCommands: [
				'git.viewCommit',
				'git.copyContentToClipboard',
				'git.blame.openFileChanges',
				'volt.gitGraph.open',
				'volt.gitGraph.askAgent',
				'workbench.action.openSettings',
				...remoteHoverCommands.map(command => command.command)
			]
		};
		markdownString.supportThemeIcons = true;

		// Author, date
		const hash = commitInformation?.hash ?? blameInformation.hash;
		const authorEmail = commitInformation?.authorEmail ?? blameInformation.authorEmail;
		const authorName = this._getAuthorDisplayName(repository, commitInformation?.authorName ?? blameInformation.authorName, authorEmail);
		const authorDate = commitInformation?.authorDate ?? blameInformation.authorDate;
		const avatar = commitAvatar ? `![${authorName}](${commitAvatar}|width=${AVATAR_SIZE},height=${AVATAR_SIZE})` : '$(account)';


		if (authorName) {
			if (authorEmail) {
				const emailTitle = l10n.t('Email');
				markdownString.appendMarkdown(`${avatar} [**${authorName}**](mailto:${authorEmail} "${emailTitle} ${authorName}")`);
			} else {
				markdownString.appendMarkdown(`${avatar} **${authorName}**`);
			}

			if (authorDate) {
				const dateString = new Date(authorDate).toLocaleString(undefined, {
					year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric'
				});
				markdownString.appendMarkdown(`, $(history) ${fromNow(authorDate, true, true)} (${dateString})`);
			}

			if (branchName) {
				markdownString.appendMarkdown(`&nbsp;&nbsp;$(git-branch) ${branchName.replace(/[\\`*_{}[\]()#+!|<>~]/g, '\\$&')}`);
			}

			markdownString.appendMarkdown('\n\n');
		}

		// Coding agents credited in the `Co-authored-by:` trailers
		const codingAgents = detectCodingAgents(commitInformation?.message ?? '');
		if (codingAgents.length > 0) {
			const agentNames = codingAgents.map(agent => `**${agent.name}**`).join(', ');
			markdownString.appendMarkdown(`$(sparkle) ${l10n.t('Written with {0}', agentNames)}\n\n`);
		}

		// Subject | Message
		// A plain message is text, not Markdown (a merge's "# Conflicts:" lines would be headings);
		// the linked one comes from a hover provider as Markdown.
		if (commitMessageWithLinks) {
			markdownString.appendMarkdown(`${emojify(commitMessageWithLinks.replace(/\r\n|\r|\n/g, '\n\n'))}\n\n`);
		} else {
			markdownString.appendText(emojify((commitInformation?.message ?? blameInformation.subject ?? '').replace(/\r\n|\r/g, '\n')));
			markdownString.appendMarkdown('\n\n');
		}
		markdownString.appendMarkdown(`---\n\n`);

		// Short stats
		if (commitInformation?.shortStat) {
			markdownString.appendMarkdown(`<span>${commitInformation.shortStat.files === 1 ?
				l10n.t('{0} file changed', commitInformation.shortStat.files) :
				l10n.t('{0} files changed', commitInformation.shortStat.files)}</span>`);

			if (commitInformation.shortStat.insertions) {
				markdownString.appendMarkdown(`,&nbsp;<span style="color:var(--vscode-scmGraph-historyItemHoverAdditionsForeground);">${commitInformation.shortStat.insertions === 1 ?
					l10n.t('{0} insertion{1}', commitInformation.shortStat.insertions, '(+)') :
					l10n.t('{0} insertions{1}', commitInformation.shortStat.insertions, '(+)')}</span>`);
			}

			if (commitInformation.shortStat.deletions) {
				markdownString.appendMarkdown(`,&nbsp;<span style="color:var(--vscode-scmGraph-historyItemHoverDeletionsForeground);">${commitInformation.shortStat.deletions === 1 ?
					l10n.t('{0} deletion{1}', commitInformation.shortStat.deletions, '(-)') :
					l10n.t('{0} deletions{1}', commitInformation.shortStat.deletions, '(-)')}</span>`);
			}

			markdownString.appendMarkdown(`\n\n---\n\n`);
		}

		// Commands
		markdownString.appendMarkdown(`[\`$(git-commit) ${getCommitShortHash(documentUri, hash)} \`](command:git.viewCommit?${encodeURIComponent(JSON.stringify([documentUri, hash, documentUri]))} "${l10n.t('Open Commit')}")`);
		markdownString.appendMarkdown('&nbsp;');
		markdownString.appendMarkdown(`[$(copy)](command:git.copyContentToClipboard?${encodeURIComponent(JSON.stringify(hash))} "${l10n.t('Copy Commit Hash')}")`);

		// File and line actions
		if (repository) {
			const repositoryRoot = repository.root;
			const relPath = getRepositoryRelativePath(repository, documentUri);
			// History query values with spaces are quoted
			const queryPath = /\s/.test(relPath) ? `"${relPath}"` : relPath;
			const fileChangesDetails = this._getFileChangesDetails(blameInformation);

			const actions = [
				commandLink(`$(diff) ${l10n.t('Open Changes')}`, 'git.blame.openFileChanges', [documentUri, hash, documentUri, fileChangesDetails], l10n.t('Open the changes of this file in the commit')),
				commandLink(`$(type-hierarchy) ${l10n.t('Open in Git Graph')}`, 'volt.gitGraph.open', [{ repositoryRoot, revealCommit: hash }], l10n.t('Reveal the commit in the Git Graph')),
				commandLink(`$(history) ${l10n.t('File History')}`, 'volt.gitGraph.open', [{ repositoryRoot, query: `path:${queryPath}` }], l10n.t('Show the history of this file')),
			];

			if (typeof lineNumber === 'number') {
				actions.push(
					commandLink(`$(list-flat) ${l10n.t('Line History')}`, 'volt.gitGraph.open', [{ repositoryRoot, query: `lines:${lineNumber}-${lineNumber}:${queryPath}` }], l10n.t('Show the history of this line')),
					commandLink(`$(sparkle) ${l10n.t('Explain')}`, 'volt.gitGraph.askAgent', [{ repositoryRoot, action: 'explain', commit: hash, path: relPath, startLine: lineNumber, endLine: lineNumber }], l10n.t('Ask an agent to explain this change')));
			}

			markdownString.appendMarkdown('&nbsp;&nbsp;|&nbsp;&nbsp;');
			markdownString.appendMarkdown(actions.join('&nbsp;&nbsp;'));
		}

		// Remote hover commands
		if (remoteHoverCommands.length > 0) {
			markdownString.appendMarkdown('&nbsp;&nbsp;|&nbsp;&nbsp;');

			const remoteCommandsMarkdown = remoteHoverCommands
				.map(command => `[${command.title}](command:${command.command}?${encodeURIComponent(JSON.stringify([...command.arguments ?? [], hash]))} "${command.tooltip}")`);
			markdownString.appendMarkdown(remoteCommandsMarkdown.join('&nbsp;'));
		}

		markdownString.appendMarkdown('&nbsp;&nbsp;|&nbsp;&nbsp;');
		markdownString.appendMarkdown(`[$(gear)](command:workbench.action.openSettings?%5B%22git.blame%22%5D "${l10n.t('Open Settings')}")`);

		return markdownString;
	}

	/** The hover of a line that is not committed yet: the message and the settings. */
	getUncommittedHover(message: string): MarkdownString {
		const markdownString = new MarkdownString();
		markdownString.isTrusted = { enabledCommands: ['workbench.action.openSettings'] };
		markdownString.supportThemeIcons = true;

		markdownString.appendText(message);
		markdownString.appendMarkdown('\n\n---\n\n');
		markdownString.appendMarkdown(`[$(gear)](command:workbench.action.openSettings?%5B%22git.blame%22%5D "${l10n.t('Open Settings')}")`);

		return markdownString;
	}

	/** "You" when the author is the repository's `user.email`, the author name otherwise. */
	private _getAuthorDisplayName(repository: Repository | undefined, authorName: string | undefined, authorEmail: string | undefined): string | undefined {
		if (repository && authorEmail) {
			const userEmail = this._userEmails.get(repository);
			if (userEmail && userEmail === authorEmail.toLowerCase()) {
				return l10n.t('You');
			}
		}

		return authorName;
	}

	/** Reads `user.email` once per repository; the decorations update when it arrives. */
	private _ensureUserEmail(repository: Repository): void {
		if (!this._userEmails.has(repository) && !this._userEmailRequests.has(repository)) {
			this._loadUserEmail(repository);
		}
	}

	private _loadUserEmail(repository: Repository): void {
		const request = repository.getEffectiveConfig('user.email')
			.then(value => value.trim().toLowerCase(), () => '');
		this._userEmailRequests.set(repository, request);

		request.then(userEmail => {
			if (this._userEmailRequests.get(repository) !== request) {
				// The repository was closed, or a newer request replaced this one
				return;
			}

			this._userEmailRequests.delete(repository);

			const previousUserEmail = this._userEmails.get(repository) ?? '';
			this._userEmails.set(repository, userEmail);

			if (userEmail !== previousUserEmail && this._textEditorBlameInformation?.repository === repository) {
				this._onDidChangeBlameInformation.fire();
			}
		});
	}

	private async _getBranchName(repository: Repository, hash: string): Promise<string | undefined> {
		const key = `${repository.root}\0${hash}`;
		const cached = this._branchNameCache.get(key);
		if (cached !== undefined) {
			return cached ?? undefined;
		}

		const cancellationTokenSource = new CancellationTokenSource();
		const timeout = setTimeout(() => cancellationTokenSource.cancel(), BRANCH_NAME_TIMEOUT);

		try {
			const branchName = await repository.getBranchNameOfCommit(hash, cancellationTokenSource.token);
			this._branchNameCache.set(key, branchName ?? null);
			return branchName;
		} catch {
			// Timed out, or no branch contains the commit
			this._branchNameCache.set(key, null);
			return undefined;
		} finally {
			clearTimeout(timeout);
			cancellationTokenSource.dispose();
		}
	}

	private _getFileChangesDetails(blameInformation: BlameInformation): BlameFileChangesDetails | undefined {
		// Quoted paths (unusual characters) are left to the command, which uses the document path
		if (!blameInformation.filename || blameInformation.filename.startsWith('"')) {
			return undefined;
		}

		const previous = blameInformation.previous;
		if (previous?.filename.startsWith('"')) {
			return undefined;
		}

		return {
			path: blameInformation.filename,
			previousHash: previous?.hash,
			previousPath: previous?.filename
		};
	}

	private _onDidChangeConfiguration(e?: ConfigurationChangeEvent): void {
		if (e &&
			!e.affectsConfiguration('git.blame.editorDecoration.enabled') &&
			!e.affectsConfiguration('git.blame.statusBarItem.enabled')) {
			return;
		}

		const config = workspace.getConfiguration('git');
		const editorDecorationEnabled = config.get<boolean>('blame.editorDecoration.enabled') === true;
		const statusBarItemEnabled = config.get<boolean>('blame.statusBarItem.enabled') === true;

		// Editor decoration
		if (editorDecorationEnabled) {
			if (!this._editorDecoration) {
				this._editorDecoration = new GitBlameEditorDecoration(this);
			}
		} else {
			this._editorDecoration?.dispose();
			this._editorDecoration = undefined;
		}

		// StatusBar item
		if (statusBarItemEnabled) {
			if (!this._statusBarItem) {
				this._statusBarItem = new GitBlameStatusBarItem(this);
			}
		} else {
			this._statusBarItem?.dispose();
			this._statusBarItem = undefined;
		}

		// Listeners
		if (editorDecorationEnabled || statusBarItemEnabled) {
			if (this._enablementDisposables.length === 0) {
				this._model.onDidOpenRepository(this._onDidOpenRepository, this, this._enablementDisposables);
				this._model.onDidCloseRepository(this._onDidCloseRepository, this, this._enablementDisposables);
				for (const repository of this._model.repositories) {
					this._onDidOpenRepository(repository);
				}

				window.onDidChangeActiveTextEditor(e => this._updateTextEditorBlameInformation(e), this, this._enablementDisposables);
				window.onDidChangeTextEditorSelection(e => this._updateTextEditorBlameInformation(e.textEditor, 'selection'), this, this._enablementDisposables);
				window.onDidChangeTextEditorDiffInformation(e => this._updateTextEditorBlameInformation(e.textEditor), this, this._enablementDisposables);
			}
		} else {
			this._enablementDisposables = dispose(this._enablementDisposables);
		}

		this._updateTextEditorBlameInformation(window.activeTextEditor);
	}

	private _onDidOpenRepository(repository: Repository): void {
		const repositoryDisposables: IDisposable[] = [];
		repository.onDidRunGitStatus(() => this._onDidRunGitStatus(repository), this, repositoryDisposables);

		// Re-read `user.email` when the repository config changes
		repository.onDidChangeRepository(uri => {
			if (/[\\/]config$/.test(uri.path) && (this._userEmails.has(repository) || this._userEmailRequests.has(repository))) {
				this._loadUserEmail(repository);
			}
		}, this, repositoryDisposables);

		this._repositoryDisposables.set(repository, repositoryDisposables);
	}

	private _onDidCloseRepository(repository: Repository): void {
		const disposables = this._repositoryDisposables.get(repository);
		if (disposables) {
			dispose(disposables);
		}

		this._repositoryDisposables.delete(repository);
		this._repositoryBlameCache.delete(repository);
		this._userEmails.delete(repository);
		this._userEmailRequests.delete(repository);
	}

	private _onDidRunGitStatus(repository: Repository): void {
		if (!repository.HEAD?.commit || this._HEAD === repository.HEAD.commit) {
			return;
		}

		this._HEAD = repository.HEAD.commit;
		this._updateTextEditorBlameInformation(window.activeTextEditor);
	}

	private async _getBlameInformation(resource: Uri, commit: string): Promise<BlameInformation[] | undefined> {
		const repository = this._model.getRepository(resource);
		if (!repository) {
			return undefined;
		}

		const resourceBlameInformation = this._repositoryBlameCache.get(repository, resource, commit);
		if (resourceBlameInformation) {
			return resourceBlameInformation;
		}

		// Ensure that the emojis are loaded as we will need
		// access to them when formatting the blame information.
		await ensureEmojis();

		// Get blame information for the resource and cache it
		const blameInformation = await repository.blame2(resource.fsPath, commit) ?? [];
		this._repositoryBlameCache.set(repository, resource, commit, blameInformation);

		return blameInformation;
	}

	@throttle
	private async _updateTextEditorBlameInformation(textEditor: TextEditor | undefined, reason?: 'selection'): Promise<void> {
		if (textEditor) {
			if (!textEditor.diffInformation || textEditor !== window.activeTextEditor) {
				return;
			}
		} else {
			this.textEditorBlameInformation = undefined;
			return;
		}

		const repository = this._model.getRepository(textEditor.document.uri);
		if (!repository || !repository.HEAD?.commit) {
			return;
		}

		this._ensureUserEmail(repository);

		// Only support resources with `file` and `git` schemes
		if (!isResourceSchemeSupported(textEditor.document.uri)) {
			this.textEditorBlameInformation = undefined;
			return;
		}

		// Do not show blame information when there is a single selection and it is at the beginning
		// of the file [0, 0, 0, 0] unless the user explicitly navigates the cursor there. We do this
		// to avoid showing blame information when the editor is not focused.
		if (reason !== 'selection' && textEditor.selections.length === 1 &&
			textEditor.selections[0].start.line === 0 && textEditor.selections[0].start.character === 0 &&
			textEditor.selections[0].end.line === 0 && textEditor.selections[0].end.character === 0) {
			this.textEditorBlameInformation = undefined;
			return;
		}

		let allChanges: readonly TextEditorChange[];
		let workingTreeChanges: readonly TextEditorChange[];
		let workingTreeAndIndexChanges: readonly TextEditorChange[] | undefined;

		if (isGitUri(textEditor.document.uri)) {
			const { ref } = fromGitUri(textEditor.document.uri);

			// For the following scenarios we can discard the diff information
			// 1) Commit - Resource in the multi-file diff editor when viewing the details of a commit.
			// 2) HEAD   - Resource on the left-hand side of the diff editor when viewing a resource from the index.
			// 3) ~      - Resource on the left-hand side of the diff editor when viewing a resource from the working tree.
			if (/^[0-9a-f]{40}$/i.test(ref) || ref === 'HEAD' || ref === '~') {
				workingTreeChanges = allChanges = [];
				workingTreeAndIndexChanges = undefined;
			} else if (ref === '') {
				// Resource on the right-hand side of the diff editor when viewing a resource from the index.
				const diffInformationWorkingTreeAndIndex = getWorkingTreeAndIndexDiffInformation(textEditor);

				// Working tree + index diff information is present and it is stale. Diff information
				// may be stale when the selection changes because of a content change and the diff
				// information is not yet updated.
				if (diffInformationWorkingTreeAndIndex && diffInformationWorkingTreeAndIndex.isStale) {
					this.textEditorBlameInformation = undefined;
					return;
				}

				workingTreeChanges = [];
				workingTreeAndIndexChanges = allChanges = diffInformationWorkingTreeAndIndex?.changes ?? [];
			} else {
				throw new Error(`Unexpected ref: ${ref}`);
			}
		} else {
			// Working tree diff information. Diff Editor (Working Tree) -> Text Editor
			const diffInformationWorkingTree = getWorkingTreeDiffInformation(textEditor);

			// Working tree diff information is not present or it is stale. Diff information
			// may be stale when the selection changes because of a content change and the diff
			// information is not yet updated.
			if (!diffInformationWorkingTree || diffInformationWorkingTree.isStale) {
				this.textEditorBlameInformation = undefined;
				return;
			}

			// Working tree + index diff information
			const diffInformationWorkingTreeAndIndex = getWorkingTreeAndIndexDiffInformation(textEditor);

			// Working tree + index diff information is present and it is stale. Diff information
			// may be stale when the selection changes because of a content change and the diff
			// information is not yet updated.
			if (diffInformationWorkingTreeAndIndex && diffInformationWorkingTreeAndIndex.isStale) {
				this.textEditorBlameInformation = undefined;
				return;
			}

			workingTreeChanges = diffInformationWorkingTree.changes;
			workingTreeAndIndexChanges = diffInformationWorkingTreeAndIndex?.changes;

			// For staged resources, we provide an additional "original resource" so that the editor
			// diff information contains both the changes that are in the working tree and the changes
			// that are in the working tree + index.
			allChanges = workingTreeAndIndexChanges ?? workingTreeChanges;
		}

		let commit: string;
		if (!isGitUri(textEditor.document.uri)) {
			// Resource with the `file` scheme
			commit = repository.HEAD.commit;
		} else {
			// Resource with the `git` scheme
			const { ref } = fromGitUri(textEditor.document.uri);
			commit = /^[0-9a-f]{40}$/i.test(ref) ? ref : repository.HEAD.commit;
		}

		// Git blame information
		const resourceBlameInformation = await this._getBlameInformation(textEditor.document.uri, commit);
		if (!resourceBlameInformation) {
			return;
		}

		const lineBlameInformation: LineBlameInformation[] = [];
		for (const lineNumber of new Set(textEditor.selections.map(s => s.active.line))) {
			// Check if the line is contained in the working tree diff information
			if (lineRangesContainLine(workingTreeChanges, lineNumber + 1)) {
				if (reason === 'selection') {
					// Only show the `Uncommitted changes` message upon selection change due to navigation
					lineBlameInformation.push({ lineNumber, blameInformation: l10n.t('You, Uncommitted changes') });
				}
				continue;
			}

			// Check if the line is contained in the working tree + index diff information
			if (lineRangesContainLine(workingTreeAndIndexChanges ?? [], lineNumber + 1)) {
				lineBlameInformation.push({ lineNumber, blameInformation: l10n.t('You, Uncommitted changes (Staged)') });
				continue;
			}

			// Map the line number to the git blame ranges using the diff information
			const lineNumberWithDiff = mapModifiedLineNumberToOriginalLineNumber(lineNumber + 1, allChanges);
			const blameInformation = resourceBlameInformation.find(blameInformation => {
				return blameInformation.ranges.find(range => {
					return lineNumberWithDiff >= range.startLineNumber && lineNumberWithDiff <= range.endLineNumber;
				});
			});

			if (blameInformation) {
				lineBlameInformation.push({ lineNumber, blameLineNumber: lineNumberWithDiff, blameInformation });
			}
		}

		this.textEditorBlameInformation = {
			resource: textEditor.document.uri,
			repository,
			blameInformation: lineBlameInformation
		};
	}

	dispose() {
		for (const disposables of this._repositoryDisposables.values()) {
			dispose(disposables);
		}
		this._repositoryDisposables.clear();

		this._disposables = dispose(this._disposables);
	}
}

class GitBlameEditorDecoration implements HoverProvider {
	private _template = '';
	private _decoration: TextEditorDecorationType;

	private _hoverDisposable: IDisposable | undefined;
	private _disposables: IDisposable[] = [];

	constructor(private readonly _controller: GitBlameController) {
		this._decoration = window.createTextEditorDecorationType({
			after: {
				color: new ThemeColor('git.blame.editorDecorationForeground'),
				fontStyle: 'normal',
				fontWeight: 'normal'
			}
		});
		this._disposables.push(this._decoration);

		workspace.onDidChangeConfiguration(this._onDidChangeConfiguration, this, this._disposables);
		window.onDidChangeActiveTextEditor(this._onDidChangeActiveTextEditor, this, this._disposables);
		this._controller.onDidChangeBlameInformation(() => this._onDidChangeBlameInformation(), this, this._disposables);

		this._onDidChangeConfiguration();
	}

	async provideHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const textEditor = window.activeTextEditor;
		if (!textEditor) {
			return undefined;
		}

		// Position must be at the end of the line
		if (position.character !== document.lineAt(position.line).range.end.character) {
			return undefined;
		}

		// Get blame information
		const blameInformation = this._controller.textEditorBlameInformation?.blameInformation;
		const lineBlameInformation = blameInformation?.find(blame => blame.lineNumber === position.line);

		if (!lineBlameInformation) {
			return undefined;
		}

		if (typeof lineBlameInformation.blameInformation === 'string') {
			const range = getEditorDecorationRange(position.line);
			return { range, contents: [this._controller.getUncommittedHover(lineBlameInformation.blameInformation)] };
		}

		const contents = await this._controller.getBlameInformationHover(textEditor.document.uri, lineBlameInformation.blameInformation, lineBlameInformation.blameLineNumber);

		if (!contents || token.isCancellationRequested) {
			return undefined;
		}

		return { range: getEditorDecorationRange(position.line), contents: [contents] };
	}

	private _onDidChangeConfiguration(e?: ConfigurationChangeEvent): void {
		if (e &&
			!e.affectsConfiguration('git.commitShortHashLength') &&
			!e.affectsConfiguration('git.blame.editorDecoration.template')) {
			return;
		}

		// Cache the decoration template
		const config = workspace.getConfiguration('git');
		this._template = config.get<string>('blame.editorDecoration.template', '${authorName}, ${authorDateAgo} • ${subject}');

		this._registerHoverProvider();
		this._onDidChangeBlameInformation();
	}

	private _onDidChangeActiveTextEditor(): void {
		// Clear decorations
		for (const editor of window.visibleTextEditors) {
			if (editor !== window.activeTextEditor) {
				editor.setDecorations(this._decoration, []);
			}
		}

		// Register hover provider
		this._registerHoverProvider();
	}

	private _onDidChangeBlameInformation(): void {
		const textEditor = window.activeTextEditor;
		if (!textEditor) {
			return;
		}

		// Get blame information
		const resourceBlameInformation = this._controller.textEditorBlameInformation;
		const blameInformation = resourceBlameInformation?.blameInformation;
		if (!blameInformation || blameInformation.length === 0) {
			textEditor.setDecorations(this._decoration, []);
			return;
		}

		// Set decorations for the editor
		const decorations = blameInformation.map(blame => {
			const contentText = typeof blame.blameInformation !== 'string'
				? this._controller.formatBlameInformationMessage(textEditor.document.uri, this._template, blame.blameInformation,
					resourceBlameInformation.repository, EDITOR_DECORATION_SUBJECT_MAX_LENGTH)
				: blame.blameInformation;

			return this._createDecoration(blame.lineNumber, contentText);
		});

		textEditor.setDecorations(this._decoration, decorations);
	}

	private _createDecoration(lineNumber: number, contentText: string): DecorationOptions {
		return {
			range: getEditorDecorationRange(lineNumber),
			renderOptions: {
				after: {
					contentText,
					margin: '0 0 0 3em'
				}
			},
		};
	}

	private _registerHoverProvider(): void {
		this._hoverDisposable?.dispose();

		if (window.activeTextEditor && isResourceSchemeSupported(window.activeTextEditor.document.uri)) {
			this._hoverDisposable = languages.registerHoverProvider({
				pattern: window.activeTextEditor.document.uri.fsPath
			}, this);
		}
	}

	dispose() {
		this._hoverDisposable?.dispose();
		this._hoverDisposable = undefined;

		this._disposables = dispose(this._disposables);
	}
}

class GitBlameStatusBarItem {
	private _template = '';
	private _statusBarItem: StatusBarItem;
	private _disposables: IDisposable[] = [];

	constructor(private readonly _controller: GitBlameController) {
		this._statusBarItem = window.createStatusBarItem('git.blame', StatusBarAlignment.Right, 200);
		this._statusBarItem.name = l10n.t('Git Blame Information');
		this._disposables.push(this._statusBarItem);

		workspace.onDidChangeConfiguration(this._onDidChangeConfiguration, this, this._disposables);
		this._controller.onDidChangeBlameInformation(() => this._onDidChangeBlameInformation(), this, this._disposables);

		this._onDidChangeConfiguration();
	}

	private _onDidChangeConfiguration(e?: ConfigurationChangeEvent): void {
		if (e &&
			!e.affectsConfiguration('git.commitShortHashLength') &&
			!e.affectsConfiguration('git.blame.statusBarItem.template')) {
			return;
		}

		// Cache the decoration template
		const config = workspace.getConfiguration('git');
		this._template = config.get<string>('blame.statusBarItem.template', '${authorName} (${authorDateAgo})');

		this._onDidChangeBlameInformation();
	}

	private async _onDidChangeBlameInformation(): Promise<void> {
		if (!window.activeTextEditor) {
			this._statusBarItem.hide();
			return;
		}

		const resourceBlameInformation = this._controller.textEditorBlameInformation;
		const blameInformation = resourceBlameInformation?.blameInformation;
		if (!blameInformation || blameInformation.length === 0) {
			this._statusBarItem.hide();
			return;
		}

		if (typeof blameInformation[0].blameInformation === 'string') {
			this._statusBarItem.text = `$(git-commit) ${blameInformation[0].blameInformation}`;
			this._statusBarItem.tooltip = l10n.t('Git Blame Information');
			this._statusBarItem.command = undefined;
		} else {
			this._statusBarItem.text = `$(git-commit) ${this._controller.formatBlameInformationMessage(
				window.activeTextEditor.document.uri, this._template, blameInformation[0].blameInformation, resourceBlameInformation.repository)}`;

			this._statusBarItem.tooltip2 = (cancellationToken: CancellationToken) => {
				return this._provideTooltip(window.activeTextEditor!.document.uri,
					blameInformation[0].blameInformation as BlameInformation, blameInformation[0].blameLineNumber, cancellationToken);
			};

			const uri = window.activeTextEditor.document.uri;
			const hash = blameInformation[0].blameInformation.hash;

			this._statusBarItem.command = {
				title: l10n.t('Open Commit'),
				command: 'git.viewCommit',
				arguments: [uri, hash, uri]
			} satisfies Command;
		}

		this._statusBarItem.show();
	}

	private async _provideTooltip(uri: Uri, blameInformation: BlameInformation, lineNumber: number | undefined, cancellationToken: CancellationToken): Promise<MarkdownString | undefined> {
		if (cancellationToken.isCancellationRequested) {
			return undefined;
		}

		const tooltip = await this._controller.getBlameInformationHover(uri, blameInformation, lineNumber);
		return cancellationToken.isCancellationRequested ? undefined : tooltip;
	}

	dispose() {
		this._disposables = dispose(this._disposables);
	}
}
