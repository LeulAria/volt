/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { AgentServerMethod, IAgentServerClientInfo } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { VOLT_FEATURES, voltFeatureDisabledTools } from '../../../workbench/contrib/voltCustomize/common/voltFeatures.js';
import { IVoltHostToolService } from '../../../workbench/services/voltRuntime/common/hostTools.js';

/** The features turned off globally, as the last Volt window on this computer said. */
export const DISABLED_FEATURES_STORAGE_KEY = 'volt.features.disabledGlobally';

/** What this needs of the protocol server (a narrow view, so tests can drive it). */
export interface IFeatureEnablementProtocol {
	registerMethod(name: string, method: AgentServerMethod): IDisposable;
	listClients(): IAgentServerClientInfo[];
	readonly onDidChangeClients: Event<void>;
}

/**
 * The server-side mirror of which Volt features are on (customize.md 6.1d, spec H.11). A window
 * turns a feature off by disabling its built-in extension; the agents run here, with the server's
 * own tools (browser, terminals, memory, tasks), so the window sends its state
 * (`features.setDisabled`) and the server takes those features' tools away from its agents: off the
 * host MCP server's list for new sessions and refused if called.
 *
 * - A global choice from a Volt window on this computer (an owner) is kept in the server's storage,
 *   so it holds after a restart and while no window is connected.
 * - A workspace-only choice holds while that window is connected. The server's tools serve every
 *   chat, so it applies to all of them meanwhile (the stricter reading).
 * - A paired device can only turn more off for as long as it is connected, never back on.
 */
export class ServerFeatureEnablement extends Disposable {

	private global: ReadonlySet<string>;
	private readonly byConnection = new Map<number, ReadonlySet<string>>();

	constructor(
		protocol: IFeatureEnablementProtocol,
		private readonly hostTools: IVoltHostToolService,
		private readonly storage: IStorageService,
	) {
		super();
		this.global = new Set(readIds(storage.get(DISABLED_FEATURES_STORAGE_KEY, StorageScope.APPLICATION)));
		this._register(protocol.registerMethod('features.setDisabled', (ctx, state) => {
			const record = state && typeof state === 'object' && !Array.isArray(state) ? state as { global?: unknown; workspace?: unknown } : {};
			const global = new Set(knownFeatures(record.global));
			const workspace = knownFeatures(record.workspace);
			if (ctx.client.role === 'owner') {
				this.setGlobal(global);
				this.byConnection.set(ctx.client.connectionId, new Set(workspace));
			} else {
				this.byConnection.set(ctx.client.connectionId, new Set([...global, ...workspace]));
			}
			this.apply();
			return true;
		}));
		this._register(protocol.onDidChangeClients(() => {
			const live = new Set(protocol.listClients().map(client => client.connectionId));
			let changed = false;
			for (const connectionId of [...this.byConnection.keys()]) {
				if (!live.has(connectionId)) {
					this.byConnection.delete(connectionId);
					changed = true;
				}
			}
			if (changed) {
				this.apply();
			}
		}));
		this.apply();
	}

	/** The features off for the server's agents now. */
	disabledFeatures(): ReadonlySet<string> {
		const all = new Set(this.global);
		for (const ids of this.byConnection.values()) {
			for (const id of ids) {
				all.add(id);
			}
		}
		return all;
	}

	private setGlobal(next: ReadonlySet<string>): void {
		if (next.size === this.global.size && [...next].every(id => this.global.has(id))) {
			return;
		}
		this.global = next;
		if (next.size) {
			this.storage.store(DISABLED_FEATURES_STORAGE_KEY, JSON.stringify([...next].sort()), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} else {
			this.storage.remove(DISABLED_FEATURES_STORAGE_KEY, StorageScope.APPLICATION);
		}
	}

	private apply(): void {
		const off = this.disabledFeatures();
		this.hostTools.setDisabledTools(voltFeatureDisabledTools(VOLT_FEATURES.filter(feature => feature.extensionId && off.has(feature.id))));
	}
}

/** Ids of features that can be turned off (core features have no switch); anything else is dropped. */
function knownFeatures(value: unknown): string[] {
	const optional = new Set(VOLT_FEATURES.filter(feature => feature.extensionId).map(feature => feature.id));
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && optional.has(id)) : [];
}

function readIds(raw: string | undefined): string[] {
	try {
		return knownFeatures(raw ? JSON.parse(raw) : []);
	} catch {
		return [];
	}
}
