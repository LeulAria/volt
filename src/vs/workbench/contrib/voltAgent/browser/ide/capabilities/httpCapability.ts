/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { sandboxBrowserUrlRefusal } from '../../../../../services/voltRuntime/common/hostToolSandbox.js';
import { HTTP_METHODS, maskSecret } from '../../../../../services/voltRuntime/common/ide/httpFile.js';
import { HttpSnippetTarget, HTTP_SNIPPET_TARGETS, httpSnippet } from '../../../../voltHttp/common/httpCodegen.js';
import { convertHttpRequest, emptyHttpAuth, emptyHttpFolder, emptyHttpRequest, findHttpItem, findHttpItemByPath, HttpAuthType, httpItemPath, httpRequestFromSpec, httpRequestsOf, httpWireRequest, IHttpCollection, IHttpFolder, IHttpItem, IHttpKeyValue, IHttpRequest } from '../../../../voltHttp/common/httpCollection.js';
import { syncHttpRequestUrl } from '../../../../voltHttp/common/httpDotHttp.js';
import { httpProtocolInfo, httpRequestBadge, IHttpMessage, isHttpProtocol } from '../../../../voltHttp/common/httpProtocols.js';
import { curlToRequest } from '../../../../voltHttp/common/httpImport.js';
import { IHttpCollectionEntry, IVoltHttpCollections } from '../../../../voltHttp/browser/voltHttpCollections.js';
import { IHttpConfinement, IHttpExchange, IVoltHttpService } from '../../../../voltHttp/browser/voltHttpService.js';
import { IVoltHttpAutomations } from '../../../../voltHttp/browser/voltHttpAutomations.js';
import { IVoltHttpPerformance } from '../../../../voltHttp/browser/voltHttpPerformance.js';
import { IVoltHttpSecurity } from '../../../../voltHttp/browser/voltHttpSecurity.js';
import { confinedReadRefusal, display, fail, IIdeCapability, IIdeCapabilityContext, IIdeCapabilityResult, num, ok, resolvePath, str } from './capability.js';
import { runHttpAutomationOp } from './httpAutomationOps.js';
import { runHttpPerformanceOp } from './httpPerformanceOps.js';
import { runHttpSecurityOp } from './httpSecurityOps.js';

/** The client's test tools an agent drives through the same capability: automations, performance tests, security scans. */
export interface IHttpCapabilityTools {
	readonly automations?: IVoltHttpAutomations;
	readonly performance?: IVoltHttpPerformance;
	readonly security?: IVoltHttpSecurity;
}

const MAX_BODY_CHARS = 6_000;
const MAX_EXPORT_CHARS = 24_000;

/** Shows a collection, or one of its requests, in the chat's HTTP client without taking focus. */
export type HttpReveal = (collection: URI, requestPath: readonly string[] | undefined, ctx: IIdeCapabilityContext) => void;

/**
 * The HTTP client for agents: the same collections (Postman files and `.http` files), folders,
 * environments, scripts, history and runner the user has in the HTTP Client tab, on the chat's
 * project. What an agent creates or changes is written to those files and shows in the tab at
 * once; what it sends lands in the tab's history.
 *
 * A request goes out from Volt's process, so a sandboxed chat's follows its network rules here
 * (`IHttpConfinement`): the URL that goes out is judged, redirects are not followed, only files it
 * may read are used, chaining reads only its own earlier responses, and it writes only where the
 * sandbox lets it.
 */
export class HttpCapability implements IIdeCapability {

	readonly id = 'http';

	constructor(
		private readonly http: IVoltHttpService,
		private readonly collections: IVoltHttpCollections,
		private readonly fileService: IFileService,
		private readonly reveal?: HttpReveal,
		private readonly tools: IHttpCapabilityTools = {},
	) { }

	async invoke(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		try {
			return await this.run(op, args, ctx);
		} catch (err) {
			return fail(err instanceof Error ? err.message : String(err));
		}
	}

	private confined(ctx: IIdeCapabilityContext): IHttpConfinement | undefined {
		const sandbox = ctx.confinement?.sandbox;
		return sandbox && {
			key: ctx.chatId ?? 'sandboxed',
			urlRefusal: url => sandboxBrowserUrlRefusal(sandbox, url),
			readable: async uri => !await confinedReadRefusal(ctx, uri),
		};
	}

	/** Why a sandboxed chat may not write `uri`, or undefined when it may (or the chat is not sandboxed). */
	private async writeRefusal(ctx: IIdeCapabilityContext, uri: URI): Promise<string | undefined> {
		if (!ctx.confinement) {
			return undefined;
		}
		return ctx.confinement.writeRefusal ? ctx.confinement.writeRefusal(uri.fsPath) : `Volt cannot tell whether this sandboxed chat may write ${uri.fsPath}`;
	}

	private entries(ctx: IIdeCapabilityContext): Promise<readonly IHttpCollectionEntry[]> {
		return this.collections.collections(ctx.root, this.confined(ctx)?.readable);
	}

	/** The collection an op names with `path`, or the project's only one. */
	private async entry(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext, forWrite: boolean): Promise<IHttpCollectionEntry> {
		const raw = str(args, 'path') ?? str(args, 'collection');
		const entries = await this.entries(ctx);
		let entry: IHttpCollectionEntry | undefined;
		if (raw) {
			const uri = resolvePath(ctx.root, raw);
			entry = entries.find(item => uri && item.uri.toString() === uri.toString()) ?? entries.find(item => item.collection.name === raw);
			if (!entry && uri) {
				if (await confinedReadRefusal(ctx, uri)) {
					throw new Error(`This chat may not read ${raw}.`);
				}
				entry = await this.collections.load(uri);
			}
			if (!entry) {
				throw new Error(`No collection at "${raw}". op list shows the project's collections; op create_collection makes one.`);
			}
		} else if (entries.length === 1) {
			entry = entries[0];
		} else {
			throw new Error(entries.length ? `Say which collection with path. The project has: ${entries.map(item => display(ctx.root, item.uri)).join(', ')}.` : 'The project has no collections yet. op create_collection makes one.');
		}
		if (entry.error) {
			throw new Error(`${display(ctx.root, entry.uri)} could not be read: ${entry.error}`);
		}
		if (forWrite) {
			const refused = await this.writeRefusal(ctx, entry.uri);
			if (refused) {
				throw new Error(`Not changed: ${refused}.`);
			}
		}
		return entry;
	}

