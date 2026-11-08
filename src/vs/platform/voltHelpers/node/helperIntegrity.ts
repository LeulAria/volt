/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { FileAccess } from '../../../base/common/network.js';
import { join, relative, sep } from '../../../base/common/path.js';
import { IVoltHelperSigningConfiguration } from '../../../base/common/product.js';
import product from '../../product/common/product.js';
import { fffPinnedDigests } from '../../voltCodeIndex/common/fff.js';
import { deviceHubTreeDigests, isDeviceHubRuntimeFile } from '../../voltDevices/common/deviceHubPin.js';
import { MXC_HELPER_DIGESTS, MXC_HELPER_ID, WXC_EXEC_DIGESTS, WXC_EXEC_HELPER_ID } from '../../voltSandbox/common/mxc.js';

/**
 * Native helpers Volt launches with its own rights (and, on macOS, its privacy grants): speech,
 * desktop control, the FFF file finder, Expo's device hub, and the sandbox's own launchers. Each
 * is checked immediately before every launch (INV-27, spec B-14):
 *
 * - **Bundled helpers** are built with the app (`build/volt/helpers/buildHelpers.mjs`) and listed in
 *   `out/volt-helpers-manifest.json` (see {@link IVoltHelpersManifest}). On macOS a helper must carry a
 *   valid code signature from Volt's team (`product.voltHelperSigning.darwinTeamId`, or the team that
 *   signed the running app); on Windows an Authenticode signature from Volt's publisher. A build
 *   that is not signed (ad-hoc on macOS, unsigned on Windows, every Linux build) checks the file's
 *   SHA-256 against the manifest instead; for a universal Mach-O that is the SHA-256 of this
 *   machine's slice, so one manifest serves both architectures.
 * - **Downloaded helpers** (FFF, the device hub) are checked against digests pinned in Volt's code.
 * - **Unsigned helpers developer mode**: running from sources (`VSCODE_DEV`), helpers may still be
 *   compiled at runtime. {@link trustDeveloperHelper} pins what was built (or found) for the rest of
 *   the session, and the window shows an "Unsigned helpers" badge. Packaged builds never take this path.
 *
 * Every refusal has a reason; nothing falls back to running an unchecked binary.
 *
 * Residual: the check and the launch are two steps, so a same-user process that swaps the file in
 * between wins the race. Bundled helpers sit in the app bundle, which a same-user process can also
 * change (D-08 tracks app-code integrity at rest).
 */

export interface IHelperVerdict {
	readonly ok: boolean;
	readonly reason?: string;
}

/** The manifest's name in `out/`, written by `build/volt/helpers/buildHelpers.mjs`. */
export const VOLT_HELPERS_MANIFEST = 'volt-helpers-manifest.json';

/**
 * `out/volt-helpers-manifest.json`. Paths are relative to `out/` and use `/`. Digests are keyed by
 * `<platform>-<arch>` (`darwin-arm64`, `win32-x64`, `linux-x64`); for a Mach-O file the digest is
 * of that architecture's slice, so the universal build merges the two architectures' manifests.
 */
export interface IVoltHelpersManifest {
	readonly version: 1;
	readonly helpers: { readonly [helperId: string]: IVoltHelperManifestEntry };
}

export interface IVoltHelperManifestEntry {
	/** The first file is the one Volt launches; the rest are files it loads (a script, a DLL). */
	readonly files: readonly { readonly path: string; readonly sha256: { readonly [target: string]: string } }[];
}

export class HelperRefusedError extends Error {
	constructor(readonly helperId: string, readonly reason: string) {
		super(`Volt did not start its ${helperId} helper: ${reason}`);
	}
}

export interface IHelperIntegrityOptions {
	/** Volt's `out/` folder: where bundled helpers and the manifest live. */
	readonly outRoot: () => string;
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	/** Running from sources: the unsigned helpers developer mode. */
	readonly developerMode: boolean;
	readonly signing: () => IVoltHelperSigningConfiguration | undefined;
	/** The signer of the running app, when it is signed (team id on macOS, subject on Windows). */
	readonly appSigner: () => Promise<string | undefined>;
	readonly linuxLibc?: () => 'gnu' | 'musl';
}

