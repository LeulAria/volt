/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { Emitter, IValueWithChangeEvent } from '../../../../../base/common/event.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelContentProvider } from '../../../../../editor/common/services/resolverService.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IVoltGitService } from '../../../../../platform/voltGit/common/voltGit.js';
import { prKey } from '../../../../../platform/voltPullRequests/common/voltPullRequestParse.js';
import { IVoltPrRepoRef, voltPrErrorMessage } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IMultiDiffSourceResolver, IResolvedMultiDiffSource, MultiDiffEditorItem } from '../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { MultiDiffEditorInput } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';
import { IMultiDiffEditorOptions } from '../../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.js';
import { openInAgentTools } from '../workspace/agentSurfaceHost.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';

export const PR_DIFF_SCHEME = 'volt-agent-pr-diff';
export const PR_BLOB_SCHEME = 'volt-agent-pr-blob';

export interface IPrDiffTarget {
	readonly repo: IVoltPrRepoRef;
	readonly number: number;
	/** The local clone the diff reads from. */
	readonly folder: string;
}

export function prDiffUri(target: IPrDiffTarget): URI {
	return URI.from({
		scheme: PR_DIFF_SCHEME,
		path: `/${target.repo.host}/${target.repo.owner}/${target.repo.name}/${target.number}`,
		query: `folder=${encodeURIComponent(target.folder)}`,
	});
}

export function parsePrDiffUri(uri: URI): IPrDiffTarget | undefined {
	if (uri.scheme !== PR_DIFF_SCHEME) {
		return undefined;
	}
	const match = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(\d+)$/.exec(uri.path);
	const folder = new URLSearchParams(uri.query).get('folder');
	if (!match || !folder) {
		return undefined;
	}
	return { repo: { host: match[1], owner: match[2], name: match[3] }, number: Number(match[4]), folder };
}

interface IPrBlob {
	readonly repoRoot: string;
	readonly sha: string;
	readonly path: string;
	readonly key: string;
	readonly side: 'original' | 'modified';
}

function blobUri(blob: IPrBlob, viewed?: boolean): URI {
	return URI.from({
		scheme: PR_BLOB_SCHEME,
		path: `/${blob.path}`,
		query: `repo=${encodeURIComponent(blob.repoRoot)}&blob=${blob.sha}&pr=${encodeURIComponent(blob.key)}&side=${blob.side}${viewed === undefined ? '' : `&viewed=${viewed ? 1 : 0}`}`,
	});
}

export function parseBlobUri(uri: URI): (IPrBlob & { readonly viewed?: boolean }) | undefined {
	if (uri.scheme !== PR_BLOB_SCHEME) {
		return undefined;
	}
	const query = new URLSearchParams(uri.query);
	const repoRoot = query.get('repo');
	const sha = query.get('blob');
	const key = query.get('pr');
	const side = query.get('side');
	const viewed = query.get('viewed');
	if (!repoRoot || !sha || !/^[0-9a-f]{40,64}$/.test(sha) || !key || (side !== 'original' && side !== 'modified')) {
		return undefined;
	}
	return { repoRoot, sha, key, side, path: uri.path.replace(/^\/+/, ''), ...(viewed === null ? {} : { viewed: viewed === '1' }) };
}

/** A diff's files in the order GitHub lists them, with where to read each side. */
interface IPrDiffFile {
	readonly path: string;
	readonly oldPath?: string;
	readonly original?: IPrBlob;
	readonly modified?: IPrBlob;
}

/** Shown pull request diffs by source URI, so file toolbars and reveals find their items. */
const sources = new Map<string, PrResolvedSource>();

class PrResolvedSource extends Disposable implements IResolvedMultiDiffSource {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly resources: IValueWithChangeEvent<readonly MultiDiffEditorItem[]>;
	readonly contextKeys = { voltPrDiff: true };
	private items: readonly MultiDiffEditorItem[] = [];
	/** Paths marked viewed on GitHub, from the last detail read. */
	private viewed: ReadonlySet<string> = new Set();

