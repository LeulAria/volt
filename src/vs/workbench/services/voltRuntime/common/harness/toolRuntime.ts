/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IToolCall, IToolContext, IToolResult, IVoltTool } from '../tools/tool.js';
import { IntelligentCache, cacheKey } from './cache.js';
import { FileTracker, staleEditHook } from './fileTracker.js';
import { mutationLane } from './mutationQueue.js';
import { dryRunPreview, planToolBatch, validateArgs } from './toolPolicy.js';
import { defaultToolPipeline, ToolPipeline } from './waterfall.js';

export interface IToolAuthorizer {
	(call: IToolCall, tool: IVoltTool): Promise<{ allow: boolean; reason?: string }>;
}

/**
 * Runs a tool batch: unknown names fail, denied tools fail, parallel-safe tools run together,
 * mutating tools run one at a time. Result order matches the model's call order.
 *
 * Every dispatched call goes through the tool waterfall (pre / around / post) so timeout,
 * retry, redaction, and context injection stay off the loop itself.
 */
export interface IToolRuntimeOptions {
	readonly authorize?: IToolAuthorizer;
	readonly cache?: IntelligentCache;
	readonly dryRun?: boolean;
	readonly pipeline?: ToolPipeline;
	readonly maxParallel?: number;
	readonly fileTracker?: FileTracker;
}

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
	const plan = planToolBatch(calls, tools);
	const results: IToolResult[] = new Array(calls.length);
	const parallel: number[] = [];
	const serial: number[] = [];

	for (let i = 0; i < calls.length; i++) {
		const call = calls[i];
		const skipped = plan.skipped.find(item => item.call === call);
		if (skipped) {
			results[i] = { callId: call.id, name: call.name, kind: tools.get(call.name)?.kind ?? 'other', text: skipped.reason, isError: true };
			continue;
		}
		const tool = tools.get(call.name);
		if (!tool) {
			results[i] = unknownTool(call);
			continue;
		}
		const schema = validateArgs(tool.schema, call.args);
		if (!schema.ok) {
			results[i] = { callId: call.id, name: call.name, kind: tool.kind, text: schema.issues.map(issue => issue.message).join(' '), isError: true };
			continue;
		}
		if (options.dryRun) {
			const preview = dryRunPreview(tool, call.args);
			results[i] = { callId: call.id, name: call.name, kind: tool.kind, text: `[dry-run] ${preview.summary}` };
			continue;
		}
		if (options.cache && tool.parallelSafe) {
			const hit = options.cache.get<IToolResult>('tool', cacheKey(call.name, JSON.stringify(call.args)));
			if (hit) {
				results[i] = { ...hit, callId: call.id };
				continue;
			}
		}
		if (tool.parallelSafe) {
			parallel.push(i);
		} else {
			serial.push(i);
		}
	}

	const runIndexed = async (i: number): Promise<void> => {
		const result = await runOne(tools, calls[i], ctx, options.authorize, pipeline);
		results[i] = result;
		if (options.cache && !result.isError && tools.get(calls[i].name)?.parallelSafe) {
			options.cache.set('tool', cacheKey(calls[i].name, JSON.stringify(calls[i].args)), result);
		}
		if (options.fileTracker && !result.isError) {
			options.fileTracker.touch(filePath(calls[i]) ?? calls[i].name, tools.get(calls[i].name)?.group === 'edit' ? 'write' : 'read');
		}
	};

	await runPool(parallel, options.maxParallel ?? 8, runIndexed);
	await runMutating(calls, tools, serial, runIndexed);
	return results;
}

async function runMutating(
	calls: readonly IToolCall[],
	tools: ReadonlyMap<string, IVoltTool>,
	serial: readonly number[],
	runIndexed: (index: number) => Promise<void>,
): Promise<void> {
	let exclusive = Promise.resolve();
	const paths = new Map<string, Promise<void>>();
	const pending: Promise<void>[] = [];
	for (const index of serial) {
		const lane = mutationLane(calls[index], tools.get(calls[index].name));
		if (lane.kind === 'path') {
			const prev = paths.get(lane.path) ?? exclusive;
			const run = prev.then(() => runIndexed(index));
			paths.set(lane.path, run.then(() => undefined, () => undefined));
			pending.push(run);
			continue;
		}
		const wait = Promise.all([exclusive, ...paths.values()]).then(() => undefined);
		const run = wait.then(() => runIndexed(index));
		exclusive = run.then(() => undefined, () => undefined);
		pending.push(run);
	}
	await Promise.all(pending);
}

function filePath(call: IToolCall): string | undefined {
	const args = call.args && typeof call.args === 'object' ? call.args as Record<string, unknown> : {};
	const value = args.path ?? args.file ?? args.file_path;
	return typeof value === 'string' && value.trim() ? value.replace(/\\/g, '/') : undefined;
}

async function runOne(
	tools: ReadonlyMap<string, IVoltTool>,
	call: IToolCall,
	ctx: IToolContext,
	authorize: IToolAuthorizer | undefined,
	pipeline: ToolPipeline,
): Promise<IToolResult> {
	const tool = tools.get(call.name);
	if (!tool) {
		return unknownTool(call);
	}
	if (authorize) {
		const decision = await authorize(call, tool);
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
	return pipeline.run(call, tool, async args => {
		try {
			const result = await tool.execute(args, ctx);
			return { ...result, callId: call.id, name: tool.name, kind: tool.kind, durationMs: result.durationMs ?? (Date.now() - started) };
		} catch (err) {
			return {
				callId: call.id,
				name: tool.name,
				kind: tool.kind,
				text: err instanceof Error ? err.message : String(err),
				isError: true,
				durationMs: Date.now() - started,
			};
		}
	});
}

async function runPool(indices: readonly number[], limit: number, work: (index: number) => Promise<void>): Promise<void> {
	if (!indices.length) {
		return;
	}
	let cursor = 0;
	const workers = Math.min(Math.max(1, limit), indices.length);
	await Promise.all(Array.from({ length: workers }, async () => {
		while (cursor < indices.length) {
			const index = indices[cursor++];
			await work(index);
		}
	}));
}

function unknownTool(call: IToolCall): IToolResult {
	return { callId: call.id, name: call.name, kind: 'other', text: `Unknown tool: ${call.name}`, isError: true };
}
