/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentAutomationCalendar.css';
import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import {
	AutomationSchedule, formatTimeOfDay, gmtOffsetLabel, IAutomation, IAutomationTrigger, nextRunsPreview, nextScheduleAt, parseTimeOfDay, scheduleKindOf, scheduleSaveError, weekdayName,
} from '../../../../services/voltRuntime/common/automations/automations.js';
import { describeCron } from '../../../../services/voltRuntime/common/automations/automationCron.js';
import { isLocalTimeZone, timeZoneLabel, wallClock } from '../../../../services/voltRuntime/common/automations/automationTime.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { dateTimeFormat, startOfDay } from '../ui/dateTime/voltDateTime.js';
import { VoltDateField, VoltTimeField } from '../ui/dateTime/voltDateTimeFields.js';
import { formatNextRun, formatScheduleWhen } from './automationFormat.js';
import { clockIcon } from './automationIcons.js';
import { showCronPresetMenu, showIntervalMenu, showMinuteMenu, showTimeMenu, showTimeZoneMenu, showWeekdayMenu } from './automationPickers.js';
import { button } from './automationUi.js';

export interface IScheduleRowContext {
	readonly contextView: IContextViewService;
	/** Cleared when the triggers card redraws. */
	readonly store: DisposableStore;
	/** Applies a change to this trigger; `redraw` re-renders the triggers card. */
	readonly update: (patch: Partial<IAutomationTrigger>, redraw?: boolean) => void;
	/** Re-renders the triggers card (after a menu that kept the row while it changed). */
	readonly rerender: () => void;
	/** The automation as saved: its planned next run shows while the schedule is unchanged. */
	readonly saved: () => IAutomation | undefined;
	/** The draft's Active switch. */
	readonly enabled: () => boolean;
}

/** "Local (GMT+4)", "GMT+1 · Berlin". */
export function zoneChipLabel(zone: string | undefined, now: number): string {
	return isLocalTimeZone(zone) ? localize('voltAutomations.localZone', "Local ({0})", gmtOffsetLabel(now)) : timeZoneLabel(zone!, now);
}

function chip(parent: HTMLElement, label: string, store: DisposableStore, onClick: (anchor: HTMLElement) => void, className = ''): HTMLButtonElement {
	const element = button(parent, `volt-auto-chip-button${className}`, label, store, () => onClick(element));
	element.appendChild(renderIcon(Codicon.chevronDown));
	return element;
}

/** An interval as the number on its chip and the unit after it: 5 minutes, 2 hours. */
function intervalParts(everyMs: number): { readonly value: number; readonly hours: boolean } {
	const minutes = Math.max(1, Math.round(everyMs / 60_000));
	return minutes >= 60 && minutes % 60 === 0 ? { value: minutes / 60, hours: true } : { value: minutes, hours: false };
}

/**
 * One schedule trigger in the editor's Triggers card: the schedule as a sentence with a chip per
 * part ("Every [5] minutes", "Weekdays at [09:00]", "Once on [Nov 4] at [9:00]", a cron field
 * with presets), its time zone, and when it runs next. Returns the row for the caller's own
 * buttons (Remove).
 */
