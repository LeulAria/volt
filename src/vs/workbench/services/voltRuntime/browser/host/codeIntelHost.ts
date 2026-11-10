/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, IDisposable, IReference } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { URI } from '../../../../../base/common/uri.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { CodeAction, CodeActionProvider, CodeActionTriggerType, DocumentSymbol, IWorkspaceTextEdit, Location, LocationLink, ProviderResult, TextEdit, WorkspaceEdit } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { ICallEdge, ICodeFix, ICodeIntelHost, ICodeLocation, ICodeRange, ICodeSymbol, ICodeSymbolRef, IDiagnostic, ITextFileChange } from '../tools/codeTools.js';

const SYMBOL_KINDS = ['file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];

/** A written file gets this long for its language service to report on the new text. */
const FRESH_WRITE_MS = 15_000;
const MARKER_WAIT_MS = 3_000;
const MARKER_SETTLE_MS = 400;
/** Opened documents stay open a while so repeated checks are instant. */
const KEEP_OPEN_MS = 90_000;
const MAX_OPEN = 24;
/** A language server that has not answered by then is treated as having nothing to say. */
const PROVIDER_TIMEOUT_MS = 10_000;
/** Rename and code actions can touch many files; they get longer. */
const EDIT_TIMEOUT_MS = 30_000;

/** What the runtime needs from code intelligence: the agent tools, plus checks after its own edits. */
export interface IRuntimeCodeIntel extends ICodeIntelHost, IDisposable {
	setLspPolicy(policy: (uri: URI) => boolean): void;
	/** Called for every agent write, so the next diagnostics call waits for fresh results. */
	noteWrite(uri: URI): void;
	/** Error markers on a file right now, counted by message. May fill in shortly after it returns (agent server). */
	errorCounts(uri: URI): Map<string, number>;
	/** Errors on `uri` beyond those in `baseline`. */
	newErrors(uri: URI, baseline: ReadonlyMap<string, number>): Promise<IDiagnostic[]>;
}

let runtimeCodeIntelFactory: (() => IRuntimeCodeIntel) | undefined;

/**
 * Call and type hierarchies and workspace symbols live in workbench contributions this layer may
 * not import (the agent server loads it too); the window's code intelligence contribution sets
 * them here.
 */
export interface ICodeIntelHierarchy {
	calls(model: ITextModel, position: Position, direction: 'incoming' | 'outgoing', token: CancellationToken): Promise<ICallEdge[] | undefined>;
	types(model: ITextModel, position: Position, direction: 'supertypes' | 'subtypes', token: CancellationToken): Promise<ICodeSymbolRef[] | undefined>;
	workspaceSymbols(query: string, limit: number, token: CancellationToken): Promise<ICodeSymbolRef[]>;
}

let codeIntelHierarchy: ICodeIntelHierarchy | undefined;

export function setCodeIntelHierarchy(hierarchy: ICodeIntelHierarchy | undefined): void {
	codeIntelHierarchy = hierarchy;
}

/**
 * The agent server has no editor models or language servers: it sets a factory whose code
 * intelligence asks an open Volt window. Unset, the runtime uses this window's {@link CodeIntelHost}.
 */
export function setRuntimeCodeIntelFactory(factory: (() => IRuntimeCodeIntel) | undefined): void {
	runtimeCodeIntelFactory = factory;
}

export function createRuntimeCodeIntel(markerService: IMarkerService, textModelService: ITextModelService, languageFeatures: ILanguageFeaturesService, fileService: IFileService): IRuntimeCodeIntel {
	return runtimeCodeIntelFactory?.() ?? new CodeIntelHost(markerService, textModelService, languageFeatures, fileService);
}

/** The column of `symbol` on a line of text (1-based), matching a whole word first. */
export function columnOfSymbol(text: string, symbol: string): number | undefined {
	const exact = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).exec(text);
	const index = exact ? exact.index : text.indexOf(symbol);
	return index >= 0 ? index + 1 : undefined;
}

export class CodeIntelHost extends Disposable implements IRuntimeCodeIntel {

