/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { dirname } from '../../../base/common/path.js';
import { ExtensionSignatureVerificationCode } from '../common/extensionManagement.js';

interface IConsentFile {
	readonly version: 1;
	readonly extensions: { readonly [id: string]: { readonly consentedAt: number; readonly version: string } };
}

/**
 * INV-29, B-AP-8: extensions the user chose to install unsigned ("Install Anyway"), when product.json
 * pins registry keys. Consent is per extension and one-time: later updates of that extension that are
 * still unsigned install without asking again. It never covers a signature that is present but
 * invalid (a tampered package), which is refused every time.
 */
export class VoltUnsignedExtensionConsent {

	private cache: Promise<IConsentFile> | undefined;

	constructor(private readonly file: string) { }

	private read(): Promise<IConsentFile> {
		if (!this.cache) {
			const empty: IConsentFile = { version: 1, extensions: {} };
			this.cache = fs.promises.readFile(this.file, 'utf8').then(text => {
				const parsed: IConsentFile | undefined = JSON.parse(text);
				return parsed?.version === 1 && parsed.extensions && typeof parsed.extensions === 'object' ? parsed : empty;
			}).catch(() => empty);
		}
		return this.cache;
	}

	async has(extensionId: string): Promise<boolean> {
		return Object.prototype.hasOwnProperty.call((await this.read()).extensions, extensionId.toLowerCase());
	}

	async grant(extensionId: string, version: string): Promise<void> {
		const current = await this.read();
		const next: IConsentFile = { version: 1, extensions: { ...current.extensions, [extensionId.toLowerCase()]: { consentedAt: Date.now(), version } } };
		this.cache = Promise.resolve(next);
		await fs.promises.mkdir(dirname(this.file), { recursive: true });
		const partial = `${this.file}.${process.pid}.tmp`;
		await fs.promises.writeFile(partial, JSON.stringify(next, null, '\t'), { mode: 0o600 });
		await fs.promises.rename(partial, this.file);
	}
}

/**
 * Whether a gallery download that failed the signature requirement may install anyway: only an
 * unsigned one (NotSigned) the user already consented to, and only with registry keys pinned.
 */
export async function isConsentedUnsignedExtension(status: ExtensionSignatureVerificationCode | undefined, extensionId: string, pinned: boolean, consent: VoltUnsignedExtensionConsent): Promise<boolean> {
	return pinned && status === ExtensionSignatureVerificationCode.NotSigned && await consent.has(extensionId);
}
