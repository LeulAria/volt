/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IPathService } from '../../../path/common/pathService.js';
import {
	EMPTY_HOOK_RESULT, hookMatches, hookPayload, hookToolInput, hookToolName, interpretHookAnswer, isBlockingEvent, isMcpTool, IVoltHookAnswer, IVoltHookDefinition,
	IVoltHookExecution, IVoltHookFileContext, IVoltHookResult, IVoltHookRunContext, IVoltHooksService, mcpParts, parseHookFile, VoltHookEvent, VoltHookProtocol, voltToolArgs,
} from '../../common/hooks/voltHooks.js';
import { IToolContext, IToolResult, IVoltTool } from '../../common/tools/tool.js';

export const VOLT_HOOKS_ENABLED_SETTING = 'volt.agent.hooks.enabled';
export const VOLT_HOOKS_THIRD_PARTY_SETTING = 'volt.agent.hooks.thirdParty';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'voltAgentHooks',
	title: localize('voltHooks.title', "Volt Agent Hooks"),
	type: 'object',
	properties: {
		[VOLT_HOOKS_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltHooks.enabled', "Run hooks from `.volt/hooks.json` (in the project and in the home folder) around the agent's tool calls, prompts and stops. Project hooks only run in trusted workspaces."),
		},
		[VOLT_HOOKS_THIRD_PARTY_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltHooks.thirdParty', "Also run hooks configured for Claude Code (`.claude/settings.json`) and Cursor (`.cursor/hooks.json`), and the hooks of installed plugins, when Volt's own agent works."),
		},
	},
});

/**
 * Hook definitions are kept until a hook file or plugin folder changes (file events, or a write
 * through the editor). The age limit only catches edits outside Volt to folders nothing watches.
 */
const CACHE_TTL_MS = 120_000;
const MAX_EXECUTIONS = 200;
const OUTPUT_CHARS = 20_000;

/** What a hook's stdout/stderr may show in the log. */
function firstLine(text: string, max = 300): string | undefined {
	const line = text.trim().split('\n').find(candidate => candidate.trim())?.trim();
	return line ? (line.length > max ? `${line.slice(0, max - 1)}…` : line) : undefined;
}

