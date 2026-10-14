/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { checkModel, globToRegExp } from '../../shared/policy.js';
import { costMicros, DEFAULT_PRICES } from '../../shared/pricing.js';
import { presetFor, splitModel, type WireFormat } from '../../shared/providers.js';
import { db, newId, now, parseJson } from '../db.js';
import { audit } from '../lib/audit.js';
import { activeCredentials, type IUpstream, resolveUpstream, touchCredential } from '../lib/credentials.js';
import { effectivePolicy, type IResolvedPolicy } from '../lib/policy.js';
import { getSettings } from '../lib/settings.js';
import { addSpend, checkBudgets, takeRateSlot } from '../lib/spend.js';
import { type Endpoint, inspectRequest } from './inspect.js';
import { UsageMeter } from './meter.js';
import { authenticate, type IPrincipal } from './principal.js';

/**
 * The model gateway. Volt (and the agent CLIs it launches, through Volt's local relay) point their
 * Anthropic and OpenAI base URLs here:
 *
 *   <govern>/gateway/anthropic          → POST /v1/messages, /v1/messages/count_tokens, GET /v1/models
 *   <govern>/gateway/openai/v1          → POST /chat/completions, /responses, GET /models
 *
 * Each request: device-bound token → member's effective policy → rate limit → model allowed and
 * routed to an organization credential → budgets → body inspection (tools, MCP, DLP, caps) →
 * forwarded with the server-held key → streamed back while metered → usage, cost and audit recorded.
 */
export const gateway = new Hono();

gateway.use('*', bodyLimit({ maxSize: 32 * 1024 * 1024, onError: c => c.json(errorBody('anthropic', 'Request too large', 'request_too_large'), 413) }));

function errorBody(format: WireFormat, message: string, code: string) {
	return format === 'anthropic'
		? { type: 'error', error: { type: code === 'rate_limited' ? 'rate_limit_error' : code === 'invalid_token' || code === 'missing_token' || code === 'dpop_required' || code === 'device_revoked' ? 'authentication_error' : 'permission_error', message: `Volt Govern: ${message}` }, volt_code: code }
		: { error: { message: `Volt Govern: ${message}`, type: code, code } };
}

const PASS_HEADERS = ['content-type', 'request-id', 'x-request-id', 'openai-processing-ms', 'retry-after', 'anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-tokens-remaining'];

interface IRecord {
	readonly principal: IPrincipal;
	readonly resolved: IResolvedPolicy;
	readonly upstream?: IUpstream;
	readonly provider: string;
	readonly model: string;
	readonly endpoint: Endpoint | 'count_tokens';
	readonly status: 'ok' | 'blocked' | 'error';
	readonly reason?: string;
	readonly meter?: UsageMeter;
	readonly started: number;
	readonly dlpFindings: number;
	readonly strippedTools: readonly string[];
	readonly requestBody?: unknown;
}

