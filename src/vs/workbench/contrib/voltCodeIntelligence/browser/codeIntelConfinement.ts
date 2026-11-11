/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { ICallEdge, ICodeIntelHost, ICodeLocation, ICodeNavIndex, ICodeRange, ICodeSymbolRef, ITextFileChange } from '../../../services/voltRuntime/browser/tools/codeTools.js';

/** A sandboxed chat's path rules: the gate's, on absolute paths (through symlinks). */
export interface ICodeIntelRules {
	readonly readRefusal: (path: string) => Promise<string | undefined>;
	/** Absent: Volt cannot tell where the chat may write, so no language server edit is written. */
	readonly writeRefusal?: (path: string) => Promise<string | undefined>;
}

/** What hover answers instead when the symbol is declared in a file the chat may not read. */
export const HOVER_WITHHELD = 'Type information withheld: the symbol is declared in a file this chat\'s sandbox may not read.';

/**
 * The editor's language servers and Volt's code index for a sandboxed chat (B-15). Both read the
 * whole project from Volt's processes, so what they answer is cut down to what the chat's sandbox
 * may read: locations, symbols, hierarchy edges and diagnostics in other files are dropped; a file's
 * text, outline and words are given only for readable files; hover is withheld when the symbol is
 * declared in a file the chat may not read. An edit (a rename, a format, a fix) is refused whole,
 * before anything is written, when any file it changes is one the chat may not read or write.
 * Each path is judged once per call.
 */
export function confineCodeIntel(host: ICodeIntelHost, nav: ICodeNavIndex | undefined, rules: ICodeIntelRules): { readonly host: ICodeIntelHost; readonly nav: ICodeNavIndex | undefined } {
	const judged = new Map<string, Promise<boolean>>();
	const readable = (uri: URI): Promise<boolean> => {
		if (uri.scheme !== Schemas.file) {
			return Promise.resolve(false);
		}
		let known = judged.get(uri.fsPath);
		if (!known) {
			known = rules.readRefusal(uri.fsPath).then(why => !why, () => false);
			judged.set(uri.fsPath, known);
		}
		return known;
	};
	const keep = async <T extends { readonly uri: URI }>(items: readonly T[]): Promise<T[]> => {
		const flags = await Promise.all(items.map(item => readable(item.uri)));
		return items.filter((_, index) => flags[index]);
	};
	const writable = async (changes: readonly ITextFileChange[] | string): Promise<readonly ITextFileChange[] | string> => {
		if (typeof changes === 'string') {
			return changes;
		}
		for (const change of changes) {
			if (change.before === change.after) {
				continue;
			}
			const why = !await readable(change.uri) ? 'it may not read it'
				: !rules.writeRefusal ? 'Volt cannot tell which files this sandboxed chat may write'
					: await rules.writeRefusal(change.uri.fsPath);
			if (why) {
				return `Nothing was changed: the edit also changes ${change.uri.scheme === Schemas.file ? change.uri.fsPath : change.uri.toString()}, which this chat's sandbox may not write (${why}). Make the change with your own edit tools, where the sandbox allows.`;
			}
		}
		return changes;
	};
	const ifReadable = async <T>(uri: URI, answer: () => Promise<T>, otherwise: T): Promise<T> => await readable(uri) ? answer() : otherwise;
	const confined: ICodeIntelHost = {
		diagnostics: async (uris, severity) => keep(await host.diagnostics(uris, severity)),
		definitions: async (uri, line, column) => keep(await ifReadable(uri, () => host.definitions(uri, line, column), [])),
		references: async (uri, line, column) => keep(await ifReadable(uri, () => host.references(uri, line, column), [])),
		symbols: uri => ifReadable(uri, () => host.symbols(uri), []),
		columnOf: (uri, line, symbol) => ifReadable(uri, () => host.columnOf(uri, line, symbol), undefined),
		lspAllowed: uri => host.lspAllowed(uri),
		wordAt: (uri, line, column) => ifReadable(uri, () => host.wordAt(uri, line, column), undefined),
	};
	const { fileText, implementations, typeDefinitions, hover, workspaceSymbols, calls, typeHierarchy, rename, format, codeActions, applyCodeAction } = host;
	if (fileText) {
		confined.fileText = (uri: URI) => ifReadable(uri, () => fileText.call(host, uri), undefined);
	}
	if (implementations) {
		confined.implementations = async (uri: URI, line: number, column: number) => keep(await ifReadable<ICodeLocation[]>(uri, () => implementations.call(host, uri, line, column), []));
	}
	if (typeDefinitions) {
		confined.typeDefinitions = async (uri: URI, line: number, column: number) => keep(await ifReadable<ICodeLocation[]>(uri, () => typeDefinitions.call(host, uri, line, column), []));
	}
	if (hover) {
		confined.hover = async (uri: URI, line: number, column: number) => {
			const text = await ifReadable(uri, () => hover.call(host, uri, line, column), undefined);
			if (!text) {
				return text;
			}
			// The type and docs come from the declaration: withheld when that is in a file the chat may not read.
			const declared = await host.definitions(uri, line, column).catch((): ICodeLocation[] => []);
			return (await keep(declared)).length === declared.length ? text : HOVER_WITHHELD;
		};
	}
	if (workspaceSymbols) {
		confined.workspaceSymbols = async (query: string, limit: number) => keep<ICodeSymbolRef>(await workspaceSymbols.call(host, query, limit));
	}
	if (calls) {
		confined.calls = async (uri: URI, line: number, column: number, direction: 'incoming' | 'outgoing') => {
			const edges = await ifReadable(uri, () => calls.call(host, uri, line, column, direction), undefined);
			return edges && keep<ICallEdge>(edges);
		};
	}
	if (typeHierarchy) {
		confined.typeHierarchy = async (uri: URI, line: number, column: number, direction: 'supertypes' | 'subtypes') => {
			const types = await ifReadable(uri, () => typeHierarchy.call(host, uri, line, column, direction), undefined);
			return types && keep<ICodeSymbolRef>(types);
		};
	}
	if (rename) {
		confined.rename = async (uri: URI, line: number, column: number, newName: string) => writable(await rename.call(host, uri, line, column, newName));
	}
	if (format) {
		confined.format = async (uri: URI) => writable(await format.call(host, uri));
	}
	if (codeActions) {
		confined.codeActions = (uri: URI, range: ICodeRange, only: string | undefined) => ifReadable(uri, () => codeActions.call(host, uri, range, only), []);
	}
	if (applyCodeAction) {
		confined.applyCodeAction = async (uri: URI, range: ICodeRange, only: string | undefined, title: string | undefined) => writable(await applyCodeAction.call(host, uri, range, only, title));
	}
	const confinedNav: ICodeNavIndex | undefined = nav && {
		definitions: async (root, name) => {
			const found = await nav.definitions(root, name);
			return found && keep(found);
		},
		references: async (root, name) => {
			const found = await nav.references(root, name);
			return found && keep(found);
		},
		outline: (root, uri) => ifReadable(uri, () => nav.outline(root, uri), undefined),
	};
	return { host: confined, nav: confinedNav };
}
