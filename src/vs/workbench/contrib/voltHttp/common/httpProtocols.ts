/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The kinds of request the Volt Client makes. Every kind is the same request model (URL, headers,
 * auth, a body or messages) read by a different executor: plain HTTP, GraphQL, SOAP, an AI
 * provider's chat endpoint and MCP are one request and one response; WebSocket, Socket.IO, SSE,
 * MQTT and gRPC stay open and exchange messages.
 */

export type HttpProtocol = 'http' | 'graphql' | 'soap' | 'ai' | 'mcp' | 'grpc' | 'ws' | 'socketio' | 'sse' | 'mqtt';

/** A message kept with a request: sent in order once its connection opens. */
export interface IHttpMessage {
	/** The Socket.IO event or the MQTT topic. */
	target?: string;
	body: string;
}

export interface IHttpProtocolInfo {
	readonly id: HttpProtocol;
	readonly label: string;
	/** What stands where a method does, in tabs, trees and the history. */
	readonly badge: string;
	/** Stays open and exchanges messages (its response is a timeline, not one body). */
	readonly stream: boolean;
	/** This side can send messages once it is open. */
	readonly sends: boolean;
	/** What each message is addressed to, when the kind has such a thing. */
	readonly target?: 'event' | 'topic';
	readonly urlPlaceholder: string;
	readonly hint: string;
}

export const HTTP_PROTOCOLS: readonly IHttpProtocolInfo[] = [
	{ id: 'http', label: 'HTTP', badge: 'HTTP', stream: false, sends: false, urlPlaceholder: 'Enter a URL or paste a cURL command', hint: 'REST and any other HTTP request' },
	{ id: 'graphql', label: 'GraphQL', badge: 'GQL', stream: false, sends: false, urlPlaceholder: 'https://api.example.com/graphql', hint: 'A query or mutation with variables' },
	{ id: 'ai', label: 'AI Request', badge: 'AI', stream: false, sends: false, urlPlaceholder: 'https://api.openai.com/v1/chat/completions', hint: 'A prompt to a model provider\'s API' },
	{ id: 'mcp', label: 'MCP', badge: 'MCP', stream: false, sends: false, urlPlaceholder: 'https://example.com/mcp', hint: 'JSON-RPC to an MCP server' },
	{ id: 'grpc', label: 'gRPC', badge: 'gRPC', stream: true, sends: true, urlPlaceholder: 'localhost:50051', hint: 'A call from a .proto file or server reflection' },
	{ id: 'ws', label: 'WebSocket', badge: 'WS', stream: true, sends: true, urlPlaceholder: 'wss://example.com/socket', hint: 'Send and receive messages on one socket' },
	{ id: 'socketio', label: 'Socket.IO', badge: 'IO', stream: true, sends: true, target: 'event', urlPlaceholder: 'http://localhost:3000', hint: 'Emit events and listen for them' },
	{ id: 'mqtt', label: 'MQTT', badge: 'MQTT', stream: true, sends: true, target: 'topic', urlPlaceholder: 'mqtt://localhost:1883', hint: 'Subscribe to topics and publish to them' },
	{ id: 'sse', label: 'Server-Sent Events', badge: 'SSE', stream: true, sends: false, urlPlaceholder: 'https://example.com/events', hint: 'Follow a stream of events' },
	{ id: 'soap', label: 'SOAP', badge: 'SOAP', stream: false, sends: false, urlPlaceholder: 'https://example.com/service', hint: 'An XML envelope with a SOAPAction' },
];

export function httpProtocolInfo(protocol: HttpProtocol | string | undefined): IHttpProtocolInfo {
	return HTTP_PROTOCOLS.find(item => item.id === protocol) ?? HTTP_PROTOCOLS[0];
}

export function isHttpProtocol(value: unknown): value is HttpProtocol {
	return typeof value === 'string' && HTTP_PROTOCOLS.some(item => item.id === value);
}

/** What a tab, a tree row or a history entry shows where a method goes. */
export function httpRequestBadge(request: { readonly method: string; readonly protocol?: string }): string {
	if (request.protocol && request.protocol !== 'http') {
		return httpProtocolInfo(request.protocol).badge;
	}
	return request.method === 'DELETE' ? 'DEL' : request.method === 'OPTIONS' ? 'OPT' : request.method;
}

