/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Automations: requests chained into an end-to-end API test flow. This file is the model of a
 * `*.volt-flow.json` file (read tolerantly, written the same way every time), the pieces a run is
 * made of (JSONPath, extraction, assertions, a JSON Schema check, data rows) and the reports built
 * from a run. Nothing here sends anything: the runner is in `browser/voltHttpAutomations.ts`.
 */

import { localize } from '../../../../nls.js';
import { emptyHttpRequest, IHttpKeyValue, IHttpRequest } from './httpCollection.js';

export const HTTP_FLOW_FILE_SUFFIX = '.volt-flow.json';
export const HTTP_FLOW_FILE_PATTERN = '**/*.volt-flow.json';
export const HTTP_FLOW_VERSION = 1;

// --- The model ----------------------------------------------------------------------------------

export type HttpFlowExtractSource = 'json' | 'header' | 'status' | 'text' | 'regex' | 'cookie' | 'time';
export const HTTP_FLOW_EXTRACT_SOURCES: readonly HttpFlowExtractSource[] = ['json', 'header', 'status', 'text', 'regex', 'cookie', 'time'];

export interface IHttpFlowExtract {
	/** The variable the value goes into. */
	name: string;
	from: HttpFlowExtractSource;
	/** A JSONPath (`json`), a header or cookie name, or a regular expression (`regex`: its first group, else the match). */
	path?: string;
	/** Used when the response has no such value; without it the step fails. */
	default?: string;
}

/** `variable` reads a flow variable (named by `path`) instead of the response: what a condition or a loop usually tests. */
export type HttpFlowAssertTarget = 'status' | 'time' | 'header' | 'json' | 'text' | 'size' | 'contentType' | 'schema' | 'variable';
export const HTTP_FLOW_ASSERT_TARGETS: readonly HttpFlowAssertTarget[] = ['status', 'time', 'header', 'json', 'text', 'size', 'contentType', 'schema', 'variable'];

export type HttpFlowAssertOp = 'equals' | 'notEquals' | 'contains' | 'notContains' | 'matches' | 'exists' | 'notExists' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'type' | 'length' | 'schema';
export const HTTP_FLOW_ASSERT_OPS: readonly HttpFlowAssertOp[] = ['equals', 'notEquals', 'contains', 'notContains', 'matches', 'exists', 'notExists', 'gt', 'gte', 'lt', 'lte', 'in', 'type', 'length', 'schema'];

export interface IHttpFlowAssert {
	target: HttpFlowAssertTarget;
	/** A JSONPath (`json`, and `schema` for a part of the body), a header name, or a variable's name. */
	path?: string;
	op: HttpFlowAssertOp;
	/** What it is compared with; `{{variables}}` in a string are filled in first. */
	value?: unknown;
}

export interface IHttpFlowRetry {
	/** How many more sends after the first. */
	times: number;
	delayMs: number;
	/** The delay grows by this factor after each attempt (1 keeps it the same). */
	backoff: number;
	/** Polling: send again until this holds. Without it, a failed step is sent again. */
	until?: IHttpFlowAssert;
}

export interface IHttpFlowRef {
	/** The collection file, relative to the flow file or the project (or the collection's name). */
	collection: string;
	/** The names from the collection down to the request. */
	path: string[];
}

export type HttpFlowBodyType = 'none' | 'json' | 'text' | 'xml' | 'form';

/** A request written in the flow itself. */
export interface IHttpFlowInline {
	method: string;
	url: string;
	headers: IHttpKeyValue[];
	body: string;
	bodyType: HttpFlowBodyType;
}

interface IHttpFlowStepBase {
	/** Kept in the file, so a run's results, a selection and a diff follow the step. */
	id: string;
	name?: string;
	disabled?: boolean;
}

export interface IHttpFlowRequestStep extends IHttpFlowStepBase {
	kind: 'request';
	ref?: IHttpFlowRef;
	inline?: IHttpFlowInline;
	/** Values for this step's send only. */
	variables: IHttpKeyValue[];
	extract: IHttpFlowExtract[];
	assert: IHttpFlowAssert[];
	retry?: IHttpFlowRetry;
	timeoutMs?: number;
	continueOnFailure?: boolean;
	/** Whether the request's own Postman tests count (they do unless this is false). */
	runScripts?: boolean;
}

export interface IHttpFlowDelayStep extends IHttpFlowStepBase {
	kind: 'delay';
	ms: number;
}

export interface IHttpFlowSetStep extends IHttpFlowStepBase {
	kind: 'set';
	/** Each value may use `{{variables}}`. */
	variables: IHttpKeyValue[];
}

export type HttpFlowGroupRole = 'setup' | 'steps' | 'teardown';

export interface IHttpFlowGroupStep extends IHttpFlowStepBase {
	kind: 'group';
	/** `setup`: a failure stops the run. `teardown`: runs even after a failure. */
	role: HttpFlowGroupRole;
	steps: IHttpFlowStep[];
}

export interface IHttpFlowConditionStep extends IHttpFlowStepBase {
	kind: 'condition';
	/** The steps inside run when this holds (on the variables and the last response). */
	if: IHttpFlowAssert;
	steps: IHttpFlowStep[];
}

export interface IHttpFlowRepeatStep extends IHttpFlowStepBase {
	kind: 'repeat';
	times?: number;
	/** A variable holding a JSON array: one round per item. */
	forEach?: string;
	/** The variable each item goes into (`item` when absent); its position goes into `<as>Index`. */
	as?: string;
	/** Rounds go on until this holds. */
	until?: IHttpFlowAssert;
	/** The most rounds, whatever the mode. */
	max: number;
	steps: IHttpFlowStep[];
}

export type IHttpFlowStep = IHttpFlowRequestStep | IHttpFlowDelayStep | IHttpFlowSetStep | IHttpFlowGroupStep | IHttpFlowConditionStep | IHttpFlowRepeatStep;
export type HttpFlowStepKind = IHttpFlowStep['kind'];
export type IHttpFlowContainerStep = IHttpFlowGroupStep | IHttpFlowConditionStep | IHttpFlowRepeatStep;

export interface IHttpFlowSettings {
	iterations: number;
	/** Between two requests. */
	delayMs: number;
	stopOnFailure: boolean;
	/** Each request's limit; 0 leaves the client's own. */
	timeoutMs: number;
	/** Extracted values are written to the environment in use when the run ends. */
	persistVariables: boolean;
}

export interface IHttpFlowData {
	/** A CSV or JSON file, relative to the flow file or the project. */
	file?: string;
	rows?: Record<string, string>[];
}

export interface IHttpFlow {
	name: string;
	description: string;
	/** The environment the run uses; the selected one when absent. */
	environment?: string;
	variables: IHttpKeyValue[];
	settings: IHttpFlowSettings;
	/** One iteration per row, its columns as variables. */
	data?: IHttpFlowData;
	steps: IHttpFlowStep[];
}

export const HTTP_FLOW_MAX_ITERATIONS = 1000;
export const HTTP_FLOW_MAX_ROUNDS = 1000;
const MAX_DELAY_MS = 600_000;

export function defaultHttpFlowSettings(): IHttpFlowSettings {
	return { iterations: 1, delayMs: 0, stopOnFailure: true, timeoutMs: 0, persistVariables: false };
}

export function emptyHttpFlow(name: string): IHttpFlow {
	return { name, description: '', variables: [], settings: defaultHttpFlowSettings(), steps: [] };
}

export function newHttpFlowStepId(taken?: ReadonlySet<string>): string {
	for (; ;) {
		const id = `s${Math.random().toString(36).slice(2, 8)}`;
		if (!taken?.has(id)) {
			return id;
		}
	}
}

export function isHttpFlowContainer(step: IHttpFlowStep): step is IHttpFlowContainerStep {
	return step.kind === 'group' || step.kind === 'condition' || step.kind === 'repeat';
}

/** A new step of a kind with what that kind starts from. */
export function newHttpFlowStep(kind: HttpFlowStepKind, taken?: ReadonlySet<string>): IHttpFlowStep {
	const id = newHttpFlowStepId(taken);
	switch (kind) {
		case 'request': return { id, kind, inline: { method: 'GET', url: '', headers: [], body: '', bodyType: 'none' }, variables: [], extract: [], assert: [] };
		case 'delay': return { id, kind, ms: 1000 };
		case 'set': return { id, kind, variables: [] };
		case 'group': return { id, kind, role: 'steps', steps: [] };
		case 'condition': return { id, kind, if: { target: 'status', op: 'equals', value: 200 }, steps: [] };
		case 'repeat': return { id, kind, times: 3, max: 100, steps: [] };
	}
}

export function newHttpFlowRefStep(ref: IHttpFlowRef, taken?: ReadonlySet<string>): IHttpFlowRequestStep {
	return { id: newHttpFlowStepId(taken), kind: 'request', ref: { collection: ref.collection, path: [...ref.path] }, variables: [], extract: [], assert: [] };
}

// --- Walking and changing the step tree ---------------------------------------------------------

export interface IHttpFlowStepLocation {
	readonly step: IHttpFlowStep;
	readonly siblings: IHttpFlowStep[];
	readonly index: number;
	/** The containers above it, outermost first. */
	readonly ancestors: readonly IHttpFlowContainerStep[];
}

export function findHttpFlowStep(flow: { steps: IHttpFlowStep[] }, id: string): IHttpFlowStepLocation | undefined {
	const search = (steps: IHttpFlowStep[], ancestors: readonly IHttpFlowContainerStep[]): IHttpFlowStepLocation | undefined => {
		for (let index = 0; index < steps.length; index++) {
			const step = steps[index];
			if (step.id === id) {
				return { step, siblings: steps, index, ancestors };
			}
			if (isHttpFlowContainer(step)) {
				const found = search(step.steps, [...ancestors, step]);
				if (found) {
					return found;
				}
			}
		}
		return undefined;
	};
	return search(flow.steps, []);
}

/** Every step, depth first (a container before what is in it). */
export function httpFlowStepsOf(steps: readonly IHttpFlowStep[]): IHttpFlowStep[] {
	const out: IHttpFlowStep[] = [];
	for (const step of steps) {
		out.push(step);
		if (isHttpFlowContainer(step)) {
			out.push(...httpFlowStepsOf(step.steps));
		}
	}
	return out;
}

/**
 * Moves a step to `index` of the container `parentId` (the flow's own list when undefined; the end
 * when `index` is undefined). False when it cannot go there (into itself, or something is missing).
 */
export function moveHttpFlowStep(flow: { steps: IHttpFlowStep[] }, id: string, parentId: string | undefined, index?: number): boolean {
	const found = findHttpFlowStep(flow, id);
	if (!found) {
		return false;
	}
	let list = flow.steps;
	if (parentId) {
		const parent = findHttpFlowStep(flow, parentId);
		if (!parent || !isHttpFlowContainer(parent.step) || parentId === id || parent.ancestors.some(step => step.id === id)) {
			return false;
		}
		list = parent.step.steps;
	}
	let at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length));
	if (list === found.siblings && found.index < at) {
		at--;
	}
	found.siblings.splice(found.index, 1);
	list.splice(at, 0, found.step);
	return true;
}

export function removeHttpFlowStep(flow: { steps: IHttpFlowStep[] }, id: string): IHttpFlowStep | undefined {
	const found = findHttpFlowStep(flow, id);
	if (!found) {
		return undefined;
	}
	found.siblings.splice(found.index, 1);
	return found.step;
}

/** A copy with new ids all the way down, put right after the step. */
export function duplicateHttpFlowStep(flow: { steps: IHttpFlowStep[] }, id: string): IHttpFlowStep | undefined {
	const found = findHttpFlowStep(flow, id);
	if (!found) {
		return undefined;
	}
	const taken = new Set(httpFlowStepsOf(flow.steps).map(step => step.id));
	const copy = structuredClone(found.step);
	for (const step of httpFlowStepsOf([copy])) {
		step.id = newHttpFlowStepId(taken);
		taken.add(step.id);
	}
	found.siblings.splice(found.index + 1, 0, copy);
	return copy;
}