const TEAM_ID = /^[A-Z0-9]{10}$/;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

export class HelperIntegrity {

	private manifest: Promise<IVoltHelpersManifest | undefined> | undefined;
	/**
	 * Verdicts that passed, by real path, keyed by `(dev, inode, size, mtime, ctime)` in nanoseconds
	 * plus the check's policy. A changed file cannot keep that key: writing it moves mtime and
	 * ctime, replacing it (rename, a new link) gives the path another inode, and no user process can
	 * set ctime (`utimes` sets only atime and mtime). So a hit is the same bytes that were checked.
	 * Signature checks spawn `codesign`/PowerShell, which is too slow to repeat for every dictation.
	 */
	private readonly passed = new Map<string, string>();
	/** Developer mode only: digests of runtime-built helpers, pinned for this session. */
	private readonly developerPins = new Map<string, string>();
	private signer: Promise<string | undefined> | undefined;

	constructor(private readonly options: IHelperIntegrityOptions) { }

	get developerMode(): boolean {
		return this.options.developerMode;
	}

	/** Where the bundled helper is, when this build lists one for this platform. */
	async bundledPath(helperId: string): Promise<string | undefined> {
		const entry = (await this.readManifest())?.helpers[helperId];
		const first = entry?.files[0];
		return first && first.sha256[this.target()] ? join(this.options.outRoot(), ...first.path.split('/')) : undefined;
	}

