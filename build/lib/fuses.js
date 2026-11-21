"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.voltElectronFuses = void 0;
exports.packagedElectronPath = packagedElectronPath;
exports.flipVoltFuses = flipVoltFuses;
exports.checkVoltFuses = checkVoltFuses;
const path_1 = __importDefault(require("path"));
const fuses_1 = require("@electron/fuses");
/**
 * The Electron fuses every packaged Volt build carries (sandbox spec B-19, D-07, D-08, INV-30).
 * Fuses are bits in the Electron binary: no flag, environment variable or app code can turn them
 * back on. Development builds (.build/electron) keep Electron's defaults.
 */
exports.voltElectronFuses = {
    // D-07: volt-server, the file watcher, the CLI and the shell environment probe run as
    // ELECTRON_RUN_AS_NODE children of this binary.
    RunAsNode: true,
    // Unchanged. Turning cookie encryption on can't be undone for existing profiles.
    EnableCookieEncryption: false,
    // NODE_OPTIONS (--require, --import, --inspect) is ignored and removed from the environment in
    // every Volt process, including RUN_AS_NODE children. src/vs/platform/shell/node/shellEnv.ts
    // carries the user's own NODE_OPTIONS through the shell environment probe.
    EnableNodeOptionsEnvironmentVariable: false,
    // --inspect* flags and SIGUSR1 open no inspector in the main process or utility processes
    // (extension hosts, shared process). SIGUSR1 terminates a utility process instead, so
    // UtilityProcess.enableInspectPort and the extension host's profiler check
    // product.electronFuses first. RUN_AS_NODE children ignore this fuse: volt-server runs with
    // --disable-sigusr1 (agentServerLauncher.ts). Cost: extension debugging (--inspect-extensions)
    // and extension host profiling need a development build.
    EnableNodeCliInspectArguments: false,
    // D-08: not flipped. VS Code reads its own files through `original-fs`, which can't see into an
    // asar, and spawns scripts from out/ by path. docs/security/sandbox/06-electron-hardening.md has
    // the release-build trial.
    EnableEmbeddedAsarIntegrityValidation: false,
    OnlyLoadAppFromAsar: false,
    // Unchanged: Volt doesn't ship a browser-process V8 snapshot.
    LoadBrowserProcessSpecificV8Snapshot: false,
    // The workbench loads from vscode-file://, and the main window's session refuses file:// outright
    // (protocolMainService.ts). The only file:// pages are render_html previews, which are one
    // self-contained file.
    GrantFileProtocolExtraPrivileges: false,
};
/** The Electron executable (or app bundle on macOS) of a packaged build in `destination`. */
function packagedElectronPath(destination, platform, product) {
    switch (platform) {
        case 'darwin': return path_1.default.join(destination, `${product.nameLong}.app`);
        case 'win32': return path_1.default.join(destination, `${product.nameShort}.exe`);
        default: return path_1.default.join(destination, product.applicationName);
    }
}
/**
 * Flips Volt's fuses in a packaged build, then reads them back. On Apple silicon the bundle is
 * signed ad hoc again (its pages changed); release signing later replaces that signature.
 */
async function flipVoltFuses(electronPath, platform, arch) {
    const fuses = {};
    for (const [name, enabled] of Object.entries(exports.voltElectronFuses)) {
        fuses[fuses_1.FuseV1Options[name]] = enabled;
    }
    await (0, fuses_1.flipFuses)(electronPath, {
        version: fuses_1.FuseVersion.V1,
        resetAdHocDarwinSignature: platform === 'darwin' && arch === 'arm64',
        ...fuses,
    });
    const mismatches = await checkVoltFuses(electronPath);
    if (mismatches.length) {
        throw new Error(`Electron fuses in ${electronPath} did not flip: ${mismatches.join(', ')}`);
    }
}
/** Reads the fuses of `electronPath` and lists every one that differs from `voltElectronFuses`. */
async function checkVoltFuses(electronPath) {
    const wire = await (0, fuses_1.getCurrentFuseWire)(electronPath);
    const mismatches = [];
    // A fuse this list doesn't name fails the build: a new Electron fuse needs a decision above.
    for (const key of Object.keys(wire)) {
        const index = Number(key);
        if (key !== 'version' && !(fuses_1.FuseV1Options[index] in exports.voltElectronFuses)) {
            mismatches.push(`${fuses_1.FuseV1Options[index] ?? `fuse #${index}`} has no Volt setting (new in this Electron?)`);
        }
    }
    for (const [name, enabled] of Object.entries(exports.voltElectronFuses)) {
        const state = wire[fuses_1.FuseV1Options[name]];
        const expected = enabled ? fuses_1.FuseState.ENABLE : fuses_1.FuseState.DISABLE;
        if (state !== expected) {
            mismatches.push(`${name} is ${describeFuseState(state)}, expected ${enabled ? 'Enabled' : 'Disabled'}`);
        }
    }
    return mismatches;
}
function describeFuseState(state) {
    switch (state) {
        case fuses_1.FuseState.ENABLE: return 'Enabled';
        case fuses_1.FuseState.DISABLE: return 'Disabled';
        case fuses_1.FuseState.REMOVED: return 'Removed';
        case fuses_1.FuseState.INHERIT: return 'Inherit';
        default: return 'missing';
    }
}
//# sourceMappingURL=fuses.js.map