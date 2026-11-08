/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IResolvedSandboxPolicy } from './sandboxResolved.js';
import { SandboxDimension } from './sandboxSchema.js';

/**
 * Windows 11: Volt's policy as an MXC ProcessContainer request (spec J.3), and the pure checks
 * around it: the OS build floor, the image classifier (MSYS2, Cygwin, WSL), Windows command-line
 * quoting, and how the parent reads the prologue's status file and the helper's attestation.
 *
 * Volt launches Microsoft's signed `wxc-exec.exe` with a pinned `version: "1.0.0"` request rather
 * than the Node SDK (`@microsoft/mxc-sdk` needs Node 24; Electron 37 ships 22.19). The request's
 * process is Volt's own prologue (`volt-mxc-helper prologue`), which blocks until the parent has
 * attested it from outside and only then starts the workload. Nothing here touches the disk.
 */

/** The request contract Volt writes. `1.1.0-alpha` would turn on required telemetry. */
export const MXC_CONFIG_VERSION = '1.0.0';
/** The `@microsoft/mxc-sdk` release `wxc-exec.exe` comes from (npm tarball, MIT). */
export const MXC_SDK_VERSION = '1.0.1';
export const MXC_SDK_TARBALL = `https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-${MXC_SDK_VERSION}.tgz`;
export const MXC_SDK_INTEGRITY = 'sha512-2cP925G5+lQyKzjBVha8uNtVd7XESgDBtgi1yCYYSo9M3xiFyZWtCO4SWPGTk509rdI6nqjyGcZxvEP3t6l8Hg==';

export type MxcArch = 'arm64' | 'x64';

/** SHA-256 of `package/bin/<arch>/wxc-exec.exe` in the pinned tarball (Authenticode: Microsoft Corporation). */
export const WXC_EXEC_DIGESTS: Readonly<Record<MxcArch, string>> = {
	arm64: '91aa4171e8809f33f19622c381116188eab7d8c8cffad231230a31b58146ee77',
	x64: '090f5d1f7bb93104ab08dcd4e8034ef954aeefcdaf6658dde5f7dff4cfc12f3a',
};

/**
 * SHA-256 of `volt-mxc-helper.exe` as built by build/volt/mxc/buildHelper.mjs with zig 0.16.0.
 * The build is reproducible; CI rebuilds it on Windows and fails when these differ. Update them
 * whenever voltMxcHelper.c changes.
 */
export const MXC_HELPER_DIGESTS: Readonly<Record<MxcArch, string>> = {
	arm64: '8e8e408b7a768c20c0c28958dc667a4aad0b4cc581fc6f1a8a4d2c4cb3da4dd3',
	x64: '079dcc860f30c4ea7948bf28bd9ced713cfa5985b3cf9545714dcbd68da41d74',
};

export const WXC_EXEC_HELPER_ID = 'mxc.wxc-exec';
export const MXC_HELPER_ID = 'mxc.volt-mxc-helper';

/** Exit codes of the prologue. */
export const MXC_PROLOGUE_FAILED = 125;
export const MXC_LIMIT_EXIT = 137;

// --- OS build floor -----------------------------------------------------------------------------

export interface IWindowsVersion {
	readonly major: number;
	readonly minor: number;
	readonly build: number;
	readonly ubr: number;
}