/** The colour key of that badge (`data-method`): the method, or the kind. */
export function httpRequestBadgeKey(request: { readonly method: string; readonly protocol?: string }): string {
	return request.protocol && request.protocol !== 'http' ? request.protocol : request.method;
}

// --- Messages in an `.http` block ---------------------------------------------------------------

const MESSAGE_SEPARATOR = /^(?:>>>|===)[ \t]*(.*)$/;

/**
 * A block's body as messages: each `>>>` line starts one (what follows on that line is its event or
 * topic), text before the first `>>>` is a message too. JetBrains' `===` separators read the same
 * (`=== wait-for-server` is a pause there and nothing here).
 */
export function httpMessagesFromBody(body: string): IHttpMessage[] {
	const messages: IHttpMessage[] = [];
	let current: { target?: string; lines: string[] } | undefined;
	const flush = () => {
		if (!current) {
			return;
		}
		const text = current.lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
		if (text || current.target) {
			messages.push({ ...(current.target ? { target: current.target } : {}), body: text });
		}
	};
	for (const line of body.split(/\r?\n/)) {
		const separator = MESSAGE_SEPARATOR.exec(line);
		if (separator) {
			flush();
			const target = separator[1].trim();
			current = { ...(target && target !== 'wait-for-server' ? { target } : {}), lines: [] };
		} else {
			current ??= { lines: [] };
			current.lines.push(line);
		}
	}
	flush();
	return messages;
}

export function httpMessagesToBody(messages: readonly IHttpMessage[]): string {
	return messages.map(message => `>>>${message.target ? ` ${message.target}` : ''}\n${message.body}`).join('\n\n');
}

// --- GraphQL --------------------------------------------------------------------------------------

/** The operation a query document runs when it names exactly one. */
export function graphqlOperationName(query: string): string | undefined {
	const names = [...stripGraphqlNoise(query).matchAll(/\b(?:query|mutation|subscription)\s+([_A-Za-z]\w*)/g)].map(match => match[1]);
	return names.length === 1 ? names[0] : undefined;
}

function stripGraphqlNoise(query: string): string {
	return query.replace(/"""[\s\S]*?"""/g, '""').replace(/"(?:\\.|[^"\\\n])*"/g, '""').replace(/#[^\n]*/g, '');
}

/** A query's indentation put right: two spaces per open brace or parenthesis. */
export function prettyGraphql(query: string): string {
	const out: string[] = [];
	let depth = 0;
	for (const raw of query.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) {
			if (out.length && out[out.length - 1] !== '') {
				out.push('');
			}
			continue;
		}
		const bare = stripGraphqlNoise(line);
		const leadingClose = /^[)\]}]+/.exec(bare)?.[0].length ?? 0;
		out.push(`${'  '.repeat(Math.max(0, depth - leadingClose))}${line}`);
		depth = Math.max(0, depth + (bare.match(/[{(\[]/g)?.length ?? 0) - (bare.match(/[})\]]/g)?.length ?? 0));
	}
	while (out.length && out[out.length - 1] === '') {
		out.pop();
	}
	return out.join('\n');
}

// --- AI requests ----------------------------------------------------------------------------------

export type HttpAiProvider = 'openai' | 'anthropic';

/** What an AI request's form edits; the request's body is this as the provider's JSON. */
export interface IHttpAiPrompt {
	provider: HttpAiProvider;
	model: string;
	system: string;
	prompt: string;
	maxTokens?: number;
	temperature?: number;
}

