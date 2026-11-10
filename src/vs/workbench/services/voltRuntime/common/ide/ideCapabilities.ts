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

export interface IIdeOpSpec {
	readonly name: string;
	/** Reads state only: runs without approval. */
	readonly readOnly?: boolean;
	/** Asks the user every time, whatever the access mode (deletes cluster resources, runs extension commands). */
	readonly confirm?: string;
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
			{ name: 'state', readOnly: true, help: 'Active editor (file, cursor, selection text), visible editors, open files with unsaved changes. Scoped to this chat\'s folder.' },
			{ name: 'open', readOnly: true, help: 'path, line?, end_line?: open the file at a line and select the range for the user.' },
			{ name: 'highlight', readOnly: true, help: 'path, line, end_line?, note?: mark lines in the editor (gutter + background, hover shows note) to point the user at code. Cleared with clear or when the chat\'s run ends.' },
			{ name: 'clear', readOnly: true, help: 'Remove this chat\'s highlights.' },
		],
	},
	{
		id: 'git', summary: 'stage, commit, branches, conflicts, blame, history', ops: [
			{ name: 'branches', readOnly: true, help: 'Local branches, the current one, upstream and ahead/behind.' },
			{ name: 'conflicts', readOnly: true, help: 'Files with merge conflicts and each conflict region (ours/theirs, line numbers).' },
			{ name: 'blame', readOnly: true, help: 'path, line, end_line?: who changed those lines, when and in which commit.' },
			{ name: 'history', readOnly: true, help: 'path?, limit?: commits touching the file (or the repo) with their messages.' },
			{ name: 'show', readOnly: true, help: 'path, ref: the file as it was at ref (commit, branch, HEAD~1).' },
			{ name: 'stage', help: 'paths: stage files (all changes when omitted).' },
			{ name: 'unstage', help: 'paths: unstage files.' },
			{ name: 'commit', help: 'message, paths?: commit staged changes (or exactly paths).' },
			{ name: 'switch', help: 'branch, create?: switch branch (create it from HEAD).' },
			{ name: 'stash', help: 'action: push|pop|list, message?.' },
		],
	},
	{
		id: 'notebook', summary: 'Jupyter notebooks: read, edit, run cells', ops: [
			{ name: 'cells', readOnly: true, help: 'path: each cell with index, kind, language, source (trimmed) and whether it has outputs.' },
			{ name: 'outputs', readOnly: true, help: 'path, cell: the cell\'s outputs as text (errors with traceback; images noted).' },
			{ name: 'kernel', readOnly: true, help: 'path: the selected kernel and its state.' },
			{ name: 'create', help: 'path, language?: create an empty notebook (python by default) and open it.' },
			{ name: 'edit', help: 'path, cell, source: replace a cell\'s source.' },
			{ name: 'insert', help: 'path, at?, source, kind?: code|markdown: insert a cell (default at the end).' },
			{ name: 'run', help: 'path, cells?: run cells (all when omitted) in the notebook\'s kernel, wait, and return their outputs. Variables persist between runs.' },
		],
	},
	{
		id: 'docker', summary: 'containers, images, logs, compose', ops: [
			{ name: 'ps', readOnly: true, help: 'all?: containers with image, status, ports, health.' },
			{ name: 'images', readOnly: true, help: 'Local images with size and age.' },
			{ name: 'logs', readOnly: true, help: 'container, tail? (200), since? (e.g. 10m): container output.' },
			{ name: 'inspect', readOnly: true, help: 'container: state, restart count, exit code, health log, env (secrets masked), ports, mounts.' },
			{ name: 'stats', readOnly: true, help: 'CPU and memory of running containers.' },
			{ name: 'exec', help: 'container, command: run a command inside the container.' },
			{ name: 'start', help: 'container.' },
			{ name: 'stop', help: 'container.' },
			{ name: 'restart', help: 'container.' },
			{ name: 'compose', help: 'action: ps|up|down|logs|restart, service?, file?: docker compose in this folder (up runs detached).' },
		],
	},
	{
		id: 'k8s', summary: 'Kubernetes pods, deployments, logs, events', ops: [
			{ name: 'contexts', readOnly: true, help: 'Contexts and the current one.' },
			{ name: 'get', readOnly: true, help: 'kind (pods, deployments, services...), name?, namespace?, all_namespaces?.' },
			{ name: 'describe', readOnly: true, help: 'kind, name, namespace?: details and recent events.' },
			{ name: 'logs', readOnly: true, help: 'pod, container?, namespace?, tail? (200), previous? (the crashed run).' },
			{ name: 'events', readOnly: true, help: 'namespace?: recent warnings and events, newest last.' },
			{ name: 'rollout', readOnly: true, help: 'deployment, namespace?: rollout status.' },
			{ name: 'restart', confirm: 'restarts a Kubernetes deployment', help: 'deployment, namespace?: rollout restart.' },
			{ name: 'scale', confirm: 'scales a Kubernetes deployment', help: 'deployment, replicas, namespace?.' },
			{ name: 'apply', confirm: 'applies manifests to the cluster', help: 'path, namespace?: kubectl apply -f.' },
			{ name: 'delete', confirm: 'deletes a Kubernetes resource', help: 'kind, name, namespace?.' },
		],
	},
	{
		id: 'ci', summary: 'GitHub Actions runs and failed logs', ops: [
			{ name: 'runs', readOnly: true, help: 'branch? (default current), limit?: recent workflow runs with status.' },
			{ name: 'view', readOnly: true, help: 'run: jobs and steps with their results.' },
			{ name: 'logs', readOnly: true, help: 'run: the failed steps\' logs, trimmed to the errors.' },
			{ name: 'rerun', help: 'run, failed? (only failed jobs).' },
		],
	},
	{
		id: 'http', summary: 'send HTTP requests, .http files', ops: [
			{ name: 'list', readOnly: true, help: 'The requests in the workspace\'s .http/.rest files (name, method, url, file:line).' },
			{ name: 'envs', readOnly: true, help: 'Environments and variables from http-client.env.json / .env files (secret values masked).' },
			{ name: 'send', help: 'name (a request from list) or method + url, headers? {}, body?, env?: send it and return status, time, size, headers and body (JSON pretty, long bodies trimmed).' },
		],
	},
	{
		id: 'profile', summary: 'CPU profiles and benchmarks', ops: [
			{ name: 'cpu', help: 'command (a node script/command): run it with the V8 CPU profiler and return the hottest functions with file:line, self and total time. Opens the profile.' },
			{ name: 'bench', help: 'command, runs? (10), warmup? (1): time a command repeatedly (hyperfine when installed): mean, min, max, stddev.' },
			{ name: 'summary', readOnly: true, help: 'path: summarize an existing .cpuprofile.' },
		],
	},
	{
		id: 'analyze', summary: 'linters and static analysis into Problems', ops: [
			{ name: 'tools', readOnly: true, help: 'Which analyzers this project has (eslint, tsc, ruff, mypy, semgrep, golangci-lint, clippy).' },
			{ name: 'run', help: 'tool? (default all detected), paths?: run analyzers, publish findings to the Problems view, return them grouped by file.' },
		],
	},
	{
		id: 'coverage', summary: 'code coverage reports', ops: [
			{ name: 'report', readOnly: true, help: 'path?: summarize the newest coverage report (coverage-final.json, lcov.info, coverage.xml, coverage.out): totals, least covered files, and for path its uncovered lines. Produce one with tests run coverage: true.' },
		],
	},
	{
		id: 'remote', summary: 'remote and container dev environments', ops: [
			{ name: 'info', readOnly: true, help: 'Where this window runs (local, SSH, container, WSL) and the project\'s dev container config, if any.' },
			{ name: 'hosts', readOnly: true, help: 'SSH hosts from ~/.ssh/config.' },
			{ name: 'exec', confirm: 'runs a command on a remote host', help: 'host, command: run a command over SSH (non-interactive; the user approves each).' },
			{ name: 'devcontainer', help: 'action: up|exec, command? (exec): the Dev Containers CLI (devcontainer) for this folder.' },
		],
	},
	{
		id: 'extensions', summary: 'installed extensions and their commands', ops: [
			{ name: 'list', readOnly: true, help: 'query?: installed extensions (id, name, what they contribute).' },
			{ name: 'commands', readOnly: true, help: 'query: editor and extension commands whose title matches (id, title).' },
			{ name: 'run', confirm: 'runs an editor command', help: 'command, args? []: run a command by id (the user approves each).' },
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
