/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqualOrParent } from '../../../base/common/extpath.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isLinux } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { fromWire, toWire } from '../../../platform/voltAgentServer/common/wire.js';
import { columnOfSymbol, IRuntimeCodeIntel } from '../../../workbench/services/voltRuntime/browser/host/codeIntelHost.js';
import { ICodeLocation, ICodeSymbol, IDiagnostic } from '../../../workbench/services/voltRuntime/browser/tools/codeTools.js';
import { LSP_ENABLED_SETTING } from '../../../workbench/services/voltRuntime/common/codeIntelligence.js';
import { IAgentServerClients } from './serverClients.js';

const NO_WINDOW = 'Diagnostics come from the language servers of an open Volt window, and none is open. Run the project\'s type checker or linter instead.';
/** A language server may still be starting (tsserver on a big project): navigation and diagnostics wait this long. */
const QUERY_TIMEOUT_MS = 30_000;
/** Marker counts and write notices are answered from memory. */
const QUICK_TIMEOUT_MS = 10_000;

/**
 * The folders each connected window has open. A file's code intelligence goes to the window that
 * has it open: another project's window would treat it as outside its workspace (or have no
 * language server for it at all).
 */
export class WindowFolders {

	private readonly byConnection = new Map<number, readonly string[]>();

	set(connectionId: number, folders: unknown): void {
		const paths = Array.isArray(folders) ? folders.filter((folder): folder is string => typeof folder === 'string' && folder.length > 0) : [];
		if (paths.length) {
			this.byConnection.set(connectionId, paths);
		} else {
			this.byConnection.delete(connectionId);
		}
	}

	/** Forgets windows that disconnected. */
	retain(live: ReadonlySet<number>): void {
		for (const connectionId of this.byConnection.keys()) {
			if (!live.has(connectionId)) {
				this.byConnection.delete(connectionId);
			}
		}
	}

	/** The windows whose innermost open folder holds `uri`; undefined when none does. */
	prefer(uri: URI | undefined): ((connectionId: number) => boolean) | undefined {
		if (!uri || uri.scheme !== 'file' || !this.byConnection.size) {
			return undefined;
		}
		let depth = -1;
		let best = new Set<number>();
		for (const [connectionId, folders] of this.byConnection) {
			for (const folder of folders) {
				if (folder.length >= depth && isEqualOrParent(uri.fsPath, folder, !isLinux)) {
					if (folder.length > depth) {
						depth = folder.length;
						best = new Set();
					}
					best.add(connectionId);
				}
			}
		}
		return best.size ? connectionId => best.has(connectionId) : undefined;
	}
}

/**
 * Code intelligence for agents in the server: the language servers live in a Volt window, so the
 * calls go to a connected window that offers `codeIntel` (it applies its own Settings > Code
 * Intelligence policy). With no window, navigation falls back to the code index and diagnostics
 * say why they can't answer instead of reporting "no errors".
 */
export class ServerCodeIntel extends Disposable implements IRuntimeCodeIntel {

	/** Baselines still being read from the window, by the map they fill. */
	private readonly pendingBaselines = new WeakMap<Map<string, number>, Promise<void>>();

	constructor(
		private readonly clients: IAgentServerClients,
		private readonly configurationService: IConfigurationService,
		private readonly fileService: IFileService,
		private readonly folders: WindowFolders = new WindowFolders(),
	) {
		super();
	}

	private get window(): boolean {
		return this.clients.has('codeIntel');
	}

	/** Asks the window that has `target` open (else the newest), giving up after `timeoutMs`. */
	private call<T>(target: URI | undefined, timeoutMs: number, method: string, ...params: unknown[]): Promise<T> {
		// Locations and diagnostics carry URIs: revive them, or the tools get plain objects.
		return this.clients.callWith<unknown>('codeIntel', { prefer: this.folders.prefer(target), timeoutMs }, `codeIntel.${method}`, ...params.map(param => toWire(param)))
			.then(result => fromWire<T>(result));
	}

	/** The window decides per file (worktrees are opt-in there); this only honors the switch. */
	setLspPolicy(): void { }

	lspAllowed(_uri: URI): boolean {
		return this.configurationService.getValue<boolean>(LSP_ENABLED_SETTING) !== false;
	}

	noteWrite(uri: URI): void {
		if (this.window) {
			this.call(uri, QUICK_TIMEOUT_MS, 'noteWrite', uri).catch(() => { /* the window went away */ });
		}
	}

	errorCounts(uri: URI): Map<string, number> {
		const counts = new Map<string, number>();
		if (this.window) {
			this.pendingBaselines.set(counts, this.call<[string, number][]>(uri, QUICK_TIMEOUT_MS, 'errorCounts', uri).then(entries => {
				for (const entry of Array.isArray(entries) ? entries : []) {
					if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') {
						counts.set(entry[0], entry[1]);
					}
				}
			}, () => { /* no baseline: every error counts as new */ }));
		}
		return counts;
	}

	async newErrors(uri: URI, baseline: ReadonlyMap<string, number>): Promise<IDiagnostic[]> {
		if (!this.window) {
			return [];
		}
		await this.pendingBaselines.get(baseline as Map<string, number>);
		return asArray<IDiagnostic>(await this.call<IDiagnostic[]>(uri, QUERY_TIMEOUT_MS, 'newErrors', uri, [...baseline]).catch(() => []));
	}

	async diagnostics(uris: readonly URI[] | undefined, severity: 'error' | 'warning' | 'all'): Promise<IDiagnostic[]> {
		if (!this.window) {
			throw new Error(NO_WINDOW);
		}
		return asArray<IDiagnostic>(await this.call<IDiagnostic[]>(uris?.[0], QUERY_TIMEOUT_MS, 'diagnostics', uris, severity));
	}

	async definitions(uri: URI, line: number, column: number): Promise<ICodeLocation[]> {
		return this.window ? asArray<ICodeLocation>(await this.call<ICodeLocation[]>(uri, QUERY_TIMEOUT_MS, 'definitions', uri, line, column).catch(() => [])) : [];
	}

	async references(uri: URI, line: number, column: number): Promise<ICodeLocation[]> {
		return this.window ? asArray<ICodeLocation>(await this.call<ICodeLocation[]>(uri, QUERY_TIMEOUT_MS, 'references', uri, line, column).catch(() => [])) : [];
	}

	async symbols(uri: URI): Promise<ICodeSymbol[]> {
		return this.window ? asArray<ICodeSymbol>(await this.call<ICodeSymbol[]>(uri, QUERY_TIMEOUT_MS, 'symbols', uri).catch(() => [])) : [];
	}

	async columnOf(uri: URI, line: number, symbol: string): Promise<number | undefined> {
		const text = await this.readLine(uri, line);
		return text === undefined ? undefined : columnOfSymbol(text, symbol);
	}

	async wordAt(uri: URI, line: number, column: number): Promise<string | undefined> {
		const content = await this.readLine(uri, line);
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

	private async readLine(uri: URI, line: number): Promise<string | undefined> {
		if (!Number.isInteger(line) || line < 1) {
			return undefined;
		}
		const text = await this.fileService.readFile(uri).then(file => file.value.toString(), () => undefined);
		return text?.split(/\r?\n/)[line - 1];
	}
}

/** A window's answer, or nothing when it sent something else (an older window, a dropped call). */
function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? value as T[] : [];
}
