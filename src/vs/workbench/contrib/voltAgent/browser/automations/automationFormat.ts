/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { addDays, dateTimeFormat, formatTimeLabel, minutesOfDay, startOfDay } from '../ui/dateTime/voltDateTime.js';

/** "in 5 min", "today at 9:00 AM", "tomorrow at 9:00 AM", "Tue, Oct 6 at 9:00 AM". */
export function formatScheduleWhen(at: number, now: number): string {
	const delta = at - now;
	if (delta >= 0 && delta < 60 * 60_000) {
		const minutes = Math.max(1, Math.round(delta / 60_000));
		return localize('voltAutomations.inMinutes', "in {0} min", minutes);
	}
	const time = formatTimeLabel(minutesOfDay(at));
	const day = startOfDay(at);
	const today = startOfDay(now);
	if (day === today) {
		return localize('voltAutomations.todayAt', "today at {0}", time);
	}
	if (day === addDays(today, 1)) {
		return localize('voltAutomations.tomorrowAt', "tomorrow at {0}", time);
	}
	if (day === addDays(today, -1)) {
		return localize('voltAutomations.yesterdayAt', "yesterday at {0}", time);
	}
	const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
	const date = dateTimeFormat(undefined, sameYear
		? { weekday: 'short', month: 'short', day: 'numeric' }
		: { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(at);
	return localize('voltAutomations.onAt', "{0} at {1}", date, time);
}

/** "now", "5m", "3h", "14d", "8w", "2y": the age column of the automations table. */
export function formatAge(at: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) {
		return localize('voltAutomations.ageNow', "now");
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return localize('voltAutomations.ageMinutes', "{0}m", minutes);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return localize('voltAutomations.ageHours', "{0}h", hours);
	}
	const days = Math.floor(hours / 24);
	if (days < 56) {
		return localize('voltAutomations.ageDays', "{0}d", days);
	}
	return days < 730 ? localize('voltAutomations.ageWeeks', "{0}w", Math.floor(days / 7)) : localize('voltAutomations.ageYears', "{0}y", Math.floor(days / 365));
}

/** "Sun, Oct 11, 3:00 PM": the Next run line. */
export function formatNextRun(at: number): string {
	return dateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
}
