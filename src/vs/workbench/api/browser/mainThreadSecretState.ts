/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { assertHostsExtension, extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ExtHostContext, ExtHostSecretStateShape, MainContext, MainThreadSecretStateShape } from '../common/extHost.protocol.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { SequencerByKey } from '../../../base/common/async.js';
import { ISecretStorageService } from '../../../platform/secrets/common/secrets.js';
import { IBrowserWorkbenchEnvironmentService } from '../../services/environment/browser/environmentService.js';

@extHostNamedCustomer(MainContext.MainThreadSecretState)
export class MainThreadSecretState extends Disposable implements MainThreadSecretStateShape {
	private readonly _proxy: ExtHostSecretStateShape;

	private readonly _sequencer = new SequencerByKey<string>();

	constructor(
		private readonly extHostContext: IExtHostContext,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@ILogService private readonly logService: ILogService,
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService
	) {
		super();

		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostSecretState);

		this._register(this.secretStorageService.onDidChangeSecret((e: string) => {
			const parsedKey = this.parseKey(e);
			// Another host's extension's secret changing is not this host's business.
			if (parsedKey && typeof parsedKey.extensionId === 'string' && this.extHostContext.hostsExtension(parsedKey.extensionId)) {
				this._proxy.$onDidChangePassword(parsedKey);
			}
		}));
	}

	/** Secrets are keyed on the extension id the payload names: only one this host runs (B-08). */
	private checkExtension(extensionId: string): void {
		assertHostsExtension(this.extHostContext, extensionId);
	}

	async $getPassword(extensionId: string, key: string): Promise<string | undefined> {
		this.checkExtension(extensionId);
		this.logService.trace(`[mainThreadSecretState] Getting password for ${extensionId} extension: `, key);
		return this._sequencer.queue(extensionId, () => this.doGetPassword(extensionId, key));
	}

	private async doGetPassword(extensionId: string, key: string): Promise<string | undefined> {
		const fullKey = this.getKey(extensionId, key);
		const password = await this.secretStorageService.get(fullKey);
		this.logService.trace(`[mainThreadSecretState] ${password ? 'P' : 'No p'}assword found for: `, extensionId, key);
		return password;
	}

	async $setPassword(extensionId: string, key: string, value: string): Promise<void> {
		this.checkExtension(extensionId);
		this.logService.trace(`[mainThreadSecretState] Setting password for ${extensionId} extension: `, key);
		return this._sequencer.queue(extensionId, () => this.doSetPassword(extensionId, key, value));
	}

	private async doSetPassword(extensionId: string, key: string, value: string): Promise<void> {
		const fullKey = this.getKey(extensionId, key);
		await this.secretStorageService.set(fullKey, value);
		this.logService.trace('[mainThreadSecretState] Password set for: ', extensionId, key);
	}

	async $deletePassword(extensionId: string, key: string): Promise<void> {
		this.checkExtension(extensionId);
		this.logService.trace(`[mainThreadSecretState] Deleting password for ${extensionId} extension: `, key);
		return this._sequencer.queue(extensionId, () => this.doDeletePassword(extensionId, key));
	}

	private async doDeletePassword(extensionId: string, key: string): Promise<void> {
		const fullKey = this.getKey(extensionId, key);
		await this.secretStorageService.delete(fullKey);
		this.logService.trace('[mainThreadSecretState] Password deleted for: ', extensionId, key);
	}

	async $getKeys(extensionId: string): Promise<string[]> {
		this.checkExtension(extensionId);
		this.logService.trace(`[mainThreadSecretState] Getting keys for ${extensionId} extension: `);
		return this._sequencer.queue(extensionId, () => this.doGetKeys(extensionId));
	}

	private async doGetKeys(extensionId: string): Promise<string[]> {
		if (!this.secretStorageService.keys) {
			throw new Error('Secret storage service does not support keys() method');
		}
		const allKeys = await this.secretStorageService.keys();
		const keys = allKeys
			.map(key => this.parseKey(key))
			.filter((parsedKey): parsedKey is { extensionId: string; key: string } => parsedKey !== undefined && parsedKey.extensionId === extensionId)
			.map(({ key }) => key); // Return only my keys
		this.logService.trace(`[mainThreadSecretState] Got ${keys.length}key(s) for: `, extensionId);
		return keys;
	}

	private getKey(extensionId: string, key: string): string {
		return JSON.stringify({ extensionId, key });
	}

	private parseKey(key: string): { extensionId: string; key: string } | undefined {
		try {
			return JSON.parse(key);
		} catch {
			return undefined;
		}
	}
}
