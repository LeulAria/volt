/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IToolCall, IToolContext, IToolResult, IVoltTool } from '../tools/tool.js';
import { IntelligentCache, cacheKey } from './cache.js';
import { toolCallKey } from './doomLoop.js';
import { FileTracker, staleEditHook } from './fileTracker.js';
import { batchDependencies } from './resources.js';
import { dryRunPreview, normalizeArgs, validateArgs } from './toolPolicy.js';
import { defaultToolPipeline, ToolPipeline } from './waterfall.js';

export interface IToolAuthorizer {
	(call: IToolCall, tool: IVoltTool): Promise<{ allow: boolean; reason?: string }>;
}

/**
 * Runs a tool batch. Unknown names and invalid arguments fail in place, denied tools fail in
 * place, and everything else is scheduled by the resources it touches: calls that conflict run
 * in the model's order, calls that don't run together (bounded by `maxParallel`). Identical
 * read-only calls share one execution. Result order always matches the call order.
 *
 * Every call runs under its own abort signal. A timeout aborts it, so a "timed out" command is
 * actually stopped, and only idempotent tools are retried after a transient failure.
 */
export interface IToolRuntimeOptions {
	readonly authorize?: IToolAuthorizer;
	readonly cache?: IntelligentCache;
	readonly dryRun?: boolean;
	readonly pipeline?: ToolPipeline;
	readonly maxParallel?: number;
	readonly fileTracker?: FileTracker;
	/** Called as each call finishes, before the batch does. */
	readonly onResult?: (result: IToolResult) => void;
	/** Default per-call ceiling when the tool declares none. */
	readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export async function runToolBatch(
	tools: ReadonlyMap<string, IVoltTool>,
	calls: readonly IToolCall[],
	ctx: IToolContext,
	authorize?: IToolAuthorizer | IToolRuntimeOptions,
): Promise<IToolResult[]> {
	const options: IToolRuntimeOptions = typeof authorize === 'function' || authorize === undefined
		? { authorize }
		: authorize;
	const pipeline = options.pipeline ?? defaultToolPipeline();
	if (options.fileTracker) {
		pipeline.use(staleEditHook(options.fileTracker));
	}
	const prepared = calls.map(call => {
		const tool = tools.get(call.name);
		return tool ? { ...call, args: normalizeArgs(tool.schema, call.args) } : call;
	});
	const results: IToolResult[] = new Array<IToolResult>(calls.length);
	const deliver = (index: number, result: IToolResult) => {
		results[index] = result;
		options.onResult?.(result);
	};
	const runnable: number[] = [];

	for (let i = 0; i < prepared.length; i++) {
		const call = prepared[i];
		const tool = tools.get(call.name);
		if (!tool) {
			deliver(i, unknownTool(call));
			continue;
		}
		const schema = validateArgs(tool.schema, call.args);
		if (!schema.ok) {
			deliver(i, { callId: call.id, name: call.name, kind: tool.kind, text: schema.issues.map(issue => issue.message).join(' '), isError: true });
			continue;
		}
		if (options.dryRun) {
			const preview = dryRunPreview(tool, call.args);
			deliver(i, { callId: call.id, name: call.name, kind: tool.kind, text: `[dry-run] ${preview.summary}` });
			continue;
		}
		if (options.cache && tool.parallelSafe) {
			const hit = options.cache.get<IToolResult>('tool', cacheKey(call.name, JSON.stringify(call.args)));
			if (hit) {
				deliver(i, { ...hit, callId: call.id });
				continue;
			}
		}
		runnable.push(i);
	}

	const deps = batchDependencies(prepared, tools, ctx.cwd);
	const done = new Map<number, Promise<void>>();
	const shared = new Map<string, Promise<IToolResult>>();
	const slots = new Semaphore(Math.max(1, options.maxParallel ?? 8));

	const runIndexed = async (i: number): Promise<void> => {
		await Promise.all(deps[i].map(dep => done.get(dep)).filter((wait): wait is Promise<void> => !!wait));
		const call = prepared[i];
		const tool = tools.get(call.name)!;
		const key = tool.parallelSafe ? toolCallKey(call) : undefined;
		const existing = key ? shared.get(key) : undefined;
		if (existing) {
			const result = await existing;
			deliver(i, { ...result, callId: call.id });
			return;
		}
		const execution = slots.run(() => runOne(tool, call, ctx, options, pipeline));
		if (key) {
			shared.set(key, execution);
		}
		const result = await execution;
		deliver(i, result);
		if (options.cache && !result.isError && tool.parallelSafe) {
			options.cache.set('tool', cacheKey(call.name, JSON.stringify(call.args)), result);
		}
		if (options.fileTracker && !result.isError) {
			options.fileTracker.touch(filePath(call) ?? call.name, tool.group === 'edit' ? 'write' : 'read');
		}
	};

	for (const i of runnable) {
		done.set(i, runIndexed(i).catch(() => undefined));
	}
	await Promise.all(done.values());
	return results;
}

function filePath(call: IToolCall): string | undefined {
	const args = call.args && typeof call.args === 'object' ? call.args as Record<string, unknown> : {};
	const value = args.path ?? args.file ?? args.file_path;
	return typeof value === 'string' && value.trim() ? value.replace(/\\/g, '/') : undefined;
}

async function runOne(
	tool: IVoltTool,
	call: IToolCall,
	ctx: IToolContext,
	options: IToolRuntimeOptions,
	pipeline: ToolPipeline,
): Promise<IToolResult> {
	if (options.authorize) {
		const decision = await options.authorize(call, tool);
		if (!decision.allow) {
			return pipeline.run(call, tool, async () => ({
				callId: call.id,
				name: tool.name,
				kind: tool.kind,
				text: decision.reason || `Blocked by Volt access policy: ${tool.name}`,
				isError: true,
			}));
		}
	}
	const started = Date.now();
	const timeoutMs = tool.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return pipeline.run(call, tool, async args => {
		const controller = new AbortController();
		const onParentAbort = () => controller.abort();
		if (ctx.signal.aborted) {
			controller.abort();
		} else {
			ctx.signal.addEventListener('abort', onParentAbort);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<IToolResult>(resolve => {
			timer = setTimeout(() => {
				controller.abort();
				resolve({
					callId: call.id,
					name: tool.name,
					kind: tool.kind,
					text: `${tool.name} timed out after ${Math.round(timeoutMs / 1000)}s and was stopped. Its effects, if any, are unknown; check before retrying.`,
					isError: true,
					durationMs: Date.now() - started,
				});
			}, timeoutMs);
		});
		try {
			const body = tool.execute(args, { ...ctx, signal: controller.signal, callId: call.id })
				.then(result => ({ ...result, callId: call.id, name: tool.name, kind: tool.kind, durationMs: result.durationMs ?? (Date.now() - started) }))
				.catch(err => ({
					callId: call.id,
					name: tool.name,
					kind: tool.kind,
					text: err instanceof Error ? err.message : String(err),
					isError: true,
					durationMs: Date.now() - started,
				}));
			return await Promise.race([body, timedOut]);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			ctx.signal.removeEventListener('abort', onParentAbort);
		}
	});
}

class Semaphore {
	private active = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(private readonly limit: number) { }

	async run<T>(work: () => Promise<T>): Promise<T> {
		if (this.active >= this.limit) {
			// The finishing call hands its slot straight to us, so `active` never overshoots.
			await new Promise<void>(resolve => this.waiting.push(resolve));
		} else {
			this.active++;
		}
		try {
			return await work();
		} finally {
			const next = this.waiting.shift();
			if (next) {
				next();
			} else {
				this.active--;
			}
		}
	}
}

function unknownTool(call: IToolCall): IToolResult {
	return { callId: call.id, name: call.name, kind: 'other', text: `Unknown tool: ${call.name}`, isError: true };
}
