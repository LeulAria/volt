/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindow } from '../../../../base/browser/dom.js';
import { raceCancellation } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IHttpRequestSpec } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { httpScriptFromAnswer } from '../common/httpProtocols.js';
import { createHttpAiModelButton, httpAiModelRef } from './voltHttpAiModel.js';
import { IHttpExchange } from './voltHttpService.js';

const MAX_BODY_IN_PROMPT = 6000;
/** An agent's one-shot call is a process start plus the answer of whichever model the user picked. */
const TIMEOUT_MS = 120_000;

/** Who the writer is; an agent's one-shot call would otherwise answer as a chat-title or coding agent. */
export const HTTP_TEST_SYSTEM_PROMPT = 'You write Postman test scripts for API responses. You are given one request and its response and reply with the JavaScript test script only: no prose, no Markdown fences, no tool use, no questions.';

/** What the model is asked: the exchange in hand, the tests there already, and what the user wants checked. */
export function httpTestPrompt(spec: IHttpRequestSpec, exchange: IHttpExchange, existing: string, wish: string): string {
	const response = exchange.response;
	const headers = response ? Object.entries(response.headers).map(([key, value]) => `${key}: ${value.length > 200 ? `${value.slice(0, 200)}...` : value}`).join('\n') : '';
	const body = response ? (response.body.length > MAX_BODY_IN_PROMPT ? `${response.body.slice(0, MAX_BODY_IN_PROMPT)}\n... (${response.body.length - MAX_BODY_IN_PROMPT} more characters cut)` : response.body) : '';
	return [
		'Write a Postman post-response test script for this API exchange. It runs in a Postman-compatible sandbox: `pm.test(name, fn)`, `pm.expect(...)` (Chai BDD), `pm.response.code`, `pm.response.status`, `pm.response.responseTime`, `pm.response.headers.get(name)`, `pm.response.json()`, `pm.response.text()`, `pm.response.to.have.status(n)`, `pm.response.to.have.header(name)`, `pm.environment.set/get`, `pm.collectionVariables.set/get`, `pm.variables.get`. No `require`, no network, no async code.',
		'',
		'Rules:',
		'- Answer with JavaScript only: no prose, no Markdown fences.',
		'- 4 to 8 focused `pm.test` blocks with plain-English names.',
		'- Assert what makes this response correct: the status, the content type, the shape and types of the body, and values that follow from the request (an id that was asked for, an echoed field). Do not assert values that change between calls (timestamps, generated ids, tokens): assert their type or format instead.',
		'- Guard body parsing: when the body is not JSON, do not call `pm.response.json()`.',
		'- If the response carries a token or id that later requests would need, store it with `pm.environment.set` after the tests.',
		existing.trim() ? '- The request already has the tests below. Write only tests that add to them; do not repeat them.' : '',
		wish.trim() ? `- The user asks specifically: ${wish.trim()}` : '',
		'',
		'Request:',
		`${spec.method} ${spec.url}`,
		...spec.headers.filter(([key]) => !/^(authorization|cookie|x-api-key|api-key)$/i.test(key)).map(([key, value]) => `${key}: ${value}`),
		...(spec.body ? ['', spec.body.length > 2000 ? `${spec.body.slice(0, 2000)}...` : spec.body] : []),
		'',
		response ? `Response: ${response.status} ${response.statusText} in ${response.durationMs} ms` : `No response: ${exchange.error ?? 'unknown error'}`,
		headers,
		'',
		body,
		...(existing.trim() ? ['', 'Existing tests:', existing.trim()] : []),
	].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n');
}

