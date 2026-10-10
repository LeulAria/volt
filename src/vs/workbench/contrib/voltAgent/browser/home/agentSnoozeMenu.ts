/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentSnooze.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';
import { addDays, dateTimeFormat, formatTimeLabel, minutesOfDay, roundUpToStep, sameDay, startOfDay } from '../ui/dateTime/voltDateTime.js';
import { VoltDateField, VoltSelectField, VoltTimeField } from '../ui/dateTime/voltDateTimeFields.js';
import { createVoltSegmented } from '../ui/segmented/voltSegmented.js';
import { AGENT_SNOOZE_UNITS, agentSnoozeAfter, agentSnoozeAt, agentSnoozePresets, AgentSnoozeUnit } from './agentHomeModel.js';

type SnoozePick = { readonly kind: 'at'; readonly until: number } | { readonly kind: 'custom' };

/**
 * The clock on an agent tab: In 1 hour, In 3 hours, This evening, Tomorrow, each with the time it
 * comes back, then Custom… which opens {@link showCustomSnoozeDialog} over `dialogHost`.
 */
export function showAgentSnoozeMenu(
	contextViewService: IContextViewService,
	anchor: HTMLElement,
	dialogHost: HTMLElement,
	snooze: (until: number) => void,
): void {
	const now = Date.now();
	const presets: IVoltMenuItem<SnoozePick>[] = agentSnoozePresets(now).map(preset => ({
		id: preset.id,
		label: preset.label,
		keybinding: formatSnoozeTime(preset.until),
		data: { kind: 'at', until: preset.until },
	}));
	showVoltMenu<SnoozePick>(contextViewService, {
		anchor,
		align: 'right',
		gap: 4,
		width: 230,
		className: 'volt-agent-snooze-menu',
		ariaLabel: localize('voltAgent.snooze.menu', "Snooze until"),
		sections: [
			{ id: 'presets', items: presets },
			{ id: 'custom', items: [{ id: 'custom', label: localize('voltAgent.snooze.custom', "Custom…"), data: { kind: 'custom' } }] },
		],
		onPick: item => {
			if (item.data.kind === 'at') {
				snooze(item.data.until);
			} else {
				showCustomSnoozeDialog(dialogHost, snooze);
			}
		},
	});
}

function formatSnoozeTime(at: number): string {
	return formatTimeLabel(minutesOfDay(at));
}

function unitLabel(unit: AgentSnoozeUnit): string {
	switch (unit) {
		case 'minutes': return localize('voltAgent.snooze.minutes', "Minutes");
		case 'hours': return localize('voltAgent.snooze.hours', "Hours");
		case 'days': return localize('voltAgent.snooze.days', "Days");
		case 'weeks': return localize('voltAgent.snooze.weeks', "Weeks");
		default: {
			const unexpected: never = unit;
			return unexpected;
		}
	}
}

const SNOOZE_STEP_MINUTES = 15;
const MAX_SNOOZE_AMOUNT = 999;

/** The Custom snooze dialog on screen; opening another replaces it rather than stacking a second. */
let openCustomSnooze: IDisposable | undefined;

/**
 * Custom snooze: a date and a time, or a duration (2 Hours). The line above the buttons says when
 * the thread comes back, or why it cannot; Snooze stays disabled until the pick lies in the future.
 * Escape, Cancel, the close button and a click outside dismiss it.
 */