	private async run(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const confined = this.confined(ctx);
		// The test tools' ops (automation_*, perf_*, security_*): each answers undefined for an op that is not its own.
		const { automations, performance, security } = this.tools;
		const tool = (automations && await runHttpAutomationOp(op, args, ctx, automations, confined))
			?? (performance && await runHttpPerformanceOp(op, args, ctx, performance))
			?? (security && await runHttpSecurityOp(op, args, ctx, security));
		if (tool) {
			return tool;
		}
		switch (op) {
			case 'list': {
				const entries = await this.entries(ctx);
				if (!entries.length) {
					return ok('No collections in the project (no *.postman_collection.json, .http or .rest files). Send ad hoc with op send (method + url), or make one with op create_collection and add requests with op save_request.');
				}
				const lines: string[] = [];
				for (const entry of entries) {
					const collection = entry.collection;
					lines.push(`${display(ctx.root, entry.uri)}  "${collection.name}"  (${entry.error ? `unreadable: ${entry.error}` : `${collection.format === 'postman' ? 'postman' : '.http'}, ${httpRequestsOf(collection.items).length} requests`})`);
					const walk = (items: readonly IHttpItem[], indent: string) => {
						for (const item of items) {
							if (item.kind === 'folder') {
								lines.push(`${indent}${item.name}/`);
								walk(item.items, `${indent}  `);
							} else {
								lines.push(`${indent}${item.method}  ${item.name || '(unnamed)'}  ${item.url}`);
							}
						}
					};
					walk(collection.items, '  ');
				}
				return ok(lines.join('\n'));
			}
			case 'get': {
				const entry = await this.entry(args, ctx, false);
				const path = pathArg(args, 'request') ?? pathArg(args, 'item');
				if (!path) {
					const collection = entry.collection;
					return ok(JSON.stringify({
						path: display(ctx.root, entry.uri), name: collection.name, format: collection.format, description: collection.description,
						variables: Object.fromEntries(collection.variables.filter(row => row.enabled).map(row => [row.key, maskSecret(row.key, row.value)])),
						auth: describeAuth(collection.auth), pre_request: collection.scripts.preRequest, tests: collection.scripts.test,
						items: outline(collection.items),
					}, null, 2));
				}
				const item = findHttpItemByPath(entry.collection, path);
				if (!item) {
					return fail(`No "${path.join('/')}" in ${display(ctx.root, entry.uri)}. op list shows what it holds.`);
				}
				return ok(JSON.stringify(item.kind === 'request' ? describeRequest(item) : { folder: item.name, description: item.description, auth: describeAuth(item.auth), pre_request: item.scripts.preRequest, tests: item.scripts.test, items: outline(item.items) }, null, 2));
			}
			case 'envs': {
				const entries = await this.collections.environments(ctx.root, confined?.readable);
				if (!entries.length) {
					return ok('No environments (*.postman_environment.json or http-client.env.json). op set_env creates one.');
				}
				return ok([
					`Selected: ${this.http.environmentOf(ctx.root) ?? 'none'}`,
					...entries.map(entry => `${entry.environment.name}${entry.globals ? ' (globals)' : ''}  [${display(ctx.root, entry.uri)}]: ${entry.environment.variables.filter(row => row.enabled).map(row => `${row.key}=${row.secret ? '***' : maskSecret(row.key, row.value)}`).join(', ') || '(empty)'}`),
				].join('\n'));
			}
			case 'send': return this.send(args, ctx, confined);
			case 'run': {
				const entry = await this.entry(args, ctx, false);
				const environment = await this.environment(args, ctx, confined);
				const folderPath = pathArg(args, 'folder');
				const folder = folderPath ? findHttpItemByPath(entry.collection, folderPath) : undefined;
				if (folderPath && folder?.kind !== 'folder') {
					return fail(`No folder "${folderPath.join('/')}" in ${display(ctx.root, entry.uri)}.`);
				}
				this.reveal?.(entry.uri, undefined, ctx);
				const summary = await this.collections.run(entry.uri, {
					...(folder ? { folderId: folder.id } : {}),
					...(ctx.root ? { root: ctx.root } : {}),
					token: ctx.token,
					...(environment ? { environment } : {}),
					...(confined ? { confined } : {}),
					...(num(args, 'iterations') ? { iterations: num(args, 'iterations') } : {}),
					...(num(args, 'delay_ms') ? { delayMs: num(args, 'delay_ms') } : {}),
					...(args.stop_on_failure === true ? { stopOnFailure: true } : {}),
				});
				const lines = summary.results.map(result => {
					const exchange = result.exchange;
					const tests = exchange.tests ?? [];
					const failed = tests.filter(test => !test.passed && !test.skipped);
					const bad = !!exchange.error || !!exchange.scriptError || failed.length > 0;
					return [
						`${bad ? 'FAIL' : 'ok  '}  ${exchange.response?.status ?? '---'}  ${exchange.method} ${result.path.join('/')}  ${exchange.response ? `${exchange.response.durationMs}ms` : ''}${tests.length ? `  tests ${tests.length - failed.length}/${tests.length}` : ''}`,
						...(exchange.error ? [`      ${exchange.error}`] : []),
						...(exchange.scriptError ? [`      script: ${exchange.scriptError}`] : []),
						...failed.map(test => `      x ${test.name}: ${test.error ?? 'failed'}`),
					].join('\n');
				});
				const text = [`${summary.requests} requests, ${summary.passed} tests passed, ${summary.failed} failed, ${summary.errors} errors, ${summary.durationMs}ms${summary.stopped ? ' (stopped early)' : ''}`, ...lines].join('\n');
				return summary.failed || summary.errors ? fail(text) : ok(text);
			}
			case 'create_collection': {
				const name = str(args, 'name');
				if (!name) {
					return fail('create_collection needs name (and format: "postman" for folders, auth and scripts, or "http" for a plain .http file).');
				}
				const format = str(args, 'format') === 'http' ? 'http' : 'postman';
				if (ctx.confinement && ctx.root) {
					const refused = await this.writeRefusal(ctx, ctx.root);
					if (refused) {
						return fail(`Not created: ${refused}.`);
					}
				}
				const uri = await this.collections.createCollection(ctx.root, name, format);
				if (format === 'postman' && (args.variables || args.auth || str(args, 'description'))) {
					await this.collections.updateCollection(uri, collection => this.applyShared(collection, args));
				}
				this.reveal?.(uri, undefined, ctx);
				return ok(`Created ${display(ctx.root, uri)}. Add requests with op save_request (path, request, method, url...).`);
			}
			case 'update_collection': {
				const entry = await this.entry(args, ctx, true);
				await this.collections.updateCollection(entry.uri, collection => {
					if (str(args, 'name') && collection.format === 'postman') {
						collection.name = str(args, 'name')!;
					}
					this.applyShared(collection, args);
				});
				return ok(`Updated ${display(ctx.root, entry.uri)}.`);
			}
			case 'create_folder': {
				const entry = await this.entry(args, ctx, true);
				const path = pathArg(args, 'folder');
				if (!path) {
					return fail('create_folder needs folder (a name, or a path like "Users/Admin").');
				}
				const id = await this.ensureFolder(entry, path);
				if (args.auth || str(args, 'description') || str(args, 'pre_request') || str(args, 'tests')) {
					await this.collections.updateItem(entry.uri, id, item => item.kind === 'folder' && this.applyShared(item, args));
				}
				return ok(`Folder ${path.join('/')} is in ${display(ctx.root, entry.uri)}.`);
			}
			case 'save_request': {
				const entry = await this.entry(args, ctx, true);
				const path = pathArg(args, 'request');
				if (!path) {
					return fail('save_request needs request: its name, or a path like "Users/Create user" (folders are made as needed).');
				}
				const existing = findHttpItemByPath(entry.collection, path);
				if (existing && existing.kind !== 'request') {
					return fail(`"${path.join('/')}" is a folder.`);
				}
				let created = false;
				if (existing) {
					await this.collections.updateItem(entry.uri, existing.id, item => item.kind === 'request' && applyRequest(item, args));
				} else {
					const parent = path.length > 1 ? await this.ensureFolder(entry, path.slice(0, -1)) : undefined;
					const request = emptyHttpRequest(path[path.length - 1], entry.collection.format === 'postman' ? 'inherit' : 'none');
					applyRequest(request, args);
					if (!request.url) {
						return fail('A new request needs url (or curl).');
					}
					await this.collections.addItem(entry.uri, parent, request);
					created = true;
				}
				const newName = str(args, 'new_name');
				this.reveal?.(entry.uri, newName ? [...path.slice(0, -1), newName] : path, ctx);
				return ok(`${created ? 'Created' : 'Updated'} ${path.join('/')} in ${display(ctx.root, entry.uri)}. op send with path + request sends it.`);
			}
			case 'rename': {
				const entry = await this.entry(args, ctx, true);
				const item = this.item(entry, args);
				const name = str(args, 'new_name');
				if (!name) {
					return fail('rename needs new_name.');
				}
				await this.collections.updateItem(entry.uri, item.id, target => target.name = name);
				return ok(`Renamed to ${name}.`);
			}
			case 'duplicate': {
				const entry = await this.entry(args, ctx, true);
				const item = this.item(entry, args);
				const id = await this.collections.duplicateItem(entry.uri, item.id);
				return ok(`Duplicated as ${httpItemPath(entry.collection, id)?.join('/') ?? 'a copy'}.`);
			}
			case 'move': {
				const entry = await this.entry(args, ctx, true);
				const item = this.item(entry, args);
				const toRaw = str(args, 'to_path');
				let target = entry;
				if (toRaw) {
					target = await this.entry({ path: toRaw }, ctx, true);
				}
				const folderPath = pathArg(args, 'to_folder');
				const parent = folderPath ? await this.ensureFolder(target, folderPath) : undefined;
				await this.collections.moveItem(entry.uri, item.id, target.uri, parent, num(args, 'index'));
				return ok(`Moved to ${display(ctx.root, target.uri)}${folderPath ? `, ${folderPath.join('/')}` : ''}.`);
			}
			case 'delete': {
				const entry = await this.entry(args, ctx, true);
				const item = this.item(entry, args);
				await this.collections.removeItem(entry.uri, item.id);
				return ok(`Deleted ${item.name} from ${display(ctx.root, entry.uri)}.`);
			}
			case 'set_env': {
				const name = str(args, 'env') ?? str(args, 'name');
				if (!name) {
					return fail('set_env needs env (the environment\'s name), variables? {name: value, or null to remove} and use? (true selects it for sends).');
				}
				const changes = args.variables && typeof args.variables === 'object' && !Array.isArray(args.variables) ? args.variables as Record<string, unknown> : {};
				const entries = await this.collections.environments(ctx.root, confined?.readable);
				const existing = entries.find(entry => !entry.globals && entry.environment.name === name);
				const target = existing?.uri ?? ctx.root;
				if (target) {
					const refused = await this.writeRefusal(ctx, target);
					if (refused) {
						return fail(`Not changed: ${refused}.`);
					}
				}
				if (existing) {
					if (Object.keys(changes).length) {
						await this.collections.saveEnvironment(existing, name, mergeVariables(existing.environment.variables, changes));
					}
				} else {
					await this.collections.createEnvironment(ctx.root, name, mergeVariables([], changes));
				}
				if (args.use === true && !confined) {
					this.http.setEnvironment(name, ctx.root);
				}
				return ok(`${existing ? 'Updated' : 'Created'} the environment "${name}"${args.use === true && !confined ? ' and selected it' : ''}.`);
			}
			case 'import': {
				let text = str(args, 'text');
				let fileName: string | undefined;
				const from = str(args, 'file') ?? str(args, 'path');
				if (!text && from) {
					const uri = resolvePath(ctx.root, from);
					if (!uri || await confinedReadRefusal(ctx, uri)) {
						return fail(`This chat may not read ${from}.`);
					}
					text = (await this.fileService.readFile(uri)).value.toString();
					fileName = uri.path.split('/').pop();
				}
				if (!text) {
					return fail('import needs text (a Postman collection or environment, OpenAPI/Swagger JSON or YAML, a HAR, .http requests or a cURL command) or file (the path of a file holding one).');
				}
				if (ctx.confinement && ctx.root) {
					const refused = await this.writeRefusal(ctx, ctx.root);
					if (refused) {
						return fail(`Not imported: ${refused}.`);
					}
				}
				const result = await this.collections.importText(ctx.root, text, fileName);
				if (result.kind === 'unknown') {
					return fail(result.message);
				}
				if (result.kind === 'request' && result.request) {
					return ok(`${result.message} Save it with op save_request (pass the same curl plus path and request), or send it with op send.\n${JSON.stringify(describeRequest(result.request), null, 2)}`);
				}
				if (result.uri && result.kind === 'collection') {
					this.reveal?.(result.uri, undefined, ctx);
				}
				return ok(`${result.message}${result.uri ? ` File: ${display(ctx.root, result.uri)}.` : ''}`);
			}
			case 'export': {
				const entry = await this.entry(args, ctx, false);
				const format = str(args, 'format') === 'http' ? 'http' : str(args, 'format') === 'postman' ? 'postman' : entry.collection.format === 'postman' ? 'http' : 'postman';
				const text = this.collections.exportText(entry.uri, format);
				const to = str(args, 'to');
				if (to) {
					const uri = resolvePath(ctx.root, to);
					if (!uri) {
						return fail(`Cannot write ${to}.`);
					}
					const refused = await this.writeRefusal(ctx, uri);
					if (refused) {
						return fail(`Not written: ${refused}.`);
					}
					await this.fileService.writeFile(uri, VSBuffer.fromString(text));
					return ok(`Wrote ${display(ctx.root, uri)} (${format === 'postman' ? 'Postman collection v2.1' : '.http'}, ${text.length} characters).`);
				}
				return ok(text.length > MAX_EXPORT_CHARS ? `${text.slice(0, MAX_EXPORT_CHARS)}\n... (${text.length - MAX_EXPORT_CHARS} more characters; pass to: a file path to write it whole)` : text);
			}
			case 'snippet': {
				const entry = await this.entry(args, ctx, false);
				const request = this.item(entry, args);
				if (request.kind !== 'request') {
					return fail('snippet needs a request.');
				}
				const target = (str(args, 'language') ?? 'curl') as HttpSnippetTarget;
				if (!HTTP_SNIPPET_TARGETS.some(item => item.id === target)) {
					return fail(`language is one of: ${HTTP_SNIPPET_TARGETS.map(item => item.id).join(', ')}.`);
				}
				const ancestors = findHttpItem(entry.collection, request.id)?.ancestors ?? [];
				return ok(httpSnippet(target, httpWireRequest(request, ancestors, entry.collection).spec));
			}
		}
		return fail(`http has no op ${op}.`);
	}

