/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asRecord } from '../tools/args.js';
import { IToolCall, IVoltTool } from '../tools/tool.js';
import { toolCallKey } from './doomLoop.js';

/**
 * Tool intelligence that is *not* ranking: schema validation, duplicate detection,
 * idempotency keys, dry-run previews, and batch planning.
 *
 * These run before AccessBroker. A call that cannot satisfy its own schema never becomes
 * an approval card, and a duplicate of a call that just succeeded never hits the filesystem.
 */

export interface ISchemaIssue {
	readonly path: string;
	readonly message: string;
}

export interface ISchemaCheck {
	readonly ok: boolean;
	readonly issues: readonly ISchemaIssue[];
}

export interface IJsonSchema {
	readonly type?: string;
	readonly properties?: Record<string, IJsonSchema | object>;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean;
	readonly items?: IJsonSchema | object;
	readonly enum?: readonly unknown[];
}

export function validateArgs(schema: object | undefined, args: unknown): ISchemaCheck {
	if (!schema || typeof schema !== 'object') {
		return { ok: true, issues: [] };
	}
	const issues: ISchemaIssue[] = [];
	walk(schema as IJsonSchema, args, '', issues);
	return { ok: issues.length === 0, issues };
}

function walk(schema: IJsonSchema, value: unknown, path: string, issues: ISchemaIssue[]): void {
	if (schema.type === 'object' || schema.properties || schema.required) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			issues.push({ path: path || '$', message: 'Expected an object.' });
			return;
		}
		const record = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (record[key] === undefined) {
				issues.push({ path: join(path, key), message: `Missing required property "${key}".` });
			}
		}
		// Extra properties are ignored. Models invent aliases (`file` vs `path`) and
		// failing the whole call over that is how you spend a turn on a schema lecture.
		for (const [key, child] of Object.entries(schema.properties ?? {})) {
			if (record[key] !== undefined) {
				walk(child as IJsonSchema, record[key], join(path, key), issues);
			}
		}
		return;
	}
	if (schema.type === 'array') {
		if (!Array.isArray(value)) {
			issues.push({ path: path || '$', message: 'Expected an array.' });
			return;
		}
		if (schema.items) {
			value.forEach((item, index) => walk(schema.items as IJsonSchema, item, `${path || '$'}[${index}]`, issues));
		}
		return;
	}
	if (schema.type && !matchesType(schema.type, value)) {
		issues.push({ path: path || '$', message: `Expected ${schema.type}.` });
	}
	if (schema.enum && !schema.enum.some(item => Object.is(item, value))) {
		issues.push({ path: path || '$', message: `Expected one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}.` });
	}
}

function matchesType(type: string, value: unknown): boolean {
	switch (type) {
		case 'string': return typeof value === 'string';
		case 'integer': return typeof value === 'number' && Number.isInteger(value);
		case 'number': return typeof value === 'number' && Number.isFinite(value);
		case 'boolean': return typeof value === 'boolean';
		case 'object': return !!value && typeof value === 'object' && !Array.isArray(value);
		case 'array': return Array.isArray(value);
		default: return true;
	}
}

function join(parent: string, key: string): string {
	return parent ? `${parent}.${key}` : key;
}

// --- dedupe / idempotency -------------------------------------------------------------------

export interface IDedupeResult {
	readonly unique: readonly IToolCall[];
	readonly duplicates: readonly IToolCall[];
}

/**
 * Drops later calls that are byte-for-byte identical to an earlier one in this batch *or*
 * to a key the caller says already ran (the cache). Order of the unique list is the model's
 * order, so a later different call is not reordered in front of a duplicate.
 */
export function dedupeCalls(calls: readonly IToolCall[], already: ReadonlySet<string> = new Set()): IDedupeResult {
	const seen = new Set(already);
	const unique: IToolCall[] = [];
	const duplicates: IToolCall[] = [];
	for (const call of calls) {
		const key = toolCallKey(call);
		if (seen.has(key)) {
			duplicates.push(call);
			continue;
		}
		seen.add(key);
		unique.push(call);
	}
	return { unique, duplicates };
}

export function idempotencyKey(call: IToolCall): string {
	return toolCallKey(call);
}

// --- dry-run --------------------------------------------------------------------------------

export interface IDryRunPreview {
	readonly name: string;
	readonly mutating: boolean;
	readonly summary: string;
	readonly paths: readonly string[];
}

export function dryRunPreview(tool: IVoltTool, args: unknown): IDryRunPreview {
	const record = asRecord(args);
	const path = typeof record.path === 'string' ? record.path : typeof record.file === 'string' ? record.file : undefined;
	const command = typeof record.command === 'string' ? record.command : undefined;
	const mutating = !tool.parallelSafe && (tool.group === 'edit' || tool.group === 'shell' || tool.group === 'git');
	const summary = command
		? `Would run \`${command}\`${path ? ` in ${path}` : ''}.`
		: path
			? `Would ${tool.name} ${path}.`
			: `Would call ${tool.name}.`;
	return {
		name: tool.name,
		mutating,
		summary,
		paths: path ? [path] : [],
	};
}

// --- batch planner --------------------------------------------------------------------------

export interface IToolBatchPlan {
	readonly parallel: readonly IToolCall[];
	readonly serial: readonly IToolCall[];
	readonly skipped: readonly { readonly call: IToolCall; readonly reason: string }[];
}

/**
 * Splits a batch the way the executor will run it, *and* names the ones that should not run
 * at all (unknown tool, failed schema, duplicate). The executor still does the work; this
 * is the plan the event log records.
 */
export function planToolBatch(
	calls: readonly IToolCall[],
	tools: ReadonlyMap<string, IVoltTool>,
	already: ReadonlySet<string> = new Set(),
): IToolBatchPlan {
	const skipped: { call: IToolCall; reason: string }[] = [];
	const candidates: IToolCall[] = [];

	for (const call of calls) {
		const tool = tools.get(call.name);
		if (!tool) {
			skipped.push({ call, reason: `Unknown tool: ${call.name}` });
			continue;
		}
		const schema = validateArgs(tool.schema, call.args);
		if (!schema.ok) {
			skipped.push({ call, reason: schema.issues.map(issue => issue.message).join(' ') });
			continue;
		}
		candidates.push(call);
	}

	const deduped = dedupeCalls(candidates, already);
	for (const call of deduped.duplicates) {
		skipped.push({ call, reason: 'Duplicate of a call that already ran or is in this batch.' });
	}

	const parallel: IToolCall[] = [];
	const serial: IToolCall[] = [];
	for (const call of deduped.unique) {
		const tool = tools.get(call.name);
		if (tool?.parallelSafe) {
			parallel.push(call);
		} else {
			serial.push(call);
		}
	}
	return { parallel, serial, skipped };
}
