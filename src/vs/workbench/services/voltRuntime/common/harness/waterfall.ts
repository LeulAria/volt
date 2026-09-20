/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IToolCall, IToolResult, IVoltTool } from '../tools/tool.js';
import { classifyError } from './progress.js';
import { redactSecrets } from './safety.js';
import { truncateHead, truncateHeadTail } from './toolResult.js';

/**
 * Tool execution waterfalls. DeepSeek's pipeline is the right *shape* - pre, around,
 * post, then a frozen result - but Cordis events are not Volt's runtime. Listeners
 * compose here the same way: `next()` delegates, a deny short-circuits the body,
 * and post-execute still sees denied and thrown calls.
 *
 *   pre     allow / rewrite args / deny
 *   around  timeout, retry, metrics (wraps dispatch)
 *   post    accept / replace / block / add context
 *
 * The UI never sees this. `runToolBatch` is the only consumer.
 */

export type PreToolDecision =
	| { readonly kind: 'allow'; readonly args?: unknown }
	| { readonly kind: 'deny'; readonly reason: string };

export type PostToolDecision =
	| { readonly kind: 'accept' }
	| { readonly kind: 'replace'; readonly result: IToolResult }
	| { readonly kind: 'block'; readonly reason: string }
	| { readonly kind: 'enrich'; readonly text?: string; readonly contexts?: readonly string[] };

export interface IToolHook {
	readonly name?: string;
	pre?(call: IToolCall, tool: IVoltTool): PreToolDecision | Promise<PreToolDecision>;
	around?(call: IToolCall, tool: IVoltTool, next: () => Promise<IToolResult>): Promise<IToolResult>;
	post?(call: IToolCall, tool: IVoltTool, result: IToolResult): PostToolDecision | Promise<PostToolDecision>;
}

export class ToolPipeline {

	private readonly hooks: IToolHook[] = [];

	use(hook: IToolHook): this {
		this.hooks.push(hook);
		return this;
	}

	list(): readonly IToolHook[] {
		return this.hooks;
	}

	async run(call: IToolCall, tool: IVoltTool, body: (args: unknown) => Promise<IToolResult>): Promise<IToolResult> {
		let args = call.args;
		for (const hook of this.hooks) {
			if (!hook.pre) {
				continue;
			}
			const decision = await hook.pre({ ...call, args }, tool);
			if (decision.kind === 'deny') {
				return this.finalize(call, tool, {
					callId: call.id,
					name: tool.name,
					kind: tool.kind,
					text: decision.reason,
					isError: true,
				});
			}
			if (decision.args !== undefined) {
				args = decision.args;
			}
		}

		const dispatched: IToolCall = { ...call, args };
		const arounds = this.hooks.filter(hook => hook.around);
		const invoke = arounds.reduceRight<() => Promise<IToolResult>>(
			(next, hook) => () => hook.around!(dispatched, tool, next),
			() => body(args),
		);

		let result: IToolResult;
		try {
			result = await invoke();
		} catch (err) {
			result = {
				callId: call.id,
				name: tool.name,
				kind: tool.kind,
				text: err instanceof Error ? err.message : String(err),
				isError: true,
			};
		}
		result = { ...result, callId: call.id, name: tool.name, kind: tool.kind };
		return this.finalize(dispatched, tool, result);
	}

	private async finalize(call: IToolCall, tool: IVoltTool, result: IToolResult): Promise<IToolResult> {
		let current = result;
		const contexts: string[] = [...(result.contexts ?? [])];
		for (const hook of this.hooks) {
			if (!hook.post) {
				continue;
			}
			const decision = await hook.post(call, tool, current);
			if (decision.kind === 'block') {
				current = { ...current, text: decision.reason, isError: true };
				continue;
			}
			if (decision.kind === 'replace') {
				current = { ...decision.result, callId: call.id, name: tool.name, kind: tool.kind };
				continue;
			}
			if (decision.kind === 'enrich') {
				if (decision.text) {
					current = { ...current, text: `${current.text}\n${decision.text}` };
				}
				if (decision.contexts?.length) {
					contexts.push(...decision.contexts);
				}
			}
		}
		return contexts.length ? { ...current, contexts } : current;
	}
}

export function defaultToolPipeline(options: { readonly timeoutMs?: number; readonly retryTransient?: boolean } = {}): ToolPipeline {
	const pipeline = new ToolPipeline();
	pipeline.use(timeoutHook(options.timeoutMs ?? 180_000));
	if (options.retryTransient !== false) {
		pipeline.use(transientRetryHook());
	}
	pipeline.use(hygieneHook());
	return pipeline;
}

export function timeoutHook(ms: number): IToolHook {
	return {
		name: 'timeout',
		around: async (_call, tool, next) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					next(),
					new Promise<IToolResult>((_, reject) => {
						timer = setTimeout(() => reject(new Error(`Tool ${tool.name} timed out after ${ms}ms`)), ms);
					}),
				]);
			} finally {
				if (timer) {
					clearTimeout(timer);
				}
			}
		},
	};
}

export function transientRetryHook(): IToolHook {
	return {
		name: 'retry-transient',
		around: async (call, _tool, next) => {
			const first = await next();
			if (!first.isError || classifyError(call.name, first.text) !== 'transient') {
				return first;
			}
			return next();
		},
	};
}

export function hygieneHook(): IToolHook {
	return {
		name: 'hygiene',
		post: (_call, tool, result) => {
			const redacted = redactSecrets(result.text);
			const truncated = tool.kind === 'execute' ? truncateHeadTail(redacted) : truncateHead(redacted);
			if (redacted === result.text && !truncated.truncated) {
				return { kind: 'accept' };
			}
			return { kind: 'replace', result: { ...result, text: truncated.text } };
		},
	};
}
