/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { maskSecret } from '../../../../../services/voltRuntime/common/ide/httpFile.js';
import { stripAnsi } from '../../../../../services/voltRuntime/common/ide/testReports.js';
import { cliText, fail, IIdeCapability, IIdeCapabilityContext, IIdeCapabilityResult, num, ok, resolvePath, safeName, str, tail } from './capability.js';

function jsonLines<T>(text: string): T[] {
	return text.split('\n').filter(line => line.trim().startsWith('{')).flatMap(line => {
		try {
			return [JSON.parse(line) as T];
		} catch {
			return [];
		}
	});
}

const DOCKER_DOWN = /Cannot connect to the Docker daemon|error during connect|docker daemon is not running/i;

/**
 * Containers through the docker CLI (the Container Tools extension's views show the same daemon):
 * state, logs and health in a few lines each, so "why does it keep restarting" is one or two calls.
 */
export class DockerCapability implements IIdeCapability {

	readonly id = 'docker';

	async invoke(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const docker = async (dockerArgs: string[], timeoutMs = 30_000) => {
			const result = await ctx.cli.run('docker', dockerArgs, { timeoutMs });
			if (result.code !== 0 && DOCKER_DOWN.test(result.stderr)) {
				return { ...result, stderr: 'Docker is not running. Start it (docker_ensure does it when the volt tools offer it) and try again.' };
			}
			return result;
		};
		const container = safeName(str(args, 'container') ?? str(args, 'name'));
		switch (op) {
			case 'ps': {
				const result = await docker(['ps', ...(args.all === true ? ['-a'] : []), '--format', '{{json .}}']);
				if (result.code !== 0) {
					return cliText(result, 'docker');
				}
				const rows = jsonLines<{ Names: string; Image: string; Status: string; Ports: string; State: string }>(result.stdout);
				return ok(rows.length ? rows.map(row => `${row.Names}  ${row.Image}  ${row.Status}${row.Ports ? `  ${row.Ports}` : ''}`).join('\n') : `No ${args.all === true ? '' : 'running '}containers.`);
			}
			case 'images': {
				const result = await docker(['images', '--format', '{{json .}}']);
				if (result.code !== 0) {
					return cliText(result, 'docker');
				}
				const rows = jsonLines<{ Repository: string; Tag: string; Size: string; CreatedSince: string }>(result.stdout);
				return ok(rows.slice(0, 60).map(row => `${row.Repository}:${row.Tag}  ${row.Size}  ${row.CreatedSince}`).join('\n') || 'No images.');
			}
			case 'logs': {
				if (!container) {
					return fail('logs needs container.');
				}
				const since = safeName(str(args, 'since'));
				const result = await docker(['logs', '--tail', String(Math.min(num(args, 'tail') ?? 200, 2_000)), ...(since ? ['--since', since] : []), container]);
				// docker logs writes the container's stderr to its stderr: both are the log.
				return result.code === 0 ? ok(tail(stripAnsi(`${result.stdout}${result.stderr}`).trim(), 300) || '(no output)') : cliText(result, 'docker logs');
			}
			case 'inspect': {
				if (!container) {
					return fail('inspect needs container.');
				}
				const result = await docker(['inspect', container]);
				if (result.code !== 0) {
					return cliText(result, 'docker inspect');
				}
				return ok(describeContainer(result.stdout));
			}
			case 'stats': {
				const result = await docker(['stats', '--no-stream', '--format', '{{json .}}'], 20_000);
				if (result.code !== 0) {
					return cliText(result, 'docker stats');
				}
				const rows = jsonLines<{ Name: string; CPUPerc: string; MemUsage: string; MemPerc: string }>(result.stdout);
				return ok(rows.map(row => `${row.Name}  cpu ${row.CPUPerc}  mem ${row.MemUsage} (${row.MemPerc})`).join('\n') || 'No running containers.');
			}
			case 'exec': {
				const command = str(args, 'command');
				if (!container || !command) {
					return fail('exec needs container and command.');
				}
				return cliText(await docker(['exec', container, 'sh', '-c', command], 120_000), 'docker exec', 200);
			}
			case 'start':
			case 'stop':
			case 'restart': {
				if (!container) {
					return fail(`${op} needs container.`);
				}
				const result = await docker([op, container], 60_000);
				return result.code === 0 ? ok(`${op === 'stop' ? 'Stopped' : op === 'start' ? 'Started' : 'Restarted'} ${container}.`) : cliText(result, `docker ${op}`);
			}
			case 'compose': {
				const action = str(args, 'action') ?? 'ps';
				const file = str(args, 'file');
				const fileUri = file ? resolvePath(ctx.root, file) : undefined;
				const service = safeName(str(args, 'service'));
				const base = ['compose', ...(fileUri ? ['-f', fileUri.fsPath] : [])];
				switch (action) {
					case 'ps': return cliText(await docker([...base, 'ps', '--format', 'table {{.Service}}\t{{.State}}\t{{.Status}}\t{{.Ports}}']), 'docker compose');
					case 'up': return cliText(await docker([...base, 'up', '-d', '--wait', ...(service ? [service] : [])], 600_000), 'docker compose up', 60);
					case 'down': return cliText(await docker([...base, 'down'], 180_000), 'docker compose down');
					case 'logs': return cliText(await docker([...base, 'logs', '--no-color', '--tail', String(num(args, 'tail') ?? 150), ...(service ? [service] : [])]), 'docker compose logs', 300);
					case 'restart': return cliText(await docker([...base, 'restart', ...(service ? [service] : [])], 180_000), 'docker compose restart');
				}
				return fail('compose action must be ps, up, down, logs or restart.');
			}
		}
		return fail(`docker has no op ${op}.`);
	}
}

