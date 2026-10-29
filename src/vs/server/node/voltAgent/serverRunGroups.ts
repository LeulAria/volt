/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { normalize } from '../../../base/common/path.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { ReplicatedCollection } from '../../../platform/voltAgentServer/common/collections.js';
import { AgentServerProtocol } from '../../../platform/voltAgentServer/common/protocolServer.js';
import { fromWire, toWire } from '../../../platform/voltAgentServer/common/wire.js';
import { AgentRunGroupService } from '../../../workbench/contrib/voltAgent/browser/runGroups/agentRunGroupService.js';
import { providerFamily } from '../../../workbench/services/voltRuntime/browser/providers/providerFamily.js';
import { VoltAccessMode } from '../../../workbench/services/voltRuntime/common/access/accessModes.js';
import {
	IAgentRunGroupService, IRunGroupModel, IRunGroupPrompt, IRunGroupStartRequest, IRunGroupView, RUN_GROUP_MAX_MODELS, RunFollowUpTarget, RunWinnerAction
} from '../../../workbench/services/voltRuntime/common/runGroups/runGroups.js';
import { IAgentRuntimeService } from '../../../workbench/services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../workbench/services/voltRuntime/common/sessionContext.js';

/**
 * The agent server's run groups: the same service a desktop window runs on its own, minus the
 * pull request form (no window here; the client that picked the winner opens its own form).
 */
export class ServerAgentRunGroupService extends AgentRunGroupService {
	protected override async openPullRequest(): Promise<boolean> {
		return false;
	}
}

const PUBLISH_DELAY_MS = 60;
const WINNER_ACTIONS: readonly RunWinnerAction[] = ['merge', 'checkout', 'pr'];
const ACCESS_MODES: readonly string[] = ['supervised', 'auto-accept-edits', 'auto', 'full-access'];

interface IStartRequestWire {
	readonly prompt?: Partial<IRunGroupPrompt>;
	/** Catalog refs, or models the client already labelled (the desktop's picker does). */
	readonly models?: readonly (string | Partial<IRunGroupModel>)[];
	readonly repoRoot?: string;
	readonly projectId?: string;
	readonly baseRef?: string;
	/** The access mode each run's chat starts in (a phone's composer chooses it). */
	readonly accessMode?: string;
}

function fail(code: string, message: string): never {
	throw Object.assign(new Error(message), { code });
}

/**
 * Run groups for every client: the `runGroups` collection (each group with its runs' statuses and
 * roll-up, so a phone needs no orchestrator logic to show them) and the `runGroups.*` methods. A
 * group started on the desktop shows on the phone and in the browser, and the other way round.
 */
