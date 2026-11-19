/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the HTTP client imports: a pasted cURL command, an OpenAPI or Swagger document (JSON or
 * YAML), a HAR recording, Postman's collection and environment files, and `.http` text.
 * `detectHttpImport` tells which one a text is and returns it in the client's model.
 */

import { parse as parseYaml, YamlNode } from '../../../../base/common/yaml.js';
import { IHttpRequestSpec } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { emptyHttpAuth, emptyHttpCollection, emptyHttpFolder, emptyHttpRequest, httpPathVariablesFor, httpRequestFromSpec, httpRequestsOf, httpUrlWithQuery, IHttpCollection, IHttpEnvironment, IHttpFolder, IHttpKeyValue, IHttpRequest } from './httpCollection.js';
import { httpFileToCollection } from './httpDotHttp.js';
import { isPostmanCollection, isPostmanEnvironment, postmanToCollection, postmanToEnvironment } from './httpPostman.js';

type Json = Record<string, unknown>;

function rec(value: unknown): Json | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

// --- cURL -------------------------------------------------------------------------------------

/** A shell command line as words: quotes, `$'...'`, and `\` or `^` line continuations. */
function shellWords(command: string): string[] {
	const source = command.replace(/\r\n/g, '\n').replace(/[\\^`]\n/g, ' ');
	const words: string[] = [];
	let current: string | undefined;
	const push = (piece: string) => current = (current ?? '') + piece;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === '\'' || (char === '$' && source[index + 1] === '\'')) {
			const ansi = char === '$';
			let at = index + (ansi ? 2 : 1);
			let piece = '';
			for (; at < source.length && source[at] !== '\''; at++) {
				if (ansi && source[at] === '\\' && at + 1 < source.length) {
					const next = source[++at];
					const hex = next === 'x' ? /^[0-9a-fA-F]{1,2}/.exec(source.slice(at + 1)) : next === 'u' ? /^[0-9a-fA-F]{1,4}/.exec(source.slice(at + 1)) : null;
					if (hex) {
						piece += String.fromCharCode(parseInt(hex[0], 16));
						at += hex[0].length;
					} else {
						piece += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
					}
				} else {
					piece += source[at];
				}
			}
			push(piece);
			index = at;
		} else if (char === '"') {
			let at = index + 1;
			let piece = '';
			for (; at < source.length && source[at] !== '"'; at++) {
				if (source[at] === '\\' && at + 1 < source.length && '"\\$`\n'.includes(source[at + 1])) {
					at++;
					piece += source[at] === '\n' ? '' : source[at];
				} else if (source[at] === '^' && source[at + 1] === '"') {
					// cmd.exe's escaped quote inside a quoted word.
					at++;
					piece += '"';
				} else {
					piece += source[at];
				}
			}
			push(piece);
			index = at;
		} else if (char === '\\' && index + 1 < source.length) {
			push(source[++index]);
		} else if (/\s/.test(char)) {
			if (current !== undefined) {
				words.push(current);
				current = undefined;
			}
		} else {
			push(char);
		}
	}
	if (current !== undefined) {
		words.push(current);
	}
	return words;
}

/** Short flags that take a value (`-H 'A: b'`, `-XPOST`). */
const CURL_SHORT_VALUES = 'XHdFuAebomxwcTECKrtyYzQ';
const CURL_SHORT_NAMES: Readonly<Record<string, string>> = { X: 'request', H: 'header', d: 'data', F: 'form', u: 'user', A: 'user-agent', e: 'referer', b: 'cookie', G: 'get', I: 'head', T: 'upload-file' };
const CURL_LONG_VALUES = new Set(['request', 'header', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'json', 'form', 'form-string', 'user', 'user-agent', 'referer', 'cookie', 'url', 'output', 'max-time', 'connect-timeout', 'proxy', 'cert', 'key', 'cacert', 'write-out', 'cookie-jar', 'retry', 'upload-file', 'resolve', 'oauth2-bearer', 'max-redirs', 'proxy-user', 'range', 'limit-rate', 'interface', 'ciphers', 'capath', 'unix-socket', 'aws-sigv4', 'retry-delay', 'retry-max-time', 'config', 'dump-header', 'trace', 'trace-ascii', 'stderr']);
const CURL_LONG_FLAGS = new Set(['compressed', 'insecure', 'location', 'silent', 'show-error', 'verbose', 'include', 'fail', 'globoff', 'http1.0', 'http1.1', 'http2', 'http2-prior-knowledge', 'http3', 'get', 'head', 'location-trusted', 'no-buffer', 'no-keepalive', 'ipv4', 'ipv6', 'tlsv1.2', 'tlsv1.3', 'fail-with-body', 'progress-bar', 'no-progress-meter', 'remote-name', 'digest', 'ntlm', 'negotiate', 'anyauth', 'basic', 'path-as-is', 'disable', 'raw', 'tr-encoding', 'ssl-no-revoke', 'ssl-reqd', 'post301', 'post302', 'post303']);

