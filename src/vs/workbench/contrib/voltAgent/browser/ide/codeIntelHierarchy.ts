/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { SymbolKind } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { setCodeIntelErrorProbe, setCodeIntelHierarchy } from '../../../../services/voltRuntime/browser/host/codeIntelHost.js';
import { ICallEdge, ICodeSymbolRef, IDiagnostic } from '../../../../services/voltRuntime/browser/tools/codeTools.js';
import { CallHierarchyItem, CallHierarchyModel } from '../../../callHierarchy/common/callHierarchy.js';
import { getWorkspaceSymbols } from '../../../search/common/search.js';
import { TypeHierarchyItem, TypeHierarchyModel } from '../../../typeHierarchy/common/typeHierarchy.js';

const KIND_NAMES: Record<number, string> = {
	[SymbolKind.File]: 'file', [SymbolKind.Module]: 'module', [SymbolKind.Namespace]: 'namespace', [SymbolKind.Package]: 'package',
	[SymbolKind.Class]: 'class', [SymbolKind.Method]: 'method', [SymbolKind.Property]: 'property', [SymbolKind.Field]: 'field',
	[SymbolKind.Constructor]: 'constructor', [SymbolKind.Enum]: 'enum', [SymbolKind.Interface]: 'interface', [SymbolKind.Function]: 'function',
	[SymbolKind.Variable]: 'variable', [SymbolKind.Constant]: 'constant', [SymbolKind.Struct]: 'struct', [SymbolKind.EnumMember]: 'enum member',
	[SymbolKind.TypeParameter]: 'type parameter', [SymbolKind.Event]: 'event', [SymbolKind.Operator]: 'operator',
};

function kindName(kind: SymbolKind): string {
	return KIND_NAMES[kind] ?? 'symbol';
}

function sitesOf(ranges: readonly IRange[]): number[] {
	return [...new Set(ranges.map(range => range.startLineNumber))].sort((a, b) => a - b);
}

function itemRef(item: CallHierarchyItem | TypeHierarchyItem): ICodeSymbolRef {
	return {
		name: item.name,
		kind: kindName(item.kind),
		uri: item.uri,
		line: item.selectionRange.startLineNumber,
		column: item.selectionRange.startColumn,
		...(item.detail ? { detail: item.detail.slice(0, 120) } : {}),
	};
}

/**
 * Hands the agents' code_nav the call hierarchy, type hierarchy and workspace symbol providers the
 * editor's own views use (Show Call Hierarchy, Go to Symbol in Workspace), so callers, callees,
 * supertypes and workspace_symbols answer from the same language servers. Also lends the new-errors
 * check after an agent's edit tsserver's direct answer for a file that stays clean.
 */
export class CodeIntelHierarchyContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltCodeIntelHierarchy';

	constructor(@ICommandService commandService: ICommandService) {
		super();
		setCodeIntelErrorProbe({ errorFree: (model, token) => typeScriptErrorFree(commandService, model, token), errors: (model, token) => typeScriptErrors(commandService, model, token) });
		this._register(toDisposable(() => setCodeIntelErrorProbe(undefined)));
		setCodeIntelHierarchy({
			calls: (model, position, direction, token) => calls(model, position, direction, token),
			types: (model, position, direction, token) => types(model, position, direction, token),
			workspaceSymbols: async (query, limit, token) => {
				const items = await getWorkspaceSymbols(query, token);
				return items.slice(0, limit * 2).map(({ symbol }): ICodeSymbolRef => ({
					name: symbol.name,
					kind: kindName(symbol.kind),
					uri: symbol.location.uri,
					line: symbol.location.range.startLineNumber,
					column: symbol.location.range.startColumn,
					...(symbol.containerName ? { container: symbol.containerName } : {}),
				})).filter((symbol, index, all) => all.findIndex(other => other.uri.toString() === symbol.uri.toString() && other.line === symbol.line && other.name === symbol.name) === index).slice(0, limit);
			},
		});
		this._register(toDisposable(() => setCodeIntelHierarchy(undefined)));
	}
}

const TYPESCRIPT_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);

interface ITsServerDiagnosticsResponse {
	readonly success?: boolean;
	readonly body?: readonly { readonly category?: string; readonly text?: string; readonly code?: number; readonly start?: { readonly line: number; readonly offset: number } }[];
}

