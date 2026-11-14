/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { findNodeAtLocation, JSONPath, ParseError, parseTree } from '../../../base/common/json.js';
import { IAdminPolicy, managedPolicyRefusal } from './authority.js';
import type { ISandboxCompositionNote, SandboxLayerSource } from './compile.js';
import { ISandboxFilesystemPolicy, ISandboxNetworkPolicy, IVoltSandboxPolicyLayer, MAX_POLICY_BYTES, parseSandboxPolicyLayer } from './sandboxSchema.js';

/**
 * Sandbox policy files (02-design.md, "Policy files"): the user's `~/.volt/sandbox.json` (trusted:
 * it may widen or narrow the agent profile) and a repository's `<root>/.volt/sandbox.json`
 * (untrusted: narrow only). Pure: the node side (`node/sandboxPolicyFiles.ts`) reads them.
 *
 * A broken user file refuses the launch (the user asked for rules Volt cannot apply). A broken
 * repository file is ignored with a warning: a repository must never be able to stop its user from
 * working, and ignoring a narrow-only file can never widen anything. The managed policy beats both:
 * every widening of the user file it denies is dropped (`capUserLayer`).
 */

/** Relative to the home folder, and to each workspace root. */
export const SANDBOX_POLICY_FILE = '.volt/sandbox.json';

export type SandboxPolicyFileSource = Extract<SandboxLayerSource, 'user' | 'workspace'>;

/** One policy file a launch looked at. Missing files are not listed. */
export interface ISandboxPolicyFileState {
	readonly source: SandboxPolicyFileSource;
	readonly path: string;
	/** `loaded`: applied. `error`: the user's refuses the launch, a repository's is ignored. */
	readonly state: 'loaded' | 'error';
	/** `line 3: filesystem.write[0] must be absolute ...` */
	readonly problem?: string;
}

/** What the policy files do to one chat's sandbox, for the chat's Access menu. */
export interface ISandboxPolicyFilesInfo {
	readonly files: readonly ISandboxPolicyFileState[];
	/** Entries the composition dropped: a repository's widenings, the user's the managed policy denies. */
	readonly ignored: readonly ISandboxCompositionNote[];
	/** Set when the user's file is broken: the chat's agent will not start. */
	readonly refusal?: string;
}

export type SandboxPolicyFileParse =
	| { readonly ok: true; readonly layer: IVoltSandboxPolicyLayer }
	| { readonly ok: false; readonly problem: string };

/** `filesystem.write[2]` as a JSON path. */
function jsonPath(path: string): JSONPath {
	const out: JSONPath = [];
	for (const match of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
		out.push(match[2] !== undefined ? Number(match[2]) : match[1]);
	}
	return out;
}

function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			line++;
		}
	}
	return line;
}

/**
 * A policy file's text as a layer, or its first problem with the line it is on. Strict JSON (no
 * comments, no trailing commas) through the schema's strict parser.
 */