	private item(entry: IHttpCollectionEntry, args: Readonly<Record<string, unknown>>): IHttpItem {
		const path = pathArg(args, 'request') ?? pathArg(args, 'folder') ?? pathArg(args, 'item');
		if (!path) {
			throw new Error('Name the request (request) or folder (folder), as a name or a path like "Users/Create user".');
		}
		const item = findHttpItemByPath(entry.collection, path);
		if (!item) {
			throw new Error(`No "${path.join('/')}" in the collection. op list shows what it holds.`);
		}
		return item;
	}

	/** The folder at `path`, made (with the folders above it) when it is not there. */
	private async ensureFolder(entry: IHttpCollectionEntry, path: readonly string[]): Promise<string> {
		let parent: string | undefined;
		let items: readonly IHttpItem[] = entry.collection.items;
		for (const name of path) {
			const found: IHttpItem | undefined = items.find(item => item.kind === 'folder' && item.name === name);
			if (found?.kind === 'folder') {
				parent = found.id;
				items = found.items;
				continue;
			}
			parent = await this.collections.addItem(entry.uri, parent, emptyHttpFolder(name));
			const made = findHttpItem(entry.collection, parent)?.item;
			items = made?.kind === 'folder' ? made.items : [];
		}
		return parent!;
	}

	/** What a collection and a folder share: description, auth, scripts, and (a collection's) variables. */
	private applyShared(target: IHttpCollection | IHttpFolder, args: Readonly<Record<string, unknown>>): void {
		if (typeof args.description === 'string') {
			target.description = args.description;
		}
		if (args.auth && typeof args.auth === 'object') {
			target.auth = authFrom(args.auth as Record<string, unknown>, target.auth);
		}
		if (typeof args.pre_request === 'string') {
			target.scripts.preRequest = args.pre_request;
		}
		if (typeof args.tests === 'string') {
			target.scripts.test = args.tests;
		}
		if ('variables' in target && args.variables && typeof args.variables === 'object' && !Array.isArray(args.variables)) {
			target.variables = mergeVariables(target.variables, args.variables as Record<string, unknown>);
		}
	}

