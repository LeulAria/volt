/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The agent CLIs a runner can drive headlessly, how to tell whether they are installed and have
 * credentials (the runner's operator supplies them; nothing is sent through the relay), the
 * command line for a task, and a parser that turns their JSON event stream into log lines.
 */
export const AGENTS = {
	claude: {
		label: 'Claude Code',
		binary: () => process.env.VOLT_RUNNER_CLAUDE_BIN || 'claude',
		credentials: () => !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || readTokenFile(process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE) || claudeCredentialsFile()),
		/** The prompt goes on stdin, so its size or quoting never matters. */
		command: task => ({
			args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', ...(task.model ? ['--model', task.model] : [])],
			env: claudeEnv(),
		}),
	},
	codex: {
		label: 'Codex',
		binary: () => process.env.VOLT_RUNNER_CODEX_BIN || 'codex',
		credentials: () => !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || fs.existsSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'))),
		command: task => ({
			args: ['exec', '--json', '--skip-git-repo-check', ...codexSandboxArgs(), ...(task.model ? ['-m', task.model] : []), '-'],
			env: {},
		}),
	},
};

/**
 * Codex's own OS sandbox for a task (B-06): on Linux and macOS it writes only the task's checkout
 * and temp (network kept on: tasks install packages), instead of running with the sandbox off.
 * `VOLT_RUNNER_CODEX_SANDBOX=off` is the operator's explicit choice for a container whose kernel
 * cannot give Codex its sandbox (no Landlock); then the container is the only boundary. Windows has
 * no sandbox Codex or Volt can apply here, so it keeps Codex's sandbox off there, and the runner's
 * machine or container is the boundary. Claude Code has no OS sandbox of its own: it runs with
 * `bypassPermissions`, bounded by the container and the allow-listed environment (runnerAgentEnv).
 */
export function codexSandboxArgs(platform = process.platform, env = process.env) {
	if (platform === 'win32' || env.VOLT_RUNNER_CODEX_SANDBOX === 'off') {
		return ['--dangerously-bypass-approvals-and-sandbox'];
	}
	return ['--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=true'];
}

/** What every agent may see of the runner's environment: where things are, never the runner's own secrets. */
const BASE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE'];
/** Each agent's own credentials and config, which it needs to run. */
const AGENT_ENV = {
	claude: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR'],
	codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'],
};

/**
 * The environment a task's agent starts with (B-06): an allow list, not the runner's whole
 * environment. The relay enrol key and token, the admin token and every other VOLT_RELAY_* and
 * VOLT_RUNNER_* setting stay with the runner; one agent never gets another's credentials.
 */
export function runnerAgentEnv(agent, hostEnv = process.env) {
	const env = {};
	for (const name of [...BASE_ENV, ...(AGENT_ENV[agent] ?? [])]) {
		if (typeof hostEnv[name] === 'string') {
			env[name] = hostEnv[name];
		}
	}
	for (const [name, value] of Object.entries(hostEnv)) {
		if (/^LC_[A-Z]+$/.test(name) && typeof value === 'string') {
			env[name] = value;
		}
	}
	return env;
}

function readTokenFile(file) {
	if (!file) {
		return undefined;
	}
	try {
		return fs.readFileSync(file, 'utf8').trim() || undefined;
	} catch {
		return undefined;
	}
}

function claudeCredentialsFile() {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
		return !!raw?.claudeAiOauth?.accessToken;
	} catch {
		return false;
	}
}

/** A token file (mounted read-only) becomes the child's env var; the runner's own env is untouched. */
function claudeEnv() {
	const token = readTokenFile(process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE);
	return token && !process.env.CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
}

function version(binary) {
	return new Promise(resolve => {
		execFile(binary, ['--version'], { timeout: 15_000 }, (err, stdout) => resolve(err ? undefined : String(stdout).trim().split('\n')[0].slice(0, 60)));
	});
}