function looksLikeUrl(word: string): boolean {
	return /^([a-z][a-z0-9+.-]*:\/\/|localhost\b|\{\{|\d{1,3}(\.\d{1,3}){3}|[\w-]+(\.[\w-]+)+([/:?]|$))/i.test(word);
}

function encodeDataUrlencode(value: string): string {
	const at = value.indexOf('=');
	if (at < 0) {
		return encodeURIComponent(value);
	}
	return at === 0 ? encodeURIComponent(value.slice(1)) : `${value.slice(0, at)}=${encodeURIComponent(value.slice(at + 1))}`;
}

/** A cURL command as a request; undefined when the text is not one or names no URL. */
export function curlToRequest(command: string): IHttpRequest | undefined {
	const words = shellWords(command.trim().replace(/^[$>#]\s+/, ''));
	if (!words.length || !/^(?:.*[\\/])?curl(?:\.exe)?$/i.test(words[0])) {
		return undefined;
	}
	let method: string | undefined;
	let url: string | undefined;
	let user: string | undefined;
	let bearer: string | undefined;
	let asQuery = false;
	let json = false;
	let upload: string | undefined;
	const headers: [string, string][] = [];
	const data: string[] = [];
	const form: IHttpKeyValue[] = [];

	const apply = (name: string, value: string) => {
		switch (name) {
			case 'request': method = value.toUpperCase(); break;
			case 'header': {
				const at = value.indexOf(':');
				if (at > 0) {
					headers.push([value.slice(0, at).trim(), value.slice(at + 1).trim()]);
				} else if (value.endsWith(';')) {
					headers.push([value.slice(0, -1).trim(), '']);
				}
				break;
			}
			case 'data': case 'data-ascii': case 'data-raw': case 'data-binary': data.push(value); break;
			case 'data-urlencode': data.push(encodeDataUrlencode(value)); break;
			case 'json': data.push(value); json = true; break;
			case 'form': case 'form-string': {
				const at = value.indexOf('=');
				const key = at < 0 ? value : value.slice(0, at);
				const raw = at < 0 ? '' : value.slice(at + 1);
				if (name === 'form' && /^[@<]/.test(raw)) {
					form.push({ key, value: raw.slice(1).split(';')[0].replace(/^"|"$/g, ''), enabled: true, type: 'file' });
				} else {
					form.push({ key, value: name === 'form' ? raw.replace(/;type=[^;]+$/, '').replace(/^"(.*)"$/, '$1') : raw, enabled: true, type: 'text' });
				}
				break;
			}
			case 'user': user = value; break;
			case 'oauth2-bearer': bearer = value; break;
			case 'user-agent': headers.push(['User-Agent', value]); break;
			case 'referer': headers.push(['Referer', value]); break;
			case 'cookie':
				if (value.includes('=')) {
					headers.push(['Cookie', value]);
				}
				break;
			case 'url': url = url ?? value; break;
			case 'upload-file': upload = value; break;
		}
	};

	for (let index = 1; index < words.length; index++) {
		const word = words[index];
		if (word.startsWith('--') && word.length > 2) {
			const eq = word.indexOf('=');
			const name = (eq < 0 ? word.slice(2) : word.slice(2, eq)).toLowerCase();
			if (name === 'get') {
				asQuery = true;
			} else if (name === 'head') {
				method = method ?? 'HEAD';
			} else if (eq >= 0) {
				apply(name, word.slice(eq + 1));
			} else if (CURL_LONG_VALUES.has(name)) {
				apply(name, words[++index] ?? '');
			} else if (!CURL_LONG_FLAGS.has(name) && index + 1 < words.length && !words[index + 1].startsWith('-') && !(url === undefined && looksLikeUrl(words[index + 1]))) {
				// A flag this does not know, followed by something that is not the URL: its value.
				index++;
			}
		} else if (word.startsWith('-') && word.length > 1) {
			for (let at = 1; at < word.length; at++) {
				const flag = word[at];
				if (flag === 'G') {
					asQuery = true;
				} else if (flag === 'I') {
					method = method ?? 'HEAD';
				} else if (CURL_SHORT_VALUES.includes(flag)) {
					const attached = word.slice(at + 1);
					const value = attached !== '' ? attached : words[++index] ?? '';
					const name = CURL_SHORT_NAMES[flag];
					if (name) {
						apply(name, flag === 'X' || flag === 'H' ? value.trim() : value);
					}
					break;
				}
			}
		} else if (url === undefined) {
			url = word;
		}
	}
	if (url === undefined) {
		return undefined;
	}

	let body = data.length ? data.join('&') : undefined;
	if (asQuery && body !== undefined) {
		url += `${url.includes('?') ? '&' : '?'}${body}`;
		body = undefined;
	}
	const hasType = () => headers.some(([key]) => key.toLowerCase() === 'content-type');
	if (json) {
		if (!hasType()) {
			headers.push(['Content-Type', 'application/json']);
		}
		if (!headers.some(([key]) => key.toLowerCase() === 'accept')) {
			headers.push(['Accept', 'application/json']);
		}
	} else if (body !== undefined && !hasType() && !/^\s*[[{]/.test(body)) {
		// What curl says about -d without a content type.
		headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
	}
	const multipart = form.length > 0;
	const spec: IHttpRequestSpec = {
		method: method ?? (upload !== undefined ? 'PUT' : body !== undefined || multipart ? 'POST' : 'GET'),
		url,
		headers: multipart ? headers.filter(([key]) => key.toLowerCase() !== 'content-type') : headers,
		...(body !== undefined && !multipart ? { body } : {}),
		line: 0,
	};
	const request = httpRequestFromSpec(spec);
	request.name = '';
	if (multipart) {
		request.body.mode = 'formdata';
		request.body.formdata = form;
	} else if (upload !== undefined && body === undefined) {
		request.body.mode = 'binary';
		request.body.binaryPath = upload;
	}
	if (user !== undefined) {
		const at = user.indexOf(':');
		request.auth = { ...emptyHttpAuth('basic'), username: at < 0 ? user : user.slice(0, at), password: at < 0 ? '' : user.slice(at + 1) };
	} else if (bearer !== undefined) {
		request.auth = { ...emptyHttpAuth('bearer'), token: bearer };
	}
	return request;
}

// --- OpenAPI / Swagger ------------------------------------------------------------------------

const OPENAPI_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const MAX_REF_DEPTH = 8;

export function isOpenApi(doc: unknown): boolean {
	const root = rec(doc);
	return !!root && (typeof root.openapi === 'string' || typeof root.swagger === 'string' || typeof root.openapi === 'number' || typeof root.swagger === 'number') && !!rec(root.paths);
}

/** Follows local `$ref`s (`#/components/schemas/User`). */
function deref(root: Json, value: unknown, depth = 0): Json | undefined {
	const object = rec(value);
	if (!object || typeof object.$ref !== 'string') {
		return object;
	}
	if (depth > MAX_REF_DEPTH || !object.$ref.startsWith('#/')) {
		return undefined;
	}
	let current: unknown = root;
	for (const part of object.$ref.slice(2).split('/')) {
		current = rec(current)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
	}
	return deref(root, current, depth + 1);
}

/**
 * An example value for a schema: its example, default or first enum value, else a placeholder of
 * its type. A schema that contains itself stops at the repeat (undefined: left out).
 */
function sample(root: Json, value: unknown, depth = 0, open: ReadonlySet<string> = new Set()): unknown {
	const ref = rec(value)?.$ref;
	if (typeof ref === 'string') {
		if (open.has(ref)) {
			return undefined;
		}
		open = new Set([...open, ref]);
	}
	const schema = deref(root, value);
	if (!schema || depth > MAX_REF_DEPTH) {
		return depth > MAX_REF_DEPTH ? undefined : {};
	}
	if (schema.example !== undefined) {
		return schema.example;
	}
	if (schema.default !== undefined) {
		return schema.default;
	}
	if (Array.isArray(schema.enum) && schema.enum.length) {
		return schema.enum[0];
	}
	if (Array.isArray(schema.allOf)) {
		const merged: Json = {};
		for (const part of schema.allOf) {
			const piece = sample(root, part, depth + 1, open);
			if (rec(piece)) {
				Object.assign(merged, piece);
			}
		}
		return merged;
	}
	const union = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
	if (union?.length) {
		return sample(root, union[0], depth + 1, open);
	}
	const type = Array.isArray(schema.type) ? schema.type.find(item => item !== 'null') : schema.type;
	if (type === 'object' || (!type && rec(schema.properties))) {
		const out: Json = {};
		for (const [key, property] of Object.entries(rec(schema.properties) ?? {})) {
			if (rec(deref(root, property))?.readOnly !== true) {
				const item = sample(root, property, depth + 1, open);
				if (item !== undefined) {
					out[key] = item;
				}
			}
		}
		return out;
	}
	switch (type) {
		case 'array': {
			const item = sample(root, schema.items, depth + 1, open);
			return item === undefined ? [] : [item];
		}
		case 'integer': case 'number': return 0;
		case 'boolean': return false;
		case 'string':
			switch (schema.format) {
				case 'date-time': return '2024-01-01T00:00:00Z';
				case 'date': return '2024-01-01';
				case 'uuid': return '00000000-0000-0000-0000-000000000000';
				case 'email': return 'user@example.com';
				case 'uri': case 'url': return 'https://example.com';
			}
			return 'string';
	}
	return {};
}

function scalar(value: unknown): string {
	return value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** A parameter's example value: its own, its schema's, else empty. */
function parameterValue(root: Json, parameter: Json): string {
	const schema = deref(root, parameter.schema) ?? parameter;
	for (const candidate of [parameter.example, schema.example, schema.default, parameter.default, Array.isArray(schema.enum) ? schema.enum[0] : undefined]) {
		if (candidate !== undefined) {
			return scalar(candidate);
		}
	}
	const examples = rec(parameter.examples);
	const first = examples ? deref(root, Object.values(examples)[0]) : undefined;
	return first?.value !== undefined ? scalar(first.value) : '';
}

function formRows(root: Json, schemaValue: unknown): IHttpKeyValue[] {
	const schema = deref(root, schemaValue);
	const required = new Set(list(schema?.required).map(text));
	return Object.entries(rec(schema?.properties) ?? {}).map(([key, property]) => {
		const resolved = deref(root, property) ?? {};
		const file = resolved.format === 'binary' || resolved.type === 'file';
		const description = text(resolved.description);
		return { key, value: file ? '' : scalar(sample(root, property, 1)), enabled: required.size ? required.has(key) : true, type: file ? 'file' as const : 'text' as const, ...(description ? { description } : {}) };
	});
}

function mediaExample(root: Json, mediaValue: unknown): unknown {
	const media = rec(mediaValue) ?? {};
	if (media.example !== undefined) {
		return media.example;
	}
	const examples = rec(media.examples);
	const first = examples ? deref(root, Object.values(examples)[0]) : undefined;
	if (first?.value !== undefined) {
		return first.value;
	}
	return media.schema !== undefined ? sample(root, media.schema) : undefined;
}

/** An OpenAPI 3.x or Swagger 2.0 document as a collection: a folder per tag, a request per operation. */
export function openApiToCollection(doc: unknown): IHttpCollection {
	const root = rec(doc);
	if (!root || !isOpenApi(root)) {
		throw new Error('Not an OpenAPI or Swagger document: it needs "openapi" or "swagger", and "paths".');
	}
	const info = rec(root.info) ?? {};
	const collection = emptyHttpCollection(text(info.title) || 'API', 'postman');
	collection.description = text(info.description);

	let baseUrl = '';
	const server = rec(list(root.servers)[0]);
	if (server) {
		baseUrl = text(server.url).replace(/\{([^}]+)\}/g, (whole, name: string) => {
			const variable = rec(rec(server.variables)?.[name]);
			return variable?.default !== undefined ? text(variable.default) : whole;
		});
	} else if (typeof root.host === 'string') {
		const schemes = list(root.schemes).map(text);
		baseUrl = `${schemes.includes('https') ? 'https' : schemes[0] || 'https'}://${root.host}${text(root.basePath)}`;
	} else if (typeof root.basePath === 'string') {
		baseUrl = root.basePath;
	}
	collection.variables.push({ key: 'baseUrl', value: baseUrl.replace(/\/+$/, ''), enabled: true });

	const schemes = Object.values(rec(rec(root.components)?.securitySchemes) ?? rec(root.securityDefinitions) ?? {}).map(scheme => deref(root, scheme)).filter((scheme): scheme is Json => !!scheme);
	if (schemes.length === 1) {
		const scheme = schemes[0];
		const type = text(scheme.type).toLowerCase();
		const httpScheme = text(scheme.scheme).toLowerCase();
		if ((type === 'http' && httpScheme === 'bearer') || type === 'oauth2' || type === 'openidconnect') {
			collection.auth = { ...emptyHttpAuth('bearer'), token: '{{bearerToken}}' };
			collection.variables.push({ key: 'bearerToken', value: '', enabled: true });
		} else if ((type === 'http' && httpScheme === 'basic') || type === 'basic') {
			collection.auth = { ...emptyHttpAuth('basic'), username: '{{username}}', password: '{{password}}' };
			collection.variables.push({ key: 'username', value: '', enabled: true }, { key: 'password', value: '', enabled: true });
		} else if (type === 'apikey' && (scheme.in === 'header' || scheme.in === 'query')) {
			collection.auth = { ...emptyHttpAuth('apikey'), keyName: text(scheme.name), keyValue: '{{apiKey}}', keyIn: scheme.in };
			collection.variables.push({ key: 'apiKey', value: '', enabled: true });
		}
	}

	const tagDescriptions = new Map<string, string>();
	for (const tag of list(root.tags).map(rec)) {
		if (tag && typeof tag.name === 'string') {
			tagDescriptions.set(tag.name, text(tag.description));
		}
	}
	const folders = new Map<string, IHttpFolder>();
	const folderFor = (tag: string): IHttpFolder => {
		let folder = folders.get(tag);
		if (!folder) {
			folder = emptyHttpFolder(tag);
			folder.description = tagDescriptions.get(tag) ?? '';
			folders.set(tag, folder);
			collection.items.push(folder);
		}
		return folder;
	};

	for (const [path, pathValue] of Object.entries(rec(root.paths) ?? {})) {
		const pathItem = deref(root, pathValue);
		if (!pathItem) {
			continue;
		}
		for (const method of OPENAPI_METHODS) {
			const operation = rec(pathItem[method]);
			if (!operation) {
				continue;
			}
			const parameters = new Map<string, Json>();
			for (const raw of [...list(pathItem.parameters), ...list(operation.parameters)]) {
				const parameter = deref(root, raw);
				if (parameter && typeof parameter.name === 'string') {
					parameters.set(`${text(parameter.in)}:${parameter.name}`, parameter);
				}
			}
			const request = emptyHttpRequest(text(operation.summary) || text(operation.operationId) || `${method.toUpperCase()} ${path}`);
			request.method = method.toUpperCase();
			request.description = text(operation.description);
			const pathValues: IHttpKeyValue[] = [];
			for (const parameter of parameters.values()) {
				const description = text(parameter.description);
				const row: IHttpKeyValue = { key: text(parameter.name), value: parameterValue(root, parameter), enabled: parameter.required === true, ...(description ? { description } : {}) };
				switch (parameter.in) {
					case 'query': request.params.push(row); break;
					case 'path': pathValues.push({ ...row, enabled: true }); break;
					case 'header':
						if (!/^(accept|content-type|authorization)$/i.test(row.key)) {
							request.headers.push(row);
						}
						break;
				}
			}
			request.url = httpUrlWithQuery(`{{baseUrl}}${path.replace(/\{([^}/]+)\}/g, ':$1')}`, request.params);
			request.pathVariables = httpPathVariablesFor(request.url, pathValues);

			// The body: OpenAPI 3's requestBody, or Swagger 2's body and formData parameters.
			const content = rec(deref(root, operation.requestBody)?.content);
			const bodyParameter = [...parameters.values()].find(parameter => parameter.in === 'body');
			const formParameters = [...parameters.values()].filter(parameter => parameter.in === 'formData');
			if (content) {
				const types = Object.keys(content);
				const jsonType = types.find(type => /json/i.test(type));
				if (jsonType) {
					request.body.mode = 'raw';
					request.body.language = 'json';
					request.body.raw = JSON.stringify(mediaExample(root, content[jsonType]) ?? {}, null, 2);
				} else if (types.includes('application/x-www-form-urlencoded')) {
					request.body.mode = 'urlencoded';
					request.body.urlencoded = formRows(root, rec(content['application/x-www-form-urlencoded'])?.schema).map(({ type: _type, ...row }) => row);
				} else if (types.includes('multipart/form-data')) {
					request.body.mode = 'formdata';
					request.body.formdata = formRows(root, rec(content['multipart/form-data'])?.schema);
				} else if (types.length) {
					const example = mediaExample(root, content[types[0]]);
					if (/octet-stream/i.test(types[0])) {
						request.body.mode = 'binary';
					} else {
						request.body.mode = 'raw';
						request.body.language = /xml/i.test(types[0]) ? 'xml' : /html/i.test(types[0]) ? 'html' : 'text';
						request.body.raw = typeof example === 'string' ? example : example === undefined ? '' : JSON.stringify(example, null, 2);
						if (request.body.language === 'text' && !/^text\/plain/i.test(types[0])) {
							request.headers.push({ key: 'Content-Type', value: types[0], enabled: true });
						}
					}
				}
			} else if (bodyParameter) {
				request.body.mode = 'raw';
				request.body.language = 'json';
				request.body.raw = JSON.stringify(sample(root, bodyParameter.schema) ?? {}, null, 2);
			} else if (formParameters.length) {
				const consumes = [...list(operation.consumes), ...list(root.consumes)].map(text);
				const rows = formParameters.map(parameter => {
					const description = text(parameter.description);
					const file = parameter.type === 'file';
					return { key: text(parameter.name), value: file ? '' : parameterValue(root, parameter), enabled: parameter.required === true || file, type: file ? 'file' as const : 'text' as const, ...(description ? { description } : {}) };
				});
				if (consumes.some(type => /multipart/i.test(type)) || rows.some(row => row.type === 'file')) {
					request.body.mode = 'formdata';
					request.body.formdata = rows;
				} else {
					request.body.mode = 'urlencoded';
					request.body.urlencoded = rows.map(({ type: _type, ...row }) => row);
				}
			}

			const tag = text(list(operation.tags)[0]);
			(tag ? folderFor(tag).items : collection.items).push(request);
		}
	}
	return collection;
}

// --- HAR --------------------------------------------------------------------------------------

function harToCollection(root: Json, name: string): IHttpCollection {
	const collection = emptyHttpCollection(name, 'postman');
	for (const entry of list(rec(root.log)?.entries).map(rec)) {
		const source = rec(entry?.request);
		if (!source || typeof source.url !== 'string') {
			continue;
		}
		const headers: [string, string][] = [];
		for (const header of list(source.headers).map(rec)) {
			const key = text(header?.name);
			if (key && !key.startsWith(':') && !/^(content-length|host|connection)$/i.test(key)) {
				headers.push([key, text(header?.value)]);
			}
		}
		const postData = rec(source.postData);
		let body = typeof postData?.text === 'string' ? postData.text : undefined;
		if (body === undefined && Array.isArray(postData?.params)) {
			body = postData.params.map(rec).map(param => `${encodeURIComponent(text(param?.name))}=${encodeURIComponent(text(param?.value))}`).join('&');
		}
		const request = httpRequestFromSpec({ method: (text(source.method) || 'GET').toUpperCase(), url: source.url, headers, ...(body ? { body } : {}), line: 0 });
		request.auth = request.auth.type === 'none' ? emptyHttpAuth('inherit') : request.auth;
		collection.items.push(request);
	}
	return collection;
}

// --- Detection --------------------------------------------------------------------------------

export type IHttpImport =
	| { kind: 'collection'; collection: IHttpCollection; source: 'postman' | 'openapi' | 'http' | 'har' }
	| { kind: 'environment'; environment: IHttpEnvironment }
	| { kind: 'request'; request: IHttpRequest; source: 'curl' }
	| { kind: 'unknown'; reason: string };

function yamlValue(node: YamlNode): unknown {
	switch (node.type) {
		case 'object': {
			const out: Json = {};
			for (const property of node.properties) {
				out[property.key.value] = yamlValue(property.value);
			}
			return out;
		}
		case 'array': return node.items.map(yamlValue);
		default: return node.value;
	}
}

function baseName(fileName: string | undefined, fallback: string): string {
	const name = fileName?.split(/[\\/]/).pop()?.replace(/\.(postman_collection\.json|json|ya?ml|http|rest|har|txt)$/i, '');
	return name || fallback;
}

/** What a pasted or opened text is, read into the HTTP client's model. */
export function detectHttpImport(input: string, fileName?: string): IHttpImport {
	const source = input.replace(/^\uFEFF/, '').trim();
	if (!source) {
		return { kind: 'unknown', reason: 'Nothing to import: the text is empty.' };
	}
	if (/^(?:[$>]\s+)?curl(?:\.exe)?\s/i.test(source)) {
		const request = curlToRequest(source);
		return request ? { kind: 'request', request, source: 'curl' } : { kind: 'unknown', reason: 'The cURL command has no URL.' };
	}
	if (/^[[{]/.test(source)) {
		let json: unknown;
		try {
			json = JSON.parse(source);
		} catch (error) {
			json = undefined;
			if (!/\.(http|rest)$/i.test(fileName ?? '')) {
				return { kind: 'unknown', reason: `The JSON does not parse: ${error instanceof Error ? error.message : String(error)}` };
			}
		}
		const root = rec(json);
		if (root) {
			try {
				if (isPostmanCollection(root)) {
					return { kind: 'collection', collection: postmanToCollection(root), source: 'postman' };
				}
				if (isPostmanEnvironment(root)) {
					return { kind: 'environment', environment: postmanToEnvironment(root) };
				}
				if (isOpenApi(root)) {
					return { kind: 'collection', collection: openApiToCollection(root), source: 'openapi' };
				}
				if (Array.isArray(rec(root.log)?.entries)) {
					return { kind: 'collection', collection: harToCollection(root, baseName(fileName, 'HAR Import')), source: 'har' };
				}
			} catch (error) {
				return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
			}
			return { kind: 'unknown', reason: 'The JSON is not a Postman collection, a Postman environment, an OpenAPI or Swagger document, or a HAR file.' };
		}
		if (json !== undefined) {
			return { kind: 'unknown', reason: 'The JSON is not a Postman collection, a Postman environment, an OpenAPI or Swagger document, or a HAR file.' };
		}
	}
	if (/\.ya?ml$/i.test(fileName ?? '') || /^\s*["']?(openapi|swagger)["']?\s*:/m.test(source)) {
		const node = parseYaml(source);
		const doc = node ? yamlValue(node) : undefined;
		if (isOpenApi(doc)) {
			try {
				return { kind: 'collection', collection: openApiToCollection(doc), source: 'openapi' };
			} catch (error) {
				return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
			}
		}
		if (/\.ya?ml$/i.test(fileName ?? '')) {
			return { kind: 'unknown', reason: 'The YAML is not an OpenAPI or Swagger document.' };
		}
	}
	try {
		const collection = httpFileToCollection(source, baseName(fileName, 'Imported requests'));
		if (httpRequestsOf(collection.items).length) {
			return { kind: 'collection', collection, source: 'http' };
		}
	} catch { /* not .http text */ }
	return { kind: 'unknown', reason: 'Not recognized. Import a Postman collection or environment, an OpenAPI or Swagger document, a HAR file, a cURL command or .http text.' };
}
