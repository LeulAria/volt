/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { getErrorMessage } from '../../../base/common/errors.js';
import { isDefined } from '../../../base/common/types.js';
import { verifyEd25519 } from '../../../base/node/voltEd25519.js';
import { buffer, ExtractError } from '../../../base/node/zip.js';
import { TargetPlatform } from '../../extensions/common/extensions.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService, LogLevel } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { ExtensionSignatureVerificationCode } from '../common/extensionManagement.js';
import { voltRegistryPublicKeys } from '../common/voltExtensionSigning.js';

export const IExtensionSignatureVerificationService = createDecorator<IExtensionSignatureVerificationService>('IExtensionSignatureVerificationService');

export interface IExtensionSignatureVerificationResult {
	readonly code: ExtensionSignatureVerificationCode;
}

/**
 * A service for verifying signed extensions.
 */
export interface IExtensionSignatureVerificationService {
	readonly _serviceBrand: undefined;

	/**
	 * Verifies an extension file (.vsix) against a signature archive file.
	 * @param extensionId The extension identifier.
	 * @param version The extension version.
	 * @param vsixFilePath The extension file path.
	 * @param signatureArchiveFilePath The signature archive file path.
	 * @returns returns the verification result or undefined if the verification was not executed.
	 */
	verify(extensionId: string, version: string, vsixFilePath: string, signatureArchiveFilePath: string, clientTargetPlatform?: TargetPlatform): Promise<IExtensionSignatureVerificationResult | undefined>;
}

declare namespace vsceSign {
	export function verify(vsixFilePath: string, signatureArchiveFilePath: string, verbose: boolean): Promise<ExtensionSignatureVerificationResult>;
}

/**
 * Extension signature verification result
 */
export interface ExtensionSignatureVerificationResult {
	readonly code: ExtensionSignatureVerificationCode;
	readonly didExecute: boolean;
	readonly internalCode?: number;
	readonly output?: string;
}

/**
 * Volt: verifies an Open VSX signature archive against the pinned registry keys.
 *
 * The format, from eclipse/openvsx's signing (published as `node-ovsx-sign`,
 * https://github.com/filiptronicek/node-ovsx-sign, src/utils/commands.ts `sign`/`verify`,
 * src/utils/sign.ts, src/utils/constants.ts):
 * - the `.sigzip` holds `.signature.sig`, `.signature.manifest` and an empty `.signature.p7s`
 *   (kept only because VS Code's downloader looks for it);
 * - `.signature.sig` is the raw 64-byte Ed25519 signature, `crypto.sign(null, <the whole .vsix>, key)`;
 * - `.signature.manifest` is JSON with the size and base64 SHA-256 of the package and of every entry.
 *   It is not itself signed, so it adds nothing once the whole package's signature checks out;
 * - the registry key is an Ed25519 SPKI PEM served at `https://open-vsx.org/api/-/public-key/<id>`
 *   (each version's `files.publicKey`). product.json pins its base64 body.
 * Checked against open-vsx.org on 2026-11-08: the `.vsix` verifies, the manifest bytes don't.
 */
export async function verifyRegistrySignature(vsixFilePath: string, signatureArchiveFilePath: string, publicKeys: readonly string[]): Promise<ExtensionSignatureVerificationResult> {
	let signature: Buffer;
	try {
		signature = await buffer(signatureArchiveFilePath, '.signature.sig');
	} catch (error) {
		const corrupt = error instanceof ExtractError && error.type === 'CorruptZip';
		return {
			code: corrupt ? ExtensionSignatureVerificationCode.SignatureArchiveIsInvalidZip : ExtensionSignatureVerificationCode.SignatureIsMissing,
			didExecute: true,
			output: getErrorMessage(error),
		};
	}
	let vsix: Buffer;
	try {
		vsix = await fs.promises.readFile(vsixFilePath);
	} catch (error) {
		return { code: ExtensionSignatureVerificationCode.PackageIsUnreadable, didExecute: true, output: getErrorMessage(error) };
	}
	if (signature.byteLength !== 64) {
		return { code: ExtensionSignatureVerificationCode.SignatureIsUnreadable, didExecute: true, output: `The signature is ${signature.byteLength} bytes, not an Ed25519 signature` };
	}
	if (publicKeys.some(key => verifyEd25519(vsix, signature, key))) {
		return { code: ExtensionSignatureVerificationCode.Success, didExecute: true };
	}
	return { code: ExtensionSignatureVerificationCode.SignatureIsNotValid, didExecute: true, output: 'The package is not signed by a pinned registry key' };
}

