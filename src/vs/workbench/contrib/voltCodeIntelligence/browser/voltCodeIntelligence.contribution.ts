/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IVoltCodeIndexService, NullVoltCodeIndexService } from '../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { CODE_INDEX_ENABLED_SETTING, CODE_INDEX_HIERARCHICAL_IGNORE_SETTING, CODE_INDEX_IGNORE_SYMLINKS_SETTING, CODE_INTELLIGENCE_TOOLS, codeIndexEnabled, lspAllowedFor, FFF_MODE_SETTING, FFF_PATH_SETTING, FIND_FILES_TOOL_NAME, FIND_SYMBOL_TOOL_NAME, INSTANT_GREP_TOOL_NAME, LSP_ENABLED_SETTING, LSP_MAX_LOCAL_SETTING, LSP_MAX_REMOTE_SETTING, LSP_WORKSPACES_MAX, LSP_WORKSPACES_MIN, LSP_WORKTREES_SETTING, readCodeIndexOptions, readFffSettings, RETRIEVAL_ENABLED_SETTING, RTK_ENABLED_SETTING, RTK_EXCLUDE_SETTING } from '../../../services/voltRuntime/common/codeIntelligence.js';
import { IVoltHostFileChange, IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolResult, IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { CodeIntelHost } from '../../../services/voltRuntime/browser/host/codeIntelHost.js';
import { createCodeIndexNav } from '../../../services/voltRuntime/browser/tools/codeIndexNav.js';
import { CODE_ACTION_DESCRIPTION, CODE_ACTION_SCHEMA, CODE_NAV_DESCRIPTION, CODE_NAV_SCHEMA, createCodeTools, DIAGNOSTICS_DESCRIPTION, DIAGNOSTICS_SCHEMA } from '../../../services/voltRuntime/browser/tools/codeTools.js';
import { IFileToolHost, writeComputedEdit } from '../../../services/voltRuntime/browser/tools/fileTools.js';
import { IVoltTool } from '../../../services/voltRuntime/common/tools/tool.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { VoltSearch } from '../../../services/voltRuntime/browser/search/voltSearch.js';
import { createSearchTools } from '../../../services/voltRuntime/browser/tools/searchTools.js';
import { CodeIntelHierarchyContribution } from './codeIntelHierarchy.js';

// Desktop: the main process's index; browsers: the agent server's (both registered later, so they win).
registerSingleton(IVoltCodeIndexService, NullVoltCodeIndexService, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'voltCodeIntelligence',
	title: localize('voltCodeIntelligence.settings', "Volt Code Intelligence"),
	type: 'object',
	properties: {
		[CODE_INDEX_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.index', "Index repositories so agents' searches answer instantly. The index is stored locally and kept fresh as files change."),
		},
		[CODE_INDEX_HIERARCHICAL_IGNORE_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.hierarchicalIgnore', "Apply .voltignore and .cursorignore files in subfolders too, not only at the project root."),
		},
		[CODE_INDEX_IGNORE_SYMLINKS_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.ignoreSymlinks', "Do not follow symbolic links when listing a project's files for the index."),
		},
		[RTK_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('voltCodeIntelligence.rtk', "Run the agent's shell commands through [RTK](https://github.com/rtk-ai/rtk) when it is installed: `git status`, test runners, linters and package managers print compact output, using 60-90% fewer tokens. Commands RTK does not know run as written."),
		},
		[RTK_EXCLUDE_SETTING]: {
			type: 'array',
			items: { type: 'string' },
			default: [],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('voltCodeIntelligence.rtkExclude', "Commands RTK never rewrites, by their first words: `git log` keeps `git log --oneline` raw but still compacts `git status`. The agent can also get one command's raw output with `rtk proxy <command>`."),
		},
		[FFF_MODE_SETTING]: {
			type: 'string',
			enum: ['auto', 'off'],
			enumDescriptions: [
				localize('voltCodeIntelligence.fffAuto', "Use FFF for fuzzy file search when it is installed; Volt's index otherwise."),
				localize('voltCodeIntelligence.fffOff', "Always use Volt's index for fuzzy file search."),
			],
			// Off unless chosen: one more process per project folder, for ranking the index already does in milliseconds.
			default: 'off',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('voltCodeIntelligence.fff', "Fuzzy file search (the agent's `find_files`) with [FFF](https://github.com/dmtrKovalenko/fff): typo-tolerant, ranked by how recently files changed and were used. It runs as its own process; without it Volt's index answers."),
		},
		[FFF_PATH_SETTING]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.MACHINE,
			description: localize('voltCodeIntelligence.fffPath', "Path to an fff-mcp binary to use instead of the one Volt installs or finds on PATH."),
		},
		[RETRIEVAL_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.retrieval', "Before the agent starts, search the project for the files, symbols and errors your message names and give it the best matches, so it reads the right code first. Capped at a small token budget; skipped when a message names nothing."),
		},
		[LSP_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.lsp', "Let agents use language servers for diagnostics and code navigation. Off: they use the code index instead, and projects in the background stop their language servers."),
		},
		[LSP_WORKTREES_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.lspWorktrees', "Let agents use language servers in their worktree checkouts. Each checkout loads its own copy of the project into the language server."),
		},
		[LSP_MAX_LOCAL_SETTING]: {
			type: 'number',
			default: 3,
			minimum: LSP_WORKSPACES_MIN,
			maximum: LSP_WORKSPACES_MAX,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.maxLocal', "How many local projects keep their language servers running at once. The project on screen and ones with an agent at work come first; the rest stop them until you switch back."),
		},
		[LSP_MAX_REMOTE_SETTING]: {
			type: 'number',
			default: 3,
			minimum: LSP_WORKSPACES_MIN,
			maximum: LSP_WORKSPACES_MAX,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.maxRemote', "How many remote projects (SSH, containers) keep their language servers running at once."),
		},
	},
});

