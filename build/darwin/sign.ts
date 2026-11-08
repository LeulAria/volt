/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { sign, SignOptions } from '@electron/osx-sign';
import { spawn } from '@malept/cross-spawn-promise';

const root = path.dirname(path.dirname(__dirname));
const baseDir = path.dirname(__dirname);
const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));
const helperAppBaseName = product.nameShort;
const gpuHelperAppName = helperAppBaseName + ' Helper (GPU).app';
const rendererHelperAppName = helperAppBaseName + ' Helper (Renderer).app';
const pluginHelperAppName = helperAppBaseName + ' Helper (Plugin).app';

function getElectronVersion(): string {
	const npmrc = fs.readFileSync(path.join(root, '.npmrc'), 'utf8');
	const target = /^target="(.*)"$/m.exec(npmrc)![1];
	return target;
}

function getEntitlementsForFile(filePath: string): string {
	if (filePath.includes(gpuHelperAppName)) {
		return path.join(baseDir, 'azure-pipelines', 'darwin', 'helper-gpu-entitlements.plist');
	} else if (filePath.includes(rendererHelperAppName)) {
		return path.join(baseDir, 'azure-pipelines', 'darwin', 'helper-renderer-entitlements.plist');
	} else if (filePath.includes(pluginHelperAppName)) {
		return path.join(baseDir, 'azure-pipelines', 'darwin', 'helper-plugin-entitlements.plist');
	}
	return path.join(baseDir, 'azure-pipelines', 'darwin', 'app-entitlements.plist');
}

/**
 * Volt: the sandbox helper runs only when its SHA-256 matches the pin in volt-helpers.json beside
 * it (src/vs/platform/voltHelpers/node/helperIntegrity.ts), and any signature changes the file.
 * So it is signed here (hardened runtime, timestamp), re-pinned, and kept away from osx-sign; the
 * app's seal, made afterwards, covers both the signed helper and the new pin.
 */
async function signVoltHelpers(app: string, identity: string | undefined, keychain: string): Promise<string[]> {
	const dir = path.join(app, 'Contents', 'Resources', 'app', 'volt-helpers');
	const manifestPath = path.join(dir, 'volt-helpers.json');
	if (!fs.existsSync(manifestPath)) {
		return [];
	}
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, { file: string; sha256: string }>;
	const signed: string[] = [];
	for (const [id, entry] of Object.entries(manifest)) {
		const file = path.join(dir, entry.file);
		await spawn('codesign', ['--force', '--sign', identity ?? '-', '--keychain', keychain, '--options', 'runtime', '--timestamp', file]);
		manifest[id] = { file: entry.file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
		signed.push(file);
	}
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
	return signed;
}

async function main(buildDir?: string): Promise<void> {
	const tempDir = process.env['AGENT_TEMPDIRECTORY'];
	const arch = process.env['VSCODE_ARCH'];
	const identity = process.env['CODESIGN_IDENTITY'];

	if (!buildDir) {
		throw new Error('$AGENT_BUILDDIRECTORY not set');
	}

	if (!tempDir) {
		throw new Error('$AGENT_TEMPDIRECTORY not set');
	}

	const appRoot = path.join(buildDir, `VSCode-darwin-${arch}`);
	const appName = product.nameLong + '.app';
	const infoPlistPath = path.resolve(appRoot, appName, 'Contents', 'Info.plist');

	const appOpts: SignOptions = {
		app: path.join(appRoot, appName),
		platform: 'darwin',
		optionsForFile: (filePath) => ({
			entitlements: getEntitlementsForFile(filePath),
			hardenedRuntime: true,
		}),
		preAutoEntitlements: false,
		preEmbedProvisioningProfile: false,
		keychain: path.join(tempDir, 'buildagent.keychain'),
		version: getElectronVersion(),
		identity,
	};

	// Only overwrite plist entries for x64 and arm64 builds,
	// universal will get its copy from the x64 build.
	if (arch !== 'universal') {
		await spawn('plutil', [
			'-insert',
			'NSAppleEventsUsageDescription',
			'-string',
			'An application in Visual Studio Code wants to use AppleScript.',
			`${infoPlistPath}`
		]);
		await spawn('plutil', [
			'-replace',
			'NSMicrophoneUsageDescription',
			'-string',
			'An application in Visual Studio Code wants to use the Microphone.',
			`${infoPlistPath}`
		]);
		await spawn('plutil', [
			'-replace',
			'NSSpeechRecognitionUsageDescription',
			'-string',
			'Volt turns your dictation into text for the agent composer.',
			`${infoPlistPath}`
		]);
		await spawn('plutil', [
			'-replace',
			'NSCameraUsageDescription',
			'-string',
			'An application in Visual Studio Code wants to use the Camera.',
			`${infoPlistPath}`
		]);
	}

	const voltHelpers = await signVoltHelpers(appOpts.app, identity, appOpts.keychain as string);
	await sign({ ...appOpts, ignore: (filePath: string) => voltHelpers.includes(filePath) });
}

if (require.main === module) {
	main(process.argv[2]).catch(async err => {
		console.error(err);
		const tempDir = process.env['AGENT_TEMPDIRECTORY'];
		if (tempDir) {
			const keychain = path.join(tempDir, 'buildagent.keychain');
			const identities = await spawn('security', ['find-identity', '-p', 'codesigning', '-v', keychain]);
			console.error(`Available identities:\n${identities}`);
			const dump = await spawn('security', ['dump-keychain', keychain]);
			console.error(`Keychain dump:\n${dump}`);
		}
		process.exit(1);
	});
}