export class ExtensionSignatureVerificationService implements IExtensionSignatureVerificationService {
	declare readonly _serviceBrand: undefined;

	private moduleLoadingPromise: Promise<typeof vsceSign> | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IProductService private readonly productService: IProductService,
	) { }

	private vsceSign(): Promise<typeof vsceSign> {
		if (!this.moduleLoadingPromise) {
			this.moduleLoadingPromise = this.resolveVsceSign();
		}

		return this.moduleLoadingPromise;
	}

	private async resolveVsceSign(): Promise<typeof vsceSign> {
		const mod = '@vscode/vsce-sign';
		return import(mod);
	}

	public async verify(extensionId: string, version: string, vsixFilePath: string, signatureArchiveFilePath: string, clientTargetPlatform?: TargetPlatform): Promise<IExtensionSignatureVerificationResult | undefined> {
		// Volt (INV-29): with registry keys pinned in product.json, Open VSX's Ed25519 `.sigzip` is
		// verified here; @vscode/vsce-sign isn't shipped and can't parse that format anyway.
		const registryKeys = voltRegistryPublicKeys(this.productService);
		let module: typeof vsceSign | undefined;

		if (!registryKeys.length) {
			try {
				module = await this.vsceSign();
			} catch (error) {
				this.logService.error('Could not load vsce-sign module', getErrorMessage(error));
				this.logService.info(`Extension signature verification is not done: ${extensionId}`);
				return undefined;
			}
		}

		const startTime = new Date().getTime();
		let result: ExtensionSignatureVerificationResult;

		try {
			this.logService.trace(`Verifying extension signature for ${extensionId}...`);
			result = module
				? await module.verify(vsixFilePath, signatureArchiveFilePath, this.logService.getLevel() === LogLevel.Trace)
				: await verifyRegistrySignature(vsixFilePath, signatureArchiveFilePath, registryKeys);
		} catch (e) {
			result = {
				code: ExtensionSignatureVerificationCode.UnknownError,
				didExecute: false,
				output: getErrorMessage(e)
			};
		}

		const duration = new Date().getTime() - startTime;

		this.logService.info(`Extension signature verification result for ${extensionId}: ${result.code}. ${isDefined(result.internalCode) ? `Internal Code: ${result.internalCode}. ` : ''}Executed: ${result.didExecute}. Duration: ${duration}ms.`);
		this.logService.trace(`Extension signature verification output for ${extensionId}:\n${result.output}`);

		type ExtensionSignatureVerificationClassification = {
			owner: 'sandy081';
			comment: 'Extension signature verification event';
			extensionId: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'extension identifier' };
			extensionVersion: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'extension version' };
			code: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'result code of the verification' };
			internalCode?: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; 'isMeasurement': true; comment: 'internal code of the verification' };
			duration: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; 'isMeasurement': true; comment: 'amount of time taken to verify the signature' };
			didExecute: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'whether the verification was executed' };
			clientTargetPlatform?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'target platform of the client' };
		};
		type ExtensionSignatureVerificationEvent = {
			extensionId: string;
			extensionVersion: string;
			code: string;
			internalCode?: number;
			duration: number;
			didExecute: boolean;
			clientTargetPlatform?: string;
		};
		this.telemetryService.publicLog2<ExtensionSignatureVerificationEvent, ExtensionSignatureVerificationClassification>('extensionsignature:verification', {
			extensionId,
			extensionVersion: version,
			code: result.code,
			internalCode: result.internalCode,
			duration,
			didExecute: result.didExecute,
			clientTargetPlatform,
		});

		return { code: result.code };
	}
}