	/** The environment a send or run uses: `env` when given (selected for the user too, unless the chat is sandboxed). */
	private async environment(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext, confined: IHttpConfinement | undefined): Promise<string | undefined> {
		const name = str(args, 'env');
		if (!name) {
			return undefined;
		}
		const entries = await this.collections.environments(ctx.root, confined?.readable);
		const names = [...new Set(entries.filter(entry => !entry.globals && !entry.shared).map(entry => entry.environment.name))];
		if (!names.includes(name)) {
			throw new Error(`No environment "${name}". Available: ${names.join(', ') || 'none'}.`);
		}
		// A sandboxed chat's pick is its send's alone: the user's next send keeps the user's environment.
		if (!confined && this.http.environmentOf(ctx.root) !== name) {
			this.http.setEnvironment(name, ctx.root);
		}
		return name;
	}

	private async send(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext, confined: IHttpConfinement | undefined): Promise<IIdeCapabilityResult> {
		const environment = await this.environment(args, ctx, confined);
		const path = pathArg(args, 'request') ?? pathArg(args, 'name');
		let request: IHttpRequest | undefined;
		let collection: URI | undefined;
		if (path) {
			const entries = str(args, 'path') || str(args, 'collection') ? [await this.entry(args, ctx, false)] : await this.entries(ctx);
			for (const entry of entries) {
				// By path, else by name anywhere in the collection (`.http` requests are named, not nested).
				const found = findHttpItemByPath(entry.collection, path) ?? (path.length === 1 ? httpRequestsOf(entry.collection.items).find(item => item.request.name === path[0])?.request : undefined);
				if (found?.kind === 'request') {
					request = found;
					collection = entry.uri;
					break;
				}
			}
			if (!request) {
				return fail(`No request "${path.join('/')}". op list shows them.`);
			}
		} else {
			const curl = str(args, 'curl');
			if (curl) {
				request = curlToRequest(curl);
				if (!request) {
					return fail('That cURL command could not be read.');
				}
			} else {
				const asked = str(args, 'protocol')?.toLowerCase();
				if (asked && !isHttpProtocol(asked)) {
					return fail(`Unknown protocol "${asked}". One of: http, graphql, soap, ai, mcp, grpc, ws, socketio, sse, mqtt.`);
				}
				const protocol = isHttpProtocol(asked) ? asked : undefined;
				const method = (str(args, 'method') ?? (protocol && protocol !== 'http' ? httpProtocolInfo(protocol).stream ? 'GET' : 'POST' : 'GET')).toUpperCase();
				const url = str(args, 'url');
				if (!url || !(HTTP_METHODS as readonly string[]).includes(method)) {
					return fail('send needs request (one from op list), or method + url, or curl.');
				}
				const rawHeaders = args.headers && typeof args.headers === 'object' ? Object.entries(args.headers as Record<string, unknown>).map(([key, value]) => [key, String(value)] as const) : [];
				const body = typeof args.body === 'string' ? args.body : args.body !== undefined ? JSON.stringify(args.body) : undefined;
				const headers = body && args.body !== undefined && typeof args.body !== 'string' && !rawHeaders.some(([key]) => key.toLowerCase() === 'content-type') ? [...rawHeaders, ['Content-Type', 'application/json'] as const] : rawHeaders;
				request = httpRequestFromSpec({ method, url, headers, ...(body !== undefined && protocol !== 'ws' && protocol !== 'socketio' && protocol !== 'mqtt' ? { body } : {}), line: 0 });
				if (protocol && protocol !== 'http') {
					// The body given stays; the kind's own fields come from the arguments below.
					const raw = request.body;
					convertHttpRequest(request, protocol);
					if (body !== undefined && protocol !== 'graphql') {
						request.body = { ...request.body, mode: 'raw', raw: body, language: raw.language };
					}
					request.headers = request.headers.filter(row => row.key.toLowerCase() !== 'soapaction' || row.value);
					applyProtocolFields(request, args);
				}
			}
		}
		const waitMs = num(args, 'wait_ms');
		const maxMessages = num(args, 'max_messages');
		const exchange = await this.collections.send(request, {
			...(collection ? { collection } : {}),
			...(ctx.root ? { root: ctx.root } : {}),
			token: ctx.token,
			...(num(args, 'timeout_ms') ? { timeoutMs: num(args, 'timeout_ms') } : {}),
			...(environment ? { environment } : {}),
			...(confined ? { confined } : {}),
			...(waitMs !== undefined || maxMessages !== undefined ? { stream: { ...(waitMs !== undefined ? { waitMs } : {}), ...(maxMessages !== undefined ? { maxMessages } : {}) } } : {}),
		});
		return describeExchange(exchange, !!confined);
	}
}