/** Whether a script holds anything a run would report. */
export function httpScriptHasTests(script: string): boolean {
	return /pm\.test\s*\(|pm\.expect\s*\(|client\.test\s*\(|tests\[/.test(script);
}

/** `script` added under the tests a request has. */
export function appendHttpTestScript(existing: string, script: string): string {
	return existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n${script}\n` : `${script}\n`;
}

export interface IHttpWrittenTests {
	/** What the model wrote, fences and tags dropped; partial when the call was cancelled. */
	readonly script: string;
	/** Why the script cannot be used. Absent for a usable script, and for a cancelled call. */
	readonly failure?: string;
}

/**
 * Has `ref` write a test script for `prompt`. A chat model streams it (`onPartial` sees it grow);
 * an agent answers in one tool-less call of its own (the Tab predictor's session answers only while
 * the user types). Never throws.
 */
export async function writeHttpTestScript(runtime: IAgentRuntimeService, ref: string, prompt: string, token: CancellationToken, onPartial?: (script: string) => void): Promise<IHttpWrittenTests> {
	let answer = '';
	let failure: string | undefined;
	try {
		if (runtime.resolveCatalogItem(ref)?.kind === 'agent') {
			const text = await raceCancellation(runtime.generateText(prompt, { ref, systemPrompt: HTTP_TEST_SYSTEM_PROMPT, timeoutMs: TIMEOUT_MS - 5000 }), token);
			if (text === undefined && !token.isCancellationRequested) {
				failure = localize('voltHttp.aiAgentFailed', "{0} did not answer. Check that it is signed in, or pick another model.", runtime.resolveCatalogItem(ref)?.label ?? ref);
			}
			answer = text ?? '';
		} else {
			for await (const event of runtime.streamModel(ref, [{ role: 'system', content: HTTP_TEST_SYSTEM_PROMPT }, { role: 'user', content: prompt }], runtime.getModelOptions(ref), token, 'code')) {
				if (token.isCancellationRequested) {
					break;
				}
				if (event.type === 'text.delta' && event.delta) {
					answer += event.delta;
					onPartial?.(httpScriptFromAnswer(answer));
				} else if (event.type === 'error') {
					failure = event.message;
					break;
				}
			}
		}
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}
	const script = httpScriptFromAnswer(answer);
	if (token.isCancellationRequested) {
		return { script };
	}
	if (!failure && !httpScriptHasTests(script)) {
		failure = localize('voltHttp.aiNoTests', "The model did not answer with tests. Try another model.");
	}
	return { script, ...(failure ? { failure } : {}) };
}

/** How long one script may take to write; a caller cancels its token after this. */
export const HTTP_TEST_WRITE_TIMEOUT_MS = TIMEOUT_MS;

export interface IHttpTestGeneratorHost {
	/** The request as it went out, the response in hand and the tests it has now; undefined when there is nothing to test yet. */
	context(): { readonly spec: IHttpRequestSpec; readonly exchange: IHttpExchange; readonly existing: string } | undefined;
	/** Adds the script to the request's post-response tests and runs them on the response in hand. */
	apply(script: string): Promise<void>;
}

/**
 * "Generate tests": a model writes the post-response tests for the response in hand. The user picks
 * the model (kept for next time), may say what to check, and the tests are added to the request
 * and run at once on the same response, so the result shows without sending again.
 */
export class HttpTestGenerator extends Disposable {

	readonly element: HTMLElement;
	private readonly running = this._register(new MutableDisposable());

	constructor(
		parent: HTMLElement,
		private readonly host: IHttpTestGeneratorHost,
		compact: boolean,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
	) {
		super();
		this.element = append(parent, $('.volt-http-ai'));
		this.element.classList.toggle('compact', compact);
		if (!compact) {
			append(this.element, $('.volt-http-ai-title')).textContent = localize('voltHttp.aiTitle', "Generate tests");
			append(this.element, $('.volt-http-ai-text')).textContent = localize('voltHttp.aiText', "A model reads this response and writes its tests. They are added under Scripts, Post-response, and run right away on this response.");
		}
		const wish = append(this.element, $('textarea.volt-http-ai-wish')) as HTMLTextAreaElement;
		wish.rows = compact ? 1 : 2;
		wish.spellcheck = false;
		wish.placeholder = localize('voltHttp.aiWish', "Optional: what should the tests check?");
		wish.setAttribute('aria-label', localize('voltHttp.aiWishLabel', "What the tests should check"));

		const row = append(this.element, $('.volt-http-ai-row'));
		const modelButton = createHttpAiModelButton(row, instantiationService, this._store, localize('voltHttp.aiModel', "The model that writes the tests"));
		append(row, $('.volt-http-spacer'));
		const run = this._register(createVoltButton(row, 'primary'));
		run.element.classList.add('volt-button-small');
		const idleLabel = localize('voltHttp.aiRun', "Generate and Run");
		run.label = idleLabel;
		// Its own line under the row: a long message never squeezes the model or the button.
		const status = append(this.element, $('.volt-http-ai-status'));
		status.setAttribute('role', 'status');
		const preview = append(this.element, $('pre.volt-http-ai-preview.hidden'));

		const setBusy = (busy: boolean) => {
			run.label = busy ? localize('voltHttp.cancel', "Cancel") : idleLabel;
			this.element.classList.toggle('busy', busy);
			wish.disabled = busy;
			modelButton.disabled = busy;
		};
		this._register(run.onDidClick(async () => {
			if (this.running.value) {
				this.running.clear();
				return;
			}
			const context = this.host.context();
			if (!context) {
				status.textContent = localize('voltHttp.aiNoResponse', "Send the request first: the tests are written from its response.");
				return;
			}
			const ref = httpAiModelRef(this.instantiationService);
			if (!ref) {
				status.textContent = localize('voltHttp.aiNoModel', "No model is set up. Add one in Settings, Providers & Models.");
				return;
			}
			const cancel = new CancellationTokenSource();
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				cancel.cancel();
			}, TIMEOUT_MS);
			const started = Date.now();
			const agent = this.runtime.resolveCatalogItem(ref)?.kind === 'agent';
			const writing = () => {
				const seconds = Math.floor((Date.now() - started) / 1000);
				// allow-any-unicode-next-line
				status.textContent = seconds < 2 ? localize('voltHttp.aiWriting', "Writing tests…") : localize('voltHttp.aiWritingFor', "Writing tests… {0}s", seconds);
			};
			const targetWindow = getWindow(this.element);
			const ticker = targetWindow.setInterval(writing, 1000);
			this.running.value = toDisposable(() => {
				targetWindow.clearInterval(ticker);
				clearTimeout(timer);
				cancel.dispose(true);
				setBusy(false);
			});
			setBusy(true);
			status.classList.remove('error');
			writing();
			preview.textContent = '';
			// An agent answers in one piece: nothing to show until it has.
			preview.classList.toggle('hidden', agent);
			const written = await writeHttpTestScript(this.runtime, ref, httpTestPrompt(context.spec, context.exchange, context.existing, wish.value), cancel.token, partial => {
				preview.textContent = partial;
				preview.scrollTop = preview.scrollHeight;
			});
			const cancelled = cancel.token.isCancellationRequested;
			this.running.clear();
			const script = written.script;
			if (written.failure || cancelled) {
				status.classList.add('error');
				status.textContent = written.failure ?? (timedOut ? localize('voltHttp.aiTimedOut', "The model took too long. Try again, or pick a faster model.") : localize('voltHttp.aiCancelled', "Stopped."));
				preview.classList.toggle('hidden', !script);
				return;
			}
			status.textContent = '';
			// The host adds the script and draws the results in this pane's place.
			await this.host.apply(script);
		}));
	}
}
