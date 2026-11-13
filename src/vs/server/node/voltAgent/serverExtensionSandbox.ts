/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { IT3ExtensionFacts, IVoltSandboxedHostStartParams, t3LogsHome, t3WorkspaceStorageHome } from '../../../platform/voltSandbox/common/extensionHostSandbox.js';
import { SandboxedExtensionHosts } from '../../../platform/voltSandbox/node/extensionHostSandbox.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { ISandboxedExtensionHostStart, IVoltExtensionHostSandbox, IVoltExtensionHostSandboxStartOptions } from '../extensionHostConnection.js';

/**
 * The agent server's side of P2/P6: a window (a browser workbench, or the desktop routing its
 * opted-in extensions here) asks for one extension in its own sandboxed extension host. The server
 * finds the extension in its own extension folders, from its manifest (never a path from the
 * request), and starts the host under the supervisor its other sandboxed hosts run under, so the
 * Security page lists it and quitting kills it.
 */
export class ServerExtensionSandbox implements IVoltExtensionHostSandbox {

	constructor(
		private readonly hosts: () => SandboxedExtensionHosts,
		private readonly options: {
			/** `bootstrap-fork.js`. */
			readonly bootstrapFork: string;
			readonly home: string;
			/**
			 * P6: the desktop app's own extension folders on this computer, as its main process named
			 * them when it asked for a ticket (with the server's token). An extension installed the
			 * normal way (Extensions view, a .vsix) is there, not in the server's folder.
			 */
			readonly localExtensionDirs?: () => readonly string[];
		},
		private readonly logService: ILogService,
	) { }

	async start(params: IVoltSandboxedHostStartParams, options: IVoltExtensionHostSandboxStartOptions): Promise<{ readonly ok: true; readonly started: ISandboxedExtensionHostStart } | { readonly ok: false; readonly code: string; readonly reason: string }> {
		const roots = [
			{ dir: options.dirs.extensions, builtin: false },
			...(this.options.localExtensionDirs?.() ?? []).map(dir => ({ dir, builtin: false })),
			{ dir: options.dirs.builtinExtensions, builtin: true },
		];
		const found = await findInstalledExtension(roots, params.extensionId, typeof params.version === 'string' ? params.version : undefined);
		if (!found) {
			return { ok: false, code: 'unknown', reason: `${params.extensionId} is not installed where Volt's server runs extensions.` };
		}
		const id = params.extensionId.toLowerCase();
		const workspaceRoots = (params.workspaceRoots ?? []).filter(root => typeof root === 'string' && root.startsWith('/'));
		const result = await this.hosts().start({
			extension: { ...found.facts, location: found.location },
			workspaceRoots,
			workspaceTrusted: params.workspaceTrusted === true,
			storageDir: join(options.dirs.globalStorage, id),
			extraWritable: [t3WorkspaceStorageHome(options.dirs.workspaceStorage, id), t3LogsHome(options.dirs.logs, id)],
			bootstrapFork: this.options.bootstrapFork,
			args: options.args,
			...(options.nlsConfig ? { nlsConfig: options.nlsConfig } : {}),
			hostEnv: options.hostEnv,
			home: this.options.home,
		});
		if (!result.ok) {
			this.logService.warn(`[volt-sandbox] extension ${params.extensionId}: no sandboxed host (${result.code}): ${result.reason}`);
			return result;
		}
		this.logService.info(`[volt-sandbox] extension ${params.extensionId} runs alone in a sandboxed host (${result.host.backend}, principal ${result.principal.id.slice(0, 8)})`);
		return { ok: true, started: { host: result.host, ready: result.ready } };
	}
}

interface IExtensionManifestLike {
	readonly name?: unknown;
	readonly publisher?: unknown;
	readonly version?: unknown;
	readonly main?: unknown;
	readonly browser?: unknown;
	readonly extensionKind?: unknown;
	readonly contributes?: { readonly voltCapabilities?: { readonly required?: unknown; readonly optional?: unknown } };
}

/**
 * The installed copy of `extensionId` in `roots` (the version the window runs when it is installed,
 * else the newest), with the facts the sandbox decides on. Built-in folders count as built-in.
 * Folders the extension manager marked for removal (`.obsolete`) are skipped.
 */
export async function findInstalledExtension(roots: readonly { readonly dir: string; readonly builtin: boolean }[], extensionId: string, preferredVersion?: string): Promise<{ readonly location: string; readonly facts: IT3ExtensionFacts } | undefined> {
	const wanted = extensionId.toLowerCase();
	let best: { location: string; facts: IT3ExtensionFacts; version: string } | undefined;
	for (const root of roots) {
		const obsolete = await readObsolete(root.dir);
		for (const name of await fs.readdir(root.dir).catch(() => [] as string[])) {
			if (name.startsWith('.') || obsolete.has(name)) {
				continue;
			}
			const location = join(root.dir, name);
			const manifest = await readManifest(join(location, 'package.json'));
			if (!manifest || typeof manifest.publisher !== 'string' || typeof manifest.name !== 'string' || `${manifest.publisher}.${manifest.name}`.toLowerCase() !== wanted) {
				continue;
			}
			const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
			if (preferredVersion !== undefined && version === preferredVersion) {
				return { location, facts: extensionFacts(`${manifest.publisher}.${manifest.name}`, manifest, root.builtin) };
			}
			if (!best || compareVersions(version, best.version) > 0) {
				best = { location, version, facts: extensionFacts(`${manifest.publisher}.${manifest.name}`, manifest, root.builtin) };
			}
		}
	}
	return best && { location: best.location, facts: best.facts };
}

/** The extension manager's `.obsolete` file: folder names waiting to be removed. */
async function readObsolete(dir: string): Promise<ReadonlySet<string>> {
	try {
		const value = JSON.parse(await fs.readFile(join(dir, '.obsolete'), 'utf8'));
		return new Set(value && typeof value === 'object' ? Object.keys(value).filter(key => value[key] === true) : []);
	} catch {
		return new Set();
	}
}

export function extensionFacts(id: string, manifest: IExtensionManifestLike, builtin: boolean): IT3ExtensionFacts {
	const kind = Array.isArray(manifest.extensionKind) ? manifest.extensionKind.filter((k): k is string => typeof k === 'string') : typeof manifest.extensionKind === 'string' ? [manifest.extensionKind] : ['workspace'];
	const capabilities = [manifest.contributes?.voltCapabilities?.required, manifest.contributes?.voltCapabilities?.optional].flatMap(list => Array.isArray(list) ? list : []);
	const declaredHosts = capabilities.flatMap(entry => {
		const capability = entry as { id?: unknown; targets?: unknown };
		return typeof capability.id === 'string' && capability.id.split('@')[0] === 'net.connect' && Array.isArray(capability.targets) ? capability.targets.filter((t): t is string => typeof t === 'string') : [];
	});
	return {
		id,
		builtin,
		main: typeof manifest.main === 'string' && manifest.main.length > 0,
		browser: typeof manifest.browser === 'string' && manifest.browser.length > 0,
		extensionKind: kind,
		declaredHosts,
	};
}

async function readManifest(file: string): Promise<IExtensionManifestLike | undefined> {
	try {
		const value = JSON.parse(await fs.readFile(file, 'utf8'));
		return value && typeof value === 'object' ? value as IExtensionManifestLike : undefined;
	} catch {
		return undefined;
	}
}

function compareVersions(a: string, b: string): number {
	const pa = a.split(/[.-]/).map(part => Number(part) || 0);
	const pb = b.split(/[.-]/).map(part => Number(part) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) {
			return d;
		}
	}
	return 0;
}
