/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { isAbsolute } from '../../../../../base/common/path.js';
import { isWeb } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { IVoltCodeIndexService } from '../../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { CodeIntelHost, DIAGNOSED_EXTENSIONS } from '../../../../services/voltRuntime/browser/host/codeIntelHost.js';
import { createCodeIndexNav } from '../../../../services/voltRuntime/browser/tools/codeIndexNav.js';
import { CODE_ACTION_DESCRIPTION, CODE_ACTION_SCHEMA, CODE_NAV_DESCRIPTION, CODE_NAV_SCHEMA, createCodeTools, DIAGNOSTICS_DESCRIPTION, DIAGNOSTICS_SCHEMA } from '../../../../services/voltRuntime/browser/tools/codeTools.js';
import { editCheckHookOutput, NO_HOOK_OUTPUT } from '../../../../services/voltRuntime/browser/tools/editDiagnostics.js';
import { IFileToolHost, writeComputedEdit } from '../../../../services/voltRuntime/browser/tools/fileTools.js';
import { displayPath, resolveWorkspaceUri } from '../../../../services/voltRuntime/browser/tools/workspacePath.js';
import { codeIndexEnabled, EditCheckPhase, editCheckPhase, isVoltWorktreePath, lspAllowedFor, readCodeIndexOptions } from '../../../../services/voltRuntime/common/codeIntelligence.js';
import { IVoltHostFileChange, IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolResult, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';

/**
 * The editor's language servers for agents that bring their own tools: the same code_nav,
 * diagnostics and code_action the native agent has, answered from the buffers the user sees.
 * Names: `LANGUAGE_SERVER_TOOL_NAMES`; what they may do for a sandboxed chat: hostToolSandbox.ts.
 */
const LANGUAGE_SERVER_TOOLS: readonly IVoltHostToolInfo[] = [
	// Behind Claude Code's tool search (~480 tokens in every request otherwise). It went unused there
	// while the lead named it only loosely (02-code-intelligence.md); the IDE guide and CODE_QUESTIONS
	// now give its exact name and how to load it on the turns about the code.
	{ name: 'code_nav', title: 'Navigated code', group: 'core', description: CODE_NAV_DESCRIPTION, inputSchema: CODE_NAV_SCHEMA },
	{ name: 'diagnostics', title: 'Read diagnostics', group: 'core', description: DIAGNOSTICS_DESCRIPTION, inputSchema: DIAGNOSTICS_SCHEMA },
	{ name: 'code_action', title: 'Refactored code', group: 'core', description: CODE_ACTION_DESCRIPTION, inputSchema: CODE_ACTION_SCHEMA, approvalInReadOnlyModes: 'changes files' },
];

/** The edit's start waits this long for the file's errors as they were (it holds up the edit). */
const BASELINE_WAIT_MS = 1_500;
/** A read's check runs in the background and may take this long (a language server still loading the project). */
const READ_BASELINE_WAIT_MS = 30_000;
/** The edit's end waits this long for the language server to report on the new text. */
const AFTER_EDIT_WAIT_MS = 4_000;
const BASELINE_TTL_MS = 10 * 60_000;

/**
 * Serves {@link LANGUAGE_SERVER_TOOLS} on the volt MCP server. The desktop window serves those
 * calls (its language servers have the user's buffers); in a browser the agent server does.
 */
export class LanguageServerHostTools extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltLanguageServerHostTools';

	private readonly codeIntel: CodeIntelHost;
	/** Each file's errors before an edit (see {@link editCheck}). */
	private readonly baselines = new ResourceMap<{ readonly counts: Map<string, number>; readonly at: number }>();

	constructor(
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IVoltCodeIndexService private readonly codeIndex: IVoltCodeIndexService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IMarkerService markerService: IMarkerService,
		@ITextModelService textModelService: ITextModelService,
		@ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
		@ITextFileService private readonly textFileService: ITextFileService,
	) {
		super();
		this.codeIntel = this._register(new CodeIntelHost(markerService, textModelService, languageFeatures, fileService));
		this.codeIntel.setLspPolicy(uri => lspAllowedFor(configurationService, !workspace.isInsideWorkspace(uri) && isVoltWorktreePath(uri.fsPath)));
		this._register(hostTools.registerToolProvider({
			tools: LANGUAGE_SERVER_TOOLS,
			invoke: (name, args, call) => this.invoke(name, args, call).catch((err): IVoltHostToolResult => ({ error: err instanceof Error ? err.message : String(err) })),
		}));
	}

	private async invoke(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const root = call?.cwd ? URI.file(call.cwd) : this.workspace.getWorkspace().folders[0]?.uri;
		const phase = editCheckPhase(name, args);
		if (phase) {
			return { text: await this.editCheck(phase, root, args).catch(() => NO_HOOK_OUTPUT) };
		}
		const tool = this.tools(root).find(candidate => candidate.name === name);
		if (!tool) {
			return { error: `Unknown tool ${name}.` };
		}
		const changes: IVoltHostFileChange[] = [];
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
	 * errors before the edit are not known (the end-of-turn check still covers the file).
	 */
	private async editCheck(phase: EditCheckPhase, root: URI | undefined, args: Record<string, unknown>): Promise<string> {
		const path = typeof args.path === 'string' ? args.path : undefined;
		const uri = path ? resolveWorkspaceUri(root, path) ?? (isAbsolute(path) ? URI.file(path) : undefined) : undefined;
		if (!uri || !DIAGNOSED_EXTENSIONS.test(uri.path) || !this.codeIntel.lspAllowed(uri)) {
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

	private tools(root: URI | undefined) {
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
		return createCodeTools(this.codeIntel, () => root, nav, (change, ctx) => writeComputedEdit(files, change.uri, change.before, change.after, ctx));
	}
}

if (!isWeb) {
	registerWorkbenchContribution2(LanguageServerHostTools.ID, LanguageServerHostTools, WorkbenchPhase.Eventually);
}
