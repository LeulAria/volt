/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { isAbsolute } from '../../../../base/common/path.js';
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
import { CODE_ACTION_TOOL_NAME, CODE_INDEX_ENABLED_SETTING, CODE_INDEX_HIERARCHICAL_IGNORE_SETTING, CODE_INDEX_IGNORE_SYMLINKS_SETTING, CODE_INTELLIGENCE_TOOLS, codeIndexEnabled, confinedIndexOptions, EditCheckPhase, editCheckPhase, FIND_FILES_TOOL_NAME, FIND_SYMBOL_TOOL_NAME, INSTANT_GREP_TOOL_NAME, lspPolicy, readCodeIndexOptions, readFffSettings } from '../../../services/voltRuntime/common/codeIntelligence.js';
import { IVoltHostFileChange, IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { isSandboxed } from '../../../services/voltRuntime/common/hostToolSandbox.js';
import { IToolContext, IVoltTool } from '../../../services/voltRuntime/common/tools/tool.js';
import { CodeIntelHost, DIAGNOSED_EXTENSIONS } from '../../../services/voltRuntime/browser/host/codeIntelHost.js';
import { VoltSearch } from '../../../services/voltRuntime/browser/search/voltSearch.js';
import { createCodeIndexNav } from '../../../services/voltRuntime/browser/tools/codeIndexNav.js';
import { createCodeTools, ITextFileChange } from '../../../services/voltRuntime/browser/tools/codeTools.js';
import { editCheckHookOutput, NO_HOOK_OUTPUT } from '../../../services/voltRuntime/browser/tools/editDiagnostics.js';
import { IFileToolHost, writeComputedEdit } from '../../../services/voltRuntime/browser/tools/fileTools.js';
import { displayPath, resolveWorkspaceUri } from '../../../services/voltRuntime/browser/tools/workspacePath.js';
import { confineCodeIntel, ICodeIntelRules } from './codeIntelConfinement.js';
import { createSearchTools } from '../../../services/voltRuntime/browser/tools/searchTools.js';

/** The edit's start waits this long for the file's errors as they were (it holds up the edit). */
const BASELINE_WAIT_MS = 1_500;
/** A read's check runs in the background and may take this long (a language server still loading the project). */
const READ_BASELINE_WAIT_MS = 30_000;
/** The edit's end waits this long for the language server to report on the new text. */
const AFTER_EDIT_WAIT_MS = 4_000;
const BASELINE_TTL_MS = 10 * 60_000;

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
				void this.codeIndex.warm(folder.uri.fsPath, options).then(() => {
					// Sandboxed chats (the default, Supervised) search their own confined index. Unwarmed,
					// the first search of a big project waited 4 s and then refused ("indexing").
					void this.codeIndex.warm(folder.uri.fsPath, confinedIndexOptions(options));
				});
			}
		}
	}
}

/**
 * The index for agents that bring their own tools (Claude Code, Codex): `instant_grep` and
 * `find_symbol` on the volt MCP server, run by the same code as the native agent's grep, and the
 * window's language servers (code_nav, diagnostics, code_action), answered from the buffers the
 * user sees, and Claude Code's edit-check hooks (`diagnostics` with `hook`, see {@link editCheck}).
 * Registered by the desktop, whose window serves the MCP server's tool calls.
 */
export class CodeIntelligenceHostTools extends Disposable {

	private readonly search: VoltSearch;
	/** The window's language servers, for code_nav / diagnostics / code_action over MCP. */
	private readonly codeIntel: CodeIntelHost;
	/** Each file's errors before an edit (see {@link editCheck}). */
	private readonly baselines = new ResourceMap<{ readonly counts: Map<string, number>; readonly at: number }>();

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
		const phase = editCheckPhase(name, args);
		if (phase) {
			return { text: await this.editCheck(phase, root, args, call).catch(() => NO_HOOK_OUTPUT) };
		}
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

	/**
	 * Claude Code's hooks around its file tools (see `EDIT_CHECK_TOOL_NAME`): a read opens the file
	 * for its language server, the edit's start notes the file's errors, its end answers the errors
	 * it added, as the hook's context for the model. Silent (`{}`) when there is nothing new or the
	 * errors before the edit are not known (the end-of-turn check still covers the file), and for a
	 * sandboxed chat when its sandbox may not read the file (or Volt cannot tell).
	 */
	private async editCheck(phase: EditCheckPhase, root: URI | undefined, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<string> {
		const path = typeof args.path === 'string' ? args.path : undefined;
		const uri = path ? resolveWorkspaceUri(root, path) ?? (isAbsolute(path) ? URI.file(path) : undefined) : undefined;
		if (!uri || !DIAGNOSED_EXTENSIONS.test(uri.path) || !this.codeIntel.lspAllowed(uri)) {
			return NO_HOOK_OUTPUT;
		}
		if (call && isSandboxed(call.sandbox) && (!call.readRefusal || await call.readRefusal(uri.fsPath))) {
			return NO_HOOK_OUTPUT;
		}
		this.forgetOldBaselines();
		switch (phase) {
			case 'read': {
				// The file's errors are read now, while the model thinks, so the edit's start need not wait.
				const at = Date.now();
				void this.codeIntel.settledErrorCounts(uri, READ_BASELINE_WAIT_MS).then(counts => {
					if (counts && (this.baselines.get(uri)?.at ?? 0) < at) {
						this.baselines.set(uri, { counts, at });
					}
				});
				return NO_HOOK_OUTPUT;
			}
			case 'before': {
				const counts = await this.codeIntel.settledErrorCounts(uri, BASELINE_WAIT_MS);
				if (counts) {
					this.baselines.set(uri, { counts, at: Date.now() });
				}
				// Else the baseline the read (or the last edit) left stays, if any.
				return NO_HOOK_OUTPUT;
			}
			case 'after': {
				const baseline = this.baselines.get(uri);
				this.codeIntel.noteWrite(uri);
				if (!baseline) {
					return NO_HOOK_OUTPUT;
				}
				const added = await raceTimeout(this.codeIntel.newErrors(uri, baseline.counts), AFTER_EDIT_WAIT_MS);
				// The next edit of this file is compared with the file as this one left it.
				this.baselines.set(uri, { counts: this.codeIntel.errorCounts(uri), at: Date.now() });
				return added?.length ? editCheckHookOutput(added, root ? displayPath(root, uri) : uri.fsPath) : NO_HOOK_OUTPUT;
			}
		}
	}

	private forgetOldBaselines(): void {
		const now = Date.now();
		for (const [uri, baseline] of this.baselines) {
			if (now - baseline.at > BASELINE_TTL_MS) {
				this.baselines.delete(uri);
			}
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