async function record(r: IRecord): Promise<void> {
	const { organizationId, userId, deviceId, client } = r.principal;
	const settings = await getSettings(organizationId);
	const m = r.meter;
	const qualified = `${r.provider}/${r.model}`;
	const prices = [...settings.prices, ...DEFAULT_PRICES];
	const cost = m ? costMicros(qualified, { input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite }, prices, (value, glob) => globToRegExp(glob).test(value)) : null;
	const id = newId();
	try {
		await db.insertInto('gov_usage').values({
			id,
			organization_id: organizationId,
			user_id: userId,
			device_id: deviceId,
			credential_id: r.upstream?.credentialId ?? null,
			provider: r.provider,
			model: r.model,
			endpoint: r.endpoint,
			status: r.status,
			reason: r.reason?.slice(0, 500) ?? null,
			input_tokens: m?.input ?? 0,
			output_tokens: m?.output ?? 0,
			cache_read_tokens: m?.cacheRead ?? 0,
			cache_write_tokens: m?.cacheWrite ?? 0,
			cost_micros: cost,
			latency_ms: Date.now() - r.started,
			tool_calls: m?.toolCalls ?? 0,
			dlp_findings: r.dlpFindings,
			stripped_tools: r.strippedTools.length,
			client,
			created_at: now(),
		}).execute();
		if (m && r.status === 'ok' && (settings.promptLogging === 'redacted' || settings.promptLogging === 'full') && r.requestBody) {
			await db.insertInto('gov_prompt_log').values({
				usage_id: id,
				organization_id: organizationId,
				request_json: JSON.stringify(r.requestBody).slice(0, 512 * 1024),
				response_text: m.text,
				created_at: now(),
			}).execute();
		}
	} catch (err) {
		console.error('[volt-govern] usage write failed', err);
	}
	if (m) {
		addSpend(organizationId, userId, r.resolved.teamIds, cost, m.input + m.output + m.cacheRead + m.cacheWrite);
	}
	if (r.upstream) {
		touchCredential(r.upstream.credentialId);
	}
	const actorType = deviceId ? 'device' : 'user';
	if (r.status === 'blocked') {
		await audit({ organizationId, actorId: userId, actorType, action: 'gateway.blocked', targetType: 'model', targetId: qualified, detail: { reason: r.reason, device: deviceId, strippedTools: r.strippedTools } });
	} else if (r.strippedTools.length || r.dlpFindings) {
		await audit({ organizationId, actorId: userId, actorType, action: 'gateway.enforced', targetType: 'model', targetId: qualified, detail: { strippedTools: r.strippedTools, redactions: r.dlpFindings, device: deviceId } });
	}
}

function upstreamUrl(upstream: IUpstream, path: string): string {
	return `${upstream.baseUrl}/${path}`;
}

async function upstreamHeaders(c: Context, upstream: IUpstream, format: WireFormat): Promise<Headers> {
	const headers = new Headers({ 'content-type': 'application/json', accept: c.req.header('accept') ?? 'application/json' });
	const credential = await upstream.authorization();
	switch (upstream.authHeader) {
		case 'x-api-key': headers.set('x-api-key', credential); break;
		case 'api-key': headers.set('api-key', credential); break;
		default: headers.set('authorization', `Bearer ${credential}`);
	}
	if (format === 'anthropic') {
		headers.set('anthropic-version', c.req.header('anthropic-version') ?? '2023-06-01');
		const beta = c.req.header('anthropic-beta');
		if (beta) {
			headers.set('anthropic-beta', beta);
		}
	}
	return headers;
}

function passHeaders(res: Response): Headers {
	const out = new Headers();
	for (const name of PASS_HEADERS) {
		const value = res.headers.get(name);
		if (value) {
			out.set(name, value);
		}
	}
	out.set('cache-control', 'no-store');
	out.set('x-volt-govern', '1');
	return out;
}

const PATHS: Record<Endpoint, string> = { messages: 'messages', chat: 'chat/completions', responses: 'responses' };

/**
 * A request already authenticated some other way: the console's playground passes the signed-in
 * member and the body it built, and everything after authentication runs as for Volt.
 */
export interface IPresetRequest {
	readonly principal: IPrincipal;
	readonly body: Record<string, unknown>;
}

