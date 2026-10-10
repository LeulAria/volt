/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { match as matchGlob } from '../../../../../base/common/glob.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ISiblingExcerpt } from '../../common/prediction.js';
import { analyzeDocument, IDocumentAnalysis, IRetrievalQuery, retrieveChunks, retrieveDefinitions } from '../../common/prediction/retrieval.js';

/** Schemes of files the user edits; diff originals, output and the composers are not code to learn from. */
const INDEXED_SCHEMES = new Set<string>([Schemas.file, Schemas.untitled, Schemas.vscodeRemote, Schemas.vscodeUserData]);
const MAX_DOCUMENTS = 40;
const MAX_DOCUMENT_CHARS = 400_000;
const MAX_TOTAL_CHARS = 4_000_000;
/** The file being typed in changes on every key; its far parts are what is used, so a little staleness is fine. */
const CURRENT_REFRESH_MS = 2_000;

interface ICachedAnalysis {
	readonly versionId: number;
	readonly at: number;
	readonly analysis: IDocumentAnalysis;
}

export interface IWorkspaceContext {
	readonly related: ISiblingExcerpt[];
	readonly definitions: string[];
}

/**
 * The codebase a prediction can see: every text model the workbench holds for the user's files
 * (open editors and the ones just closed), analyzed once per version and queried per request for
 * the code most like the cursor's and the declarations of the names it uses. Nothing is read from
 * disk and nothing runs until a model request needs it.
 */
export class WorkspaceContextIndex extends Disposable {

	private readonly cache = new Map<string, ICachedAnalysis>();

	constructor(@IModelService private readonly modelService: IModelService) {
		super();
		this._register(modelService.onModelRemoved(model => this.cache.delete(model.uri.toString())));
	}

	/**
	 * Related code and definitions for the cursor in `current`, within `budget` characters each.
	 * `excerpt` is the 1-based line range the prompt already shows of the current file.
	 */
	query(current: ITextModel, terms: ReadonlyMap<string, number>, excerpt: { readonly start: number; readonly end: number }, budget: { readonly related: number; readonly definitions: number }, excludedGlobs: readonly string[]): IWorkspaceContext {
		if (!terms.size) {
			return { related: [], definitions: [] };
		}
		const docs = this.documents(current, excludedGlobs);
		const query: IRetrievalQuery = {
			path: current.uri.path,
			languageId: current.getLanguageId(),
			terms,
			excerpt: { start: excerpt.start - 1, end: excerpt.end - 1 },
		};
		const related = retrieveChunks(query, docs, budget.related).map(chunk => ({ path: `${chunk.path}:${chunk.startLine + 1}`, excerpt: chunk.text }));
		const definitions = retrieveDefinitions(query, docs, budget.definitions);
		return { related, definitions };
	}

	/** The current file first, then the files in editors, then the rest, within the size caps. */
	private documents(current: ITextModel, excludedGlobs: readonly string[]): IDocumentAnalysis[] {
		const models = this.modelService.getModels()
			.filter(model => model === current || this.indexable(model, excludedGlobs))
			.sort((a, b) => rank(a) - rank(b));
		function rank(model: ITextModel): number {
			return model === current ? 0 : model.isAttachedToEditor() ? 1 : 2;
		}
		const out: IDocumentAnalysis[] = [];
		let total = 0;
		for (const model of models) {
			if (out.length >= MAX_DOCUMENTS) {
				break;
			}
			const length = model.getValueLength();
			if (length > MAX_DOCUMENT_CHARS || total + length > MAX_TOTAL_CHARS) {
				continue;
			}
			total += length;
			out.push(this.analysis(model, model === current));
		}
		return out;
	}

	private indexable(model: ITextModel, excludedGlobs: readonly string[]): boolean {
		return INDEXED_SCHEMES.has(model.uri.scheme)
			&& !model.isForSimpleWidget
			&& !model.isTooLargeForSyncing()
			&& !excludedGlobs.some(pattern => matchGlob(pattern, model.uri.path));
	}

	private analysis(model: ITextModel, current: boolean): IDocumentAnalysis {
		const key = model.uri.toString();
		const cached = this.cache.get(key);
		const versionId = model.getVersionId();
		if (cached && (cached.versionId === versionId || current && Date.now() - cached.at < CURRENT_REFRESH_MS)) {
			return cached.analysis;
		}
		const analysis = analyzeDocument(model.uri.path, model.getLanguageId(), model.getValue());
		this.cache.set(key, { versionId, at: Date.now(), analysis });
		return analysis;
	}
}
