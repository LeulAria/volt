/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { extUriBiasedIgnorePathCase, normalizePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { VOLT_EXTENSION_SANDBOX_KILL_SWITCH_SETTING, VOLT_EXTENSION_SANDBOX_MODE_SETTING, VOLT_SANDBOXED_EXTENSIONS_SETTING, VOLT_UNSANDBOXED_EXTENSIONS_SETTING } from '../../../../platform/voltSandbox/common/extensionHostSandbox.js';
import { webviewResourceBaseHost } from './webview.js';

/**
 * Who owns an extension's webview and what it may reach (spec B-23, I.10, INV-19, INV-20). Core
 * decides it from the extension it knows, never from the webview's options: the resource roots are
 * clamped to the extension's readable set and core writes a CSP floor under the extension's own CSP.
 * Pure, so every decision is tested without a workbench.
 */

/**
 * Extensions the user opted into Volt's sandbox, by id (N.1 #22: opt-in per extension). Each runs
 * alone in its own sandboxed extension host (P2, `extensionHostSandbox.ts`), and their webviews get
 * the strict floor (no network beyond declared `net.connect` hosts, no workspace reads through the
 * webview unless the workspace is trusted, links outside Volt ask first).
 */
export { VOLT_SANDBOXED_EXTENSIONS_SETTING, VOLT_UNSANDBOXED_EXTENSIONS_SETTING };

const EXTENSION_ID_ITEMS = { type: 'string', pattern: '^[a-zA-Z0-9-]+\\.[a-zA-Z0-9-]+$', patternErrorMessage: localize('voltExtensions.sandboxed.pattern', "Use the extension's id, publisher.name.") } as const;

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.extensions',
	title: localize('voltExtensions.configTitle', "Extensions"),
	type: 'object',
	properties: {
		[VOLT_SANDBOXED_EXTENSIONS_SETTING]: {
			type: 'array',
			items: EXTENSION_ID_ITEMS,
			default: [],
			uniqueItems: true,
			// Per profile, in user (or remote user) settings only: a repository can't change which extensions are confined.
			scope: ConfigurationScope.MACHINE,
			description: localize('voltExtensions.sandboxed', "Extensions Volt runs in a sandbox, by id (publisher.name). Each runs alone in its own extension host, which reads only its own folder and storage, your toolchains and a trusted workspace, writes only its storage, and reaches no network except hosts you allow. Their webviews reach no network except the hosts the extension declares with net.connect, read the workspace only when it is trusted, and links they open outside Volt ask first. Extensions not listed run as before."),
		},
		[VOLT_UNSANDBOXED_EXTENSIONS_SETTING]: {
			type: 'array',
			items: EXTENSION_ID_ITEMS,
			default: [],
			uniqueItems: true,
			scope: ConfigurationScope.MACHINE,
			description: localize('voltExtensions.runWithoutSandbox', "Extensions in volt.extensions.sandboxed that Volt could not sandbox here and that you chose to run without the sandbox anyway. Until you choose that, such an extension stays off."),
		},
		[VOLT_EXTENSION_SANDBOX_MODE_SETTING]: {
			type: 'string',
			enum: ['optIn', 'required'],
			enumDescriptions: [
				localize('voltExtensions.sandboxMode.optIn', "Only the extensions in volt.extensions.sandboxed run in a sandbox. Others run as before."),
				localize('voltExtensions.sandboxMode.required', "Every third-party extension with code runs in a sandbox, on macOS and Linux. Built-in extensions run as before. On Windows this reads as optIn."),
			],
			default: 'optIn',
			scope: ConfigurationScope.MACHINE,
			description: localize('voltExtensions.sandboxMode', "Which third-party extensions Volt runs in a sandbox. Applies after a window reload."),
		},
		[VOLT_EXTENSION_SANDBOX_KILL_SWITCH_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.MACHINE,
			description: localize('voltExtensions.sandboxKillSwitch', "Switch the extension sandbox off. Extensions that would run in a sandbox stay off instead and each asks whether to run without the sandbox; none runs unsandboxed until you say so. Applies after a window reload."),
		},
	},
});

export function isSandboxedExtension(sandboxed: unknown, extensionId: string): boolean {
	const lower = extensionId.toLowerCase();
	return Array.isArray(sandboxed) && sandboxed.some(entry => typeof entry === 'string' && entry.toLowerCase() === lower);
}

/** Schemes whose resources are files on a disk (local, remote or Volt's user data). */
const DISK_SCHEMES: ReadonlySet<string> = new Set([Schemas.file, Schemas.vscodeRemote, Schemas.vscodeUserData]);

export interface IWebviewRootClamp {
	/** The roots the webview keeps (normalized). */
	readonly kept: URI[];
	/** The roots core dropped, as requested. */
	readonly dropped: URI[];
}

/**
 * Keeps the requested roots that lie inside the owner's readable set (B-23, INV-20). A root is kept
 * when it equals or lies under a readable folder (same scheme and authority, after `..` is
 * resolved); `/`, the home folder, `~/.ssh` or another extension's folder are dropped.
 *
 * `allowVirtualSchemes`: roots served by a non-disk file system (an extension's own `memfs:`, a
 * virtual workspace) are kept; for a sandboxed owner they are dropped like any other.
 */
