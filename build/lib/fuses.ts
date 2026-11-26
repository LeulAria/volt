/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'path';
import { flipFuses, getCurrentFuseWire, FuseState, FuseV1Options, FuseVersion } from '@electron/fuses';

export type VoltFuseName = Exclude<keyof typeof FuseV1Options, number | 'WasmTrapHandlers'>;

/**
 * The Electron fuses every packaged Volt build carries (sandbox spec B-19, D-07, D-08, INV-30).
 * Fuses are bits in the Electron binary: no flag, environment variable or app code can turn them
 * back on. Development builds (.build/electron) keep Electron's defaults.
 */
export const voltElectronFuses: Readonly<Record<VoltFuseName, boolean>> = {
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
export function packagedElectronPath(destination: string, platform: string, product: { nameLong: string; nameShort: string; applicationName: string }): string {
	switch (platform) {
		case 'darwin': return path.join(destination, `${product.nameLong}.app`);
		case 'win32': return path.join(destination, `${product.nameShort}.exe`);
		default: return path.join(destination, product.applicationName);
	}
}

/**
 * Flips Volt's fuses in a packaged build, then reads them back. On Apple silicon the bundle is
 * signed ad hoc again (its pages changed); release signing later replaces that signature.
 */
export async function flipVoltFuses(electronPath: string, platform: string, arch: string): Promise<void> {
	const fuses: Partial<Record<FuseV1Options, boolean>> = {};
	for (const [name, enabled] of Object.entries(voltElectronFuses)) {
		fuses[FuseV1Options[name as VoltFuseName]] = enabled;
	}
	await flipFuses(electronPath, {
		version: FuseVersion.V1,
		resetAdHocDarwinSignature: platform === 'darwin' && arch === 'arm64',
		...fuses,
	});
	const mismatches = await checkVoltFuses(electronPath);
	if (mismatches.length) {
		throw new Error(`Electron fuses in ${electronPath} did not flip: ${mismatches.join(', ')}`);
	}
}

/** Reads the fuses of `electronPath` and lists every one that differs from `voltElectronFuses`. */
export async function checkVoltFuses(electronPath: string): Promise<string[]> {
	const wire = await getCurrentFuseWire(electronPath);
	const mismatches: string[] = [];
	// A fuse this list doesn't name fails the build: a new Electron fuse needs a decision above.
	for (const key of Object.keys(wire)) {
		const index = Number(key);
		if (key !== 'version' && !(FuseV1Options[index] in voltElectronFuses)) {
			mismatches.push(`${FuseV1Options[index] ?? `fuse #${index}`} has no Volt setting (new in this Electron?)`);
		}
	}
	for (const [name, enabled] of Object.entries(voltElectronFuses)) {
		const state = wire[FuseV1Options[name as VoltFuseName]];
		const expected = enabled ? FuseState.ENABLE : FuseState.DISABLE;
		if (state !== expected) {
			mismatches.push(`${name} is ${describeFuseState(state)}, expected ${enabled ? 'Enabled' : 'Disabled'}`);
		}
	}
	return mismatches;
}

function describeFuseState(state: FuseState | undefined): string {
	switch (state) {
		case FuseState.ENABLE: return 'Enabled';
		case FuseState.DISABLE: return 'Disabled';
		case FuseState.REMOVED: return 'Removed';
		case FuseState.INHERIT: return 'Inherit';
		default: return 'missing';
	}
}