	private readonly writes = new ResourceMap<number>();
	private readonly open = new ResourceMap<{ ref: IReference<IResolvedTextEditorModel>; timer: ReturnType<typeof setTimeout> }>();
	/** Settings > Code Intelligence: which files language servers may be asked about. */
	private policy: (uri: URI) => boolean = () => true;

	constructor(
		private readonly markerService: IMarkerService,
		private readonly textModelService: ITextModelService,
		private readonly languageFeatures: ILanguageFeaturesService,
		private readonly fileService: IFileService,
	) {
		super();
		this._register({ dispose: () => this.closeAll() });
	}

	setLspPolicy(policy: (uri: URI) => boolean): void {
		this.policy = policy;
	}

	lspAllowed(uri: URI): boolean {
		return this.policy(uri);
	}

	async wordAt(uri: URI, line: number, column: number): Promise<string | undefined> {
		const text = await this.fileService.readFile(uri).then(file => file.value.toString(), () => undefined);
		const content = text?.split('\n')[line - 1];
		if (content === undefined) {
			return undefined;
		}
		const at = Math.max(0, column - 1);
		const re = /[A-Za-z_$][\w$]*/g;
		let match: RegExpExecArray | null;
		while ((match = re.exec(content))) {
			if (at >= match.index && at <= match.index + match[0].length) {
				return match[0];
			}
		}
		return undefined;
	}

	/** Called for every agent write, so the next diagnostics call waits for fresh results. */
	noteWrite(uri: URI): void {
		this.writes.set(uri, Date.now());
	}