export function clampLocalResourceRoots(requested: readonly URI[] | undefined, readable: readonly URI[], allowVirtualSchemes: boolean): IWebviewRootClamp {
	const kept: URI[] = [];
	const dropped: URI[] = [];
	const readableNormalized = readable.map(root => normalizePath(root));
	for (const root of requested ?? []) {
		const normalized = normalizePath(root);
		const inside = readableNormalized.some(member => extUriBiasedIgnorePathCase.isEqualOrParent(normalized, member));
		if (inside || (allowVirtualSchemes && !DISK_SCHEMES.has(normalized.scheme))) {
			if (!kept.some(other => extUriBiasedIgnorePathCase.isEqual(other, normalized))) {
				kept.push(normalized);
			}
		} else {
			dropped.push(root);
		}
	}
	return { kept, dropped };
}

/**
 * A folder of a file the user opened counts as readable for an unsandboxed extension's preview of
 * it, except a folder so broad it would expose everything: a file system root or the home folder.
 */
export function isDocumentFolderReadable(folder: URI, home: URI | undefined): boolean {
	const segments = folder.path.split('/').filter(Boolean);
	if (segments.length === 0 || (segments.length === 1 && /^[a-zA-Z]:$/.test(segments[0]))) {
		return false;
	}
	return !(home && extUriBiasedIgnorePathCase.isEqual(normalizePath(folder), normalizePath(home)));
}

/** Where a webview's local resources appear to the page: the service worker answers these, never the network. */
export const WEBVIEW_RESOURCE_SOURCE = `https://*.${webviewResourceBaseHost}`;

/**
 * The CSP sources for granted `net.connect` targets (`api.example.com`, `*.example.com`,
 * `example.com:8443`). `*` grants any host. An invalid pattern grants nothing.
 */
export function cspSourcesForHosts(hosts: readonly string[]): string[] {
	if (hosts.includes('*')) {
		return ['https:', 'http:', 'wss:', 'ws:'];
	}
	const sources: string[] = [];
	for (const host of hosts) {
		if (/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i.test(host)) {
			sources.push(`https://${host}`, `http://${host}`, `wss://${host}`, `ws://${host}`);
		}
	}
	return sources;
}

/**
 * What core enforces on an extension's webview besides its roots. `strict` is set for an extension
 * in {@link VOLT_SANDBOXED_EXTENSIONS_SETTING}: its webview may reach only `egressHosts`.
 */
export interface IWebviewOwnerPolicy {
	/** The CSP core puts in front of the extension's own (both apply; a request must pass both). */
	readonly csp: string;
	/** Set for a sandboxed owner: the only network hosts its pages may reach (`*` any). */
	readonly egressHosts?: readonly string[];
}

/**
 * The floor every extension webview gets. Only these directives, so scripts and styles stay the
 * extension's business; each allows the webview's own origin, its resources, `data:` and `blob:`,
 * and the web (`https:`, `http:`, and `wss:`, `ws:` for `connect-src`). It blocks `file:`,
 * `vscode-file:`, `vscode-remote-resource:`, `filesystem:`, `ftp:` and every other scheme in
 * fetches, images, media, fonts and frames, and forms posting anywhere but the web or the
 * webview itself (custom schemes, `javascript:`).
 */
const OPEN_FLOOR = [
	`connect-src 'self' ${WEBVIEW_RESOURCE_SOURCE} https: http: wss: ws: data: blob:`,
	`img-src 'self' ${WEBVIEW_RESOURCE_SOURCE} https: http: data: blob:`,
	`media-src 'self' ${WEBVIEW_RESOURCE_SOURCE} https: http: data: blob: mediastream:`,
	`font-src 'self' ${WEBVIEW_RESOURCE_SOURCE} https: http: data: blob:`,
	`frame-src 'self' ${WEBVIEW_RESOURCE_SOURCE} https: http: data: blob:`,
	`form-action 'self' https: http:`,
].join('; ');

/**
 * The policy of an extension's webview. Unsandboxed: {@link OPEN_FLOOR}. Sandboxed: nothing leaves
 * except to `grantedHosts` (`default-src` covers scripts, styles, workers, frames, fetches and
 * every other load; inline code and eval stay allowed so pages work, the extension's own CSP can
 * still forbid them), forms post only to granted hosts.
 */
export function webviewOwnerPolicy(sandboxed: boolean, grantedHosts: readonly string[]): IWebviewOwnerPolicy {
	if (!sandboxed) {
		return { csp: OPEN_FLOOR };
	}
	const granted = cspSourcesForHosts(grantedHosts);
	const extra = granted.length ? ` ${granted.join(' ')}` : '';
	return {
		csp: [
			`default-src 'self' ${WEBVIEW_RESOURCE_SOURCE} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:${extra}`,
			`form-action ${granted.length ? granted.join(' ') : `'none'`}`,
		].join('; '),
		egressHosts: [...grantedHosts],
	};
}

export function areWebviewOwnerPoliciesEqual(a: IWebviewOwnerPolicy | undefined, b: IWebviewOwnerPolicy | undefined): boolean {
	if (!a || !b) {
		return a === b;
	}
	const hostsA = a.egressHosts?.join('\n');
	const hostsB = b.egressHosts?.join('\n');
	return a.csp === b.csp && hostsA === hostsB;
}

/** Invisible and bidirectional-override characters a prompt never shows (G.12). */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Text an extension supplied (a URL, its name), made safe to show in Volt's sentence: stripped and length-capped. */
export function promptSafeText(value: string, maxLength: number): string {
	const cleaned = value.replace(INVISIBLE, '');
	return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}
