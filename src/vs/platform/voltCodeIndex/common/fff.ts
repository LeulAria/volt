/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FFF (github.com/dmtrKovalenko/fff, MIT): a Rust file finder with typo-tolerant fuzzy matching,
 * frecency and git-status ranking and its own watcher. Volt talks to its `fff-mcp` binary over
 * MCP's stdio transport, as a separate process: no native module is loaded into Volt, and the
 * binary is optional (installed on request, found on PATH, or set in settings).
 */

/** The release Volt installs, with the SHA-256 of each binary (from the release's .sha256 files). */
export const FFF_VERSION = '0.11.0';

const FFF_HASHES: Record<string, string> = {
	'fff-mcp-aarch64-apple-darwin': 'cc606d9418cfa7764376dcd7b32a33e6459a6cb9a4718be366b024dca6e9fead',
	'fff-mcp-x86_64-apple-darwin': '33377a8f96442ebc8b06d3bd2863cf66a520f97a33700e0fb85a09dd7988e862',
	'fff-mcp-x86_64-unknown-linux-gnu': '1b645947cfa086f8080cd6419899e32cb2c531b122618c1141d9155e449ce647',
	'fff-mcp-aarch64-unknown-linux-gnu': 'f413fd1809f18f7ba44524010192d29562d6ba5745e33926be18b99cab6edb89',
	'fff-mcp-x86_64-unknown-linux-musl': 'd1e8671f40c89c445aaa1728a21ec04b74be2e5f99091485caeabcc97f99aceb',
	'fff-mcp-aarch64-unknown-linux-musl': '35f8e05d6c865266bf451d13bfa5e1b0d98438fda7dc1c9bdbc1c6a83484577d',
	'fff-mcp-x86_64-pc-windows-msvc.exe': '7a40439b06a33880487661b519f116a6a6d48b1c684bce79adfd5666875f23fd',
	'fff-mcp-aarch64-pc-windows-msvc.exe': '6525ac801df272906f372502707f4a9812c440ace5549ddc7810570d4ca5aced',
};

export interface IFffAsset {
	readonly name: string;
	readonly url: string;
	readonly sha256: string;
}

/** The release binary for a Node `process.platform` / `process.arch`, if FFF ships one. */
export function fffAsset(platform: string, arch: string, musl = false): IFffAsset | undefined {
	const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;
	if (!cpu) {
		return undefined;
	}
	const target = platform === 'darwin' ? `${cpu}-apple-darwin`
		: platform === 'linux' ? `${cpu}-unknown-linux-${musl ? 'musl' : 'gnu'}`
			: platform === 'win32' ? `${cpu}-pc-windows-msvc.exe`
				: undefined;
	const name = target && `fff-mcp-${target}`;
	const sha256 = name ? FFF_HASHES[name] : undefined;
	return name && sha256 ? { name, sha256, url: `https://github.com/dmtrKovalenko/fff/releases/download/v${FFF_VERSION}/${name}` } : undefined;
}

/** `fff-mcp 0.11.0 (95fd777c...)` -> `0.11.0`. */
export function parseFffVersion(output: string): string | undefined {
	return /fff-mcp\s+v?(\d+\.\d+\.\d+[\w.-]*)/.exec(output)?.[1];
}

export interface IFffFindFilesOutput {
	/** Relative to FFF's base folder (the git root), best first. */
	readonly paths: readonly string[];
	/** Files that matched, when FFF says (it does only when there are more than it listed). */
	readonly total?: number;
}

/** Trailing annotations FFF adds to a path line: ` - hot`, ` git:modified`. */
const SUFFIX = /(?: - (?:hot|warm|frequent))?(?: git:(?:modified|untracked|deleted|renamed|staged_new|staged_modified|staged_deleted|ignored|unknown))?$/;

/**
 * Parses the text of FFF's `find_files` tool:
 *
 *   -> Read src/a.ts (exact match!)      (optional hint)
 *   5/2870 matches                      (only when there are more)
 *   src/a.ts - hot git:modified
 *   cursor: 1                           (only when there are more)
 *
 * or `0 results (10270 indexed)`. Pass only the first text block: FFF appends its update notice
 * as a block of its own.
 */
export function parseFffFindFiles(text: string): IFffFindFilesOutput {
	const paths: string[] = [];
	let total: number | undefined;
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\r$/, '');
		if (!line.trim() || line.startsWith('\u2192 ') || /^cursor: \S+$/.test(line)) {
			continue;
		}
		if (/^0 results \(\d+ indexed\)$/.test(line)) {
			return { paths: [], total: 0 };
		}
		const counted = /^(\d+)\/(\d+) matches$/.exec(line);
		if (counted) {
			total = Number(counted[2]);
			continue;
		}
		const path = line.replace(SUFFIX, '');
		if (path) {
			paths.push(path);
		}
	}
	return { paths, ...(total !== undefined ? { total } : {}) };
}
