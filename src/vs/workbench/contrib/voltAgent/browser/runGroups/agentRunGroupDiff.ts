/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, IValueWithChangeEvent } from '../../../../../base/common/event.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelContentProvider } from '../../../../../editor/common/services/resolverService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVoltGitService } from '../../../../../platform/voltGit/common/voltGit.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IRunDiffTarget } from '../../../../services/voltRuntime/common/runGroups/runGroups.js';
import { IMultiDiffSourceResolver, IResolvedMultiDiffSource, MultiDiffEditorItem } from '../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { MultiDiffEditorInput } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';

/**
 * Diffs between two commits of one repository: a run's snapshot against the base, or two runs'
 * snapshots against each other. Run worktrees share the project's object store, so both sides
 * are read with `git cat-file` from the project checkout.
 */
export const RUN_DIFF_SCHEME = 'volt-run-diff';
export const RUN_BLOB_SCHEME = 'volt-run-blob';

const SHA = /^[0-9a-f]{40,64}$/;

export function runDiffUri(target: IRunDiffTarget): URI {
	return URI.from({
		scheme: RUN_DIFF_SCHEME,
		path: `/${target.from}/${target.to}`,
		query: new URLSearchParams({ repo: target.repoRoot, label: target.label, ...(target.folder ? { folder: target.folder } : {}) }).toString(),
	});
}

export function parseRunDiffUri(uri: URI): IRunDiffTarget | undefined {
	if (uri.scheme !== RUN_DIFF_SCHEME) {
		return undefined;
	}
	const match = /^\/([0-9a-f]{40,64})\/([0-9a-f]{40,64})$/.exec(uri.path);
	const query = new URLSearchParams(uri.query);
	const repoRoot = query.get('repo');
	if (!match || !repoRoot) {
		return undefined;
	}
	const folder = query.get('folder');
	return { repoRoot, from: match[1], to: match[2], label: query.get('label') ?? '', ...(folder ? { folder } : {}) };
}

function blobUri(repoRoot: string, sha: string, path: string): URI {
	return URI.from({ scheme: RUN_BLOB_SCHEME, path: `/${path}`, query: new URLSearchParams({ repo: repoRoot, blob: sha }).toString() });
}

function parseBlobUri(uri: URI): { readonly repoRoot: string; readonly sha: string; readonly path: string } | undefined {
	if (uri.scheme !== RUN_BLOB_SCHEME) {
		return undefined;
	}
	const query = new URLSearchParams(uri.query);
	const repoRoot = query.get('repo');
	const sha = query.get('blob');
	return repoRoot && sha && SHA.test(sha) ? { repoRoot, sha, path: uri.path.replace(/^\/+/, '') } : undefined;
}

class RunDiffSource implements IResolvedMultiDiffSource {
	private readonly onDidChangeEmitter = new Emitter<void>();
	readonly resources: IValueWithChangeEvent<readonly MultiDiffEditorItem[]>;

	constructor(items: readonly MultiDiffEditorItem[]) {
		this.resources = { value: items, onDidChange: this.onDidChangeEmitter.event };
	}
}

export class RunDiffSourceResolver implements IMultiDiffSourceResolver {

	constructor(@IVoltGitService private readonly git: IVoltGitService) { }

	canHandleUri(uri: URI): boolean {
		return parseRunDiffUri(uri) !== undefined;
	}

	async resolveDiffSource(uri: URI): Promise<IResolvedMultiDiffSource> {
		const target = parseRunDiffUri(uri)!;
		const entries = await this.git.diffSummary({ repoRoot: target.repoRoot, from: target.from, to: target.to });
		const items = entries
			.filter(entry => entry.oldBlob || entry.newBlob)
			.sort((a, b) => a.path.localeCompare(b.path))
			.map(entry => new MultiDiffEditorItem(
				entry.oldBlob ? blobUri(target.repoRoot, entry.oldBlob, entry.oldPath ?? entry.path) : undefined,
				entry.newBlob ? blobUri(target.repoRoot, entry.newBlob, entry.path) : undefined,
				target.folder ? joinPath(URI.file(target.folder), entry.path) : undefined,
			));
		return new RunDiffSource(items);
	}
}

export class RunBlobContentProvider implements ITextModelContentProvider {

	constructor(
		@IVoltGitService private readonly git: IVoltGitService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) { }

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const existing = this.modelService.getModel(resource);
		if (existing && !existing.isDisposed()) {
			return existing;
		}
		const blob = parseBlobUri(resource);
		const text = blob ? (await this.git.readBlob({ repoRoot: blob.repoRoot, sha: blob.sha, path: blob.path }).catch(() => undefined))?.toString() ?? '' : '';
		const language = this.languageService.createByFilepathOrFirstLine(URI.file(`/${blob?.path ?? 'file'}`), text.split(/\r?\n/, 1)[0]);
		return this.modelService.createModel(text, language, resource);
	}
}

export async function openRunDiff(instantiationService: IInstantiationService, editorService: IEditorService, target: IRunDiffTarget): Promise<void> {
	const input = MultiDiffEditorInput.fromResourceMultiDiffEditorInput({ multiDiffSource: runDiffUri(target), label: target.label }, instantiationService);
	await editorService.openEditor(input, { pinned: true });
}
