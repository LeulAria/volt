/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { IExtensionsProfileScannerService } from '../../common/extensionsProfileScannerService.js';
import { AbstractExtensionsScannerService, IExtensionsScannerService, Translations } from '../../common/extensionsScannerService.js';
import { IVoltBuiltinManifest, VOLT_BUILTIN_MANIFEST_FILE, VoltBuiltinIntegrity } from '../../common/voltBuiltinIntegrity.js';
import { ExtensionsProfileScannerService } from '../../node/extensionsProfileScannerService.js';
import { IFileService } from '../../../files/common/files.js';
import { FileService } from '../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { TestInstantiationService } from '../../../instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { IUriIdentityService } from '../../../uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../uriIdentity/common/uriIdentityService.js';
import { IUserDataProfilesService, UserDataProfilesService } from '../../../userDataProfile/common/userDataProfile.js';

const ROOT = URI.file('/VOLTAPP');
const APP = joinPath(ROOT, 'app');
const EXTENSIONS = joinPath(APP, 'extensions');

class TestScannerService extends AbstractExtensionsScannerService implements IExtensionsScannerService {
	constructor(
		@IUserDataProfilesService userDataProfilesService: IUserDataProfilesService,
		@IExtensionsProfileScannerService extensionsProfileScannerService: IExtensionsProfileScannerService,
		@IFileService fileService: IFileService,
		@ILogService logService: ILogService,
		@INativeEnvironmentService nativeEnvironmentService: INativeEnvironmentService,
		@IProductService productService: IProductService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(EXTENSIONS, joinPath(ROOT, 'user-extensions'), joinPath(ROOT, 'control.json'), userDataProfilesService.defaultProfile,
			userDataProfilesService, extensionsProfileScannerService, fileService, logService, nativeEnvironmentService, productService, uriIdentityService, instantiationService);
	}
	protected async getTranslations(): Promise<Translations> {
		return {};
	}
}

class RecordingLogService extends NullLogService {
	readonly lines: string[] = [];
	override info(message: string): void { this.lines.push(`info: ${message}`); }
	override warn(message: string): void { this.lines.push(`warn: ${message}`); }
	override error(message: string | Error): void { this.lines.push(`error: ${message}`); }
}