interface IInspect {
	readonly Name?: string;
	readonly RestartCount?: number;
	readonly State?: { Status?: string; ExitCode?: number; Error?: string; OOMKilled?: boolean; StartedAt?: string; FinishedAt?: string; Health?: { Status?: string; FailingStreak?: number; Log?: { ExitCode?: number; Output?: string }[] } };
	readonly Config?: { Image?: string; Env?: string[]; Cmd?: string[]; Healthcheck?: { Test?: string[] } };
	readonly NetworkSettings?: { Ports?: Record<string, { HostPort?: string }[] | null> };
	readonly Mounts?: { Source?: string; Destination?: string; Type?: string }[];
	readonly HostConfig?: { RestartPolicy?: { Name?: string } };
}

function describeContainer(raw: string): string {
	const [info] = JSON.parse(raw) as IInspect[];
	if (!info) {
		return 'No such container.';
	}
	const state = info.State ?? {};
	const lines = [
		`${info.Name?.replace(/^\//, '')}  ${info.Config?.Image ?? ''}`,
		`State: ${state.Status}${state.ExitCode ? `, exit code ${state.ExitCode}` : ''}${state.OOMKilled ? ', OOM killed' : ''}${state.Error ? `, error: ${state.Error}` : ''}. Restarts: ${info.RestartCount ?? 0} (policy ${info.HostConfig?.RestartPolicy?.Name || 'no'}). Started ${state.StartedAt}${state.FinishedAt && !state.FinishedAt.startsWith('0001') ? `, finished ${state.FinishedAt}` : ''}.`,
	];
	if (state.Health) {
		lines.push(`Health: ${state.Health.Status}, failing streak ${state.Health.FailingStreak ?? 0}.`);
		for (const check of (state.Health.Log ?? []).slice(-3)) {
			lines.push(`  check exit ${check.ExitCode}: ${(check.Output ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`);
		}
	}
	if (info.Config?.Cmd?.length) {
		lines.push(`Cmd: ${info.Config.Cmd.join(' ')}`);
	}
	const ports = Object.entries(info.NetworkSettings?.Ports ?? {}).map(([port, bindings]) => `${port}${bindings?.length ? ` -> ${bindings.map(binding => binding.HostPort).join(',')}` : ''}`);
	if (ports.length) {
		lines.push(`Ports: ${ports.join(', ')}`);
	}
	if (info.Mounts?.length) {
		lines.push(`Mounts: ${info.Mounts.map(mount => `${mount.Source} -> ${mount.Destination}`).join(', ')}`);
	}
	if (info.Config?.Env?.length) {
		lines.push(`Env: ${info.Config.Env.map(entry => {
			const at = entry.indexOf('=');
			return at > 0 ? `${entry.slice(0, at)}=${maskSecret(entry.slice(0, at), entry.slice(at + 1))}` : entry;
		}).join(' ')}`);
	}
	return lines.join('\n');
}

/** Kubernetes through kubectl, with the current context. Mutating ops ask the user every time. */
export class KubernetesCapability implements IIdeCapability {

	readonly id = 'k8s';

	async invoke(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const namespace = safeName(str(args, 'namespace'));
		const ns = args.all_namespaces === true ? ['-A'] : namespace ? ['-n', namespace] : [];
		const kubectl = (kubeArgs: string[], timeoutMs = 30_000, maxLines = 150) => ctx.cli.run('kubectl', kubeArgs, { timeoutMs }).then(result => cliText(result, 'kubectl', maxLines));
		const kind = safeName(str(args, 'kind'));
		const name = safeName(str(args, 'name'));
		const deployment = safeName(str(args, 'deployment'));
		switch (op) {
			case 'contexts': return kubectl(['config', 'get-contexts']);
			case 'get': return kind ? kubectl(['get', kind, ...(name ? [name] : []), ...ns, '-o', 'wide']) : fail('get needs kind.');
			case 'describe': return kind && name ? kubectl(['describe', kind, name, ...ns], 30_000, 200) : fail('describe needs kind and name.');
			case 'logs': {
				const pod = safeName(str(args, 'pod'));
				const container = safeName(str(args, 'container'));
				return pod ? kubectl(['logs', pod, ...(container ? ['-c', container] : []), ...ns, '--tail', String(Math.min(num(args, 'tail') ?? 200, 2_000)), ...(args.previous === true ? ['--previous'] : [])], 30_000, 300) : fail('logs needs pod.');
			}
			case 'events': return kubectl(['get', 'events', ...ns, '--sort-by=.lastTimestamp'], 30_000, 40);
			case 'rollout': return deployment ? kubectl(['rollout', 'status', `deployment/${deployment}`, ...ns, '--timeout=15s']) : fail('rollout needs deployment.');
			case 'restart': return deployment ? kubectl(['rollout', 'restart', `deployment/${deployment}`, ...ns]) : fail('restart needs deployment.');
			case 'scale': {
				const replicas = num(args, 'replicas');
				return deployment && replicas !== undefined ? kubectl(['scale', `deployment/${deployment}`, `--replicas=${replicas}`, ...ns]) : fail('scale needs deployment and replicas.');
			}
			case 'apply': {
				const path = resolvePath(ctx.root, str(args, 'path'));
				return path ? kubectl(['apply', '-f', path.fsPath, ...ns], 120_000) : fail('apply needs path.');
			}
			case 'delete': return kind && name ? kubectl(['delete', kind, name, ...ns], 120_000) : fail('delete needs kind and name.');
		}
		return fail(`k8s has no op ${op}.`);
	}
}

