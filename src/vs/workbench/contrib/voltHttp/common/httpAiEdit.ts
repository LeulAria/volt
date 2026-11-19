/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * "Edit with AI": a short conversation with a model about one request. Each turn the model sees the
 * request as JSON (secrets masked), the requests the user mentioned with @, the variables in reach
 * and the conversation so far, and answers with a reply and the fields it changes. Pure: the panel
 * in browser/voltHttpAiEdit.ts calls the model and applies the answer with `applyHttpAiEdit`.
 */

import { convertHttpRequest, emptyHttpAuth, HttpAuthType, HttpBodyMode, HttpRawLanguage, httpUrlWithQuery, IHttpAuth, IHttpKeyValue, IHttpRequest } from './httpCollection.js';
import { syncHttpRequestUrl } from './httpDotHttp.js';
import { HTTP_PROTOCOLS, IHttpMessage, isHttpProtocol } from './httpProtocols.js';

/** Stands for a secret the model is not shown; written back as it was when the answer keeps it. */
export const HTTP_AI_SECRET = '<secret>';

const MAX_TEXT = 4000;
const MAX_HISTORY = 12;
const BODY_MODES: readonly HttpBodyMode[] = ['none', 'raw', 'urlencoded', 'formdata', 'graphql', 'binary'];
const RAW_LANGUAGES: readonly HttpRawLanguage[] = ['json', 'text', 'xml', 'html', 'javascript'];
const AUTH_TYPES: readonly HttpAuthType[] = ['inherit', 'none', 'bearer', 'basic', 'apikey', 'oauth2', 'jwt', 'digest', 'oauth1', 'hawk', 'awsv4', 'ntlm', 'edgegrid', 'asap'];
const SECRET_PARAM = /secret|password|token|key|signature|credential/i;

export const HTTP_AI_EDIT_SYSTEM_PROMPT = [
	'You edit one API request in Volt Client, a Postman-style API client, for the user, over a short conversation.',
	'You never use tools and never ask to run anything. You answer with ONE JSON object and nothing else (no Markdown fences, no prose around it):',
	'{"reply": "<one or two plain sentences for the user: what you changed, or your answer>", "request": { <only the fields you change> }}',
	'Leave "request" out when the user only asks a question.',
].join('\n');

export interface IHttpAiEditMessage {
	readonly role: 'user' | 'assistant';
	readonly text: string;
}

/** A request the user mentioned with `@`, given to the model as an example to follow. */
export interface IHttpAiEditMention {
	readonly label: string;
	readonly request: IHttpRequest;
}

function clip(text: string, max = MAX_TEXT): string {
	return text.length > max ? `${text.slice(0, max)}... (${text.length - max} more characters)` : text;
}

/** A secret field's value as the model sees it: a `{{variable}}` is a name and shows; a literal is masked. */
function maskValue(value: string): string {
	return !value || /^\s*\{\{[^}]+\}\}\s*$/.test(value) ? value : HTTP_AI_SECRET;
}

function rows(list: readonly IHttpKeyValue[], secret?: (key: string) => boolean): Record<string, unknown>[] {
	return list.filter(row => row.key || row.value).map(row => ({
		key: row.key,
		value: secret?.(row.key) ? maskValue(row.value) : row.value,
		...(row.enabled ? {} : { enabled: false }),
		...(row.description ? { description: row.description } : {}),
		...(row.type === 'file' ? { type: 'file' } : {}),
	}));
}

const SECRET_HEADER = (key: string) => /^(authorization|cookie|proxy-authorization|x-api-key|api-key|x-auth-token)$/i.test(key);

function authView(auth: IHttpAuth): Record<string, unknown> {
	switch (auth.type) {
		case 'inherit': case 'none': return { type: auth.type };
		case 'bearer': return { type: 'bearer', token: maskValue(auth.token) };
		case 'basic': return { type: 'basic', username: auth.username, password: maskValue(auth.password) };
		case 'apikey': return { type: 'apikey', keyName: auth.keyName, keyValue: maskValue(auth.keyValue), keyIn: auth.keyIn };
		case 'oauth2': return { type: 'oauth2', token: maskValue(auth.token), ...paramsView(auth.params) };
		default: return { type: auth.type, ...paramsView(auth.params) };
	}
}

