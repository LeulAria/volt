/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { RecentEditsTracker } from '../../../services/voltRuntime/browser/prediction/recentEditsTracker.js';
// Ensure the prediction service singleton is registered before anything asks for it.
import '../../../services/voltRuntime/browser/prediction/voltPredictionService.js';
import { VoltAiEditAction } from './oneShotEdit.js';
import { VoltInlineCompletionsProvider } from './voltInlineCompletionsProvider.js';

/**
 * Wires the Prediction Runtime into the editor: one InlineCompletionsProvider on every
 * language (D23) plus the recent-edits tracker feeding its context.
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
		const provider = this._register(instantiationService.createInstance(VoltInlineCompletionsProvider, this.recentEdits));
		this._register(languageFeaturesService.inlineCompletionsProvider.register('*', provider));
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
