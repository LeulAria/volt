/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IVoltCodeIndexService } from '../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { CODE_ACTION_TOOL_NAME, CODE_INDEX_ENABLED_SETTING, CODE_INDEX_HIERARCHICAL_IGNORE_SETTING, CODE_INDEX_IGNORE_SYMLINKS_SETTING, CODE_INTELLIGENCE_TOOLS, codeIndexEnabled, FIND_FILES_TOOL_NAME, FIND_SYMBOL_TOOL_NAME, INSTANT_GREP_TOOL_NAME, lspPolicy, readCodeIndexOptions, readFffSettings } from '../../../services/voltRuntime/common/codeIntelligence.js';
import { IVoltHostFileChange, IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { isSandboxed } from '../../../services/voltRuntime/common/hostToolSandbox.js';
import { IToolContext, IVoltTool } from '../../../services/voltRuntime/common/tools/tool.js';
import { CodeIntelHost } from '../../../services/voltRuntime/browser/host/codeIntelHost.js';
import { VoltSearch } from '../../../services/voltRuntime/browser/search/voltSearch.js';
import { createCodeIndexNav } from '../../../services/voltRuntime/browser/tools/codeIndexNav.js';
import { confineCodeIntel, ICodeIntelRules } from '../../../services/voltRuntime/browser/tools/codeIntelConfinement.js';
import { createCodeTools, ITextFileChange } from '../../../services/voltRuntime/browser/tools/codeTools.js';
import { IFileToolHost, writeComputedEdit } from '../../../services/voltRuntime/browser/tools/fileTools.js';
import { createSearchTools } from '../../../services/voltRuntime/browser/tools/searchTools.js';

/** Indexes the open project's folders in the background, so the first agent search is already fast. */
export class CodeIndexWarmup extends Disposable {

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
 * `find_symbol` on the volt MCP server, run by the same code as the native agent's grep, and the
 * window's language servers (code_nav, diagnostics, code_action).
 * Registered by the desktop, whose window serves the MCP server's tool calls.
 */
export class CodeIntelligenceHostTools extends Disposable {

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
		this.codeIntel.setLspPolicy(lspPolicy(configurationService, uri => workspace.isInsideWorkspace(uri)));
		this._register(hostTools.registerToolProvider({
			tools: CODE_INTELLIGENCE_TOOLS,
			invoke: (name, args, call) => this.invoke(name, args, call).catch((err): IVoltHostToolResult => ({ error: err instanceof Error ? err.message : String(err) })),
		}));
	}

	private async invoke(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const root = call?.cwd ? URI.file(call.cwd) : this.workspace.getWorkspace().folders[0]?.uri;
		// A sandboxed chat searches its own confined index, and sees only results its sandbox may read (B-15);
		// its language server edits change only files its sandbox may write.
		let confine: ICodeIntelRules | undefined;
		if (call && isSandboxed(call.sandbox)) {
			if (!call.readRefusal || !call.cwd) {
				return { error: `${name} was not run: Volt cannot tell which files this sandboxed chat may read. Search with your own tools instead: they run inside the sandbox.` };
			}
			if (name === CODE_ACTION_TOOL_NAME && !call.writeRefusal) {
				return { error: `${name} did not start: no file was changed. Volt cannot tell which files this sandboxed chat may write. Edit the files with your own tools instead.` };
			}
			confine = { readRefusal: call.readRefusal, ...(call.writeRefusal ? { writeRefusal: call.writeRefusal } : {}) };
		}
		const changes: IVoltHostFileChange[] = [];
		const tool = this.toolFor(name, root, confine);
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

	private toolFor(name: string, root: URI | undefined, confine: ICodeIntelRules | undefined): IVoltTool | undefined {
		if (name === INSTANT_GREP_TOOL_NAME || name === FIND_SYMBOL_TOOL_NAME || name === FIND_FILES_TOOL_NAME) {
			const local = name === INSTANT_GREP_TOOL_NAME ? 'grep' : name === FIND_SYMBOL_TOOL_NAME ? 'find_symbol' : 'find_files';
			return createSearchTools(this.search, () => root, confine).find(candidate => candidate.name === local);
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
		const index = createCodeIndexNav({ service: this.codeIndex, enabled: () => codeIndexEnabled(this.configurationService), options: () => readCodeIndexOptions(this.configurationService) });
		const { host, nav } = confine ? confineCodeIntel(this.codeIntel, index, confine) : { host: this.codeIntel, nav: index };
		// code_action's edits are written here, in Volt's process (writeComputedEdit: the open buffer, else
		// IFileService). A sandboxed chat's edit was judged whole by the confined host; each file is judged
		// again just before it is written.
		const write = async (change: ITextFileChange, ctx: IToolContext) => {
			const why = confine && (confine.writeRefusal ? await confine.writeRefusal(change.uri.fsPath) : 'Volt cannot tell which files this sandboxed chat may write');
			if (why) {
				throw new Error(`Stopped before changing ${change.uri.fsPath}: ${why} (this chat runs in Volt's sandbox). Files of this edit listed before it may already be changed: check them with git diff, and make the rest of the change with your own edit tools.`);
			}
			return writeComputedEdit(files, change.uri, change.before, change.after, ctx);
		};
		return createCodeTools(host, () => root, nav, write).find(candidate => candidate.name === name);
	}
}
