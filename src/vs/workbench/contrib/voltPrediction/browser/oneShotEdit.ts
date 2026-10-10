/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IBulkEditService, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { AGENT_SIDE_PANEL_VIEW_ID } from '../../voltAgent/browser/editor/agentEditorInput.js';
import { AgentSidePanel } from '../../voltAgent/browser/chrome/agentSidePanel.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IEditPrediction, IVoltPredictionService } from '../../../services/voltRuntime/common/prediction.js';
import { buildPredictionContext } from '../../../services/voltRuntime/browser/prediction/predictionContextBuilder.js';
import { resolveEditInModel } from '../../../services/voltRuntime/browser/prediction/predictedEditResolver.js';
import { RecentEditsTracker } from '../../../services/voltRuntime/browser/prediction/recentEditsTracker.js';

export const VOLT_AI_EDIT_COMMAND_ID = 'volt.prediction.aiEdit';

/** Below this the structured edit is not applied; the intent escalates to the agent thread. */
const APPLY_CONFIDENCE_THRESHOLD = 0.5;

/**
 * One-shot AI edit: intent -> structured multi-edit -> bulk preview/apply. Low confidence or
 * an unparsable response escalates the same intent into the Volt agent composer, so the
 * user never dead-ends.
 */
export class VoltAiEditAction extends Action2 {

	constructor(private readonly recentEditsProvider: () => RecentEditsTracker) {
		super({
			id: VOLT_AI_EDIT_COMMAND_ID,
			title: localize2('voltPrediction.aiEdit', "Volt: AI Edit"),
			category: Categories.View,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const quickInputService = accessor.get(IQuickInputService);
		const predictionService = accessor.get(IVoltPredictionService);
		const markerService = accessor.get(IMarkerService);
		const modelService = accessor.get(IModelService);
		const bulkEditService = accessor.get(IBulkEditService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);
		const textModelService = accessor.get(ITextModelService);
		// The accessor is only valid until the first await; the agent handoff needs these later.
		const handoff: IAgentHandoff = { layoutService: accessor.get(IWorkbenchLayoutService), viewsService: accessor.get(IViewsService), notificationService };

		const control = editorService.activeTextEditorControl;
		if (!isCodeEditor(control) || !control.hasModel()) {
			notificationService.info(localize('voltPrediction.noEditor', "Open a text editor to use Volt AI Edit."));
			return;
		}
		const model = control.getModel();
		const position = control.getPosition();

		const intent = await quickInputService.input({
			prompt: localize('voltPrediction.intentPrompt', "What should Volt change? (e.g. rename getUser to fetchUser everywhere)"),
			placeHolder: localize('voltPrediction.intentPlaceholder', "Describe the edit"),
		});
		if (!intent?.trim()) {
			return;
		}

		const cts = new CancellationTokenSource();
		const prediction = await progressService.withProgress<IEditPrediction | undefined>({
			location: ProgressLocation.Notification,
			title: localize('voltPrediction.working', "Volt is preparing edits..."),
			cancellable: true,
		}, () => {
			const ctx = buildPredictionContext(model, position, markerService, modelService, this.recentEditsProvider().list());
			return predictionService.predictMultiEdit(ctx, intent, cts.token);
		}, () => cts.cancel());

		if (cts.token.isCancellationRequested) {
			return;
		}
		if (!prediction || prediction.confidence < APPLY_CONFIDENCE_THRESHOLD) {
			await escalateToAgent(handoff, intent, prediction);
			return;
		}

		// Text-anchored edits are placed in each file as it is now; one whose text is not there is dropped.
		const placed: ResourceTextEdit[] = [];
		for (const edit of [prediction.primary, ...prediction.next]) {
			let reference;
			try {
				reference = await textModelService.createModelReference(edit.uri);
			} catch {
				continue;
			}
			try {
				const target = reference.object.textEditorModel;
				const resolved = resolveEditInModel(edit, target, target.uri.toString() === model.uri.toString() ? position : { lineNumber: 1, column: 1 });
				if (resolved) {
					placed.push(new ResourceTextEdit(resolved.uri, { range: resolved.range, text: resolved.replacement }));
				}
			} finally {
				reference.dispose();
			}
		}
		if (!placed.length) {
			await escalateToAgent(handoff, intent, prediction);
			return;
		}
		const edits = placed;
		const result = await bulkEditService.apply(edits, {
			showPreview: edits.length > 1,
			label: localize('voltPrediction.editLabel', "Volt AI Edit: {0}", intent),
			code: 'volt.aiEdit',
		});
		if (result.isApplied) {
			notificationService.status(localize('voltPrediction.applied', "Volt applied {0} edit(s).", edits.length), { hideAfter: 3000 });
		}
	}
}

/** Hands the intent to the agent thread: open side panel, prefill the composer, tell the user why. */
interface IAgentHandoff {
	readonly layoutService: IWorkbenchLayoutService;
	readonly viewsService: IViewsService;
	readonly notificationService: INotificationService;
}

async function escalateToAgent({ layoutService, viewsService, notificationService }: IAgentHandoff, intent: string, prediction: IEditPrediction | undefined): Promise<void> {
	layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
	const view = await viewsService.openView<AgentSidePanel>(AGENT_SIDE_PANEL_VIEW_ID, true);
	if (!view) {
		notificationService.error(localize('voltPrediction.noPanel', "Could not open the Volt agent panel."));
		return;
	}
	if (!view.getActiveAgentEditor()) {
		await view.openNewAgent();
	}
	view.getActiveAgentEditor()?.prefillDraft(intent);
	notificationService.notify({
		severity: Severity.Info,
		message: prediction
			? localize('voltPrediction.lowConfidence', "The prediction confidence was too low for a direct edit - the request was handed to the agent.")
			: localize('voltPrediction.noParse', "The model did not return a usable edit - the request was handed to the agent."),
	});
}