/**
 * The editor's language servers for agents that bring their own tools: the same code_nav,
 * diagnostics and code_action the native agent has, answered from the buffers the user sees.
 */
const LANGUAGE_SERVER_TOOLS: readonly IVoltHostToolInfo[] = [
	{ name: 'code_nav', title: 'Navigated code', group: 'core', description: CODE_NAV_DESCRIPTION, inputSchema: CODE_NAV_SCHEMA },
	{ name: 'diagnostics', title: 'Read diagnostics', group: 'core', description: DIAGNOSTICS_DESCRIPTION, inputSchema: DIAGNOSTICS_SCHEMA },
	{ name: 'code_action', title: 'Refactored code', group: 'core', description: CODE_ACTION_DESCRIPTION, inputSchema: CODE_ACTION_SCHEMA, approvalInReadOnlyModes: 'changes files' },
];

/** Indexes the open project's folders in the background, so the first agent search is already fast. */
class CodeIndexWarmup extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltCodeIndexWarmup';

	constructor(
		@IVoltCodeIndexService private readonly codeIndex: IVoltCodeIndexService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this.warm();
		this._register(this.workspace.onDidChangeWorkspaceFolders(() => this.warm()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CODE_INDEX_ENABLED_SETTING) || e.affectsConfiguration(CODE_INDEX_HIERARCHICAL_IGNORE_SETTING) || e.affectsConfiguration(CODE_INDEX_IGNORE_SYMLINKS_SETTING)) {
				this.warm();
			}
		}));
	}

	private warm(): void {
		if (!codeIndexEnabled(this.configurationService)) {
			return;
		}
		const options = readCodeIndexOptions(this.configurationService);
		for (const folder of this.workspace.getWorkspace().folders) {
			if (folder.uri.scheme === Schemas.file) {
				void this.codeIndex.warm(folder.uri.fsPath, options);
			}
		}
	}
}

/**
 * The index for agents that bring their own tools (Claude Code, Codex): `instant_grep` and
 * `find_symbol` on the volt MCP server, run by the same code as the native agent's grep.
 * Registered by the desktop, whose window serves the MCP server's tool calls.
 */
