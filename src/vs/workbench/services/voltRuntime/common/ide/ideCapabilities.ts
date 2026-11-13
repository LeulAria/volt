/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The `ide` tool: every IDE capability beyond the hot path (tests, debug, tasks, code_nav) behind
 * one tool, so the prompt carries one line per capability instead of a schema per tool. The agent
 * reads a capability's arguments with op "help" only when it needs them (progressive disclosure,
 * like deferred tools). Each capability is an adapter in the window (`agentIdeCapabilities.ts`).
 */

export const IDE_GATEWAY_TOOL_NAME = 'ide';

/**
 * What an op does for a chat in Volt's OS sandbox (`hostToolSandbox.ts` judges it):
 * - `safe`: Volt's own state or UI.
 * - `reads` / `writes`: Volt's process reads or writes the files the op names (`path`, `paths`),
 *   judged by the sandbox gate like any host tool's.
 * - `sandboxed`: runs programs through `IdeCli`, which carries the chat's sandbox (git through HostGit's guards).
 * - `escapes`: runs code, or reads credentials, outside the sandbox. Refused for sandboxed chats.
 */
export type IdeOpSandbox = 'safe' | 'reads' | 'writes' | 'sandboxed' | 'escapes';

export interface IIdeOpSpec {
	readonly name: string;
	/** Reads state only: runs without approval. */
	readonly readOnly?: boolean;
	/** Asks the user every time, whatever the access mode (deletes cluster resources, runs extension commands). */
	readonly confirm?: string;
	/** What it does outside the sandbox. Every op says, so a new one is never judged by default. */
	readonly sandbox: IdeOpSandbox;
	/** Arguments and behaviour, for op "help". */
	readonly help: string;
}

export interface IIdeCapabilitySpec {
	readonly id: string;
	/** What it is for, a few words. */
	readonly summary: string;
	readonly ops: readonly IIdeOpSpec[];
}

