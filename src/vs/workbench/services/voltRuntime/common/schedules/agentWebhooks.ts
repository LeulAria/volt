/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Webhook triggers for scheduled agent tasks: each task can have a secret URL on the relay
 * (held there while Volt is closed) and a direct local URL. A delivery is checked (signature,
 * at the relay or locally), filtered (event type, JSON path equals/contains/matches), rendered
 * into the task's prompt (`{{payload.pull_request.title}}`), and run through the orchestrator
 * like a scheduled run. Everything here is pure; transport and storage live in the services.
 *
 * Compared with T3 Code's webhooks: payload filters (T3 has none, so noise costs a full run),
 * redelivery, a visible held queue, and the relay keeps only a hash of the URL token.
 */

export type AgentScheduleTriggerKind = 'schedule' | 'webhook' | 'both';

export type WebhookSignatureKind = 'none' | 'github' | 'generic';

export interface IAgentWebhookSignature {
	readonly kind: WebhookSignatureKind;
	/** HMAC-SHA256 key. Write-only in the UI once saved. */
	readonly secret?: string;
	/** Generic only: header carrying the digest (default `x-volt-signature`). */
	readonly header?: string;
	readonly prefix?: string;
	readonly encoding?: 'hex' | 'base64';
	/** Generic only: signs `<timestamp>.<body>` and refuses old timestamps (replay guard). */
	readonly timestampHeader?: string;
	readonly toleranceSec?: number;
}

export type WebhookFilterOp = 'equals' | 'not_equals' | 'contains' | 'matches' | 'exists' | 'missing' | 'in';

export const WEBHOOK_FILTER_OPS: readonly WebhookFilterOp[] = ['equals', 'not_equals', 'contains', 'matches', 'in', 'exists', 'missing'];

export interface IAgentWebhookFilter {
	/** `event`, `payload.action`, `payload.pull_request.base.ref`, `headers.x-github-event`, `query.env`… */
	readonly path: string;
	readonly op: WebhookFilterOp;
	readonly value?: string;
}

export interface IAgentWebhookTrigger {
	/** Also the hook's id on the relay. */
	readonly id: string;
	/** Secret path segment of the direct local URL. */
	readonly localToken: string;
	/** The relay URL (a secret; the relay keeps only its hash). */
	readonly relayUrl?: string;
	/** The relay that issued `relayUrl`; another relay means the hook must be made again. */
	readonly relayId?: string;
	readonly signature: IAgentWebhookSignature;
	/** All must match, else the delivery is recorded as filtered and no run starts. */
	readonly filters: readonly IAgentWebhookFilter[];
}

export type WebhookDeliveryStatus = 'held' | 'delivered' | 'ran' | 'filtered' | 'failed' | 'expired';

export interface IWebhookDeliveryPayload {
	readonly body: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly query: Readonly<Record<string, string>>;
}

/** One delivery as Volt shows it: from the relay's list, or handled here. */
export interface IAgentWebhookDelivery {
	readonly id: string;
	readonly taskId: string;
	readonly source: 'relay' | 'local';
	readonly receivedAt: number;
	readonly status: WebhookDeliveryStatus;
	readonly event?: string;
	/** "opened · #12 Fix login". */
	readonly summary?: string;
	readonly threadId?: string;
	readonly error?: string;
	/** Why it was filtered, or placeholders that rendered empty. */
	readonly note?: string;
	readonly redeliveryOf?: string;
	readonly handledAt?: number;
	readonly signature?: 'verified' | 'none' | 'failed';
	/** Local deliveries keep their payload (capped) so they can be sent again. */
	readonly payload?: IWebhookDeliveryPayload;
}

/** Deliveries remembered per task, newest last. */
export const WEBHOOK_DELIVERIES_KEPT = 30;
/** A local delivery keeps at most this much body for Redeliver. */
export const LOCAL_PAYLOAD_KEPT = 64 * 1024;
/** Payload pasted into a prompt that has no placeholders. */
const PAYLOAD_IN_PROMPT = 12_000;

