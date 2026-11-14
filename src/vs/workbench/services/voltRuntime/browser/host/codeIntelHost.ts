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

/** A written file counts as just written this long: its next check waits for fresh markers. */
const FRESH_WRITE_MS = 15_000;
/** A written file's language service gets this long, counted from the write, to report on the new text. */
const MARKER_WAIT_MS = 3_000;
const MARKER_SETTLE_MS = 400;
/** A document opened this recently may still be activating its language's extension. */
const ACTIVATION_GRACE_MS = 1_000;

/** Files language services usually check (compilers, type checkers, linters). */
export const DIAGNOSED_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|cs|c|cc|cpp|h|hpp|php|rb|swift|dart|vue|svelte|css|scss|less|json)$/i;
/** Languages whose service the probe can ask directly (tsserver). */
const PROBED_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);
const PROBE_TIMEOUT_MS = 8_000;
const MAX_PROBED = 200;
/** An open document is compared with the file on disk at most this often (by etag, so unchanged files cost a stat). */
const RECHECK_DISK_MS = 1_000;
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
 * Asks a document's language service directly whether its current text has errors. Push-only
 * services (TypeScript) send nothing for a file that was clean and stays clean, so without this
 * answer a check can only wait out its cap. Set by the window's code intelligence contribution
 * (commands live outside this layer).
 */
export interface ICodeIntelErrorProbe {
	/** True: the language service checked this text and found no errors. Undefined: it cannot say. */
	errorFree(model: ITextModel, token: CancellationToken): Promise<boolean | undefined>;
	/** The language service's errors and warnings in the model's current text, asked directly; undefined when it cannot say. */
	errors?(model: ITextModel, token: CancellationToken): Promise<IDiagnostic[] | undefined>;
}

/**
 * What the probe found per file whose language service publishes no markers for it (TypeScript
 * reports only files open in a tab), keyed by the model version it checked. Shared by every host in
 * the window: the agent tools, the hooks and the runtime's end-of-turn check see the same errors.
 */
const probedErrors = new ResourceMap<{ readonly version: number; readonly errors: readonly IDiagnostic[] }>();

let codeIntelErrorProbe: ICodeIntelErrorProbe | undefined;

