/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IVoltCodeIndexService, NullVoltCodeIndexService } from '../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { CODE_INDEX_ENABLED_SETTING, CODE_INDEX_HIERARCHICAL_IGNORE_SETTING, CODE_INDEX_IGNORE_SYMLINKS_SETTING, FFF_MODE_SETTING, FFF_PATH_SETTING, LSP_ENABLED_SETTING, LSP_MAX_LOCAL_SETTING, LSP_MAX_REMOTE_SETTING, LSP_WORKSPACES_MAX, LSP_WORKSPACES_MIN, LSP_WORKTREES_SETTING, RETRIEVAL_ENABLED_SETTING, RTK_ENABLED_SETTING, RTK_EXCLUDE_SETTING } from '../common/codeIntelligence.js';

/*
 * What stays in core of Code Intelligence: the code index service (the native agent's grep and
 * the context pack use it whatever the extension says) and its settings. The feature's own parts
 * (index warmup, the instant_grep / find_symbol / find_files host tools, its Settings page) are
 * the `volt.code-intelligence` module in contrib/voltCodeIntelligence/.
 */

// Desktop: the main process's index; browsers: the agent server's (both registered later, so they win).
registerSingleton(IVoltCodeIndexService, NullVoltCodeIndexService, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'voltCodeIntelligence',
	title: localize('voltCodeIntelligence.settings', "Volt Code Intelligence"),
	type: 'object',
	properties: {
		[CODE_INDEX_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.index', "Index repositories so agents' searches answer instantly. The index is stored locally and kept fresh as files change."),
		},
		[CODE_INDEX_HIERARCHICAL_IGNORE_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.hierarchicalIgnore', "Apply .voltignore and .cursorignore files in subfolders too, not only at the project root."),
		},
		[CODE_INDEX_IGNORE_SYMLINKS_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.ignoreSymlinks', "Do not follow symbolic links when listing a project's files for the index. Searches from sandboxed chats never follow them, whatever this says."),
		},
		[RTK_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('voltCodeIntelligence.rtk', "Run the agent's shell commands through [RTK](https://github.com/rtk-ai/rtk) when it is installed: `git status`, test runners, linters and package managers print compact output, using 60-90% fewer tokens. Commands RTK does not know run as written."),
		},
		[RTK_EXCLUDE_SETTING]: {
			type: 'array',
			items: { type: 'string' },
			default: [],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('voltCodeIntelligence.rtkExclude', "Commands RTK never rewrites, by their first words: `git log` keeps `git log --oneline` raw but still compacts `git status`. The agent can also get one command's raw output with `rtk proxy <command>`."),
		},
		[FFF_MODE_SETTING]: {
			type: 'string',
			enum: ['auto', 'off'],
			enumDescriptions: [
				localize('voltCodeIntelligence.fffAuto', "Use FFF for fuzzy file search when it is installed; Volt's index otherwise."),
				localize('voltCodeIntelligence.fffOff', "Always use Volt's index for fuzzy file search."),
			],
			// Off unless chosen: one more process per project folder, for ranking the index already does in milliseconds.
			default: 'off',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('voltCodeIntelligence.fff', "Fuzzy file search (the agent's `find_files`) with [FFF](https://github.com/dmtrKovalenko/fff): typo-tolerant, ranked by how recently files changed and were used. It runs as its own process; without it Volt's index answers."),
		},
		[FFF_PATH_SETTING]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.MACHINE,
			description: localize('voltCodeIntelligence.fffPath', "Path to an fff-mcp binary to use instead of the one Volt installs or finds on PATH."),
		},
		[RETRIEVAL_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.retrieval', "Before the agent starts, search the project for the files, symbols and errors your message names and give it the best matches, so it reads the right code first. Capped at a small token budget; skipped when a message names nothing."),
		},
		[LSP_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.lsp', "Let agents use language servers for diagnostics and code navigation. Off: they use the code index instead, and projects in the background stop their language servers."),
		},
		[LSP_WORKTREES_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.lspWorktrees', "Let agents use language servers in their worktree checkouts. Each checkout loads its own copy of the project into the language server."),
		},
		[LSP_MAX_LOCAL_SETTING]: {
			type: 'number',
			default: 3,
			minimum: LSP_WORKSPACES_MIN,
			maximum: LSP_WORKSPACES_MAX,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.maxLocal', "How many local projects keep their language servers running at once. The project on screen and ones with an agent at work come first; the rest stop them until you switch back."),
		},
		[LSP_MAX_REMOTE_SETTING]: {
			type: 'number',
			default: 3,
			minimum: LSP_WORKSPACES_MIN,
			maximum: LSP_WORKSPACES_MAX,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltCodeIntelligence.maxRemote', "How many remote projects (SSH, containers) keep their language servers running at once."),
		},
	},
});