export const IDE_CAPABILITIES: readonly IIdeCapabilitySpec[] = [
	{
		id: 'editor', summary: 'what the user sees and show them code', ops: [
			{ name: 'state', readOnly: true, sandbox: 'reads', help: 'Active editor (file, cursor, selection text), visible editors, open files with unsaved changes. Scoped to this chat\'s folder.' },
			{ name: 'open', readOnly: true, sandbox: 'reads', help: 'path, line?, end_line?: open the file at a line and select the range for the user.' },
			{ name: 'highlight', readOnly: true, sandbox: 'reads', help: 'path, line, end_line?, note?: mark lines in the editor (gutter + background, hover shows note) to point the user at code. Cleared with clear or when the chat\'s run ends.' },
			{ name: 'clear', readOnly: true, sandbox: 'safe', help: 'Remove this chat\'s highlights.' },
		],
	},
	{
		id: 'git', summary: 'stage, commit, branches, conflicts, blame, history', ops: [
			{ name: 'branches', readOnly: true, sandbox: 'sandboxed', help: 'Local branches, the current one, upstream and ahead/behind.' },
			{ name: 'conflicts', readOnly: true, sandbox: 'sandboxed', help: 'Files with merge conflicts and each conflict region (ours/theirs, line numbers).' },
			{ name: 'blame', readOnly: true, sandbox: 'sandboxed', help: 'path, line, end_line?: who changed those lines, when and in which commit.' },
			{ name: 'history', readOnly: true, sandbox: 'sandboxed', help: 'path?, limit?: commits touching the file (or the repo) with their messages.' },
			{ name: 'show', readOnly: true, sandbox: 'sandboxed', help: 'path, ref: the file as it was at ref (commit, branch, HEAD~1).' },
			{ name: 'stage', sandbox: 'sandboxed', help: 'paths: stage files (all changes when omitted).' },
			{ name: 'unstage', sandbox: 'sandboxed', help: 'paths: unstage files.' },
			{ name: 'commit', sandbox: 'sandboxed', help: 'message, paths?: commit staged changes (or exactly paths).' },
			{ name: 'switch', sandbox: 'sandboxed', help: 'branch, create?: switch branch (create it from HEAD).' },
			{ name: 'stash', sandbox: 'sandboxed', help: 'action: push|pop|list, message?.' },
		],
	},
	{
		id: 'notebook', summary: 'Jupyter notebooks: read, edit, run cells', ops: [
			{ name: 'cells', readOnly: true, sandbox: 'reads', help: 'path: each cell with index, kind, language, source (trimmed) and whether it has outputs.' },
			{ name: 'outputs', readOnly: true, sandbox: 'reads', help: 'path, cell: the cell\'s outputs as text (errors with traceback; images noted).' },
			{ name: 'kernel', readOnly: true, sandbox: 'reads', help: 'path: the selected kernel and its state.' },
			{ name: 'create', sandbox: 'writes', help: 'path, language?: create an empty notebook (python by default) and open it.' },
			{ name: 'edit', sandbox: 'writes', help: 'path, cell, source: replace a cell\'s source.' },
			{ name: 'insert', sandbox: 'writes', help: 'path, at?, source, kind?: code|markdown: insert a cell (default at the end).' },
			// The kernel (Jupyter's, started by its extension) runs outside any sandbox.
			{ name: 'run', sandbox: 'escapes', help: 'path, cells?: run cells (all when omitted) in the notebook\'s kernel, wait, and return their outputs. Variables persist between runs.' },
		],
	},
	{
		id: 'docker', summary: 'containers, images, logs, compose', ops: [
			{ name: 'ps', readOnly: true, sandbox: 'sandboxed', help: 'all?: containers with image, status, ports, health.' },
			{ name: 'images', readOnly: true, sandbox: 'sandboxed', help: 'Local images with size and age.' },
			{ name: 'logs', readOnly: true, sandbox: 'sandboxed', help: 'container, tail? (200), since? (e.g. 10m): container output.' },
			{ name: 'inspect', readOnly: true, sandbox: 'sandboxed', help: 'container: state, restart count, exit code, health log, env (secrets masked), ports, mounts.' },
			{ name: 'stats', readOnly: true, sandbox: 'sandboxed', help: 'CPU and memory of running containers.' },
			{ name: 'exec', sandbox: 'sandboxed', help: 'container, command: run a command inside the container.' },
			{ name: 'start', sandbox: 'sandboxed', help: 'container.' },
			{ name: 'stop', sandbox: 'sandboxed', help: 'container.' },
			{ name: 'restart', sandbox: 'sandboxed', help: 'container.' },
			{ name: 'compose', sandbox: 'sandboxed', help: 'action: ps|up|down|logs|restart, service?, file?: docker compose in this folder (up runs detached).' },
		],
	},
	{
		id: 'k8s', summary: 'Kubernetes pods, deployments, logs, events', ops: [
			{ name: 'contexts', readOnly: true, sandbox: 'sandboxed', help: 'Contexts and the current one.' },
			{ name: 'get', readOnly: true, sandbox: 'sandboxed', help: 'kind (pods, deployments, services...), name?, namespace?, all_namespaces?.' },
			{ name: 'describe', readOnly: true, sandbox: 'sandboxed', help: 'kind, name, namespace?: details and recent events.' },
			{ name: 'logs', readOnly: true, sandbox: 'sandboxed', help: 'pod, container?, namespace?, tail? (200), previous? (the crashed run).' },
			{ name: 'events', readOnly: true, sandbox: 'sandboxed', help: 'namespace?: recent warnings and events, newest last.' },
			{ name: 'rollout', readOnly: true, sandbox: 'sandboxed', help: 'deployment, namespace?: rollout status.' },
			{ name: 'restart', confirm: 'restarts a Kubernetes deployment', sandbox: 'sandboxed', help: 'deployment, namespace?: rollout restart.' },
			{ name: 'scale', confirm: 'scales a Kubernetes deployment', sandbox: 'sandboxed', help: 'deployment, replicas, namespace?.' },
			{ name: 'apply', confirm: 'applies manifests to the cluster', sandbox: 'sandboxed', help: 'path, namespace?: kubectl apply -f.' },
			{ name: 'delete', confirm: 'deletes a Kubernetes resource', sandbox: 'sandboxed', help: 'kind, name, namespace?.' },
		],
	},
	{
		id: 'ci', summary: 'GitHub Actions runs and failed logs', ops: [
			{ name: 'runs', readOnly: true, sandbox: 'sandboxed', help: 'branch? (default current), limit?: recent workflow runs with status.' },
			{ name: 'view', readOnly: true, sandbox: 'sandboxed', help: 'run: jobs and steps with their results.' },
			{ name: 'logs', readOnly: true, sandbox: 'sandboxed', help: 'run: the failed steps\' logs, trimmed to the errors.' },
			{ name: 'rerun', sandbox: 'sandboxed', help: 'run, failed? (only failed jobs).' },
		],
	},
	{
		id: 'http', summary: 'send HTTP requests, .http files', ops: [
			// Request files and environments are read by Volt; a sent request's URL (after variables) is judged by the chat's network rules.
			{ name: 'list', readOnly: true, sandbox: 'reads', help: 'The requests in the workspace\'s .http/.rest files (name, method, url, file:line).' },
			{ name: 'envs', readOnly: true, sandbox: 'reads', help: 'Environments and variables from http-client.env.json / .env files (secret values masked).' },
			{ name: 'send', sandbox: 'reads', help: 'name (a request from list) or method + url, headers? {}, body?, env?: send it and return status, time, size, headers and body (JSON pretty, long bodies trimmed).' },
		],
	},
	{
		id: 'profile', summary: 'CPU profiles and benchmarks', ops: [
			{ name: 'cpu', sandbox: 'sandboxed', help: 'command (a node script/command): run it with the V8 CPU profiler and return the hottest functions with file:line, self and total time. Opens the profile.' },
			{ name: 'bench', sandbox: 'sandboxed', help: 'command, runs? (10), warmup? (1): time a command repeatedly (hyperfine when installed): mean, min, max, stddev.' },
			{ name: 'summary', readOnly: true, sandbox: 'reads', help: 'path: summarize an existing .cpuprofile.' },
		],
	},
	{
		id: 'analyze', summary: 'linters and static analysis into Problems', ops: [
			{ name: 'tools', readOnly: true, sandbox: 'sandboxed', help: 'Which analyzers this project has (eslint, tsc, ruff, mypy, semgrep, golangci-lint, clippy).' },
			{ name: 'run', sandbox: 'sandboxed', help: 'tool? (default all detected), paths?: run analyzers, publish findings to the Problems view, return them grouped by file.' },
		],
	},
	{
		id: 'coverage', summary: 'code coverage reports', ops: [
			{ name: 'report', readOnly: true, sandbox: 'reads', help: 'path?: summarize the newest coverage report (coverage-final.json, lcov.info, coverage.xml, coverage.out): totals, least covered files, and for path its uncovered lines. Produce one with tests run coverage: true.' },
		],
	},
	{
		id: 'remote', summary: 'remote and container dev environments', ops: [
			{ name: 'info', readOnly: true, sandbox: 'reads', help: 'Where this window runs (local, SSH, container, WSL) and the project\'s dev container config, if any.' },
			// ~/.ssh is a credential folder; ssh runs with the user's keys and agent.
			{ name: 'hosts', readOnly: true, sandbox: 'escapes', help: 'SSH hosts from ~/.ssh/config.' },
			{ name: 'exec', confirm: 'runs a command on a remote host', sandbox: 'escapes', help: 'host, command: run a command over SSH (non-interactive; the user approves each).' },
			{ name: 'devcontainer', sandbox: 'sandboxed', help: 'action: up|exec, command? (exec): the Dev Containers CLI (devcontainer) for this folder.' },
		],
	},
	{
		id: 'extensions', summary: 'installed extensions and their commands', ops: [
			{ name: 'list', readOnly: true, sandbox: 'safe', help: 'query?: installed extensions (id, name, what they contribute).' },
			{ name: 'commands', readOnly: true, sandbox: 'safe', help: 'query: editor and extension commands whose title matches (id, title).' },
			// Any registered command, in the window or an extension host outside the sandbox.
			{ name: 'run', confirm: 'runs an editor command', sandbox: 'escapes', help: 'command, args? []: run a command by id (the user approves each).' },
		],
	},
];

