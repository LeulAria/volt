/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AGENT_BROWSER_ACCESS_SETTING, BrowserBlockReason, browserBlockReason, IVoltBrowserAccessService } from '../common/browserAccess.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.browser',
	title: localize('voltBrowser.configTitle', "Volt Browser"),
	type: 'object',
	properties: {
		[AGENT_BROWSER_ACCESS_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltBrowser.allowAgents', "Let agents open, read and click in the in-app browser. When off, the browser tools refuse with a message the agent sees. Each chat can still turn browser access on or off from the browser's menu."),
		},
	},
});

const STORAGE_KEY = 'volt.browser.agentAccess.chats';
/** Choices kept; the oldest go first. */
const MAX_CHOICES = 500;

export class VoltBrowserAccessService extends Disposable implements IVoltBrowserAccessService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private readonly choices = new Map<string, boolean>();

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		try {
			const stored = JSON.parse(this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION, '{}')) as Record<string, unknown>;
			for (const [sessionId, allowed] of Object.entries(stored)) {
				if (typeof allowed === 'boolean') {
					this.choices.set(sessionId, allowed);
				}
			}
		} catch {
			// a damaged value: start over
		}
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_BROWSER_ACCESS_SETTING)) {
				this._onDidChange.fire();
			}
		}));
	}

	blockReason(sessionId: string | undefined): BrowserBlockReason | undefined {
		const allowed = this.configurationService.getValue<boolean>(AGENT_BROWSER_ACCESS_SETTING) !== false;
		return browserBlockReason(allowed, sessionId ? this.choices.get(sessionId) : undefined);
	}

	chatChoice(sessionId: string): boolean | undefined {
		return this.choices.get(sessionId);
	}

	setChatChoice(sessionId: string, allowed: boolean | undefined): void {
		if (this.choices.get(sessionId) === allowed) {
			return;
		}
		this.choices.delete(sessionId);
		if (allowed !== undefined) {
			this.choices.set(sessionId, allowed);
			while (this.choices.size > MAX_CHOICES) {
				this.choices.delete(this.choices.keys().next().value!);
			}
		}
		this.storageService.store(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.choices)), StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChange.fire();
	}
}

registerSingleton(IVoltBrowserAccessService, VoltBrowserAccessService, InstantiationType.Delayed);