export function newWebhookTrigger(id: string, localToken: string): IAgentWebhookTrigger {
	return { id, localToken, signature: { kind: 'none' }, filters: [] };
}

//#region Context

export interface IWebhookContext {
	readonly payload: unknown;
	readonly body: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly query: Readonly<Record<string, string>>;
	readonly event?: string;
	readonly delivery: { readonly id: string; readonly receivedAt: number; readonly source: 'relay' | 'local'; readonly redeliveryOf?: string };
}

export function webhookContext(input: {
	readonly body: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly query?: Readonly<Record<string, string>>;
	readonly event?: string;
	readonly id: string;
	readonly receivedAt: number;
	readonly source: 'relay' | 'local';
	readonly redeliveryOf?: string;
}): IWebhookContext {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(input.headers ?? {})) {
		headers[name.toLowerCase()] = String(value);
	}
	const payload = parseBody(input.body, headers['content-type']);
	const fromPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
		? [(payload as Record<string, unknown>).event, (payload as Record<string, unknown>).type, (payload as Record<string, unknown>).event_type].find(value => typeof value === 'string') as string | undefined
		: undefined;
	const event = input.event ?? headers['x-github-event'] ?? headers['x-gitlab-event'] ?? headers['x-event-type'] ?? headers['x-volt-event'] ?? fromPayload;
	return {
		payload,
		body: input.body,
		headers,
		query: { ...input.query },
		...(event ? { event } : {}),
		delivery: { id: input.id, receivedAt: input.receivedAt, source: input.source, ...(input.redeliveryOf ? { redeliveryOf: input.redeliveryOf } : {}) },
	};
}

function parseBody(body: string, contentType: string | undefined): unknown {
	const text = body.trim();
	if (/json/i.test(contentType ?? '') || text.startsWith('{') || text.startsWith('[')) {
		try {
			return JSON.parse(text);
		} catch {
			// Not JSON after all.
		}
	}
	if (/x-www-form-urlencoded/i.test(contentType ?? '')) {
		const form = Object.fromEntries(new URLSearchParams(text));
		// GitHub can send JSON inside a `payload` form field.
		if (typeof form.payload === 'string') {
			try {
				return JSON.parse(form.payload);
			} catch {
				// Keep the form.
			}
		}
		return form;
	}
	return text;
}

/** `payload.a.b[0]["x.y"]` → ['payload', 'a', 'b', '0', 'x.y']. `$.a` is `payload.a`. */
export function splitWebhookPath(path: string): string[] {
	const parts: string[] = [];
	const source = path.trim().replace(/^\$(?=\.|\[|$)/, 'payload');
	const pattern = /([^.[\]]+)|\[(?:"([^"]*)"|'([^']*)'|(\d+))\]/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(source))) {
		parts.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
	}
	return parts;
}

/** The value at a path, or undefined. Roots: payload, body, headers, query, event, delivery. */
export function resolveWebhookPath(context: IWebhookContext, path: string): unknown {
	const [root, ...rest] = splitWebhookPath(path);
	let value: unknown;
	switch (root) {
		case 'payload': value = context.payload; break;
		case 'body': return rest.length ? walk(context.payload, rest) : context.body;
		case 'headers': return rest.length ? context.headers[rest.join('.').toLowerCase()] : context.headers;
		case 'query': value = context.query; break;
		case 'event': return context.event;
		case 'delivery': value = context.delivery; break;
		default:
			// A bare path reads the payload: `action` is `payload.action`.
			return root === undefined ? undefined : walk(context.payload, [root, ...rest]);
	}
	return walk(value, rest);
}