/** H.10 built-in integrity: an edited built-in file is detected at load (SUP-7); dev builds skip with a log. */
suite('Volt built-in integrity', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let fileService: IFileService;
	let log: RecordingLogService;

	const sha = (text: string) => createHash('sha256').update(text).digest('hex');
	const files: { [folder: string]: { [file: string]: string } } = {
		'volt-browser': { 'package.json': JSON.stringify({ name: 'browser', publisher: 'volt', version: '0.0.1', engines: { vscode: '*' } }), 'media/icon.svg': '<svg/>' },
		'volt-usage': { 'package.json': JSON.stringify({ name: 'usage', publisher: 'volt', version: '0.0.1', engines: { vscode: '*' } }) },
		'git': { 'package.json': JSON.stringify({ name: 'git', publisher: 'vscode', version: '1.0.0', engines: { vscode: '*' } }) },
	};

	/** Writes the built-ins and a manifest as build/volt/release/builtinManifest.mjs does; returns the manifest's hash. */
	async function build(helpers: { [file: string]: string } = {}): Promise<string> {
		const manifest: IVoltBuiltinManifest = { version: 1, algorithm: 'sha256', extensions: {}, helpers: {} };
		for (const [folder, contents] of Object.entries(files)) {
			for (const [file, text] of Object.entries(contents)) {
				await fileService.writeFile(joinPath(EXTENSIONS, folder, file), VSBuffer.fromString(text));
			}
			if (folder.startsWith('volt-')) {
				(manifest.extensions as Record<string, Record<string, string>>)[folder] = Object.fromEntries(Object.entries(contents).map(([file, text]) => [file, sha(text)]).sort(([a], [b]) => a < b ? -1 : 1));
			}
		}
		for (const [file, text] of Object.entries(helpers)) {
			await fileService.writeFile(joinPath(APP, file), VSBuffer.fromString(text));
			(manifest.helpers as Record<string, string>)[file] = sha(text);
		}
		const text = JSON.stringify(manifest, null, '\t') + '\n';
		await fileService.writeFile(joinPath(APP, VOLT_BUILTIN_MANIFEST_FILE), VSBuffer.fromString(text));
		return sha(text);
	}

	function integrity(isBuilt: boolean, manifestSha256: string | undefined): VoltBuiltinIntegrity {
		return new VoltBuiltinIntegrity({ appRoot: APP, isBuilt, manifestSha256 }, fileService, log);
	}

	const locations = Object.keys(files).map(folder => joinPath(EXTENSIONS, folder));
	const failuresOf = async (check: VoltBuiltinIntegrity) => Object.fromEntries([...(await check.checkExtensions(locations))].map(([location, why]) => [location.replace(/^.*\/extensions\//, ''), why]));

	setup(() => {
		log = new RecordingLogService();
		fileService = disposables.add(new FileService(log));
		disposables.add(fileService.registerProvider(ROOT.scheme, disposables.add(new InMemoryFileSystemProvider())));
	});

	test('an untouched build passes', async () => {
		const hash = await build();
		assert.deepStrictEqual(await failuresOf(integrity(true, hash)), {});
	});

	test('SUP-7: an edited, added or removed built-in file is detected', async () => {
		const hash = await build();
		await fileService.writeFile(joinPath(EXTENSIONS, 'volt-browser', 'package.json'), VSBuffer.fromString(JSON.stringify({ name: 'browser', publisher: 'volt', version: '0.0.1', main: './evil.js' })));
		assert.deepStrictEqual(await failuresOf(integrity(true, hash)), { 'volt-browser': 'package.json was modified' });
		assert.ok(log.lines.some(line => line.startsWith('error: Built-in extension volt-browser failed its integrity check')));

		await build();
		await fileService.writeFile(joinPath(EXTENSIONS, 'volt-usage', 'evil.js'), VSBuffer.fromString('process.exit()'));
		await fileService.del(joinPath(EXTENSIONS, 'volt-browser', 'media', 'icon.svg'));
		assert.deepStrictEqual(await failuresOf(integrity(true, hash)), { 'volt-usage': 'evil.js was added', 'volt-browser': 'media/icon.svg was removed' });
	});

	test('SUP-7: a rewritten, missing or unknown manifest fails every volt built-in', async () => {
		const hash = await build();
		// An attacker who edits a file and re-hashes it into the manifest still trips product.json's hash.
		await fileService.writeFile(joinPath(APP, VOLT_BUILTIN_MANIFEST_FILE), VSBuffer.fromString(JSON.stringify({ version: 1, algorithm: 'sha256', extensions: {} })));
		assert.deepStrictEqual(Object.values(await failuresOf(integrity(true, hash))), [`${VOLT_BUILTIN_MANIFEST_FILE} does not match the hash in product.json`, `${VOLT_BUILTIN_MANIFEST_FILE} does not match the hash in product.json`]);
		await fileService.del(joinPath(APP, VOLT_BUILTIN_MANIFEST_FILE));
		assert.match(Object.values(await failuresOf(integrity(true, hash)))[0], /is missing/);

		// A volt-* folder the manifest doesn't know is not loaded either.
		const fresh = await build();
		await fileService.writeFile(joinPath(EXTENSIONS, 'volt-planted', 'package.json'), VSBuffer.fromString('{}'));
		const planted = await integrity(true, fresh).checkExtensions([joinPath(EXTENSIONS, 'volt-planted')]);
		assert.deepStrictEqual([...planted.values()], [`volt-planted is not in ${VOLT_BUILTIN_MANIFEST_FILE}`]);
	});

	test('dev builds and builds without a manifest skip the check, with a log', async () => {
		const hash = await build();
		await fileService.writeFile(joinPath(EXTENSIONS, 'volt-browser', 'package.json'), VSBuffer.fromString('{}'));
		assert.deepStrictEqual(await failuresOf(integrity(false, hash)), {});
		assert.deepStrictEqual(log.lines, ['info: Built-in integrity check skipped: running from sources']);

		log.lines.length = 0;
		await fileService.del(joinPath(APP, VOLT_BUILTIN_MANIFEST_FILE));
		assert.deepStrictEqual(await failuresOf(integrity(true, undefined)), {});
		assert.deepStrictEqual(log.lines, [`warn: Built-in integrity check skipped: this build has no ${VOLT_BUILTIN_MANIFEST_FILE}`]);
	});

	test('helper binaries are checked through the manifest hook', async () => {
		const hash = await build({ 'out/helper/volt-desktop': 'binary' });
		const check = integrity(true, hash);
		assert.strictEqual(await check.checkHelper('out/helper/volt-desktop'), undefined);
		assert.match((await check.checkHelper('out/helper/other'))!, /not in/);
		await fileService.writeFile(joinPath(APP, 'out/helper/volt-desktop'), VSBuffer.fromString('patched'));
		assert.strictEqual(await integrity(true, hash).checkHelper('out/helper/volt-desktop'), 'out/helper/volt-desktop was modified');
		assert.strictEqual(await integrity(false, hash).checkHelper('out/helper/volt-desktop'), undefined);
	});

	test('SUP-7: the extension scanner does not load an edited built-in', async () => {
		const hash = await build();
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(ILogService, log);
		instantiationService.stub(IFileService, fileService);
		const environmentService = instantiationService.stub(INativeEnvironmentService, { userHome: ROOT, userRoamingDataHome: ROOT, cacheHome: joinPath(ROOT, 'cache'), builtinExtensionsPath: EXTENSIONS.fsPath, extensionsPath: joinPath(ROOT, 'user-extensions').fsPath, isBuilt: true });
		instantiationService.stub(IProductService, { version: '1.66.0', voltBuiltinManifestSha256: hash });
		const uriIdentityService = disposables.add(new UriIdentityService(fileService));
		instantiationService.stub(IUriIdentityService, uriIdentityService);
		const userDataProfilesService = disposables.add(new UserDataProfilesService(environmentService, fileService, uriIdentityService, log));
		instantiationService.stub(IUserDataProfilesService, userDataProfilesService);
		instantiationService.stub(IExtensionsProfileScannerService, disposables.add(new ExtensionsProfileScannerService(environmentService, fileService, userDataProfilesService, uriIdentityService, log)));

		const scanned = async () => (await disposables.add(instantiationService.createInstance(TestScannerService)).scanSystemExtensions({})).map(extension => extension.identifier.id).sort();
		assert.deepStrictEqual(await scanned(), ['volt.browser', 'volt.usage', 'vscode.git']);

		await fileService.writeFile(joinPath(EXTENSIONS, 'volt-usage', 'package.json'), VSBuffer.fromString(JSON.stringify({ name: 'usage', publisher: 'volt', version: '0.0.1', engines: { vscode: '*' }, main: './evil.js' })));
		assert.deepStrictEqual(await scanned(), ['volt.browser', 'vscode.git']);
	});
});
