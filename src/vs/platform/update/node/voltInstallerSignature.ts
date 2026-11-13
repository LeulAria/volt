/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as path from '../../../base/common/path.js';

/**
 * Platform code-signature checks for what the updater installs (INV-28, SUP-4/5): another
 * channel's macOS app before it is moved into place, and a Windows installer before it runs.
 * They are enforced only when product.json pins the signer (`voltRelease.darwinTeamIdentifier`,
 * `voltRelease.win32Publisher`); without a pin the check is skipped and logged.
 */

export interface IVoltInstallerPins {
	readonly darwinTeamIdentifier?: string;
	readonly win32Publisher?: string;
}

export interface IVoltExecResult {
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs a program without a shell; rejects when it exits non-zero (the error carries stdout/stderr). */
export type VoltExec = (file: string, args: readonly string[], options?: { readonly env?: NodeJS.ProcessEnv }) => Promise<IVoltExecResult>;

export const voltExec: VoltExec = (file, args, options) => new Promise((resolve, reject) => {
	execFile(file, [...args], { env: options?.env, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
		if (error) {
			reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }));
		} else {
			resolve({ stdout: String(stdout), stderr: String(stderr) });
		}
	});
});

export class VoltInstallerSignatureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'VoltInstallerSignatureError';
	}
}

function outputOf(error: unknown): string {
	const e = error as { stderr?: string; stdout?: string; message?: string } | undefined;
	return (e?.stderr || e?.stdout || e?.message || String(error)).trim().split('\n').slice(0, 4).join(' ');
}

/**
 * The Developer ID requirement for one team: Apple's anchor, the Developer ID intermediate
 * (1.2.840.113635.100.6.2.6), a Developer ID Application leaf (1.2.840.113635.100.6.1.13) and the team id.
 */
export function darwinTeamRequirement(teamId: string): string {
	return `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`;
}

/** `codesign --verify --deep --strict` against the pinned team's Developer ID requirement, then the TeamIdentifier it reports. */
export async function verifyDarwinAppSignature(app: string, teamId: string, run: VoltExec = voltExec): Promise<void> {
	if (!/^[A-Z0-9]{10}$/.test(teamId)) {
		throw new VoltInstallerSignatureError(`The pinned Apple team id "${teamId}" is not a team id`);
	}
	const name = path.basename(app);
	try {
		await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', `=${darwinTeamRequirement(teamId)}`, app]);
	} catch (error) {
		throw new VoltInstallerSignatureError(`${name} is not signed by team ${teamId}: ${outputOf(error)}`);
	}
	let details: IVoltExecResult;
	try {
		details = await run('/usr/bin/codesign', ['-dv', '--verbose=2', app]);
	} catch (error) {
		throw new VoltInstallerSignatureError(`Could not read the signature of ${name}: ${outputOf(error)}`);
	}
	const team = /^TeamIdentifier=(.+)$/m.exec(`${details.stderr}\n${details.stdout}`)?.[1]?.trim();
	if (team !== teamId) {
		throw new VoltInstallerSignatureError(`${name} is signed by team ${team ?? 'none'}, not ${teamId}`);
	}
}

/** The CN of an X.500 subject such as `CN=Example Ltd, O=Example Ltd, C=US`. */
function commonName(subject: string): string | undefined {
	return /(?:^|,\s*)CN=("[^"]*"|[^,]*)/i.exec(subject)?.[1]?.replace(/^"|"$/g, '').trim();
}

/**
 * Whether the signer subject matches the pin. A pin with several parts (`CN=..., O=...`) must equal
 * the whole subject; `CN=<name>` or a bare name must equal the subject's CN. Case-insensitive.
 */
export function win32PublisherMatches(subject: string, pinned: string): boolean {
	const normalize = (value: string) => value.replace(/\s*,\s*/g, ', ').trim().toLowerCase();
	if (/,/.test(pinned)) {
		return normalize(subject) === normalize(pinned);
	}
	const cn = commonName(subject);
	const pinnedCn = /^\s*CN=/i.test(pinned) ? commonName(pinned) : pinned.trim();
	return !!cn && !!pinnedCn && cn.toLowerCase() === pinnedCn.toLowerCase();
}

const AUTHENTICODE_SCRIPT = '$s = Get-AuthenticodeSignature -LiteralPath $env:VOLT_VERIFY_FILE; [pscustomobject]@{ Status = [string]$s.Status; Subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress';

/** Authenticode status must be `Valid` (chain trusted, hash intact) and the signer must be the pinned publisher. */
export async function verifyWin32Authenticode(file: string, publisher: string, run: VoltExec = voltExec): Promise<void> {
	const name = path.basename(file);
	const systemRoot = process.env['SystemRoot'] || 'C:\\Windows';
	const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
	// A small environment: the file path and what PowerShell needs to load its modules, nothing else.
	const env: NodeJS.ProcessEnv = { SystemRoot: systemRoot, windir: process.env['windir'] ?? systemRoot, VOLT_VERIFY_FILE: file };
	for (const key of ['PSModulePath', 'TEMP', 'TMP', 'USERPROFILE']) {
		if (process.env[key]) {
			env[key] = process.env[key];
		}
	}
	let output: IVoltExecResult;
	try {
		output = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', AUTHENTICODE_SCRIPT], { env });
	} catch (error) {
		throw new VoltInstallerSignatureError(`Could not check the Authenticode signature of ${name}: ${outputOf(error)}`);
	}
	let result: { Status?: unknown; Subject?: unknown };
	try {
		result = JSON.parse(output.stdout.trim());
	} catch {
		throw new VoltInstallerSignatureError(`Could not read the Authenticode signature of ${name}`);
	}
	if (result.Status !== 'Valid') {
		throw new VoltInstallerSignatureError(`${name} has no valid Authenticode signature (${String(result.Status)})`);
	}
	const subject = typeof result.Subject === 'string' ? result.Subject : '';
	if (!win32PublisherMatches(subject, publisher)) {
		throw new VoltInstallerSignatureError(`${name} is signed by "${subject}", not "${publisher}"`);
	}
}

/**
 * Checks what the updater is about to install on `platform`. Resolves `'verified'`, or `'unpinned'`
 * when product.json pins no signer for the platform (the check is skipped and `log` says so).
 * Throws VoltInstallerSignatureError to refuse.
 */
export async function verifyVoltInstaller(platform: 'darwin' | 'win32', file: string, pins: IVoltInstallerPins | undefined, log: (message: string) => void, run: VoltExec = voltExec): Promise<'verified' | 'unpinned'> {
	if (platform === 'darwin') {
		if (!pins?.darwinTeamIdentifier) {
			log(`update#signature - product.json pins no voltRelease.darwinTeamIdentifier; ${path.basename(file)} is installed without a codesign check`);
			return 'unpinned';
		}
		await verifyDarwinAppSignature(file, pins.darwinTeamIdentifier, run);
	} else {
		if (!pins?.win32Publisher) {
			log(`update#signature - product.json pins no voltRelease.win32Publisher; ${path.basename(file)} runs without an Authenticode check`);
			return 'unpinned';
		}
		await verifyWin32Authenticode(file, pins.win32Publisher, run);
	}
	log(`update#signature - ${path.basename(file)} is signed by the pinned publisher`);
	return 'verified';
}