export class CodeIntelligenceHostTools extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltCodeIntelligenceHostTools';

	private readonly search: VoltSearch;
	/** The window's language servers, for code_nav / diagnostics / code_action over MCP. */
	private readonly codeIntel: CodeIntelHost;

	constructor(
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IVoltCodeIndexService private readonly codeIndex: IVoltCodeIndexService,
		@ISearchService searchService: ISearchService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IMarkerService markerService: IMarkerService,
		@ITextModelService textModelService: ITextModelService,
		@ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
		@ITextFileService private readonly textFileService: ITextFileService,
	) {
		super();
		this.search = this._register(new VoltSearch(searchService, {
			service: codeIndex,
			enabled: () => codeIndexEnabled(configurationService),
			options: () => readCodeIndexOptions(configurationService),
			fff: () => readFffSettings(configurationService),
		}, fileService.onDidFilesChange));
		this.codeIntel = this._register(new CodeIntelHost(markerService, textModelService, languageFeatures, fileService));
		this.codeIntel.setLspPolicy(uri => lspAllowedFor(configurationService, !workspace.isInsideWorkspace(uri)));
		this._register(hostTools.registerToolProvider({
			tools: [...CODE_INTELLIGENCE_TOOLS, ...LANGUAGE_SERVER_TOOLS],
			invoke: (name, args, call) => this.invoke(name, args, call).catch((err): IVoltHostToolResult => ({ error: err instanceof Error ? err.message : String(err) })),
		}));
	}

	private async invoke(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const root = call?.cwd ? URI.file(call.cwd) : this.workspace.getWorkspace().folders[0]?.uri;
		const changes: IVoltHostFileChange[] = [];
		const tool = this.toolFor(name, root);
		if (!tool) {
			return { error: `Unknown tool ${name}.` };
		}
		const abort = new AbortController();
		const cancel = call?.token?.onCancellationRequested(() => abort.abort());
		try {
			const result = await tool.execute(args, {
				signal: abort.signal,
				...(call?.cwd ? { cwd: call.cwd } : {}),
				// code_action's edits join the chat's change set, like browser_run's.
				emit: event => {
					if (event.type === 'file.change' && URI.isUri(event.uri) && typeof event.before === 'string') {
						changes.push({ uri: event.uri, kind: 'edit', before: event.before, existed: true });
					}
				},
			});
			return result.isError ? { error: result.text } : { text: result.text, ...(changes.length ? { changes } : {}) };
		} finally {
			cancel?.dispose();
		}
	}

	private toolFor(name: string, root: URI | undefined): IVoltTool | undefined {
		if (name === INSTANT_GREP_TOOL_NAME || name === FIND_SYMBOL_TOOL_NAME || name === FIND_FILES_TOOL_NAME) {
			const local = name === INSTANT_GREP_TOOL_NAME ? 'grep' : name === FIND_SYMBOL_TOOL_NAME ? 'find_symbol' : 'find_files';
			return createSearchTools(this.search, () => root).find(candidate => candidate.name === local);
		}
		const files: IFileToolHost = {
			fileService: this.fileService,
			root: () => root,
			documents: {
				dirtyText: uri => {
					const model = this.textFileService.files.get(uri);
					return model?.isDirty() ? model.textEditorModel?.getValue() : undefined;
				},
				writeOpen: async (uri, text) => {
					const model = this.textFileService.files.get(uri);
					const editor = model?.textEditorModel;
					if (!model || !editor) {
						return false;
					}
					editor.pushEditOperations([], [{ range: editor.getFullModelRange(), text }], () => null);
					await model.save();
					return true;
				},
			},
		};
		const nav = createCodeIndexNav({ service: this.codeIndex, enabled: () => codeIndexEnabled(this.configurationService), options: () => readCodeIndexOptions(this.configurationService) });
		return createCodeTools(this.codeIntel, () => root, nav, (change, ctx) => writeComputedEdit(files, change.uri, change.before, change.after, ctx)).find(candidate => candidate.name === name);
	}
}

registerWorkbenchContribution2(CodeIndexWarmup.ID, CodeIndexWarmup, WorkbenchPhase.Eventually);
registerWorkbenchContribution2(CodeIntelHierarchyContribution.ID, CodeIntelHierarchyContribution, WorkbenchPhase.BlockRestore);
