"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const osx_sign_1 = require("@electron/osx-sign");
const cross_spawn_promise_1 = require("@malept/cross-spawn-promise");
const root = path_1.default.dirname(path_1.default.dirname(__dirname));
const baseDir = path_1.default.dirname(__dirname);
const product = JSON.parse(fs_1.default.readFileSync(path_1.default.join(root, 'product.json'), 'utf8'));
const helperAppBaseName = product.nameShort;
const gpuHelperAppName = helperAppBaseName + ' Helper (GPU).app';
const rendererHelperAppName = helperAppBaseName + ' Helper (Renderer).app';
const pluginHelperAppName = helperAppBaseName + ' Helper (Plugin).app';
function getElectronVersion() {
    const npmrc = fs_1.default.readFileSync(path_1.default.join(root, '.npmrc'), 'utf8');
    const target = /^target="(.*)"$/m.exec(npmrc)[1];
    return target;
}
function getEntitlementsForFile(filePath) {
    if (filePath.includes(gpuHelperAppName)) {
        return path_1.default.join(baseDir, 'azure-pipelines', 'darwin', 'helper-gpu-entitlements.plist');
    }
    else if (filePath.includes(rendererHelperAppName)) {
        return path_1.default.join(baseDir, 'azure-pipelines', 'darwin', 'helper-renderer-entitlements.plist');
    }
    else if (filePath.includes(pluginHelperAppName)) {
        return path_1.default.join(baseDir, 'azure-pipelines', 'darwin', 'helper-plugin-entitlements.plist');
    }
    return path_1.default.join(baseDir, 'azure-pipelines', 'darwin', 'app-entitlements.plist');
}
/**
 * Volt: the sandbox helper runs only when its SHA-256 matches the pin in volt-helpers.json beside
 * it (src/vs/platform/voltHelpers/node/helperIntegrity.ts), and any signature changes the file.
 * So it is signed here (hardened runtime, timestamp), re-pinned, and kept away from osx-sign; the
 * app's seal, made afterwards, covers both the signed helper and the new pin.
 */
async function signVoltHelpers(app, identity, keychain) {
    const dir = path_1.default.join(app, 'Contents', 'Resources', 'app', 'volt-helpers');
    const manifestPath = path_1.default.join(dir, 'volt-helpers.json');
    if (!fs_1.default.existsSync(manifestPath)) {
        return [];
    }
    const manifest = JSON.parse(fs_1.default.readFileSync(manifestPath, 'utf8'));
    const signed = [];
    for (const [id, entry] of Object.entries(manifest)) {
        const file = path_1.default.join(dir, entry.file);
        await (0, cross_spawn_promise_1.spawn)('codesign', ['--force', '--sign', identity ?? '-', '--keychain', keychain, '--options', 'runtime', '--timestamp', file]);
        manifest[id] = { file: entry.file, sha256: crypto_1.default.createHash('sha256').update(fs_1.default.readFileSync(file)).digest('hex') };
        signed.push(file);
    }
    fs_1.default.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
    return signed;
}
async function main(buildDir) {
    const tempDir = process.env['AGENT_TEMPDIRECTORY'];
    const arch = process.env['VSCODE_ARCH'];
    const identity = process.env['CODESIGN_IDENTITY'];
    if (!buildDir) {
        throw new Error('$AGENT_BUILDDIRECTORY not set');
    }
    if (!tempDir) {
        throw new Error('$AGENT_TEMPDIRECTORY not set');
    }
    const appRoot = path_1.default.join(buildDir, `VSCode-darwin-${arch}`);
    const appName = product.nameLong + '.app';
    const infoPlistPath = path_1.default.resolve(appRoot, appName, 'Contents', 'Info.plist');
    const appOpts = {
        app: path_1.default.join(appRoot, appName),
        platform: 'darwin',
        optionsForFile: (filePath) => ({
            entitlements: getEntitlementsForFile(filePath),
            hardenedRuntime: true,
        }),
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        keychain: path_1.default.join(tempDir, 'buildagent.keychain'),
        version: getElectronVersion(),
        identity,
    };
    // Only overwrite plist entries for x64 and arm64 builds,
    // universal will get its copy from the x64 build.
    if (arch !== 'universal') {
        await (0, cross_spawn_promise_1.spawn)('plutil', [
            '-insert',
            'NSAppleEventsUsageDescription',
            '-string',
            'An application in Visual Studio Code wants to use AppleScript.',
            `${infoPlistPath}`
        ]);
        await (0, cross_spawn_promise_1.spawn)('plutil', [
            '-replace',
            'NSMicrophoneUsageDescription',
            '-string',
            'An application in Visual Studio Code wants to use the Microphone.',
            `${infoPlistPath}`
        ]);
        await (0, cross_spawn_promise_1.spawn)('plutil', [
            '-replace',
            'NSSpeechRecognitionUsageDescription',
            '-string',
            'Volt turns your dictation into text for the agent composer.',
            `${infoPlistPath}`
        ]);
        await (0, cross_spawn_promise_1.spawn)('plutil', [
            '-replace',
            'NSCameraUsageDescription',
            '-string',
            'An application in Visual Studio Code wants to use the Camera.',
            `${infoPlistPath}`
        ]);
    }
    const voltHelpers = await signVoltHelpers(appOpts.app, identity, appOpts.keychain);
    await (0, osx_sign_1.sign)({ ...appOpts, ignore: (filePath) => voltHelpers.includes(filePath) });
}
if (require.main === module) {
    main(process.argv[2]).catch(async err => {
        console.error(err);
        const tempDir = process.env['AGENT_TEMPDIRECTORY'];
        if (tempDir) {
            const keychain = path_1.default.join(tempDir, 'buildagent.keychain');
            const identities = await (0, cross_spawn_promise_1.spawn)('security', ['find-identity', '-p', 'codesigning', '-v', keychain]);
            console.error(`Available identities:\n${identities}`);
            const dump = await (0, cross_spawn_promise_1.spawn)('security', ['dump-keychain', keychain]);
            console.error(`Keychain dump:\n${dump}`);
        }
        process.exit(1);
    });
}
//# sourceMappingURL=sign.js.map