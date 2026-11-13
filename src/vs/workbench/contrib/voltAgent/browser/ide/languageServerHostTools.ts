/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
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
import { CodeIntelHost } from '../../../../services/voltRuntime/browser/host/codeIntelHost.js';
import { createCodeIndexNav } from '../../../../services/voltRuntime/browser/tools/codeIndexNav.js';
import { CODE_ACTION_DESCRIPTION, CODE_ACTION_SCHEMA, CODE_NAV_DESCRIPTION, CODE_NAV_SCHEMA, createCodeTools, DIAGNOSTICS_DESCRIPTION, DIAGNOSTICS_SCHEMA } from '../../../../services/voltRuntime/browser/tools/codeTools.js';
import { IFileToolHost, writeComputedEdit } from '../../../../services/voltRuntime/browser/tools/fileTools.js';
import { codeIndexEnabled, isVoltWorktreePath, lspAllowedFor, readCodeIndexOptions } from '../../../../services/voltRuntime/common/codeIntelligence.js';
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

/**
 * Serves {@link LANGUAGE_SERVER_TOOLS} on the volt MCP server. The desktop window serves those
 * calls (its language servers have the user's buffers); in a browser the agent server does.
 */
export class LanguageServerHostTools extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltLanguageServerHostTools';

	private readonly codeIntel: CodeIntelHost;

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