/** `{ claude: { installed, credentials, version }, codex: … }` for heartbeats. */
export async function detectAgents() {
	const out = {};
	for (const [name, agent] of Object.entries(AGENTS)) {
		const found = await version(agent.binary());
		out[name] = { installed: !!found, credentials: !!found && agent.credentials(), ...(found ? { version: found } : {}) };
	}
	return out;
}

/** One line of an agent's JSON stream → zero or more relay log events. */
export function parseAgentLine(agent, line, state) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return line.trim() ? [{ t: 'log', stream: 'stdout', text: line }] : [];
	}
	return agent === 'codex' ? parseCodex(event, state) : parseClaude(event, state);
}

function parseClaude(event, state) {
	const out = [];
	if (event.type === 'system' && event.subtype === 'init') {
		out.push({ t: 'log', stream: 'system', text: `Claude Code started${event.model ? ` (${event.model})` : ''}.` });
	} else if (event.type === 'assistant') {
		for (const part of event.message?.content ?? []) {
			if (part.type === 'text' && part.text?.trim()) {
				out.push({ t: 'message', role: 'assistant', text: part.text });
			} else if (part.type === 'tool_use') {
				out.push({ t: 'tool', name: part.name, summary: toolSummary(part.input), progress: `${part.name} ${toolSummary(part.input)}`.trim().slice(0, 160) });
			}
		}
	} else if (event.type === 'user') {
		for (const part of event.message?.content ?? []) {
			if (part.type === 'tool_result' && part.is_error) {
				out.push({ t: 'log', stream: 'stderr', text: resultText(part.content).slice(0, 2000) });
			}
		}
	} else if (event.type === 'result') {
		state.summary = typeof event.result === 'string' ? event.result : state.summary;
		state.failed = event.is_error === true || (event.subtype && event.subtype !== 'success');
		out.push({
			t: 'usage',
			inputTokens: (event.usage?.input_tokens ?? 0) + (event.usage?.cache_read_input_tokens ?? 0) + (event.usage?.cache_creation_input_tokens ?? 0),
			outputTokens: event.usage?.output_tokens,
			costUsd: event.total_cost_usd,
			turns: event.num_turns,
		});
	}
	return out;
}

function parseCodex(event, state) {
	const out = [];
	const item = event.item ?? event.msg;
	const type = item?.type ?? item?.item_type;
	if (event.type === 'thread.started') {
		out.push({ t: 'log', stream: 'system', text: 'Codex started.' });
	} else if (type === 'agent_message' && (event.type === 'item.completed' || !event.type)) {
		const text = item.text ?? item.message ?? '';
		if (text.trim()) {
			state.summary = text;
			out.push({ t: 'message', role: 'assistant', text });
		}
	} else if (type === 'command_execution' && event.type === 'item.started') {
		out.push({ t: 'tool', name: 'Shell', summary: String(item.command ?? '').slice(0, 300), progress: `Shell ${String(item.command ?? '').slice(0, 120)}` });
	} else if (type === 'file_change' && event.type === 'item.completed') {
		const paths = (item.changes ?? []).map(change => change.path).filter(Boolean);
		out.push({ t: 'tool', name: 'Edit', summary: paths.join(', ').slice(0, 300) });
	} else if (event.type === 'turn.completed' && event.usage) {
		out.push({ t: 'usage', inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens });
	} else if (event.type === 'turn.failed' || event.type === 'error') {
		state.failed = true;
		out.push({ t: 'log', stream: 'stderr', text: String(event.error?.message ?? event.message ?? 'Codex failed.') });
	}
	return out;
}

/** The one thing worth showing about a tool call: its file, command, pattern or URL. */
export function toolSummary(input) {
	if (!input || typeof input !== 'object') {
		return '';
	}
	const value = input.file_path ?? input.path ?? input.notebook_path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
	return typeof value === 'string' ? value.replace(/\s+/g, ' ').slice(0, 300) : '';
}

function resultText(content) {
	if (typeof content === 'string') {
		return content;
	}
	return Array.isArray(content) ? content.map(part => part.text ?? '').join('\n') : '';
}