/** The kind's own fields of a request, from an agent's arguments: its messages and options. */
function applyProtocolFields(request: IHttpRequest, args: Readonly<Record<string, unknown>>): void {
	if (Array.isArray(args.messages)) {
		request.messages = args.messages.map((item): IHttpMessage | undefined => {
			if (typeof item === 'string') {
				return { body: item };
			}
			const message = record(item);
			if (!message) {
				return undefined;
			}
			const body = typeof message.body === 'string' ? message.body : message.body !== undefined ? JSON.stringify(message.body) : '';
			const target = typeof message.target === 'string' ? message.target : typeof message.event === 'string' ? message.event : typeof message.topic === 'string' ? message.topic : undefined;
			return { ...(target ? { target } : {}), body };
		}).filter((message): message is IHttpMessage => !!message);
	}
	const options: Record<string, string> = { ...request.options };
	const given = record(args.options) ?? {};
	for (const key of ['proto', 'subscribe', 'clientId', 'qos', 'path', 'auth']) {
		const value = given[key] ?? (key === 'proto' || key === 'subscribe' ? args[key] : undefined);
		if (value === null || value === '') {
			delete options[key];
		} else if (Array.isArray(value)) {
			options[key] = value.map(String).join('\n');
		} else if (value !== undefined) {
			options[key] = typeof value === 'string' ? value : JSON.stringify(value);
		}
	}
	if (Object.keys(options).length) {
		request.options = options;
	} else {
		delete request.options;
	}
	const graphql = record(args.graphql);
	if (graphql && request.protocol === 'graphql') {
		request.body.mode = 'graphql';
		request.body.graphqlQuery = typeof graphql.query === 'string' ? graphql.query : request.body.graphqlQuery;
		request.body.graphqlVariables = typeof graphql.variables === 'string' ? graphql.variables : graphql.variables !== undefined ? JSON.stringify(graphql.variables, null, 2) : request.body.graphqlVariables;
	}
}

