/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltHostToolInfo } from './hostTools.js';

/**
 * Managed terminals: long-running commands (dev servers, watchers, `docker compose up`, log
 * follows) run in a real terminal the user can open from the chat, while the agent keeps working
 * and reads their output, waits for readiness and stops them with these tools.
 */
export const TERMINAL_START_TOOL_NAME = 'terminal_start';
export const TERMINAL_OUTPUT_TOOL_NAME = 'terminal_output';
export const TERMINAL_WAIT_TOOL_NAME = 'terminal_wait';
export const TERMINAL_SEND_TOOL_NAME = 'terminal_send';
export const TERMINAL_STOP_TOOL_NAME = 'terminal_stop';
export const TERMINAL_LIST_TOOL_NAME = 'terminal_list';
export const DOCKER_ENSURE_TOOL_NAME = 'docker_ensure';
export const APP_OPEN_TOOL_NAME = 'app_open';

export const TERMINAL_TOOL_NAMES = [
	TERMINAL_START_TOOL_NAME,
	TERMINAL_OUTPUT_TOOL_NAME,
	TERMINAL_WAIT_TOOL_NAME,
	TERMINAL_SEND_TOOL_NAME,
	TERMINAL_STOP_TOOL_NAME,
	TERMINAL_LIST_TOOL_NAME,
	DOCKER_ENSURE_TOOL_NAME,
	APP_OPEN_TOOL_NAME,
] as const;

export type VoltTerminalToolName = typeof TERMINAL_TOOL_NAMES[number];

/** Tools that only look: they never need approval and may run alongside others. */
export const TERMINAL_READ_TOOL_NAMES: ReadonlySet<string> = new Set([TERMINAL_OUTPUT_TOOL_NAME, TERMINAL_WAIT_TOOL_NAME, TERMINAL_LIST_TOOL_NAME]);

export function isTerminalToolName(name: string): name is VoltTerminalToolName {
	return (TERMINAL_TOOL_NAMES as readonly string[]).includes(name);
}

/** Lifecycle of a managed terminal, as the chat's chips and the tools report it. */
export type AgentTerminalStatus =
	/** Launched; nothing says it is up yet. */
	| 'starting'
	/** Up and producing output, no readiness signal (or none expected). */
	| 'running'
	/** Its ready pattern matched or it printed a local URL. */
	| 'ready'
	/** Waiting on the user: it asked for input. */
	| 'attention'
	| 'stopping'
	/** Exited 0. */
	| 'completed'
	/** Exited non-zero, or could not start. */
	| 'failed'
	/** Stopped by the agent or the user. */
	| 'stopped';

export function isTerminalLive(status: AgentTerminalStatus): boolean {
	return status === 'starting' || status === 'running' || status === 'ready' || status === 'attention' || status === 'stopping';
}

const ID = { type: 'string', description: 'Terminal id returned by terminal_start (e.g. "term-3").' };