function clipText(text: string, max = 32_000): string {
	return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

/** Quotes for the user's POSIX shell. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class VoltHooksService extends Disposable implements IVoltHooksService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeExecutions = this._register(new Emitter<void>());
	readonly onDidChangeExecutions = this._onDidChangeExecutions.event;

	private log: IVoltHookExecution[] = [];
	private readonly cache = new Map<string, { at: number; value: Promise<readonly IVoltHookDefinition[]> }>();
	/** Environment a `sessionStart` hook asked for, per chat. */
	private readonly sessionEnv = new Map<string, Record<string, string>>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VOLT_HOOKS_ENABLED_SETTING) || e.affectsConfiguration(VOLT_HOOKS_THIRD_PARTY_SETTING)) {
				this.cache.clear();
			}
		}));
		this._register(this.trust.onDidChangeTrust(() => this.cache.clear()));
		this._register(this.fileService.onDidFilesChange(e => {
			if (this.cache.size && (e.rawUpdated.some(isHookFile) || e.rawAdded.some(isHookFile) || e.rawDeleted.some(isHookFile))) {
				this.cache.clear();
			}
		}));
		// Saves and deletes through Volt itself, also in folders the file watcher does not cover (home).
		this._register(this.fileService.onDidRunOperation(e => {
			if (this.cache.size && (isHookFile(e.resource) || (e.target && isHookFile(e.target.resource)))) {
				this.cache.clear();
			}
		}));
	}

	get executions(): readonly IVoltHookExecution[] {
		return this.log;
	}

	clearExecutions(): void {
		if (this.log.length) {
			this.log = [];
			this._onDidChangeExecutions.fire();
		}
	}

	private get enabled(): boolean {
		return this.configurationService.getValue<boolean>(VOLT_HOOKS_ENABLED_SETTING) !== false;
	}

	//#region Configuration

	definitions(root: string | undefined): Promise<readonly IVoltHookDefinition[]> {
		if (!this.enabled) {
			return Promise.resolve([]);
		}
		const key = root ?? '';
		const cached = this.cache.get(key);
		if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
			return cached.value;
		}
		const value = this.load(root).catch(err => {
			this.logService.warn('[volt-hooks] could not read hook configuration', err);
			return [] as readonly IVoltHookDefinition[];
		});
		this.cache.set(key, { at: Date.now(), value });
		return value;
	}

	private async load(root: string | undefined): Promise<readonly IVoltHookDefinition[]> {
		const thirdParty = this.configurationService.getValue<boolean>(VOLT_HOOKS_THIRD_PARTY_SETTING) !== false;
		const home = await this.pathService.userHome().catch(() => undefined);
		const sources: { file: URI; context: IVoltHookFileContext }[] = [];
		const add = (file: URI, context: Omit<IVoltHookFileContext, 'file'>) => sources.push({ file, context: { ...context, file: file.fsPath } });
		const rootUri = root ? URI.file(root) : undefined;
		const rootName = rootUri ? rootUri.path.split('/').filter(Boolean).pop() ?? root! : '';

		// The plugin scan and the trust check do not depend on each other.
		const [plugins, trusted] = await Promise.all([
			home ? this.pluginRoots(home, thirdParty) : Promise.resolve([]),
			rootUri ? this.isTrusted(rootUri) : Promise.resolve(false),
		]);

		if (home) {
			add(joinPath(home, '.volt', 'hooks.json'), { scope: 'user', origin: 'volt', cwd: joinPath(home, '.volt').fsPath, label: 'Volt User' });
			if (thirdParty) {
				add(joinPath(home, '.cursor', 'hooks.json'), { scope: 'user', origin: 'cursor', cwd: joinPath(home, '.cursor').fsPath, label: 'Cursor User' });
				add(joinPath(home, '.claude', 'settings.json'), { scope: 'user', origin: 'claude', cwd: root, label: 'Claude User' });
			}
			for (const plugin of plugins) {
				for (const file of [joinPath(plugin.root, 'hooks', 'hooks.json'), joinPath(plugin.root, 'hooks.json')]) {
					add(file, { scope: 'plugin', origin: plugin.origin, cwd: root, pluginRoot: plugin.root.fsPath, label: rootName ? `${rootName} / ${plugin.name}` : plugin.name });
				}
			}
		}
		// A project's own hooks are code from the repository: only a trusted folder runs them.
		if (rootUri && trusted) {
			add(joinPath(rootUri, '.volt', 'hooks.json'), { scope: 'workspace', origin: 'volt', cwd: root, label: rootName });
			if (thirdParty) {
				add(joinPath(rootUri, '.cursor', 'hooks.json'), { scope: 'workspace', origin: 'cursor', cwd: root, label: `${rootName} / Cursor` });
				add(joinPath(rootUri, '.claude', 'settings.json'), { scope: 'workspace', origin: 'claude', cwd: root, label: `${rootName} / Claude` });
				add(joinPath(rootUri, '.claude', 'settings.local.json'), { scope: 'workspace', origin: 'claude', cwd: root, label: `${rootName} / Claude (local)` });
			}
		}
		const parsed = await Promise.all(sources.map(async source => parseHookFile(await this.readJson(source.file), source.context)));
		return parsed.flat();
	}

	private async isTrusted(root: URI): Promise<boolean> {
		try {
			return (await this.trust.getUriTrustInfo(root)).trusted;
		} catch {
			return this.trust.isWorkspaceTrusted();
		}
	}

	/** Installed plugins that may ship hooks: Volt's own always; Claude Code's and Cursor's with third-party hooks on. */
	private async pluginRoots(home: URI, thirdParty: boolean): Promise<{ root: URI; name: string; origin: IVoltHookDefinition['origin'] }[]> {
		// Every source is scanned at once; the order stays Volt's, Claude Code's, Cursor's.
		const [volt, claude, cursor] = await Promise.all([
			this.children(joinPath(home, '.volt', 'plugins')),
			thirdParty ? this.claudePluginRoots(home) : Promise.resolve([]),
			thirdParty ? this.cursorPluginRoots(home) : Promise.resolve([]),
		]);
		return [
			...volt.filter(child => child.isDirectory).map(plugin => ({ root: plugin.resource, name: plugin.name, origin: 'volt' as const })),
			...claude,
			...cursor,
		];
	}

	private async claudePluginRoots(home: URI): Promise<{ root: URI; name: string; origin: IVoltHookDefinition['origin'] }[]> {
		const [installed, settings] = await Promise.all([
			this.readJson(joinPath(home, '.claude', 'plugins', 'installed_plugins.json')),
			this.readJson(joinPath(home, '.claude', 'settings.json')),
		]);
		const roots: { root: URI; name: string; origin: IVoltHookDefinition['origin'] }[] = [];
		const enabled = ((settings as { enabledPlugins?: Record<string, unknown> } | undefined)?.enabledPlugins ?? {}) as Record<string, unknown>;
		for (const [key, entries] of Object.entries((installed as { plugins?: Record<string, unknown> } | undefined)?.plugins ?? {})) {
			if (enabled[key] === false || !Array.isArray(entries)) {
				continue;
			}
			const entry = entries.find(candidate => (candidate as { scope?: unknown }).scope !== 'project') as { installPath?: unknown } | undefined;
			if (typeof entry?.installPath === 'string') {
				roots.push({ root: URI.file(entry.installPath), name: key.split('@')[0], origin: 'claude' });
			}
		}
		return roots;
	}

	/** The newest download of each Cursor plugin; marketplaces and plugins are read in parallel. */
	private async cursorPluginRoots(home: URI): Promise<{ root: URI; name: string; origin: IVoltHookDefinition['origin'] }[]> {
		const marketplaces = (await this.children(joinPath(home, '.cursor', 'plugins', 'cache'))).filter(child => child.isDirectory);
		const found = await Promise.all(marketplaces.map(async marketplace => {
			const plugins = (await this.children(marketplace.resource)).filter(child => child.isDirectory);
			return Promise.all(plugins.map(async plugin => {
				const versions = (await this.children(plugin.resource, true)).filter(child => child.isDirectory).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
				return versions[0] ? [{ root: versions[0].resource, name: plugin.name, origin: 'cursor' as const }] : [];
			}));
		}));
		return found.flat(2);
	}

	private async children(dir: URI, metadata = false): Promise<IFileStat[]> {
		try {
			return (await this.fileService.resolve(dir, { resolveMetadata: metadata })).children ?? [];
		} catch {
			return [];
		}
	}

	private async readJson(file: URI): Promise<unknown> {
		try {
			const text = (await this.fileService.readFile(file, { limits: { size: 1024 * 1024 } })).value.toString();
			return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
		} catch {
			return undefined;
		}
	}

	//#endregion

	//#region Running

	async run(event: VoltHookEvent, context: IVoltHookRunContext, fields: Record<string, unknown> | ((protocol: VoltHookProtocol) => Record<string, unknown>), toolName?: string): Promise<IVoltHookResult> {
		const definitions = (await this.definitions(context.root)).filter(definition => definition.event === event && hookMatches(definition, toolName));
		if (!definitions.length) {
			return EMPTY_HOOK_RESULT;
		}
		const contexts: string[] = [];
		let updatedInput: Record<string, unknown> | undefined;
		let followup: string | undefined;
		let userMessage: string | undefined;
		let env: Record<string, string> | undefined;
		for (const definition of definitions) {
			const base = typeof fields === 'function' ? fields(definition.protocol) : fields;
			// A rewrite by an earlier hook is what the next one sees.
			const input = updatedInput && base.tool_input && typeof base.tool_input === 'object' ? { ...base, tool_input: { ...(base.tool_input as object), ...updatedInput } } : base;
			const answer = await this.execute(definition, hookPayload(definition, context, input), context, toolName);
			if (answer.block !== undefined) {
				return { blocked: answer.block, userMessage: answer.userMessage, context: contexts };
			}
			if (answer.stopRun) {
				return { stopRun: answer.stopRun, userMessage: answer.userMessage, context: contexts };
			}
			if (answer.updatedInput) {
				updatedInput = { ...(updatedInput ?? {}), ...answer.updatedInput };
			}
			if (answer.context) {
				contexts.push(answer.context);
			}
			if (answer.followup) {
				followup = followup ? `${followup}\n\n${answer.followup}` : answer.followup;
			}
			if (answer.userMessage) {
				userMessage = answer.userMessage;
			}
			if (answer.env) {
				env = { ...(env ?? {}), ...answer.env };
			}
		}
		if (env && event === 'sessionStart') {
			this.sessionEnv.set(context.sessionId, { ...(this.sessionEnv.get(context.sessionId) ?? {}), ...env });
		}
		return { context: contexts, updatedInput, followup, userMessage, env };
	}

	private async execute(definition: IVoltHookDefinition, payload: Record<string, unknown>, context: IVoltHookRunContext, toolName: string | undefined): Promise<IVoltHookAnswer> {
		const id = `hook-${generateUuid().slice(0, 8)}`;
		const json = JSON.stringify(payload);
		const project = context.root ?? context.cwd ?? '';
		const env: Record<string, string> = {
			...(this.sessionEnv.get(context.sessionId) ?? {}),
			VOLT_HOOK_EVENT: definition.event,
			VOLT_PROJECT_DIR: project,
			CLAUDE_PROJECT_DIR: project,
			CURSOR_PROJECT_DIR: project,
			...(definition.pluginRoot ? { CLAUDE_PLUGIN_ROOT: definition.pluginRoot, CURSOR_PLUGIN_ROOT: definition.pluginRoot } : {}),
		};
		let command: string;
		let inputFile: URI | undefined;
		if (isWindows) {
			// cmd.exe cannot pipe an environment variable safely: hand the event over in a file.
			const home = await this.pathService.userHome();
			inputFile = joinPath(home, '.volt', 'tmp', `${id}.json`);
			await this.fileService.writeFile(inputFile, VSBuffer.fromString(json));
			command = `type "${inputFile.fsPath}" | ${definition.command}`;
		} else {
			env.VOLT_HOOK_INPUT = json;
			command = `printf '%s' "$VOLT_HOOK_INPUT" | (\n${definition.command}\n)`;
		}
		const startedAt = Date.now();
		let exitCode: number | null = null;
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let failed: string | undefined;
		try {
			const result = await this.stdio.exec({
				id,
				command,
				cwd: definition.cwd ?? (project || undefined),
				env,
				timeoutMs: definition.timeoutMs,
				inlineChars: OUTPUT_CHARS,
			});
			exitCode = result.exitCode;
			stdout = result.stdout;
			stderr = result.stderr;
			timedOut = result.timedOut;
		} catch (err) {
			failed = err instanceof Error ? err.message : String(err);
		} finally {
			if (inputFile) {
				void this.fileService.del(inputFile).catch(() => undefined);
			}
		}
		let answer: IVoltHookAnswer;
		if (failed !== undefined || timedOut || (exitCode !== 0 && exitCode !== 2)) {
			const reason = failed ?? (timedOut
				? localize('voltHooks.timedOut', "The hook timed out after {0}s.", Math.round(definition.timeoutMs / 1000))
				: firstLine(stderr) ?? localize('voltHooks.exited', "The hook exited with code {0}.", exitCode ?? 'none'));
			// A broken hook lets the action through unless it is marked fail-closed.
			answer = definition.failClosed && isBlockingEvent(definition.event) ? { block: reason } : {};
			this.logService.warn(`[volt-hooks] ${definition.sourceEvent} hook failed (${definition.file}): ${reason}`);
			this.record(definition, context, toolName, startedAt, exitCode, timedOut, answer.block ? 'blocked' : 'error', reason);
			return answer;
		}
		answer = interpretHookAnswer(definition, exitCode, stdout, stderr);
		const outcome: IVoltHookExecution['outcome'] = answer.block !== undefined || answer.stopRun ? 'blocked' : answer.followup ? 'followup' : answer.updatedInput ? 'rewrote' : 'ok';
		this.record(definition, context, toolName, startedAt, exitCode, timedOut, outcome, answer.block ?? answer.stopRun ?? answer.followup ?? answer.userMessage ?? firstLine(stderr));
		return answer;
	}

	private record(definition: IVoltHookDefinition, context: IVoltHookRunContext, toolName: string | undefined, startedAt: number, exitCode: number | null, timedOut: boolean, outcome: IVoltHookExecution['outcome'], message: string | undefined): void {
		this.log = [{
			id: generateUuid(),
			event: definition.event,
			sourceEvent: definition.sourceEvent,
			label: definition.label,
			command: definition.command,
			sessionId: context.sessionId,
			toolName: toolName ? hookToolName(definition.protocol, toolName) : undefined,
			startedAt,
			durationMs: Date.now() - startedAt,
			exitCode,
			timedOut,
			outcome,
			message,
		}, ...this.log].slice(0, MAX_EXECUTIONS);
		this._onDidChangeExecutions.fire();
	}

	//#endregion

	//#region Tools

	wrapTool(tool: IVoltTool, context: () => IVoltHookRunContext): IVoltTool {
		const run = (event: VoltHookEvent, ctx: IVoltHookRunContext, fields: (protocol: VoltHookProtocol) => Record<string, unknown>) => this.run(event, ctx, fields, tool.name);
		const before = beforeEventsFor(tool.name);
		const after = afterEventsFor(tool.name);
		return {
			...tool,
			execute: async (args: unknown, toolContext: IToolContext): Promise<IToolResult> => {
				const hookContext = context();
				const definitions = this.enabled ? await this.definitions(hookContext.root) : [];
				const relevant = new Set(definitions.filter(definition => hookMatches(definition, tool.name)).map(definition => definition.event));
				if (![...before, ...after, 'postToolUseFailure' as const].some(event => relevant.has(event))) {
					return tool.execute(args, toolContext);
				}
				const cwd = toolContext.cwd ?? hookContext.cwd;
				let current = args;
				for (const event of before) {
					if (!relevant.has(event)) {
						continue;
					}
					const result = await run(event, hookContext, protocol => beforeFields(event, protocol, tool.name, current, cwd, toolContext.callId));
					if (result.blocked !== undefined || result.stopRun) {
						if (result.stopRun) {
							hookContext.stop?.(result.stopRun);
						}
						const reason = result.blocked ?? result.stopRun ?? '';
						const shown = result.userMessage && result.userMessage !== reason ? `\n${result.userMessage}` : '';
						return { callId: '', name: tool.name, kind: tool.kind, text: localize('voltHooks.blocked', "Blocked by a hook: {0}{1}", reason, shown), isError: true };
					}
					if (result.updatedInput) {
						current = voltToolArgs(tool.name, current, result.updatedInput);
					}
				}
				const startedAt = Date.now();
				let result: IToolResult;
				try {
					result = await tool.execute(current, toolContext);
				} catch (err) {
					if (relevant.has('postToolUseFailure')) {
						const message = err instanceof Error ? err.message : String(err);
						void run('postToolUseFailure', hookContext, protocol => failureFields(protocol, tool.name, current, cwd, message, toolContext.callId));
					}
					throw err;
				}
				const events = result.isError ? ['postToolUseFailure' as const] : after;
				const extra: string[] = [];
				for (const event of events) {
					if (!relevant.has(event)) {
						continue;
					}
					const answer = event === 'postToolUseFailure'
						? await run(event, hookContext, protocol => failureFields(protocol, tool.name, current, cwd, result.text, toolContext.callId))
						: await run(event, hookContext, protocol => afterFields(event, protocol, tool.name, current, cwd, result, Date.now() - startedAt, toolContext.callId));
					if (answer.stopRun) {
						hookContext.stop?.(answer.stopRun);
					}
					extra.push(...answer.context);
					if (answer.blocked) {
						extra.push(answer.blocked);
					}
				}
				return extra.length ? { ...result, contexts: [...(result.contexts ?? []), ...extra.map(text => `Hook feedback: ${text}`)] } : result;
			},
		};
	}

	//#endregion
}