	/** Error markers on a file right now, counted by message (line numbers shift with edits). */
	errorCounts(uri: URI): Map<string, number> {
		const counts = new Map<string, number>();
		for (const marker of this.markerService.read({ resource: uri, severities: MarkerSeverity.Error })) {
			const key = markerKey(marker);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return counts;
	}

	/** Errors on `uri` beyond those in `baseline`. Opens the file and waits for fresh markers first. */
	async newErrors(uri: URI, baseline: ReadonlyMap<string, number>): Promise<IDiagnostic[]> {
		if (!this.policy(uri)) {
			return []; // opening it would start a language server for this checkout
		}
		await this.freshen(uri);
		const seen = new Map<string, number>();
		const added: IDiagnostic[] = [];
		for (const marker of this.markerService.read({ resource: uri, severities: MarkerSeverity.Error })) {
			const key = markerKey(marker);
			const count = (seen.get(key) ?? 0) + 1;
			seen.set(key, count);
			if (count > (baseline.get(key) ?? 0)) {
				added.push(toDiagnostic(marker));
			}
		}
		return added;
	}

	async diagnostics(uris: readonly URI[] | undefined, severity: 'error' | 'warning' | 'all'): Promise<IDiagnostic[]> {
		const severities = severity === 'error' ? MarkerSeverity.Error : severity === 'warning' ? MarkerSeverity.Error | MarkerSeverity.Warning : MarkerSeverity.Error | MarkerSeverity.Warning | MarkerSeverity.Info;
		if (!uris?.length) {
			return this.markerService.read({ severities }).slice(0, 500).map(toDiagnostic);
		}
		await Promise.all(uris.map(uri => this.freshen(uri)));
		return uris.flatMap(uri => this.markerService.read({ resource: uri, severities }).map(toDiagnostic));
	}

	async definitions(uri: URI, line: number, column: number): Promise<ICodeLocation[]> {
		const model = await this.model(uri);
		const position = new Position(line, column);
		const found: (Location | LocationLink)[] = [];
		for (const provider of this.languageFeatures.definitionProvider.ordered(model)) {
			const result = await Promise.resolve(provider.provideDefinition(model, position, CancellationToken.None)).catch(() => undefined);
			if (result) {
				found.push(...(Array.isArray(result) ? result : [result]));
			}
			if (found.length) {
				break;
			}
		}
		return this.withPreviews(found.map(toLocation));
	}

	async references(uri: URI, line: number, column: number): Promise<ICodeLocation[]> {
		const model = await this.model(uri);
		const position = new Position(line, column);
		for (const provider of this.languageFeatures.referenceProvider.ordered(model)) {
			const result = await Promise.resolve(provider.provideReferences(model, position, { includeDeclaration: true }, CancellationToken.None)).catch(() => undefined);
			if (result?.length) {
				return this.withPreviews(result.map(toLocation));
			}
		}
		return [];
	}

	async symbols(uri: URI): Promise<ICodeSymbol[]> {
		const model = await this.model(uri);
		for (const provider of this.languageFeatures.documentSymbolProvider.ordered(model)) {
			const result = await Promise.resolve(provider.provideDocumentSymbols(model, CancellationToken.None)).catch(() => undefined);
			if (result?.length) {
				const out: ICodeSymbol[] = [];
				const walk = (symbols: readonly DocumentSymbol[], depth: number) => {
					for (const symbol of [...symbols].sort((a, b) => a.range.startLineNumber - b.range.startLineNumber)) {
						out.push({
							name: symbol.name,
							kind: SYMBOL_KINDS[symbol.kind] ?? 'symbol',
							line: symbol.range.startLineNumber,
							endLine: symbol.range.endLineNumber,
							depth,
							...(symbol.detail ? { detail: symbol.detail.slice(0, 80) } : {}),
						});
						if (symbol.children?.length && depth < 3) {
							walk(symbol.children, depth + 1);
						}
					}
				};
				walk(result, 0);
				return out;
			}
		}
		return [];
	}

	async columnOf(uri: URI, line: number, symbol: string): Promise<number | undefined> {
		const model = await this.model(uri);
		if (line < 1 || line > model.getLineCount()) {
			return undefined;
		}
		return columnOfSymbol(model.getLineContent(line), symbol);
	}

	async fileText(uri: URI): Promise<string | undefined> {
		return (await this.model(uri).catch(() => undefined))?.getValue();
	}

	async implementations(uri: URI, line: number, column: number): Promise<ICodeLocation[]> {
		const model = await this.model(uri);
		const position = new Position(line, column);
		for (const provider of this.languageFeatures.implementationProvider.ordered(model)) {
			const result = await this.ask(token => provider.provideImplementation(model, position, token));
			const found = result ? (Array.isArray(result) ? result : [result]) : [];
			if (found.length) {
				return this.withPreviews(found.map(toLocation));
			}
		}
		return [];
	}

	async typeDefinitions(uri: URI, line: number, column: number): Promise<ICodeLocation[]> {
		const model = await this.model(uri);
		const position = new Position(line, column);
		for (const provider of this.languageFeatures.typeDefinitionProvider.ordered(model)) {
			const result = await this.ask(token => provider.provideTypeDefinition(model, position, token));
			const found = result ? (Array.isArray(result) ? result : [result]) : [];
			if (found.length) {
				return this.withPreviews(found.map(toLocation));
			}
		}
		return [];
	}

	async hover(uri: URI, line: number, column: number): Promise<string | undefined> {
		const model = await this.model(uri);
		const position = new Position(line, column);
		const parts: string[] = [];
		for (const provider of this.languageFeatures.hoverProvider.ordered(model)) {
			const result = await this.ask(token => provider.provideHover(model, position, token));
			for (const content of result?.contents ?? []) {
				const value = content.value.trim();
				if (value && !parts.includes(value)) {
					parts.push(value);
				}
			}
		}
		const joined = parts.join('\n\n').replace(/\n{3,}/g, '\n\n');
		return joined ? (joined.length > 2_000 ? `${joined.slice(0, 2_000)}\u2026` : joined) : undefined;
	}

	async workspaceSymbols(query: string, limit: number): Promise<ICodeSymbolRef[]> {
		if (!codeIntelHierarchy) {
			return [];
		}
		const cancel = new CancellationTokenSource();
		try {
			const found = await raceTimeout(codeIntelHierarchy.workspaceSymbols(query, limit, cancel.token), PROVIDER_TIMEOUT_MS, () => cancel.cancel());
			return (found ?? []).filter(symbol => this.policy(symbol.uri));
		} finally {
			cancel.dispose();
		}
	}

	async calls(uri: URI, line: number, column: number, direction: 'incoming' | 'outgoing'): Promise<ICallEdge[] | undefined> {
		const hierarchy = codeIntelHierarchy;
		if (!hierarchy) {
			return undefined;
		}
		const model = await this.model(uri);
		return this.ask(token => hierarchy.calls(model, new Position(line, column), direction, token));
	}

	async typeHierarchy(uri: URI, line: number, column: number, direction: 'supertypes' | 'subtypes'): Promise<ICodeSymbolRef[] | undefined> {
		const hierarchy = codeIntelHierarchy;
		if (!hierarchy) {
			return undefined;
		}
		const model = await this.model(uri);
		return this.ask(token => hierarchy.types(model, new Position(line, column), direction, token));
	}

	async rename(uri: URI, line: number, column: number, newName: string): Promise<readonly ITextFileChange[] | string> {
		const model = await this.model(uri);
		const position = new Position(line, column);
		const providers = this.languageFeatures.renameProvider.ordered(model);
		if (!providers.length) {
			return 'No language server offers rename for this file.';
		}
		for (const provider of providers) {
			const result = await this.ask(token => provider.provideRenameEdits(model, position, newName, token), EDIT_TIMEOUT_MS);
			if (result?.rejectReason) {
				return result.rejectReason;
			}
			if (result?.edits.length) {
				return this.textChanges(result);
			}
		}
		return 'The language server found nothing to rename there. Point at the symbol\'s name (line + symbol).';
	}

	async format(uri: URI): Promise<readonly ITextFileChange[] | string> {
		const model = await this.model(uri);
		const [provider] = this.languageFeatures.documentFormattingEditProvider.ordered(model);
		if (!provider) {
			return 'No formatter is registered for this file type. Run the project\'s formatter with shell instead.';
		}
		const options = model.getOptions();
		const edits = await this.ask(token => provider.provideDocumentFormattingEdits(model, { tabSize: options.tabSize, insertSpaces: options.insertSpaces }, token), EDIT_TIMEOUT_MS);
		if (!edits?.length) {
			return [];
		}
		const before = model.getValue();
		return [{ uri, before, after: applyTextEdits(model, edits) }];
	}

	async codeActions(uri: URI, range: ICodeRange, only: string | undefined): Promise<ICodeFix[]> {
		const offered = await this.offeredActions(uri, range, only);
		try {
			return offered.actions.map(({ action }) => ({
				title: action.title,
				...(action.kind ? { kind: action.kind } : {}),
				...(action.isPreferred ? { preferred: true } : {}),
				...(action.diagnostics?.length ? { fixes: action.diagnostics[0].message.split('\n')[0].slice(0, 160) } : {}),
				...(action.disabled ? { disabled: action.disabled } : {}),
			}));
		} finally {
			offered.dispose();
		}
	}

	async applyCodeAction(uri: URI, range: ICodeRange, only: string | undefined, title: string | undefined): Promise<readonly ITextFileChange[] | string> {
		const offered = await this.offeredActions(uri, range, only);
		try {
			const usable = offered.actions.filter(({ action }) => !action.disabled);
			const wanted = title?.trim().toLowerCase();
			const pick = wanted
				? usable.find(({ action }) => action.title.toLowerCase() === wanted) ?? usable.find(({ action }) => action.title.toLowerCase().includes(wanted))
				: usable.find(({ action }) => action.isPreferred) ?? (usable.length === 1 || only?.startsWith('source') ? usable[0] : undefined);
			if (!pick) {
				if (!usable.length) {
					return only === 'source.organizeImports' ? [] : `No ${only ?? 'code actions'} offered there.`;
				}
				return `${wanted ? `No action titled "${title}". ` : 'Several actions apply; pass title. '}Offered: ${usable.slice(0, 12).map(({ action }) => JSON.stringify(action.title)).join(', ')}.`;
			}
			let action: CodeAction | undefined = pick.action;
			if (!action.edit && pick.provider.resolveCodeAction) {
				const resolve = pick.provider.resolveCodeAction.bind(pick.provider);
				action = await this.ask(token => resolve(pick.action, token), EDIT_TIMEOUT_MS) ?? action;
			}
			if (!action.edit?.edits.length) {
				return action.command
					? `"${action.title}" runs an editor command (${action.command.id}) instead of returning an edit, so it cannot be applied here. Make the change with edit_file.`
					: `"${action.title}" returned no edit.`;
			}
			return this.textChanges(action.edit);
		} finally {
			offered.dispose();
		}
	}

	/** Every provider's actions for the range, kept with the provider that can resolve them. */
	private async offeredActions(uri: URI, range: ICodeRange, only: string | undefined): Promise<{ readonly actions: readonly { readonly action: CodeAction; readonly provider: CodeActionProvider }[]; dispose(): void }> {
		const model = await this.model(uri);
		const last = Math.min(Math.max(range.startLine, range.endLine), model.getLineCount());
		const first = Math.min(range.startLine, last);
		const editorRange = new Range(first, 1, last, model.getLineMaxColumn(last));
		const lists: IDisposable[] = [];
		const actions: { action: CodeAction; provider: CodeActionProvider }[] = [];
		for (const provider of this.languageFeatures.codeActionProvider.ordered(model)) {
			if (only && provider.providedCodeActionKinds?.length && !provider.providedCodeActionKinds.some(kind => kindMatches(kind, only) || kindMatches(only, kind))) {
				continue;
			}
			const list = await this.ask(token => provider.provideCodeActions(model, editorRange, { trigger: CodeActionTriggerType.Invoke, ...(only ? { only } : {}) }, token));
			if (!list) {
				continue;
			}
			lists.push(list);
			for (const action of list.actions) {
				if (!action.isAI && (!only || (action.kind && kindMatches(action.kind, only)))) {
					actions.push({ action, provider });
				}
			}
		}
		actions.sort((a, b) => Number(!!b.action.isPreferred) - Number(!!a.action.isPreferred));
		return { actions, dispose: () => lists.forEach(list => list.dispose()) };
	}

	/** The text edits of a workspace edit, applied per file to the text the editor has. */
	private async textChanges(edit: WorkspaceEdit): Promise<readonly ITextFileChange[] | string> {
		const byFile = new ResourceMap<TextEdit[]>();
		for (const item of edit.edits) {
			const textEdit = item as IWorkspaceTextEdit;
			if (!textEdit.resource || !textEdit.textEdit) {
				continue; // file creates/renames and custom edits are not applied by agents
			}
			const list = byFile.get(textEdit.resource) ?? [];
			list.push(textEdit.textEdit);
			byFile.set(textEdit.resource, list);
		}
		const changes: ITextFileChange[] = [];
		for (const [resource, edits] of byFile) {
			if (!this.policy(resource)) {
				return `The edit also changes ${resource.fsPath}, outside what language servers may touch.`;
			}
			const model = await this.model(resource);
			changes.push({ uri: resource, before: model.getValue(), after: applyTextEdits(model, edits) });
		}
		return changes;
	}

	/** One language server call, cancelled and treated as no answer after `timeout`. */
	private async ask<T>(call: (token: CancellationToken) => ProviderResult<T>, timeout = PROVIDER_TIMEOUT_MS): Promise<T | undefined> {
		const cancel = new CancellationTokenSource();
		try {
			const result = await raceTimeout(Promise.resolve(call(cancel.token)).catch(() => undefined), timeout, () => cancel.cancel());
			return result ?? undefined;
		} finally {
			cancel.dispose();
		}
	}

	/** Opens the document for its language service and waits for markers when it was just written. */
	private async freshen(uri: URI): Promise<void> {
		const wasOpen = this.open.has(uri);
		await this.model(uri).catch(() => undefined);
		const written = this.writes.get(uri);
		const recent = written !== undefined && Date.now() - written < FRESH_WRITE_MS;
		if (wasOpen && !recent) {
			return;
		}
		await new Promise<void>(resolve => {
			let settle: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				clearTimeout(cap);
				if (settle) {
					clearTimeout(settle);
				}
				listener.dispose();
				resolve();
			};
			const cap = setTimeout(done, MARKER_WAIT_MS);
			const listener = this.markerService.onMarkerChanged(changed => {
				if (changed.some(resource => resource.toString() === uri.toString())) {
					if (settle) {
						clearTimeout(settle);
					}
					settle = setTimeout(done, MARKER_SETTLE_MS);
				}
			});
		});
		this.writes.delete(uri);
	}