/**
 * tsserver's errors and warnings in the model's current text, asked directly. The TypeScript
 * extension reports diagnostics only for files open in an editor tab (unless project diagnostics are
 * on), so a file an agent changed in a project chat never got a marker: the diagnostics tool said
 * "no errors" and the new-errors checks never fired. Undefined when tsserver cannot answer.
 */
export async function typeScriptErrors(commandService: ICommandService, model: ITextModel, token: CancellationToken): Promise<IDiagnostic[] | undefined> {
	if (!TYPESCRIPT_LANGUAGES.has(model.getLanguageId()) || token.isCancellationRequested) {
		return undefined;
	}
	const ask = (command: string) => commandService.executeCommand<ITsServerDiagnosticsResponse>('typescript.tsserverRequest', command, { file: model.uri }).catch(() => undefined);
	const answers = await Promise.all([ask('syntacticDiagnosticsSync'), ask('semanticDiagnosticsSync')]);
	if (token.isCancellationRequested || answers.some(answer => !answer?.success || !Array.isArray(answer.body))) {
		return undefined;
	}
	return answers.flatMap(answer => answer!.body!).filter(item => item.category === 'error' || item.category === 'warning').map((item): IDiagnostic => ({
		uri: model.uri,
		line: item.start?.line ?? 1,
		column: item.start?.offset ?? 1,
		severity: item.category === 'error' ? 'error' : 'warning',
		message: item.text ?? '',
		source: 'ts',
		...(item.code !== undefined ? { code: String(item.code) } : {}),
	}));
}

/**
 * Whether tsserver finds no syntax or type errors in the model's current text. The TypeScript
 * extension only pushes diagnostics that changed, so a file that stays clean never gets a marker
 * event; its read-only `*DiagnosticsSync` requests answer directly (the extension sends pending
 * text changes before any request). Undefined when tsserver cannot answer for this document.
 */
export async function typeScriptErrorFree(commandService: ICommandService, model: ITextModel, token: CancellationToken): Promise<boolean | undefined> {
	if (!TYPESCRIPT_LANGUAGES.has(model.getLanguageId()) || token.isCancellationRequested) {
		return undefined;
	}
	const ask = (command: string) => commandService.executeCommand<ITsServerDiagnosticsResponse>('typescript.tsserverRequest', command, { file: model.uri }).catch(() => undefined);
	const answers = await Promise.all([ask('syntacticDiagnosticsSync'), ask('semanticDiagnosticsSync')]);
	if (token.isCancellationRequested || answers.some(answer => !answer?.success || !Array.isArray(answer.body))) {
		return undefined; // not open in tsserver, no TypeScript extension, or the request failed
	}
	return answers.every(answer => answer!.body!.every(diagnostic => diagnostic.category !== 'error'));
}

async function calls(model: ITextModel, position: Position, direction: 'incoming' | 'outgoing', token: CancellationToken): Promise<ICallEdge[] | undefined> {
	const hierarchy = await CallHierarchyModel.create(model, position, token).catch(() => undefined);
	if (!hierarchy) {
		return undefined;
	}
	try {
		const edges: ICallEdge[] = [];
		for (const root of hierarchy.roots) {
			if (direction === 'incoming') {
				for (const call of await hierarchy.resolveIncomingCalls(root, token)) {
					edges.push({ ...itemRef(call.from), sites: sitesOf(call.fromRanges) });
				}
			} else {
				for (const call of await hierarchy.resolveOutgoingCalls(root, token)) {
					edges.push({ ...itemRef(call.to), sites: sitesOf(call.fromRanges) });
				}
			}
		}
		return edges;
	} finally {
		hierarchy.dispose();
	}
}

async function types(model: ITextModel, position: Position, direction: 'supertypes' | 'subtypes', token: CancellationToken): Promise<ICodeSymbolRef[] | undefined> {
	const hierarchy = await TypeHierarchyModel.create(model, position, token).catch(() => undefined);
	if (!hierarchy) {
		return undefined;
	}
	try {
		const found: ICodeSymbolRef[] = [];
		for (const root of hierarchy.roots) {
			const items = direction === 'supertypes' ? await hierarchy.provideSupertypes(root, token) : await hierarchy.provideSubtypes(root, token);
			found.push(...items.map(itemRef));
		}
		return found;
	} finally {
		hierarchy.dispose();
	}
}

registerWorkbenchContribution2(CodeIntelHierarchyContribution.ID, CodeIntelHierarchyContribution, WorkbenchPhase.BlockRestore);