export function setCodeIntelErrorProbe(probe: ICodeIntelErrorProbe | undefined): void {
	codeIntelErrorProbe = probe;
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
	/** When markers last changed on a file written recently. */
	private readonly reported = new ResourceMap<number>();
	private readonly open = new ResourceMap<{ ref: IReference<IResolvedTextEditorModel>; timer: ReturnType<typeof setTimeout>; openedAt: number; checkedAt: number }>();
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
		this._register(this.markerService.onMarkerChanged(resources => {
			if (this.writes.size) {
				for (const resource of resources) {
					if (this.writes.has(resource)) {
						this.reported.set(resource, Date.now());
					}
				}
			}
		}));
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

	/**
	 * Called for every agent write, so the next diagnostics call waits for fresh results. The file
	 * is opened for its language service now, so it checks the new text while the agent goes on and
	 * the check at the turn's end rarely has to wait.
	 */
	noteWrite(uri: URI): void {
		const entry = this.open.get(uri);
		if (entry) {
			entry.checkedAt = 0; // the next use reads the file again
		}
		this.writes.set(uri, Date.now());
		this.reported.delete(uri);
		if (DIAGNOSED_EXTENSIONS.test(uri.path) && this.policy(uri)) {
			this.model(uri).catch(() => { /* deleted, or not a text file */ });
		}
	}

	/** Opens the file for its language service without waiting, so a later check finds its markers ready. */
	warm(uri: URI): void {
		if (DIAGNOSED_EXTENSIONS.test(uri.path) && this.policy(uri)) {
			this.model(uri).catch(() => { /* deleted, or not a text file */ });
		}
	}

	/**
	 * The file's error counts once its language service has reported on its current text; undefined
	 * when it has not within `waitMs` (then nothing can tell an edit's new errors from old ones).
	 */
	async settledErrorCounts(uri: URI, waitMs: number): Promise<Map<string, number> | undefined> {
		if (!this.policy(uri) || !DIAGNOSED_EXTENSIONS.test(uri.path)) {
			return undefined;
		}
		const settled = await raceTimeout(this.freshen(uri).then(() => true, () => false), waitMs);
		return settled ? this.errorCounts(uri) : undefined;
	}

	/** Error markers on a file right now, counted by message (line numbers shift with edits). */
	errorCounts(uri: URI): Map<string, number> {
		const counts = new Map<string, number>();
		for (const key of this.currentErrors(uri, 'error').map(item => item.key)) {
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return counts;
	}

	/** The file's markers, or when none report on it, what the probe last found in its current text. */
	private currentErrors(uri: URI, severity: 'error' | 'warning' | 'all'): { readonly key: string; readonly diagnostic: IDiagnostic }[] {
		const severities = severity === 'error' ? MarkerSeverity.Error : severity === 'warning' ? MarkerSeverity.Error | MarkerSeverity.Warning : MarkerSeverity.Error | MarkerSeverity.Warning | MarkerSeverity.Info;
		const markers = this.markerService.read({ resource: uri, severities });
		if (markers.length || this.markerService.read({ resource: uri, take: 1 }).length) {
			return markers.map(marker => ({ key: markerKey(marker), diagnostic: toDiagnostic(marker) }));
		}
		const probed = probedErrors.get(uri);
		const model = this.open.get(uri)?.ref.object.textEditorModel;
		if (!probed || (model && !model.isDisposed() && model.getVersionId() !== probed.version)) {
			return [];
		}
		return probed.errors.filter(item => severity !== 'error' || item.severity === 'error').map(item => ({ key: `${item.source ?? ''}:${item.code ?? ''}:${item.message}`, diagnostic: item }));
	}

	/** Asks the language service directly for a file nothing publishes markers for (see {@link probedErrors}). */
	private async probe(uri: URI, model: ITextModel): Promise<void> {
		const probe = codeIntelErrorProbe;
		if (!probe?.errors || this.markerService.read({ resource: uri, take: 1 }).length) {
			return;
		}
		const version = model.getVersionId();
		if (probedErrors.get(uri)?.version === version) {
			return;
		}
		const cancel = new CancellationTokenSource();
		const timer = setTimeout(() => cancel.cancel(), PROBE_TIMEOUT_MS);
		try {
			const errors = await probe.errors(model, cancel.token).catch(() => undefined);
			if (errors && !model.isDisposed() && model.getVersionId() === version) {
				probedErrors.set(uri, { version, errors });
				if (probedErrors.size > MAX_PROBED) {
					probedErrors.delete([...probedErrors.keys()][0]);
				}
			}
		} finally {
			clearTimeout(timer);
			cancel.dispose();
		}
	}

	/** Errors on `uri` beyond those in `baseline`. Opens the file and waits for fresh markers first. */
	async newErrors(uri: URI, baseline: ReadonlyMap<string, number>): Promise<IDiagnostic[]> {
		if (!this.policy(uri)) {
			return []; // opening it would start a language server for this checkout
		}
		await this.freshen(uri);
		const seen = new Map<string, number>();
		const added: IDiagnostic[] = [];
		for (const { key, diagnostic } of this.currentErrors(uri, 'error')) {
			const count = (seen.get(key) ?? 0) + 1;
			seen.set(key, count);
			if (count > (baseline.get(key) ?? 0)) {
				added.push(diagnostic);
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
		return uris.flatMap(uri => this.currentErrors(uri, severity).map(item => item.diagnostic));
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

	/**
	 * Opens the document for its language service and, when it was just written, waits for markers
	 * on the new text: until they settle, at most {@link MARKER_WAIT_MS} after the write. A clean file
	 * gets no marker event at all, so the wait is counted from the write (when the file was opened,
	 * see {@link noteWrite}), not from this call. When the language service itself answers that the
	 * new text has no errors ({@link ICodeIntelErrorProbe}), the wait ends {@link MARKER_SETTLE_MS}
	 * after the write instead. A file no language service owns is not waited for.
	 */
	private async freshen(uri: URI): Promise<void> {
		const wasOpen = this.open.has(uri);
		const model = await this.model(uri).catch(() => undefined);
		if (model && this.writes.has(uri)) {
			await this.catchUpWithDisk(uri, model);
		}
		// A file the language service publishes no markers for (TypeScript outside editor tabs) has
		// nothing to wait for: its service is asked directly about the current text.
		if (model && codeIntelErrorProbe?.errors && PROBED_LANGUAGES.has(model.getLanguageId()) && !this.markerService.read({ resource: uri, take: 1 }).length) {
			this.forgetWrite(uri);
			await this.probe(uri, model);
			if (probedErrors.get(uri)?.version === model.getVersionId()) {
				return;
			}
		}
		await this.freshenMarkers(uri, wasOpen, model);
	}

	/** After a write on disk: the model holds the written text before anyone is asked about it. */
	private async catchUpWithDisk(uri: URI, model: ITextModel): Promise<void> {
		const entry = this.open.get(uri);
		for (let attempt = 0; entry && attempt < 5 && !model.isDisposed(); attempt++) {
			const disk = await this.fileService.readFile(uri).then(file => file.value.toString(), () => undefined);
			if (disk === undefined || (disk.charCodeAt(0) === 0xFEFF ? disk.slice(1) : disk) === model.getValue()) {
				return;
			}
			await reloadFromDisk(entry.ref.object, true);
			if (attempt) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		}
	}

	private async freshenMarkers(uri: URI, wasOpen: boolean, model: ITextModel | undefined): Promise<void> {
		const written = this.writes.get(uri);
		const recent = written !== undefined && Date.now() - written < FRESH_WRITE_MS;
		if (!model || (wasOpen && !recent)) {
			this.forgetWrite(uri);
			return;
		}
		const since = recent ? written : Date.now();
		if (!this.hasLanguageService(model)) {
			const openedAt = this.open.get(uri)?.openedAt ?? 0;
			const grace = openedAt + ACTIVATION_GRACE_MS - Date.now();
			if (grace > 0) {
				await new Promise(resolve => setTimeout(resolve, grace));
			}
			if (!this.hasLanguageService(model)) {
				this.forgetWrite(uri);
				return; // nothing will report on it
			}
		}
		const cancel = new CancellationTokenSource();
		await new Promise<void>(resolve => {
			let finished = false;
			let settle: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				if (finished) {
					return;
				}
				finished = true;
				clearTimeout(cap);
				if (settle) {
					clearTimeout(settle);
				}
				listener.dispose();
				cancel.cancel();
				resolve();
			};
			const settleFrom = (at: number) => {
				if (settle) {
					clearTimeout(settle);
				}
				settle = setTimeout(done, Math.max(0, at + MARKER_SETTLE_MS - Date.now()));
			};
			let cap = setTimeout(done, Math.max(0, since + MARKER_WAIT_MS - Date.now()));
			const listener = this.markerService.onMarkerChanged(changed => {
				if (changed.some(resource => resource.toString() === uri.toString())) {
					settleFrom(Date.now());
				}
			});
			// The language service already reported on the new text while the agent went on.
			const reported = this.reported.get(uri);
			if (reported !== undefined && reported >= since) {
				settleFrom(reported);
				return;
			}
			// A clean file gets no marker event at all: the language service's own answer that the
			// text has no errors ends the wait. Other providers (linters) still get the settle window
			// counted from the write, and a marker change in it is still waited for.
			this.confirmedErrorFree(model, cancel.token).then(clean => {
				if (clean && !finished && !settle && !this.hasErrorMarkers(uri)) {
					clearTimeout(cap);
					cap = setTimeout(done, Math.max(0, since + MARKER_SETTLE_MS - Date.now()));
				}
			});
		});
		cancel.dispose();
		this.forgetWrite(uri);
	}

	/**
	 * The language service checked the text the agent wrote (the open model matches the file on
	 * disk) and found no errors in it. False when there is no such answer.
	 */
	private async confirmedErrorFree(model: ITextModel, token: CancellationToken): Promise<boolean> {
		const probe = codeIntelErrorProbe;
		if (!probe) {
			return false;
		}
		const disk = await this.fileService.readFile(model.uri).then(file => file.value.toString(), () => undefined);
		if (disk === undefined || model.isDisposed() || token.isCancellationRequested || (disk.charCodeAt(0) === 0xFEFF ? disk.slice(1) : disk) !== model.getValue()) {
			return false; // the model has not caught up with the write yet: its answer would be for older text
		}
		const version = model.getVersionId();
		const clean = await probe.errorFree(model, token).catch(() => undefined);
		return clean === true && !model.isDisposed() && model.getVersionId() === version;
	}

	private hasErrorMarkers(uri: URI): boolean {
		return this.markerService.read({ resource: uri, severities: MarkerSeverity.Error, take: 1 }).length > 0;
	}

	private forgetWrite(uri: URI): void {
		this.writes.delete(uri);
		this.reported.delete(uri);
	}

	/** Some language service reports on or answers for this document (markers, symbols, hovers, fixes). */
	private hasLanguageService(model: ITextModel): boolean {
		return this.markerService.read({ resource: model.uri, take: 1 }).length > 0
			|| this.languageFeatures.documentSymbolProvider.has(model)
			|| this.languageFeatures.hoverProvider.has(model)
			|| this.languageFeatures.definitionProvider.has(model)
			|| this.languageFeatures.codeActionProvider.has(model);
	}

	private readonly opening = new ResourceMap<Promise<ITextModel>>();

	private async model(uri: URI): Promise<ITextModel> {
		const existing = this.open.get(uri);
		if (existing) {
			clearTimeout(existing.timer);
			existing.timer = setTimeout(() => this.close(uri), KEEP_OPEN_MS);
			if (Date.now() - existing.checkedAt > RECHECK_DISK_MS) {
				existing.checkedAt = Date.now();
				await reloadFromDisk(existing.ref.object);
			}
			return existing.ref.object.textEditorModel;
		}
		// A write and a check can ask for the same file at once: one reference, not two.
		const pending = this.opening.get(uri);
		if (pending) {
			return pending;
		}
		const opened = this.textModelService.createModelReference(uri).then(ref => {
			if (this._store.isDisposed) {
				ref.dispose();
				throw new Error('code intelligence was disposed');
			}
			if (this.open.size >= MAX_OPEN) {
				const oldest = [...this.open.keys()][0];
				if (oldest) {
					this.close(oldest);
				}
			}
			this.open.set(uri, { ref, timer: setTimeout(() => this.close(uri), KEEP_OPEN_MS), openedAt: Date.now(), checkedAt: Date.now() });
			return ref.object.textEditorModel;
		}).finally(() => this.opening.delete(uri));
		this.opening.set(uri, opened);
		return opened;
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

/**
 * A project chat's files are outside the window's folders, where no file watcher reloads their
 * models: a model kept the text it was opened with, so after a CLI agent's edit on disk the language
 * server went on answering about the old text (no new errors, stale bodies and lines). A text file
 * model that is not dirty is resolved again (the file is read only if its etag changed).
 */
async function reloadFromDisk(model: object, force?: boolean): Promise<void> {
	const file = model as { isDirty?(): boolean; resolve?(options?: { forceReadFromFile?: boolean }): Promise<void> };
	if (typeof file.resolve === 'function' && typeof file.isDirty === 'function' && !file.isDirty()) {
		await file.resolve(force ? { forceReadFromFile: true } : undefined).catch(() => { /* deleted or unreadable: keep what is there */ });
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
