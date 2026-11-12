/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICliAgentDefinition, probeClaudeAuth, probeCodexAuth, probeFxAuth, probeGrokAuth, probeKimiAuth, probeMuseAuth, probeOpenCodeAuth, probePiAuth } from './cliAgents.js';

/**
 * The hand-written agent list from before providers became manifest data (spec H.12, M2). Kept for
 * one release as the reference `cliAgentParity.test.ts` deep-equals `CLI_AGENTS` (built from
 * `extensions/volt-provider-*`) against; nothing runs from it. Delete it, and the test's reference
 * side, in the release after M2.
 */
export const CLI_AGENT_DEFINITIONS: readonly ICliAgentDefinition[] = [
	{
		id: 'codex',
		label: 'Codex',
		commands: ['codex'],
		versionArgs: ['--version'],
		// Codex has no `acp` subcommand. `codex acp` starts the TUI, which exits with
		// "stdin is not a terminal" when Volt pipes stdio. The adapter speaks ACP for it.
		acpArgs: [],
		acpAdapter: { command: 'codex-acp', package: '@agentclientprotocol/codex-acp@1.13.1' },
		probeAuth: probeCodexAuth,
	},
	{
		id: 'claude-code',
		label: 'Claude',
		commands: ['claude'],
		versionArgs: ['--version'],
		// Claude Code has no `acp` subcommand; the official adapter speaks ACP for it.
		acpArgs: [],
		acpAdapter: { command: 'claude-agent-acp', package: '@agentclientprotocol/claude-agent-acp@0.81.2' },
		// Claude Code turns its to-do tools (TodoWrite / TaskCreate) on only for older models, so Opus 5.5
		// and newer had no list to show in the Tasks card. This switch turns them on for every model.
		acpEnv: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
		probeAuth: probeClaudeAuth,
	},
	{
		id: 'cursor-acp',
		label: 'Cursor',
		commands: ['cursor-agent', 'agent'],
		versionArgs: ['--version'],
		acpArgs: ['acp'],
		earlyAccess: true,
	},
	{
		id: 'grok',
		label: 'Grok',
		commands: ['grok'],
		versionArgs: ['--version'],
		// `grok acp` is not a command. ACP is `grok agent stdio`.
		acpArgs: ['agent', 'stdio'],
		earlyAccess: true,
		probeAuth: probeGrokAuth,
	},
	{
		id: 'opencode',
		label: 'OpenCode',
		// OpenCode 2's npm package also installs `opencode2`; its installer replaces `opencode` itself.
		// `--version` prints "opencode v2.0.26" on 2 and "1.19.0" on 1. ACP is `opencode acp` on both.
		commands: ['opencode', 'opencode2'],
		versionArgs: ['--version'],
		acpArgs: ['acp'],
		probeAuth: probeOpenCodeAuth,
	},
	{
		id: 'pi',
		label: 'Pi',
		commands: ['pi'],
		versionArgs: ['--version'],
		// Pi speaks its own JSON-lines RPC (`pi --mode rpc`), not ACP; the pi-acp adapter drives it
		// with the same login and settings.
		acpArgs: [],
		acpAdapter: { command: 'pi-acp', package: 'pi-acp@0.0.34' },
		earlyAccess: true,
		probeAuth: probePiAuth,
	},
	{
		id: 'antigravity',
		label: 'Antigravity',
		commands: ['agy'],
		versionArgs: ['--version'],
		acpArgs: ['acp'],
	},
	{
		id: 'kimi',
		label: 'Kimi Code',
		commands: ['kimi'],
		versionArgs: ['--version'],
		acpArgs: ['acp'],
		probeAuth: probeKimiAuth,
	},
	{
		id: 'muse',
		label: 'Muse Code',
		commands: ['muse'],
		versionArgs: ['--version'],
		acpArgs: ['acp'],
		probeAuth: probeMuseAuth,
	},
	{
		id: 'fx',
		label: 'fx',
		commands: ['fx'],
		versionArgs: ['--version'],
		acpArgs: ['acp'],
		earlyAccess: true,
		probeAuth: probeFxAuth,
	},
];

/** The sign-in commands from before M2 (`claude login` is a prompt; Claude Code's login is `claude auth login`). */
export const CLI_LOGIN_COMMANDS_REFERENCE: Readonly<Record<string, string>> = {
	'claude-code': 'claude auth login',
	codex: 'codex login',
	'cursor-acp': 'cursor-agent login',
	opencode: 'opencode auth login',
	fx: 'fx login',
};
