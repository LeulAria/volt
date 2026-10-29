/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse } from '../../../../base/common/json.js';
import { localize } from '../../../../nls.js';
import { AgentResourceEcosystem, AgentResourceGroupId, AgentResourceScope, mcpServersKey, stripTomlComment, tomlTableKeys } from './agentResources.js';

/** What the management page reads out of config files: MCP servers, hook events, instruction load order. */

//#region MCP servers

export interface IAgentMcpServerEntry {
	readonly name: string;
	readonly transport: 'stdio' | 'http' | 'unknown';
	/** The command line or the URL's host, for the row's detail. */
	readonly target?: string;
	/** Environment variables it reads (names only, never values): credentials stay where they are. */
	readonly envRefs: readonly string[];
	/** It sends HTTP headers, which often carry a token. */
	readonly hasHeaders: boolean;
	readonly disabled: boolean;
}

const ENV_REF = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|\$([A-Z_][A-Z0-9_]{2,})/g;

function envRefsIn(value: unknown, into: Set<string>): void {
	if (typeof value === 'string') {
		for (const match of value.matchAll(ENV_REF)) {
			into.add(match[1] ?? match[2]);
		}
	} else if (Array.isArray(value)) {
		value.forEach(entry => envRefsIn(entry, into));
	} else if (value && typeof value === 'object') {
		Object.values(value).forEach(entry => envRefsIn(entry, into));
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

function serverFromObject(name: string, raw: unknown): IAgentMcpServerEntry {
	const config = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const refs = new Set<string>();
	envRefsIn(config.args, refs);
	envRefsIn(config.url, refs);
	envRefsIn(config.headers, refs);
	envRefsIn(config.env, refs);
	// An `env` block names what the server is given; the values may be secrets, so only the names are kept.
	if (config.env && typeof config.env === 'object') {
		Object.keys(config.env).forEach(key => refs.add(key));
	}
	const url = typeof config.url === 'string' ? config.url : typeof config.serverUrl === 'string' ? config.serverUrl : typeof config.httpUrl === 'string' ? config.httpUrl : undefined;
	const command = typeof config.command === 'string' ? config.command : Array.isArray(config.command) ? config.command.join(' ') : undefined;
	const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : [];
	return {
		name,
		transport: url ? 'http' : command ? 'stdio' : 'unknown',
		target: url ? hostOf(url) : command ? [command, ...args].join(' ').slice(0, 120) : undefined,
		envRefs: [...refs],
		hasHeaders: !!config.headers && typeof config.headers === 'object' && Object.keys(config.headers).length > 0,
		disabled: config.disabled === true || config.enabled === false,
	};
}

/**
 * The servers a config file defines: `mcpServers` (Claude, Cursor, Gemini, portable files), `servers`
 * (VS Code's .vscode/mcp.json), `mcp` (OpenCode) and `[mcp_servers.<name>]` (Codex TOML), by
 * {@link mcpServersKey}. `projectPath` picks this
 * project's local servers out of `~/.claude.json`.
 */
export function parseMcpServers(relativePath: string, content: string, projectPath?: string): IAgentMcpServerEntry[] {
	if (/\.toml$/i.test(relativePath)) {
		return parseTomlMcpServers(content);
	}
	const value = parse(content, [], { allowTrailingComma: true, disallowComments: false }) as Record<string, unknown> | undefined;
	if (!value || typeof value !== 'object') {
		return [];
	}
	const servers: IAgentMcpServerEntry[] = [];
	const add = (block: unknown) => {
		if (block && typeof block === 'object' && !Array.isArray(block)) {
			for (const [name, raw] of Object.entries(block)) {
				servers.push(serverFromObject(name, raw));
			}
		}
	};
	add(value[mcpServersKey(relativePath)] ?? value.managedMcpServers);
	if (projectPath && value.projects && typeof value.projects === 'object') {
		add((value.projects as Record<string, { mcpServers?: unknown } | undefined>)[projectPath]?.mcpServers);
	}
	return servers;
}

function parseTomlMcpServers(content: string): IAgentMcpServerEntry[] {
	const servers = new Map<string, Record<string, string>>();
	let current: Record<string, string> | undefined;
	for (const raw of content.split(/\r?\n/)) {
		const line = stripTomlComment(raw);
		const keys = tomlTableKeys(line);
		if (keys?.[0] === 'mcp_servers' && keys.length >= 2) {
			// `[mcp_servers.x.env]` belongs to x; its keys are variable names.
			current = servers.get(keys[1]) ?? {};
			servers.set(keys[1], current);
			if (keys.length === 3 && keys[2] === 'env') {
				current.__env = 'true';
			} else {
				delete current.__env;
			}
			continue;
		}
		if (/^\s*\[/.test(line)) {
			current = undefined;
			continue;
		}
		const entry = current && /^\s*([A-Za-z_][\w-]*)\s*=\s*(.+?)\s*$/.exec(line);
		if (current && entry) {
			current[current.__env ? `env.${entry[1]}` : entry[1]] = entry[2];
		}
	}
	return [...servers].map(([name, fields]) => {
		const text = (key: string) => /^["'](.*)["']$/.exec(fields[key] ?? '')?.[1];
		const refs = new Set<string>();
		for (const [key, value] of Object.entries(fields)) {
			if (key.startsWith('env.')) {
				refs.add(key.slice(4));
			} else if (key === 'bearer_token_env_var') {
				refs.add(text(key) ?? value);
			} else if (key === 'env_vars') {
				for (const match of value.matchAll(/["']([A-Za-z_][\w]*)["']/g)) {
					refs.add(match[1]);
				}
			}
		}
		const url = text('url');
		const command = text('command');
		return {
			name,
			transport: url ? 'http' as const : command ? 'stdio' as const : 'unknown' as const,
			target: url ? hostOf(url) : command,
			envRefs: [...refs],
			hasHeaders: 'http_headers' in fields || 'env_http_headers' in fields,
			disabled: fields.enabled === 'false',
		};
	});
}

//#endregion

//#region Hooks

/** The lifecycle events a hooks file or a settings file's `hooks` block handles. */
export function parseHookEvents(relativePath: string, content: string): string[] {
	if (/\.toml$/i.test(relativePath)) {
		return [...new Set([...content.matchAll(/^\s*\[\[?hooks\.([A-Za-z]+)/gm)].map(match => match[1]))];
	}
	const value = parse(content, [], { allowTrailingComma: true, disallowComments: false }) as { hooks?: unknown } | undefined;
	const hooks = value?.hooks;
	return hooks && typeof hooks === 'object' && !Array.isArray(hooks) ? Object.keys(hooks) : [];
}

//#endregion

//#region Who reads a file

/**
 * Which harnesses read skills and subagents from a config folder, from their docs (2026-10-29):
 * `.agents/skills` is the shared one (Codex, Gemini CLI, Cursor, VS Code); `.claude/` is also read by
 * Cursor and VS Code. Volt's own scan (agentCustomize.ts CONFIG_DIRS) reads .volt, .agents, .claude,
 * .cursor and .codex.
 */
const SKILL_READERS: Record<string, readonly AgentResourceEcosystem[]> = {
	'.agents': ['codex', 'gemini', 'cursor', 'copilot', 'volt'],
	'.claude': ['claude', 'cursor', 'copilot', 'volt'],
	'.cursor': ['cursor', 'volt'],
	'.codex': ['cursor', 'volt'],
	'.gemini': ['gemini'],
	'.github': ['copilot'],
	'.copilot': ['copilot'],
	'.volt': ['volt'],
};

const AGENT_READERS: Record<string, readonly AgentResourceEcosystem[]> = {
	'.claude': ['claude', 'cursor', 'copilot', 'volt'],
	'.cursor': ['cursor', 'volt'],
	'.codex': ['cursor', 'volt'],
	'.gemini': ['gemini'],
	'.github': ['copilot'],
	'.copilot': ['copilot'],
	'.agents': ['volt'],
	'.volt': ['volt'],
};

/** MCP files by path from their root; `home` for the ones in the home folder. Volt's McpHost reads the ones listing 'volt'. */
const MCP_READERS: Record<'project' | 'home', Record<string, readonly AgentResourceEcosystem[]>> = {
	project: {
		'.mcp.json': ['claude', 'volt'],
		'.cursor/mcp.json': ['cursor', 'volt'],
		'.vscode/mcp.json': ['copilot', 'volt'],
		'.volt/mcp.json': ['volt'],
		'.gemini/settings.json': ['gemini'],
		'.codex/config.toml': ['codex'],
	},
	home: {
		'.cursor/mcp.json': ['cursor', 'volt'],
		'.volt/mcp.json': ['volt'],
		'.claude.json': ['claude'],
		'.gemini/settings.json': ['gemini'],
		'.codex/config.toml': ['codex'],
		'.copilot/mcp-config.json': ['copilot'],
	},
};

export interface IAgentReadersInput extends IInstructionChainInput { }

/** The harnesses that read this file, when the docs say; undefined when it is only its own ecosystem's. */
export function agentResourceReaders(item: IAgentReadersInput): readonly AgentResourceEcosystem[] | undefined {
	const segments = item.relativePath.split('/');
	if (item.group === 'skills' || item.group === 'subagents') {
		const table = item.group === 'skills' ? SKILL_READERS : AGENT_READERS;
		for (let index = segments.length - 2; index >= 0; index--) {
			const readers = table[segments[index]];
			if (readers) {
				return readers;
			}
		}
		return undefined;
	}
	if (item.group === 'integrations' || item.group === 'config') {
		const table = item.scope === 'global' ? MCP_READERS.home : item.scope === 'project' || item.scope === 'local' ? MCP_READERS.project : undefined;
		return table?.[item.relativePath];
	}
	return undefined;
}

//#endregion

//#region Instruction load order

/** What a load-order step needs to know about a discovered file. */
export interface IInstructionChainInput {
	readonly group: AgentResourceGroupId;
	readonly ecosystem: AgentResourceEcosystem;
	readonly scope: AgentResourceScope;
	/** From its root: the project folder, the home folder, or the managed folder. */
	readonly relativePath: string;
}

/** A file the step could create when it has none. `global` paths are under the home folder. */
export interface IInstructionCreate {
	readonly scope: 'global' | 'workspace';
	readonly path: string;
}

export interface IInstructionStep<T extends IInstructionChainInput> {
	readonly id: string;
	readonly label: string;
	/** Where it is looked for, as the harness's docs put it. */
	readonly where: string;
	readonly items: readonly T[];
	/** Files that were found but are not read here (an AGENTS.md beside a CLAUDE.md). */
	readonly skipped: readonly T[];
	readonly note?: string;
	readonly create?: IInstructionCreate;
}

export interface IInstructionChain<T extends IInstructionChainInput> {
	readonly ecosystem: AgentResourceEcosystem;
	/** How the files are combined. */
	readonly merge: string;
	readonly steps: readonly IInstructionStep<T>[];
	/** Where the rest of this harness's instructions live, outside files. */
	readonly footnote?: string;
}

const lower = (path: string) => path.toLowerCase();
const isRoot = (path: string, ...names: string[]) => names.some(name => lower(path) === lower(name));
const nestedNamed = (path: string, name: string) => lower(path).endsWith(`/${lower(name)}`) && !lower(path).startsWith('.');

/**
 * The order each harness reads instruction files in this project, from its docs (checked 2026-10-29):
 * Claude Code (code.claude.com/docs/en/memory), Codex (AGENTS.md guide), Gemini CLI (docs/cli/gemini-md.md),
 * Cursor (cursor.com/docs/context/rules) and GitHub Copilot in VS Code (custom instructions).
 */
export function instructionChains<T extends IInstructionChainInput>(items: readonly T[]): IInstructionChain<T>[] {
	const instructions = items.filter(item => item.group === 'instructions');
	const pick = (filter: (item: T) => boolean) => instructions.filter(filter);
	const step = (id: string, label: string, where: string, found: readonly T[], extra?: Partial<Pick<IInstructionStep<T>, 'skipped' | 'note' | 'create'>>): IInstructionStep<T> => ({ id, label, where, items: found, skipped: extra?.skipped ?? [], note: extra?.note, create: found.length ? undefined : extra?.create });

	// Claude Code skips AGENTS.md while any CLAUDE.md is there.
	const claudeProject = pick(item => item.scope === 'project' && isRoot(item.relativePath, 'CLAUDE.md', '.claude/CLAUDE.md'));
	const agentsRoot = pick(item => item.scope === 'project' && isRoot(item.relativePath, 'AGENTS.md', '.claude/AGENTS.md'));
	const claudeLocal = pick(item => item.scope === 'local' && isRoot(item.relativePath, 'CLAUDE.local.md'));
	const usesClaudeMd = claudeProject.length > 0 || claudeLocal.length > 0;
	const claude: IInstructionChain<T> = {
		ecosystem: 'claude',
		merge: localize('agentResources.chain.claudeMerge', "Every file is loaded together, in this order. Later files come last, so they win when two disagree."),
		steps: [
			step('managed', localize('agentResources.chain.org', "Organization"), 'CLAUDE.md', pick(item => item.scope === 'managed' && item.ecosystem === 'claude')),
			step('global', localize('agentResources.chain.yourMemory', "Your memory"), '~/.claude/CLAUDE.md', pick(item => item.scope === 'global' && isRoot(item.relativePath, '.claude/CLAUDE.md')), { create: { scope: 'global', path: '.claude/CLAUDE.md' } }),
			step('globalRules', localize('agentResources.chain.yourRules', "Your rules"), '~/.claude/rules/*.md', pick(item => item.scope === 'global' && lower(item.relativePath).startsWith('.claude/rules/'))),
			step('project', localize('agentResources.chain.project', "Project"), 'CLAUDE.md, .claude/CLAUDE.md', usesClaudeMd ? claudeProject : agentsRoot, {
				skipped: usesClaudeMd ? agentsRoot : [],
				note: usesClaudeMd
					? (agentsRoot.length ? localize('agentResources.chain.agentsSkipped', "AGENTS.md is skipped while a CLAUDE.md exists. Import it with @AGENTS.md to use both.") : undefined)
					: (agentsRoot.length ? localize('agentResources.chain.agentsFallback', "No CLAUDE.md, so AGENTS.md is read instead.") : undefined),
				create: { scope: 'workspace', path: 'CLAUDE.md' },
			}),
			step('projectRules', localize('agentResources.chain.projectRules', "Project rules"), '.claude/rules/**/*.md', pick(item => item.scope === 'project' && lower(item.relativePath).startsWith('.claude/rules/'))),
			step('local', localize('agentResources.chain.local', "Local, not shared"), 'CLAUDE.local.md', claudeLocal, { create: { scope: 'workspace', path: 'CLAUDE.local.md' } }),
			step('nested', localize('agentResources.chain.subfolders', "Subfolders"), '<folder>/CLAUDE.md', pick(item => item.scope === 'nested' && nestedNamed(item.relativePath, 'CLAUDE.md')), { note: localize('agentResources.chain.onDemand', "Loaded when the agent works in that folder.") }),
		],
	};

	const override = (scope: AgentResourceScope, base: string) => pick(item => item.scope === scope && isRoot(item.relativePath, `${base}AGENTS.override.md`));
	const plain = (scope: AgentResourceScope, base: string) => pick(item => item.scope === scope && isRoot(item.relativePath, `${base}AGENTS.md`));
	const codexGlobalOverride = override('global', '.codex/');
	const codexProjectOverride = override('project', '');
	const codex: IInstructionChain<T> = {
		ecosystem: 'codex',
		merge: localize('agentResources.chain.codexMerge', "One file per folder, AGENTS.override.md first. They are joined from the root down to the working folder, up to 32 KiB."),
		steps: [
			step('global', localize('agentResources.chain.global', "Global"), '~/.codex/AGENTS.override.md, ~/.codex/AGENTS.md', codexGlobalOverride.length ? codexGlobalOverride : plain('global', '.codex/'), { skipped: codexGlobalOverride.length ? plain('global', '.codex/') : [], create: { scope: 'global', path: '.codex/AGENTS.md' } }),
			step('project', localize('agentResources.chain.project', "Project"), 'AGENTS.override.md, AGENTS.md', codexProjectOverride.length ? codexProjectOverride : plain('project', ''), { skipped: codexProjectOverride.length ? plain('project', '') : [], create: { scope: 'workspace', path: 'AGENTS.md' } }),
			step('nested', localize('agentResources.chain.subfolders', "Subfolders"), '<folder>/AGENTS.md', pick(item => item.scope === 'nested' && (nestedNamed(item.relativePath, 'AGENTS.md') || nestedNamed(item.relativePath, 'AGENTS.override.md'))), { note: localize('agentResources.chain.codexNested', "Read on the way down to the folder the agent works in; closer files come later.") }),
		],
	};

	const gemini: IInstructionChain<T> = {
		ecosystem: 'gemini',
		merge: localize('agentResources.chain.geminiMerge', "Every file found is joined together. context.fileName in settings can add other names, such as AGENTS.md."),
		steps: [
			step('global', localize('agentResources.chain.global', "Global"), '~/.gemini/GEMINI.md', pick(item => item.scope === 'global' && isRoot(item.relativePath, '.gemini/GEMINI.md')), { create: { scope: 'global', path: '.gemini/GEMINI.md' } }),
			step('project', localize('agentResources.chain.project', "Project"), 'GEMINI.md', pick(item => item.scope === 'project' && isRoot(item.relativePath, 'GEMINI.md')), { create: { scope: 'workspace', path: 'GEMINI.md' } }),
			step('nested', localize('agentResources.chain.subfolders', "Subfolders"), '<folder>/GEMINI.md', pick(item => item.scope === 'nested' && nestedNamed(item.relativePath, 'GEMINI.md')), { note: localize('agentResources.chain.justInTime', "Loaded when a tool touches that folder.") }),
		],
	};

	const cursor: IInstructionChain<T> = {
		ecosystem: 'cursor',
		merge: localize('agentResources.chain.cursorMerge', "Team rules, then project rules, then your rules. All apply; the earlier one wins a conflict."),
		steps: [
			step('rules', localize('agentResources.chain.projectRules', "Project rules"), '.cursor/rules/*.mdc', pick(item => item.ecosystem === 'cursor' && (item.scope === 'project' || item.scope === 'nested') && lower(item.relativePath).includes('.cursor/rules/'))),
			step('agents', 'AGENTS.md', 'AGENTS.md, <folder>/AGENTS.md', pick(item => (item.scope === 'project' || item.scope === 'nested') && (isRoot(item.relativePath, 'AGENTS.md') || nestedNamed(item.relativePath, 'AGENTS.md'))), { create: { scope: 'workspace', path: 'AGENTS.md' } }),
		],
		footnote: localize('agentResources.chain.cursorFootnote', "Your own rules live in Cursor Settings > Rules, and team rules in the Cursor dashboard."),
	};

	const copilot: IInstructionChain<T> = {
		ecosystem: 'copilot',
		merge: localize('agentResources.chain.copilotMerge', "All of them are added together, with no order between them."),
		steps: [
			step('global', localize('agentResources.chain.global', "Global"), '~/.copilot/instructions', pick(item => item.scope === 'global' && item.ecosystem === 'copilot')),
			step('project', localize('agentResources.chain.project', "Project"), '.github/copilot-instructions.md', pick(item => item.scope === 'project' && isRoot(item.relativePath, '.github/copilot-instructions.md')), { create: { scope: 'workspace', path: '.github/copilot-instructions.md' } }),
			step('scoped', localize('agentResources.chain.scoped', "Scoped instructions"), '.github/instructions/*.instructions.md', pick(item => item.ecosystem === 'copilot' && lower(item.relativePath).includes('.github/instructions/'))),
			step('shared', localize('agentResources.chain.shared', "Shared files"), 'AGENTS.md, CLAUDE.md', pick(item => item.scope === 'project' && isRoot(item.relativePath, 'AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md')), { note: localize('agentResources.chain.copilotShared', "Read while chat.useAgentsMdFile and chat.useClaudeMdFile are on (the default).") }),
		],
	};

	return [claude, codex, gemini, cursor, copilot];
}

//#endregion
