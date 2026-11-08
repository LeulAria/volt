/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IManifestView } from './authority.js';
import { extensionSubject, SubjectKey } from './principals.js';
import { AGENT_ENV_INHERIT, credentialDenyEntries, HOME_TOOLCHAIN_PATHS } from './sandboxProfiles.js';
import { IVoltSandboxPolicy, SANDBOX_POLICY_SCHEMA_VERSION, SandboxDimension } from './sandboxSchema.js';

/**
 * The T3 extension host (spec H.1, H.7, H.8): one VS Code extension in its own extension host
 * process, started by the supervisor inside the OS sandbox. Opt-in per extension (N.1 #22): an
 * extension the user did not opt in runs exactly as before, in the shared host. Pure: the policy,
 * the quotas and the decision whether an extension can be sandboxed at all, so each is tested
 * without a process.
 */

/** The opt-in list (`publisher.name`). Per profile, user (or remote user) settings only: a repository can't change it. */
export const VOLT_SANDBOXED_EXTENSIONS_SETTING = 'volt.extensions.sandboxed';

/**
 * Extensions the user chose to run without the sandbox after Volt said it can't sandbox them
 * (P8 kill switch, F.13). Until then an opted-in extension that can't be sandboxed stays off, never
 * silently unsandboxed.
 */
export const VOLT_UNSANDBOXED_EXTENSIONS_SETTING = 'volt.extensions.runWithoutSandbox';

/** H.8 for T3: 1 GB, 64 processes, 500 MB of storage, 200 MB a day through the broker, idle by activation. */
export const T3_HOST_QUOTAS = { memoryMB: 1024, processes: 64, storageMB: 500, networkMBPerDay: 200 } as const;

/** What core knows about an extension, from its scanned manifest (never from an RPC payload). */
export interface IT3ExtensionFacts {
	/** `publisher.name`. */
	readonly id: string;
	/** Ships with Volt (its built-in `volt.*` extensions and VS Code's): unaffected by the opt-in. */
	readonly builtin: boolean;
	/** Has a Node entry point (`main`). */
	readonly main: boolean;
	/** Has a browser entry point (`browser`). */
	readonly browser: boolean;
	/** `extensionKind`, as the manifest says or VS Code derives it. */
	readonly extensionKind: readonly string[];
	/** Hosts it names in `contributes.voltCapabilities` `net.connect`: reachable without asking (low, G.4). */
	readonly declaredHosts?: readonly string[];
}

/** Why an opted-in extension does not run in a sandbox, as a code the UI keys its action on. */
export type ExtensionSandboxRefusalCode =
	/** `extensionKind: ui` with no browser entry: it would need "Run with full access" (critical, H.7). */
	| 'ui-full-access'
	/** Code only for the browser: the per-extension sandboxed renderer (T3-web, D-13) is not built. */
	| 'browser-only'
	/** This OS has no sandbox Volt can run an extension host in (F.13). */
	| 'platform'
	/** The desktop routes sandboxed extensions to the local agent server (P6), which is off. */
	| 'server-off'
	/** The sandboxed host was refused at launch (probe, attestation, budget). */
	| 'launch';

export type ExtensionSandboxPlan =
	| { readonly kind: 'sandbox' }
	/** Nothing to confine: no code (themes, grammars, snippets), or a built-in. It runs as before. */
	| { readonly kind: 'not-needed'; readonly reason: string }
	| { readonly kind: 'refuse'; readonly code: ExtensionSandboxRefusalCode; readonly reason: string };

/**
 * Whether an opted-in extension can run in its own sandboxed host here. Decided from static facts
 * before any launch (F.13): a refusal is shown with its reason and the extension stays off.
 */
export function extensionSandboxPlan(facts: IT3ExtensionFacts, platform: string): ExtensionSandboxPlan {
	if (facts.builtin) {
		return { kind: 'not-needed', reason: 'Built-in extensions run as part of Volt.' };
	}
	if (!facts.main && !facts.browser) {
		return { kind: 'not-needed', reason: 'It has no code to run (only themes, languages or settings).' };
	}
	if (!facts.main) {
		return { kind: 'refuse', code: 'browser-only', reason: 'It runs only in the browser part of Volt, which can\'t sandbox one extension yet.' };
	}
	if (facts.extensionKind[0] === 'ui' && !facts.browser) {
		return { kind: 'refuse', code: 'ui-full-access', reason: 'It must run beside Volt\'s window (extensionKind "ui"), which needs full access.' };
	}
	if (platform !== 'darwin' && platform !== 'linux') {
		return { kind: 'refuse', code: 'platform', reason: 'Volt can sandbox an extension host on macOS and Linux only.' };
	}
	return { kind: 'sandbox' };
}