function paramsView(params: Readonly<Record<string, string>> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(params ?? {})) {
		out[key] = SECRET_PARAM.test(key) ? maskValue(value) : value;
	}
	return out;
}

/** The request as the model sees it: what the editor shows, secrets masked, long texts cut. */
export function httpAiEditView(request: IHttpRequest): Record<string, unknown> {
	const body = request.body;
	const bodyView: Record<string, unknown> = { mode: body.mode };
	switch (body.mode) {
		case 'raw': bodyView.language = body.language; bodyView.raw = clip(body.raw); break;
		case 'urlencoded': bodyView.urlencoded = rows(body.urlencoded); break;
		case 'formdata': bodyView.formdata = rows(body.formdata); break;
		case 'graphql': bodyView.graphqlQuery = clip(body.graphqlQuery); bodyView.graphqlVariables = clip(body.graphqlVariables); break;
		case 'binary': bodyView.binaryPath = body.binaryPath; break;
	}
	return {
		name: request.name,
		protocol: request.protocol ?? 'http',
		method: request.method,
		url: request.url,
		...(request.pathVariables.some(row => row.key) ? { pathVariables: rows(request.pathVariables) } : {}),
		headers: rows(request.headers, SECRET_HEADER),
		body: bodyView,
		auth: authView(request.auth),
		scripts: { preRequest: clip(request.scripts.preRequest), test: clip(request.scripts.test) },
		...(request.messages?.length ? { messages: request.messages.map(message => ({ ...(message.target ? { target: message.target } : {}), body: clip(message.body, 1000) })) } : {}),
		...(request.options && Object.keys(request.options).length ? { options: request.options } : {}),
		description: clip(request.description, 2000),
	};
}

/** The user's turn as the model reads it: the format, the request now, mentions, variables, the conversation. */
export function httpAiEditPrompt(request: IHttpRequest, history: readonly IHttpAiEditMessage[], message: string, mentions: readonly IHttpAiEditMention[], variables: readonly string[]): string {
	const lines = [
		'The fields of "request" (send only those you change; a list or object you send replaces the whole one):',
		`- name, description (Markdown), protocol (${HTTP_PROTOCOLS.map(item => item.id).join(' | ')}), method, url (with its query string; path variables as :name)`,
		'- headers: [{"key","value","enabled"?: false,"description"?}]',
		'- body: {"mode": "none"|"raw"|"urlencoded"|"formdata"|"graphql", "language"?: "json"|"text"|"xml"|"html"|"javascript", "raw"?: string (a JSON body is a string of pretty JSON), "urlencoded"?|"formdata"?: rows like headers, "graphqlQuery"?, "graphqlVariables"?}',
		'- auth: {"type": "inherit"|"none"|"bearer"|"basic"|"apikey"|"oauth2"|..., "token"?, "username"?, "password"?, "keyName"?, "keyValue"?, "keyIn"?: "header"|"query"}',
		'- scripts: {"preRequest"?, "test"?}: Postman sandbox JavaScript (pm.test, pm.expect, pm.response, pm.environment.set)',
		'- messages: [{"body", "target"?}] for WebSocket, Socket.IO and MQTT; options: {...} for gRPC, MQTT and Socket.IO',
		'Rules:',
		`- A value shown as ${HTTP_AI_SECRET} is a secret you cannot see: to keep it, write ${HTTP_AI_SECRET} back. Never invent secrets; use a {{variable}} instead.`,
		'- Prefer {{variables}} that exist for hosts, tokens and ids. Keep what the user did not ask to change.',
		'- If the user pastes a cURL command, an OpenAPI snippet or a description of an endpoint, build the request from it.',
		'',
		'The request now:',
		JSON.stringify(httpAiEditView(request), undefined, 2),
	];
	if (variables.length) {
		lines.push('', `Variables in reach: ${variables.slice(0, 80).map(name => `{{${name}}}`).join(', ')}`);
	}
	for (const mention of mentions) {
		lines.push('', `The user mentioned @${mention.label}:`, JSON.stringify(httpAiEditView(mention.request), undefined, 2));
	}
	const earlier = history.slice(-MAX_HISTORY);
	if (earlier.length) {
		lines.push('', 'The conversation so far:', ...earlier.map(turn => `${turn.role === 'user' ? 'User' : 'You'}: ${clip(turn.text, 1500)}`));
	}
	lines.push('', `User: ${message.trim()}`);
	return lines.join('\n');
}

