/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { IVoltCodeIndexOptions, IVoltCodeSymbol, IVoltLspLimits, VoltCodeSymbolKind, VoltFffMode } from '../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import type { IVoltHostToolInfo } from './hostTools.js';

/** Settings > Code Intelligence. */
export const CODE_INDEX_ENABLED_SETTING = 'volt.codeIntelligence.index.enabled';
export const CODE_INDEX_HIERARCHICAL_IGNORE_SETTING = 'volt.codeIntelligence.index.hierarchicalIgnore';
export const CODE_INDEX_IGNORE_SYMLINKS_SETTING = 'volt.codeIntelligence.index.ignoreSymlinks';
export const LSP_ENABLED_SETTING = 'volt.codeIntelligence.lsp.enabled';
export const LSP_WORKTREES_SETTING = 'volt.codeIntelligence.lsp.worktrees';
export const LSP_MAX_LOCAL_SETTING = 'volt.codeIntelligence.lsp.maxLocalWorkspaces';
export const LSP_MAX_REMOTE_SETTING = 'volt.codeIntelligence.lsp.maxRemoteWorkspaces';

/** Run the agent's shell commands through RTK (github.com/rtk-ai/rtk) when it is installed. */
export const RTK_ENABLED_SETTING = 'volt.codeIntelligence.rtk.enabled';
/** Commands (by their first words, e.g. `git log`) RTK never rewrites. */
export const RTK_EXCLUDE_SETTING = 'volt.codeIntelligence.rtk.exclude';
/** FFF (github.com/dmtrKovalenko/fff) for fuzzy file search: `auto` uses it when installed. */
export const FFF_MODE_SETTING = 'volt.codeIntelligence.fff.mode';
/** A specific `fff-mcp` binary, instead of Volt's install or the one on PATH. */
export const FFF_PATH_SETTING = 'volt.codeIntelligence.fff.path';
/** Search the project for what a message names and give the agent the best matches up front. */
export const RETRIEVAL_ENABLED_SETTING = 'volt.codeIntelligence.retrieval.enabled';

export const LSP_WORKSPACES_MIN = 1;
export const LSP_WORKSPACES_MAX = 20;

export function codeIndexEnabled(configuration: IConfigurationService): boolean {
	return configuration.getValue<boolean>(CODE_INDEX_ENABLED_SETTING) !== false;
}

export function readCodeIndexOptions(configuration: IConfigurationService): IVoltCodeIndexOptions {
	return {
		hierarchicalIgnore: configuration.getValue<boolean>(CODE_INDEX_HIERARCHICAL_IGNORE_SETTING) === true,
		ignoreSymlinks: configuration.getValue<boolean>(CODE_INDEX_IGNORE_SYMLINKS_SETTING) === true,
	};
}

export function clampLspWorkspaces(value: unknown, fallback = 3): number {
	const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.min(LSP_WORKSPACES_MAX, Math.max(LSP_WORKSPACES_MIN, number));
}

export function readLspLimits(configuration: IConfigurationService): IVoltLspLimits {
	return {
		enabled: configuration.getValue<boolean>(LSP_ENABLED_SETTING) !== false,
		maxLocal: clampLspWorkspaces(configuration.getValue(LSP_MAX_LOCAL_SETTING)),
		maxRemote: clampLspWorkspaces(configuration.getValue(LSP_MAX_REMOTE_SETTING)),
	};
}

/** Whether agents may ask language servers about files in a folder (a project or a worktree). */
export function lspAllowedFor(configuration: IConfigurationService, inWorktree: boolean): boolean {
	if (configuration.getValue<boolean>(LSP_ENABLED_SETTING) === false) {
		return false;
	}
	return !inWorktree || configuration.getValue<boolean>(LSP_WORKTREES_SETTING) === true;
}

export function rtkEnabled(configuration: IConfigurationService): boolean {
	return configuration.getValue<boolean>(RTK_ENABLED_SETTING) !== false;
}

export function readRtkExclusions(configuration: IConfigurationService): string[] {
	const value = configuration.getValue<unknown>(RTK_EXCLUDE_SETTING);
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];
}

export function readFffSettings(configuration: IConfigurationService): { readonly mode: VoltFffMode; readonly path?: string } {
	const path = configuration.getValue<string>(FFF_PATH_SETTING)?.trim();
	return { mode: configuration.getValue<string>(FFF_MODE_SETTING) === 'off' ? 'off' : 'auto', ...(path ? { path } : {}) };
}

export function retrievalEnabled(configuration: IConfigurationService): boolean {
	return configuration.getValue<boolean>(RETRIEVAL_ENABLED_SETTING) !== false;
}

/** Holds the agent's command for the RTK wrapper, so no quoting can change it. */
export const RTK_COMMAND_ENV = 'VOLT_RTK_CMD';

/**
 * A POSIX shell line that runs `$VOLT_RTK_CMD` through RTK when RTK has a compact form of it
 * (`git status` becomes `rtk git status`, `cargo test` becomes `rtk cargo test`) and as written
 * otherwise, including when RTK is not installed. One process start (~5 ms) per command; the
 * exit code is the command's own. Windows asks `rtk rewrite` without a shell instead (shellTool).
 */
