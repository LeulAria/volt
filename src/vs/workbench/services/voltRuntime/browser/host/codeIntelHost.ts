/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable, IReference } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { URI } from '../../../../../base/common/uri.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { DocumentSymbol, Location, LocationLink } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { ICodeIntelHost, ICodeLocation, ICodeSymbol, IDiagnostic } from '../tools/codeTools.js';

const SYMBOL_KINDS = ['file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];

/** A written file gets this long for its language service to report on the new text. */
const FRESH_WRITE_MS = 15_000;
const MARKER_WAIT_MS = 3_000;
const MARKER_SETTLE_MS = 400;
/** Opened documents stay open a while so repeated checks are instant. */
const KEEP_OPEN_MS = 90_000;
const MAX_OPEN = 24;

export class CodeIntelHost extends Disposable implements ICodeIntelHost {

	private readonly writes = new ResourceMap<number>();
	private readonly open = new ResourceMap<{ ref: IReference<IResolvedTextEditorModel>; timer: ReturnType<typeof setTimeout> }>();

	constructor(
		private readonly markerService: IMarkerService,
		private readonly textModelService: ITextModelService,
		private readonly languageFeatures: ILanguageFeaturesService,
		private readonly fileService: IFileService,
	) {
		super();
		this._register({ dispose: () => this.closeAll() });
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
		const text = model.getLineContent(line);
		const exact = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).exec(text);
		const index = exact ? exact.index : text.indexOf(symbol);
		return index >= 0 ? index + 1 : undefined;
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
			return line ? { ...location, preview: line.length > 160 ? `${line.slice(0, 160)}…` : line } : location;
		});
	}
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
