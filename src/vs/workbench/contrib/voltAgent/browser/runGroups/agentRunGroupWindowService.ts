/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../../base/common/async.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVoltUsageService } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { IVoltQueryCache } from '../../../../services/voltRuntime/browser/queryCache.js';
import { IRunCostHistory } from '../../../../services/voltRuntime/common/runGroups/runGroups.js';
import { limitsQuery, usageQuery } from '../usage/agentUsageModel.js';
import { AgentRunGroupService } from './agentRunGroupService.js';

/**
 * Typical cost of one session per provider family over the last 30 days, and the live usage
 * limits, from the Usage page's cache when it has them (refetching behind them); only a first-ever
 * read waits on the main process. Empty without a usage service.
 */
export async function readRunCostHistory(instantiationService: IInstantiationService): Promise<IRunCostHistory> {
	const usage = instantiationService.invokeFunction(accessor => accessor.getIfExists(IVoltUsageService));
	if (!usage) {
		return { costPerSession: new Map(), limits: [] };
	}
	const cache = instantiationService.invokeFunction(accessor => accessor.getIfExists(IVoltQueryCache));
	const [snapshot, limits] = await Promise.all([
		raceTimeout((cache ? cache.read(usageQuery(usage)) : usage.getUsage()).catch(() => undefined), 4000),
		raceTimeout((cache ? cache.read(limitsQuery(usage)) : usage.getLimits()).catch(() => undefined), 4000),
	]);
	const costPerSession = new Map<string, number>();
	if (snapshot) {
		const since = Date.now() - 30 * 24 * 3600_000;
		const cost = new Map<string, number>();
		const sessions = new Map<string, Set<number>>();
		for (const bucket of snapshot.buckets) {
			if (bucket.hour >= since) {
				cost.set(bucket.provider, (cost.get(bucket.provider) ?? 0) + bucket.costUsd);
			}
		}
		for (const activity of snapshot.activity) {
			if (activity.hour >= since) {
				const set = sessions.get(activity.provider) ?? new Set<number>();
				activity.sessions.forEach(session => set.add(session));
				sessions.set(activity.provider, set);
			}
		}
		for (const [provider, total] of cost) {
			const count = sessions.get(provider)?.size ?? 0;
			if (count > 0 && total > 0) {
				costPerSession.set(provider, total / count);
			}
		}
	}
	const windows = (limits ?? []).flatMap(group => group.windows.map(window => ({
		family: group.provider,
		label: `${group.provider === 'claude' ? 'Claude' : group.provider === 'codex' ? 'Codex' : 'Cursor'} ${window.label.toLowerCase()}`,
		usedPercent: window.usedPercent,
		...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
	})));
	return { costPerSession, limits: windows };
}

/**
 * The run group service of a window that runs its own agents (the agent server is off): the
 * shared one, with the cost warning read from this window's usage history.
 */
export class WindowAgentRunGroupService extends AgentRunGroupService {
	protected override costHistory(): Promise<IRunCostHistory> {
		return readRunCostHistory(this.instantiationService);
	}
}