/** `10.0.26200.9725`, `Microsoft Windows [Version 10.0.26200.9725]`, or `ver` output. */
export function parseWindowsVersion(text: string): IWindowsVersion | undefined {
	const match = /(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(text);
	if (!match) {
		return undefined;
	}
	const [major, minor, build, ubr] = match.slice(1, 5).map(Number);
	return { major, minor, build, ubr };
}

/**
 * The first update of each Windows 11 release with ProcessContainer (BaseContainer through PSEC),
 * from microsoft/mxc docs/backends/process-container/os-version-support.md. In-container loopback
 * servers need .9550 on 24H2/25H2.
 */
export const MXC_BUILD_FLOOR: readonly { readonly build: number; readonly ubr: number; readonly release: string }[] = [
	{ build: 26100, ubr: 9278, release: '24H2' },
	{ build: 26200, ubr: 9278, release: '25H2' },
	{ build: 26300, ubr: 9550, release: '26H2' },
	{ build: 28000, ubr: 2804, release: '26H1' },
];

export type WindowsSupport =
	| { readonly ok: true; readonly release: string; readonly note?: string }
	| { readonly ok: false; readonly reason: string };

/**
 * Whether this Windows can run MXC at all, before any trial. `installationType` is the registry's
 * `InstallationType` (`Client`, `Server`, `Server Core`). The registry's `ProductName` still says
 * "Windows 10" on Windows 11, so only the build number decides the release.
 */
export function checkWindowsFloor(version: IWindowsVersion | undefined, installationType: string | undefined): WindowsSupport {
	if (!version || version.major !== 10) {
		return { ok: false, reason: 'Could not read the Windows version.' };
	}
	if (installationType && /server/i.test(installationType)) {
		return { ok: false, reason: 'Windows Server has no ProcessContainer support (MXC needs Windows 11 24H2 or later, client editions).' };
	}
	if (version.build < 22000) {
		return { ok: false, reason: 'Windows 10 cannot sandbox Volt\'s agents. Windows 11 24H2 or later is required.' };
	}
	const known = MXC_BUILD_FLOOR.find(entry => entry.build === version.build);
	if (known) {
		return version.ubr >= known.ubr
			? { ok: true, release: known.release }
			: { ok: false, reason: `Windows 11 ${known.release} needs update ${version.build}.${known.ubr} or later for sandboxing (this is ${version.build}.${version.ubr}). Install the latest Windows update.` };
	}
	if (version.build > 26300) {
		return { ok: true, release: `build ${version.build}`, note: 'Build not in MXC\'s support table; the probe trial decides.' };
	}
	return { ok: false, reason: `Windows 11 build ${version.build} is older than 24H2. Sandboxing needs Windows 11 24H2 (26100.9278) or later.` };
}

// --- PE images ----------------------------------------------------------------------------------

export interface IPeInfo {
	readonly machine: number;
	readonly dllCharacteristics: number;
	/** Lower-cased DLL names from the import and delay-import tables. */
	readonly imports: readonly string[];
}

export const PE_DYNAMIC_BASE = 0x0040;

/** Reads the PE headers and import names; undefined for anything that is not a PE image. */
export function readPeInfo(data: Uint8Array): IPeInfo | undefined {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const u16 = (o: number) => o + 2 <= data.length ? view.getUint16(o, true) : -1;
	const u32 = (o: number) => o + 4 <= data.length ? view.getUint32(o, true) : -1;
	if (data.length < 0x40 || data[0] !== 0x4d || data[1] !== 0x5a) {
		return undefined;
	}
	const pe = u32(0x3c);
	if (pe < 0 || u32(pe) !== 0x00004550) {
		return undefined;
	}
	const machine = u16(pe + 4);
	const sections = u16(pe + 6);
	const optSize = u16(pe + 20);
	const opt = pe + 24;
	const magic = u16(opt);
	if (magic !== 0x10b && magic !== 0x20b) {
		return undefined;
	}
	const dllCharacteristics = u16(opt + 70);
	const dirs = opt + (magic === 0x20b ? 112 : 96);
	const table = opt + optSize;
	const toOffset = (rva: number): number => {
		for (let i = 0; i < sections; i++) {
			const s = table + i * 40;
			const va = u32(s + 12), rawSize = u32(s + 16), raw = u32(s + 20), vsize = u32(s + 8);
			if (rva >= va && rva < va + Math.max(rawSize, vsize)) {
				return rva - va + raw;
			}
		}
		return -1;
	};
	const cString = (offset: number): string | undefined => {
		if (offset < 0) {
			return undefined;
		}
		let end = offset;
		while (end < data.length && data[end] !== 0 && end - offset < 260) {
			end++;
		}
		return end < data.length ? String.fromCharCode(...data.subarray(offset, end)).toLowerCase() : undefined;
	};
	const imports: string[] = [];
	// Directory 1: imports (20-byte descriptors, name RVA at +12). Directory 13: delay imports (32 bytes, name RVA at +4).
	for (const [dir, size, nameAt] of [[1, 20, 12], [13, 32, 4]] as const) {
		const rva = u32(dirs + dir * 8);
		if (rva <= 0) {
			continue;
		}
		let offset = toOffset(rva);
		for (let i = 0; offset >= 0 && i < 512; i++, offset += size) {
			const name = u32(offset + nameAt);
			if (name <= 0) {
				break;
			}
			const text = cString(toOffset(name));
			if (text) {
				imports.push(text);
			}
		}
	}
	return { machine, dllCharacteristics, imports: [...new Set(imports)] };
}

// --- Image classifier ---------------------------------------------------------------------------

export type WindowsImageKind = 'native' | 'msys' | 'cygwin' | 'wsl';

export interface IWindowsImageClass {
	readonly kind: WindowsImageKind;
	/** Why a non-native image is refused, for the user. */
	readonly reason?: string;
}

const WSL_IMAGES: ReadonlySet<string> = new Set(['wsl.exe', 'wslg.exe', 'wslhost.exe', 'wslconfig.exe', 'wslservice.exe', 'ubuntu.exe', 'debian.exe', 'kali.exe']);

export const GIT_BASH_REFUSAL = 'Git Bash, MSYS2 and Cygwin programs cannot start inside the Windows sandbox (their runtime needs the global object namespace, microsoft/mxc#1061). Use PowerShell or cmd for this chat, or set the chat\'s sandbox to Off.';
export const WSL_REFUSAL = 'WSL starts a Linux VM outside the Windows sandbox, so it is never run from a sandboxed chat. Use PowerShell or cmd, or set the chat\'s sandbox to Off.';

/**
 * Classifies the program a sandboxed command would start. WSL is refused because it escapes the
 * container; MSYS2/Cygwin (Git Bash) because their runtime cannot initialise in an AppContainer
 * (MXC#1061). `approvedRuntime` marks an image inside a Volt-prepared AppContainer-compatible
 * runtime copy, checked by the caller (digest of its msys-2.0.dll and the image's ASLR flag).
 * Native programs that later start `sh.exe` (git hooks, credential helpers) are not caught here;
 * they fail inside the sandbox with the same error, which is not an escape.
 */
export function classifyWindowsImage(path: string, pe: IPeInfo | undefined, approvedRuntime = false): IWindowsImageClass {
	const lower = path.replace(/\//g, '\\').toLowerCase();
	const name = lower.slice(lower.lastIndexOf('\\') + 1);
	if (WSL_IMAGES.has(name) || (name === 'bash.exe' && /\\windows\\(system32|sysnative|syswow64)\\bash\.exe$/.test(lower)) || lower.includes('\\windowsapps\\microsoftcorporationii.windowssubsystemforlinux')) {
		return { kind: 'wsl', reason: WSL_REFUSAL };
	}
	const imports = pe?.imports ?? [];
	const cygwin = imports.includes('cygwin1.dll') || /\\cygwin(64)?\\(usr\\)?bin\\/.test(lower);
	const msys = imports.includes('msys-2.0.dll') || /\\git\\usr\\bin\\|\\msys(64|32)?\\(usr\\)?bin\\|\\msys2\\/.test(lower)
		// Git's own launchers start usr\bin\bash.exe.
		|| /\\git\\(bin\\(bash|sh)\.exe|git-bash\.exe|git-cmd\.exe)$/.test(lower);
	if ((cygwin || msys) && !approvedRuntime) {
		return { kind: cygwin && !msys ? 'cygwin' : 'msys', reason: GIT_BASH_REFUSAL };
	}
	if (cygwin || msys) {
		return { kind: cygwin && !msys ? 'cygwin' : 'msys' };
	}
	return { kind: 'native' };
}

// --- Windows paths ------------------------------------------------------------------------------

/** `C:\a\b` with backslashes, no trailing separator (except a drive root `C:\`). */
export function normalizeWindowsPath(path: string): string {
	let p = path.replace(/\//g, '\\');
	const unc = p.startsWith('\\\\');
	p = (unc ? '\\\\' : '') + p.slice(unc ? 2 : 0).replace(/\\{2,}/g, '\\');
	if (/^[A-Za-z]:$/.test(p)) {
		return `${p}\\`;
	}
	if (p.length > 3 && p.endsWith('\\')) {
		p = p.slice(0, -1);
	}
	return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
}

export function windowsPathKey(path: string): string {
	return normalizeWindowsPath(path).toLowerCase();
}

export function isWindowsPathInside(path: string, root: string): boolean {
	const p = windowsPathKey(path);
	const r = windowsPathKey(root);
	return p === r || p.startsWith(r.endsWith('\\') ? r : `${r}\\`);
}

/** A drive root (`C:\`) or a share root (`\\server\share`): MXC grants on these never cascade, and Volt never grants them. */
export function isWindowsVolumeRoot(path: string): boolean {
	const p = normalizeWindowsPath(path);
	return /^[A-Za-z]:\\$/.test(p) || /^\\\\[^\\]+(\\[^\\]+)?$/.test(p) || /^\\\\[?.]\\[A-Za-z]:\\?$/.test(p);
}

/** Every proper ancestor folder, from the volume root down. */
export function windowsAncestors(path: string): string[] {
	const p = normalizeWindowsPath(path);
	const drive = /^[A-Za-z]:\\/.exec(p);
	if (!drive) {
		return [];
	}
	const parts = p.slice(3).split('\\').filter(Boolean);
	const out = [drive[0]];
	for (let i = 1; i < parts.length; i++) {
		out.push(`${drive[0]}${parts.slice(0, i).join('\\')}`);
	}
	return out;
}

function uniqueWindowsPaths(paths: Iterable<string>): string[] {
	const seen = new Map<string, string>();
	for (const path of paths) {
		const normal = normalizeWindowsPath(path);
		seen.set(normal.toLowerCase(), seen.get(normal.toLowerCase()) ?? normal);
	}
	return [...seen.values()];
}

// --- Command lines ------------------------------------------------------------------------------

/** One argument as CommandLineToArgvW and the MSVC runtime read it (ported from VS Code's MXC runtime). */
export function quoteWindowsArgument(value: string): string {
	if (value && !/[\s"]/.test(value)) {
		return value;
	}
	return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&')}"`;
}

/** cmd.exe metacharacters: an argument with any of them cannot be passed to a batch file safely. */
const CMD_META = /[&|<>^%!"\r\n]/;

export class MxcPolicyError extends Error {
	constructor(message: string, readonly dimension?: SandboxDimension) {
		super(message);
		this.name = 'MxcPolicyError';
	}
}

/**
 * The command line CreateProcessW runs. `file` is an absolute, already resolved path. Batch files
 * run through `cmd.exe /d /s /c`, and only with arguments cmd.exe cannot reinterpret.
 */
export function windowsCommandLine(file: string, args: readonly string[], comSpec: string): string {
	for (const value of [file, ...args]) {
		if (/[\u0000\r\n]/.test(value)) {
			throw new MxcPolicyError('A command or argument with a line break or NUL cannot be run in the Windows sandbox.');
		}
	}
	if (/\.(cmd|bat)$/i.test(file)) {
		const bad = [file, ...args].find(value => CMD_META.test(value));
		if (bad !== undefined) {
			throw new MxcPolicyError(`A batch file's arguments cannot contain cmd.exe metacharacters (& | < > ^ % ! "): ${JSON.stringify(bad)}`);
		}
		const inner = [file, ...args].map(value => /\s/.test(value) || !value ? `"${value}"` : value).join(' ');
		return `${quoteWindowsArgument(comSpec)} /d /s /c "${inner}"`;
	}
	return [file, ...args].map(quoteWindowsArgument).join(' ');
}

// --- The request --------------------------------------------------------------------------------

export interface IMxcRequest {
	readonly version: typeof MXC_CONFIG_VERSION;
	readonly containment: 'processcontainer';
	readonly lifecycle: { readonly destroyOnExit: true };
	readonly process: {
		readonly commandLine: string;
		readonly cwd: string;
		readonly env: readonly string[];
		readonly inheritDefaultEnv: false;
		readonly timeout: number;
	};
	readonly filesystem: {
		readonly readonlyPaths: readonly string[];
		readonly readwritePaths: readonly string[];
		readonly deniedPaths: readonly string[];
	};
	readonly network: {
		readonly egress: { readonly default: 'allow' | 'deny' };
		readonly ingress: { readonly default: 'allow' | 'deny'; readonly hostLoopback: 'allow' | 'deny' };
	};
	readonly runtimeConfig?: { readonly networkProxy: string };
	readonly ui: { readonly disable: false; readonly clipboard: 'none'; readonly injection: false };
	readonly processContainer: {
		readonly ui: { readonly isolation: 'container'; readonly desktopSystemControl: false; readonly systemSettings: 'none'; readonly ime: false };
		readonly filesystem?: { readonly enumeratePaths: readonly string[] };
	};
	readonly telemetry: { readonly enabled: false };
}

export interface IMxcRequestInput {
	/** Resolved for win32: every path a real Windows path. */
	readonly policy: IResolvedSandboxPolicy;
	/** The verified prologue copy and its control file, both in the run's control folder. */
	readonly helperPath: string;
	readonly controlFile: string;
	readonly controlDir: string;
	readonly systemRoot: string;
	readonly proxyPort?: number;
	/** Existing paths matched by `**\/` deny and protect patterns (bounded walk). */
	readonly patternDeny: readonly string[];
	readonly patternProtect: readonly string[];
	/** Lower-cased keys (windowsPathKey) of the paths that exist; protections that do not exist are skipped. */
	readonly existing: ReadonlySet<string>;
	/** Process timeout for wxc-exec, in ms; 0 for none (Volt's own timer still applies). */
	readonly timeoutMs: number;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_()]{0,127}$/;

/** Names that look up executables or DLLs relative to the current folder are turned off for the workload. */
const HARDENING_ENV: Readonly<Record<string, string>> = { NoDefaultCurrentDirectoryInExePath: '1' };

/**
 * Volt's resolved policy as an MXC request (J.3). Throws `MxcPolicyError` for anything MXC cannot
 * express without widening it: reads of everything, a volume root or the profile root, unix
 * sockets, direct loopback ports, or "no new processes".
 */
export function buildMxcRequest(input: IMxcRequestInput): IMxcRequest {
	const { policy } = input;
	if (policy.readAll) {
		throw new MxcPolicyError('The Windows sandbox reads only listed folders; a policy that reads the whole disk cannot be enforced.', 'filesystem.read');
	}
	const home = windowsPathKey(policy.home);
	const broad = (path: string) => {
		const key = windowsPathKey(path);
		return isWindowsVolumeRoot(path) || key === home || home.startsWith(`${key}\\`) || /^[a-z]:\\users$/.test(key);
	};
	for (const [kind, paths] of [['read', policy.read], ['write', policy.write], ['write', policy.writeFiles]] as const) {
		const bad = paths.find(broad);
		if (bad) {
			throw new MxcPolicyError(`The Windows sandbox never grants a drive root, C:\\Users or the profile folder (${kind}: ${bad}).`, kind === 'read' ? 'filesystem.read' : 'filesystem.write');
		}
	}
	if (policy.unixSockets.length) {
		throw new MxcPolicyError('Unix socket grants are not supported by the Windows sandbox.', 'host.unixSockets');
	}
	if (policy.network.mode !== 'host' && policy.network.loopbackPorts.length) {
		throw new MxcPolicyError('MXC cannot open single loopback ports: host loopback opens every port (microsoft/mxc#1665).', 'network.loopbackPorts');
	}
	if (policy.limits.processes !== undefined && policy.limits.processes <= 1) {
		throw new MxcPolicyError('"No new processes" cannot be enforced on Windows: shells need children and MXC has no process limit.', 'limits.processes');
	}
	if (policy.network.mode === 'proxy' && !input.proxyPort) {
		throw new MxcPolicyError('Network through Volt\'s proxy needs the proxy to be running.', 'network.proxy');
	}

	const exists = (path: string) => input.existing.has(windowsPathKey(path));
	const writable = uniqueWindowsPaths([...policy.write, ...policy.writeFiles]);
	const protect = uniqueWindowsPaths([...policy.protect.filter(exists), ...input.patternProtect])
		.filter(path => writable.some(root => isWindowsPathInside(path, root)));
	const readonly = uniqueWindowsPaths([...policy.read, input.controlDir, ...protect]);
	const denied = uniqueWindowsPaths([...policy.deny, ...input.patternDeny]);
	// Tools look upward from their folders (Node's realpath lstat()s every ancestor); BaseContainer
	// then needs list/query access to each ancestor, never read access to its files.
	const granted = [...readonly, ...writable, policy.cwd];
	const enumerate = uniqueWindowsPaths(granted.flatMap(windowsAncestors))
		.filter(path => !granted.some(grant => windowsPathKey(grant) === windowsPathKey(path)))
		.filter(path => !denied.some(deny => isWindowsPathInside(path, deny)));

	const env = workloadEnv(policy, input.systemRoot, writable);
	const network = policy.network.mode === 'host'
		? { egress: { default: 'allow' as const }, ingress: { default: 'allow' as const, hostLoopback: 'allow' as const } }
		: policy.network.mode === 'proxy'
			// Model 2 for an unpackaged, identity-less proxy: MXC requires hostLoopback "allow" with
			// runtimeConfig.networkProxy and then lets WFP pass only the proxy's address and port.
			? { egress: { default: 'deny' as const }, ingress: { default: 'allow' as const, hostLoopback: 'allow' as const } }
			: { egress: { default: 'deny' as const }, ingress: { default: 'deny' as const, hostLoopback: 'deny' as const } };
	return {
		version: MXC_CONFIG_VERSION,
		containment: 'processcontainer',
		lifecycle: { destroyOnExit: true },
		process: {
			commandLine: `${quoteWindowsArgument(input.helperPath)} prologue ${quoteWindowsArgument(input.controlFile)}`,
			cwd: normalizeWindowsPath(policy.cwd),
			env: Object.entries(env).map(([name, value]) => `${name}=${value}`),
			inheritDefaultEnv: false,
			timeout: Math.max(0, Math.min(input.timeoutMs, 0xffffffff)),
		},
		filesystem: { readonlyPaths: readonly, readwritePaths: writable, deniedPaths: denied },
		network,
		...(policy.network.mode === 'proxy' ? { runtimeConfig: { networkProxy: `http://127.0.0.1:${input.proxyPort}` } } : {}),
		ui: { disable: false, clipboard: 'none', injection: false },
		processContainer: {
			ui: { isolation: 'container', desktopSystemControl: false, systemSettings: 'none', ime: false },
			...(enumerate.length ? { filesystem: { enumeratePaths: enumerate } } : {}),
		},
		telemetry: { enabled: false },
	};
}

/**
 * The workload's environment: the resolved policy's, plus what Windows programs cannot start
 * without (MXC requires SystemRoot and LOCALAPPDATA), temp folders in the run's own folder, and
 * PATH with writable folders moved behind the system ones (F.7.6).
 */
export function workloadEnv(policy: IResolvedSandboxPolicy, systemRoot: string, writable: readonly string[]): Record<string, string> {
	const env: Record<string, string> = {};
	const has = (name: string) => Object.keys(env).some(key => key.toLowerCase() === name.toLowerCase());
	const set = (name: string, value: string) => {
		for (const key of Object.keys(env)) {
			if (key.toLowerCase() === name.toLowerCase()) {
				delete env[key];
			}
		}
		env[name] = value;
	};
	for (const [name, value] of Object.entries(policy.env)) {
		if (!ENV_NAME.test(name) || value.includes('\u0000')) {
			throw new MxcPolicyError(`Environment variable ${JSON.stringify(name)} cannot be passed to the Windows sandbox.`, 'env.clear');
		}
		set(name, value);
	}
	const tmp = normalizeWindowsPath(policy.tmp);
	const profile = `${tmp}\\home`;
	set('SystemRoot', systemRoot);
	set('TEMP', tmp);
	set('TMP', tmp);
	if (!has('windir')) {
		set('windir', systemRoot);
	}
	if (!has('ComSpec')) {
		set('ComSpec', `${systemRoot}\\System32\\cmd.exe`);
	}
	if (!has('PATHEXT')) {
		set('PATHEXT', '.COM;.EXE;.BAT;.CMD');
	}
	if (!has('USERPROFILE')) {
		set('USERPROFILE', env.HOME ?? profile);
	}
	if (!has('LOCALAPPDATA')) {
		set('LOCALAPPDATA', `${profile}\\AppData\\Local`);
	}
	if (!has('APPDATA')) {
		set('APPDATA', `${profile}\\AppData\\Roaming`);
	}
	const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
	const entries = (pathKey ? env[pathKey] : '').split(';').filter(Boolean);
	// System folders lead (as in Windows' own machine-then-user PATH), then the rest, then
	// anything writable, so nothing the workload can plant shadows a system program.
	const system = [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`];
	const isSystem = (dir: string) => system.some(entry => windowsPathKey(entry) === windowsPathKey(dir));
	const inWritable = (dir: string) => writable.some(root => isWindowsPathInside(dir, root));
	const rest = entries.filter(dir => !isSystem(dir));
	set('PATH', [...system, ...rest.filter(dir => !inWritable(dir)), ...rest.filter(inWritable)].join(';'));
	for (const [name, value] of Object.entries(HARDENING_ENV)) {
		set(name, value);
	}
	return env;
}

// --- Prologue control and status ----------------------------------------------------------------

export interface IMxcControl {
	readonly nonce: string;
	readonly statusFile: string;
	readonly goFile: string;
	/** A file outside every grant: the prologue's open of it must be refused. */
	readonly sentinel: string;
	readonly network: IResolvedSandboxPolicy['network']['mode'];
	/** A host loopback port the container must not reach (Volt's canary listener). */
	readonly canaryPort?: number;
	readonly limits: IResolvedSandboxPolicy['limits'];
	/** The run's temp folder: MXC replaces TEMP and TMP with a container folder it does not create, so the prologue sets them back. */
	readonly temp?: string;
	readonly commandLine: string;
}

/** The prologue's control file: `key=value` lines, `cmd` last. */
export function mxcControlText(control: IMxcControl): string {
	for (const value of [control.nonce, control.statusFile, control.goFile, control.sentinel, control.temp ?? '', control.commandLine]) {
		if (/[\r\n\u0000]/.test(value)) {
			throw new MxcPolicyError('A path or command with a line break cannot be passed to the Windows sandbox.');
		}
	}
	const lines = [
		`nonce=${control.nonce}`,
		`status=${control.statusFile}`,
		`go=${control.goFile}`,
		`sentinel=${control.sentinel}`,
		`net=${control.network}`,
		`canaryPort=${control.canaryPort ?? 0}`,
		`cpuSeconds=${control.limits.cpuSeconds ?? 0}`,
		`memoryMB=${control.limits.memoryMB ?? 0}`,
		`processes=${control.limits.processes ?? 0}`,
		...(control.temp ? [`temp=${control.temp}`] : []),
		`cmd=${control.commandLine}`,
	];
	return `${lines.join('\n')}\n`;
}

export interface IMxcStatus {
	readonly ready?: {
		readonly pid: number;
		readonly nonce: string;
		readonly inJob: boolean;
		readonly ui?: number;
		readonly sentinel: number;
		readonly publicConnect: number;
		readonly loopbackConnect: number;
	};
	readonly started?: number;
	readonly limit?: { readonly resource: 'cpu' | 'memory' | 'processes'; readonly value: number };
	readonly exit?: number;
	readonly nogo: boolean;
	readonly error?: string;
}

export function parseMxcStatus(text: string): IMxcStatus {
	let ready: IMxcStatus['ready'];
	let started: number | undefined;
	let limit: IMxcStatus['limit'];
	let exit: number | undefined;
	let nogo = false;
	let error: string | undefined;
	for (const line of text.split(/\r?\n/)) {
		const fields = Object.fromEntries(line.split(' ').slice(1).map(pair => pair.split('=') as [string, string]));
		const word = line.split(' ')[0];
		if (word === 'ready' && !ready) {
			const ui = /^0x[0-9a-f]+$/i.test(fields.ui ?? '') ? Number.parseInt(fields.ui, 16) : undefined;
			ready = {
				pid: Number(fields.pid), nonce: fields.nonce ?? '', inJob: fields.injob === '1', ui,
				sentinel: Number(fields.sentinel), publicConnect: Number(fields.public), loopbackConnect: Number(fields.loopback),
			};
		} else if (word === 'started') {
			started = Number(fields.pid);
		} else if (word === 'limit') {
			const [, resource, value] = line.split(' ');
			if (resource === 'cpu' || resource === 'memory' || resource === 'processes') {
				limit = { resource, value: Number(value) };
			}
		} else if (word === 'exit') {
			exit = Number(line.split(' ')[1]);
		} else if (word === 'nogo') {
			nogo = true;
		} else if (word === 'error') {
			error = line.slice(6);
		}
	}
	return { ready, started, limit, exit, nogo, error };
}

/** One JSON line from `volt-mxc-helper attest <pid>`. */
export interface IMxcAttestation {
	readonly pid: number;
	readonly ok: boolean;
	readonly running: boolean;
	readonly appContainer: boolean;
	readonly inJob: boolean;
	readonly sessionId: number;
	readonly parentPid: number;
	readonly created: number;
	readonly appContainerSid: string;
	readonly integrity: string;
	readonly image: string;
	readonly error?: string;
}

const LOW_INTEGRITY = 'S-1-16-4096';
const UNTRUSTED_INTEGRITY = 'S-1-16-0';
/** WSAEACCES: the container's WFP filters refuse a connect at once. */
export const WSAEACCES = 10013;
export const WSAETIMEDOUT = 10060;
const ERROR_ACCESS_DENIED = 5;

export interface IMxcEvidenceCheck {
	readonly ok: boolean;
	readonly error?: string;
	readonly evidence: Readonly<Record<string, string | number | boolean>>;
}

/**
 * The parent's decision on one run: the prologue's process, seen from outside, is an AppContainer
 * process at Low integrity in a job, running Volt's verified prologue image, started by this run's
 * wxc-exec; and the canary failed the way the policy says it must.
 */
export function checkMxcEvidence(status: IMxcStatus, attestation: IMxcAttestation | undefined, expected: { readonly nonce: string; readonly helperPath: string; readonly launcherPid?: number; readonly network: IResolvedSandboxPolicy['network']['mode']; readonly canaryPort?: number }): IMxcEvidenceCheck {
	const fail = (error: string): IMxcEvidenceCheck => ({ ok: false, error, evidence: {} });
	const ready = status.ready;
	if (!ready || ready.nonce !== expected.nonce || !(ready.pid > 0)) {
		return fail('the sandbox prologue did not report ready');
	}
	if (!attestation || !attestation.ok || attestation.pid !== ready.pid) {
		return fail(`the sandboxed process could not be inspected${attestation?.error ? `: ${attestation.error}` : ''}`);
	}
	if (!attestation.running) {
		return fail('the sandboxed process exited before it was attested');
	}
	if (!attestation.appContainer || !/^S-1-15-2-\d+(-\d+){6}$/.test(attestation.appContainerSid)) {
		return fail('the process is not in an AppContainer: the sandbox was not applied');
	}
	if (attestation.integrity !== LOW_INTEGRITY && attestation.integrity !== UNTRUSTED_INTEGRITY) {
		return fail(`the sandboxed process runs at integrity ${attestation.integrity || 'unknown'}, not Low`);
	}
	if (!attestation.inJob) {
		return fail('the sandboxed process is not in a job object, so its process tree cannot be contained');
	}
	if (windowsPathKey(attestation.image) !== windowsPathKey(expected.helperPath)) {
		return fail(`an unexpected program reported ready (${attestation.image})`);
	}
	if (expected.launcherPid !== undefined && attestation.parentPid !== expected.launcherPid) {
		return fail('the sandboxed process was not started by this run\'s launcher');
	}
	if (ready.sentinel !== ERROR_ACCESS_DENIED && ready.sentinel !== 2 && ready.sentinel !== 3) {
		return fail(`canary: a file outside the policy was ${ready.sentinel === 0 ? 'readable' : `refused with error ${ready.sentinel}`}`);
	}
	if (expected.network !== 'host') {
		if (ready.publicConnect !== WSAEACCES) {
			return fail(`canary: a direct connection was ${ready.publicConnect === 0 ? 'allowed' : ready.publicConnect === WSAETIMEDOUT ? 'not refused at once' : `refused with ${ready.publicConnect}`}, expected WSAEACCES`);
		}
		if (expected.canaryPort && ready.loopbackConnect === 0) {
			return fail('canary: a host loopback port outside the policy was reachable');
		}
	}
	return {
		ok: true,
		evidence: {
			appContainer: true,
			appContainerSid: attestation.appContainerSid,
			integrity: attestation.integrity,
			inJob: true,
			pid: attestation.pid,
			parentPid: attestation.parentPid,
			sessionId: attestation.sessionId,
			canarySentinel: ready.sentinel,
			canaryPublic: ready.publicConnect,
			canaryLoopback: ready.loopbackConnect,
			...(ready.ui !== undefined ? { uiRestrictions: ready.ui } : {}),
		},
	};
}

export function parseMxcAttestation(text: string): IMxcAttestation | undefined {
	try {
		const value = JSON.parse(text.trim().split(/\r?\n/).pop() ?? '');
		return value && typeof value === 'object' && typeof value.pid === 'number' ? value as IMxcAttestation : undefined;
	} catch {
		return undefined;
	}
}

/** `wxc-exec --probe` output: the tier must be BaseContainer (no AppContainer fallback) with deny paths. */
export interface IMxcProbe {
	readonly tier?: string;
	readonly warnings?: readonly string[];
	readonly probes?: Readonly<Record<string, unknown>>;
}

export function checkMxcProbe(probe: IMxcProbe | undefined): { readonly ok: true; readonly enumerate: boolean } | { readonly ok: false; readonly reason: string } {
	if (!probe) {
		return { ok: false, reason: 'wxc-exec --probe did not answer.' };
	}
	if (probe.tier !== 'base-container' || probe.probes?.baseContainerApiPresent !== true) {
		return { ok: false, reason: `MXC would use ${probe.tier ?? 'no'} isolation, not ProcessContainer (BaseContainer). This Windows build cannot sandbox Volt's agents.` };
	}
	if (probe.probes?.baseContainerSupportsDenyPaths !== true) {
		return { ok: false, reason: 'This Windows build cannot deny paths inside the sandbox (PSE_SUPPORT_FS_DENY), so credentials could not be protected.' };
	}
	return { ok: true, enumerate: probe.probes?.baseContainerSupportsEnumeratePaths === true };
}
