/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { RecentEditsTracker } from '../../../services/voltRuntime/browser/prediction/recentEditsTracker.js';
// Ensure the prediction service singleton is registered before anything asks for it.
import '../../../services/voltRuntime/browser/prediction/voltPredictionService.js';
import { WorkspaceContextIndex } from '../../../services/voltRuntime/browser/prediction/workspaceContextIndex.js';
import { IVoltPredictionService } from '../../../services/voltRuntime/common/prediction.js';
import { AGENT_COMPOSER_SCHEME } from '../../../services/voltRuntime/common/prediction/composerContext.js';
import { describeStats } from '../../../services/voltRuntime/common/prediction/predictionStats.js';
import { ClipboardWatch } from './clipboardWatch.js';
import { VoltAiEditAction } from './oneShotEdit.js';
import { TerminalCommandTracker } from './terminalCommandTracker.js';
import { VoltComposerCompletionsProvider } from './voltComposerCompletionsProvider.js';
import { VoltInlineCompletionsProvider } from './voltInlineCompletionsProvider.js';

/**
 * Wires the Prediction Runtime into the editor: one InlineCompletionsProvider on every
 * language (D23) plus what feeds its context (recent edits, the workspace index of open files,
 * terminal commands, the clipboard), and a natural-language provider for the agent composers.
 */
class VoltPredictionContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltPrediction';

	readonly recentEdits: RecentEditsTracker;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
	) {
		super();
		this.recentEdits = this._register(instantiationService.createInstance(RecentEditsTracker));
		const index = this._register(instantiationService.createInstance(WorkspaceContextIndex));
		const terminals = this._register(instantiationService.createInstance(TerminalCommandTracker));
		const clipboard = instantiationService.createInstance(ClipboardWatch);
		const provider = this._register(instantiationService.createInstance(VoltInlineCompletionsProvider, this.recentEdits, index, terminals, clipboard));
		this._register(languageFeaturesService.inlineCompletionsProvider.register('*', provider));
		const composer = this._register(instantiationService.createInstance(VoltComposerCompletionsProvider, terminals, clipboard));
		// The composers' models are simple-widget models: a provider only sees them with hasAccessToAllModels.
		this._register(languageFeaturesService.inlineCompletionsProvider.register({ scheme: AGENT_COMPOSER_SCHEME, hasAccessToAllModels: true }, composer));
		recentEditsForActions = this.recentEdits;
	}
}

/** The action needs the tracker but Action2 has no DI on construction; hand it over lazily. */
let recentEditsForActions: RecentEditsTracker | undefined;

registerWorkbenchContribution2(VoltPredictionContribution.ID, VoltPredictionContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends VoltAiEditAction {
	constructor() {
		super(() => {
			if (!recentEditsForActions) {
				throw new Error('Volt prediction is not initialized yet.');
			}
			return recentEditsForActions;
		});
	}
});

/** What Tab and the composer ghost text cost and saved since the window opened. */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'volt.prediction.showStats',
			title: localize2('voltPrediction.showStats', "Volt: Tab Prediction Stats"),
			category: Categories.View,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		const stats = accessor.get(IVoltPredictionService).stats.snapshot();
		accessor.get(INotificationService).info(describeStats(stats));
	}
});