	async verify(helperId: string, path: string): Promise<IHelperVerdict> {
		try {
			return await this.doVerify(helperId, path);
		} catch (err) {
			return refuse(`could not check ${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** {@link verify}, throwing a {@link HelperRefusedError} with the reason. */
	async assert(helperId: string, path: string): Promise<void> {
		const verdict = await this.verify(helperId, path);
		if (!verdict.ok) {
			throw new HelperRefusedError(helperId, verdict.reason ?? 'it failed verification');
		}
	}

	/**
	 * Developer mode only: pins the helper Volt just built (or found from an earlier run) at `path`
	 * for the rest of this session, so a later swap is still refused. Refused in a packaged build.
	 */
	async trustDeveloperHelper(helperId: string, path: string): Promise<IHelperVerdict> {
		if (!this.options.developerMode) {
			return refuse('runtime-built helpers run only in the unsigned helpers developer mode (a build from sources)');
		}
		const stat = await fs.lstat(path);
		if (!stat.isFile()) {
			return refuse(`${path} is not a regular file`);
		}
		const real = await fs.realpath(path);
		const pinned = this.developerPins.get(pinKey(helperId, real));
		const digest = sha256(await fs.readFile(real));
		if (pinned && pinned !== digest) {
			return refuse(`${path} changed since Volt built it in this session`);
		}
		this.developerPins.set(pinKey(helperId, real), digest);
		return { ok: true, reason: 'unsigned helpers developer mode' };
	}

	private async doVerify(helperId: string, path: string): Promise<IHelperVerdict> {
		if (helperId === 'device-hub') {
			return this.verifyDeviceHub(path);
		}
		const stat = await fs.lstat(path).catch(() => undefined);
		if (!stat) {
			return refuse(`${path} does not exist`);
		}
		if (!stat.isFile()) {
			return refuse(`${path} is not a regular file`);
		}
		const real = await fs.realpath(path);
		const codePinned = this.codePinnedDigests(helperId);
		if (codePinned) {
			const key = `${await statKey(real)}|${helperId}`;
			if (this.passed.get(real) === key) {
				return { ok: true };
			}
			const digest = sha256(await fs.readFile(real));
			if (!codePinned.digests.includes(digest)) {
				this.passed.delete(real);
				return refuse(`${path} is not the ${codePinned.label} Volt pins (SHA-256 ${digest.slice(0, 12)}...)`);
			}
			this.passed.set(real, key);
			return { ok: true };
		}
		const manifest = await this.readManifest();
		const entry = manifest?.helpers[helperId];
		const outRoot = await fs.realpath(this.options.outRoot()).catch(() => this.options.outRoot());
		const file = entry?.files.find(candidate => samePath(join(outRoot, ...candidate.path.split('/')), real));
		if (!file) {
			const pinned = this.developerPins.get(pinKey(helperId, real));
			if (pinned && this.options.developerMode) {
				const digest = sha256(await fs.readFile(real));
				return digest === pinned ? { ok: true, reason: 'unsigned helpers developer mode' } : refuse(`${path} changed since Volt built it in this session`);
			}
			return refuse(manifest
				? `${path} is not the ${helperId} helper this build ships`
				: `this build has no helper manifest (${VOLT_HELPERS_MANIFEST}), so ${path} cannot be checked`);
		}
		const policy = await this.policyFor(real);
		const key = `${await statKey(real)}|${policy.kind}:${policy.signer ?? ''}`;
		if (this.passed.get(real) === key) {
			return { ok: true };
		}
		const verdict = policy.kind === 'codesign' ? await codesignVerdict(real, policy.signer!)
			: policy.kind === 'authenticode' ? await authenticodeVerdict(real, policy.signer!)
				: await this.digestVerdict(real, file.sha256);
		if (verdict.ok) {
			this.passed.set(real, key);
		} else {
			this.passed.delete(real);
		}
		return verdict;
	}

	/**
	 * Helpers Volt doesn't build, pinned by digest in its code: FFF's release, and the Windows
	 * sandbox's Microsoft-signed `wxc-exec.exe` (from the pinned `@microsoft/mxc-sdk`) with Volt's
	 * reproducibly built `volt-mxc-helper` (C7).
	 */
	private codePinnedDigests(helperId: string): { readonly digests: readonly string[]; readonly label: string } | undefined {
		switch (helperId) {
			case 'fff': return { digests: fffPinnedDigests(this.options.platform, this.options.arch), label: 'FFF release' };
			case WXC_EXEC_HELPER_ID: return { digests: Object.values(WXC_EXEC_DIGESTS), label: 'wxc-exec release' };
			case MXC_HELPER_ID: return { digests: Object.values(MXC_HELPER_DIGESTS), label: 'volt-mxc-helper build' };
			default: return undefined;
		}
	}

	/** Signature checks for binaries on signed macOS and Windows builds; the manifest digest otherwise. */
	private async policyFor(real: string): Promise<{ kind: 'codesign' | 'authenticode' | 'digest'; signer?: string }> {
		const platform = this.options.platform;
		if (platform === 'darwin' && await isMachO(real)) {
			const team = this.options.signing()?.darwinTeamId ?? await this.appSigner();
			if (team) {
				return { kind: 'codesign', signer: team };
			}
		}
		if (platform === 'win32' && /\.(exe|dll)$/i.test(real)) {
			const publisher = this.options.signing()?.win32Publisher ?? await this.appSigner();
			if (publisher) {
				return { kind: 'authenticode', signer: publisher };
			}
		}
		return { kind: 'digest' };
	}

	private appSigner(): Promise<string | undefined> {
		this.signer ??= this.options.appSigner().catch(() => undefined);
		return this.signer;
	}

	private async digestVerdict(real: string, digests: { readonly [target: string]: string }): Promise<IHelperVerdict> {
		const expected = digests[this.target()];
		if (!expected) {
			return refuse(`this build has no ${this.target()} digest for ${real}`);
		}
		const bytes = await fs.readFile(real);
		const slice = this.options.platform === 'darwin' ? machOSlice(bytes, this.options.arch) : bytes;
		if (!slice) {
			return refuse(`${real} has no ${this.options.arch} code`);
		}
		const digest = sha256(slice);
		return digest === expected ? { ok: true } : refuse(`${real} does not match this build's manifest (SHA-256 ${digest.slice(0, 12)}..., expected ${expected.slice(0, 12)}...)`);
	}

	private async verifyDeviceHub(dir: string): Promise<IHelperVerdict> {
		const target = this.options.platform === 'linux' ? `${this.target()}-${this.options.linuxLibc?.() ?? 'gnu'}` : this.target();
		const expected = deviceHubTreeDigests[target];
		if (!expected) {
			return refuse(`Volt pins no device hub for ${target}`);
		}
		const digest = await treeDigest(join(dir, 'node_modules'), isDeviceHubRuntimeFile);
		return digest === expected ? { ok: true } : refuse(`the installed device hub in ${dir} is not the one Volt pins (tree SHA-256 ${digest.slice(0, 12)}...)`);
	}

	private target(): string {
		return `${this.options.platform}-${this.options.arch}`;
	}

	private readManifest(): Promise<IVoltHelpersManifest | undefined> {
		this.manifest ??= fs.readFile(join(this.options.outRoot(), VOLT_HELPERS_MANIFEST), 'utf8').then(text => {
			const parsed = JSON.parse(text) as IVoltHelpersManifest;
			return parsed && parsed.version === 1 && parsed.helpers && typeof parsed.helpers === 'object' ? parsed : undefined;
		}, () => undefined);
		return this.manifest;
	}
}

function refuse(reason: string): IHelperVerdict {
	return { ok: false, reason };
}

function pinKey(helperId: string, real: string): string {
	return `${helperId}\n${real}`;
}

function samePath(a: string, b: string): boolean {
	return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sha256(bytes: Uint8Array | string): string {
	return createHash('sha256').update(bytes).digest('hex');
}

async function statKey(path: string): Promise<string> {
	const stat = await fs.stat(path, { bigint: true });
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

async function isMachO(path: string): Promise<boolean> {
	const handle = await fs.open(path, 'r');
	try {
		const head = Buffer.alloc(4);
		await handle.read(head, 0, 4, 0);
		const magic = head.readUInt32BE(0);
		return magic === 0xcafebabe || magic === 0xcafebabf || magic === 0xcffaedfe || magic === 0xcefaedfe || magic === 0xfeedfacf || magic === 0xfeedface;
	} finally {
		await handle.close();
	}
}

/**
 * The bytes of `arch`'s code in a Mach-O file: the whole file when it is thin, that slice when it
 * is universal. `lipo` copies each slice unchanged, so its digest is the one the arch's build saw.
 * Undefined for a universal file without that architecture.
 */
export function machOSlice(bytes: Buffer, arch: string): Buffer | undefined {
	if (bytes.length < 8) {
		return bytes;
	}
	const magic = bytes.readUInt32BE(0);
	if (magic !== 0xcafebabe && magic !== 0xcafebabf) {
		return bytes;
	}
	const wide = magic === 0xcafebabf;
	const count = bytes.readUInt32BE(4);
	const wanted = arch === 'arm64' ? CPU_TYPE_ARM64 : arch === 'x64' ? CPU_TYPE_X86_64 : -1;
	const entrySize = wide ? 32 : 20;
	for (let i = 0; i < count && 8 + (i + 1) * entrySize <= bytes.length; i++) {
		const at = 8 + i * entrySize;
		if (bytes.readUInt32BE(at) !== wanted) {
			continue;
		}
		const offset = wide ? Number(bytes.readBigUInt64BE(at + 8)) : bytes.readUInt32BE(at + 8);
		const size = wide ? Number(bytes.readBigUInt64BE(at + 16)) : bytes.readUInt32BE(at + 12);
		return offset + size <= bytes.length ? bytes.subarray(offset, offset + size) : undefined;
	}
	return undefined;
}

/**
 * One SHA-256 over a folder: every file and symlink below it, sorted by path, as
 * `<path>\0f\0<sha256>\n` or `<path>\0l\0<link target>\n`. Paths are relative and use `/`.
 * `ignore` leaves out files the tool itself writes there at runtime.
 */
export async function treeDigest(root: string, ignore: (relativePath: string) => boolean = () => false): Promise<string> {
	const entries: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
			const path = join(dir, dirent.name);
			const rel = relative(root, path).split(sep).join('/');
			if (dirent.isDirectory()) {
				await walk(path);
			} else if (ignore(rel)) {
				continue;
			} else if (dirent.isSymbolicLink()) {
				entries.push(`${rel}\0l\0${await fs.readlink(path)}\n`);
			} else if (dirent.isFile()) {
				entries.push(`${rel}\0f\0${sha256(await fs.readFile(path))}\n`);
			} else {
				entries.push(`${rel}\0o\0\n`);
			}
		}
	};
	await walk(root);
	entries.sort();
	const hash = createHash('sha256');
	for (const entry of entries) {
		hash.update(entry);
	}
	return hash.digest('hex');
}

function codesignVerdict(path: string, team: string): Promise<IHelperVerdict> {
	if (!TEAM_ID.test(team)) {
		return Promise.resolve(refuse(`"${team}" is not an Apple team id`));
	}
	const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${team}"`;
	return new Promise(resolve => execFile('/usr/bin/codesign', ['--verify', '--strict', `-R${requirement}`, path], { timeout: 30_000 }, (error, _stdout, stderr) => {
		resolve(error ? refuse(`${path} is not signed by Volt's team ${team}: ${String(stderr || error.message).trim().split('\n').pop()}`) : { ok: true });
	}));
}

function powershell(): string {
	return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** `Status|Subject` of a file's Authenticode signature. The path is passed as data, never as script. */
function authenticode(path: string): Promise<{ status: string; subject: string }> {
	const script = '$s = Get-AuthenticodeSignature -LiteralPath $env:VOLT_HELPER_PATH; Write-Output ("" + $s.Status + "|" + $s.SignerCertificate.Subject)';
	return new Promise((resolve, reject) => execFile(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
		timeout: 30_000,
		windowsHide: true,
		env: { SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows', VOLT_HELPER_PATH: path },
	}, (error, stdout) => {
		if (error) {
			reject(error);
			return;
		}
		const [status, ...subject] = String(stdout).trim().split('|');
		resolve({ status, subject: subject.join('|') });
	}));
}

async function authenticodeVerdict(path: string, publisher: string): Promise<IHelperVerdict> {
	const { status, subject } = await authenticode(path);
	if (status !== 'Valid') {
		return refuse(`${path} has no valid Authenticode signature (${status || 'unknown'})`);
	}
	return subject === publisher ? { ok: true } : refuse(`${path} is signed by ${subject}, not by ${publisher}`);
}

/** The team id (macOS) or certificate subject (Windows) that signed this app; undefined when unsigned or ad-hoc. */
export async function runningAppSigner(platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
	if (platform === 'darwin') {
		const output = await new Promise<string>(resolve => execFile('/usr/bin/codesign', ['-dv', '--verbose=2', process.execPath], { timeout: 15_000 }, (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`)));
		const team = /^TeamIdentifier=(\S+)$/m.exec(output)?.[1];
		return team && TEAM_ID.test(team) ? team : undefined;
	}
	if (platform === 'win32') {
		const { status, subject } = await authenticode(process.execPath);
		return status === 'Valid' && subject ? subject : undefined;
	}
	return undefined;
}

function linuxLibc(): 'gnu' | 'musl' {
	const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
	return report?.header?.glibcVersionRuntime ? 'gnu' : 'musl';
}

let defaultIntegrity: HelperIntegrity | undefined;

/** The checker for this process: Volt's own `out/`, its product.json and the running app's signer. */
export function helperIntegrity(): HelperIntegrity {
	defaultIntegrity ??= new HelperIntegrity({
		outRoot: () => FileAccess.asFileUri('').fsPath,
		platform: process.platform,
		arch: process.arch,
		developerMode: !!process.env['VSCODE_DEV'],
		signing: () => product.voltHelperSigning,
		appSigner: () => runningAppSigner(),
		linuxLibc,
	});
	return defaultIntegrity;
}

/** Checks the helper at `path` right before Volt launches it. Shared by every helper launch site. */
export function verifyHelperBinary(helperId: string, path: string): Promise<IHelperVerdict> {
	return helperIntegrity().verify(helperId, path);
}

/** Whether this process runs in the unsigned helpers developer mode (a build from sources). */
export function isUnsignedHelpersMode(): boolean {
	return helperIntegrity().developerMode;
}
