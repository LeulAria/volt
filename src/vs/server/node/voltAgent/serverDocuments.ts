/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../base/common/map.js';
import { URI } from '../../../base/common/uri.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { AgentServerProtocol } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { fromWire, toWire } from '../../../platform/voltAgentServer/common/wire.js';
import { IToolDocuments, setRuntimeToolDocuments } from '../../../workbench/services/voltRuntime/browser/tools/fileTools.js';

/** A window that does not apply an agent's edit by then is skipped: the edit goes to disk instead. */
const WRITE_OPEN_TIMEOUT_MS = 15_000;

interface IOpenDocument {
	readonly connectionId: number;
	readonly text: string;
}

/**
 * Editors with unsaved changes, as the windows report them: the agents' file tools read that text
 * instead of what is on disk, and an edit to such a file goes into the window's buffer (and saves),
 * so it never lands behind what the user is typing.
 */
export class ServerDocuments extends Disposable implements IToolDocuments {

	private readonly dirty = new ResourceMap<IOpenDocument>();

	constructor(
		private readonly protocol: AgentServerProtocol,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(protocol.registerMethods('documents', {
			/** `[uri, text | null][]`: a window's unsaved documents changed (null: saved, reverted or closed). */
			update: (ctx, changes) => {
				if (ctx.client.role !== 'owner' || !Array.isArray(changes)) {
					return false;
				}
				for (const change of changes) {
					if (!Array.isArray(change)) {
						continue;
					}
					const uri = fromWire<unknown>(change[0]);
					if (!URI.isUri(uri)) {
						continue;
					}
					if (typeof change[1] === 'string') {
						this.dirty.set(uri, { connectionId: ctx.client.connectionId, text: change[1] });
					} else if (this.dirty.get(uri)?.connectionId === ctx.client.connectionId) {
						this.dirty.delete(uri);
					}
				}
				return true;
			},
			/** A window (re)connected: what it holds replaces what it held. */
			reset: (ctx) => {
				this.dropConnection(ctx.client.connectionId);
				return true;
			},
		}));
		this._register(protocol.onDidChangeClients(() => {
			const live = new Set(protocol.listClients().map(client => client.connectionId));
			for (const [uri, document] of [...this.dirty]) {
				if (!live.has(document.connectionId)) {
					this.dirty.delete(uri);
				}
			}
		}));
		setRuntimeToolDocuments(this);
		this._register(toDisposable(() => setRuntimeToolDocuments(undefined)));
	}

	dirtyText(uri: URI): string | undefined {
		return this.dirty.get(uri)?.text;
	}

	async writeOpen(uri: URI, text: string): Promise<boolean> {
		const document = this.dirty.get(uri);
		if (!document) {
			return false;
		}
		try {
			const written = await this.protocol.callConnection<boolean>(document.connectionId, 'documents.writeOpen', [toWire(uri), text], WRITE_OPEN_TIMEOUT_MS);
			if (written) {
				// The window saved it: disk is current again.
				if (this.dirty.get(uri) === document) {
					this.dirty.delete(uri);
				}
				return true;
			}
		} catch (err) {
			this.logService.warn(`[volt agent server] the window holding ${uri.fsPath} did not take the agent's edit; writing it to disk`, err);
		}
		return false;
	}

	private dropConnection(connectionId: number): void {
		for (const [uri, document] of [...this.dirty]) {
			if (document.connectionId === connectionId) {
				this.dirty.delete(uri);
			}
		}
	}
}
