/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../../base/common/async.js';
import { VSBuffer, encodeHex } from '../../../../../base/common/buffer.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { McpServerConfig } from './mcpConfig.js';

/**
 * Approvals of a project's own MCP servers (`.mcp.json` and friends in a repository). A cloned
 * repository's server is code from that repository: Volt starts it only in a trusted folder, and
 * only once the user approved that exact server. The approval is pinned to a digest of what would
 * run (command, arguments, environment, working folder and the binary the command resolves to),
 * so any change asks again and the old approval is never used for the new command (INV-21, INV-22).
 */

/** What a project server would run, as the approval card shows it. Environment and header values are left out: they may be secrets. */
export type IVoltMcpServerSpec =
	| { readonly kind: 'stdio'; readonly command: string; readonly args: readonly string[]; readonly envNames: readonly string[]; readonly cwd: string; readonly binary?: string; readonly allowedHosts?: readonly string[] }
	| { readonly kind: 'http'; readonly url: string; readonly headerNames: readonly string[] };

export interface IVoltMcpApprovalRecord {
	/** The project folder's real path. */
	readonly root: string;
	/** The folder as the chat named it (a URI), whose Workspace Trust the approval was granted under. */
	readonly folder?: string;
	readonly name: string;
	/** {@link mcpConfigDigest} of the server the user decided on. */
	readonly digest: string;
	readonly decision: 'allow' | 'deny';
	readonly spec: IVoltMcpServerSpec;
	readonly at: number;
}

/** The approvals store: one decision per (project folder, server name), valid only for its digest. */
export interface IVoltMcpApprovals {
	/** The decision for this exact server, or undefined when there is none or it was made for another digest. */
	decision(root: string, name: string, digest: string): Promise<IVoltMcpApprovalRecord | undefined>;
	/** The last decision for a server by this name, whatever its digest (what a re-prompt diffs against). */
	latest(root: string, name: string): Promise<IVoltMcpApprovalRecord | undefined>;
	list(): Promise<readonly IVoltMcpApprovalRecord[]>;
	/** Replaces the decision for (root, name). */
	set(record: IVoltMcpApprovalRecord): Promise<void>;
	/** Forgets the decisions for a server, or for every server of the folder. */
	remove(root: string, name?: string): Promise<void>;
}

let trustAttestedByApproval = false;

/**
 * The agent server has no Workspace Trust of its own (no folder is trusted there). Its project MCP
 * approvals come from a window, which grants one only for a folder that window trusts and drops
 * them when the folder stops being trusted: there an approval stands for both.
 */
export function setMcpTrustAttestedByApproval(): void {
	trustAttestedByApproval = true;
}

export function isMcpTrustAttestedByApproval(): boolean {
	return trustAttestedByApproval;
}

/** The working folder a stdio server runs in: its own `cwd`, else the project folder. */
export function mcpEffectiveConfig(config: McpServerConfig, root: URI): McpServerConfig {
	return config.kind === 'stdio' && config.cwd === undefined ? { ...config, cwd: root.fsPath } : config;
}

export function mcpServerSpec(config: McpServerConfig, binary: string | undefined): IVoltMcpServerSpec {
	if (config.kind === 'http') {
		return { kind: 'http', url: config.url, headerNames: Object.keys(config.headers).sort() };
	}
	return { kind: 'stdio', command: config.command, args: [...config.args], envNames: Object.keys(config.env).sort(), cwd: config.cwd ?? '', ...(binary ? { binary } : {}), ...(config.allowedHosts ? { allowedHosts: [...config.allowedHosts] } : {}) };
}

/**
 * SHA-256 (hex) of the canonical JSON of what the server runs: `{command, args, env, cwd, binary}`
 * for a stdio server (environment values included, so a changed token asks again; `allowedHosts`
 * too when the config has it, so a server without it keeps its digest), `{url, headers}`
 * for an HTTP one. The server's name is not part of it: renaming a server does not carry its approval
 * because records are looked up by name too.
 */
export async function mcpConfigDigest(config: McpServerConfig, binary: string | undefined): Promise<string> {
	const pinned = config.kind === 'http'
		? { kind: 'http', url: config.url, headers: config.headers }
		: { kind: 'stdio', command: config.command, args: config.args, env: config.env, cwd: config.cwd ?? null, binary: binary ?? null, allowedHosts: config.allowedHosts };
	const bytes = VSBuffer.fromString(canonicalJson(pinned)).buffer;
	const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
	return encodeHex(VSBuffer.wrap(new Uint8Array(digest)));
}

