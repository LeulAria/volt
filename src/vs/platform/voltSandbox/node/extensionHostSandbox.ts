/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import type { Socket } from 'net';
import { dirname, join } from '../../../base/common/path.js';
import { extensionSandboxPlan, IT3ExtensionFacts, T3_HOST_QUOTAS, t3ExtensionHostPolicy, t3ManifestView, t3Subject } from '../common/extensionHostSandbox.js';
import { IPrincipal } from '../common/principals.js';
import { PrincipalRegistry } from './principalRegistry.js';
import { HostStartResult, ISandboxedHost, SandboxSupervisor } from './supervisor.js';

/**
 * Starts T3 extension hosts (spec H.1): `bootstrap-fork` as Node (`ELECTRON_RUN_AS_NODE=1
 * --disable-sigusr1`), `VSCODE_ESM_ENTRYPOINT=vs/workbench/api/node/extensionHostProcess`, its
 * environment from the fixed list (F.7) with the launcher's names last, through the supervisor:
 * attested before it runs, one extension per process (H.6), restarted per F.11, killed with Volt.
 *
 * The host's connection is handed to it on its channel, as VS Code's server does (`VSCODE_EXTHOST_IPC_SOCKET`):
 * a socket with no path, so no other sandbox can reach it.
 */

export interface ISandboxedExtensionHostRequest {
	readonly extension: IT3ExtensionFacts & {
		/** Its folder, as the extension scanner found it on this host (never a payload's path). */
		readonly location: string;
	};
	readonly workspaceRoots: readonly string[];
	readonly workspaceTrusted: boolean;
	/** Its own persistent folder (`${storage}`): `globalStorage/<id>`. */
	readonly storageDir: string;
	/** More folders it writes: its workspace storage, its log folder. */
	readonly extraWritable?: readonly string[];
	/** `bootstrap-fork.js`, Volt's code. */
	readonly bootstrapFork: string;
	/** Volt's code the host reads (`out/`, `node_modules`). Default: the folder above `bootstrap-fork.js`. */
	readonly appRoots?: readonly string[];
	/** `--type=extensionHost` and the server's flags (`--transformURIs`, `--useHostProxy=…`). */
	readonly args: readonly string[];
	/** `VSCODE_NLS_CONFIG`. */
	readonly nlsConfig?: string;
	/** The user's environment the fixed list copies from. */
	readonly hostEnv: Readonly<Record<string, string | undefined>>;
	readonly home: string;
	readonly platform?: string;
	readonly label?: string;
}

export type SandboxedExtensionHostResult =
	| {
		readonly ok: true; readonly host: ISandboxedHost; readonly principal: IPrincipal;
		/** Resolves true when the host said it is ready for its connection, false when it stopped first. */
		readonly ready: Promise<boolean>;
	}
	| { readonly ok: false; readonly reason: string; readonly code: string };

/** The extension host's channel messages (`extensionHostProtocol.ts`), named here so this layer has no workbench import. */
const READY = 'VSCODE_EXTHOST_IPC_READY';

export class SandboxedExtensionHosts {

	constructor(
		private readonly supervisor: SandboxSupervisor,
		private readonly registry: PrincipalRegistry,
	) { }

	/** One extension, alone, in its own sandboxed host. A refusal is typed; nothing runs unsandboxed. */
	async start(request: ISandboxedExtensionHostRequest): Promise<SandboxedExtensionHostResult> {
		const platform = request.platform ?? process.platform;
		const plan = extensionSandboxPlan(request.extension, platform);
		if (plan.kind !== 'sandbox') {
			return { ok: false, code: plan.kind === 'refuse' ? plan.code : 'not-needed', reason: plan.reason };
		}
		const real = async (path: string) => fs.realpath(path).catch(() => path);
		const extensionDir = await real(request.extension.location);
		await fs.mkdir(request.storageDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
		const appRoots = await Promise.all((request.appRoots ?? defaultAppRoots(request.bootstrapFork)).map(real));
		const extraWritable: string[] = [];
		for (const dir of request.extraWritable ?? []) {
			await fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
			extraWritable.push(await real(dir));
		}
		const policy = t3ExtensionHostPolicy({ platform, home: request.home, extensionDir, appRoots, workspaceTrusted: request.workspaceTrusted, extraWritable });
		const principal = this.registry.mint({ subject: t3Subject(request.extension.id), kind: 't3', launchPolicyHash: '' });
		const result: HostStartResult = await this.supervisor.start({
			principal,
			label: request.label ?? `extension ${request.extension.id}`,
			command: {
				fork: request.bootstrapFork,
				args: request.args,
				reservedEnv: {
					VSCODE_ESM_ENTRYPOINT: 'vs/workbench/api/node/extensionHostProcess',
					VSCODE_HANDLES_UNCAUGHT_ERRORS: 'true',
					VSCODE_EXTHOST_WILL_SEND_SOCKET: '1',
					...(request.nlsConfig ? { VSCODE_NLS_CONFIG: request.nlsConfig } : {}),
				},
			},
			policy,
			context: {
				workspaceRoots: request.workspaceTrusted ? request.workspaceRoots : [],
				cwd: extensionDir,
				storageDir: request.storageDir,
				hostEnv: request.hostEnv,
			},
			ipc: true,
			// The window holds the host's connection and restarts a crashed host itself (with a new
			// connection), as it does for VS Code's remote host: a restart here would have no socket.
			restart: { maxPerMinute: 0 },
			limits: { memoryMB: T3_HOST_QUOTAS.memoryMB },
			manifest: t3ManifestView(request.extension.id, request.extension.declaredHosts),
		});
		if (!result.ok) {
			if (this.registry.isLive(principal.id)) {
				this.registry.retire(principal.id);
			}
			return { ok: false, code: 'launch', reason: result.reason };
		}
		return { ok: true, host: result.host, principal: result.host.principal, ready: whenReady(result.host) };
	}
}

/** Resolves true on the host's READY, false when it stops first. Listens from the moment the host runs. */
function whenReady(host: ISandboxedHost): Promise<boolean> {
	return new Promise(resolve => {
		const listeners = [
			host.onMessage(message => {
				if (message && typeof message === 'object' && (message as { type?: unknown }).type === READY) {
					dispose();
					resolve(true);
				}
			}),
			host.onExit(() => {
				dispose();
				resolve(false);
			}),
		];
		const dispose = () => listeners.forEach(listener => listener.dispose());
	});
}

/**
 * Hands `socket` to the host once it is ready: the host then speaks VS Code's extension host
 * protocol on it. Resolves false when the host stops first.
 */
export async function handOffWhenReady(started: { readonly host: ISandboxedHost; readonly ready: Promise<boolean> }, socketMessage: () => { readonly message: unknown; readonly socket: Socket } | undefined): Promise<boolean> {
	if (!await started.ready) {
		return false;
	}
	const next = socketMessage();
	return !!next && started.host.send(next.message, next.socket);
}

/**
 * Volt's code a host loads: `out/`, the `node_modules` beside it (followed through a link, as a
 * dev checkout has) and the product files `out/` reads. Not the rest of the app folder.
 */
function defaultAppRoots(bootstrapFork: string): string[] {
	const out = dirname(bootstrapFork);
	const app = dirname(out);
	return [out, join(app, 'node_modules'), join(app, 'product.json'), join(app, 'package.json')];
}
