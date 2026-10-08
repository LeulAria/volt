/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentSnooze.css';
import '../media/agentSchedules.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { AgentScheduleSpec, AgentScheduleTarget, describeSchedule, formatTimeOfDay, IAgentSchedule, IAgentScheduleInput, MIN_SCHEDULE_INTERVAL_MS, nextScheduleRun, parseTimeOfDay } from '../../../../services/voltRuntime/common/schedules/agentSchedules.js';
import { AgentScheduleTriggerKind, formatWebhookFilter, IAgentWebhookFilter, IAgentWebhookSignature, IAgentWebhookTrigger, newWebhookTrigger, parseWebhookFilter, WebhookSignatureKind } from '../../../../services/voltRuntime/common/schedules/agentWebhooks.js';
import { IVoltRelayService, IVoltRelayState } from '../../../../../platform/voltRelay/common/voltRelay.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { formatScheduleWhen } from './agentScheduleFormat.js';
import { VoltSelectField, VoltTimeField } from '../ui/dateTime/voltDateTimeFields.js';
import { localeWeekStart, weekdayLabels } from '../ui/dateTime/voltDateTime.js';
import { createVoltSegmented } from '../ui/segmented/voltSegmented.js';

type RepeatMode = 'interval' | 'time';
type IntervalUnit = 'minutes' | 'hours' | 'days';
type TargetMode = 'thread' | 'new';

const WEBHOOK_ONLY_SCHEDULE: AgentScheduleSpec = { type: 'interval', everyMs: 3_600_000 };

const UNIT_MS: Record<IntervalUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

export interface IAgentScheduleDialogOptions {
	/** Editing this task; otherwise a new one. */
	readonly task?: IAgentSchedule;
	/** The chat the dialog was opened from: offers "This chat" as the target. */
	readonly threadId?: string;
	readonly threadTitle?: string;
	/** The project a new chat would start in, for the label. */
	readonly projectLabel?: string;
	readonly projectRoot?: string;
	readonly prompt?: string;
	readonly mode?: string;
	readonly modelRef?: string;
	/** Shows the webhook URL from the relay; Connect asks for a relay link when it is offline. */
	readonly relay?: IVoltRelayService;
	readonly connectRelay?: () => Promise<unknown>;
	readonly onSave: (input: IAgentScheduleInput) => void | Promise<void>;
}

/** The dialog on screen; opening another replaces it. */
let openDialog: IDisposable | undefined;

/**
 * New / Edit scheduled task: the prompt, how often it runs (an interval, or a time of day on
 * chosen weekdays) and where (this chat, or a new chat each run). The line above the buttons says
 * when it runs next. Same chrome as the Custom snooze dialog.
 */