/** JSON with object keys sorted at every level, so equal values always give equal text. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
		return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
	}
	return JSON.stringify(value ?? null);
}

/** One line of the re-prompt's diff: a field of the spec that changed. */
export interface IVoltMcpSpecChange {
	readonly field: 'kind' | 'command' | 'args' | 'cwd' | 'binary' | 'env' | 'allowedHosts' | 'url' | 'headers';
	readonly before: string;
	readonly after: string;
}

/**
 * What changed between the approved spec and the current one. Empty while the digests differ means
 * a value the card does not show changed (an environment variable's or a header's value).
 */
export function diffMcpServerSpec(before: IVoltMcpServerSpec, after: IVoltMcpServerSpec): IVoltMcpSpecChange[] {
	if (before.kind !== after.kind) {
		return [{ field: 'kind', before: before.kind, after: after.kind }];
	}
	const changes: IVoltMcpSpecChange[] = [];
	const add = (field: IVoltMcpSpecChange['field'], a: string, b: string) => {
		if (a !== b) {
			changes.push({ field, before: a, after: b });
		}
	};
	if (before.kind === 'stdio' && after.kind === 'stdio') {
		add('command', before.command, after.command);
		add('args', JSON.stringify(before.args), JSON.stringify(after.args));
		add('cwd', before.cwd, after.cwd);
		add('binary', before.binary ?? '', after.binary ?? '');
		add('env', before.envNames.join(', '), after.envNames.join(', '));
		add('allowedHosts', (before.allowedHosts ?? []).join(', '), (after.allowedHosts ?? []).join(', '));
	} else if (before.kind === 'http' && after.kind === 'http') {
		add('url', before.url, after.url);
		add('headers', before.headerNames.join(', '), after.headerNames.join(', '));
	}
	return changes;
}

interface IStoreFile {
	readonly version: 1;
	readonly approvals: readonly IVoltMcpApprovalRecord[];
}

/**
 * The approvals as a JSON file in the user data folder. Every read goes to the file, so windows
 * and the agent server that share it see each other's decisions at once; every write replaces the
 * file whole (a temporary file renamed over it), so a crash never leaves half a file.
 */
export class VoltMcpApprovalStore implements IVoltMcpApprovals {

	private readonly writes = new Sequencer();

	constructor(
		private readonly file: URI,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) { }

	async decision(root: string, name: string, digest: string): Promise<IVoltMcpApprovalRecord | undefined> {
		const record = await this.latest(root, name);
		return record?.digest === digest ? record : undefined;
	}

	async latest(root: string, name: string): Promise<IVoltMcpApprovalRecord | undefined> {
		return (await this.read()).find(record => record.root === root && record.name === name);
	}

	list(): Promise<readonly IVoltMcpApprovalRecord[]> {
		return this.read();
	}

	set(record: IVoltMcpApprovalRecord): Promise<void> {
		return this.update(records => [...records.filter(other => other.root !== record.root || other.name !== record.name), record]);
	}

	remove(root: string, name?: string): Promise<void> {
		return this.update(records => records.filter(record => record.root !== root || (name !== undefined && record.name !== name)));
	}

	private update(change: (records: readonly IVoltMcpApprovalRecord[]) => readonly IVoltMcpApprovalRecord[]): Promise<void> {
		return this.writes.queue(async () => {
			const next: IStoreFile = { version: 1, approvals: change(await this.read()) };
			const temp = joinPath(this.file, '..', `.${generateUuid()}.tmp`);
			await this.fileService.writeFile(temp, VSBuffer.fromString(JSON.stringify(next, undefined, '\t')));
			try {
				await this.fileService.move(temp, this.file, true);
			} catch (err) {
				await this.fileService.del(temp).catch(() => undefined);
				throw err;
			}
		});
	}

	/** Unreadable or malformed: no approvals, so nothing from a project runs. */
	private async read(): Promise<readonly IVoltMcpApprovalRecord[]> {
		let text: string;
		try {
			text = (await this.fileService.readFile(this.file)).value.toString();
		} catch {
			return [];
		}
		try {
			const parsed = JSON.parse(text) as Partial<IStoreFile> | null;
			return Array.isArray(parsed?.approvals) ? parsed.approvals.filter(isRecord) : [];
		} catch (err) {
			this.logService.warn('[volt mcp] the MCP approvals file is malformed; no project server is approved', err);
			return [];
		}
	}
}

function isRecord(value: unknown): value is IVoltMcpApprovalRecord {
	const record = value as Partial<IVoltMcpApprovalRecord> | null;
	return !!record && typeof record.root === 'string' && typeof record.name === 'string' && typeof record.digest === 'string'
		&& (record.decision === 'allow' || record.decision === 'deny') && !!record.spec && typeof record.spec === 'object';
}