	private async model(uri: URI): Promise<ITextModel> {
		const existing = this.open.get(uri);
		if (existing) {
			clearTimeout(existing.timer);
			existing.timer = setTimeout(() => this.close(uri), KEEP_OPEN_MS);
			return existing.ref.object.textEditorModel;
		}
		const ref = await this.textModelService.createModelReference(uri);
		if (this.open.size >= MAX_OPEN) {
			const oldest = [...this.open.keys()][0];
			if (oldest) {
				this.close(oldest);
			}
		}
		this.open.set(uri, { ref, timer: setTimeout(() => this.close(uri), KEEP_OPEN_MS) });
		return ref.object.textEditorModel;
	}

	private close(uri: URI): void {
		const entry = this.open.get(uri);
		if (entry) {
			clearTimeout(entry.timer);
			entry.ref.dispose();
			this.open.delete(uri);
		}
	}

	private closeAll(): void {
		for (const uri of [...this.open.keys()]) {
			this.close(uri);
		}
	}

	private async withPreviews(locations: ICodeLocation[]): Promise<ICodeLocation[]> {
		const unique = dedupe(locations);
		const files = new ResourceMap<string[] | undefined>();
		for (const location of unique.slice(0, 80)) {
			if (!files.has(location.uri) && files.size < 30) {
				const text = await this.fileService.readFile(location.uri).then(file => file.value.toString(), () => undefined);
				files.set(location.uri, text?.split('\n'));
			}
		}
		return unique.map(location => {
			const line = files.get(location.uri)?.[location.line - 1]?.trim();
			return line ? { ...location, preview: line.length > 160 ? `${line.slice(0, 160)}\u2026` : line } : location;
		});
	}
}