function describeExchange(exchange: IHttpExchange, confined: boolean): IIdeCapabilityResult {
	const verb = httpRequestBadge(exchange);
	if (exchange.stream && exchange.response) {
		// A connection: what it said about itself, then every message in order.
		const lines = exchange.stream.map(entry => `${entry.direction === 'in' ? '<-' : entry.direction === 'out' ? '->' : entry.direction === 'error' ? '!!' : '--'} ${entry.target ? `[${entry.target}] ` : ''}${entry.binary ? '(binary, base64) ' : ''}${entry.data.length > 2000 ? `${entry.data.slice(0, 2000)}... (${entry.data.length - 2000} more characters)` : entry.data}`);
		const received = exchange.stream.filter(entry => entry.direction === 'in').length;
		const tests = exchange.tests ?? [];
		const failed = tests.filter(test => !test.passed && !test.skipped);
		const text = [
			`${verb} ${exchange.url}`,
			`${exchange.response.status}${exchange.response.statusText ? ` ${exchange.response.statusText}` : ''}  ${exchange.response.durationMs}ms  ${received} message${received === 1 ? '' : 's'} received`,
			...(tests.length ? [`tests: ${tests.length - failed.length}/${tests.length} passed`, ...tests.map(test => `  ${test.skipped ? '-' : test.passed ? 'ok' : 'x'} ${test.name}${test.error ? `: ${test.error}` : ''}`)] : []),
			...(exchange.scriptError ? [`error: ${exchange.scriptError}`] : []),
			'',
			...lines.slice(0, 200),
			...(lines.length > 200 ? [`... (${lines.length - 200} more lines)`] : []),
		].join('\n');
		return failed.length || exchange.scriptError ? fail(text) : ok(text);
	}
	if (exchange.error || !exchange.response) {
		return fail(`${verb} ${exchange.url}: ${[exchange.error, exchange.scriptError].filter(Boolean).join('; ') || 'no response'}`);
	}
	const response = exchange.response;
	const type = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
	let body = response.body;
	if (/json/.test(type) || /^\s*[[{]/.test(body)) {
		try {
			body = JSON.stringify(JSON.parse(body), null, 2);
		} catch { /* not JSON after all */ }
	}
	const headerLines = Object.entries(response.headers).filter(([key]) => !/^(date|connection|keep-alive|transfer-encoding|vary|server)$/i.test(key)).slice(0, 20).map(([key, value]) => `${key}: ${maskSecret(key, value)}`);
	const tests = exchange.tests ?? [];
	const failed = tests.filter(test => !test.passed && !test.skipped);
	const text = [
		`${exchange.method} ${exchange.url}`,
		`${response.status} ${response.statusText}  ${response.durationMs}ms  ${formatBytes(response.size)}`,
		...(confined && response.status >= 300 && response.status < 400 ? ['(Not followed: this chat runs in Volt\'s sandbox. Send the location to follow it; its host is judged by the chat\'s network rules.)'] : []),
		...(tests.length ? [`tests: ${tests.length - failed.length}/${tests.length} passed`, ...tests.map(test => `  ${test.skipped ? '-' : test.passed ? 'ok' : 'x'} ${test.name}${test.error ? `: ${test.error}` : ''}`)] : []),
		...(exchange.scriptError ? [`script error: ${exchange.scriptError}`] : []),
		...(exchange.logs?.length ? ['console:', ...exchange.logs.slice(0, 20).map(log => `  ${log.text}`)] : []),
		...headerLines,
		'',
		body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n… (${body.length - MAX_BODY_CHARS} more characters)` : body,
	].join('\n');
	return failed.length || exchange.scriptError ? fail(text) : ok(text);
}

/** `"Users/Create user"` or `["Users", "Create user"]` as a name path. */
function pathArg(args: Readonly<Record<string, unknown>>, key: string): string[] | undefined {
	const value = args[key];
	if (Array.isArray(value)) {
		const parts = value.filter((part): part is string => typeof part === 'string' && part.trim() !== '');
		return parts.length ? parts : undefined;
	}
	if (typeof value !== 'string' || !value.trim()) {
		return undefined;
	}
	// A name with a slash in it (a request named after its route) is written with `\/`.
	return value.split(/(?<!\\)\//).map(part => part.replace(/\\\//g, '/').trim()).filter(Boolean);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function rowsFrom(value: unknown, before: readonly IHttpKeyValue[]): IHttpKeyValue[] | undefined {
	const map = record(value);
	if (!map) {
		return undefined;
	}
	return Object.entries(map).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => ({ key, value: typeof item === 'string' ? item : JSON.stringify(item), enabled: true, ...(before.find(row => row.key === key)?.description ? { description: before.find(row => row.key === key)!.description } : {}) }));
}

function mergeVariables(before: readonly IHttpKeyValue[], changes: Record<string, unknown>): IHttpKeyValue[] {
	const rows = before.map(row => ({ ...row }));
	for (const [key, value] of Object.entries(changes)) {
		const at = rows.findIndex(row => row.key === key);
		if (value === null || value === undefined) {
			if (at >= 0) {
				rows.splice(at, 1);
			}
			continue;
		}
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		if (at >= 0) {
			rows[at] = { ...rows[at], value: text, enabled: true };
		} else {
			rows.push({ key, value: text, enabled: true });
		}
	}
	return rows;
}

function authFrom(value: Record<string, unknown>, before: IHttpRequest['auth']): IHttpRequest['auth'] {
	const text = (key: string) => typeof value[key] === 'string' ? value[key] as string : undefined;
	const raw = (text('type') ?? before.type).toLowerCase().replace(/[\s_.()-]/g, '');
	const type: HttpAuthType = Object.prototype.hasOwnProperty.call(AUTH_TYPE_ALIASES, raw) ? AUTH_TYPE_ALIASES[raw] : 'none';
	if (type === 'jwt' || type === 'digest' || type === 'oauth1' || type === 'hawk' || type === 'awsv4' || type === 'ntlm' || type === 'edgegrid' || type === 'asap' || type === 'oauth2') {
		// Every other field is one of the type's own, under Postman's key name: what is not named stays.
		const params: Record<string, string> = type === before.type ? { ...before.params } : {};
		for (const [key, field] of Object.entries(value)) {
			if (key === 'type' || field === undefined || (type === 'oauth2' && (key === 'token' || key === 'accessToken' || key === 'access_token'))) {
				continue;
			}
			params[key] = field === null ? '' : typeof field === 'string' ? field : typeof field === 'object' ? JSON.stringify(field, null, 2) : String(field);
		}
		return {
			...emptyHttpAuth(type),
			...(before.raw !== undefined && type === before.type ? { raw: before.raw } : {}),
			token: type === 'oauth2' ? text('token') ?? text('accessToken') ?? text('access_token') ?? (before.type === 'oauth2' || before.type === 'bearer' ? before.token : '') : '',
			params,
		};
	}
	return {
		...emptyHttpAuth(type),
		...(before.raw !== undefined && type === before.type ? { raw: before.raw } : {}),
		token: text('token') ?? before.token,
		username: text('username') ?? text('user') ?? before.username,
		password: text('password') ?? before.password,
		keyName: text('key') ?? before.keyName,
		keyValue: text('value') ?? before.keyValue,
		keyIn: text('in') === 'query' ? 'query' : text('in') === 'header' ? 'header' : before.keyIn,
	};
}

/** The names an agent may give a type, lower case without spaces or punctuation. */
const AUTH_TYPE_ALIASES: Readonly<Record<string, HttpAuthType>> = {
	inherit: 'inherit', inheritauthfromparent: 'inherit', none: 'none', noauth: 'none', other: 'other',
	bearer: 'bearer', bearertoken: 'bearer', basic: 'basic', basicauth: 'basic', apikey: 'apikey',
	oauth2: 'oauth2', oauth20: 'oauth2', jwt: 'jwt', jwtbearer: 'jwt', digest: 'digest', digestauth: 'digest',
	oauth1: 'oauth1', oauth10: 'oauth1', hawk: 'hawk', hawkauthentication: 'hawk',
	awsv4: 'awsv4', aws: 'awsv4', awssignature: 'awsv4', awssigv4: 'awsv4', sigv4: 'awsv4',
	ntlm: 'ntlm', ntlmauthentication: 'ntlm', edgegrid: 'edgegrid', akamai: 'edgegrid', akamaiedgegrid: 'edgegrid',
	asap: 'asap', asapatlassian: 'asap',
};

/** Applies an op's fields to a request; what the op does not name stays as it was. */
function applyRequest(request: IHttpRequest, args: Readonly<Record<string, unknown>>): void {
	const curl = str(args, 'curl');
	if (curl) {
		const parsed = curlToRequest(curl);
		if (!parsed) {
			throw new Error('That cURL command could not be read.');
		}
		Object.assign(request, { ...parsed, id: request.id, name: request.name, description: request.description, scripts: request.scripts, extra: request.extra, line: request.line, auth: parsed.auth.type === 'none' ? request.auth : parsed.auth });
	}
	const newName = str(args, 'new_name');
	if (newName) {
		request.name = newName;
	}
	const protocol = str(args, 'protocol')?.toLowerCase();
	if (protocol) {
		if (!isHttpProtocol(protocol)) {
			throw new Error(`Unknown protocol "${protocol}". One of: http, graphql, soap, ai, mcp, grpc, ws, socketio, sse, mqtt.`);
		}
		convertHttpRequest(request, protocol);
	}
	if (request.protocol && request.protocol !== 'http') {
		applyProtocolFields(request, args);
	}
	const method = str(args, 'method');
	if (method) {
		request.method = method.toUpperCase();
	}
	const url = str(args, 'url');
	if (url) {
		syncHttpRequestUrl(request, url);
	}
	if (typeof args.description === 'string') {
		request.description = args.description;
	}
	const headers = rowsFrom(args.headers, request.headers);
	if (headers) {
		request.headers = headers;
	}
	const pathVariables = record(args.path_variables);
	if (pathVariables) {
		request.pathVariables = request.pathVariables.map(row => pathVariables[row.key] !== undefined ? { ...row, value: String(pathVariables[row.key]) } : row);
	}
	const mode = str(args, 'body_mode')?.toLowerCase();
	const form = rowsFrom(args.form, mode === 'formdata' ? request.body.formdata : request.body.urlencoded);
	const graphql = record(args.graphql);
	if (graphql) {
		request.body.mode = 'graphql';
		request.body.graphqlQuery = typeof graphql.query === 'string' ? graphql.query : request.body.graphqlQuery;
		request.body.graphqlVariables = graphql.variables === undefined ? request.body.graphqlVariables : typeof graphql.variables === 'string' ? graphql.variables : JSON.stringify(graphql.variables, null, 2);
	} else if (form) {
		if (mode === 'formdata') {
			request.body.mode = 'formdata';
			request.body.formdata = form;
		} else {
			request.body.mode = 'urlencoded';
			request.body.urlencoded = form;
		}
	} else if (args.body !== undefined) {
		if (args.body === null || args.body === '') {
			request.body.mode = 'none';
			request.body.raw = '';
		} else {
			request.body.mode = 'raw';
			request.body.raw = typeof args.body === 'string' ? args.body : JSON.stringify(args.body, null, 2);
			request.body.language = mode === 'xml' ? 'xml' : mode === 'text' ? 'text' : mode === 'html' ? 'html' : mode === 'javascript' ? 'javascript' : typeof args.body !== 'string' || /^\s*[[{]/.test(request.body.raw) ? 'json' : 'text';
		}
	} else if (mode === 'none') {
		request.body.mode = 'none';
	}
	const auth = record(args.auth);
	if (auth) {
		request.auth = authFrom(auth, request.auth);
	}
	if (typeof args.pre_request === 'string') {
		request.scripts.preRequest = args.pre_request;
	}
	if (typeof args.tests === 'string') {
		request.scripts.test = args.tests;
	}
}

/** The auth fields (Postman's key names) that hold a secret. */
const AUTH_SECRET_PARAMS: ReadonlySet<string> = new Set(['password', 'secret', 'privateKey', 'consumerSecret', 'token', 'tokenSecret', 'authKey', 'secretKey', 'sessionToken', 'accessToken', 'clientToken', 'clientSecret', 'refreshToken', 'code_verifier']);

/** A secret as an agent may see it: a `{{variable}}` by name, a value masked. */
function maskAuthSecret(value: string): string {
	return /^\{\{[^{}]+\}\}$/.test(value.trim()) ? value : maskSecret('secret', value);
}

function describeAuth(auth: IHttpRequest['auth']): Record<string, string> {
	const params = () => Object.fromEntries(Object.entries(auth.params ?? {}).filter(([, value]) => value !== '').map(([key, value]) => [key, AUTH_SECRET_PARAMS.has(key) ? maskAuthSecret(value) : value]));
	switch (auth.type) {
		case 'bearer': return { type: auth.type, token: maskSecret('token', auth.token) };
		case 'oauth2': return { type: auth.type, token: maskSecret('token', auth.token), ...params() };
		case 'basic': return { type: 'basic', username: auth.username, password: maskSecret('password', auth.password) };
		case 'apikey': return { type: 'apikey', key: auth.keyName, value: maskSecret('apikey', auth.keyValue), in: auth.keyIn };
		case 'jwt': case 'digest': case 'oauth1': case 'hawk': case 'awsv4': case 'ntlm': case 'edgegrid': case 'asap':
			return { type: auth.type, ...params() };
		default: return { type: auth.type };
	}
}

function describeRequest(request: IHttpRequest): Record<string, unknown> {
	const body = request.body;
	return {
		name: request.name,
		...(request.protocol && request.protocol !== 'http' ? { protocol: request.protocol } : {}),
		method: request.method,
		url: request.url,
		...(request.messages?.length ? { messages: request.messages } : {}),
		...(request.options && Object.keys(request.options).length ? { options: request.options } : {}),
		...(request.description ? { description: request.description } : {}),
		...(request.pathVariables.length ? { path_variables: Object.fromEntries(request.pathVariables.map(row => [row.key, row.value])) } : {}),
		headers: Object.fromEntries(request.headers.filter(row => row.enabled).map(row => [row.key, maskSecret(row.key, row.value)])),
		body_mode: body.mode === 'raw' ? body.language : body.mode,
		...(body.mode === 'raw' ? { body: body.raw } : {}),
		...(body.mode === 'urlencoded' ? { form: Object.fromEntries(body.urlencoded.filter(row => row.enabled).map(row => [row.key, row.value])) } : {}),
		...(body.mode === 'formdata' ? { form: Object.fromEntries(body.formdata.filter(row => row.enabled).map(row => [row.key, row.type === 'file' ? `@${row.value}` : row.value])) } : {}),
		...(body.mode === 'graphql' ? { graphql: { query: body.graphqlQuery, variables: body.graphqlVariables } } : {}),
		...(body.mode === 'binary' ? { file: body.binaryPath } : {}),
		auth: describeAuth(request.auth),
		...(request.scripts.preRequest.trim() ? { pre_request: request.scripts.preRequest } : {}),
		...(request.scripts.test.trim() ? { tests: request.scripts.test } : {}),
	};
}

function outline(items: readonly IHttpItem[]): unknown[] {
	return items.map(item => item.kind === 'folder' ? { folder: item.name, items: outline(item.items) } : `${httpRequestBadge(item)} ${item.name} ${item.url}`);
}

function formatBytes(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}
