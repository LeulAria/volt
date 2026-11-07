/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The model behind the AI review, through the OpenAI-compatible chat completions API that Gemini,
// OpenRouter, Groq, Mistral and most other providers offer. Free tiers are per model, so a list of
// models is tried in order: a model that is out of quota or unknown falls through to the next.

/**
 * @typedef {{ name: string, baseUrl: string, apiKey: string, models: string[] }} Provider
 * @typedef {{ role: 'system' | 'user', content: string }} Message
 */

/** Gemini's free tier through Google AI Studio: https://aistudio.google.com/apikey */
const geminiModels = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-3.5-flash-lite'];

/**
 * Picks the provider from the configured secrets. AI_REVIEW_API_KEY with AI_REVIEW_BASE_URL is any
 * OpenAI-compatible endpoint; AI_REVIEW_MODEL (comma-separated) overrides the models.
 * @param {Record<string, string | undefined>} env
 * @returns {Provider | undefined}
 */
export function resolveProvider(env) {
	const models = (env.AI_REVIEW_MODEL ?? '').split(',').map(m => m.trim()).filter(Boolean);
	if (env.AI_REVIEW_API_KEY && env.AI_REVIEW_BASE_URL) {
		return { name: 'custom', baseUrl: env.AI_REVIEW_BASE_URL.replace(/\/$/, ''), apiKey: env.AI_REVIEW_API_KEY, models: models.length ? models : ['gpt-4o-mini'] };
	}
	if (env.GEMINI_API_KEY) {
		return { name: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: env.GEMINI_API_KEY, models: models.length ? models : geminiModels };
	}
	if (env.OPENROUTER_API_KEY) {
		return { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: env.OPENROUTER_API_KEY, models: models.length ? models : ['openrouter/free'] };
	}
	return undefined;
}

export class ModelError extends Error {
	/**
	 * @param {string} message
	 * @param {boolean} fatal no other model will do better (a rejected key)
	 */
	constructor(message, fatal = false) {
		super(message);
		this.fatal = fatal;
	}
}

/**
 * The first JSON object in a model reply, tolerating code fences and prose around it.
 * @param {string} text
 * @returns {any}
 */
export function parseJsonReply(text) {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf('{');
		const end = trimmed.lastIndexOf('}');
		if (start >= 0 && end > start) {
			return JSON.parse(trimmed.slice(start, end + 1));
		}
		throw new Error('the reply is not JSON');
	}
}

export class ChatClient {
	/**
	 * @param {Provider} provider
	 * @param {{ fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, timeoutMs?: number, log?: (message: string) => void }} [options]
	 */
	constructor(provider, options = {}) {
		this.provider = provider;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
		this.timeoutMs = options.timeoutMs ?? 240_000;
		this.log = options.log ?? (message => console.log(message));
		/** Models that failed for good in this run, skipped by later calls. */
		this.exhausted = new Set();
		/** @type {string | undefined} the model that answered last */
		this.lastModel = undefined;
		/** response_format support, downgraded the first time a provider rejects it. */
		/** @type {'json_schema' | 'json_object' | 'none'} */
		this.format = 'json_schema';
	}

	/**
	 * Sends the messages and returns the parsed JSON reply.
	 * @param {Message[]} messages
	 * @param {{ name: string, schema: object }} schema
	 * @param {{ maxTokens?: number }} [options]
	 * @returns {Promise<any>}
	 */
	async json(messages, schema, options = {}) {
		/** @type {string[]} */
		const failures = [];
		for (const model of this.provider.models) {
			if (this.exhausted.has(model)) {
				continue;
			}
			try {
				const reply = await this.complete(model, messages, schema, options.maxTokens ?? 8192);
				this.lastModel = model;
				return reply;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(`${model}: ${message}`);
				if (error instanceof ModelError && error.fatal) {
					throw error;
				}
				this.log(`${model} failed (${message}), trying the next model`);
			}
		}
		throw new ModelError(failures.length ? failures.join('; ') : 'every model is exhausted for this run');
	}

	/**
	 * @param {string} model
	 * @param {Message[]} messages
	 * @param {{ name: string, schema: object }} schema
	 * @param {number} maxTokens
	 */
	async complete(model, messages, schema, maxTokens) {
		let invalidJson = 0;
		for (let attempt = 1; attempt <= 4; attempt++) {
			/** @type {Record<string, unknown>} */
			const body = { model, messages, temperature: 0.2, max_tokens: maxTokens };
			if (this.format === 'json_schema') {
				body.response_format = { type: 'json_schema', json_schema: { name: schema.name, schema: schema.schema } };
			} else if (this.format === 'json_object') {
				body.response_format = { type: 'json_object' };
			}
			/** @type {Response} */
			let response;
			try {
				response = await this.fetch(`${this.provider.baseUrl}/chat/completions`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${this.provider.apiKey}` },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(this.timeoutMs),
				});
			} catch (error) {
				if (attempt < 3) {
					await this.sleep(2000 * attempt);
					continue;
				}
				throw new ModelError(`request failed: ${error instanceof Error ? error.message : error}`);
			}
			const text = await response.text();
			if (response.ok) {
				/** @type {any} */
				let data;
				try {
					data = JSON.parse(text);
				} catch {
					throw new ModelError('the provider answered with something other than JSON');
				}
				const choice = data.choices?.[0];
				const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
				try {
					return parseJsonReply(content);
				} catch {
					// A reply cut off by the token limit, or prose instead of JSON: ask again, then give up on this model.
					if (++invalidJson >= 2) {
						throw new ModelError(`no valid JSON in the reply (finish_reason ${choice?.finish_reason ?? 'unknown'})`);
					}
					continue;
				}
			}
			const status = response.status;
			if (status === 401 || status === 403) {
				throw new ModelError(`the provider rejected the API key (${status})`, true);
			}
			if (status === 400 && this.format !== 'none' && /response_format|json_schema|schema|mime/i.test(text)) {
				this.format = this.format === 'json_schema' ? 'json_object' : 'none';
				this.log(`${this.provider.name} rejected the response format, retrying with ${this.format}`);
				attempt--;
				continue;
			}
			if (status === 404 || (status === 400 && /model/i.test(text))) {
				this.exhausted.add(model);
				throw new ModelError(`model not available (${status})`);
			}
			if (status === 429) {
				const wait = retryDelay(response, text);
				// A daily quota will not come back within this run.
				if (/per.?day|daily|quota.*exceeded|exhausted/i.test(text) && wait > 60_000) {
					this.exhausted.add(model);
					throw new ModelError('out of quota');
				}
				if (attempt < 4) {
					this.log(`${model} is rate limited, waiting ${Math.round(wait / 1000)}s`);
					await this.sleep(Math.min(wait, 90_000));
					continue;
				}
				this.exhausted.add(model);
				throw new ModelError('rate limited');
			}
			if (status >= 500 && attempt < 4) {
				await this.sleep(3000 * attempt);
				continue;
			}
			throw new ModelError(`HTTP ${status}: ${text.slice(0, 200)}`);
		}
		throw new ModelError('no answer after retries');
	}
}

/**
 * How long a 429 asks to wait: the Retry-After header, or Gemini's RetryInfo in the body.
 * @param {Response} response
 * @param {string} text
 */
function retryDelay(response, text) {
	const header = Number(response.headers.get('retry-after'));
	if (header > 0) {
		return header * 1000;
	}
	const fromBody = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
	if (fromBody) {
		return Number(fromBody[1]) * 1000;
	}
	return 20_000;
}
