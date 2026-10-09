/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Limiter } from '../../../../base/common/async.js';
import { hostProductLabel, VoltPrSupportedProvider } from '../../common/voltPrHosts.js';
import {
	IVoltPrCreateRequest,
	IVoltPrFilePatch,
	IVoltPrLineComment,
	IVoltPrMergeRequest,
	IVoltPrRepoRef,
	IVoltPullRequest,
	IVoltPullRequestDetail,
	VoltPrError,
} from '../../common/voltPullRequests.js';
import { VoltPrHttp } from './voltPrHttp.js';

/**
 * A code host other than GitHub, over its REST API. One instance per host and token; the service
 * picks it by the repository's host. Every method speaks Volt's shapes; what a host cannot do
 * throws `unsupported` with a sentence the views show as is.
 */
export interface IVoltPrHostClient {
	readonly provider: VoltPrSupportedProvider;
	readonly label: string;
	readonly http: VoltPrHttp;
	/** The token's account. */
	viewer(owner?: string): Promise<string>;
	list(repo: IVoltPrRepoRef, state: 'open' | 'closed' | 'all', limit: number): Promise<IVoltPullRequest[]>;
	/** Newest first, the open one first. */
	forBranch(repo: IVoltPrRepoRef, branch: string, headOwner?: string): Promise<IVoltPullRequest[]>;
	get(repo: IVoltPrRepoRef, number: number): Promise<IVoltPullRequest | undefined>;
	detail(repo: IVoltPrRepoRef, number: number): Promise<IVoltPullRequestDetail>;
	create(request: IVoltPrCreateRequest): Promise<IVoltPullRequest>;
	merge(request: IVoltPrMergeRequest): Promise<void>;
	cancelAutoMerge(repo: IVoltPrRepoRef, number: number): Promise<void>;
	updateBranch(repo: IVoltPrRepoRef, number: number, rebase: boolean): Promise<void>;
	setState(repo: IVoltPrRepoRef, number: number, state: 'open' | 'closed'): Promise<void>;
	setBase(repo: IVoltPrRepoRef, number: number, base: string): Promise<void>;
	setDraft(repo: IVoltPrRepoRef, number: number, draft: boolean): Promise<void>;
	setLabels(repo: IVoltPrRepoRef, number: number, add: readonly string[], remove: readonly string[]): Promise<void>;
	comment(repo: IVoltPrRepoRef, number: number, body: string): Promise<void>;
	reply(repo: IVoltPrRepoRef, number: number, threadId: string, body: string): Promise<void>;
	resolveThread(repo: IVoltPrRepoRef, number: number, threadId: string, resolved: boolean): Promise<void>;
	review(repo: IVoltPrRepoRef, number: number, event: 'approve' | 'requestChanges' | 'comment', body: string): Promise<void>;
	postReview(repo: IVoltPrRepoRef, number: number, body: string, comments: readonly IVoltPrLineComment[], headOid?: string): Promise<{ posted: number; url?: string }>;
	requestReviewers(repo: IVoltPrRepoRef, number: number, logins: readonly string[]): Promise<void>;
	rerunFailedChecks(repo: IVoltPrRepoRef, number: number): Promise<number>;
	/** From the API: the whole pull request, or one commit. `blob` is a blob id or `<commit>:<path>`. */
	filePatches(repo: IVoltPrRepoRef, number: number, commit?: string): Promise<IVoltPrFilePatch[]>;
	/** A blob id, or `<commit>:<path>`. */
	readBlob(repo: IVoltPrRepoRef, ref: string): Promise<string>;
	remoteBranches(repo: IVoltPrRepoRef): Promise<string[]>;
}

/** Reads at once when a list fills in each row's checks. */
const ROW_READS = 6;

export abstract class VoltPrRestClient implements Partial<IVoltPrHostClient> {

	abstract readonly provider: VoltPrSupportedProvider;
	private viewerCache = new Map<string, Promise<string>>();

	constructor(readonly http: VoltPrHttp) { }

	get label(): string {
		return hostProductLabel(this.provider);
	}

	protected unsupported(what: string): never {
		throw new VoltPrError('unsupported', `${this.label} does not let Volt ${what}.`);
	}

	/** The token's account, read once per owner (Azure tokens are per organization). */
	viewer(owner?: string): Promise<string> {
		const key = owner ?? '';
		let cached = this.viewerCache.get(key);
		if (!cached) {
			cached = this.readViewer(owner);
			this.viewerCache.set(key, cached);
			cached.catch(() => this.viewerCache.delete(key));
		}
		return cached;
	}

	protected abstract readViewer(owner?: string): Promise<string>;

	/** Reads each item with at most a few requests in flight. */
	protected async each<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
		const limiter = new Limiter<R>(ROW_READS);
		try {
			return await Promise.all(items.map(item => limiter.queue(() => read(item))));
		} finally {
			limiter.dispose();
		}
	}

	/** Like {@link each}, but a row that fails keeps going without its extra (it still lists). */
	protected async eachSettled<T, R>(items: readonly T[], read: (item: T) => Promise<R>, fallback: (item: T) => R): Promise<R[]> {
		return this.each(items, item => read(item).catch(() => fallback(item)));
	}

	async cancelAutoMerge(_repo: IVoltPrRepoRef, _number: number): Promise<void> {
		this.unsupported('turn off auto-merge');
	}

	async updateBranch(_repo: IVoltPrRepoRef, _number: number, _rebase: boolean): Promise<void> {
		this.unsupported('update the branch from its base; restack it or pull the base in locally');
	}

	async setLabels(_repo: IVoltPrRepoRef, _number: number, _add: readonly string[], _remove: readonly string[]): Promise<void> {
		this.unsupported('change labels');
	}

	async reply(_repo: IVoltPrRepoRef, _number: number, _threadId: string, _body: string): Promise<void> {
		this.unsupported('reply to review threads');
	}

	async resolveThread(_repo: IVoltPrRepoRef, _number: number, _threadId: string, _resolved: boolean): Promise<void> {
		this.unsupported('resolve review threads');
	}

	async requestReviewers(_repo: IVoltPrRepoRef, _number: number, _logins: readonly string[]): Promise<void> {
		this.unsupported('request reviewers');
	}

	async rerunFailedChecks(_repo: IVoltPrRepoRef, _number: number): Promise<number> {
		this.unsupported('re-run checks');
	}
}

/** Sorts what a branch search found: the open one first, then the newest. */
export function openFirst(prs: IVoltPullRequest[]): IVoltPullRequest[] {
	const open = (pr: IVoltPullRequest) => pr.state === 'open' || pr.state === 'draft';
	return prs.sort((a, b) => Number(open(b)) - Number(open(a)) || b.createdAt - a.createdAt);
}

/** `<commit>:<path>`, the stand-in blob id of hosts whose API names no blob for a file. */
export function commitPathRef(commit: string, path: string): string {
	return `${commit}:${path}`;
}

export function parseCommitPathRef(ref: string): { commit: string; path: string } | undefined {
	const match = /^([0-9a-f]{7,64}):(.+)$/i.exec(ref);
	return match ? { commit: match[1], path: match[2] } : undefined;
}

/** Long lists of findings become one comment on hosts without line comments: a heading per file and line. */
export function findingsAsComment(body: string, comments: readonly IVoltPrLineComment[]): string {
	return [body.trim(), ...comments.map(comment => `**${comment.path}:${comment.line}**\n\n${comment.body.trim()}`)].filter(Boolean).join('\n\n---\n\n');
}