export function showCustomSnoozeDialog(host: HTMLElement, snooze: (until: number) => void): IDisposable {
	openCustomSnooze?.dispose();
	const store = new DisposableStore();
	openCustomSnooze = store;
	store.add(toDisposable(() => {
		if (openCustomSnooze === store) {
			openCustomSnooze = undefined;
		}
	}));
	const window = getWindow(host);
	const previousFocus = window.document.activeElement as HTMLElement | null;
	const close = () => store.dispose();

	const layer = append(host, $('.volt-agent-snooze-layer'));
	store.add(toDisposable(() => {
		layer.remove();
		previousFocus?.focus?.();
	}));
	const backdrop = append(layer, $('.volt-agent-snooze-backdrop'));
	const dialog = append(layer, $('.volt-agent-snooze-dialog'));
	dialog.setAttribute('role', 'dialog');
	dialog.setAttribute('aria-modal', 'true');
	dialog.tabIndex = -1;

	const body = append(dialog, $('.volt-agent-snooze-body'));
	const title = append(body, $('h2.volt-agent-snooze-title'));
	title.id = 'volt-agent-snooze-title';
	title.textContent = localize('voltAgent.snooze.customTitle', "Custom snooze");
	dialog.setAttribute('aria-labelledby', title.id);
	append(body, $('p.volt-agent-snooze-subtitle')).textContent = localize('voltAgent.snooze.customSubtitle', "Choose when snoozed threads return to your inbox.");

	const closeButton = append(dialog, $('button.volt-agent-snooze-close')) as HTMLButtonElement;
	closeButton.type = 'button';
	closeButton.setAttribute('aria-label', localize('voltAgent.snooze.close', "Close"));
	closeButton.appendChild(renderIcon(Codicon.close));

	type Mode = 'at' | 'for';
	let mode: Mode = 'at';
	const tabs = createVoltSegmented<Mode>(append(body, $('.volt-agent-snooze-tabs')), [
		{ id: 'at', label: localize('voltAgent.snooze.dateAndTime', "Date and time") },
		{ id: 'for', label: localize('voltAgent.snooze.duration', "Duration") },
	], mode, next => {
		mode = next;
		sync();
	}, store, 'fill');

	// Date and time: the next quarter hour an hour from now, like the first quick pick.
	const opened = Date.now();
	const start = roundUpToStep(opened + 3_600_000, SNOOZE_STEP_MINUTES);
	const atPane = append(body, $('.volt-agent-snooze-fields'));
	const dateField = store.add(new VoltDateField(field(atPane, localize('voltAgent.snooze.date', "Date")), {
		value: start,
		min: opened,
		ariaLabel: localize('voltAgent.snooze.date', "Date"),
	}));
	const timeField = store.add(new VoltTimeField(field(atPane, localize('voltAgent.snooze.time', "Time")), {
		value: minutesOfDay(start),
		step: SNOOZE_STEP_MINUTES,
		ariaLabel: localize('voltAgent.snooze.time', "Time"),
	}));

	// Duration: 2 Hours, with - and + around the amount.
	const forPane = append(body, $('.volt-agent-snooze-fields'));
	const stepper = append(field(forPane, localize('voltAgent.snooze.for', "Snooze for")), $('.volt-agent-snooze-stepper'));
	const minus = append(stepper, $('button.volt-agent-snooze-step')) as HTMLButtonElement;
	minus.type = 'button';
	minus.setAttribute('aria-label', localize('voltAgent.snooze.less', "Less"));
	minus.appendChild(renderIcon(Codicon.dash));
	const amountInput = append(stepper, $('input.volt-agent-snooze-amount')) as HTMLInputElement;
	amountInput.type = 'text';
	amountInput.inputMode = 'numeric';
	amountInput.value = '2';
	amountInput.setAttribute('role', 'spinbutton');
	amountInput.setAttribute('aria-label', localize('voltAgent.snooze.amount', "Amount"));
	amountInput.setAttribute('aria-valuemin', '1');
	amountInput.setAttribute('aria-valuemax', String(MAX_SNOOZE_AMOUNT));
	const plus = append(stepper, $('button.volt-agent-snooze-step')) as HTMLButtonElement;
	plus.type = 'button';
	plus.setAttribute('aria-label', localize('voltAgent.snooze.more', "More"));
	plus.appendChild(renderIcon(Codicon.add));
	const unitField = store.add(new VoltSelectField<AgentSnoozeUnit>(field(forPane, localize('voltAgent.snooze.unit', "Unit")), {
		options: AGENT_SNOOZE_UNITS.map(unit => ({ id: unit, label: unitLabel(unit) })),
		value: 'hours',
		ariaLabel: localize('voltAgent.snooze.unit', "Unit"),
	}));

	const preview = append(body, $('.volt-agent-snooze-preview'));
	preview.setAttribute('aria-live', 'polite');

	const footer = append(dialog, $('.volt-agent-snooze-footer'));
	const cancel = append(footer, $('button.volt-agent-snooze-button')) as HTMLButtonElement;
	cancel.type = 'button';
	cancel.textContent = localize('voltAgent.snooze.cancel', "Cancel");
	const confirm = append(footer, $('button.volt-agent-snooze-button.primary')) as HTMLButtonElement;
	confirm.type = 'button';
	confirm.textContent = localize('voltAgent.snooze.confirm', "Snooze");

	/** The amount as typed: a whole number from 1 to the maximum, else undefined. */
	const amount = (): number | undefined => {
		const text = amountInput.value.trim();
		const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
		return value >= 1 && value <= MAX_SNOOZE_AMOUNT ? value : undefined;
	};
	const until = (now = Date.now()): number | undefined => {
		if (mode === 'at') {
			return agentSnoozeAt(now, dateField.value, timeField.value);
		}
		const value = amount();
		return value === undefined ? undefined : agentSnoozeAfter(now, value, unitField.value);
	};
	const sync = () => {
		const now = Date.now();
		atPane.classList.toggle('hidden', mode !== 'at');
		forPane.classList.toggle('hidden', mode !== 'for');
		// On today, the times already past are listed but cannot be picked.
		timeField.setMin(sameDay(dateField.value, now) ? minutesOfDay(now) + 1 : undefined);
		const value = amount();
		minus.disabled = value === undefined || value <= 1;
		plus.disabled = value !== undefined && value >= MAX_SNOOZE_AMOUNT;
		amountInput.setAttribute('aria-valuenow', String(value ?? ''));
		amountInput.classList.toggle('invalid', value === undefined);
		const at = until(now);
		confirm.disabled = at === undefined;
		preview.classList.toggle('error', at === undefined);
		preview.textContent = at !== undefined
			? localize('voltAgent.snooze.returns', "Returns {0}", formatReturn(at, now))
			: mode === 'at'
				? localize('voltAgent.snooze.past', "That time has already passed")
				: localize('voltAgent.snooze.badAmount', "Enter a whole number from 1 to {0}", MAX_SNOOZE_AMOUNT);
	};
	const submit = () => {
		const at = until();
		if (at === undefined) {
			sync();
			return;
		}
		close();
		snooze(at);
	};
	const step = (delta: number) => {
		const current = amount() ?? 1;
		amountInput.value = String(Math.max(1, Math.min(MAX_SNOOZE_AMOUNT, current + delta)));
		sync();
	};

	store.add(dateField.onDidChange(sync));
	store.add(timeField.onDidChange(sync));
	store.add(unitField.onDidChange(sync));
	store.add(addDisposableListener(minus, 'click', () => step(-1)));
	store.add(addDisposableListener(plus, 'click', () => step(1)));
	store.add(addDisposableListener(amountInput, 'input', sync));
	store.add(addDisposableListener(amountInput, 'keydown', e => {
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			step(e.key === 'ArrowUp' ? 1 : -1);
		}
	}));
	store.add(addDisposableListener(cancel, 'click', close));
	store.add(addDisposableListener(closeButton, 'click', close));
	store.add(addDisposableListener(backdrop, 'mousedown', close));
	store.add(addDisposableListener(confirm, 'click', submit));
	store.add(addDisposableListener(dialog, 'keydown', e => {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close();
		} else if (e.key === 'Enter' && (e.target as HTMLElement | null)?.tagName !== 'BUTTON') {
			e.preventDefault();
			submit();
		} else if (e.key === 'Tab') {
			// Modal: Tab and Shift+Tab go round the dialog, never out to the window behind it.
			const stops = [...dialog.querySelectorAll<HTMLElement>('button, input, [tabindex]')]
				.filter(element => element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled && element.getClientRects().length > 0);
			const index = stops.indexOf(e.target as HTMLElement);
			const next = e.shiftKey
				? (index <= 0 ? stops.at(-1) : undefined)
				: (index === -1 || index === stops.length - 1 ? stops[0] : undefined);
			if (next) {
				e.preventDefault();
				next.focus();
			}
		}
	}));
	// Focus that lands behind the dialog (a click on the page, a stray Tab from the body) comes back.
	store.add(addDisposableListener(window.document, 'focusin', e => {
		if (e.target instanceof Node && !layer.contains(e.target)) {
			dialog.focus();
		}
	}, true));
	// "Returns in 5 minutes" turns into "passed" if the dialog sits open; keep the line honest.
	const tick = window.setInterval(sync, 15_000);
	store.add(toDisposable(() => window.clearInterval(tick)));

	sync();
	// The thumb measures its pill, which needs the dialog laid out.
	window.requestAnimationFrame(() => tabs.sync());
	dialog.focus();
	return store;
}

/** "today at 11:30 AM", "tomorrow at 9:00 AM", "Tue, Oct 6 at 11:30 AM". */
function formatReturn(at: number, now: number): string {
	const time = formatTimeLabel(minutesOfDay(at));
	const day = startOfDay(at);
	const today = startOfDay(now);
	if (day === today) {
		return localize('voltAgent.snooze.returnsToday', "today at {0}", time);
	}
	if (day === addDays(today, 1)) {
		return localize('voltAgent.snooze.returnsTomorrow', "tomorrow at {0}", time);
	}
	const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
	const date = dateTimeFormat(undefined, sameYear
		? { weekday: 'short', month: 'short', day: 'numeric' }
		: { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(at);
	return localize('voltAgent.snooze.returnsOn', "{0} at {1}", date, time);
}

/** A labelled column; returns the box the control goes in. */
function field(parent: HTMLElement, label: string): HTMLElement {
	const column = append(parent, $('.volt-agent-snooze-field'));
	append(column, $('span.volt-agent-snooze-label')).textContent = label;
	return column;
}
