/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MenuRegistry } from '../../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IExtensionService } from '../../../../../services/extensions/common/extensions.js';
import { HTTP_METHODS, IHttpRequestSpec, maskSecret } from '../../../../../services/voltRuntime/common/ide/httpFile.js';
import { IVoltHttpService } from '../../../../voltHttp/browser/voltHttpService.js';
import { display, fail, IIdeCapability, IIdeCapabilityContext, IIdeCapabilityResult, num, ok, str } from './capability.js';

const MAX_BODY_CHARS = 6_000;

/** HTTP requests through the HTTP client's service: the same history, environments and chaining the user's tab has. */
export class HttpCapability implements IIdeCapability {

	readonly id = 'http';

	constructor(private readonly http: IVoltHttpService) { }

	async invoke(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		switch (op) {
			case 'list': {
				const files = await this.http.index();
				const lines = files.flatMap(file => [`${display(ctx.root, file.uri)}`, ...file.requests.map(request => `  ${request.name ?? '(unnamed)'}  ${request.method} ${request.url}  :${request.line}`)]);
				return ok(lines.length ? lines.join('\n') : 'No .http or .rest files in the workspace. Send ad hoc with method + url, or create requests.http.');
			}
			case 'envs': {
				const envs = await this.http.environments();
				const names = Object.keys(envs);
				if (!names.length) {
					return ok('No environments (http-client.env.json).');
				}
				return ok([`Selected: ${this.http.environment ?? 'none'}`, ...names.map(name => `${name}: ${Object.entries(envs[name]).map(([key, value]) => `${key}=${maskSecret(key, value)}`).join(', ')}`)].join('\n'));
			}
			case 'send': {
				const envName = str(args, 'env');
				if (envName && envName !== this.http.environment) {
					const envs = await this.http.environments();
					if (!envs[envName]) {
						return fail(`No environment "${envName}". Available: ${Object.keys(envs).join(', ') || 'none'}.`);
					}
					this.http.setEnvironment(envName);
				}
				const name = str(args, 'name');
				let request: IHttpRequestSpec | undefined;
				let source;
				if (name) {
					for (const file of await this.http.index()) {
						const found = file.requests.find(item => item.name === name);
						if (found) {
							request = found;
							source = file.uri;
							break;
						}
					}
					if (!request) {
						return fail(`No request named "${name}". op list shows them.`);
					}
				} else {
					const method = (str(args, 'method') ?? 'GET').toUpperCase();
					const url = str(args, 'url');
					if (!url || !(HTTP_METHODS as readonly string[]).includes(method)) {
						return fail('send needs name, or method + url.');
					}
					const rawHeaders = args.headers && typeof args.headers === 'object' ? Object.entries(args.headers as Record<string, unknown>).map(([key, value]) => [key, String(value)] as const) : [];
					const body = typeof args.body === 'string' ? args.body : args.body !== undefined ? JSON.stringify(args.body) : undefined;
					const headers = body && args.body !== undefined && typeof args.body !== 'string' && !rawHeaders.some(([key]) => key.toLowerCase() === 'content-type') ? [...rawHeaders, ['Content-Type', 'application/json'] as const] : rawHeaders;
					request = { method, url, headers, ...(body !== undefined ? { body } : {}), line: 0 };
				}
				const exchange = await this.http.send(request, { ...(source ? { source } : {}), token: ctx.token, ...(num(args, 'timeout_ms') ? { timeoutMs: num(args, 'timeout_ms') } : {}) });
				if (exchange.error || !exchange.response) {
					return fail(`${exchange.method} ${exchange.url}: ${exchange.error ?? 'no response'}`);
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
				return ok([
					`${exchange.method} ${exchange.url}`,
					`${response.status} ${response.statusText}  ${response.durationMs}ms  ${formatBytes(response.size)}`,
					...headerLines,
					'',
					body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n\u2026 (${body.length - MAX_BODY_CHARS} more characters)` : body,
				].join('\n'));
			}
		}
		return fail(`http has no op ${op}.`);
	}
}

/** Installed extensions and the commands they (and the editor) offer; running one needs the user's yes. */
export class ExtensionsCapability implements IIdeCapability {

	readonly id = 'extensions';

	constructor(
		private readonly extensionService: IExtensionService,
		private readonly commandService: ICommandService,
	) { }

	async invoke(op: string, args: Readonly<Record<string, unknown>>, _ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		switch (op) {
			case 'list': {
				const query = str(args, 'query')?.toLowerCase();
				const extensions = this.extensionService.extensions.filter(extension => !extension.isBuiltin || query).filter(extension => !query || `${extension.identifier.value} ${extension.displayName ?? ''} ${extension.description ?? ''}`.toLowerCase().includes(query));
				const lines = extensions.slice(0, 60).map(extension => {
					const contributes = Object.keys(extension.contributes ?? {}).slice(0, 6).join(', ');
					return `${extension.identifier.value}  ${extension.displayName ?? extension.name}${contributes ? `  (${contributes})` : ''}`;
				});
				return ok(lines.length ? lines.join('\n') : 'No matching extensions.');
			}
			case 'commands': {
				const query = str(args, 'query')?.toLowerCase();
				if (!query) {
					return fail('commands needs query.');
				}
				const titles = new Map<string, string>();
				for (const [id, command] of MenuRegistry.getCommands()) {
					const title = typeof command.title === 'string' ? command.title : command.title.value;
					const category = command.category ? (typeof command.category === 'string' ? command.category : command.category.value) : '';
					titles.set(id, category ? `${category}: ${title}` : title);
				}
				const matches = [...CommandsRegistry.getCommands().keys()].filter(id => !id.startsWith('_')).filter(id => id.toLowerCase().includes(query) || titles.get(id)?.toLowerCase().includes(query)).slice(0, 40);
				return ok(matches.length ? matches.map(id => `${id}${titles.get(id) ? `  ${titles.get(id)}` : ''}`).join('\n') : `No commands match "${query}".`);
			}
			case 'run': {
				const command = str(args, 'command');
				if (!command || !CommandsRegistry.getCommand(command)) {
					return fail(`No command ${command ?? '(missing)'}. Find one with op commands.`);
				}
				const commandArgs = Array.isArray(args.args) ? args.args : [];
				const result = await this.commandService.executeCommand(command, ...commandArgs);
				const text = result === undefined ? '' : typeof result === 'string' ? result : safeJson(result);
				return ok(`Ran ${command}.${text ? `\n${text.slice(0, 4_000)}` : ''}`);
			}
		}
		return fail(`extensions has no op ${op}.`);
	}
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 1) ?? '';
	} catch {
		return String(value);
	}
}

function formatBytes(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}