function isHookFile(uri: URI): boolean {
	return /[\\/](hooks\.json|settings(\.local)?\.json|installed_plugins\.json)$/.test(uri.path)
		// A plugin installed, updated or removed.
		|| /[\\/]\.(?:volt|cursor|claude)[\\/]plugins(?:[\\/][^\\/]+){0,3}$/.test(uri.path);
}

function beforeEventsFor(name: string): VoltHookEvent[] {
	if (name === 'shell') {
		return ['preToolUse', 'beforeShellExecution'];
	}
	if (name === 'read_file') {
		return ['preToolUse', 'beforeReadFile'];
	}
	if (isMcpTool(name)) {
		return ['preToolUse', 'beforeMCPExecution'];
	}
	return ['preToolUse'];
}

function afterEventsFor(name: string): VoltHookEvent[] {
	if (name === 'shell') {
		return ['postToolUse', 'afterShellExecution'];
	}
	if (name === 'edit_file' || name === 'write_file') {
		return ['postToolUse', 'afterFileEdit'];
	}
	if (isMcpTool(name)) {
		return ['postToolUse', 'afterMCPExecution'];
	}
	return ['postToolUse'];
}

function argsRecord(args: unknown): Record<string, unknown> {
	return (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
}

function beforeFields(event: VoltHookEvent, protocol: VoltHookProtocol, name: string, args: unknown, cwd: string | undefined, callId: string | undefined): Record<string, unknown> {
	const input = hookToolInput(protocol, name, args, cwd);
	switch (event) {
		case 'beforeShellExecution':
			return { command: argsRecord(args).command, cwd: input.cwd ?? cwd };
		case 'beforeReadFile':
			return { file_path: input.file_path, attachments: [] };
		case 'beforeMCPExecution': {
			const parts = mcpParts(name);
			return { tool_name: parts?.tool ?? name, server: parts?.server, tool_input: JSON.stringify(argsRecord(args)) };
		}
		default:
			return { tool_name: hookToolName(protocol, name), tool_input: input, tool_use_id: callId ?? '', ...(protocol === 'cursor' ? { cwd } : {}) };
	}
}

function afterFields(event: VoltHookEvent, protocol: VoltHookProtocol, name: string, args: unknown, cwd: string | undefined, result: IToolResult, durationMs: number, callId: string | undefined): Record<string, unknown> {
	const input = hookToolInput(protocol, name, args, cwd);
	const output = clipText(result.text);
	switch (event) {
		case 'afterShellExecution':
			return { command: argsRecord(args).command, output, exit_code: result.exitCode, duration: durationMs };
		case 'afterFileEdit': {
			const edits = name === 'write_file'
				? [{ old_string: '', new_string: input.content }]
				: Array.isArray(input.edits) ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
			return { file_path: input.file_path, edits };
		}
		case 'afterMCPExecution': {
			const parts = mcpParts(name);
			return { tool_name: parts?.tool ?? name, server: parts?.server, tool_input: JSON.stringify(argsRecord(args)), result_json: output };
		}
		default:
			return protocol === 'claude'
				? { tool_name: hookToolName(protocol, name), tool_input: input, tool_response: { output, is_error: !!result.isError }, tool_use_id: callId ?? '' }
				: { tool_name: hookToolName(protocol, name), tool_input: input, tool_output: output, tool_use_id: callId ?? '', cwd, duration: durationMs };
	}
}

function failureFields(protocol: VoltHookProtocol, name: string, args: unknown, cwd: string | undefined, error: string, callId: string | undefined): Record<string, unknown> {
	return { tool_name: hookToolName(protocol, name), tool_input: hookToolInput(protocol, name, args, cwd), error: clipText(error, 8_000), tool_use_id: callId ?? '' };
}

/** For callers that print a hook command: shell-quoted payload for a manual test run. */
export function hookTestCommand(command: string, payload: Record<string, unknown>): string {
	return `printf '%s' ${shellQuote(JSON.stringify(payload))} | (${command})`;
}

registerSingleton(IVoltHooksService, VoltHooksService, InstantiationType.Delayed);
