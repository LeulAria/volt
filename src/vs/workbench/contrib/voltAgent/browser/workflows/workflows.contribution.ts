/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import Severity from '../../../../../base/common/severity.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IWorkflowService, WorkflowRecord } from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { OPEN_AUTOMATIONS_ROUTE_COMMAND_ID } from '../../../voltAutomations/common/voltAutomations.js';
import { AutomationsRoute, IWorkflowSeed } from '../automations/automationRoutes.js';
import { registerAgentPaletteEntry } from '../editor/agentCommandPalette.js';
import { WorkflowAutomationBridge } from './workflowAutomationBridge.js';
import { WorkflowService } from './workflowService.js';

registerSingleton(IWorkflowService, WorkflowService, InstantiationType.Delayed);

/** Workflows live in the Automations tab, a page of the Automations feature's module. */
function openAutomations(accessor: ServicesAccessor, route: AutomationsRoute): Promise<void> {
	return accessor.get(ICommandService).executeCommand(OPEN_AUTOMATIONS_ROUTE_COMMAND_ID, route);
}

registerWorkbenchContribution2(WorkflowAutomationBridge.ID, WorkflowAutomationBridge, WorkbenchPhase.AfterRestored);

/** `()`: the workflow library on the Automations page. */
export const OPEN_WORKFLOWS_COMMAND_ID = 'workbench.action.voltAgent.openWorkflows';
/** `(seed?: { yaml?, templateId?, templateSource?, describe?, automationId? })`: a new, unsaved workflow in the builder. */
export const NEW_WORKFLOW_COMMAND_ID = 'workbench.action.voltAgent.newWorkflow';
/** `(workflowId?: string, inputs?: Record<string, value>)`: runs a saved workflow for real; picks one without an id. Resolves with the run id. */
export const RUN_WORKFLOW_COMMAND_ID = 'workbench.action.voltAgent.runWorkflow';

registerAction2(class OpenWorkflowsAction extends Action2 {
	constructor() {
		super({
			id: OPEN_WORKFLOWS_COMMAND_ID,
			visibility: 'public',
			title: localize2('voltWorkflows.open', "Show Workflows"),
			category: localize2('voltAgent.category', "Agent"),
			icon: Codicon.typeHierarchy,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openAutomations(accessor, { page: 'workflows' });
	}
});

registerAction2(class NewWorkflowAction extends Action2 {
	constructor() {
		super({
			id: NEW_WORKFLOW_COMMAND_ID,
			visibility: 'internal',
			title: localize2('voltWorkflows.new', "New Workflow…"),
			category: localize2('voltAgent.category', "Agent"),
			icon: Codicon.typeHierarchy,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
		const raw = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
		const seed: { -readonly [K in keyof IWorkflowSeed]: IWorkflowSeed[K] } = {};
		for (const key of ['yaml', 'templateId', 'templateSource', 'describe', 'automationId'] as const) {
			if (typeof raw[key] === 'string' && raw[key]) {
				seed[key] = raw[key] as string;
			}
		}
		await openAutomations(accessor, { page: 'workflow', ...(Object.keys(seed).length ? { seed } : {}) });
	}
});

registerAction2(class RunWorkflowAction extends Action2 {
	constructor() {
		super({
			id: RUN_WORKFLOW_COMMAND_ID,
			visibility: 'internal',
			title: localize2('voltWorkflows.run', "Run Workflow…"),
			category: localize2('voltAgent.category', "Agent"),
			icon: Codicon.play,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor, workflowId?: unknown, inputs?: unknown): Promise<string | undefined> {
		const workflows = accessor.get(IWorkflowService);
		const notificationService = accessor.get(INotificationService);
		const quickInputService = accessor.get(IQuickInputService);
		const instantiationService = accessor.get(IInstantiationService);
		await workflows.whenReady;
		let id = typeof workflowId === 'string' && workflowId ? workflowId : undefined;
		if (!id) {
			const picks: (IQuickPickItem & { readonly workflowId: string })[] = workflows.list().filter(summary => summary.nodeCount > 0).map(summary => ({
				label: summary.name,
				description: summary.description,
				workflowId: summary.id,
			}));
			if (!picks.length) {
				notificationService.info(localize('voltWorkflows.none', "There are no workflows yet. Make one with New Workflow."));
				return undefined;
			}
			id = (await quickInputService.pick(picks, { placeHolder: localize('voltWorkflows.pick', "Workflow to run") }))?.workflowId;
			if (!id) {
				return undefined;
			}
		}
		const show = (runId?: string) => instantiationService.invokeFunction(inner => openAutomations(inner, { page: 'workflow', id, ...(runId ? { run: runId } : {}) }));
		let execution;
		try {
			execution = await workflows.start(id, {
				mode: 'execute',
				...(inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? { inputs: inputs as WorkflowRecord } : {}),
				trigger: { kind: 'manual', label: localize('voltWorkflows.fromCommand', "Command") },
			});
		} catch (err) {
			if (!isCancellationError(err)) {
				notificationService.error(err instanceof Error ? err.message : String(err));
			}
			return undefined;
		}
		const runId = execution.run.id;
		const name = execution.run.workflowName;
		notificationService.prompt(Severity.Info, localize('voltWorkflows.started', "Running {0}.", name), [{ label: localize('voltWorkflows.show', "Show"), run: () => void show(runId) }]);
		void execution.done.then(run => {
			if (run.status === 'failed' || run.outcome === 'failure') {
				notificationService.prompt(Severity.Warning, localize('voltWorkflows.failed', "{0} failed: {1}", name, run.error ?? localize('voltWorkflows.failedStep', "a step failed")), [{ label: localize('voltWorkflows.show', "Show"), run: () => void show(runId) }]);
			}
		});
		return runId;
	}
});

registerAgentPaletteEntry({
	id: 'workflows',
	label: localize('voltWorkflows.palette.open', "Workflows"),
	description: localize('voltWorkflows.palette.openDetail', "Your workflows, templates and community workflows"),
	commandId: OPEN_WORKFLOWS_COMMAND_ID,
	order: 62,
});

registerAgentPaletteEntry({
	id: 'newWorkflow',
	label: localize('voltWorkflows.palette.new', "New Workflow…"),
	description: localize('voltWorkflows.palette.newDetail', "Chain agents, checks, git steps and approvals in a visual builder"),
	commandId: NEW_WORKFLOW_COMMAND_ID,
	order: 63,
});

registerAgentPaletteEntry({
	id: 'runWorkflow',
	label: localize('voltWorkflows.palette.run', "Run Workflow…"),
	commandId: RUN_WORKFLOW_COMMAND_ID,
	order: 64,
});
