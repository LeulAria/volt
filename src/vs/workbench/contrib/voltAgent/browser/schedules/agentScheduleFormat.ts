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
		return localize('voltSchedules.inMinutes', "in {0} min", minutes);
	}
	const time = formatTimeLabel(minutesOfDay(at));
	const day = startOfDay(at);
	const today = startOfDay(now);
	if (day === today) {
		return localize('voltSchedules.todayAt', "today at {0}", time);
	}
	if (day === addDays(today, 1)) {
		return localize('voltSchedules.tomorrowAt', "tomorrow at {0}", time);
	}
	if (day === addDays(today, -1)) {
		return localize('voltSchedules.yesterdayAt', "yesterday at {0}", time);
	}
	const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
	const date = dateTimeFormat(undefined, sameYear
		? { weekday: 'short', month: 'short', day: 'numeric' }
		: { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(at);
	return localize('voltSchedules.onAt', "{0} at {1}", date, time);
}