function walk(value: unknown, parts: readonly string[]): unknown {
	let current = value;
	for (const part of parts) {
		if (current === null || current === undefined) {
			return undefined;
		}
		if (Array.isArray(current) && /^\d+$/.test(part)) {
			current = current[Number(part)];
		} else if (typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, part)) {
			current = (current as Record<string, unknown>)[part];
		} else {
			return undefined;
		}
	}
	return current;
}

//#endregion

//#region Filters

export interface IWebhookFilterResult {
	readonly pass: boolean;
	/** "event is push, not pull_request". */
	readonly reason?: string;
}

/** Every filter must hold. Comparisons are on text; arrays match when any item does. */
export function evaluateWebhookFilters(filters: readonly IAgentWebhookFilter[], context: IWebhookContext): IWebhookFilterResult {
	for (const filter of filters) {
		if (!filter.path.trim()) {
			continue;
		}
		const actual = resolveWebhookPath(context, filter.path);
		if (!filterHolds(filter, actual)) {
			return { pass: false, reason: describeMiss(filter, actual) };
		}
	}
	return { pass: true };
}

function filterHolds(filter: IAgentWebhookFilter, actual: unknown): boolean {
	const expected = filter.value ?? '';
	const values = Array.isArray(actual) ? actual.map(text) : actual === undefined || actual === null ? [] : [text(actual)];
	switch (filter.op) {
		case 'exists': return values.length > 0 && values.some(value => value !== '');
		case 'missing': return values.length === 0 || values.every(value => value === '');
		case 'equals': return values.some(value => value === expected);
		case 'not_equals': return !values.some(value => value === expected);
		case 'contains': return values.some(value => value.includes(expected)) || (typeof actual === 'string' && actual.includes(expected));
		case 'in': {
			const options = expected.split(',').map(option => option.trim()).filter(Boolean);
			return values.some(value => options.includes(value));
		}
		case 'matches': {
			try {
				const pattern = new RegExp(expected);
				return values.some(value => pattern.test(value));
			} catch {
				return false;
			}
		}
	}
}

function describeMiss(filter: IAgentWebhookFilter, actual: unknown): string {
	const shown = actual === undefined || actual === null ? 'missing' : `"${truncate(text(actual), 60)}"`;
	switch (filter.op) {
		case 'exists': return `${filter.path} is missing`;
		case 'missing': return `${filter.path} is ${shown}`;
		case 'not_equals': return `${filter.path} is "${filter.value ?? ''}"`;
		case 'matches': return `${filter.path} (${shown}) does not match /${filter.value ?? ''}/`;
		case 'in': return `${filter.path} is ${shown}, not one of ${filter.value ?? ''}`;
		case 'contains': return `${filter.path} (${shown}) does not contain "${filter.value ?? ''}"`;
		default: return `${filter.path} is ${shown}, not "${filter.value ?? ''}"`;
	}
}