/** The subject a T3 host runs as: grants (Allow host) attach to it, across restarts. */
export function t3Subject(extensionId: string): SubjectKey {
	return extensionSubject(extensionId, false);
}

/**
 * The manifest view the network broker judges a T3 host by (H.7): network none, except the hosts
 * the extension names in `contributes.voltCapabilities` (low) and the user's "Allow host" grants.
 */
export function t3ManifestView(extensionId: string, declaredHosts: readonly string[] = []): IManifestView {
	const hosts = declaredHosts.filter(host => typeof host === 'string' && host.trim() && host.trim() !== '*');
	return { subject: t3Subject(extensionId), network: 'broker', declared: hosts.length ? [{ id: 'net.connect', targets: hosts }] : [] };
}

export interface IT3PolicyInput {
	readonly platform: string;
	/** The user's home (real path). */
	readonly home: string;
	/** The extension's own folder (real path). */
	readonly extensionDir: string;
	/** Volt's code the host runs from (`out/`, its `node_modules`): read-only. */
	readonly appRoots: readonly string[];
	/** Readable only when the workspace is trusted (H.7). */
	readonly workspaceTrusted: boolean;
	/** Folders it may write besides `${storage}` and `${tmp}`: its workspace storage, its log folder. */
	readonly extraWritable?: readonly string[];
}

/**
 * H.7's T3 default policy:
 * - read: its own folder and storage, the workspace if trusted, `${system}`, `${path}`, the
 *   toolchain list, Volt's own code;
 * - write: its storage and temp only (no raw workspace writes: edits go through `WorkspaceEdit`,
 *   which the main thread applies);
 * - network: through the broker, where nothing is allowed until the user allows a host;
 * - exec: allowed inside, children inherit the sandbox (language servers, linters);
 * - H.8 quotas: memory (polled on macOS) and processes.
 */
export function t3ExtensionHostPolicy(input: IT3PolicyInput): IVoltSandboxPolicy {
	const at = (relative: string) => `${input.home}/${relative}`;
	const bestEffort: SandboxDimension[] = ['limits.processes', 'limits.memory', 'process.tree', 'filesystem.protectNew'];
	return {
		schemaVersion: SANDBOX_POLICY_SCHEMA_VERSION,
		name: 'extension-host',
		filesystem: {
			read: unique(['${system}', '${path}', input.extensionDir, ...input.appRoots, ...HOME_TOOLCHAIN_PATHS.map(at), ...(input.workspaceTrusted ? ['${workspace}'] : [])]),
			write: unique(['${storage}', '${tmp}', ...(input.extraWritable ?? [])]),
			deny: credentialDenyEntries(),
			protect: [],
			unmask: [],
		},
		network: { mode: 'proxy', allow: [], loopbackPorts: [], listen: false },
		process: { limits: { memoryMB: T3_HOST_QUOTAS.memoryMB, processes: T3_HOST_QUOTAS.processes, fileSizeMB: T3_HOST_QUOTAS.storageMB, openFiles: 4096 } },
		// The fixed list (F.7): locale, shell and toolchain locations; anything secret-like is dropped even when listed.
		env: { inherit: AGENT_ENV_INHERIT, set: { TMPDIR: '${tmp}' } },
		host: { unixSockets: [], systemServices: false },
		bestEffort,
	};
}

function unique(entries: readonly string[]): string[] {
	return [...new Set(entries)];
}

/** Whether `id` is in an opt-in list, case-insensitively (extension ids are). */
export function extensionListed(list: unknown, id: string): boolean {
	const lower = id.toLowerCase();
	return Array.isArray(list) && list.some(entry => typeof entry === 'string' && entry.toLowerCase() === lower);
}