export const TERMINAL_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: TERMINAL_START_TOOL_NAME,
		approvalInReadOnlyModes: 'runs a command on your machine',
		title: 'Started terminal',
		group: 'terminal',
		description: [
			'Start a long-running process in a terminal the user can watch: dev servers, watchers, `docker compose up`, `tail -f`, anything that does not exit by itself.',
			'Returns as soon as the process is ready (printed a local URL or matched ready_pattern), exits, or wait_ms passes, with its id, status and first output. It keeps running while you keep working.',
			'Check on it with terminal_output or terminal_wait, answer prompts with terminal_send, stop it with terminal_stop.',
			'Do not use it for commands that finish on their own (builds, tests, installs, git): run those as normal commands.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The command line, run by the user\'s shell in the project (or cwd).' },
				title: { type: 'string', description: 'Two-word label for the chip, e.g. "Dev server", "API", "Docker".' },
				cwd: { type: 'string', description: 'Working directory, relative to the project or absolute inside it.' },
				ready_pattern: { type: 'string', description: 'Regex that means "up", e.g. "ready in|listening on". A local URL in the output also counts.' },
				wait_ms: { type: 'integer', description: 'Longest to wait for readiness before returning (default 8000, max 60000; 0 returns right after launch).' },
			},
			required: ['command'],
		},
	},
	{
		name: TERMINAL_OUTPUT_TOOL_NAME,
		title: 'Read terminal',
		group: 'terminal',
		description: 'Read a managed terminal\'s output (ANSI stripped) and its status, exit code and URLs. Pass the offset from your previous read to get only what is new.',
		inputSchema: {
			type: 'object',
			properties: {
				id: ID,
				offset: { type: 'integer', description: 'Offset returned by the previous read; omit for the latest output.' },
			},
			required: ['id'],
		},
	},
	{
		name: TERMINAL_WAIT_TOOL_NAME,
		title: 'Waited for terminal',
		group: 'terminal',
		description: 'Wait until a managed terminal prints something matching `until` (a regex) in output that is new since your last read, becomes ready, exits, or timeout_ms passes. Returns the new output.',
		inputSchema: {
			type: 'object',
			properties: {
				id: ID,
				until: { type: 'string', description: 'Regex to wait for in new output, e.g. "compiled|error".' },
				timeout_ms: { type: 'integer', description: 'Default 30000, max 600000.' },
			},
			required: ['id'],
		},
	},
	{
		name: TERMINAL_SEND_TOOL_NAME,
		approvalInReadOnlyModes: 'types into a running process',
		title: 'Typed in terminal',
		group: 'terminal',
		description: 'Type into a managed terminal, e.g. to answer a prompt. Use "\\u0003" for Ctrl+C.',
		inputSchema: {
			type: 'object',
			properties: {
				id: ID,
				text: { type: 'string' },
				enter: { type: 'boolean', description: 'Press Enter after the text (default true).' },
			},
			required: ['id', 'text'],
		},
	},
	{
		name: TERMINAL_STOP_TOOL_NAME,
		approvalInReadOnlyModes: 'stops a running process',
		title: 'Stopped terminal',
		group: 'terminal',
		description: 'Stop a managed terminal\'s process and everything it started. Its output stays readable.',
		inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
	},
	{
		name: TERMINAL_LIST_TOOL_NAME,
		title: 'Listed terminals',
		group: 'terminal',
		description: 'List this chat\'s managed terminals with their id, command, status, exit code and URLs.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: DOCKER_ENSURE_TOOL_NAME,
		approvalInReadOnlyModes: 'can start Docker on your machine',
		title: 'Checked Docker',
		group: 'terminal',
		description: 'Make sure Docker is usable in one call: finds the docker CLI, checks the daemon, starts Docker Desktop (or OrbStack/Colima) when it is not running and waits until it answers. Use it instead of opening Docker and polling `docker info` yourself.',
		inputSchema: {
			type: 'object',
			properties: {
				start: { type: 'boolean', description: 'Start the Docker app when the daemon is down (default true).' },
				timeout_ms: { type: 'integer', description: 'Longest to wait for the daemon (default 90000, max 300000).' },
			},
		},
	},
	{
		name: APP_OPEN_TOOL_NAME,
		approvalInReadOnlyModes: 'opens an app on your machine',
		title: 'Opened app',
		group: 'terminal',
		description: 'Open a desktop app, file or URL with the system (macOS `open`), without stealing focus from Volt unless `focus` is true. Returns at once.',
		inputSchema: {
			type: 'object',
			properties: {
				target: { type: 'string', description: 'App name ("Docker", "Simulator"), bundle id, file path or URL.' },
				focus: { type: 'boolean', description: 'Bring it to the front (default false).' },
			},
			required: ['target'],
		},
	},
];

// --- Command classification --------------------------------------------------------------------

/**
 * Commands that keep running until stopped. Used only when the caller did not say: an explicit
 * `background` flag or `terminal_start` always wins, and anything misjudged as short still hands
 * control back after a while (see the shell tool's yield).
 */
const LONG_RUNNING: readonly RegExp[] = [
	// Package scripts that serve or watch.
	/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch|preview|storybook)(?::[\w:-]+)?(?:\s|$)/,
	/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?![\w:-]*(?:build|test|lint|check|install))[\w:-]*(?:dev|serve|watch)(?:\s|$)/,
	/^(?:npm|pnpm|yarn|bun)\b.*\s--watch(?:All)?\b/,
	/^(?:npx\s+|pnpm\s+(?:exec|dlx)\s+|bunx\s+)?(?:vite|next|nuxt|astro|remix|react-scripts|vue-cli-service|ng|expo|storybook)\s+(?:dev|start|serve|preview)\b/,
	/^(?:npx\s+)?vite(?:\s+--?[\w-]+(?:[ =]\S+)?)*\s*$/,
	/^(?:npx\s+)?(?:webpack\s+serve|webpack-dev-server|nodemon|ts-node-dev|tsx\s+watch|serve|http-server|live-server|browser-sync)\b/,
	/^node\s+--watch\b/,
	/^(?:npx\s+)?(?:tsc|jest|vitest|mocha|webpack|rollup|esbuild|babel|sass|tailwindcss|postcss|gulp|grunt)\b.*\s(?:--watch(?:All)?|-w)\b/,
	// Servers of other stacks.
	/^(?:python3?\s+-m\s+(?:http\.server|uvicorn|flask\s+run|django)|python3?\s+manage\.py\s+runserver|flask\s+run|uvicorn|gunicorn|hypercorn|fastapi\s+(?:dev|run)|streamlit\s+run|jupyter\s+(?:lab|notebook))\b/,
	/^(?:bundle\s+exec\s+)?(?:rails\s+(?:s|server)|bin\/dev|bin\/rails\s+(?:s|server)|jekyll\s+serve|puma)\b/,
	/^(?:php\s+artisan\s+serve|php\s+-S|hugo\s+server|mkdocs\s+serve|cargo\s+watch|air|reflex\s+run|deno\s+task\s+(?:dev|start))\b/,
	/^(?:redis-server|mongod|postgres\s+-D|ollama\s+serve|ngrok|cloudflared\s+tunnel|minikube\s+tunnel|kubectl\s+port-forward)\b/,
	// Containers in the foreground and log follows.
	/^docker(?:-compose|\s+compose)\s+(?:-f\s+\S+\s+)*up\b(?!.*\s(?:-d|--detach)\b)/,
	/^(?:docker|kubectl|podman)\s+(?:compose\s+)?logs\b.*\s(?:-f|--follow)\b/,
	/^tail\s+.*-[a-zA-Z]*[fF]\b/,
];