export interface IHttpAiEditAnswer {
	readonly reply: string;
	/** The fields the model changes; absent when it only answered. */
	readonly request?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The model's answer read back: the JSON object (fences and text around it dropped), or its text as a plain reply. */
export function parseHttpAiEditAnswer(answer: string): IHttpAiEditAnswer {
	const text = answer.replace(/<\/?insert>/g, '').trim();
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start >= 0 && end > start) {
		try {
			const parsed = record(JSON.parse(text.slice(start, end + 1)));
			if (parsed && ('reply' in parsed || 'request' in parsed)) {
				const request = record(parsed.request);
				const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
				return { reply, ...(request && Object.keys(request).length ? { request } : {}) };
			}
		} catch {
			// Not JSON: the text itself is the reply.
		}
	}
	return { reply: text.replace(/^```\w*\s*|\s*```$/g, '').trim() };
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

/**
 * Rows from the answer: a list of `{key, value}` or an object of `key: value`. A `<secret>` value
 * keeps what the row with the same key had (the model never saw it).
 */
function rowsFrom(value: unknown, before: readonly IHttpKeyValue[]): IHttpKeyValue[] | undefined {
	const kept = (key: string, next: string) => next === HTTP_AI_SECRET ? before.find(row => row.key.toLowerCase() === key.toLowerCase())?.value ?? '' : next;
	if (Array.isArray(value)) {
		return value.map(record).filter((row): row is Record<string, unknown> => !!row && str(row.key) !== undefined).map(row => {
			const key = str(row.key)!;
			return {
				key,
				value: kept(key, str(row.value) ?? ''),
				enabled: row.enabled !== false,
				...(str(row.description) ? { description: str(row.description) } : {}),
				...(row.type === 'file' ? { type: 'file' as const } : {}),
			};
		});
	}
	const map = record(value);
	return map ? Object.entries(map).map(([key, next]) => ({ key, value: kept(key, str(next) ?? ''), enabled: true })) : undefined;
}

function secretOr(next: unknown, before: string): string | undefined {
	const value = str(next);
	return value === undefined ? undefined : value === HTTP_AI_SECRET ? before : value;
}

function applyAuth(request: IHttpRequest, value: Record<string, unknown>): void {
	const type = str(value.type) as HttpAuthType | undefined;
	const before = request.auth;
	const auth: IHttpAuth = type && AUTH_TYPES.includes(type) && type !== before.type ? { ...emptyHttpAuth(type) } : { ...before, ...(before.params ? { params: { ...before.params } } : {}) };
	const params: Record<string, string> = { ...(auth.params ?? {}) };
	for (const [key, next] of Object.entries(value)) {
		if (key === 'type') {
			continue;
		}
		switch (key) {
			case 'token': auth.token = secretOr(next, before.token) ?? auth.token; break;
			case 'username': auth.username = str(next) ?? auth.username; break;
			case 'password': auth.password = secretOr(next, before.password) ?? auth.password; break;
			case 'keyName': case 'key': auth.keyName = str(next) ?? auth.keyName; break;
			case 'keyValue': case 'value': auth.keyValue = secretOr(next, before.keyValue) ?? auth.keyValue; break;
			case 'keyIn': case 'in': auth.keyIn = next === 'query' ? 'query' : 'header'; break;
			default: {
				const text = secretOr(next, before.params?.[key] ?? '');
				if (text !== undefined) {
					params[key] = text;
				}
			}
		}
	}
	if (Object.keys(params).length) {
		auth.params = params;
	}
	request.auth = auth;
}

function applyBody(request: IHttpRequest, value: Record<string, unknown>): void {
	const body = request.body;
	const mode = str(value.mode) as HttpBodyMode | undefined;
	if (mode && BODY_MODES.includes(mode)) {
		body.mode = mode;
	}
	const language = str(value.language) as HttpRawLanguage | undefined;
	if (language && RAW_LANGUAGES.includes(language)) {
		body.language = language;
	}
	if ('raw' in value) {
		// A JSON body sent as an object instead of a string is still meant as JSON.
		body.raw = typeof value.raw === 'string' ? value.raw : JSON.stringify(value.raw, undefined, 2);
		if (!mode && body.mode === 'none') {
			body.mode = 'raw';
		}
		if (typeof value.raw !== 'string' && !language) {
			body.language = 'json';
		}
	}
	body.urlencoded = rowsFrom(value.urlencoded, body.urlencoded) ?? body.urlencoded;
	body.formdata = rowsFrom(value.formdata, body.formdata) ?? body.formdata;
	if ('graphqlQuery' in value) {
		body.graphqlQuery = str(value.graphqlQuery) ?? '';
	}
	if ('graphqlVariables' in value) {
		body.graphqlVariables = typeof value.graphqlVariables === 'string' ? value.graphqlVariables : JSON.stringify(value.graphqlVariables, undefined, 2);
	}
	if ('binaryPath' in value) {
		body.binaryPath = str(value.binaryPath) ?? '';
	}
}

/**
 * Applies the fields of an answer to `request` (a copy the caller saves as a draft). Unknown fields
 * are ignored; `<secret>` keeps the value the model did not see. Returns the names of what changed.
 */
export function applyHttpAiEdit(request: IHttpRequest, patch: Readonly<Record<string, unknown>>): string[] {
	const changed: string[] = [];
	const protocol = patch.protocol;
	if (isHttpProtocol(protocol) && protocol !== (request.protocol ?? 'http')) {
		convertHttpRequest(request, protocol);
		changed.push('kind');
	}
	if (typeof patch.name === 'string' && patch.name !== request.name) {
		request.name = patch.name;
		changed.push('name');
	}
	if (typeof patch.method === 'string' && patch.method.trim() && patch.method.toUpperCase() !== request.method) {
		request.method = patch.method.trim().toUpperCase();
		changed.push('method');
	}
	if (typeof patch.url === 'string' && patch.url !== request.url) {
		syncHttpRequestUrl(request, patch.url.trim());
		changed.push('URL');
	} else if (Array.isArray(patch.params)) {
		// Params on their own: the URL's query follows them.
		const params = rowsFrom(patch.params, request.params) ?? request.params;
		syncHttpRequestUrl(request, httpUrlWithQuery(request.url, params));
		request.params = params;
		changed.push('params');
	}
	if (patch.pathVariables !== undefined) {
		const next = rowsFrom(patch.pathVariables, request.pathVariables);
		if (next) {
			request.pathVariables = next;
			changed.push('path variables');
		}
	}
	if (patch.headers !== undefined) {
		const next = rowsFrom(patch.headers, request.headers);
		if (next) {
			request.headers = next;
			changed.push('headers');
		}
	}
	const body = record(patch.body);
	if (body) {
		applyBody(request, body);
		changed.push('body');
	}
	const auth = record(patch.auth);
	if (auth) {
		applyAuth(request, auth);
		changed.push('authorization');
	}
	const scripts = record(patch.scripts);
	if (scripts) {
		if (typeof scripts.preRequest === 'string') {
			request.scripts.preRequest = scripts.preRequest;
		}
		if (typeof scripts.test === 'string') {
			request.scripts.test = scripts.test;
		}
		changed.push('scripts');
	}
	if (Array.isArray(patch.messages)) {
		request.messages = patch.messages.map(record).filter((message): message is Record<string, unknown> => !!message).map((message): IHttpMessage => ({
			body: typeof message.body === 'string' ? message.body : JSON.stringify(message.body, undefined, 2),
			...(str(message.target) ? { target: str(message.target) } : {}),
		}));
		changed.push('messages');
	}
	const options = record(patch.options);
	if (options) {
		const next: Record<string, string> = { ...(request.options ?? {}) };
		for (const [key, value] of Object.entries(options)) {
			const text = str(value);
			if (text !== undefined) {
				next[key] = text;
			}
		}
		request.options = next;
		changed.push('options');
	}
	if (typeof patch.description === 'string' && patch.description !== request.description) {
		request.description = patch.description;
		changed.push('docs');
	}
	return changed;
}

/** `@` mentions in a message that name a request the user can pick: `@Collection/Folder/Request`. */
export function httpAiEditMentions(message: string, labels: readonly string[]): string[] {
	// The longest label first, so "@Users/Get user by id" is not read as "@Users/Get user".
	const sorted = [...labels].sort((a, b) => b.length - a.length);
	const found: string[] = [];
	let rest = message;
	for (const label of sorted) {
		const token = `@${label}`;
		if (rest.includes(token)) {
			found.push(label);
			rest = rest.split(token).join(' ');
		}
	}
	return found;
}
