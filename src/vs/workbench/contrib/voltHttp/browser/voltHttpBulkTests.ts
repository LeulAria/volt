/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { findHttpItem, httpRequestsOf, IHttpRequest } from '../common/httpCollection.js';
import { httpProtocolInfo } from '../common/httpProtocols.js';
import { appendHttpTestScript, httpTestPrompt, IHttpWrittenTests } from './voltHttpAiTests.js';
import { httpDraftKey, IHttpCollectionEntry, IVoltHttpCollections } from './voltHttpCollections.js';

/** One request to write tests for. */
export interface IHttpTestTarget {
	readonly collection: URI;
	readonly id: string;
}

export type HttpBulkStage = 'sending' | 'writing' | 'running';

export interface IHttpBulkResult {
	readonly target: IHttpTestTarget;
	readonly name: string;
	/** `added`: the tests are in the request and ran. `skipped`: left as it was. `failed`: nothing was added. */
	readonly status: 'added' | 'skipped' | 'failed';
	/** Why it was skipped or failed; for `added`, what the run of the new tests complained about. */
	readonly detail?: string;
	readonly passed?: number;
	readonly total?: number;
	/** The request is open with unsaved edits: the tests went into those, and are saved with them. */
	readonly unsaved?: boolean;
}

export interface IHttpBulkOptions {
	readonly root?: URI;
	readonly environment?: string;
	/** What the user asked the tests to check, for every request. */
	readonly wish?: string;
	/** Leave requests that already have post-response tests alone. */
	readonly skipExisting?: boolean;
	/** Has a model write the script for one prompt. */
	readonly write: (prompt: string, token: CancellationToken) => Promise<IHttpWrittenTests>;
	readonly token: CancellationToken;
	readonly onStage?: (target: IHttpTestTarget, stage: HttpBulkStage) => void;
	readonly onResult?: (result: IHttpBulkResult, done: number, total: number) => void;
}

/** Every request of a collection, or of one of its folders, or the one request: what a row of the sidebar stands for. */
export function httpTestTargetsOf(entry: IHttpCollectionEntry, itemId?: string): IHttpTestTarget[] {
	if (entry.error) {
		return [];
	}
	if (!itemId) {
		return httpRequestsOf(entry.collection.items).map(({ request }) => ({ collection: entry.uri, id: request.id }));
	}
	const found = findHttpItem(entry.collection, itemId)?.item;
	if (!found) {
		return [];
	}
	return found.kind === 'request' ? [{ collection: entry.uri, id: found.id }] : httpRequestsOf(found.items).map(({ request }) => ({ collection: entry.uri, id: request.id }));
}

/** Why a request cannot get generated tests, or undefined when it can. */
export function httpTestBlocker(request: IHttpRequest): string | undefined {
	if (httpProtocolInfo(request.protocol).stream) {
		return 'A connection has no single response to write tests from.';
	}
	return request.url.trim() ? undefined : 'The request has no URL.';
}

/**
 * Writes tests for several requests, one after the other in the order given (a login before the
 * calls that need its token): each is sent, a model writes its tests from the response, they are
 * added under the ones it has and run on that same response. A request open with unsaved edits
 * gets them in those edits; any other is saved to its file. One request failing does not stop the
 * rest; cancelling does.
 */
export async function generateHttpTestsFor(collections: IVoltHttpCollections, targets: readonly IHttpTestTarget[], options: IHttpBulkOptions): Promise<IHttpBulkResult[]> {
	const results: IHttpBulkResult[] = [];
	const finish = (result: IHttpBulkResult) => {
		results.push(result);
		options.onResult?.(result, results.length, targets.length);
	};
	for (const target of targets) {
		if (options.token.isCancellationRequested) {
			break;
		}
		const entry = await collections.load(target.collection);
		const saved = entry && !entry.error ? findHttpItem(entry.collection, target.id)?.item : undefined;
		if (saved?.kind !== 'request') {
			finish({ target, name: target.id, status: 'failed', detail: 'The request is no longer in its collection.' });
			continue;
		}
		const key = httpDraftKey(target.collection, target.id);
		const draft = collections.draftOf(key);
		const request = draft ?? saved;
		const blocker = httpTestBlocker(request);
		if (blocker) {
			finish({ target, name: request.name, status: 'skipped', detail: blocker });
			continue;
		}
		if (options.skipExisting && request.scripts.test.trim()) {
			finish({ target, name: request.name, status: 'skipped', detail: 'Already has tests.' });
			continue;
		}
		const context = { collection: target.collection, token: options.token, ...(options.root ? { root: options.root } : {}), ...(options.environment ? { environment: options.environment } : {}) };
		try {
			options.onStage?.(target, 'sending');
			const exchange = await collections.send(request, context);
			if (options.token.isCancellationRequested) {
				break;
			}
			if (!exchange.response) {
				finish({ target, name: request.name, status: 'failed', detail: exchange.error ?? 'No response.' });
				continue;
			}
			options.onStage?.(target, 'writing');
			const prompt = httpTestPrompt({ method: exchange.method, url: exchange.url, headers: exchange.headers, ...(exchange.body !== undefined ? { body: exchange.body } : {}), line: 1 }, exchange, request.scripts.test, options.wish ?? '');
			const written = await options.write(prompt, options.token);
			if (options.token.isCancellationRequested) {
				break;
			}
			if (written.failure || !written.script) {
				finish({ target, name: request.name, status: 'failed', detail: written.failure ?? 'The model wrote nothing.' });
				continue;
			}
			const script = appendHttpTestScript(request.scripts.test, written.script);
			// Read again: the user may have typed in the open request while the model wrote.
			const latest = collections.draftOf(key);
			let tested: IHttpRequest;
			if (latest) {
				tested = { ...latest, scripts: { ...latest.scripts, test: appendHttpTestScript(latest.scripts.test, written.script) } };
				collections.setDraft(key, tested);
			} else {
				await collections.updateItem(target.collection, target.id, item => {
					if (item.kind === 'request') {
						item.scripts.test = script;
					}
				});
				tested = { ...request, scripts: { ...request.scripts, test: script } };
			}
			options.onStage?.(target, 'running');
			const run = await collections.retest(tested, context, exchange);
			const tests = run.tests ?? [];
			const failed = tests.filter(test => !test.passed && !test.skipped);
			finish({
				target,
				name: request.name,
				status: 'added',
				passed: tests.length - failed.length,
				total: tests.length,
				...(run.scriptError ? { detail: run.scriptError } : failed.length ? { detail: failed.map(test => `${test.name}: ${test.error ?? 'failed'}`).join('\n') } : {}),
				...(latest ? { unsaved: true } : {}),
			});
		} catch (err) {
			if (options.token.isCancellationRequested) {
				break;
			}
			finish({ target, name: request.name, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
		}
	}
	return results;
}