	constructor(
		private readonly uri: URI,
		private readonly target: IPrDiffTarget,
		private readonly files: readonly IPrDiffFile[],
		pullRequests: IAgentPullRequestService,
	) {
		super();
		const self = this;
		this.resources = {
			get value() {
				return self.items;
			},
			onDidChange: this._onDidChange.event,
		};
		this.items = this.build(this.viewed);
		const key = prKey(target.repo, target.number);
		this._register(pullRequests.onDidReadDetail(detail => {
			if (detail.key === key) {
				this.setViewed(new Set(detail.files.filter(file => file.viewed === 'viewed').map(file => file.path)));
			}
		}));
		// The latest resolve of a source wins; the one it replaces stops listening.
		sources.get(uri.toString())?.dispose();
		sources.set(uri.toString(), this);
	}


	setViewed(viewed: ReadonlySet<string>): void {
		const before = [...this.viewed].sort().join('\n');
		this.viewed = viewed;
		if (before !== [...viewed].sort().join('\n')) {
			this.items = this.build(viewed);
			this._onDidChange.fire();
		}
	}

	private build(viewed: ReadonlySet<string>): MultiDiffEditorItem[] {
		return this.files.map(file => {
			const isViewed = viewed.has(file.path);
			const goTo = joinPath(URI.file(this.target.folder), file.path);
			return new MultiDiffEditorItem(
				file.original ? blobUri(file.original) : undefined,
				file.modified ? blobUri(file.modified, isViewed) : undefined,
				goTo,
				undefined,
				{ voltPrFile: true, voltPrFileViewed: isViewed },
			);
		});
	}

	itemFor(path: string): MultiDiffEditorItem | undefined {
		const index = this.files.findIndex(file => file.path === path);
		return index >= 0 ? this.items[index] : undefined;
	}

	pathOf(uri: URI): string | undefined {
		const blob = parseBlobUri(uri);
		return blob && this.files.find(file => file.modified?.sha === blob.sha && file.path === blob.path || file.original?.sha === blob.sha && (file.oldPath ?? file.path) === blob.path)?.path;
	}

	get prTarget(): IPrDiffTarget {
		return this.target;
	}

	get sourceUri(): URI {
		return this.uri;
	}
}

export class PrDiffSourceResolver implements IMultiDiffSourceResolver {

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVoltGitService private readonly git: IVoltGitService,
	) { }

	canHandleUri(uri: URI): boolean {
		return parsePrDiffUri(uri) !== undefined;
	}

	/** Asked for on first use: registering at startup must not start pull request syncing early. */
	private get pullRequests(): IAgentPullRequestService {
		return this.instantiationService.invokeFunction(accessor => accessor.get(IAgentPullRequestService));
	}

	async resolveDiffSource(uri: URI): Promise<IResolvedMultiDiffSource> {
		const target = parsePrDiffUri(uri)!;
		const repo = await this.pullRequests.repoForFolder(target.folder);
		if (!repo) {
			throw new Error(localize('voltPr.diff.noClone', "{0} is not a clone of {1}/{2}.", target.folder, target.repo.owner, target.repo.name));
		}
		const [fetched, detail] = await Promise.all([
			this.pullRequests.api.fetch({ repo: target.repo, number: target.number, folder: target.folder }),
			this.pullRequests.detail({ repo: target.repo, number: target.number }),
		]);
		const entries = await this.git.diffSummary({ repoRoot: repo.root, from: fetched.base, to: fetched.head });
		const key = prKey(target.repo, target.number);
		// GitHub's order (the Files tab's), then anything git saw that GitHub did not list.
		const order = new Map(detail.files.map((file, index) => [file.path, index]));
		const files: IPrDiffFile[] = entries
			.map(entry => ({
				path: entry.path,
				...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
				...(entry.oldBlob ? { original: { repoRoot: repo.root, sha: entry.oldBlob, path: entry.oldPath ?? entry.path, key, side: 'original' as const } } : {}),
				...(entry.newBlob ? { modified: { repoRoot: repo.root, sha: entry.newBlob, path: entry.path, key, side: 'modified' as const } } : {}),
			}))
			.filter(file => file.original || file.modified)
			.sort((a, b) => (order.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.path) ?? Number.MAX_SAFE_INTEGER) || a.path.localeCompare(b.path));
		const source = new PrResolvedSource(uri, target, files, this.pullRequests);
		source.setViewed(new Set(detail.files.filter(file => file.viewed === 'viewed').map(file => file.path)));
		return source;
	}
}