/** Reads a filter typed as one line: `event = pull_request`, `payload.action in opened,reopened`. */
export function parseWebhookFilter(line: string): IAgentWebhookFilter | undefined {
	const match = /^\s*(\S+)\s*(==|=|!=|~=|~|\bcontains\b|\bmatches\b|\bin\b|\bexists\b|\bmissing\b)\s*(.*?)\s*$/i.exec(line);
	if (!match) {
		return undefined;
	}
	const ops: Record<string, WebhookFilterOp> = { '=': 'equals', '==': 'equals', '!=': 'not_equals', '~': 'contains', 'contains': 'contains', '~=': 'matches', 'matches': 'matches', 'in': 'in', 'exists': 'exists', 'missing': 'missing' };
	const op = ops[match[2].toLowerCase()];
	const value = match[3].replace(/^["'](.*)["']$/, '$1');
	return op === 'exists' || op === 'missing' ? { path: match[1], op } : { path: match[1], op, value };
}

export function formatWebhookFilter(filter: IAgentWebhookFilter): string {
	const symbol: Record<WebhookFilterOp, string> = { equals: '=', not_equals: '!=', contains: 'contains', matches: 'matches', in: 'in', exists: 'exists', missing: 'missing' };
	return filter.op === 'exists' || filter.op === 'missing' ? `${filter.path} ${symbol[filter.op]}` : `${filter.path} ${symbol[filter.op]} ${filter.value ?? ''}`;
}

//#endregion

//#region Prompt

const PLACEHOLDER = /\{\{\s*([^{}|]+?)\s*(?:\|\s*(?:"([^"]*)"|'([^']*)'))?\s*\}\}/g;

export function hasWebhookPlaceholders(template: string): boolean {
	PLACEHOLDER.lastIndex = 0;
	return PLACEHOLDER.test(template);
}

/**
 * `{{payload.pull_request.title}}`, `{{event}}`, `{{headers.x-github-event}}`, `{{payload}}`
 * (all of it, as JSON), with an optional fallback: `{{payload.label.name | "none"}}`. A path
 * that is not there renders as its fallback (or nothing) and is reported in `missing`.
 */
export function renderWebhookTemplate(template: string, context: IWebhookContext): { readonly text: string; readonly missing: readonly string[] } {
	const missing: string[] = [];
	const text = template.replace(PLACEHOLDER, (_all, path: string, fallbackA?: string, fallbackB?: string) => {
		const value = resolveWebhookPath(context, path);
		if (value === undefined || value === null || value === '') {
			missing.push(path.trim());
			return fallbackA ?? fallbackB ?? '';
		}
		return typeof value === 'object' ? truncateLines(JSON.stringify(value, null, 2), 4000) : String(value);
	});
	return { text, missing };
}

/** "opened · #12 Fix login" from the common GitHub/GitLab shapes; the event goes beside it. */
export function describeWebhookDelivery(context: IWebhookContext): string | undefined {
	const payload = context.payload && typeof context.payload === 'object' ? context.payload as Record<string, unknown> : undefined;
	if (!payload) {
		return undefined;
	}
	const get = (path: string) => resolveWebhookPath(context, path);
	const parts: string[] = [];
	const action = get('payload.action') ?? get('payload.object_attributes.action');
	if (typeof action === 'string') {
		parts.push(action);
	}
	const number = get('payload.pull_request.number') ?? get('payload.issue.number') ?? get('payload.number') ?? get('payload.object_attributes.iid');
	const title = get('payload.pull_request.title') ?? get('payload.issue.title') ?? get('payload.object_attributes.title') ?? firstLine(get('payload.head_commit.message'));
	if (typeof number === 'number' || typeof title === 'string') {
		parts.push([typeof number === 'number' ? `#${number}` : '', typeof title === 'string' ? truncate(title, 80) : ''].filter(Boolean).join(' '));
	}
	const ref = get('payload.ref');
	if (!parts.length && typeof ref === 'string') {
		parts.push(ref.replace(/^refs\/heads\//, ''));
	}
	const repo = get('payload.repository.full_name');
	if (typeof repo === 'string' && parts.length) {
		parts.push(repo);
	}
	return parts.length ? parts.join(' · ') : undefined;
}

/** The prompt a webhook run sends: marked like a scheduled run, then the rendered template. */
export function webhookRunPrompt(task: { readonly title: string; readonly prompt: string }, context: IWebhookContext): { readonly text: string; readonly display: string; readonly missing: readonly string[] } {
	const rendered = renderWebhookTemplate(task.prompt.trim(), context);
	const what = [context.event, describeWebhookDelivery(context)].filter(Boolean).join(' · ');
	const header = `[Volt] Webhook task "${task.title}" received ${what ? `${what} ` : 'a delivery '}(delivery ${context.delivery.id}${context.delivery.redeliveryOf ? `, sent again` : ''}) at ${new Date(context.delivery.receivedAt).toISOString()}. The user set this up earlier and is not necessarily watching; do the task and finish with a short report.`;
	const payload = hasWebhookPlaceholders(task.prompt) ? '' : `\n\n<webhook_payload${context.event ? ` event="${context.event}"` : ''}>\n${truncateLines(typeof context.payload === 'string' ? context.payload : JSON.stringify(context.payload, null, 2), PAYLOAD_IN_PROMPT)}\n</webhook_payload>`;
	return { text: `${header}\n\n${rendered.text}${payload}`, display: rendered.text, missing: rendered.missing };
}

export interface IWebhookTaskState {
	readonly title: string;
	readonly prompt: string;
	readonly enabled: boolean;
	readonly webhook?: IAgentWebhookTrigger;
	readonly runs: readonly { readonly threadId?: string; readonly webhook?: { readonly deliveryId: string } }[];
}

export type WebhookDeliveryPlan =
	| { readonly kind: 'run'; readonly text: string; readonly display: string; readonly missing: readonly string[] }
	| { readonly kind: 'filtered'; readonly note: string }
	| { readonly kind: 'duplicate'; readonly threadId?: string }
	| { readonly kind: 'off' }
	| { readonly kind: 'unknown' };

/** What a delivery does to its task: run it, or say why it does not. Redelivery is never run twice. */
export function planWebhookDelivery(task: IWebhookTaskState | undefined, context: IWebhookContext): WebhookDeliveryPlan {
	if (!task?.webhook) {
		return { kind: 'unknown' };
	}
	if (!task.enabled) {
		return { kind: 'off' };
	}
	const done = task.runs.find(run => run.webhook?.deliveryId === context.delivery.id);
	if (done) {
		return { kind: 'duplicate', ...(done.threadId ? { threadId: done.threadId } : {}) };
	}
	const verdict = evaluateWebhookFilters(task.webhook.filters, context);
	if (!verdict.pass) {
		return { kind: 'filtered', note: verdict.reason ?? 'A filter did not match.' };
	}
	return { kind: 'run', ...webhookRunPrompt(task, context) };
}

//#endregion

//#region Deliveries

/**
 * The deliveries list: what Volt handled (local records), updated with the relay's view (held,
 * expired, rejected deliveries Volt never saw), newest first.
 */
export function mergeWebhookDeliveries(local: readonly IAgentWebhookDelivery[], relay: readonly IAgentWebhookDelivery[]): IAgentWebhookDelivery[] {
	const byId = new Map<string, IAgentWebhookDelivery>();
	for (const delivery of relay) {
		byId.set(delivery.id, delivery);
	}
	for (const delivery of local) {
		const remote = byId.get(delivery.id);
		// Volt's record knows the chat and the filter reason; the relay may know a later state.
		byId.set(delivery.id, remote && (delivery.status === 'held' || delivery.status === 'delivered') ? { ...delivery, status: remote.status } : { ...remote, ...delivery });
	}
	return [...byId.values()].sort((a, b) => b.receivedAt - a.receivedAt);
}

/** Adds or replaces a record, keeping the newest `WEBHOOK_DELIVERIES_KEPT`. */
export function recordWebhookDelivery(list: readonly IAgentWebhookDelivery[], record: IAgentWebhookDelivery): IAgentWebhookDelivery[] {
	return [...list.filter(entry => entry.id !== record.id), record].sort((a, b) => a.receivedAt - b.receivedAt).slice(-WEBHOOK_DELIVERIES_KEPT);
}

/** Already handled (ran or filtered): a redelivered claim of the same id must not run twice. */
export function isHandledDelivery(record: IAgentWebhookDelivery | undefined): boolean {
	return !!record && (record.status === 'ran' || record.status === 'filtered');
}

//#endregion

//#region Persistence

export function parseWebhookTrigger(value: unknown): IAgentWebhookTrigger | undefined {
	const raw = value as Record<string, unknown> | undefined;
	if (!raw || typeof raw.id !== 'string' || typeof raw.localToken !== 'string') {
		return undefined;
	}
	const signature = raw.signature as Record<string, unknown> | undefined;
	const kind: WebhookSignatureKind = signature?.kind === 'github' || signature?.kind === 'generic' ? signature.kind : 'none';
	return {
		id: raw.id,
		localToken: raw.localToken,
		...(typeof raw.relayUrl === 'string' ? { relayUrl: raw.relayUrl } : {}),
		...(typeof raw.relayId === 'string' ? { relayId: raw.relayId } : {}),
		signature: {
			kind,
			...(typeof signature?.secret === 'string' && signature.secret ? { secret: signature.secret } : {}),
			...(typeof signature?.header === 'string' && signature.header ? { header: signature.header } : {}),
			...(typeof signature?.prefix === 'string' ? { prefix: signature.prefix } : {}),
			...(signature?.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
			...(typeof signature?.timestampHeader === 'string' && signature.timestampHeader ? { timestampHeader: signature.timestampHeader } : {}),
			...(typeof signature?.toleranceSec === 'number' ? { toleranceSec: signature.toleranceSec } : {}),
		},
		filters: Array.isArray(raw.filters) ? raw.filters.flatMap(filter => {
			const entry = filter as Record<string, unknown>;
			return typeof entry?.path === 'string' && WEBHOOK_FILTER_OPS.includes(entry.op as WebhookFilterOp)
				? [{ path: entry.path, op: entry.op as WebhookFilterOp, ...(typeof entry.value === 'string' ? { value: entry.value } : {}) }]
				: [];
		}) : [],
	};
}

export function parseWebhookDelivery(value: unknown): IAgentWebhookDelivery | undefined {
	const raw = value as Record<string, unknown> | undefined;
	const statuses: WebhookDeliveryStatus[] = ['held', 'delivered', 'ran', 'filtered', 'failed', 'expired'];
	if (!raw || typeof raw.id !== 'string' || typeof raw.taskId !== 'string' || typeof raw.receivedAt !== 'number' || !statuses.includes(raw.status as WebhookDeliveryStatus)) {
		return undefined;
	}
	const payload = raw.payload as Record<string, unknown> | undefined;
	return {
		id: raw.id,
		taskId: raw.taskId,
		source: raw.source === 'local' ? 'local' : 'relay',
		receivedAt: raw.receivedAt,
		status: raw.status as WebhookDeliveryStatus,
		...pickStrings(raw, ['event', 'summary', 'threadId', 'error', 'note', 'redeliveryOf']),
		...(typeof raw.handledAt === 'number' ? { handledAt: raw.handledAt } : {}),
		...(raw.signature === 'verified' || raw.signature === 'none' || raw.signature === 'failed' ? { signature: raw.signature } : {}),
		...(payload && typeof payload.body === 'string' ? { payload: { body: payload.body, headers: (payload.headers ?? {}) as Record<string, string>, query: (payload.query ?? {}) as Record<string, string> } } : {}),
	};
}

function pickStrings(raw: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of keys) {
		if (typeof raw[key] === 'string' && raw[key]) {
			out[key] = raw[key] as string;
		}
	}
	return out;
}

//#endregion

function text(value: unknown): string {
	return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * Pretty-printed JSON cut to `max` characters, at a line boundary, so every line kept is whole
 * (a cut mid-string leaves a 400 from the model). Says what was dropped.
 */
export function truncateLines(value: string, max: number): string {
	if (value.length <= max) {
		return value;
	}
	const lines = value.split('\n');
	const kept: string[] = [];
	let length = 0;
	for (const line of lines) {
		if (length + line.length + 1 > max) {
			break;
		}
		kept.push(line);
		length += line.length + 1;
	}
	const dropped = lines.length - kept.length;
	return `${kept.join('\n')}\n… (${dropped} more line${dropped === 1 ? '' : 's'} not shown; the payload was longer than ${max} characters)`;
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function firstLine(value: unknown): string | undefined {
	return typeof value === 'string' ? value.split('\n')[0] : undefined;
}