async function handle(c: Context, format: WireFormat, endpoint: Endpoint, preset?: IPresetRequest): Promise<Response> {
	const started = Date.now();
	let principal: IPrincipal;
	let body: Record<string, unknown>;
	if (preset) {
		principal = preset.principal;
		body = preset.body;
	} else {
		const auth = await authenticate(c);
		if (!('principal' in auth)) {
			return c.json(errorBody(format, auth.error, auth.code), auth.status);
		}
		principal = auth.principal;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json(errorBody(format, 'The request body is not JSON', 'invalid_request'), 400);
		}
	}
	const requested = splitModel(String(body.model ?? ''));
	if (!requested.model) {
		return c.json(errorBody(format, 'No model in the request', 'invalid_request'), 400);
	}
	const resolved = await effectivePolicy(principal.organizationId, principal.userId);
	const policy = resolved.policy;
	const base = { principal, resolved, endpoint, started, dlpFindings: 0, strippedTools: [] as readonly string[] };

	if (!takeRateSlot(`${principal.organizationId}:${principal.userId}`, policy.limits.requestsPerMinute)) {
		return c.json(errorBody(format, `Rate limit: ${policy.limits.requestsPerMinute} requests per minute`, 'rate_limited'), 429, { 'retry-after': '20' });
	}

	const upstream = await resolveUpstream(principal.organizationId, format, requested);
	if (!upstream) {
		void record({ ...base, provider: requested.provider ?? format, model: requested.model, status: 'blocked', reason: 'No organization credential offers this model' });
		return c.json(errorBody(format, `No organization credential offers ${requested.model}. Ask an admin to add it.`, 'model_unavailable'), 404);
	}
	const qualified = `${upstream.provider}/${requested.model}`;
	const modelVerdict = checkModel(policy, qualified);
	if (!modelVerdict.allowed) {
		void record({ ...base, upstream, provider: upstream.provider, model: requested.model, status: 'blocked', reason: modelVerdict.reason });
		return c.json(errorBody(format, modelVerdict.reason ?? 'Model not allowed', 'model_blocked'), 403);
	}
	const budget = await checkBudgets(principal.organizationId, policy);
	if (budget.blocked) {
		void record({ ...base, upstream, provider: upstream.provider, model: requested.model, status: 'blocked', reason: budget.reason });
		return c.json(errorBody(format, `${budget.reason}. Ask an admin to raise it.`, 'budget_exceeded'), 403);
	}

	const inspection = inspectRequest(endpoint, body, policy, resolved.knownMcpServers);
	const enforced = { ...base, upstream, provider: upstream.provider, model: requested.model, dlpFindings: inspection.dlpFindings, strippedTools: inspection.strippedTools };
	if (inspection.blocked) {
		void record({ ...enforced, status: 'blocked', reason: inspection.blocked });
		return c.json(errorBody(format, inspection.blocked, 'policy_blocked'), 403);
	}
	const outgoing: Record<string, unknown> = { ...inspection.body, model: requested.model };
	const streaming = outgoing.stream === true;
	if (endpoint === 'chat' && streaming) {
		outgoing.stream_options = { ...(outgoing.stream_options as Record<string, unknown> | undefined), include_usage: true };
	}

	const settings = await getSettings(principal.organizationId);
	const meter = new UsageMeter(endpoint, settings.promptLogging === 'redacted' || settings.promptLogging === 'full');
	let res: Response;
	try {
		res = await fetch(upstreamUrl(upstream, PATHS[endpoint]), {
			method: 'POST',
			headers: await upstreamHeaders(c, upstream, format),
			body: JSON.stringify(outgoing),
			signal: c.req.raw.signal,
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		void record({ ...enforced, status: 'error', reason: `Upstream unreachable: ${reason}` });
		return c.json(errorBody(format, 'The provider could not be reached', 'upstream_unreachable'), 502);
	}

	if (!res.ok) {
		const text = await res.text();
		void record({ ...enforced, status: 'error', reason: `Provider answered ${res.status}: ${text.slice(0, 300)}` });
		return new Response(text, { status: res.status, headers: passHeaders(res) });
	}

	const requestBody = settings.promptLogging === 'redacted' || settings.promptLogging === 'full' ? outgoing : undefined;
	const isStream = (res.headers.get('content-type') ?? '').includes('text/event-stream');
	if (isStream && res.body) {
		const tapped = res.body.pipeThrough(meter.tap(() => void record({ ...enforced, status: 'ok', meter, requestBody })));
		c.req.raw.signal.addEventListener('abort', () => meter.finish(), { once: true });
		return new Response(tapped, { status: res.status, headers: passHeaders(res) });
	}
	const text = await res.text();
	try {
		meter.whole(JSON.parse(text) as Record<string, unknown>);
	} catch {
		// Not JSON: nothing to meter.
	}
	void record({ ...enforced, status: 'ok', meter, requestBody });
	return new Response(text, { status: res.status, headers: passHeaders(res) });
}

/** The gateway path for a request authenticated by the caller (the console's playground). */
export function forwardAs(c: Context, format: WireFormat, endpoint: Endpoint, preset: IPresetRequest): Promise<Response> {
	return handle(c, format, endpoint, preset);
}

gateway.post('/anthropic/v1/messages', c => handle(c, 'anthropic', 'messages'));
gateway.post('/openai/v1/chat/completions', c => handle(c, 'openai', 'chat'));
gateway.post('/openai/v1/responses', c => handle(c, 'openai', 'responses'));

/** Token counting: authenticated and model-checked, forwarded as is, not metered as spend. */
gateway.post('/anthropic/v1/messages/count_tokens', async c => {
	const auth = await authenticate(c);
	if (!('principal' in auth)) {
		return c.json(errorBody('anthropic', auth.error, auth.code), auth.status);
	}
	const body = await c.req.json<Record<string, unknown>>().catch(() => undefined);
	const requested = splitModel(String(body?.model ?? ''));
	const upstream = body && await resolveUpstream(auth.principal.organizationId, 'anthropic', requested);
	if (!body || !upstream) {
		return c.json(errorBody('anthropic', 'Unknown model', 'model_unavailable'), 404);
	}
	const { policy } = await effectivePolicy(auth.principal.organizationId, auth.principal.userId);
	if (!checkModel(policy, `${upstream.provider}/${requested.model}`).allowed) {
		return c.json(errorBody('anthropic', 'Model not allowed', 'model_blocked'), 403);
	}
	const res = await fetch(upstreamUrl(upstream, 'messages/count_tokens'), { method: 'POST', headers: await upstreamHeaders(c, upstream, 'anthropic'), body: JSON.stringify({ ...body, model: requested.model }) });
	return new Response(await res.text(), { status: res.status, headers: passHeaders(res) });
});

/** The models a member may use on one wire format: bare ids when unambiguous. */
async function allowedModels(principal: IPrincipal, format: WireFormat): Promise<{ readonly id: string; readonly provider: string }[]> {
	const { policy } = await effectivePolicy(principal.organizationId, principal.userId);
	const rows = (await activeCredentials(principal.organizationId)).filter(r => (presetFor(r.provider)?.format ?? 'openai') === format);
	const pairs: { provider: string; model: string }[] = [];
	for (const row of rows) {
		const listed = parseJson<string[]>(row.models_json, []);
		for (const model of listed.length ? listed : presetFor(row.provider)?.models ?? []) {
			if (checkModel(policy, `${row.provider}/${model}`).allowed && !pairs.some(p => p.provider === row.provider && p.model === model)) {
				pairs.push({ provider: row.provider, model });
			}
		}
	}
	return pairs.map(p => ({ id: pairs.filter(q => q.model === p.model).length > 1 ? `${p.provider}/${p.model}` : p.model, provider: p.provider }));
}

gateway.get('/anthropic/v1/models', async c => {
	const auth = await authenticate(c);
	if (!('principal' in auth)) {
		return c.json(errorBody('anthropic', auth.error, auth.code), auth.status);
	}
	const models = await allowedModels(auth.principal, 'anthropic');
	return c.json({ data: models.map(m => ({ type: 'model', id: m.id, display_name: m.id, created_at: '1970-01-01T00:00:00Z' })), has_more: false, first_id: models[0]?.id ?? null, last_id: models.at(-1)?.id ?? null });
});

gateway.get('/openai/v1/models', async c => {
	const auth = await authenticate(c);
	if (!('principal' in auth)) {
		return c.json(errorBody('openai', auth.error, auth.code), auth.status);
	}
	const models = await allowedModels(auth.principal, 'openai');
	return c.json({ object: 'list', data: models.map(m => ({ id: m.id, object: 'model', created: 0, owned_by: m.provider })) });
});

export { allowedModels };