/** Whether `command` runs until stopped (a server, watcher or log follow). */
export function isLongRunningCommand(command: string): boolean {
	return commandSegments(command).some(segment => LONG_RUNNING.some(pattern => pattern.test(segment)));
}

/** The simple commands of a command line, without leading env assignments or `cd x &&`. */
function commandSegments(command: string): string[] {
	return command
		.split(/&&|\|\||;|\n/)
		.map(segment => segment.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '').replace(/^(?:exec|time|sudo)\s+/, ''))
		.filter(Boolean);
}

/** A short label for a terminal chip when the agent gave none. */
export function terminalLabelFor(command: string): string {
	const segments = commandSegments(command);
	const main = segments[segments.length - 1] ?? command.trim();
	if (/^docker(?:-compose|\s+compose)\b|^docker\s+run\b|^podman\b/.test(main)) {
		return 'Docker';
	}
	if (/\blogs\b|^tail\s/.test(main)) {
		return 'Logs';
	}
	if (/\b(?:test|jest|vitest|pytest|mocha|playwright)\b/.test(main)) {
		return 'Tests';
	}
	if (/\s--watch\b|\s-w\b|\bwatch\b|nodemon/.test(main)) {
		return 'Watcher';
	}
	if (/\b(?:dev|serve|server|start|preview|runserver|uvicorn|gunicorn|rails\s+s|artisan\s+serve|http\.server)\b/.test(main)) {
		return 'Dev server';
	}
	const words = main.split(/\s+/).slice(0, 3).join(' ');
	return words.length > 24 ? `${words.slice(0, 23)}\u2026` : words;
}

// --- Output signals ----------------------------------------------------------------------------

/** A local address a server printed: the strongest readiness signal there is. */
const LOCAL_URL_SOURCE = String.raw`\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.local)(?::\d{2,5})?(?:\/[^\s'")\]]*)?`;
const LOCAL_URL = new RegExp(LOCAL_URL_SOURCE);

/** Lines that usually mean "up". Checked only on new output. */
const READY_HINT = /\b(?:ready in|ready on|ready -|is ready|server (?:is )?(?:running|started|listening)|listening (?:on|at)|started server|compiled successfully|successfully compiled|watching for (?:file )?changes|application startup complete|accepting connections|serving (?:on|at)|running (?:on|at) https?:)/i;

/** Lines worth surfacing as the reason something is wrong. */
const ERROR_HINT = /(?:EADDRINUSE|address already in use|cannot connect to the docker daemon|is the docker daemon running|command not found|no such file or directory|permission denied|\bERR!|\bError:|\bFATAL\b|Traceback \(most recent call last\)|Unhandled(?:Promise)?Rejection|failed to compile|exited with code [1-9])/i;

/** Lines that ask the user for something. */
const PROMPT_HINT = /(?:\?\s*(?:\(y\/n\)|\[y\/N\]|\[Y\/n\])\s*$|press (?:any key|enter) to|enter (?:your )?(?:password|passphrase)|would you like to|ok to proceed\?)/i;

export function localUrlsIn(text: string): string[] {
	const urls = new Set<string>();
	for (const match of text.matchAll(new RegExp(LOCAL_URL_SOURCE, 'g'))) {
		urls.add(match[0].replace(/[.,;:]+$/, '').replace('0.0.0.0', 'localhost'));
	}
	return [...urls];
}

export function looksReady(text: string): boolean {
	return READY_HINT.test(text) || LOCAL_URL.test(text);
}

/** The last line of `text` that looks like an error, trimmed for a one-line summary. */
export function lastErrorLine(text: string): string | undefined {
	const lines = text.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line && ERROR_HINT.test(line)) {
			return line.length > 200 ? `${line.slice(0, 199)}\u2026` : line;
		}
	}
	return undefined;
}

export function looksLikePrompt(text: string): boolean {
	const tail = text.slice(-400).trimEnd();
	const last = tail.slice(tail.lastIndexOf('\n') + 1);
	return PROMPT_HINT.test(last);
}

/** Regex from the agent; an invalid one matches literally instead of failing the call. */
export function agentPattern(source: string | undefined): RegExp | undefined {
	if (!source) {
		return undefined;
	}
	try {
		return new RegExp(source, 'im');
	} catch {
		return new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'im');
	}
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Z0-9]|\u001b[=>78MDEc]/g;

/** Terminal output as plain text: escape sequences gone, carriage-return redraws collapsed. */
export function plainTerminalText(data: string): string {
	return data
		.replace(ANSI, '')
		.replace(/\r\n/g, '\n')
		// A progress bar redraws its line with \r: keep only the last state of the line.
		.replace(/[^\n]*\r(?!\n)/g, '');
}