export function renderScheduleRow(card: HTMLElement, trigger: IAutomationTrigger, now: number, context: IScheduleRowContext): HTMLElement {
	const store = context.store;
	const row = append(card, $('.volt-auto-list-row.schedule'));
	append(row, $('span.icon')).appendChild(clockIcon());
	const line = append(row, $('span.schedule-line'));
	const spec = trigger.schedule!;
	const zone = trigger.timezone;
	const set = (schedule: AutomationSchedule) => context.update({ schedule, event: scheduleKindOf(schedule) }, true);
	const word = (text: string, muted = false) => append(line, $(muted ? 'span.word.muted' : 'span.word')).textContent = text;
	const at = localize('voltAutomations.at', "at");
	let current: AutomationSchedule = spec;
	const sync = () => syncNext(row, { ...trigger, schedule: current }, Date.now(), context);

	switch (spec.type) {
		case 'interval': {
			const { value, hours } = intervalParts(spec.everyMs);
			word(localize('voltAutomations.every', "Every"));
			chip(line, String(value), store, anchor => showIntervalMenu(context.contextView, anchor, spec.everyMs, everyMs => set({ type: 'interval', everyMs })));
			word(hours
				? (value === 1 ? localize('voltAutomations.hourUnit', "hour") : localize('voltAutomations.hoursUnit', "hours"))
				: (value === 1 ? localize('voltAutomations.minuteUnit', "minute") : localize('voltAutomations.minutesUnit', "minutes")));
			break;
		}
		case 'hourly':
			word(localize('voltAutomations.everyHour', "Every hour"));
			word(at, true);
			chip(line, `:${String(spec.minute).padStart(2, '0')}`, store, anchor => showMinuteMenu(context.contextView, anchor, spec.minute, minute => set({ type: 'hourly', minute })));
			break;
		case 'daily':
			word(localize('voltAutomations.everyDay', "Every day"));
			word(at, true);
			chip(line, spec.time, store, anchor => showTimeMenu(context.contextView, anchor, parseTimeOfDay(spec.time) ?? 540, minutes => set({ type: 'daily', time: formatTimeOfDay(minutes) })));
			break;
		case 'weekly': {
			word(localize('voltAutomations.every', "Every"));
			const days = [...spec.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
			const dayLabel = days.length === 1 ? weekdayName(days[0]) : days.map(day => weekdayName(day, true)).join(', ');
			let picked = [...spec.weekdays];
			chip(line, dayLabel, store, anchor => showWeekdayMenu(context.contextView, anchor, () => picked, day => {
				picked = picked.includes(day) ? (picked.length > 1 ? picked.filter(entry => entry !== day) : picked) : [...picked, day].sort((a, b) => a - b);
				context.update({ schedule: { type: 'weekly', weekdays: picked, time: spec.time } }, false);
			}, () => context.rerender()));
			word(at, true);
			chip(line, spec.time, store, anchor => showTimeMenu(context.contextView, anchor, parseTimeOfDay(spec.time) ?? 540, minutes => set({ type: 'weekly', weekdays: spec.weekdays, time: formatTimeOfDay(minutes) })));
			break;
		}
		case 'once': {
			renderOnce(line, spec, zone, now, context, word, at, schedule => {
				current = schedule;
				sync();
			});
			break;
		}
		case 'cron': {
			word(localize('voltAutomations.cron', "Cron"));
			const input = append(line, $('input.volt-auto-cron')) as HTMLInputElement;
			input.value = spec.expr;
			input.spellcheck = false;
			input.placeholder = '0 9 * * 1-5';
			input.setAttribute('aria-label', localize('voltAutomations.cronAria', "Cron expression"));
			setAgentTooltip(input, localize('voltAutomations.cronHelp', "minute hour day-of-month month day-of-week, in the trigger's time zone. Examples: */5 * * * *, 0 9 * * 1-5, @daily"));
			const apply = () => {
				current = { type: 'cron', expr: input.value.trim() };
				context.update({ schedule: current }, false);
				sync();
			};
			const debounced = store.add(new RunOnceScheduler(apply, 150));
			store.add(addDisposableListener(input, 'input', () => debounced.schedule()));
			chip(line, localize('voltAutomations.presets', "Presets"), store, anchor => showCronPresetMenu(context.contextView, anchor, input.value, expression => {
				input.value = expression;
				debounced.cancel();
				apply();
			}), '.presets');
			break;
		}
	}
	// An interval runs at the same moments whatever the zone.
	if (spec.type !== 'interval') {
		const zoneButton = chip(line, zoneChipLabel(zone, now), store, anchor => showTimeZoneMenu(context.contextView, anchor, zone, Date.now(), picked => {
			if (picked === zone || (isLocalTimeZone(picked) && isLocalTimeZone(zone))) {
				return;
			}
			// A one-time run keeps its wall time ("09:00") in the new zone.
			const schedule = current.type === 'once' ? onceInZone(current.at, zone, picked) : current;
			context.update({ timezone: picked, schedule }, true);
		}), '.tz');
		setAgentTooltip(zoneButton, localize('voltAutomations.zoneHelp', "The time zone this schedule's times are in"));
	}
	append(line, $('span.next'));
	syncNext(row, trigger, now, context);
	return row;
}

function onceInZone(at: number, from: string | undefined, to: string | undefined): AutomationSchedule {
	const parts = wallClock(from).parts(at);
	return { type: 'once', at: wallClock(to).epoch(parts.year, parts.month, parts.day, parts.hour, parts.minute) };
}

/** "Once on [Nov 4, 2026] at [9:00 AM]": the date and time fields, read in the trigger's zone. */
function renderOnce(line: HTMLElement, spec: Extract<AutomationSchedule, { type: 'once' }>, zone: string | undefined, now: number, context: IScheduleRowContext, word: (text: string, muted?: boolean) => void, at: string, onChange: (schedule: AutomationSchedule) => void): void {
	const clock = wallClock(zone);
	const parts = clock.parts(Number.isFinite(spec.at) ? spec.at : now);
	word(localize('voltAutomations.onceOn', "Once on"));
	const dateHost = append(line, $('span.volt-auto-once-field.date'));
	const dateField = context.store.add(new VoltDateField(dateHost, {
		value: new Date(parts.year, parts.month - 1, parts.day).getTime(),
		min: startOfDay(now),
		ariaLabel: localize('voltAutomations.onceDate', "Date"),
	}));
	word(at, true);
	const timeHost = append(line, $('span.volt-auto-once-field.time'));
	const timeField = context.store.add(new VoltTimeField(timeHost, {
		value: parts.hour * 60 + parts.minute,
		step: 15,
		ariaLabel: localize('voltAutomations.onceTime', "Time"),
	}));
	const today = () => startOfDay(dateField.value) === startOfDay(Date.now());
	const syncMin = () => {
		const local = new Date();
		timeField.setMin(today() ? local.getHours() * 60 + local.getMinutes() + 1 : undefined);
	};
	syncMin();
	const apply = () => {
		syncMin();
		const day = new Date(dateField.value);
		const minutes = timeField.value;
		const schedule: AutomationSchedule = { type: 'once', at: clock.epoch(day.getFullYear(), day.getMonth() + 1, day.getDate(), Math.floor(minutes / 60), minutes % 60) };
		context.update({ schedule }, false);
		onChange(schedule);
	};
	context.store.add(dateField.onDidChange(apply));
	context.store.add(timeField.onDidChange(apply));
}

/** "Tue 09:00", "10:05" today, "Nov 20, 09:00" past a week. */
function formatPreview(at: number, now: number): string {
	if (startOfDay(at) === startOfDay(now)) {
		return dateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
	}
	return at - now < 6 * 86_400_000
		? dateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
		: dateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

/** The row's last part: when it runs next (the plan, while the saved schedule is unchanged), or what is wrong with it. */
function syncNext(row: HTMLElement, trigger: IAutomationTrigger, now: number, context: IScheduleRowContext): void {
	const next = row.querySelector<HTMLElement>('.next');
	const spec = trigger.schedule!;
	const saved = context.saved();
	const before = saved?.triggers.find(entry => entry.id === trigger.id);
	const unchanged = !!before && JSON.stringify(before.schedule) === JSON.stringify(spec) && before.timezone === trigger.timezone;
	const error = scheduleSaveError(trigger, saved?.triggers, now);
	row.classList.toggle('invalid', !!error);
	if (!next) {
		return;
	}
	next.classList.toggle('preview', spec.type === 'cron');
	if (error) {
		next.textContent = error;
		setAgentTooltip(next, '');
		return;
	}
	const planned = unchanged && context.enabled() ? saved?.nextRuns[trigger.id] : undefined;
	if (spec.type === 'once' && planned === undefined && spec.at <= now) {
		next.textContent = localize('voltAutomations.oncePassed', "Its time has passed; it does not run again.");
		setAgentTooltip(next, '');
		return;
	}
	if (spec.type === 'cron') {
		const runs = nextRunsPreview(spec, now, 3, trigger.timezone);
		const description = describeCron(spec.expr);
		const parts = [description.startsWith('Cron ') ? undefined : description, runs.length ? localize('voltAutomations.nextPreview', "Next: {0}", runs.map(run => formatPreview(run, now)).join(', ')) : localize('voltAutomations.neverRuns', "Never runs")];
		next.textContent = parts.filter(Boolean).join(' · ');
		setAgentTooltip(next, runs.length ? `${formatNextRun(runs[0])} ${gmtOffsetLabel(runs[0])}` : '');
		return;
	}
	const at = planned ?? nextScheduleAt(spec, now, trigger.timezone);
	next.textContent = at !== undefined ? localize('voltAutomations.nextRun', "Next run {0} {1}", formatNextRun(at), gmtOffsetLabel(at)) : '';
	setAgentTooltip(next, at !== undefined ? formatScheduleWhen(at, now) : '');
}