export const HTTP_AI_PROVIDERS: readonly { readonly id: HttpAiProvider; readonly label: string; readonly url: string; readonly keyVariable: string; readonly model: string }[] = [
	{ id: 'openai', label: 'OpenAI compatible', url: 'https://api.openai.com/v1/chat/completions', keyVariable: 'OPENAI_API_KEY', model: '' },
	{ id: 'anthropic', label: 'Anthropic', url: 'https://api.anthropic.com/v1/messages', keyVariable: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5' },
];

export function httpAiProviderOf(url: string, body?: string): HttpAiProvider {
	return /anthropic\.com|\/v1\/messages\b/i.test(url) || (!!body && /"anthropic_version"/.test(body)) ? 'anthropic' : 'openai';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textOfContent(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map(part => typeof part === 'string' ? part : typeof asRecord(part)?.text === 'string' ? asRecord(part)!.text as string : '').join('');
	}
	return '';
}

/** Reads a provider body back into the form; undefined when it is not one the form can hold (several turns, tools...). */
export function httpAiPromptFromBody(url: string, body: string): IHttpAiPrompt | undefined {
	const provider = httpAiProviderOf(url, body);
	if (!body.trim()) {
		return { provider, model: HTTP_AI_PROVIDERS.find(item => item.id === provider)?.model ?? '', system: '', prompt: '' };
	}
	let json: Record<string, unknown> | undefined;
	try {
		json = asRecord(JSON.parse(body));
	} catch {
		return undefined;
	}
	if (!json) {
		return undefined;
	}
	const known = new Set(['model', 'messages', 'system', 'max_tokens', 'max_completion_tokens', 'temperature']);
	if (Object.keys(json).some(key => !known.has(key))) {
		return undefined;
	}
	const messages = Array.isArray(json.messages) ? json.messages.map(asRecord) : [];
	if (messages.some(message => !message)) {
		return undefined;
	}
	const systems = messages.filter(message => message!.role === 'system' || message!.role === 'developer');
	const users = messages.filter(message => message!.role === 'user');
	if (systems.length > 1 || users.length > 1 || systems.length + users.length !== messages.length) {
		return undefined;
	}
	const maxTokens = json.max_tokens ?? json.max_completion_tokens;
	return {
		provider,
		model: typeof json.model === 'string' ? json.model : '',
		system: typeof json.system === 'string' ? json.system : systems.length ? textOfContent(systems[0]!.content) : '',
		prompt: users.length ? textOfContent(users[0]!.content) : '',
		...(typeof maxTokens === 'number' ? { maxTokens } : {}),
		...(typeof json.temperature === 'number' ? { temperature: json.temperature } : {}),
	};
}

/** The form as the provider's request body. */
export function httpAiBodyOf(prompt: IHttpAiPrompt): string {
	const body: Record<string, unknown> = { model: prompt.model };
	if (prompt.provider === 'anthropic') {
		// Anthropic's Messages API needs a token budget and takes the system prompt beside the messages.
		body.max_tokens = prompt.maxTokens ?? 1024;
		if (prompt.system.trim()) {
			body.system = prompt.system;
		}
		body.messages = [{ role: 'user', content: prompt.prompt }];
	} else {
		body.messages = [...(prompt.system.trim() ? [{ role: 'system', content: prompt.system }] : []), { role: 'user', content: prompt.prompt }];
		if (prompt.maxTokens !== undefined) {
			body.max_tokens = prompt.maxTokens;
		}
	}
	if (prompt.temperature !== undefined) {
		body.temperature = prompt.temperature;
	}
	return JSON.stringify(body, null, 2);
}

/** The model's answer and its token counts, read from either provider's response. */
export function httpAiAnswerOf(body: string): { readonly text: string; readonly model?: string; readonly inputTokens?: number; readonly outputTokens?: number; readonly stop?: string } | undefined {
	let json: Record<string, unknown> | undefined;
	try {
		json = asRecord(JSON.parse(body));
	} catch {
		return undefined;
	}
	if (!json) {
		return undefined;
	}
	const usage = asRecord(json.usage);
	const count = (...keys: string[]) => keys.map(key => usage?.[key]).find((value): value is number => typeof value === 'number');
	const meta = {
		...(typeof json.model === 'string' ? { model: json.model } : {}),
		...(count('input_tokens', 'prompt_tokens') !== undefined ? { inputTokens: count('input_tokens', 'prompt_tokens') } : {}),
		...(count('output_tokens', 'completion_tokens') !== undefined ? { outputTokens: count('output_tokens', 'completion_tokens') } : {}),
	};
	if (Array.isArray(json.content)) {
		return { text: textOfContent(json.content), ...meta, ...(typeof json.stop_reason === 'string' ? { stop: json.stop_reason } : {}) };
	}
	const choice = Array.isArray(json.choices) ? asRecord(json.choices[0]) : undefined;
	if (choice) {
		const message = asRecord(choice.message);
		return { text: message ? textOfContent(message.content) : typeof choice.text === 'string' ? choice.text : '', ...meta, ...(typeof choice.finish_reason === 'string' ? { stop: choice.finish_reason } : {}) };
	}
	if (typeof json.output_text === 'string') {
		return { text: json.output_text, ...meta };
	}
	return undefined;
}

// --- MCP ------------------------------------------------------------------------------------------

export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** The JSON-RPC messages the MCP editor offers, by method. */
export const HTTP_MCP_TEMPLATES: readonly { readonly method: string; readonly label: string; readonly params?: unknown }[] = [
	{ method: 'initialize', label: 'Initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'volt-client', version: '1.0' } } },
	{ method: 'tools/list', label: 'List tools' },
	{ method: 'tools/call', label: 'Call a tool', params: { name: '', arguments: {} } },
	{ method: 'resources/list', label: 'List resources' },
	{ method: 'resources/read', label: 'Read a resource', params: { uri: '' } },
	{ method: 'resources/templates/list', label: 'List resource templates' },
	{ method: 'prompts/list', label: 'List prompts' },
	{ method: 'prompts/get', label: 'Get a prompt', params: { name: '', arguments: {} } },
	{ method: 'ping', label: 'Ping' },
];

export function httpMcpMessage(method: string, id: number | string = 1): string {
	const template = HTTP_MCP_TEMPLATES.find(item => item.method === method);
	return JSON.stringify({ jsonrpc: '2.0', id, method, ...(template?.params !== undefined ? { params: template.params } : {}) }, null, 2);
}

/** The `method` of a JSON-RPC body, when it parses. */
export function httpMcpMethodOf(body: string): string | undefined {
	try {
		const method = asRecord(JSON.parse(body))?.method;
		return typeof method === 'string' ? method : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A Streamable HTTP answer as JSON text: the body itself, or (for `text/event-stream`) the data of
 * the event that answers `id`, else of the last event that carries JSON.
 */
export function httpMcpResponseBody(contentType: string, body: string, id: unknown): string {
	if (!/text\/event-stream/i.test(contentType)) {
		return body;
	}
	const events: string[] = [];
	let data: string[] = [];
	for (const line of body.split(/\r\n|\r|\n/)) {
		if (line === '') {
			if (data.length) {
				events.push(data.join('\n'));
			}
			data = [];
		} else if (line.startsWith('data:')) {
			data.push(line.slice(5).replace(/^ /, ''));
		}
	}
	if (data.length) {
		events.push(data.join('\n'));
	}
	let last: string | undefined;
	for (const event of events) {
		try {
			const parsed = asRecord(JSON.parse(event));
			if (parsed) {
				last = event;
				if (id !== undefined && parsed.id === id && ('result' in parsed || 'error' in parsed)) {
					return event;
				}
			}
		} catch { /* not JSON: a keep-alive or a comment */ }
	}
	return last ?? body;
}

// --- SOAP -----------------------------------------------------------------------------------------

export const HTTP_SOAP_ENVELOPE = [
	'<?xml version="1.0" encoding="utf-8"?>',
	'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
	'  <soap:Body>',
	'    ',
	'  </soap:Body>',
	'</soap:Envelope>',
].join('\n');

// --- gRPC -----------------------------------------------------------------------------------------

/** `host:port/package.Service/Method` taken apart; the service and method are empty until picked. */
export function httpGrpcTarget(url: string): { readonly address: string; readonly service: string; readonly method: string } {
	const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url)?.[0] ?? '';
	const rest = url.slice(scheme.length);
	const slash = rest.indexOf('/');
	if (slash < 0) {
		return { address: url, service: '', method: '' };
	}
	const [service = '', method = ''] = rest.slice(slash + 1).split('/');
	return { address: `${scheme}${rest.slice(0, slash)}`, service, method };
}

export function httpGrpcUrl(address: string, service: string, method: string): string {
	return service ? `${address.replace(/\/+$/, '')}/${service}${method ? `/${method}` : ''}` : address;
}

// --- Generated tests ------------------------------------------------------------------------------

/** The script out of a model's answer: the first fenced block when it used one anyway, else the text. */
export function httpScriptFromAnswer(answer: string): string {
	// An agent's text-only session wraps what it writes in `<insert>` tags.
	const plain = answer.replace(/<\/?insert>/gi, '');
	const fenced = /```(?:javascript|js|ts|typescript)?[ \t]*\r?\n([\s\S]*?)(?:```|$)/i.exec(plain);
	return (fenced ? fenced[1] : plain).replace(/\r\n/g, '\n').trim();
}