/** `kind` is `scope` or below it (`refactor.extract` is under `refactor`). */
function kindMatches(kind: string, scope: string): boolean {
	return kind === scope || kind.startsWith(`${scope}.`);
}

/** The model's text with `edits` applied (ranges refer to the current text and must not overlap). */
export function applyTextEdits(model: ITextModel, edits: readonly TextEdit[]): string {
	const text = model.getValue();
	const spans = edits.map(edit => ({
		start: model.getOffsetAt({ lineNumber: edit.range.startLineNumber, column: edit.range.startColumn }),
		end: model.getOffsetAt({ lineNumber: edit.range.endLineNumber, column: edit.range.endColumn }),
		text: edit.text ?? '',
	})).sort((a, b) => b.start - a.start || b.end - a.end);
	let out = text;
	for (const span of spans) {
		out = out.slice(0, span.start) + span.text + out.slice(span.end);
	}
	return out;
}

function toLocation(item: Location | LocationLink): ICodeLocation {
	// Editor links carry `uri` + `range`, plus `targetSelectionRange` for the name itself.
	const range = (item as LocationLink).targetSelectionRange ?? item.range;
	return { uri: item.uri, line: range.startLineNumber, column: range.startColumn };
}

function dedupe(locations: readonly ICodeLocation[]): ICodeLocation[] {
	const seen = new Set<string>();
	return locations.filter(location => {
		const key = `${location.uri.toString()}:${location.line}:${location.column}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function toDiagnostic(marker: IMarker): IDiagnostic {
	const code = typeof marker.code === 'string' ? marker.code : marker.code?.value;
	return {
		uri: marker.resource,
		line: marker.startLineNumber,
		column: marker.startColumn,
		severity: marker.severity === MarkerSeverity.Error ? 'error' : marker.severity === MarkerSeverity.Warning ? 'warning' : 'info',
		message: marker.message,
		...(marker.source ? { source: marker.source } : {}),
		...(code ? { code: String(code) } : {}),
	};
}

function markerKey(marker: IMarker): string {
	const code = typeof marker.code === 'string' ? marker.code : marker.code?.value;
	return `${marker.source ?? marker.owner}:${code ?? ''}:${marker.message}`;
}