export function ideCapability(id: string): IIdeCapabilitySpec | undefined {
	return IDE_CAPABILITIES.find(capability => capability.id === id);
}

export function ideOp(capability: string, op: string): IIdeOpSpec | undefined {
	return ideCapability(capability)?.ops.find(spec => spec.name === op);
}

/** The tool description: one line per capability with its ops. */
export function ideGatewayDescription(available: readonly string[] = IDE_CAPABILITIES.map(item => item.id)): string {
	const lines = IDE_CAPABILITIES.filter(item => available.includes(item.id)).map(item => `${item.id} (${item.summary}): ${item.ops.map(op => op.name).join(', ')}`);
	return [
		'The rest of the IDE, by capability. Call with capability + op + args; op "help" returns a capability\'s arguments. Read-only ops run without approval.',
		...lines,
	].join('\n');
}

export function ideHelp(capability: string): string | undefined {
	const spec = ideCapability(capability);
	return spec ? [`${spec.id}: ${spec.summary}`, ...spec.ops.map(op => `- ${op.name}${op.readOnly ? ' (read-only)' : ''}: ${op.help}`)].join('\n') : undefined;
}

export const IDE_GATEWAY_SCHEMA = {
	type: 'object',
	properties: {
		capability: { type: 'string', enum: IDE_CAPABILITIES.map(item => item.id) },
		op: { type: 'string', description: 'An op of the capability, or help' },
		args: { type: 'object', description: 'The op\'s arguments (op help lists them)' },
	},
	required: ['capability', 'op'],
	additionalProperties: false,
} as const;

export function isIdeGatewayReadOnly(args: unknown): boolean {
	const record = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {};
	const capability = typeof record.capability === 'string' ? record.capability : '';
	const op = typeof record.op === 'string' ? record.op : '';
	if (op === 'help') {
		return true;
	}
	if (capability === 'git' && op === 'stash') {
		const action = (record.args as Record<string, unknown> | undefined)?.action;
		return action === 'list';
	}
	return !!ideOp(capability, op)?.readOnly;
}
