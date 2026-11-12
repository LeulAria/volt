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
import { CODE_INDEX_ENABLED_SETTING, CODE_INDEX_HIERARCHICAL_IGNORE_SETTING, CODE_INDEX_IGNORE_SYMLINKS_SETTING, CODE_INTELLIGENCE_TOOLS, codeIndexEnabled, FIND_FILES_TOOL_NAME, FIND_SYMBOL_TOOL_NAME, INSTANT_GREP_TOOL_NAME, readCodeIndexOptions, readFffSettings } from '../../../services/voltRuntime/common/codeIntelligence.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { isSandboxed } from '../../../services/voltRuntime/common/hostToolSandbox.js';
import { ISearchConfinement, VoltSearch } from '../../../services/voltRuntime/browser/search/voltSearch.js';
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
 * `find_symbol` on the volt MCP server, run by the same code as the native agent's grep.
 * Registered by the desktop, whose window serves the MCP server's tool calls.
 */
export class CodeIntelligenceHostTools extends Disposable {

	private readonly search: VoltSearch;

	constructor(
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IVoltCodeIndexService codeIndex: IVoltCodeIndexService,
		@ISearchService searchService: ISearchService,
		@IFileService fileService: IFileService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this.search = this._register(new VoltSearch(searchService, {
			service: codeIndex,
			enabled: () => codeIndexEnabled(configurationService),
			options: () => readCodeIndexOptions(configurationService),
			fff: () => readFffSettings(configurationService),
		}, fileService.onDidFilesChange));
		this._register(hostTools.registerToolProvider({
			tools: CODE_INTELLIGENCE_TOOLS,
			invoke: (name, args, call) => this.invoke(name, args, call).catch((err): IVoltHostToolResult => ({ error: err instanceof Error ? err.message : String(err) })),
		}));
	}

	private async invoke(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const root = call?.cwd ? URI.file(call.cwd) : this.workspace.getWorkspace().folders[0]?.uri;
		// A sandboxed chat searches its own confined index, and sees only results its sandbox may read (B-15).
		let confine: ISearchConfinement | undefined;
		if (call && isSandboxed(call.sandbox)) {
			if (!call.readRefusal || !call.cwd) {
				return { error: `${name} was not run: Volt cannot tell which files this sandboxed chat may read. Search with your own tools instead: they run inside the sandbox.` };
			}
			confine = { readRefusal: call.readRefusal };
		}
		const tools = createSearchTools(this.search, () => root, confine);
		const tool = tools.find(candidate => candidate.name === (name === INSTANT_GREP_TOOL_NAME ? 'grep' : name === FIND_SYMBOL_TOOL_NAME ? 'find_symbol' : name === FIND_FILES_TOOL_NAME ? 'find_files' : ''));
		if (!tool) {
			return { error: `Unknown tool ${name}.` };
		}
		const abort = new AbortController();
		const cancel = call?.token?.onCancellationRequested(() => abort.abort());
		try {
			const result = await tool.execute(args, { signal: abort.signal, ...(call?.cwd ? { cwd: call.cwd } : {}) });
			return result.isError ? { error: result.text } : { text: result.text };
		} finally {
			cancel?.dispose();
		}
	}
}
