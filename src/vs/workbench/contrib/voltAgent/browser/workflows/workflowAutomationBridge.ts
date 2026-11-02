/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isCancellationError } from '../../../../../base/common/errors.js';
import { hash } from '../../../../../base/common/hash.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { DurableClaims } from '../../../../services/voltRuntime/browser/jobs/durableClaims.js';
import {
	AutomationSchedule, IAutomation, IAutomationService, IAutomationTrigger, IAutomationWorkflowRequest, IAutomationWorkflowResult, IAutomationWorkflowRun, MIN_INTERVAL_MS,
} from '../../../../services/voltRuntime/common/automations/automations.js';
import { AUTOMATION_PROVIDERS, AutomationProvider } from '../../../../services/voltRuntime/common/automations/automationTriggers.js';
import { IAgentWebhookFilter, newWebhookTrigger, parseWebhookFilter } from '../../../../services/voltRuntime/common/automations/automationWebhooks.js';
import { IWorkflowDefinition, IWorkflowExecution, IWorkflowService, IWorkflowTrigger, WorkflowValue } from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import type { IWorkflowStoreChange, IWorkflowStoreEvents } from './workflowService.js';

/**
 * Workflows and automations share one scheduler and one webhook path. A workflow whose trigger is
 * a schedule or an event is carried out by a linked automation (`templateId: workflow:<id>`) that
 * this bridge keeps in step with the workflow's trigger; an automation with a `workflowId` runs
 * the workflow through the runner registered here. Neither service depends on the other.
 */

export const WORKFLOW_TEMPLATE_PREFIX = 'workflow:';

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function shortId(prefix: string): string {
	return `${prefix}-${generateUuid().replace(/-/g, '').slice(0, 10)}`;
}

function linkTemplate(workflowId: string): string {
	return `${WORKFLOW_TEMPLATE_PREFIX}${workflowId}`;
}

/** The automation that carries out the workflow's schedule or event trigger, if it has one. */
export function linkedAutomation(automations: IAutomationService, workflowId: string): IAutomation | undefined {
	return automations.list().find(automation => automation.templateId === linkTemplate(workflowId) && automation.workflowId === workflowId);
}

/**
 * The automation triggers a workflow trigger stands for: undefined for a manual one (no link),
 * none yet for a schedule or event still being filled in. Kept from `previous`: trigger ids, and
 * the hook (its URL, token and signing secret) of the same provider, so senders keep working.
 */
export function automationTriggersFor(trigger: IWorkflowTrigger, previous: readonly IAutomationTrigger[]): IAutomationTrigger[] | undefined {
	if (trigger.type === 'schedule') {
		const cron = trigger.cron?.trim();
		const minutes = trigger.everyMinutes;
		const schedule: AutomationSchedule | undefined = cron
			? { type: 'cron', expr: cron }
			: minutes && minutes > 0 ? { type: 'interval', everyMs: Math.max(MIN_INTERVAL_MS, Math.round(minutes * 60_000)) } : undefined;
		if (!schedule) {
			return [];
		}
		const before = previous.find(entry => entry.provider === 'schedule');
		return [{
			id: before?.id ?? shortId('tr'),
			provider: 'schedule',
			event: schedule.type === 'interval' ? 'hourly' : 'cron',
			schedule,
			...(trigger.timezone?.trim() ? { timezone: trigger.timezone.trim() } : {}),
		}];
	}
	if (trigger.type === 'event') {
		const provider = trigger.provider as AutomationProvider | undefined;
		const event = trigger.event?.trim();
		if (!provider || provider === 'schedule' || !AUTOMATION_PROVIDERS.includes(provider) || !event) {
			return [];
		}
		const before = previous.find(entry => entry.provider === provider && entry.event === event && entry.hook) ?? previous.find(entry => entry.provider === provider && entry.hook);
		const filters = (trigger.filters ?? []).map(line => parseWebhookFilter(line)).filter((filter): filter is IAgentWebhookFilter => !!filter);
		const hook = before?.hook ?? newWebhookTrigger(`hook_${generateUuid().replace(/-/g, '')}`, generateUuid().replace(/-/g, ''));
		return [{
			id: before?.id ?? shortId('tr'),
			provider,
			event,
			hook: { ...hook, filters },
			...(trigger.option?.trim() ? { option: trigger.option.trim() } : {}),
		}];
	}
	return undefined;
}

/**
 * Brings the workflow's linked automation in step with its trigger: made (inactive) for a schedule
 * or event, updated when the trigger or the name changed, deleted for a manual trigger. The
 * automation's own on/off stays as the user set it. Duplicates (two windows raced) are dropped.
 */
export async function linkWorkflow(automations: IAutomationService, definition: IWorkflowDefinition): Promise<IAutomation | undefined> {
	await automations.whenReady;
	const [existing, ...extra] = automations.list().filter(automation => automation.templateId === linkTemplate(definition.id));
	for (const duplicate of extra) {
		await automations.delete(duplicate.id);
	}
	const triggers = automationTriggersFor(definition.trigger, existing?.triggers ?? []);
	if (!triggers) {
		if (existing) {
			await automations.delete(existing.id);
		}
		return undefined;
	}
	if (!existing) {
		return automations.create({
			name: definition.name,
			instructions: '',
			enabled: false,
			triggers,
			tools: [],
			templateId: linkTemplate(definition.id),
			workflowId: definition.id,
		});
	}
	if (existing.name === definition.name && existing.workflowId === definition.id && JSON.stringify(existing.triggers) === JSON.stringify(triggers)) {
		return existing;
	}
	return automations.update(existing.id, { name: definition.name, triggers, workflowId: definition.id });
}