/** GitHub Actions through the gh CLI (signed in as the user): runs, jobs and the failing logs. */
export class CiCapability implements IIdeCapability {

	readonly id = 'ci';

	async invoke(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const gh = (ghArgs: string[], timeoutMs = 60_000) => ctx.cli.run('gh', ghArgs, { timeoutMs });
		const run = safeName(str(args, 'run'));
		switch (op) {
			case 'runs': {
				let branch = safeName(str(args, 'branch'));
				if (!branch) {
					const current = await ctx.cli.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 10_000 });
					branch = safeName(current.stdout.trim());
				}
				const result = await gh(['run', 'list', ...(branch ? ['--branch', branch] : []), '--limit', String(Math.min(num(args, 'limit') ?? 10, 50)), '--json', 'databaseId,displayTitle,workflowName,status,conclusion,createdAt,event']);
				if (result.code !== 0) {
					return cliText(result, 'gh');
				}
				const runs = JSON.parse(result.stdout || '[]') as { databaseId: number; displayTitle: string; workflowName: string; status: string; conclusion: string; createdAt: string; event: string }[];
				return ok(runs.length ? runs.map(item => `${item.databaseId}  ${item.conclusion || item.status}  ${item.workflowName}: ${item.displayTitle}  (${item.event}, ${item.createdAt})`).join('\n') : `No runs${branch ? ` for ${branch}` : ''}.`);
			}
			case 'view': {
				if (!run) {
					return fail('view needs run (an id from runs).');
				}
				const result = await gh(['run', 'view', run, '--json', 'jobs,conclusion,status,url,displayTitle,workflowName']);
				if (result.code !== 0) {
					return cliText(result, 'gh');
				}
				const view = JSON.parse(result.stdout) as { jobs: { name: string; conclusion: string; status: string; steps?: { name: string; conclusion: string; number: number }[] }[]; conclusion: string; status: string; url: string; displayTitle: string; workflowName: string };
				const lines = [`${view.workflowName}: ${view.displayTitle} - ${view.conclusion || view.status}  ${view.url}`];
				for (const job of view.jobs) {
					lines.push(`${job.conclusion || job.status}  ${job.name}`);
					for (const step of job.steps ?? []) {
						if (step.conclusion && step.conclusion !== 'success' && step.conclusion !== 'skipped') {
							lines.push(`    ${step.conclusion}  step ${step.number}: ${step.name}`);
						}
					}
				}
				return ok(lines.join('\n'));
			}
			case 'logs': {
				if (!run) {
					return fail('logs needs run.');
				}
				const result = await gh(['run', 'view', run, '--log-failed'], 120_000);
				if (result.code !== 0) {
					return cliText(result, 'gh');
				}
				return ok(failedLogDigest(result.stdout) || 'No failed step logs (the run may still be going, or nothing failed).');
			}
			case 'rerun': {
				if (!run) {
					return fail('rerun needs run.');
				}
				return cliText(await gh(['run', 'rerun', run, ...(args.failed === true ? ['--failed'] : [])]), 'gh');
			}
		}
		return fail(`ci has no op ${op}.`);
	}
}

/** `gh run view --log-failed` without its timestamps, cut down to the errors and the end of each step. */
export function failedLogDigest(raw: string): string {
	const byStep = new Map<string, string[]>();
	for (const line of stripAnsi(raw).split('\n')) {
		const [job, step, ...rest] = line.split('\t');
		if (rest.length === 0) {
			continue;
		}
		const text = rest.join('\t').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').replace(/^##\[(?:group|endgroup)\]/, '');
		const key = `${job} / ${step}`;
		byStep.set(key, [...(byStep.get(key) ?? []), text]);
	}
	const out: string[] = [];
	for (const [step, lines] of byStep) {
		const errors = lines.filter(line => /error|fail|exception|panic|assert|\u2717|\u2716/i.test(line)).slice(0, 25);
		out.push(`== ${step}`, ...errors, ...(errors.length ? ['  ...'] : []), ...lines.slice(-25));
	}
	return tail(out.join('\n'), 250);
}