export function showAgentScheduleDialog(host: HTMLElement, options: IAgentScheduleDialogOptions): IDisposable {
	openDialog?.dispose();
	const store = new DisposableStore();
	openDialog = store;
	store.add(toDisposable(() => {
		if (openDialog === store) {
			openDialog = undefined;
		}
	}));
	const window = getWindow(host);
	const previousFocus = window.document.activeElement as HTMLElement | null;
	const close = () => store.dispose();
	const task = options.task;

	const layer = append(host, $('.volt-agent-snooze-layer'));
	store.add(toDisposable(() => {
		layer.remove();
		previousFocus?.focus?.();
	}));
	const backdrop = append(layer, $('.volt-agent-snooze-backdrop'));
	const dialog = append(layer, $('.volt-agent-snooze-dialog.volt-schedule-dialog'));
	dialog.setAttribute('role', 'dialog');
	dialog.setAttribute('aria-modal', 'true');
	dialog.tabIndex = -1;

	const body = append(dialog, $('.volt-agent-snooze-body'));
	const title = append(body, $('h2.volt-agent-snooze-title'));
	title.id = 'volt-schedule-title';
	title.textContent = task ? localize('voltSchedules.edit', "Edit scheduled task") : localize('voltSchedules.new', "New scheduled task");
	dialog.setAttribute('aria-labelledby', title.id);
	append(body, $('p.volt-agent-snooze-subtitle')).textContent = localize('voltSchedules.subtitle', "Volt runs the prompt on the schedule, or for each matching webhook delivery. A busy chat runs it when its current turn ends.");

	const closeButton = append(dialog, $('button.volt-agent-snooze-close')) as HTMLButtonElement;
	closeButton.type = 'button';
	closeButton.setAttribute('aria-label', localize('voltSchedules.close', "Close"));
	closeButton.appendChild(renderIcon(Codicon.close));

	const nameInput = append(field(body, localize('voltSchedules.name', "Title")), $('input.volt-schedule-input')) as HTMLInputElement;
	nameInput.type = 'text';
	nameInput.placeholder = localize('voltSchedules.namePlaceholder', "Daily CI check");
	nameInput.value = task?.title ?? '';

	const promptInput = append(field(body, localize('voltSchedules.prompt', "Prompt")), $('textarea.volt-schedule-input.volt-schedule-prompt')) as HTMLTextAreaElement;
	promptInput.rows = 4;
	promptInput.placeholder = localize('voltSchedules.promptPlaceholder', "Check the latest CI run on main and fix anything that broke.");
	promptInput.value = task?.prompt ?? options.prompt ?? '';

	// When it starts.
	let trigger: AgentScheduleTriggerKind = task?.trigger ?? 'schedule';
	heading(body, localize('voltSchedules.starts', "Starts"));
	const triggerTabs = createVoltSegmented<AgentScheduleTriggerKind>(append(body, $('.volt-agent-snooze-tabs.volt-schedule-tabs')), [
		{ id: 'schedule', label: localize('voltSchedules.onSchedule', "On a schedule") },
		{ id: 'webhook', label: localize('voltSchedules.onWebhook', "On a webhook") },
		{ id: 'both', label: localize('voltSchedules.onBoth', "Both") },
	], trigger, next => {
		trigger = next;
		sync();
	}, store, 'fill');

	// How often.
	const scheduleBlock = append(body, $('.volt-schedule-block'));
	const spec = task?.schedule;
	let repeat: RepeatMode = spec?.type === 'interval' ? 'interval' : 'time';
	heading(scheduleBlock, localize('voltSchedules.repeat', "Repeat"));
	const repeatTabs = createVoltSegmented<RepeatMode>(append(scheduleBlock, $('.volt-agent-snooze-tabs.volt-schedule-tabs')), [
		{ id: 'time', label: localize('voltSchedules.atTime', "At a time") },
		{ id: 'interval', label: localize('voltSchedules.interval', "Every…") },
	], repeat, next => {
		repeat = next;
		sync();
	}, store, 'fill');

	const timePane = append(scheduleBlock, $('.volt-schedule-pane'));
	const initialMinutes = spec?.type === 'fixed_time' ? parseTimeOfDay(spec.timeOfDay) ?? 540 : 540;
	const timeField = store.add(new VoltTimeField(field(timePane, localize('voltSchedules.time', "Time")), {
		value: initialMinutes,
		step: 15,
		ariaLabel: localize('voltSchedules.time', "Time"),
	}));
	const days = new Set<number>(spec?.type === 'fixed_time' && spec.weekdays?.length ? spec.weekdays : [0, 1, 2, 3, 4, 5, 6]);
	const dayRow = append(field(timePane, localize('voltSchedules.days', "Days")), $('.volt-schedule-days'));
	const weekStart = localeWeekStart();
	const dayButtons: HTMLButtonElement[] = [];
	weekdayLabels(weekStart).forEach((label, index) => {
		const day = (weekStart + index) % 7;
		const button = append(dayRow, $('button.volt-schedule-day')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label.short.slice(0, 2);
		button.title = label.long;
		button.dataset.day = String(day);
		store.add(addDisposableListener(button, 'click', () => {
			if (days.has(day) && days.size > 1) {
				days.delete(day);
			} else {
				days.add(day);
			}
			sync();
		}));
		dayButtons.push(button);
	});

	const intervalPane = append(scheduleBlock, $('.volt-agent-snooze-fields.volt-schedule-pane'));
	const initialInterval = intervalParts(spec?.type === 'interval' ? spec.everyMs : 3_600_000);
	const amountInput = append(field(intervalPane, localize('voltSchedules.every', "Every")), $('input.volt-schedule-input')) as HTMLInputElement;
	amountInput.type = 'text';
	amountInput.inputMode = 'numeric';
	amountInput.value = String(initialInterval.amount);
	const unitField = store.add(new VoltSelectField<IntervalUnit>(field(intervalPane, localize('voltSchedules.unit', "Unit")), {
		options: [
			{ id: 'minutes', label: localize('voltSchedules.minutes', "Minutes") },
			{ id: 'hours', label: localize('voltSchedules.hours', "Hours") },
			{ id: 'days', label: localize('voltSchedules.daysUnit', "Days") },
		],
		value: initialInterval.unit,
		ariaLabel: localize('voltSchedules.unit', "Unit"),
	}));

	// Webhook.
	const webhookBlock = append(body, $('.volt-schedule-block'));
	heading(webhookBlock, localize('voltSchedules.webhook', "Webhook"));
	const hookBase: IAgentWebhookTrigger = task?.webhook ?? newWebhookTrigger(`hook_${generateUuid().replace(/-/g, '')}`, generateUuid().replace(/-/g, ''));
	let relayState: IVoltRelayState = { status: 'off' };
	const urlRow = append(field(webhookBlock, localize('voltSchedules.url', "URL")), $('.volt-schedule-url-row'));
	const urlInput = append(urlRow, $('input.volt-schedule-input')) as HTMLInputElement;
	urlInput.type = 'text';
	urlInput.readOnly = true;
	const copyButton = append(urlRow, $('button.volt-agent-snooze-button')) as HTMLButtonElement;
	copyButton.type = 'button';
	copyButton.textContent = localize('voltSchedules.copy', "Copy");
	const relayNote = append(webhookBlock, $('.volt-schedule-note'));
	const connectButton = append(webhookBlock, $('button.volt-agent-snooze-button')) as HTMLButtonElement;
	connectButton.type = 'button';
	connectButton.textContent = localize('voltSchedules.connectRelay', "Connect to Volt Relay…");

	let signatureKind: WebhookSignatureKind = hookBase.signature.kind;
	createVoltSegmented<WebhookSignatureKind>(append(field(webhookBlock, localize('voltSchedules.signature', "Signature")), $('.volt-agent-snooze-tabs.volt-schedule-tabs')), [
		{ id: 'none', label: localize('voltSchedules.sigNone', "None") },
		{ id: 'github', label: localize('voltSchedules.sigGithub', "GitHub") },
		{ id: 'generic', label: localize('voltSchedules.sigGeneric', "HMAC header") },
	], signatureKind, next => {
		signatureKind = next;
		sync();
	}, store, 'fill');
	const secretField = field(webhookBlock, localize('voltSchedules.secret', "Secret"));
	const secretInput = append(secretField, $('input.volt-schedule-input')) as HTMLInputElement;
	secretInput.type = 'password';
	secretInput.autocomplete = 'off';
	secretInput.placeholder = hookBase.signature.secret
		? localize('voltSchedules.secretSaved', "Saved. Type to replace it.")
		: localize('voltSchedules.secretPlaceholder', "The secret the sender signs with");

	const filtersInput = append(field(webhookBlock, localize('voltSchedules.filters', "Only when")), $('textarea.volt-schedule-input.volt-schedule-prompt')) as HTMLTextAreaElement;
	filtersInput.rows = 3;
	filtersInput.placeholder = 'payload.action = opened';
	filtersInput.value = hookBase.filters.map(formatWebhookFilter).join('\n');
	append(webhookBlock, $('.volt-schedule-note')).textContent = localize('voltSchedules.webhookNote', "Each line must match. Put {{payload.pull_request.title}} in the prompt to insert a field.");

	// Where.
	let target: TargetMode = task ? (task.target.kind === 'thread' ? 'thread' : 'new') : options.threadId ? 'thread' : 'new';
	const threadId = task?.target.kind === 'thread' ? task.target.threadId : options.threadId;
	if (threadId) {
		heading(body, localize('voltSchedules.runsIn', "Runs in"));
		createVoltSegmented<TargetMode>(append(body, $('.volt-agent-snooze-tabs.volt-schedule-tabs')), [
			{ id: 'thread', label: options.threadTitle ? localize('voltSchedules.thisChatNamed', "This chat") : localize('voltSchedules.thisChat', "Its chat") },
			{ id: 'new', label: localize('voltSchedules.newChat', "A new chat each run") },
		], target, next => {
			target = next;
			sync();
		}, store, 'fill');
	} else {
		target = 'new';
	}
	const targetNote = append(body, $('.volt-schedule-note'));

	const preview = append(body, $('.volt-agent-snooze-preview'));
	preview.setAttribute('aria-live', 'polite');

	const footer = append(dialog, $('.volt-agent-snooze-footer'));
	const cancel = append(footer, $('button.volt-agent-snooze-button')) as HTMLButtonElement;
	cancel.type = 'button';
	cancel.textContent = localize('voltSchedules.cancel', "Cancel");
	const confirm = append(footer, $('button.volt-agent-snooze-button.primary')) as HTMLButtonElement;
	confirm.type = 'button';
	confirm.textContent = task ? localize('voltSchedules.save', "Save") : localize('voltSchedules.create', "Schedule");

	const currentSpec = (): AgentScheduleSpec | undefined => {
		if (repeat === 'time') {
			const weekdays = [...days].sort((a, b) => a - b);
			return { type: 'fixed_time', timeOfDay: formatTimeOfDay(timeField.value), ...(weekdays.length < 7 ? { weekdays } : {}) };
		}
		const text = amountInput.value.trim();
		const amount = /^\d+$/.test(text) ? Number(text) : Number.NaN;
		const everyMs = amount * UNIT_MS[unitField.value];
		return Number.isFinite(everyMs) && everyMs >= MIN_SCHEDULE_INTERVAL_MS ? { type: 'interval', everyMs } : undefined;
	};
	const currentTarget = (): AgentScheduleTarget => target === 'thread' && threadId
		? { kind: 'thread', threadId }
		: { kind: 'new', ...(task?.target.kind === 'new' && task.target.projectRoot ? { projectRoot: task.target.projectRoot } : options.projectRoot ? { projectRoot: options.projectRoot } : {}) };

	const parseFilters = (): IAgentWebhookFilter[] | undefined => {
		const parsed = filtersInput.value.split('\n').map(line => line.trim()).filter(Boolean).map(parseWebhookFilter);
		return parsed.every((filter): filter is IAgentWebhookFilter => !!filter) ? parsed : undefined;
	};
	const secretOk = () => signatureKind === 'none' || !!secretInput.value.trim() || !!hookBase.signature.secret;
	const currentWebhook = (): IAgentWebhookTrigger => {
		const typed = secretInput.value.trim();
		const signature: IAgentWebhookSignature = signatureKind === 'none'
			? { kind: 'none' }
			: { ...hookBase.signature, kind: signatureKind, ...(typed ? { secret: typed } : {}) };
		return { ...hookBase, signature, filters: parseFilters() ?? [] };
	};
	const hookUrl = (): string => {
		if (hookBase.relayUrl && (!hookBase.relayId || hookBase.relayId === relayState.relayId)) {
			return hookBase.relayUrl;
		}
		return relayState.localWebhookBase ? `${relayState.localWebhookBase}/h/${hookBase.localToken}` : '';
	};

	const sync = () => {
		scheduleBlock.classList.toggle('hidden', trigger === 'webhook');
		webhookBlock.classList.toggle('hidden', trigger === 'schedule');
		secretField.classList.toggle('hidden', signatureKind === 'none');
		const relayOnline = relayState.status === 'online';
		connectButton.classList.toggle('hidden', relayOnline || !options.connectRelay);
		relayNote.textContent = relayOnline
			? localize('voltSchedules.relayOnline', "Works while Volt is closed: the relay holds deliveries until Volt opens.")
			: localize('voltSchedules.relayOffline', "Connect to Volt Relay for a URL that works while Volt is closed. Until then it answers only while Volt runs.");
		urlInput.value = hookUrl();
		urlInput.placeholder = localize('voltSchedules.urlPlaceholder', "Shown after you save");
		timePane.classList.toggle('hidden', repeat !== 'time');
		intervalPane.classList.toggle('hidden', repeat !== 'interval');
		for (const button of dayButtons) {
			button.classList.toggle('on', days.has(Number(button.dataset.day)));
			button.setAttribute('aria-pressed', String(days.has(Number(button.dataset.day))));
		}
		const next = currentSpec();
		amountInput.classList.toggle('invalid', repeat === 'interval' && !next);
		targetNote.textContent = target === 'thread'
			? localize('voltSchedules.threadNote', "Each run is a new message in {0}.", options.threadTitle ? `"${options.threadTitle}"` : localize('voltSchedules.theChat', "the chat"))
			: localize('voltSchedules.newNote', "Each run starts a new chat in {0}.", options.projectLabel ?? localize('voltSchedules.theProject', "the project"));
		const at = next ? nextScheduleRun(next, Date.now()) : undefined;
		const scheduleOk = trigger === 'webhook' || (!!next && at !== undefined);
		const filtersOk = !!parseFilters();
		const webhookOk = trigger === 'schedule' || (filtersOk && secretOk());
		confirm.disabled = !(scheduleOk && webhookOk && !!promptInput.value.trim());
		preview.classList.toggle('error', !scheduleOk || !webhookOk);
		preview.textContent = !filtersOk
			? localize('voltSchedules.badFilter', "A line under Only when is not a filter, like payload.action = opened.")
			: !secretOk()
				? localize('voltSchedules.needSecret', "Enter the secret the sender signs with, or choose None.")
				: trigger === 'webhook'
					? localize('voltSchedules.webhookOnly', "Runs for each delivery that matches.")
					: next && at !== undefined
						? localize('voltSchedules.preview', "{0} · next run {1}", describeSchedule(next), formatScheduleWhen(at, Date.now()))
						: localize('voltSchedules.badInterval', "Runs at most once a minute: enter a whole number.");
	};
	const submit = async () => {
		const next = currentSpec();
		if ((trigger !== 'webhook' && !next) || !promptInput.value.trim() || !parseFilters() || !secretOk()) {
			sync();
			return;
		}
		close();
		await options.onSave({
			title: nameInput.value.trim(),
			prompt: promptInput.value.trim(),
			trigger,
			schedule: next ?? task?.schedule ?? WEBHOOK_ONLY_SCHEDULE,
			...(trigger !== 'schedule' ? { webhook: currentWebhook() } : {}),
			target: currentTarget(),
			...(task?.mode ?? options.mode ? { mode: task?.mode ?? options.mode } : {}),
			...(task?.modelRef ?? options.modelRef ? { modelRef: task?.modelRef ?? options.modelRef } : {}),
			...(options.threadId ? { sourceThreadId: options.threadId } : {}),
		});
	};

	store.add(timeField.onDidChange(sync));
	store.add(unitField.onDidChange(sync));
	store.add(addDisposableListener(amountInput, 'input', sync));
	store.add(addDisposableListener(promptInput, 'input', sync));
	store.add(addDisposableListener(cancel, 'click', close));
	store.add(addDisposableListener(closeButton, 'click', close));
	store.add(addDisposableListener(backdrop, 'mousedown', close));
	store.add(addDisposableListener(confirm, 'click', () => void submit()));
	store.add(addDisposableListener(copyButton, 'click', () => void navigator.clipboard?.writeText(urlInput.value).catch(() => undefined)));
	store.add(addDisposableListener(connectButton, 'click', () => void options.connectRelay?.()));
	store.add(addDisposableListener(secretInput, 'input', sync));
	store.add(addDisposableListener(filtersInput, 'input', sync));
	if (options.relay) {
		const relay = options.relay;
		void relay.getState().then(state => {
			relayState = state;
			sync();
		});
		store.add(relay.onDidChangeState(state => {
			relayState = state;
			sync();
		}));
	}
	store.add(addDisposableListener(dialog, 'keydown', e => {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close();
		} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			// The prompt takes newlines; Cmd+Enter saves from anywhere in the dialog.
			e.preventDefault();
			void submit();
		} else if (e.key === 'Enter' && (e.target as HTMLElement | null)?.tagName === 'INPUT') {
			e.preventDefault();
			void submit();
		} else if (e.key === 'Tab') {
			const stops = [...dialog.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex]')]
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
	store.add(addDisposableListener(window.document, 'focusin', e => {
		if (e.target instanceof Node && !layer.contains(e.target)) {
			dialog.focus();
		}
	}, true));

	sync();
	window.requestAnimationFrame(() => {
		repeatTabs.sync();
		triggerTabs.sync();
	});
	(task ? nameInput : promptInput.value ? nameInput : promptInput).focus();
	return store;
}

function intervalParts(everyMs: number): { amount: number; unit: IntervalUnit } {
	if (everyMs % UNIT_MS.days === 0) {
		return { amount: everyMs / UNIT_MS.days, unit: 'days' };
	}
	if (everyMs % UNIT_MS.hours === 0) {
		return { amount: everyMs / UNIT_MS.hours, unit: 'hours' };
	}
	return { amount: Math.max(1, Math.round(everyMs / UNIT_MS.minutes)), unit: 'minutes' };
}

function heading(parent: HTMLElement, label: string): void {
	append(parent, $('span.volt-agent-snooze-label.volt-schedule-heading')).textContent = label;
}

/** A labelled column; returns the box the control goes in. */
function field(parent: HTMLElement, label: string): HTMLElement {
	const column = append(parent, $('.volt-agent-snooze-field.volt-schedule-field'));
	append(column, $('span.volt-agent-snooze-label')).textContent = label;
	return column;
}