export class ServerRunGroups extends Disposable {

	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		protocol: AgentServerProtocol,
		private readonly col: ReplicatedCollection,
		@IAgentRunGroupService private readonly service: IAgentRunGroupService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(service.onDidChange(groupId => this.schedule(groupId)));
		this._register(toDisposable(() => this.timers.forEach(timer => clearTimeout(timer))));
		void service.whenReady.then(() => this.col.replace(Object.fromEntries(service.list().map(group => [group.id, this.view(group.id)]))));
		const group = (id: unknown) => {
			const groupId = String(id ?? '');
			return service.get(groupId) ? groupId : fail('NotFound', 'This comparison no longer exists.');
		};
		this._register(protocol.registerMethods('runGroups', {
			start: (_ctx, request) => this.start(fromWire<IStartRequestWire>(request) ?? {}),
			stop: (_ctx, groupId, runId) => service.stop(group(groupId), typeof runId === 'string' && runId ? runId : undefined),
			retrySetup: (_ctx, groupId, runId) => service.retrySetup(group(groupId), String(runId ?? '')),
			followUp: (_ctx, groupId, target, prompt) => service.followUp(group(groupId), String(target ?? 'all'), this.prompt(fromWire(prompt))),
			setFollowUpTarget: (_ctx, groupId, target) => service.setFollowUpTarget(group(groupId), (target === 'all' ? 'all' : 'selected') satisfies RunFollowUpTarget),
			refreshStats: (_ctx, groupId) => service.refreshStats(group(groupId)),
			pickWinner: (_ctx, groupId, runId, action, options) => {
				const picked = WINNER_ACTIONS.find(candidate => candidate === action) ?? fail('BadArgument', 'Pick merge, checkout or pr.');
				return service.pickWinner(group(groupId), String(runId ?? ''), picked, { removeOthers: !!(options as { removeOthers?: unknown } | undefined)?.removeOthers });
			},
			removeWorktrees: (_ctx, groupId, runIds) => service.removeWorktrees(group(groupId), Array.isArray(runIds) ? runIds.map(String) : []),
			diffTarget: async (_ctx, groupId, from, to) => toWire(await service.diffTarget(group(groupId), String(from ?? 'base'), String(to ?? ''))),
			estimate: async (_ctx, models) => {
				const estimate = await service.estimate(this.models(Array.isArray(models) ? models : []));
				return toWire(estimate);
			},
			archive: (_ctx, groupId) => service.archive(group(groupId)),
		}));
	}

	private schedule(groupId: string): void {
		if (this.timers.has(groupId)) {
			return;
		}
		this.timers.set(groupId, setTimeout(() => {
			this.timers.delete(groupId);
			this.col.update({ [groupId]: this.service.get(groupId) ? this.view(groupId) : undefined });
		}, PUBLISH_DELAY_MS));
	}

	private view(groupId: string): IRunGroupView {
		const group = this.service.get(groupId)!;
		const statuses = Object.fromEntries(group.runs.map(run => [run.id, this.service.runStatus(groupId, run.id)]));
		return toWire({ ...group, statuses, rollup: this.service.rollup(groupId) }) as IRunGroupView;
	}

	private async start(request: IStartRequestWire) {
		const prompt = this.prompt(request.prompt);
		if (!prompt.text.trim()) {
			fail('BadArgument', 'Write a prompt first.');
		}
		const project = request.projectId ? this.sessionContext.getProject(request.projectId) : undefined;
		const repoRoot = typeof request.repoRoot === 'string' && request.repoRoot
			? normalize(request.repoRoot)
			: project?.root.scheme === 'file' ? project.root.fsPath : fail('BadArgument', 'Pick a project on this computer: each model runs in its own worktree of it.');
		const projectId = project?.id ?? this.sessionContext.projects.find(candidate => candidate.root.scheme === 'file' && normalize(candidate.root.fsPath) === repoRoot)?.id;
		const start: IRunGroupStartRequest = {
			prompt,
			models: this.models(request.models ?? []),
			repoRoot,
			...(projectId ? { projectId } : {}),
			...(typeof request.baseRef === 'string' && request.baseRef ? { baseRef: request.baseRef } : {}),
		};
		const group = await this.service.start(start);
		const access = request.accessMode;
		if (typeof access === 'string' && ACCESS_MODES.includes(access)) {
			// Each run blocks on its worktree first, so the mode is set before its prompt goes out.
			await Promise.all(group.runs.map(run => this.runtime.setAccessMode(access as VoltAccessMode, run.id))).catch(err => this.logService.warn('[volt run groups] could not set the access mode', err));
		}
		this.logService.info(`[volt run groups] started ${group.id} (${group.runs.map(run => run.model.label).join(', ')}) in ${repoRoot}`);
		return toWire(group);
	}

	private prompt(value: Partial<IRunGroupPrompt> | undefined): IRunGroupPrompt {
		const text = typeof value?.text === 'string' ? value.text : '';
		return {
			text,
			...(value?.display !== undefined ? { display: value.display } : {}),
			...(typeof value?.mode === 'string' && value.mode ? { mode: value.mode } : {}),
		};
	}

	/** Labels, families and options from the catalog for models a client named by ref only. */
	private models(values: readonly unknown[]): IRunGroupModel[] {
		const catalog = this.runtime.listCatalog();
		return values.slice(0, RUN_GROUP_MAX_MODELS + 1).map(value => {
			const given = (typeof value === 'string' ? { ref: value } : value ?? {}) as Partial<IRunGroupModel>;
			const ref = typeof given.ref === 'string' && given.ref ? given.ref : fail('BadArgument', 'Name each model by its catalog ref.');
			const item = catalog.find(candidate => candidate.ref === ref);
			const label = typeof given.label === 'string' && given.label.trim() ? given.label.trim()
				: item ? [item.label, item.qualifier].filter(Boolean).join(' ') : ref.replace(/^(agent|model):[^:]+:/, '');
			const options = given.options ?? this.runtime.getModelOptions(ref);
			return {
				ref,
				label,
				family: typeof given.family === 'string' && given.family ? given.family : providerFamily(item?.providerId ?? ref.split(':')[1] ?? ''),
				...(options && Object.keys(options).length ? { options } : {}),
			};
		});
	}
}