/** What a step is called when it has no name of its own. */
export function httpFlowStepLabel(step: IHttpFlowStep): string {
	if (step.name?.trim()) {
		return step.name.trim();
	}
	switch (step.kind) {
		case 'request':
			if (step.ref) {
				return step.ref.path.at(-1) || step.ref.collection || localize('voltHttp.autoStepRequest', "Request");
			}
			return step.inline?.url.trim() ? `${step.inline.method} ${step.inline.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').replace(/^\{\{[^}]+\}\}/, '').split('?')[0] || step.inline.url}` : localize('voltHttp.autoStepNewRequest', "New Request");
		case 'delay': return localize('voltHttp.autoStepDelay', "Wait {0} ms", step.ms);
		case 'set': {
			const names = step.variables.filter(row => row.key).map(row => row.key);
			return names.length ? localize('voltHttp.autoStepSet', "Set {0}", names.join(', ')) : localize('voltHttp.autoStepSetEmpty', "Set Variables");
		}
		case 'group': return step.role === 'setup' ? localize('voltHttp.autoStepSetup', "Setup") : step.role === 'teardown' ? localize('voltHttp.autoStepTeardown', "Teardown") : localize('voltHttp.autoStepGroup', "Group");
		case 'condition': return localize('voltHttp.autoStepIf', "If {0}", httpFlowAssertLabel(step.if));
		case 'repeat':
			if (step.forEach) {
				return localize('voltHttp.autoStepForEach', "For each item of {0}", step.forEach);
			}
			if (step.until) {
				return localize('voltHttp.autoStepUntil', "Repeat until {0}", httpFlowAssertLabel(step.until));
			}
			return localize('voltHttp.autoStepRepeat', "Repeat {0} times", step.times ?? 1);
	}
}

/** An inline step's request as the client sends one. Its id is the step's. */
export function httpFlowInlineRequest(step: IHttpFlowRequestStep): IHttpRequest {
	const inline = step.inline ?? { method: 'GET', url: '', headers: [], body: '', bodyType: 'none' as const };
	const request = emptyHttpRequest(step.name ?? '', 'none');
	request.id = step.id;
	request.method = inline.method || 'GET';
	request.url = inline.url;
	request.headers = inline.headers.map(row => ({ ...row }));
	const type = inline.bodyType === 'none' && inline.body ? 'text' : inline.bodyType;
	if (type === 'form') {
		request.body.mode = 'urlencoded';
		request.body.urlencoded = inline.body.split('&').filter(Boolean).map(pair => {
			const at = pair.indexOf('=');
			return { key: at < 0 ? pair : pair.slice(0, at), value: at < 0 ? '' : pair.slice(at + 1), enabled: true };
		});
	} else if (type !== 'none') {
		request.body.mode = 'raw';
		request.body.raw = inline.body;
		request.body.language = type;
	}
	return request;
}

// --- Reading and writing the file ---------------------------------------------------------------

export interface IHttpFlowProblem {
	readonly severity: 'error' | 'warning';
	/** Where in the file: `steps[2].assert[0]`. */
	readonly path: string;
	readonly message: string;
	readonly stepId?: string;
}