/** Turns a schedule or event workflow on or off (its linked automation, made when missing). */
export async function setWorkflowActive(automations: IAutomationService, workflows: IWorkflowService, workflowId: string, on: boolean): Promise<IAutomation | undefined> {
	await workflows.whenReady;
	const definition = workflows.get(workflowId);
	if (!definition) {
		return undefined;
	}
	const automation = linkedAutomation(automations, workflowId) ?? (on ? await linkWorkflow(automations, definition) : undefined);
	if (!automation) {
		return undefined;
	}
	if (automation.enabled !== on) {
		await automations.setEnabled(automation.id, on);
	}
	return automations.get(automation.id);
}

/** What `{{ trigger.payload }}` reads in a run an automation started. */
function automationPayload(request: IAutomationWorkflowRequest): WorkflowValue {
	let body: WorkflowValue = request.payload ?? null;
	if (request.payload) {
		try {
			body = JSON.parse(request.payload) as WorkflowValue;
		} catch {
			// An excerpt, not JSON: kept as text.
		}
	}
	return {
		provider: request.run.provider,
		event: request.run.event ?? null,
		label: request.run.label,
		at: request.run.at,
		lines: [...(request.eventLines ?? [])],
		body,
	};
}

export class WorkflowAutomationBridge extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltWorkflowAutomations';

	private readonly claims: DurableClaims;
	/** Link changes run one after another: a save, then its delete, never overlap. */
	private linking: Promise<unknown> = Promise.resolve();

	constructor(
		@IAutomationService private readonly automations: IAutomationService,
		@IWorkflowService private readonly workflows: IWorkflowService,
		@IFileService fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.claims = new DurableClaims(joinPath(environmentService.userRoamingDataHome, 'voltJobs', 'claims'), fileService, logService);
		const registration = automations.registerWorkflowRunner?.({ run: request => this.run(request) });
		if (registration) {
			this._register(registration);
		}
		// Listening does not create the workflow service: it starts when Workflows are first used.
		this._register((workflows as IWorkflowService & IWorkflowStoreEvents).onDidSaveWorkflow(change => {
			this.linking = this.linking.then(() => this.relink(change)).catch(err => this.logService.warn(`[volt workflows] could not update the automation of ${change.id}`, err));
		}));
	}

	/** Every window sees a workflow file change; the first to claim it updates the link. */
	private async relink(change: IWorkflowStoreChange): Promise<void> {
		await this.automations.whenReady;
		const linked = this.automations.list().filter(automation => automation.templateId === linkTemplate(change.id));
		if (!change.definition) {
			if (!linked.length || !await this.claims.claim(`wflink:${change.id}:deleted:${linked.map(automation => automation.id).join(',')}`)) {
				return;
			}
			for (const automation of linked) {
				await this.automations.delete(automation.id);
			}
			return;
		}
		const definition = change.definition;
		if (definition.trigger.type === 'manual' && !linked.length) {
			return;
		}
		const key = `wflink:${change.id}:${definition.revision ?? 0}:${hash({ name: definition.name, trigger: definition.trigger }).toString(36)}`;
		if (!await this.claims.claim(key)) {
			return;
		}
		await linkWorkflow(this.automations, definition);
	}

	/** An automation run of a workflow: its instructions as the `task` input, its event as the payload. */
	private run(request: IAutomationWorkflowRequest): IAutomationWorkflowRun {
		let execution: IWorkflowExecution | undefined;
		let cancelled = false;
		const result = (async (): Promise<IAutomationWorkflowResult> => {
			const workflowId = request.automation.workflowId;
			await this.workflows.whenReady;
			if (!workflowId || !this.workflows.get(workflowId)) {
				return { status: 'failed', error: localize('voltWorkflows.automationMissing', "The workflow {0} no longer exists.", workflowId ?? '') };
			}
			if (cancelled) {
				return { status: 'cancelled' };
			}
			try {
				execution = await this.workflows.start(workflowId, {
					mode: 'execute',
					...(request.task ? { inputs: { task: request.task } } : {}),
					trigger: {
						kind: 'automation',
						label: request.run.label,
						automationId: request.automation.id,
						automationRunId: request.run.id,
						payload: automationPayload(request),
						...(request.repository ? { repository: request.repository.root } : {}),
					},
				});
			} catch (err) {
				return { status: isCancellationError(err) ? 'cancelled' : 'failed', error: errorText(err) };
			}
			if (cancelled) {
				execution.cancel();
			}
			request.onProgress({ workflowRunId: execution.run.id });
			let threadId: string | undefined;
			const listener = execution.onDidChange(event => {
				if (!threadId && event.kind === 'step' && event.step.threadId) {
					threadId = event.step.threadId;
					request.onProgress({ threadId });
				}
			});
			try {
				const run = await execution.done;
				threadId ??= run.steps.find(step => step.threadId)?.threadId;
				const status = run.status === 'succeeded' && run.outcome !== 'failure' ? 'succeeded' : run.status === 'cancelled' ? 'cancelled' : 'failed';
				const error = run.error ?? (status === 'failed' ? run.steps.find(step => step.state === 'failed')?.error : undefined);
				return { status, workflowRunId: run.id, ...(error ? { error } : {}), ...(threadId ? { threadId } : {}) };
			} finally {
				listener.dispose();
			}
		})();
		return {
			result,
			cancel: () => {
				cancelled = true;
				execution?.cancel();
			},
		};
	}
}