export class PrBlobContentProvider implements ITextModelContentProvider {

	constructor(
		@IVoltGitService private readonly git: IVoltGitService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) { }

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const blob = parseBlobUri(resource);
		const text = blob ? (await this.git.readBlob({ repoRoot: blob.repoRoot, sha: blob.sha, path: blob.path }).catch(() => undefined))?.toString() ?? '' : '';
		const existing = this.modelService.getModel(resource);
		if (existing && !existing.isDisposed()) {
			return existing;
		}
		const language = this.languageService.createByFilepathOrFirstLine(URI.file(`/${blob?.path ?? 'file'}`), text.split(/\r?\n/, 1)[0]);
		return this.modelService.createModel(text, language, resource);
	}
}

/**
 * Opens the pull request's files as one scrolling diff in the chat's tools, at `path` when given.
 * The PR's commits are fetched into hidden refs of the clone at `folder` first.
 */
export async function openPullRequestDiff(accessor: ServicesAccessor, target: IPrDiffTarget, title: string, path?: string, sessionId?: string): Promise<void> {
	const instantiationService = accessor.get(IInstantiationService);
	const editorService = accessor.get(IEditorService);
	const uri = prDiffUri(target);
	const input = MultiDiffEditorInput.fromResourceMultiDiffEditorInput({ multiDiffSource: uri, label: localize('voltPr.diff.label', "#{0} {1}", target.number, title) }, instantiationService);
	const open = (options?: IMultiDiffEditorOptions) => openInAgentTools(input, sessionId, options) ?? editorService.openEditor(input, { ...options, pinned: true });
	await open();
	if (!path) {
		return;
	}
	// The source resolves after the tab opens (it fetches the commits first); reveal once its files are known.
	for (let attempt = 0; attempt < 80; attempt++) {
		const item = sources.get(uri.toString())?.itemFor(path);
		if (item) {
			await open({ viewState: { revealData: { resource: { original: item.originalUri, modified: item.modifiedUri } } } });
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 150));
	}
}

/** The file's diff header: tick it viewed (on GitHub too), or back. */
async function setFileViewed(accessor: ServicesAccessor, resource: unknown, viewed: boolean): Promise<void> {
	if (!URI.isUri(resource)) {
		return;
	}
	const pullRequests = accessor.get(IAgentPullRequestService);
	const notificationService = accessor.get(INotificationService);
	const source = [...sources.values()].find(candidate => candidate.pathOf(resource));
	const path = source?.pathOf(resource);
	if (!source || !path) {
		return;
	}
	const target = source.prTarget;
	try {
		await pullRequests.api.setViewed({ repo: target.repo, number: target.number, path, viewed });
		await pullRequests.detail({ repo: target.repo, number: target.number }, true);
	} catch (err) {
		notificationService.error(localize('voltPr.viewedFailed', "Could not mark {0}: {1}", path, voltPrErrorMessage(err)));
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'volt.pullRequest.markFileViewed',
			title: localize2('voltPr.markViewed', "Mark as Viewed"),
			icon: Codicon.circleLarge,
			menu: { id: MenuId.MultiDiffEditorFileToolbar, group: 'navigation', order: 1, when: ContextKeyExpr.and(ContextKeyExpr.has('voltPrFile'), ContextKeyExpr.not('voltPrFileViewed')) },
		});
	}
	override run(accessor: ServicesAccessor, resource: unknown): Promise<void> {
		return setFileViewed(accessor, resource, true);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'volt.pullRequest.markFileUnviewed',
			title: localize2('voltPr.markUnviewed', "Viewed (click to unmark)"),
			icon: Codicon.passFilled,
			menu: { id: MenuId.MultiDiffEditorFileToolbar, group: 'navigation', order: 1, when: ContextKeyExpr.and(ContextKeyExpr.has('voltPrFile'), ContextKeyExpr.has('voltPrFileViewed')) },
		});
	}
	override run(accessor: ServicesAccessor, resource: unknown): Promise<void> {
		return setFileViewed(accessor, resource, false);
	}
});