export interface IHttpFlowParse {
	/** Absent when the text is not a flow at all; `error` says why. */
	readonly flow?: IHttpFlow;
	readonly error?: string;
	/** What was read around (an unknown operator, a step with no kind): the flow loads without it. */
	readonly problems: readonly IHttpFlowProblem[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textOf(value: unknown): string | undefined {
	return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

function numberOf(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

/** Key/value rows from the file's list form, or from a plain `{ name: value }` object. */
function rowsOf(value: unknown): IHttpKeyValue[] {
	if (Array.isArray(value)) {
		const out: IHttpKeyValue[] = [];
		for (const item of value) {
			const row = record(item);
			const key = row && (textOf(row.key) ?? textOf(row.name));
			if (row && key !== undefined) {
				out.push({ key, value: valueText(row.value) ?? '', enabled: row.enabled !== false && row.disabled !== true });
			}
		}
		return out;
	}
	const map = record(value);
	return map ? Object.entries(map).map(([key, item]) => ({ key, value: valueText(item) ?? '', enabled: true })) : [];
}

const TARGET_ALIASES: Readonly<Record<string, HttpFlowAssertTarget>> = { body: 'text', responsetime: 'time', duration: 'time', statuscode: 'status', code: 'status', headers: 'header', jsonpath: 'json', 'content-type': 'contentType', contenttype: 'contentType', var: 'variable', variables: 'variable' };
const OP_ALIASES: Readonly<Record<string, HttpFlowAssertOp>> = {
	eq: 'equals', equal: 'equals', is: 'equals', '==': 'equals', '===': 'equals', ne: 'notEquals', neq: 'notEquals', notequal: 'notEquals', '!=': 'notEquals', includes: 'contains', notincludes: 'notContains', match: 'matches', regex: 'matches',
	exist: 'exists', notexist: 'notExists', greaterthan: 'gt', '>': 'gt', greaterthanorequal: 'gte', '>=': 'gte', lessthan: 'lt', '<': 'lt', lessthanorequal: 'lte', '<=': 'lte', oneof: 'in', typeof: 'type', istype: 'type', count: 'length', size: 'length', matchesschema: 'schema',
};

function lookup<T extends string>(raw: unknown, known: readonly T[], aliases: Readonly<Record<string, T>>): T | undefined {
	const value = typeof raw === 'string' ? raw.trim() : '';
	return known.find(item => item.toLowerCase() === value.toLowerCase()) ?? aliases[value.toLowerCase().replace(/[\s_]/g, '')];
}

function parseAssert(raw: unknown, path: string, problems: IHttpFlowProblem[], stepId: string | undefined): IHttpFlowAssert | undefined {
	const item = record(raw);
	if (!item) {
		problems.push({ severity: 'warning', path, message: 'An assertion must be an object such as { "target": "status", "op": "equals", "value": 200 }.', ...(stepId ? { stepId } : {}) });
		return undefined;
	}
	const pathText = textOf(item.path) ?? textOf(item.name) ?? textOf(item.header) ?? textOf(item.variable);
	let target = lookup(item.target ?? item.source ?? item.from, HTTP_FLOW_ASSERT_TARGETS, TARGET_ALIASES);
	if (!target && item.target === undefined && pathText !== undefined) {
		target = pathText.startsWith('$') ? 'json' : undefined;
	}
	let op = lookup(item.op ?? item.operator, HTTP_FLOW_ASSERT_OPS, OP_ALIASES);
	if (!op && item.op === undefined && item.operator === undefined) {
		op = target === 'schema' ? 'schema' : item.value === undefined ? 'exists' : 'equals';
	}
	if (!target || !op) {
		problems.push({ severity: 'warning', path, message: !target ? `Unknown assertion target ${JSON.stringify(item.target ?? null)}. Use one of: ${HTTP_FLOW_ASSERT_TARGETS.join(', ')}.` : `Unknown assertion operator ${JSON.stringify(item.op ?? item.operator ?? null)}. Use one of: ${HTTP_FLOW_ASSERT_OPS.join(', ')}.`, ...(stepId ? { stepId } : {}) });
		return undefined;
	}
	const value = item.value !== undefined ? item.value : item.expected !== undefined ? item.expected : item.schema;
	return { target, ...(pathText !== undefined ? { path: pathText } : {}), op, ...(value !== undefined ? { value } : {}) };
}

function parseExtract(raw: unknown, path: string, problems: IHttpFlowProblem[], stepId: string): IHttpFlowExtract | undefined {
	const item = record(raw);
	const name = item && (textOf(item.name) ?? textOf(item.variable) ?? textOf(item.as));
	if (!item || name === undefined) {
		problems.push({ severity: 'warning', path, message: 'An extraction must be an object with a variable "name", e.g. { "name": "token", "from": "json", "path": "$.token" }.', stepId });
		return undefined;
	}
	const where = textOf(item.path) ?? textOf(item.pattern) ?? textOf(item.header) ?? textOf(item.cookie);
	const from = lookup(item.from ?? item.source, HTTP_FLOW_EXTRACT_SOURCES, { body: 'text', jsonpath: 'json', headers: 'header', responsetime: 'time', duration: 'time', statuscode: 'status' }) ?? (item.from === undefined && item.source === undefined ? 'json' : undefined);
	if (!from) {
		problems.push({ severity: 'warning', path, message: `Unknown extraction source ${JSON.stringify(item.from ?? item.source)}. Use one of: ${HTTP_FLOW_EXTRACT_SOURCES.join(', ')}.`, stepId });
		return undefined;
	}
	const fallback = valueText(item.default);
	return { name, from, ...(where !== undefined ? { path: where } : {}), ...(fallback !== undefined ? { default: fallback } : {}) };
}

function parseInline(raw: Record<string, unknown>): IHttpFlowInline {
	const body = raw.body;
	const given = lookup(raw.bodyType ?? raw.bodytype, ['none', 'json', 'text', 'xml', 'form'] as const, { urlencoded: 'form', raw: 'text' });
	let text = '';
	let type: HttpFlowBodyType = 'none';
	if (typeof body === 'string') {
		text = body;
		type = given ?? (text ? (/^\s*[[{]/.test(text) ? 'json' : /^\s*</.test(text) ? 'xml' : 'text') : 'none');
	} else if (body !== undefined && body !== null) {
		if (given === 'form' && record(body)) {
			text = Object.entries(record(body)!).map(([key, value]) => `${key}=${valueText(value) ?? ''}`).join('&');
		} else {
			text = JSON.stringify(body, null, 2);
		}
		type = given === 'form' ? 'form' : 'json';
	}
	const headers = rowsOf(raw.headers);
	const query = rowsOf(raw.query ?? raw.params).filter(row => row.enabled && row.key);
	let url = textOf(raw.url) ?? '';
	if (query.length) {
		url += `${url.includes('?') ? '&' : '?'}${query.map(row => row.value !== '' ? `${row.key}=${row.value}` : row.key).join('&')}`;
	}
	return { method: (textOf(raw.method) ?? 'GET').toUpperCase(), url, headers, body: text, bodyType: type };
}

function parseRetry(raw: unknown, path: string, problems: IHttpFlowProblem[], stepId: string): IHttpFlowRetry | undefined {
	const item = record(raw);
	if (!item) {
		return undefined;
	}
	const until = item.until !== undefined ? parseAssert(item.until, `${path}.until`, problems, stepId) : undefined;
	return { times: Math.round(numberOf(item.times ?? item.attempts, 3, 0, 100)), delayMs: Math.round(numberOf(item.delayMs ?? item.delay, 1000, 0, MAX_DELAY_MS)), backoff: numberOf(item.backoff, 1, 1, 10), ...(until ? { until } : {}) };
}

const STEP_KINDS: readonly HttpFlowStepKind[] = ['request', 'delay', 'set', 'group', 'condition', 'repeat'];

function parseSteps(raw: unknown, path: string, problems: IHttpFlowProblem[], ids: Set<string>, counter: { next: number }): IHttpFlowStep[] {
	if (raw === undefined || raw === null) {
		return [];
	}
	if (!Array.isArray(raw)) {
		problems.push({ severity: 'error', path, message: '"steps" must be a list of steps.' });
		return [];
	}
	const out: IHttpFlowStep[] = [];
	raw.forEach((value, index) => {
		const step = parseStep(value, `${path}[${index}]`, problems, ids, counter);
		if (step) {
			out.push(step);
		}
	});
	return out;
}

function parseStep(raw: unknown, path: string, problems: IHttpFlowProblem[], ids: Set<string>, counter: { next: number }): IHttpFlowStep | undefined {
	const item = record(raw);
	if (!item) {
		problems.push({ severity: 'warning', path, message: 'A step must be an object with a "kind".' });
		return undefined;
	}
	let id = typeof item.id === 'string' && item.id.trim() && !ids.has(item.id.trim()) ? item.id.trim() : undefined;
	while (!id) {
		// A step written by hand has no id: it gets one from its place, so a reload gives it the same.
		const candidate = `s${counter.next++}`;
		id = ids.has(candidate) ? undefined : candidate;
	}
	ids.add(id);
	const given = lookup(item.kind ?? item.type, STEP_KINDS, { wait: 'delay', sleep: 'delay', setvariables: 'set', variables: 'set', folder: 'group', if: 'condition', loop: 'repeat', foreach: 'repeat', http: 'request' });
	const kind: HttpFlowStepKind | undefined = given ?? (item.kind === undefined && item.type === undefined
		? (item.ref || item.inline || item.request ? 'request' : item.ms !== undefined ? 'delay' : item.if !== undefined ? 'condition' : item.times !== undefined || item.forEach !== undefined ? 'repeat' : Array.isArray(item.steps) ? 'group' : record(item.variables) || Array.isArray(item.variables) ? 'set' : undefined)
		: undefined);
	if (!kind) {
		problems.push({ severity: 'warning', path, message: `Unknown step kind ${JSON.stringify(item.kind ?? item.type ?? null)}. Use one of: ${STEP_KINDS.join(', ')}.` });
		return undefined;
	}
	const name = textOf(item.name);
	const base = { id, ...(name ? { name } : {}), ...(item.disabled === true || item.enabled === false ? { disabled: true } : {}) };
	switch (kind) {
		case 'request': {
			const refRaw = record(item.ref);
			const inlineRaw = record(item.inline) ?? record(item.request);
			const refPath = refRaw ? (Array.isArray(refRaw.path) ? refRaw.path.map(part => textOf(part) ?? '').filter(Boolean) : typeof refRaw.path === 'string' ? refRaw.path.split('/').map(part => part.trim()).filter(Boolean) : typeof refRaw.request === 'string' ? [refRaw.request] : []) : [];
			const list = <T>(value: unknown, key: string, parse: (raw: unknown, path: string) => T | undefined): T[] => {
				const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
				const parsed: T[] = [];
				values.forEach((entry, index) => {
					const result = parse(entry, `${path}.${key}[${index}]`);
					if (result !== undefined) {
						parsed.push(result);
					}
				});
				return parsed;
			};
			const retry = parseRetry(item.retry, `${path}.retry`, problems, id);
			const timeoutMs = item.timeoutMs !== undefined ? Math.round(numberOf(item.timeoutMs, 0, 0, 3_600_000)) : 0;
			return {
				...base, kind,
				...(refRaw ? { ref: { collection: textOf(refRaw.collection) ?? '', path: refPath } } : {}),
				...(!refRaw && inlineRaw ? { inline: parseInline(inlineRaw) } : {}),
				variables: rowsOf(item.variables),
				extract: list(item.extract, 'extract', (entry, at) => parseExtract(entry, at, problems, id)),
				assert: list(item.assert ?? item.asserts ?? item.assertions, 'assert', (entry, at) => parseAssert(entry, at, problems, id)),
				...(retry ? { retry } : {}),
				...(timeoutMs ? { timeoutMs } : {}),
				...(item.continueOnFailure === true ? { continueOnFailure: true } : {}),
				...(item.runScripts === false ? { runScripts: false } : {}),
			};
		}
		case 'delay': return { ...base, kind, ms: Math.round(numberOf(item.ms ?? item.delayMs ?? item.delay, 1000, 0, MAX_DELAY_MS)) };
		case 'set': return { ...base, kind, variables: rowsOf(item.variables ?? item.values) };
		case 'group': {
			const role = lookup(item.role, ['setup', 'steps', 'teardown'] as const, { before: 'setup', after: 'teardown', cleanup: 'teardown' }) ?? 'steps';
			return { ...base, kind, role, steps: parseSteps(item.steps, `${path}.steps`, problems, ids, counter) };
		}
		case 'condition': {
			const test = parseAssert(item.if ?? item.when ?? item.condition, `${path}.if`, problems, id) ?? { target: 'status' as const, op: 'equals' as const, value: 200 };
			return { ...base, kind, if: test, steps: parseSteps(item.steps ?? item.then, `${path}.steps`, problems, ids, counter) };
		}
		case 'repeat': {
			const until = item.until !== undefined ? parseAssert(item.until, `${path}.until`, problems, id) : undefined;
			const forEach = textOf(item.forEach ?? item.foreach)?.replace(/^\{\{\s*|\s*\}\}$/g, '');
			const as = textOf(item.as);
			const times = item.times !== undefined ? Math.round(numberOf(item.times, 1, 0, HTTP_FLOW_MAX_ROUNDS)) : undefined;
			return {
				...base, kind,
				...(times !== undefined ? { times } : {}),
				...(forEach ? { forEach } : {}),
				...(as ? { as } : {}),
				...(until ? { until } : {}),
				max: Math.round(numberOf(item.max ?? item.cap, until && times === undefined ? 10 : 100, 1, HTTP_FLOW_MAX_ROUNDS)),
				steps: parseSteps(item.steps, `${path}.steps`, problems, ids, counter),
			};
		}
	}
}

/** Reads a flow from a file's text or an object already parsed. Never throws. */
export function parseHttpFlow(input: unknown, fallbackName = 'Automation'): IHttpFlowParse {
	let json: unknown = input;
	if (typeof input === 'string') {
		if (!input.trim()) {
			return { error: 'The file is empty.', problems: [] };
		}
		try {
			json = JSON.parse(input);
		} catch (err) {
			return { error: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`, problems: [] };
		}
	}
	const root = record(json);
	if (!root) {
		return { error: 'A flow file holds one JSON object: { "volt": "flow", "version": 1, "name": ..., "steps": [...] }.', problems: [] };
	}
	if (root.volt !== undefined && root.volt !== 'flow') {
		return { error: `Not a flow file: "volt" is ${JSON.stringify(root.volt)}, expected "flow".`, problems: [] };
	}
	if (root.volt === undefined && !Array.isArray(root.steps)) {
		return { error: 'Not a flow file: it has neither "volt": "flow" nor a "steps" list.', problems: [] };
	}
	const problems: IHttpFlowProblem[] = [];
	if (typeof root.version === 'number' && root.version > HTTP_FLOW_VERSION) {
		problems.push({ severity: 'warning', path: 'version', message: `This flow was written for format version ${root.version}; this Volt reads version ${HTTP_FLOW_VERSION}. Newer features are ignored.` });
	}
	const settingsRaw = record(root.settings) ?? {};
	const settings: IHttpFlowSettings = {
		iterations: Math.round(numberOf(settingsRaw.iterations, 1, 1, HTTP_FLOW_MAX_ITERATIONS)),
		delayMs: Math.round(numberOf(settingsRaw.delayMs, 0, 0, MAX_DELAY_MS)),
		stopOnFailure: settingsRaw.stopOnFailure !== false,
		timeoutMs: Math.round(numberOf(settingsRaw.timeoutMs, 0, 0, 3_600_000)),
		persistVariables: settingsRaw.persistVariables === true,
	};
	const dataRaw = record(root.data);
	let data: IHttpFlowData | undefined;
	if (dataRaw) {
		const file = textOf(dataRaw.file)?.trim();
		const rows = Array.isArray(dataRaw.rows) ? dataRaw.rows.map(row => record(row)).filter((row): row is Record<string, unknown> => !!row).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, valueText(value) ?? '']))) : undefined;
		if (file || rows?.length) {
			data = { ...(file ? { file } : {}), ...(rows?.length ? { rows } : {}) };
		}
	}
	const environment = textOf(root.environment)?.trim();
	const flow: IHttpFlow = {
		name: textOf(root.name)?.trim() || fallbackName,
		description: textOf(root.description) ?? '',
		...(environment ? { environment } : {}),
		variables: rowsOf(root.variables),
		settings,
		...(data ? { data } : {}),
		steps: parseSteps(root.steps, 'steps', problems, new Set(), { next: 1 }),
	};
	return { flow, problems };
}

function assertToFile(assert: IHttpFlowAssert): Record<string, unknown> {
	return { target: assert.target, ...(assert.path !== undefined && assert.path !== '' ? { path: assert.path } : {}), op: assert.op, ...(assert.value !== undefined ? { value: assert.value } : {}) };
}

function rowsToFile(rows: readonly IHttpKeyValue[]): Record<string, unknown>[] {
	return rows.map(row => ({ key: row.key, value: row.value, enabled: row.enabled }));
}

function stepToFile(step: IHttpFlowStep): Record<string, unknown> {
	const base = { id: step.id, kind: step.kind, ...(step.name ? { name: step.name } : {}), ...(step.disabled ? { disabled: true } : {}) };
	switch (step.kind) {
		case 'request': return {
			...base,
			...(step.ref ? { ref: { collection: step.ref.collection, path: [...step.ref.path] } } : {}),
			...(!step.ref && step.inline ? { inline: { method: step.inline.method, url: step.inline.url, ...(step.inline.headers.length ? { headers: rowsToFile(step.inline.headers) } : {}), ...(step.inline.bodyType !== 'none' ? { bodyType: step.inline.bodyType, body: step.inline.body } : {}) } } : {}),
			...(step.variables.length ? { variables: rowsToFile(step.variables) } : {}),
			...(step.extract.length ? { extract: step.extract.map(item => ({ name: item.name, from: item.from, ...(item.path !== undefined && item.path !== '' ? { [item.from === 'regex' ? 'pattern' : 'path']: item.path } : {}), ...(item.default !== undefined ? { default: item.default } : {}) })) } : {}),
			...(step.assert.length ? { assert: step.assert.map(assertToFile) } : {}),
			...(step.retry ? { retry: { times: step.retry.times, delayMs: step.retry.delayMs, backoff: step.retry.backoff, ...(step.retry.until ? { until: assertToFile(step.retry.until) } : {}) } } : {}),
			...(step.timeoutMs ? { timeoutMs: step.timeoutMs } : {}),
			...(step.continueOnFailure ? { continueOnFailure: true } : {}),
			...(step.runScripts === false ? { runScripts: false } : {}),
		};
		case 'delay': return { ...base, ms: step.ms };
		case 'set': return { ...base, variables: rowsToFile(step.variables) };
		case 'group': return { ...base, role: step.role, steps: step.steps.map(stepToFile) };
		case 'condition': return { ...base, if: assertToFile(step.if), steps: step.steps.map(stepToFile) };
		case 'repeat': return { ...base, ...(step.times !== undefined ? { times: step.times } : {}), ...(step.forEach ? { forEach: step.forEach } : {}), ...(step.as ? { as: step.as } : {}), ...(step.until ? { until: assertToFile(step.until) } : {}), max: step.max, steps: step.steps.map(stepToFile) };
	}
}

/** The flow as the JSON object its file holds, keys always in the same order. */
export function httpFlowToJson(flow: IHttpFlow): Record<string, unknown> {
	return {
		volt: 'flow',
		version: HTTP_FLOW_VERSION,
		name: flow.name,
		description: flow.description,
		...(flow.environment ? { environment: flow.environment } : {}),
		variables: rowsToFile(flow.variables),
		settings: { iterations: flow.settings.iterations, delayMs: flow.settings.delayMs, stopOnFailure: flow.settings.stopOnFailure, timeoutMs: flow.settings.timeoutMs, persistVariables: flow.settings.persistVariables },
		...(flow.data && (flow.data.file || flow.data.rows?.length) ? { data: { ...(flow.data.file ? { file: flow.data.file } : {}), ...(flow.data.rows?.length ? { rows: flow.data.rows } : {}) } } : {}),
		steps: flow.steps.map(stepToFile),
	};
}

/** The file's text: 2-space JSON, the same for the same flow. */
export function serializeHttpFlow(flow: IHttpFlow): string {
	return `${JSON.stringify(httpFlowToJson(flow), null, 2)}\n`;
}

const NEEDS_PATH: ReadonlySet<HttpFlowAssertTarget> = new Set(['header', 'json', 'variable']);

function assertProblems(assert: IHttpFlowAssert, path: string, stepId: string, out: IHttpFlowProblem[]): void {
	const add = (message: string) => out.push({ severity: 'error', path, message, stepId });
	if (NEEDS_PATH.has(assert.target) && !assert.path?.trim()) {
		add(assert.target === 'json' ? 'A json assertion needs a "path" such as $.id.' : assert.target === 'header' ? 'A header assertion needs the header\'s name in "path".' : 'A variable assertion needs the variable\'s name in "path".');
	}
	if (assert.target === 'json' && assert.path?.trim() && !parseHttpJsonPath(assert.path)) {
		add(`"${assert.path}" is not a JSONPath this client reads (use $.a.b[0].c, $..id or [*]).`);
	}
	if (assert.op !== 'exists' && assert.op !== 'notExists' && (assert.value === undefined || assert.value === '')) {
		add(`The "${assert.op}" operator needs a "value".`);
	}
	if (assert.op === 'matches' && typeof assert.value === 'string' && !assert.value.includes('{{') && !httpFlowRegExp(assert.value)) {
		add(`"${assert.value}" is not a valid regular expression.`);
	}
	if ((assert.op === 'schema' || assert.target === 'schema') && assert.value !== undefined && !record(typeof assert.value === 'string' ? safeJson(assert.value) : assert.value)) {
		add('A schema assertion\'s "value" must be a JSON Schema object.');
	}
}

/**
 * What would make the flow fail or do nothing, before it runs. `refExists` tells whether a saved
 * request is there (undefined: not known, say nothing).
 */
export function validateHttpFlow(flow: IHttpFlow, refExists?: (ref: IHttpFlowRef) => boolean | undefined): IHttpFlowProblem[] {
	const out: IHttpFlowProblem[] = [];
	if (!httpFlowStepsOf(flow.steps).some(step => step.kind === 'request' && !step.disabled)) {
		out.push({ severity: 'warning', path: 'steps', message: 'The flow has no request to send.' });
	}
	if (flow.data?.file && flow.data.rows?.length) {
		out.push({ severity: 'warning', path: 'data', message: 'The data set has both a file and inline rows: the file is used.' });
	}
	const visit = (steps: readonly IHttpFlowStep[], path: string) => steps.forEach((step, index) => {
		const at = `${path}[${index}]`;
		const error = (message: string, where = at) => out.push({ severity: 'error', path: where, message, stepId: step.id });
		switch (step.kind) {
			case 'request':
				if (step.ref) {
					if (!step.ref.collection.trim() || !step.ref.path.length) {
						error('A "ref" needs the collection file and the request\'s name path: { "collection": "api.postman_collection.json", "path": ["Folder", "Request"] }.', `${at}.ref`);
					} else if (refExists?.(step.ref) === false) {
						error(`The request "${step.ref.path.join(' / ')}" was not found in ${step.ref.collection}.`, `${at}.ref`);
					}
				} else if (!step.inline) {
					error('A request step needs a "ref" to a saved request or an "inline" request.');
				} else if (!step.inline.url.trim()) {
					error('The inline request has no URL.', `${at}.inline`);
				}
				step.extract.forEach((item, at2) => {
					const where = `${at}.extract[${at2}]`;
					if (!item.name.trim()) {
						error('An extraction needs the name of the variable it sets.', where);
					}
					if ((item.from === 'json' || item.from === 'header' || item.from === 'regex' || item.from === 'cookie') && !item.path?.trim()) {
						error(item.from === 'json' ? 'A json extraction needs a "path" such as $.token.' : item.from === 'regex' ? 'A regex extraction needs a "pattern".' : `A ${item.from} extraction needs the ${item.from}'s name in "path".`, where);
					} else if (item.from === 'json' && item.path && !parseHttpJsonPath(item.path)) {
						error(`"${item.path}" is not a JSONPath this client reads (use $.a.b[0].c, $..id or [*]).`, where);
					} else if (item.from === 'regex' && item.path && !httpFlowRegExp(item.path)) {
						error(`"${item.path}" is not a valid regular expression.`, where);
					}
				});
				step.assert.forEach((item, at2) => assertProblems(item, `${at}.assert[${at2}]`, step.id, out));
				if (step.retry?.until) {
					assertProblems(step.retry.until, `${at}.retry.until`, step.id, out);
				}
				break;
			case 'set':
				if (!step.variables.some(row => row.enabled && row.key)) {
					out.push({ severity: 'warning', path: at, message: 'This step sets no variable.', stepId: step.id });
				}
				break;
			case 'condition':
				assertProblems(step.if, `${at}.if`, step.id, out);
				break;
			case 'repeat':
				if (step.times === undefined && !step.forEach && !step.until) {
					error('A repeat step needs "times", "forEach" (a variable holding a JSON array) or "until" (an assertion).');
				}
				if (step.until) {
					assertProblems(step.until, `${at}.until`, step.id, out);
				}
				break;
		}
		if (isHttpFlowContainer(step)) {
			if (!step.steps.length) {
				out.push({ severity: 'warning', path: `${at}.steps`, message: 'This step has no steps inside.', stepId: step.id });
			}
			visit(step.steps, `${at}.steps`);
		}
	});
	visit(flow.steps, 'steps');
	return out;
}

/** What an agent or a model needs to write a flow file by hand. */
export const HTTP_FLOW_FORMAT_GUIDE = [
	'A flow is one JSON file named <name>.volt-flow.json:',
	'{ "volt": "flow", "version": 1, "name": "Checkout", "description": "", "environment": "staging" (optional), "variables": [{ "key": "email", "value": "qa@example.com", "enabled": true }], "settings": { "iterations": 1, "delayMs": 0, "stopOnFailure": true, "timeoutMs": 0, "persistVariables": false }, "data": { "file": "users.csv" } or { "rows": [{ "email": "a@x.io" }] } (optional: one iteration per row, columns become variables), "steps": [ ... ] }',
	'Steps run in order. Every step may have "id" (kept if given), "name" and "disabled". Kinds:',
	'- request: either "ref": { "collection": "<collection file path relative to the flow file or the project>", "path": ["Folder", "Request name"] } to send a saved request, or "inline": { "method": "POST", "url": "{{baseUrl}}/login", "headers": [{ "key": "Accept", "value": "application/json", "enabled": true }], "bodyType": "json" | "text" | "xml" | "form", "body": "..." }. Optional: "variables" (key/value overrides for this send), "extract", "assert", "retry": { "times": 5, "delayMs": 1000, "backoff": 1, "until": <assertion> } (send again until the assertion holds: polling), "timeoutMs", "continueOnFailure": true, "runScripts": false (ignore the saved request\'s own Postman tests).',
	'- delay: { "kind": "delay", "ms": 500 }.',
	'- set: { "kind": "set", "variables": [{ "key": "orderUrl", "value": "{{baseUrl}}/orders/{{orderId}}", "enabled": true }] }.',
	'- group: { "kind": "group", "name": "...", "role": "setup" | "steps" | "teardown", "steps": [...] }. A failed setup stops the run; a teardown group runs even after a failure.',
	'- condition: { "kind": "condition", "if": <assertion>, "steps": [...] }: the steps run only when the assertion holds on the variables and the last response.',
	'- repeat: { "kind": "repeat", "times": 3, "steps": [...] } or "forEach": "<variable holding a JSON array>" with "as": "item" (each item goes into {{item}}, its position into {{itemIndex}}) or "until": <assertion>; "max" caps the rounds.',
	'extract: [{ "name": "<variable>", "from": "json" | "header" | "status" | "text" | "regex" | "cookie" | "time", "path": "$.data.token" (a JSONPath, a header or cookie name) or "pattern": "<regex, first group>", "default": "..." (optional) }]. Extracted values are {{variables}} in every later step.',
	'assert (an assertion): { "target": "status" | "time" | "header" | "json" | "text" | "size" | "contentType" | "schema" | "variable", "path": "<JSONPath, header name or variable name>", "op": "equals" | "notEquals" | "contains" | "notContains" | "matches" | "exists" | "notExists" | "gt" | "gte" | "lt" | "lte" | "in" | "type" | "length" | "schema", "value": ... }. Examples: { "target": "status", "op": "equals", "value": 201 }, { "target": "json", "path": "$.items", "op": "length", "value": ">0" }, { "target": "json", "path": "$.user.id", "op": "equals", "value": "{{userId}}" }, { "target": "time", "op": "lt", "value": 800 }, { "target": "schema", "op": "schema", "value": { "type": "object", "required": ["id"], "properties": { "id": { "type": "integer" } } } }.',
	'JSONPath: $.a.b[0].c, $..id (anywhere), [*] (every item). Use {{name}} for variables in URLs, headers, bodies and assertion values.',
].join('\n');

// --- JSONPath -----------------------------------------------------------------------------------

interface IPathSegment {
	readonly deep: boolean;
	readonly key?: string;
	readonly index?: number;
	readonly wild?: boolean;
}

/** The segments of `$.a.b[0].c`, `$..id`, `a[*].b`; undefined when the path is malformed. */
export function parseHttpJsonPath(path: string): readonly IPathSegment[] | undefined {
	let text = path.trim();
	if (text.startsWith('$')) {
		text = text.slice(1);
	}
	const out: IPathSegment[] = [];
	let at = 0;
	let first = true;
	while (at < text.length) {
		let deep = false;
		if (text[at] === '.') {
			if (text[at + 1] === '.') {
				deep = true;
				at += 2;
			} else {
				at++;
			}
			if (at >= text.length) {
				return undefined;
			}
		} else if (text[at] !== '[' && !first) {
			return undefined;
		}
		first = false;
		if (text[at] === '[') {
			const end = text.indexOf(']', at);
			if (end < 0) {
				return undefined;
			}
			const inner = text.slice(at + 1, end).trim();
			at = end + 1;
			const quoted = /^(['"])(.*)\1$/.exec(inner);
			if (inner === '*') {
				out.push({ deep, wild: true });
			} else if (quoted) {
				out.push({ deep, key: quoted[2] });
			} else if (/^-?\d+$/.test(inner)) {
				out.push({ deep, index: Number(inner) });
			} else if (inner) {
				out.push({ deep, key: inner });
			} else {
				return undefined;
			}
			continue;
		}
		if (text[at] === '*') {
			out.push({ deep, wild: true });
			at++;
			continue;
		}
		let end = at;
		while (end < text.length && text[end] !== '.' && text[end] !== '[') {
			end++;
		}
		if (end === at) {
			return undefined;
		}
		out.push({ deep, key: text.slice(at, end) });
		at = end;
	}
	return out;
}

function descendants(value: unknown, out: unknown[]): void {
	out.push(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			descendants(item, out);
		}
	} else if (value && typeof value === 'object') {
		for (const item of Object.values(value)) {
			descendants(item, out);
		}
	}
}

/** Every value at `path`, in document order. Empty when there is none or the path is malformed. */
export function httpJsonPath(value: unknown, path: string): unknown[] {
	const segments = parseHttpJsonPath(path);
	if (!segments) {
		return [];
	}
	let nodes: unknown[] = [value];
	for (const segment of segments) {
		let from = nodes;
		if (segment.deep) {
			from = [];
			for (const node of nodes) {
				descendants(node, from);
			}
		}
		const next: unknown[] = [];
		for (const node of from) {
			if (segment.wild) {
				if (Array.isArray(node)) {
					next.push(...node);
				} else if (node && typeof node === 'object') {
					next.push(...Object.values(node));
				}
			} else if (segment.index !== undefined) {
				if (Array.isArray(node)) {
					const index = segment.index < 0 ? node.length + segment.index : segment.index;
					if (index >= 0 && index < node.length) {
						next.push(node[index]);
					}
				}
			} else if (segment.key !== undefined && node && typeof node === 'object') {
				if (Array.isArray(node)) {
					if (/^\d+$/.test(segment.key) && Number(segment.key) < node.length) {
						next.push(node[Number(segment.key)]);
					}
				} else if (Object.prototype.hasOwnProperty.call(node, segment.key)) {
					next.push((node as Record<string, unknown>)[segment.key]);
				}
			}
		}
		nodes = next;
	}
	return nodes;
}

/** What a path stands for: the one value of a plain path, the list of matches of one with `..` or `*`. */
export function readHttpJsonPath(value: unknown, path: string): { readonly found: boolean; readonly value: unknown } {
	const segments = parseHttpJsonPath(path);
	if (!segments) {
		return { found: false, value: undefined };
	}
	const matches = httpJsonPath(value, path);
	if (segments.some(segment => segment.deep || segment.wild)) {
		return { found: matches.length > 0, value: matches };
	}
	return { found: matches.length > 0, value: matches[0] };
}

/** The paths of a JSON value's leaves (and its arrays), for picking one from a response. */
export function listHttpJsonPaths(value: unknown, max = 200): { readonly path: string; readonly preview: string }[] {
	const out: { path: string; preview: string }[] = [];
	const visit = (node: unknown, path: string, depth: number) => {
		if (out.length >= max || depth > 8) {
			return;
		}
		if (Array.isArray(node)) {
			out.push({ path, preview: `[${node.length}]` });
			if (node.length) {
				visit(node[0], `${path}[0]`, depth + 1);
			}
		} else if (node && typeof node === 'object') {
			for (const [key, item] of Object.entries(node)) {
				visit(item, /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}['${key}']`, depth + 1);
			}
		} else {
			const text = valueText(node) ?? '';
			out.push({ path, preview: text.length > 60 ? `${text.slice(0, 60)}...` : text });
		}
	};
	visit(value, '$', 0);
	return out.filter(item => item.path !== '$');
}

// --- Variables, extraction, assertions ----------------------------------------------------------

/** A value as a variable holds it: text as it is, anything else as JSON. */
function valueText(value: unknown): string | undefined {
	return value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value);
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** `{{name}}` replaced by the variable's value; a name with no value stays as written. */
export function fillHttpFlowVariables(text: string, variables: Readonly<Record<string, string>>): string {
	return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, name: string) => Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : match);
}

/** `/pattern/flags` or a bare pattern as a RegExp; undefined when it does not compile. */
export function httpFlowRegExp(pattern: string): RegExp | undefined {
	const slashed = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
	try {
		return slashed ? new RegExp(slashed[1], slashed[2]) : new RegExp(pattern);
	} catch {
		return undefined;
	}
}

/** What the engine reads of a response. */
export interface IHttpFlowResponse {
	readonly status: number;
	readonly statusText: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
	readonly durationMs: number;
	readonly size: number;
}

function headerOf(response: IHttpFlowResponse, name: string): string | undefined {
	const wanted = name.trim().toLowerCase();
	for (const [key, value] of Object.entries(response.headers)) {
		if (key.toLowerCase() === wanted) {
			return value;
		}
	}
	return undefined;
}

function cookieOf(response: IHttpFlowResponse, name: string): string | undefined {
	const header = headerOf(response, 'set-cookie');
	if (header === undefined) {
		return undefined;
	}
	// Several cookies arrive as lines or joined by commas; a comma inside `Expires=Wed, 01 Jan` starts no cookie.
	for (const cookie of header.split(/\r?\n|,(?=\s*[^;=,\s]+=)/)) {
		const pair = cookie.split(';')[0];
		const at = pair.indexOf('=');
		if (at > 0 && pair.slice(0, at).trim() === name.trim()) {
			return pair.slice(at + 1).trim();
		}
	}
	return undefined;
}

export interface IHttpFlowExtracted {
	readonly name: string;
	/** The value the variable got (the default when the response had none). */
	readonly value?: string;
	/** The response had it. */
	readonly found: boolean;
	readonly error?: string;
}

/** Takes one value out of a response. */
export function extractHttpFlowValue(extract: IHttpFlowExtract, response: IHttpFlowResponse): IHttpFlowExtracted {
	let value: string | undefined;
	let error: string | undefined;
	const where = extract.path?.trim() ?? '';
	switch (extract.from) {
		case 'status': value = String(response.status); break;
		case 'time': value = String(response.durationMs); break;
		case 'text': value = response.body; break;
		case 'header': value = headerOf(response, where); break;
		case 'cookie': value = cookieOf(response, where); break;
		case 'regex': {
			const pattern = httpFlowRegExp(where);
			if (!pattern) {
				error = `"${where}" is not a valid regular expression`;
				break;
			}
			const match = pattern.exec(response.body);
			value = match ? match[1] ?? match[0] : undefined;
			break;
		}
		case 'json': {
			const json = safeJson(response.body);
			if (json === undefined) {
				error = 'the response body is not JSON';
				break;
			}
			const read = readHttpJsonPath(json, where || '$');
			value = read.found ? valueText(read.value) : undefined;
			break;
		}
	}
	if (value !== undefined) {
		return { name: extract.name, value, found: true };
	}
	const subject = extract.from === 'json' || extract.from === 'regex' ? where : extract.from === 'header' || extract.from === 'cookie' ? `${extract.from} ${where}` : extract.from;
	return { name: extract.name, ...(extract.default !== undefined ? { value: extract.default } : {}), found: false, error: error ?? `the response has no ${subject}` };
}

export interface IHttpFlowAssertContext {
	/** The response the assertion reads; absent for a condition before any request. */
	readonly response?: IHttpFlowResponse;
	readonly variables: Readonly<Record<string, string>>;
}

export interface IHttpFlowAssertResult {
	/** What was checked: `$.user.id equals 42`. */
	readonly label: string;
	readonly passed: boolean;
	/** The label when it passed; why not when it failed: `expected $.user.id to equal 42, got 41`. */
	readonly message: string;
	readonly expected?: string;
	readonly actual?: string;
}

function show(value: unknown): string {
	if (value === undefined) {
		return 'nothing';
	}
	const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
	return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function typeName(value: unknown): string {
	return value === null ? 'null' : Array.isArray(value) ? 'array' : value === undefined ? 'undefined' : typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
	}
	const left = record(a);
	const right = record(b);
	if (left && right) {
		const keys = Object.keys(left);
		return keys.length === Object.keys(right).length && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
	}
	return false;
}

/** Variables are text and a file's values are whatever was typed: `"42"` equals 42, `"true"` equals true. */
function looseEqual(actual: unknown, expected: unknown): boolean {
	if (deepEqual(actual, expected)) {
		return true;
	}
	if (typeof actual === 'string' && typeof expected !== 'string') {
		return expected !== null && typeof expected === 'object' ? deepEqual(safeJson(actual), expected) : actual === String(expected);
	}
	if (typeof expected === 'string' && typeof actual !== 'string' && actual !== undefined) {
		return actual !== null && typeof actual === 'object' ? deepEqual(actual, safeJson(expected)) : String(actual) === expected;
	}
	return false;
}

/** An expected value written as text, read as the kind of thing it is compared with (for the message). */
function likeActual(expected: unknown, actual: unknown): unknown {
	if (typeof expected === 'string' && typeof actual !== 'string' && /^(?:-?\d+(?:\.\d+)?|true|false|null)$/.test(expected.trim())) {
		return safeJson(expected.trim());
	}
	return expected;
}

function subjectOf(assert: IHttpFlowAssert): string {
	switch (assert.target) {
		case 'status': return 'status';
		case 'time': return 'response time';
		case 'header': return `header ${assert.path ?? ''}`.trim();
		case 'json': return assert.path?.trim() || '$';
		case 'text': return 'body';
		case 'size': return 'size';
		case 'contentType': return 'content type';
		case 'schema': return assert.path?.trim() || 'body';
		case 'variable': return `{{${assert.path ?? ''}}}`;
	}
}

const OP_WORDS: Readonly<Record<HttpFlowAssertOp, readonly [string, string]>> = {
	equals: ['equals', 'to equal'], notEquals: ['does not equal', 'not to equal'], contains: ['contains', 'to contain'], notContains: ['does not contain', 'not to contain'],
	matches: ['matches', 'to match'], exists: ['exists', 'to exist'], notExists: ['does not exist', 'not to exist'], gt: ['is above', 'to be above'], gte: ['is at least', 'to be at least'],
	lt: ['is below', 'to be below'], lte: ['is at most', 'to be at most'], in: ['is one of', 'to be one of'], type: ['is of type', 'to be of type'], length: ['has length', 'to have length'], schema: ['matches the schema', 'to match the schema'],
};

/** What an assertion checks, in words. */
export function httpFlowAssertLabel(assert: IHttpFlowAssert): string {
	const subject = subjectOf(assert);
	if (assert.op === 'exists' || assert.op === 'notExists' || assert.op === 'schema' || assert.target === 'schema') {
		return `${subject} ${OP_WORDS[assert.target === 'schema' ? 'schema' : assert.op][0]}`;
	}
	return `${subject} ${OP_WORDS[assert.op][0]} ${typeof assert.value === 'string' ? assert.value : show(assert.value)}`;
}

function lengthOf(value: unknown): number | undefined {
	return typeof value === 'string' || Array.isArray(value) ? value.length : record(value) ? Object.keys(value as object).length : undefined;
}

/** Checks one assertion. `{{variables}}` in its value are filled in first. */
export function evaluateHttpFlowAssert(assert: IHttpFlowAssert, context: IHttpFlowAssertContext): IHttpFlowAssertResult {
	const fill = (value: unknown): unknown => typeof value === 'string' ? fillHttpFlowVariables(value, context.variables) : Array.isArray(value) ? value.map(fill) : value;
	const filled: IHttpFlowAssert = { ...assert, ...(assert.path !== undefined ? { path: assert.target === 'variable' ? assert.path.replace(/^\{\{\s*|\s*\}\}$/g, '') : fillHttpFlowVariables(assert.path, context.variables) } : {}), ...(assert.value !== undefined ? { value: fill(assert.value) } : {}) };
	const label = httpFlowAssertLabel(filled);
	const subject = subjectOf(filled);
	const op: HttpFlowAssertOp = filled.target === 'schema' ? 'schema' : filled.op;
	const failed = (message: string, expected?: unknown, actual?: unknown): IHttpFlowAssertResult => ({ label, passed: false, message, ...(expected !== undefined ? { expected: valueText(expected) } : {}), ...(actual !== undefined ? { actual: valueText(actual) } : {}) });
	const response = context.response;
	let actual: unknown;
	if (filled.target === 'variable') {
		const name = filled.path?.trim() ?? '';
		actual = Object.prototype.hasOwnProperty.call(context.variables, name) ? context.variables[name] : undefined;
	} else if (!response) {
		return failed(`expected ${subject} ${OP_WORDS[op][1]}${op === 'exists' || op === 'notExists' || op === 'schema' ? '' : ` ${show(filled.value)}`}, but there is no response`);
	} else {
		switch (filled.target) {
			case 'status': actual = response.status; break;
			case 'time': actual = response.durationMs; break;
			case 'size': actual = response.size; break;
			case 'text': actual = response.body; break;
			case 'header': actual = headerOf(response, filled.path ?? ''); break;
			case 'contentType': actual = headerOf(response, 'content-type'); break;
			case 'json':
			case 'schema': {
				const json = safeJson(response.body);
				if (json === undefined) {
					if (op === 'notExists') {
						return { label, passed: true, message: label };
					}
					return failed(`expected ${subject} ${OP_WORDS[op][1]}${op === 'exists' || op === 'schema' ? '' : ` ${show(filled.value)}`}, but the response body is not JSON`);
				}
				actual = readHttpJsonPath(json, filled.path?.trim() || '$').value;
				break;
			}
		}
	}
	const expected = likeActual(filled.value, actual);
	const verdict = (passed: boolean): IHttpFlowAssertResult => passed
		? { label, passed: true, message: label }
		: failed(op === 'exists' ? `expected ${subject} to exist, but it does not` : op === 'notExists' ? `expected ${subject} not to exist, got ${show(actual)}` : `expected ${subject} ${OP_WORDS[op][1]} ${show(expected)}, got ${show(actual)}`, op === 'exists' || op === 'notExists' ? undefined : expected, actual);
	switch (op) {
		case 'exists': return verdict(actual !== undefined);
		case 'notExists': return verdict(actual === undefined);
		case 'equals': return verdict(looseEqual(actual, expected));
		case 'notEquals': return verdict(!looseEqual(actual, expected));
		case 'contains':
		case 'notContains': {
			let has: boolean;
			if (Array.isArray(actual)) {
				has = actual.some(item => looseEqual(item, expected));
			} else if (typeof actual === 'string') {
				has = actual.includes(valueText(filled.value) ?? '');
			} else if (record(actual)) {
				has = Object.prototype.hasOwnProperty.call(actual, String(filled.value));
			} else {
				has = actual !== undefined && String(actual).includes(valueText(filled.value) ?? '');
			}
			return verdict(op === 'contains' ? has : !has);
		}
		case 'matches': {
			const pattern = httpFlowRegExp(valueText(filled.value) ?? '');
			if (!pattern) {
				return failed(`${show(filled.value)} is not a valid regular expression`);
			}
			return verdict(actual !== undefined && pattern.test(valueText(actual) ?? ''));
		}
		case 'gt':
		case 'gte':
		case 'lt':
		case 'lte': {
			const left = typeof actual === 'number' ? actual : typeof actual === 'string' && actual.trim() ? Number(actual) : NaN;
			const right = typeof expected === 'number' ? expected : typeof expected === 'string' && expected.trim() ? Number(expected) : NaN;
			if (Number.isNaN(right)) {
				return failed(`expected ${subject} ${OP_WORDS[op][1]} a number, but the value to compare with is ${show(filled.value)}`);
			}
			if (Number.isNaN(left)) {
				return verdict(false);
			}
			return verdict(op === 'gt' ? left > right : op === 'gte' ? left >= right : op === 'lt' ? left < right : left <= right);
		}
		case 'in': {
			const parsed = typeof filled.value === 'string' ? safeJson(filled.value) : filled.value;
			const options: unknown[] = Array.isArray(parsed) ? parsed : typeof filled.value === 'string' ? filled.value.split(',').map(item => item.trim()) : [filled.value];
			return actual !== undefined && options.some(option => looseEqual(actual, option)) ? { label, passed: true, message: label } : failed(`expected ${subject} to be one of ${show(options)}, got ${show(actual)}`, options, actual);
		}
		case 'type': {
			const wanted = String(filled.value ?? '').trim().toLowerCase();
			const name = typeName(actual);
			const passed = wanted === name || (wanted === 'integer' && typeof actual === 'number' && Number.isInteger(actual));
			return passed ? { label, passed: true, message: label } : failed(`expected ${subject} to be of type ${wanted}, got ${name}${actual === undefined ? '' : ` (${show(actual)})`}`, wanted, name);
		}
		case 'length': {
			const length = lengthOf(actual);
			const rule = /^\s*(>=|<=|>|<|==?|!=)?\s*(\d+)\s*$/.exec(String(filled.value ?? ''));
			if (!rule) {
				return failed(`expected ${subject} to have length ${show(filled.value)}, but that is not a number (use 3, ">0" or "<=10")`);
			}
			if (length === undefined) {
				return failed(`expected ${subject} to have length ${rule[1] ?? ''}${rule[2]}, got ${show(actual)}, which has no length`, filled.value, actual);
			}
			const want = Number(rule[2]);
			const comparator = rule[1] ?? '==';
			const passed = comparator === '>' ? length > want : comparator === '>=' ? length >= want : comparator === '<' ? length < want : comparator === '<=' ? length <= want : comparator === '!=' ? length !== want : length === want;
			return passed ? { label, passed: true, message: label } : failed(`expected ${subject} to have length ${rule[1] ?? ''}${want}, got ${length}`, `${rule[1] ?? ''}${want}`, length);
		}
		case 'schema': {
			const schema = typeof filled.value === 'string' ? safeJson(filled.value) : filled.value;
			if (!record(schema)) {
				return failed(`expected ${subject} to match a schema, but the assertion has no JSON Schema object as its value`);
			}
			if (actual === undefined) {
				return failed(`expected ${subject} to match the schema, but it does not exist`);
			}
			const errors = validateHttpJsonSchema(actual, schema, filled.path?.trim() || '$');
			return errors.length ? failed(`expected ${subject} to match the schema: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? `; and ${errors.length - 5} more` : ''}`) : { label, passed: true, message: label };
		}
	}
}

// --- JSON Schema (the basics) -------------------------------------------------------------------

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case 'integer': return typeof value === 'number' && Number.isInteger(value);
		case 'number': return typeof value === 'number';
		case 'array': return Array.isArray(value);
		case 'null': return value === null;
		case 'object': return !!record(value);
		default: return typeof value === type;
	}
}

/**
 * Checks a value against a JSON Schema's everyday keywords: type, required, properties,
 * additionalProperties: false, items, enum, const, minimum/maximum, minLength/maxLength, pattern,
 * minItems/maxItems. Returns what is wrong, each with the path it is at.
 */
export function validateHttpJsonSchema(value: unknown, schema: unknown, path = '$'): string[] {
	const rules = record(schema);
	if (!rules) {
		return [];
	}
	const errors: string[] = [];
	const types = typeof rules.type === 'string' ? [rules.type] : Array.isArray(rules.type) ? rules.type.filter((item): item is string => typeof item === 'string') : undefined;
	if (types && !types.some(type => matchesType(value, type))) {
		errors.push(`${path}: expected ${types.join(' or ')}, got ${typeof value === 'number' && types.includes('integer') ? 'a number that is not whole' : typeName(value)}`);
		return errors;
	}
	if (Array.isArray(rules.enum) && !rules.enum.some(item => deepEqual(item, value))) {
		errors.push(`${path}: expected one of ${show(rules.enum)}, got ${show(value)}`);
	}
	if (rules.const !== undefined && !deepEqual(rules.const, value)) {
		errors.push(`${path}: expected ${show(rules.const)}, got ${show(value)}`);
	}
	if (typeof value === 'number') {
		if (typeof rules.minimum === 'number' && value < rules.minimum) {
			errors.push(`${path}: expected at least ${rules.minimum}, got ${value}`);
		}
		if (typeof rules.maximum === 'number' && value > rules.maximum) {
			errors.push(`${path}: expected at most ${rules.maximum}, got ${value}`);
		}
	}
	if (typeof value === 'string') {
		if (typeof rules.minLength === 'number' && value.length < rules.minLength) {
			errors.push(`${path}: expected at least ${rules.minLength} characters, got ${value.length}`);
		}
		if (typeof rules.maxLength === 'number' && value.length > rules.maxLength) {
			errors.push(`${path}: expected at most ${rules.maxLength} characters, got ${value.length}`);
		}
		if (typeof rules.pattern === 'string') {
			const pattern = httpFlowRegExp(rules.pattern);
			if (pattern && !pattern.test(value)) {
				errors.push(`${path}: expected text matching ${rules.pattern}, got ${show(value)}`);
			}
		}
	}
	if (Array.isArray(value)) {
		if (typeof rules.minItems === 'number' && value.length < rules.minItems) {
			errors.push(`${path}: expected at least ${rules.minItems} items, got ${value.length}`);
		}
		if (typeof rules.maxItems === 'number' && value.length > rules.maxItems) {
			errors.push(`${path}: expected at most ${rules.maxItems} items, got ${value.length}`);
		}
		if (record(rules.items)) {
			value.forEach((item, index) => {
				if (errors.length < 50) {
					errors.push(...validateHttpJsonSchema(item, rules.items, `${path}[${index}]`));
				}
			});
		}
	}
	const object = record(value);
	if (object) {
		const properties = record(rules.properties) ?? {};
		if (Array.isArray(rules.required)) {
			for (const key of rules.required) {
				if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(object, key)) {
					errors.push(`${path}: missing required property "${key}"`);
				}
			}
		}
		for (const [key, rule] of Object.entries(properties)) {
			if (Object.prototype.hasOwnProperty.call(object, key)) {
				errors.push(...validateHttpJsonSchema(object[key], rule, `${path}.${key}`));
			}
		}
		if (rules.additionalProperties === false) {
			for (const key of Object.keys(object)) {
				if (!Object.prototype.hasOwnProperty.call(properties, key)) {
					errors.push(`${path}: unexpected property "${key}"`);
				}
			}
		}
	}
	return errors;
}

/** A schema that a value fits: its types and, for objects, the properties it has (all required). */
export function inferHttpJsonSchema(value: unknown, depth = 0): Record<string, unknown> {
	if (Array.isArray(value)) {
		return { type: 'array', ...(value.length && depth < 6 ? { items: inferHttpJsonSchema(value[0], depth + 1) } : {}) };
	}
	const object = record(value);
	if (object) {
		if (depth >= 6) {
			return { type: 'object' };
		}
		return { type: 'object', required: Object.keys(object), properties: Object.fromEntries(Object.entries(object).map(([key, item]) => [key, inferHttpJsonSchema(item, depth + 1)])) };
	}
	if (value === null) {
		return {};
	}
	return { type: typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value };
}

// --- Data rows ----------------------------------------------------------------------------------

/** CSV with a header row: quoted fields, doubled quotes, commas, semicolons or tabs between fields. */
export function parseHttpFlowCsv(text: string): Record<string, string>[] {
	const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
	const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
	const count = (char: string) => firstLine.split(char).length - 1;
	const delimiter = count('\t') > count(',') && count('\t') >= count(';') ? '\t' : count(';') > count(',') ? ';' : ',';
	const records: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	let any = false;
	for (let at = 0; at < source.length; at++) {
		const char = source[at];
		if (quoted) {
			if (char === '"') {
				if (source[at + 1] === '"') {
					field += '"';
					at++;
				} else {
					quoted = false;
				}
			} else {
				field += char;
			}
			continue;
		}
		if (char === '"' && field === '') {
			quoted = true;
			any = true;
		} else if (char === delimiter) {
			row.push(field);
			field = '';
			any = true;
		} else if (char === '\n' || char === '\r') {
			if (char === '\r' && source[at + 1] === '\n') {
				at++;
			}
			if (any || field !== '') {
				row.push(field);
				records.push(row);
			}
			row = [];
			field = '';
			any = false;
		} else {
			field += char;
		}
	}
	if (any || field !== '') {
		row.push(field);
		records.push(row);
	}
	const [head, ...rest] = records;
	if (!head) {
		return [];
	}
	const names = head.map(name => name.trim());
	return rest.filter(cells => cells.some(cell => cell.trim() !== '')).map(cells => Object.fromEntries(names.map((name, index) => [name, cells[index] ?? ''] as const).filter(([name]) => name !== '')));
}

/** A data file's rows: a JSON list of objects, or CSV. */
export function parseHttpFlowData(text: string, fileName = ''): { readonly rows: Record<string, string>[]; readonly error?: string } {
	const looksJson = /\.json$/i.test(fileName) || /^\s*[[{]/.test(text);
	if (looksJson) {
		const json = safeJson(text);
		const list = Array.isArray(json) ? json : Array.isArray(record(json)?.rows) ? record(json)!.rows as unknown[] : undefined;
		if (!list) {
			return { rows: [], error: 'The data file is not a JSON list of objects.' };
		}
		const rows = list.map(item => record(item)).filter((item): item is Record<string, unknown> => !!item).map(item => Object.fromEntries(Object.entries(item).map(([key, value]) => [key, valueText(value) ?? ''])));
		return { rows: rows.slice(0, HTTP_FLOW_MAX_ITERATIONS) };
	}
	return { rows: parseHttpFlowCsv(text).slice(0, HTTP_FLOW_MAX_ITERATIONS) };
}

// --- A run's result -----------------------------------------------------------------------------

export type HttpFlowStepStatus = 'queued' | 'running' | 'passed' | 'failed' | 'skipped' | 'error';

/** What the reports read of an exchange; the client's own exchange has all of it. */
export interface IHttpFlowExchange {
	readonly method: string;
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly body?: string;
	readonly response?: IHttpFlowResponse;
	readonly error?: string;
	readonly tests?: readonly { readonly name: string; readonly passed: boolean; readonly skipped?: boolean; readonly error?: string }[];
	readonly scriptError?: string;
}

/** One step of one run. A step in a loop or an iteration has one of these per round. */
export interface IHttpFlowStepRun<E extends IHttpFlowExchange = IHttpFlowExchange> {
	/** Unique in the run. */
	readonly key: string;
	readonly stepId: string;
	readonly parentKey?: string;
	readonly depth: number;
	readonly kind: HttpFlowStepKind;
	readonly name: string;
	/** 0-based. */
	readonly iteration: number;
	status: HttpFlowStepStatus;
	attempts: number;
	durationMs: number;
	method?: string;
	url?: string;
	statusCode?: number;
	/** Why it is an error, or why it was skipped. */
	error?: string;
	asserts: IHttpFlowAssertResult[];
	extracted: IHttpFlowExtracted[];
	exchange?: E;
	/** The saved request it sent, to open it. */
	collection?: string;
	requestId?: string;
}

export interface IHttpFlowTotals {
	/** Steps that do something (requests, delays, sets); containers are not counted. */
	steps: number;
	passed: number;
	failed: number;
	skipped: number;
	errors: number;
	requests: number;
	asserts: number;
	assertsFailed: number;
}

export type HttpFlowRunState = 'running' | 'passed' | 'failed' | 'stopped' | 'error';

export interface IHttpFlowRun<E extends IHttpFlowExchange = IHttpFlowExchange> {
	readonly id: string;
	readonly flowName: string;
	readonly startedAt: number;
	durationMs: number;
	state: HttpFlowRunState;
	/** Why the run could not go on (the data file is missing, the flow does not load). */
	error?: string;
	environment?: string;
	iterations: number;
	/** The iteration in progress, 0-based. */
	iteration: number;
	/** In the order they ran; `parentKey` and `depth` give the tree. */
	steps: IHttpFlowStepRun<E>[];
	totals: IHttpFlowTotals;
	/** The variables as the run left them. */
	variables: Record<string, string>;
}

export interface IHttpFlowRunSummary {
	readonly at: number;
	readonly durationMs: number;
	readonly state: HttpFlowRunState;
	readonly passed: number;
	readonly failed: number;
	readonly skipped: number;
	readonly total: number;
}

export function httpFlowTotals(steps: readonly IHttpFlowStepRun[]): IHttpFlowTotals {
	const totals: IHttpFlowTotals = { steps: 0, passed: 0, failed: 0, skipped: 0, errors: 0, requests: 0, asserts: 0, assertsFailed: 0 };
	for (const step of steps) {
		if (step.kind === 'group' || step.kind === 'condition' || step.kind === 'repeat') {
			// A loop that never met its condition, or a condition that could not be read, fails on its own.
			if ((step.status === 'failed' || step.status === 'error') && step.error) {
				totals.steps++;
				totals[step.status === 'failed' ? 'failed' : 'errors']++;
			}
			continue;
		}
		if (step.status === 'queued' || step.status === 'running') {
			continue;
		}
		totals.steps++;
		totals[step.status === 'passed' ? 'passed' : step.status === 'failed' ? 'failed' : step.status === 'skipped' ? 'skipped' : 'errors']++;
		if (step.kind === 'request' && step.status !== 'skipped') {
			totals.requests += step.attempts;
		}
		totals.asserts += step.asserts.length;
		totals.assertsFailed += step.asserts.filter(assert => !assert.passed).length;
	}
	return totals;
}

export function httpFlowRunSummary(run: IHttpFlowRun): IHttpFlowRunSummary {
	return { at: run.startedAt, durationMs: run.durationMs, state: run.state, passed: run.totals.passed, failed: run.totals.failed + run.totals.errors, skipped: run.totals.skipped, total: run.totals.steps };
}

// --- Reports ------------------------------------------------------------------------------------

function duration(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function stateWord(state: HttpFlowRunState): string {
	return state === 'passed' ? 'Passed' : state === 'failed' ? 'Failed' : state === 'stopped' ? 'Stopped' : state === 'error' ? 'Error' : 'Running';
}

/** The names of the containers above a step, outermost first. */
function ancestorsOf(run: IHttpFlowRun, step: IHttpFlowStepRun): string[] {
	const byKey = new Map(run.steps.map(item => [item.key, item]));
	const out: string[] = [];
	for (let parent = step.parentKey ? byKey.get(step.parentKey) : undefined; parent; parent = parent.parentKey ? byKey.get(parent.parentKey) : undefined) {
		out.unshift(parent.name);
	}
	return out;
}

function isLeaf(step: IHttpFlowStepRun): boolean {
	return step.kind === 'request' || step.kind === 'delay' || step.kind === 'set' || ((step.status === 'failed' || step.status === 'error') && !!step.error);
}

function summaryLine(run: IHttpFlowRun): string {
	const totals = run.totals;
	return `${stateWord(run.state)}: ${totals.passed} passed, ${totals.failed} failed${totals.errors ? `, ${totals.errors} errors` : ''}, ${totals.skipped} skipped of ${totals.steps} steps; ${totals.asserts - totals.assertsFailed}/${totals.asserts} assertions; ${totals.requests} requests in ${duration(run.durationMs)}${run.iterations > 1 ? `; ${run.iterations} iterations` : ''}${run.environment ? `; environment ${run.environment}` : ''}`;
}

/** A run as plain text an agent or a chat reads: each step's status, why a step failed, what was extracted. */
export function httpFlowRunText(run: IHttpFlowRun, options: { readonly maxValue?: number } = {}): string {
	const max = options.maxValue ?? 200;
	const cut = (text: string) => text.length > max ? `${text.slice(0, max)}...` : text;
	const lines: string[] = [`${run.flowName}: ${summaryLine(run)}`];
	if (run.error) {
		lines.push(`Error: ${run.error}`);
	}
	let iteration = -1;
	for (const step of run.steps) {
		if (run.iterations > 1 && step.iteration !== iteration) {
			iteration = step.iteration;
			lines.push('', `Iteration ${iteration + 1}`);
		}
		const pad = '  '.repeat(step.depth);
		const facts = [step.statusCode !== undefined ? String(step.statusCode) : '', step.statusCode !== undefined ? duration(step.durationMs) : '', step.attempts > 1 ? `${step.attempts} attempts` : ''].filter(Boolean).join(', ');
		lines.push(`${pad}[${step.status}] ${step.name}${step.method ? ` (${step.method} ${cut(step.url ?? '')})` : ''}${facts ? ` - ${facts}` : ''}`);
		if (step.error) {
			lines.push(`${pad}  ${step.status === 'skipped' ? 'skipped' : 'error'}: ${step.error}`);
		}
		for (const assert of step.asserts) {
			if (!assert.passed) {
				lines.push(`${pad}  failed: ${assert.message}`);
			}
		}
		for (const item of step.extracted) {
			lines.push(item.found ? `${pad}  ${item.name} = ${cut(item.value ?? '')}` : `${pad}  ${item.name}: ${item.error ?? 'not found'}${item.value !== undefined ? ` (default ${cut(item.value)})` : ''}`);
		}
		if ((step.status === 'failed' || step.status === 'error') && step.exchange?.response && step.exchange.response.body) {
			lines.push(`${pad}  response: ${cut(step.exchange.response.body.replace(/\s+/g, ' '))}`);
		}
	}
	return lines.join('\n');
}

function xml(text: string): string {
	// Control characters are not allowed in XML 1.0, escaped or not.
	return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** JUnit XML: a testsuite per group (and iteration), a testcase per assertion, or per step that has none. */
export function httpFlowJUnit(run: IHttpFlowRun): string {
	interface ICase { name: string; time: number; failure?: string; error?: string; skipped?: string }
	const suites = new Map<string, ICase[]>();
	for (const step of run.steps) {
		if (!isLeaf(step) || step.status === 'queued' || step.status === 'running') {
			continue;
		}
		const suite = [run.flowName, ...(run.iterations > 1 ? [`Iteration ${step.iteration + 1}`] : []), ...ancestorsOf(run, step)].join(' / ');
		let cases = suites.get(suite);
		if (!cases) {
			suites.set(suite, cases = []);
		}
		const time = step.durationMs / 1000;
		if (step.status === 'skipped') {
			cases.push({ name: step.name, time: 0, skipped: step.error ?? 'skipped' });
		} else if (step.status === 'error') {
			cases.push({ name: step.name, time, error: step.error ?? 'error' });
		} else if (!step.asserts.length) {
			cases.push({ name: step.name, time, ...(step.status === 'failed' ? { failure: step.error ?? step.extracted.find(item => !item.found && item.value === undefined)?.error ?? 'failed' } : {}) });
		} else {
			step.asserts.forEach((assert, index) => cases!.push({ name: `${step.name}: ${assert.label}`, time: index === 0 ? time : 0, ...(assert.passed ? {} : { failure: assert.message }) }));
			const missing = step.extracted.filter(item => !item.found && item.value === undefined);
			for (const item of missing) {
				cases.push({ name: `${step.name}: extract ${item.name}`, time: 0, failure: item.error ?? 'not found' });
			}
		}
	}
	const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
	const all = [...suites.values()].flat();
	const counts = (cases: readonly ICase[]) => `tests="${cases.length}" failures="${cases.filter(item => item.failure !== undefined).length}" errors="${cases.filter(item => item.error !== undefined).length}" skipped="${cases.filter(item => item.skipped !== undefined).length}" time="${cases.reduce((sum, item) => sum + item.time, 0).toFixed(3)}"`;
	lines.push(`<testsuites name="${xml(run.flowName)}" ${counts(all)}>`);
	for (const [name, cases] of suites) {
		lines.push(`  <testsuite name="${xml(name)}" ${counts(cases)} timestamp="${new Date(run.startedAt).toISOString()}">`);
		for (const item of cases) {
			const open = `    <testcase name="${xml(item.name)}" classname="${xml(name)}" time="${item.time.toFixed(3)}"`;
			if (item.failure !== undefined) {
				lines.push(`${open}>`, `      <failure message="${xml(item.failure)}">${xml(item.failure)}</failure>`, '    </testcase>');
			} else if (item.error !== undefined) {
				lines.push(`${open}>`, `      <error message="${xml(item.error)}">${xml(item.error)}</error>`, '    </testcase>');
			} else if (item.skipped !== undefined) {
				lines.push(`${open}>`, `      <skipped message="${xml(item.skipped)}"/>`, '    </testcase>');
			} else {
				lines.push(`${open}/>`);
			}
		}
		lines.push('  </testsuite>');
	}
	lines.push('</testsuites>', '');
	return lines.join('\n');
}

const SECRET_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;
const MAX_REPORT_BODY = 8000;

function reportHeaders(headers: Iterable<readonly [string, string]>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of headers) {
		out[key] = SECRET_HEADER.test(key) ? '(hidden)' : value;
	}
	return out;
}

function reportBody(body: string | undefined): string | undefined {
	return body === undefined ? undefined : body.length > MAX_REPORT_BODY ? `${body.slice(0, MAX_REPORT_BODY)}\n... (${body.length - MAX_REPORT_BODY} more characters)` : body;
}

/** The run as a JSON document: totals, then each step with its assertions, extracted values and exchange (secrets hidden, long bodies cut). */
export function httpFlowReportJson(run: IHttpFlowRun): string {
	return `${JSON.stringify({
		flow: run.flowName,
		state: run.state,
		startedAt: new Date(run.startedAt).toISOString(),
		durationMs: run.durationMs,
		...(run.environment ? { environment: run.environment } : {}),
		iterations: run.iterations,
		...(run.error ? { error: run.error } : {}),
		totals: run.totals,
		steps: run.steps.map(step => ({
			key: step.key,
			id: step.stepId,
			...(step.parentKey ? { parent: step.parentKey } : {}),
			kind: step.kind,
			name: step.name,
			iteration: step.iteration + 1,
			status: step.status,
			attempts: step.attempts,
			durationMs: step.durationMs,
			...(step.error ? { error: step.error } : {}),
			...(step.asserts.length ? { asserts: step.asserts } : {}),
			...(step.extracted.length ? { extracted: step.extracted } : {}),
			...(step.exchange ? {
				request: { method: step.exchange.method, url: step.exchange.url, headers: reportHeaders(step.exchange.headers), ...(step.exchange.body !== undefined ? { body: reportBody(step.exchange.body) } : {}) },
				...(step.exchange.response ? { response: { status: step.exchange.response.status, statusText: step.exchange.response.statusText, durationMs: step.exchange.response.durationMs, size: step.exchange.response.size, headers: reportHeaders(Object.entries(step.exchange.response.headers)), body: reportBody(step.exchange.response.body) } } : {}),
				...(step.exchange.error ? { sendError: step.exchange.error } : {}),
			} : {}),
		})),
	}, null, 2)}\n`;
}

const STATUS_MARK: Readonly<Record<HttpFlowStepStatus, string>> = { passed: 'PASS', failed: 'FAIL', error: 'ERROR', skipped: 'SKIP', queued: '-', running: '-' };

/** A Markdown summary: the totals, a table of the steps, then the failures in full. */
export function httpFlowMarkdown(run: IHttpFlowRun): string {
	const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
	const lines = [`# ${run.flowName}`, '', `**${stateWord(run.state)}** on ${new Date(run.startedAt).toISOString()}`, '', `- Steps: ${run.totals.passed} passed, ${run.totals.failed} failed, ${run.totals.errors} errors, ${run.totals.skipped} skipped (of ${run.totals.steps})`, `- Assertions: ${run.totals.asserts - run.totals.assertsFailed} of ${run.totals.asserts} passed`, `- Requests: ${run.totals.requests}`, `- Duration: ${duration(run.durationMs)}`];
	if (run.iterations > 1) {
		lines.push(`- Iterations: ${run.iterations}`);
	}
	if (run.environment) {
		lines.push(`- Environment: ${run.environment}`);
	}
	if (run.error) {
		lines.push('', `> ${run.error}`);
	}
	lines.push('', '| Result | Step | Status | Time | Attempts |', '| --- | --- | --- | --- | --- |');
	for (const step of run.steps) {
		const indent = '&nbsp;&nbsp;'.repeat(step.depth);
		lines.push(`| ${STATUS_MARK[step.status]} | ${indent}${cell(run.iterations > 1 && step.depth === 0 ? `${step.name} (#${step.iteration + 1})` : step.name)} | ${step.statusCode ?? ''} | ${step.statusCode !== undefined ? duration(step.durationMs) : ''} | ${step.attempts > 1 ? step.attempts : ''} |`);
	}
	const bad = run.steps.filter(step => (step.status === 'failed' || step.status === 'error') && isLeaf(step));
	if (bad.length) {
		lines.push('', '## Failures', '');
		for (const step of bad) {
			lines.push(`### ${[...ancestorsOf(run, step), step.name].join(' / ')}${run.iterations > 1 ? ` (iteration ${step.iteration + 1})` : ''}`, '');
			if (step.method) {
				lines.push(`\`${step.method} ${step.url ?? ''}\`${step.statusCode !== undefined ? ` returned ${step.statusCode}` : ''}`, '');
			}
			if (step.error) {
				lines.push(`- ${step.error}`);
			}
			for (const assert of step.asserts.filter(item => !item.passed)) {
				lines.push(`- ${assert.message}`);
			}
			for (const item of step.extracted.filter(value => !value.found && value.value === undefined)) {
				lines.push(`- could not extract ${item.name}: ${item.error ?? 'not found'}`);
			}
			lines.push('');
		}
	}
	return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function html(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** One HTML file with everything in it (no scripts, no outside styles): the totals and each step, its details folded. */
export function httpFlowHtml(run: IHttpFlowRun): string {
	const totals = run.totals;
	const rows: string[] = [];
	for (const step of run.steps) {
		const exchange = step.exchange;
		const details: string[] = [];
		if (step.error) {
			details.push(`<p class="${step.status === 'skipped' ? 'muted' : 'bad'}">${html(step.error)}</p>`);
		}
		if (step.asserts.length) {
			details.push(`<ul>${step.asserts.map(assert => `<li class="${assert.passed ? 'ok' : 'bad'}">${html(assert.passed ? assert.label : assert.message)}</li>`).join('')}</ul>`);
		}
		if (step.extracted.length) {
			details.push(`<table>${step.extracted.map(item => `<tr><th>${html(item.name)}</th><td class="${item.found ? '' : 'bad'}">${html(item.found ? item.value ?? '' : `${item.error ?? 'not found'}${item.value !== undefined ? ` (default ${item.value})` : ''}`)}</td></tr>`).join('')}</table>`);
		}
		if (exchange) {
			details.push(`<h4>Request</h4><pre>${html(`${exchange.method} ${exchange.url}\n${Object.entries(reportHeaders(exchange.headers)).map(([key, value]) => `${key}: ${value}`).join('\n')}${exchange.body ? `\n\n${reportBody(exchange.body)}` : ''}`)}</pre>`);
			if (exchange.response) {
				details.push(`<h4>Response</h4><pre>${html(`${exchange.response.status} ${exchange.response.statusText}\n${Object.entries(reportHeaders(Object.entries(exchange.response.headers))).map(([key, value]) => `${key}: ${value}`).join('\n')}\n\n${reportBody(exchange.response.body) ?? ''}`)}</pre>`);
			} else if (exchange.error) {
				details.push(`<p class="bad">${html(exchange.error)}</p>`);
			}
		}
		const head = `<span class="badge ${step.status}">${STATUS_MARK[step.status]}</span><span class="name" style="padding-left:${step.depth * 18}px">${html(step.name)}${run.iterations > 1 && step.depth === 0 ? ` <span class="muted">#${step.iteration + 1}</span>` : ''}</span><span class="muted">${step.method ? html(step.method) : ''}</span><span class="code">${step.statusCode ?? ''}</span><span class="muted">${step.statusCode !== undefined ? duration(step.durationMs) : ''}</span><span class="muted">${step.attempts > 1 ? `${step.attempts} attempts` : ''}</span>`;
		rows.push(details.length ? `<details${step.status === 'failed' || step.status === 'error' ? ' open' : ''}><summary>${head}</summary><div class="detail">${details.join('')}</div></details>` : `<div class="row">${head}</div>`);
	}
	return [
		'<!DOCTYPE html>',
		'<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${html(run.flowName)}: ${stateWord(run.state)}</title>`,
		'<style>',
		':root{color-scheme:light dark;--line:rgba(128,128,128,.28);--muted:rgba(128,128,128,.95);--ok:#2da44e;--bad:#d1242f;--warn:#b98900}',
		'body{margin:0;padding:28px 32px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}',
		'h1{margin:0 0 4px;font-size:20px}h4{margin:12px 0 4px;font-size:12px}.muted{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--bad)}',
		'.totals{display:flex;flex-wrap:wrap;gap:8px 24px;margin:16px 0 20px;padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.totals b{display:block;font-size:18px}',
		'.row,summary{display:grid;grid-template-columns:54px minmax(0,1fr) 60px 44px 80px 90px;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)}summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}',
		'.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.badge{font-size:10px;font-weight:700;text-align:center;padding:2px 0;border-radius:3px;background:rgba(128,128,128,.16)}.badge.passed{color:var(--ok)}.badge.failed,.badge.error{color:var(--bad)}.badge.skipped{color:var(--muted)}',
		'.code,pre,td{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}.detail{padding:8px 0 12px 62px;border-bottom:1px solid var(--line)}pre{margin:0;padding:10px;overflow:auto;max-height:320px;border:1px solid var(--line);border-radius:3px;white-space:pre-wrap;word-break:break-word}',
		'ul{margin:4px 0;padding-left:18px}table{border-collapse:collapse;margin:4px 0}th{text-align:left;font-weight:600;padding:2px 14px 2px 0}td{padding:2px 0;word-break:break-all}',
		'</style></head><body>',
		`<h1>${html(run.flowName)}</h1>`,
		`<div class="muted">${html(new Date(run.startedAt).toISOString())}${run.environment ? ` &middot; environment ${html(run.environment)}` : ''}${run.iterations > 1 ? ` &middot; ${run.iterations} iterations` : ''}</div>`,
		run.error ? `<p class="bad">${html(run.error)}</p>` : '',
		`<div class="totals"><div><b class="${run.state === 'passed' ? 'ok' : 'bad'}">${stateWord(run.state)}</b>result</div><div><b>${totals.passed}</b>passed</div><div><b>${totals.failed + totals.errors}</b>failed</div><div><b>${totals.skipped}</b>skipped</div><div><b>${totals.asserts - totals.assertsFailed}/${totals.asserts}</b>assertions</div><div><b>${totals.requests}</b>requests</div><div><b>${duration(run.durationMs)}</b>duration</div></div>`,
		...rows,
		'</body></html>',
		'',
	].filter((line, index, all) => line !== '' || index === all.length - 1).join('\n');
}

// --- Writing a flow with a model ----------------------------------------------------------------

/** One saved request as a model is told about it: where it is and its shape, never its values. */
export interface IHttpFlowCatalogRequest {
	readonly path: readonly string[];
	readonly method: string;
	/** The URL with its query values taken out. */
	readonly url: string;
	/** The top-level field names of a JSON or form body. */
	readonly bodyFields: readonly string[];
}

export interface IHttpFlowCatalogCollection {
	/** How a flow's `ref.collection` names it: its file relative to the project. */
	readonly collection: string;
	readonly name: string;
	readonly requests: readonly IHttpFlowCatalogRequest[];
}

const MAX_CATALOG_REQUESTS = 400;

/** What a model may know of a saved request: no header values, no auth, no body values, no query values. */
export function httpFlowCatalogRequest(path: readonly string[], request: IHttpRequest): IHttpFlowCatalogRequest {
	const url = request.url.replace(/([?&][^=&#]+)=[^&#]*/g, '$1=');
	let fields: string[] = [];
	if (request.body.mode === 'urlencoded') {
		fields = request.body.urlencoded.filter(row => row.enabled && row.key).map(row => row.key);
	} else if (request.body.mode === 'formdata') {
		fields = request.body.formdata.filter(row => row.enabled && row.key).map(row => row.key);
	} else if (request.body.mode === 'raw') {
		const json = record(safeJson(request.body.raw.replace(/\{\{[^{}]*\}\}/g, '0')));
		fields = json ? Object.keys(json) : [];
	}
	return { path: [...path], method: request.method, url, bodyFields: fields.slice(0, 30) };
}

/** The prompt that asks a model for a flow over the project's saved requests. */
/** `add`: the model writes only steps to go after `existing`'s. `rewrite`: it writes the whole flow again, `existing` as the starting point. */
export function httpFlowGenerationPrompt(catalog: readonly IHttpFlowCatalogCollection[], wish: string, existing?: IHttpFlow, mode: 'add' | 'rewrite' = 'add'): string {
	const lines: string[] = [];
	let count = 0;
	for (const collection of catalog) {
		if (count >= MAX_CATALOG_REQUESTS) {
			break;
		}
		lines.push(`Collection "${collection.name}" (ref.collection: ${JSON.stringify(collection.collection)})`);
		for (const request of collection.requests) {
			if (count++ >= MAX_CATALOG_REQUESTS) {
				break;
			}
			lines.push(`  - path ${JSON.stringify(request.path)}: ${request.method} ${request.url}${request.bodyFields.length ? ` (body fields: ${request.bodyFields.join(', ')})` : ''}`);
		}
	}
	return [
		'Write an end-to-end API test flow for Volt Client, as QA engineers do: set up what the test needs, call the endpoints in the order a real client would, carry ids and tokens from one response to the next with "extract", check every response with "assert" (status, the shape of the body, the values that follow from the request, the response time), cover the important negative cases (a missing field, a wrong id, no auth) when asked or when cheap, and clean up what was created in a teardown group.',
		'',
		'Rules:',
		'- Answer with one JSON object only, the flow file: no prose, no Markdown fences.',
		'- Prefer "ref" steps that point at the saved requests below (use their ref.collection and path exactly). Use "inline" requests only for calls no saved request makes, with {{baseUrl}}-style variables for hosts.',
		'- Use {{variables}} for every value that one step takes from an earlier one. Never write secrets, tokens or passwords: refer to environment variables such as {{password}}.',
		'- Give each step a short name that says what it checks.',
		'',
		HTTP_FLOW_FORMAT_GUIDE,
		'',
		catalog.length ? 'The project\'s saved requests:' : 'The project has no saved requests: use inline requests.',
		...lines,
		...(existing && existing.steps.length ? ['', mode === 'rewrite'
			? 'The flow has these steps now. Write the whole flow again, every step it should have: keep what is still right and change what the request below asks for. Your steps replace these.'
			: 'The flow has these steps already; write only the steps to add after them:', describeHttpFlow(existing)] : []),
		'',
		`What to test: ${wish.trim() || 'the main happy path through these endpoints, with assertions on every response.'}`,
	].join('\n');
}

/** Who a model writing a flow is. */
export const HTTP_FLOW_SYSTEM_PROMPT = 'You are a senior QA engineer who writes API test flows. You reply with one JSON object, the flow file, and nothing else: no prose, no Markdown fences, no tool use, no questions.';

/** The flow in a model's answer (fences and talk around it ignored; a bare list is taken as the steps). */
export function parseHttpFlowAnswer(answer: string, fallbackName = 'Automation'): IHttpFlowParse {
	let text = answer.trim().replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
	const firstObject = text.indexOf('{');
	const firstList = text.indexOf('[');
	const list = firstList >= 0 && (firstObject < 0 || firstList < firstObject);
	const start = list ? firstList : firstObject;
	const end = text.lastIndexOf(list ? ']' : '}');
	if (start < 0 || end <= start) {
		return { error: answer.trim() ? 'The model did not answer with a flow (no JSON in the answer).' : 'The model gave no answer.', problems: [] };
	}
	text = text.slice(start, end + 1);
	const json = safeJson(text);
	if (json === undefined) {
		return { error: 'The model\'s answer is not valid JSON.', problems: [] };
	}
	const parsed = parseHttpFlow(Array.isArray(json) ? { volt: 'flow', name: fallbackName, steps: json } : json, fallbackName);
	if (parsed.flow && !parsed.flow.steps.length) {
		return { error: 'The model\'s flow has no steps.', problems: parsed.problems };
	}
	return parsed;
}

/** A flow in a few lines: what a chat needs to talk about it. */
export function describeHttpFlow(flow: IHttpFlow): string {
	const lines = [`${flow.name}${flow.description ? `: ${flow.description}` : ''}`];
	const visit = (steps: readonly IHttpFlowStep[], depth: number) => {
		for (const step of steps) {
			const facts: string[] = [];
			if (step.kind === 'request') {
				facts.push(step.ref ? `${step.ref.collection} > ${step.ref.path.join(' / ')}` : `${step.inline?.method ?? 'GET'} ${step.inline?.url ?? ''}`);
				if (step.assert.length) {
					facts.push(step.assert.map(httpFlowAssertLabel).join('; '));
				}
				if (step.extract.length) {
					facts.push(`extracts ${step.extract.map(item => item.name).join(', ')}`);
				}
			}
			lines.push(`${'  '.repeat(depth)}- ${step.disabled ? '(disabled) ' : ''}${httpFlowStepLabel(step)}${facts.length ? ` [${facts.join(' | ')}]` : ''}`);
			if (isHttpFlowContainer(step)) {
				visit(step.steps, depth + 1);
			}
		}
	};
	visit(flow.steps, 0);
	return lines.join('\n');
}