export const RTK_WRAPPER = '__volt_rtk=$(command rtk rewrite "${' + RTK_COMMAND_ENV + '}" 2>/dev/null); if [ -n "$__volt_rtk" ]; then eval "$__volt_rtk"; else eval "${' + RTK_COMMAND_ENV + '}"; fi';

/**
 * Commands RTK should not touch: empty, already RTK (no double wrap: `rtk proxy cmd` is how to
 * get one command's raw output), carrying Volt's own wrapper variable (no recursion), or excluded
 * in settings by their first words (`git log` excludes `git log --oneline` but not `git status`).
 */
export function wantsRtk(command: string, exclusions: readonly string[] = []): boolean {
	const trimmed = command.trim();
	if (!trimmed || /^rtk(\s|$)/.test(trimmed) || trimmed.includes(RTK_COMMAND_ENV)) {
		return false;
	}
	const words = trimmed.split(/\s+/);
	return !exclusions.some(exclusion => {
		const prefix = exclusion.trim().split(/\s+/);
		return prefix.length > 0 && prefix.every((word, i) => words[i] === word);
	});
}

export const SYMBOL_KIND_NAMES: readonly VoltCodeSymbolKind[] = ['function', 'method', 'class', 'interface', 'type', 'enum', 'variable', 'constant', 'module', 'struct', 'trait', 'macro', 'field'];

export function formatSymbols(symbols: readonly IVoltCodeSymbol[], limitHit: boolean, query: string): string {
	if (!symbols.length) {
		return `No declarations named ${JSON.stringify(query)}. Try match "fuzzy", or grep for it.`;
	}
	const lines = symbols.map(symbol => `${symbol.path}:${symbol.line}  ${symbol.kind} ${symbol.name}${symbol.text ? `  \u2014 ${symbol.text}` : ''}`);
	return `${lines.join('\n')}${limitHit ? '\n[More matches exist. Narrow with kind or path, or raise limit.]' : ''}`;
}

//#region Host tools (Claude Code, Codex and other agents over the volt MCP server)

export const INSTANT_GREP_TOOL_NAME = 'instant_grep';
export const FIND_SYMBOL_TOOL_NAME = 'find_symbol';
export const FIND_FILES_TOOL_NAME = 'find_files';

export const CODE_INTELLIGENCE_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: INSTANT_GREP_TOOL_NAME,
		title: 'Searched code',
		group: 'core',
		description: [
			'Regex or literal search over the project\'s files, answered from Volt\'s local trigram index: milliseconds even in very large repos, where ripgrep re-reads every file.',
			'Same semantics as ripgrep (honors .gitignore, case-insensitive unless case_sensitive). Results are grouped by file with line numbers.',
			'Prefer it over Grep, rg or find for searching code. Run several in parallel when exploring.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'Regular expression (or literal text when literal is true)' },
				path: { type: 'string', description: 'Folder to search in (default: the project root)' },
				glob: { type: 'string', description: 'File filter, e.g. src/**/*.ts' },
				type: { type: 'string', description: 'File type shortcut: ts, js, py, go, rust, java, css, html, json, md, ...' },
				literal: { type: 'boolean', description: 'Treat pattern as plain text' },
				case_sensitive: { type: 'boolean' },
				output_mode: { type: 'string', enum: ['content', 'files', 'count'], description: 'Default content' },
				context: { type: 'integer', description: 'Lines of context around each match (0-5)' },
				head_limit: { type: 'integer', description: 'Maximum matches (content) or files (files/count)' },
				multiline: { type: 'boolean', description: 'Let the pattern span lines' },
			},
			required: ['pattern'],
		},
	},
	{
		name: FIND_SYMBOL_TOOL_NAME,
		title: 'Found symbol',
		group: 'core',
		description: [
			'Where functions, classes, interfaces, types, methods and constants are declared, by name, across the whole project. Instant, from Volt\'s code index; no language server needed.',
			'match "exact" (default), "prefix", or "fuzzy" (camel-case and substring: "usrSvc" finds UserService).',
			'Use it first when you know or can guess a name; then read the file at that line.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Symbol name, e.g. createServer or UserService' },
				match: { type: 'string', enum: ['exact', 'prefix', 'fuzzy'] },
				kind: { type: 'string', description: 'Only this kind: function, method, class, interface, type, enum, variable, constant, module, struct, trait, macro' },
				path: { type: 'string', description: 'Only under this folder (relative to the project root)' },
				limit: { type: 'integer', description: 'Maximum results (default 30)' },
			},
			required: ['name'],
		},
	},
	{
		name: FIND_FILES_TOOL_NAME,
		title: 'Found files',
		group: 'core',
		description: [
			'Find a file by a fuzzy name or path, typos allowed ("rootIndx" finds rootIndex.ts), best match first. Instant, from Volt\'s file index (and FFF when installed).',
			'Each word narrows the results: "auth middleware". Use 1-2 words; use instant_grep for file contents.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Part of a file name or path' },
				path: { type: 'string', description: 'Only under this folder (relative to the project root)' },
				limit: { type: 'integer', description: 'Maximum paths (default 20)' },
			},
			required: ['query'],
		},
	},
];

//#endregion
