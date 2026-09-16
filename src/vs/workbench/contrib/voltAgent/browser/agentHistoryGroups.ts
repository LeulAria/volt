/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IAgentSessionMeta } from '../../../services/voltRuntime/common/agentHistory.js';

export interface IAgentHistoryGroup {
	readonly key: string;
	readonly label: string;
	readonly sessions: IAgentSessionMeta[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_ORDER = ['pinned', 'today', 'yesterday', 'week', 'month'];

/**
 * Buckets sessions by last activity: pinned first, then Today, Yesterday,
 * Previous 7 days, Previous 30 days and one bucket per older month.
 * Input order (most recent first) is preserved inside each bucket.
 */
export function groupSessionsByDate(sessions: readonly IAgentSessionMeta[], now = Date.now()): IAgentHistoryGroup[] {
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);
	const today = startOfToday.getTime();
	const yesterday = today - DAY_MS;
	const week = today - 6 * DAY_MS;
	const month = today - 29 * DAY_MS;

	const groups = new Map<string, IAgentHistoryGroup>();
	const push = (key: string, label: string, session: IAgentSessionMeta) => {
		let group = groups.get(key);
		if (!group) {
			group = { key, label, sessions: [] };
			groups.set(key, group);
		}
		group.sessions.push(session);
	};

	for (const session of sessions) {
		if (session.pinned) {
			push('pinned', localize('voltAgent.history.pinned', "Pinned"), session);
			continue;
		}
		const at = session.updatedAt || session.createdAt;
		if (at >= today) {
			push('today', localize('voltAgent.history.today', "Today"), session);
		} else if (at >= yesterday) {
			push('yesterday', localize('voltAgent.history.yesterday', "Yesterday"), session);
		} else if (at >= week) {
			push('week', localize('voltAgent.history.week', "Previous 7 Days"), session);
		} else if (at >= month) {
			push('month', localize('voltAgent.history.month', "Previous 30 Days"), session);
		} else {
			const date = new Date(at);
			const sameYear = date.getFullYear() === startOfToday.getFullYear();
			push(`m-${date.getFullYear()}-${date.getMonth()}`, date.toLocaleDateString(undefined, { month: 'long', year: sameYear ? undefined : 'numeric' }), session);
		}
	}

	return [...groups.values()].sort((a, b) => {
		const ia = FIXED_ORDER.indexOf(a.key);
		const ib = FIXED_ORDER.indexOf(b.key);
		if (ia !== -1 || ib !== -1) {
			return (ia === -1 ? FIXED_ORDER.length : ia) - (ib === -1 ? FIXED_ORDER.length : ib);
		}
		// Older months, newest first; keys are m-YYYY-M.
		return monthKeyValue(b.key) - monthKeyValue(a.key);
	});
}

function monthKeyValue(key: string): number {
	const [, year, month] = key.split('-');
	return Number(year) * 12 + Number(month);
}