export function parseSandboxPolicyFile(raw: string): SandboxPolicyFileParse {
	const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
	if (text.length > MAX_POLICY_BYTES) {
		return { ok: false, problem: `the file is larger than ${MAX_POLICY_BYTES} bytes` };
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (err) {
		const errors: ParseError[] = [];
		parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
		const line = errors.length ? lineAt(text, errors[0].offset) : 1;
		return { ok: false, problem: `line ${line}: not valid JSON (${(err as Error).message.replace(/\s+in JSON at position.*$/, '')})` };
	}
	const parsed = parseSandboxPolicyLayer(value);
	if (parsed.ok) {
		return { ok: true, layer: parsed.value };
	}
	const first = parsed.errors[0];
	// The value at the error's path, else its parent (a list cut short at its 256th entry).
	const root = parseTree(text);
	const segments = first ? jsonPath(first.path) : [];
	const node = root && (findNodeAtLocation(root, segments) ?? findNodeAtLocation(root, segments.slice(0, -1)));
	const where = `line ${node ? lineAt(text, node.offset) : 1}`;
	const what = first ? `${first.path ? `${first.path} ` : ''}${first.message}` : 'not a sandbox policy';
	const more = parsed.errors.length > 1 ? ` (and ${parsed.errors.length - 1} more)` : '';
	return { ok: false, problem: `${where}: ${what}${more}` };
}

/**
 * The user file's widenings the managed policy denies, dropped (it beats the user). Each widening
 * is judged as the request the Authority would see for it: `files.write` for a writable folder,
 * `files.read:home` for a home path or a lifted credential deny, `net.connect` for a host or for the
 * whole network, `net.listen:<port>`, `net.loopback.connect:<port>`, `net.local.connect` for a
 * socket. What the managed policy has no words for (environment, limits) is the user's.
 */
export function capUserLayer(layer: IVoltSandboxPolicyLayer, admin: IAdminPolicy, home: string): { readonly layer: IVoltSandboxPolicyLayer; readonly ignored: readonly ISandboxCompositionNote[] } {
	if (!admin.denyCapabilities?.length && !admin.denyHosts?.length) {
		return { layer, ignored: [] };
	}
	const ignored: ISandboxCompositionNote[] = [];
	/** Whether the managed policy lets the user's file ask for `capability`; a refusal is noted. */
	const allowed = (field: string, value: string | number, capability: string, target?: string): boolean => {
		const reason = managedPolicyRefusal(admin, capability, target);
		if (reason) {
			ignored.push({ source: 'user', field, value: String(value), reason });
		}
		return !reason;
	};
	const inHome = (path: string) => path === '${home}' || path.startsWith('${home}/') || path === home || path.startsWith(`${home}/`);
	const fs: { -readonly [K in keyof ISandboxFilesystemPolicy]?: ISandboxFilesystemPolicy[K] } | undefined = layer.filesystem && { ...layer.filesystem };
	if (fs) {
		fs.read &&= fs.read.filter(path => !inHome(path) || allowed('filesystem.read', path, 'files.read:home', path));
		fs.write &&= fs.write.filter(path => allowed('filesystem.write', path, 'files.write', path));
		fs.unmask &&= fs.unmask.filter(path => allowed('filesystem.unmask', path, 'files.read:home', path));
	}
	const net: { -readonly [K in keyof ISandboxNetworkPolicy]?: ISandboxNetworkPolicy[K] } | undefined = layer.network && { ...layer.network };
	if (net) {
		if (net.mode === 'host' && !allowed('network.mode', 'host', 'net.connect', '*')) {
			delete net.mode;
		}
		if (net.listen && !allowed('network.listen', 'true', 'net.listen:*')) {
			delete net.listen;
		}
		net.allow &&= net.allow.filter(host => allowed('network.allow', host, 'net.connect', host));
		net.loopbackPorts &&= net.loopbackPorts.filter(port => allowed('network.loopbackPorts', port, `net.loopback.connect:${port}`));
		net.listenPorts &&= net.listenPorts.filter(port => allowed('network.listenPorts', port, `net.listen:${port}`));
	}
	const sockets = layer.host?.unixSockets?.filter(socket => allowed('host.unixSockets', socket, 'net.local.connect'));
	return {
		layer: {
			...layer,
			...(fs ? { filesystem: fs } : {}),
			...(net ? { network: net } : {}),
			...(sockets ? { host: { ...layer.host, unixSockets: sockets } } : {}),
		},
		ignored,
	};
}

/**
 * `${home}` and (in a repository's file) `${workspace}` as the paths they stand for, so a narrowing
 * compares like with like: the agent profile names real folders, not tokens. A repository's
 * `${workspace}` is its own root. `${tmp}`, `${storage}`, `${system}` and `${path}` stay tokens.
 */
export function expandPolicyFileTokens(layer: IVoltSandboxPolicyLayer, home: string, workspaceRoot: string | undefined): IVoltSandboxPolicyLayer {
	const expand = (entry: string): string => {
		if (entry === '${home}' || entry.startsWith('${home}/')) {
			return home + entry.slice('${home}'.length);
		}
		if (workspaceRoot !== undefined && (entry === '${workspace}' || entry.startsWith('${workspace}/'))) {
			return workspaceRoot + entry.slice('${workspace}'.length);
		}
		return entry;
	};
	const list = (values: readonly string[]) => [...new Set(values.map(expand))];
	const fs: { -readonly [K in keyof ISandboxFilesystemPolicy]?: ISandboxFilesystemPolicy[K] } | undefined = layer.filesystem && { ...layer.filesystem };
	if (fs) {
		for (const key of ['read', 'write', 'deny', 'protect', 'unmask'] as const) {
			fs[key] &&= list(fs[key]);
		}
	}
	return {
		...layer,
		...(fs ? { filesystem: fs } : {}),
		...(layer.host?.unixSockets ? { host: { ...layer.host, unixSockets: list(layer.host.unixSockets) } } : {}),
	};
}

/** "Ignored from .volt/sandbox.json: network.mode host, filesystem.write /etc" for the transcript. */
export function describeIgnoredEntries(ignored: readonly ISandboxCompositionNote[], fileName: (source: SandboxLayerSource) => string | undefined): string[] {
	const bySource = new Map<string, ISandboxCompositionNote[]>();
	for (const note of ignored) {
		const name = fileName(note.source);
		if (name) {
			bySource.set(name, [...bySource.get(name) ?? [], note]);
		}
	}
	return [...bySource].map(([name, notes]) => `Ignored from ${name}: ${notes.map(note => `${note.field} ${note.value} (${note.reason})`).join('; ')}.`);
}
