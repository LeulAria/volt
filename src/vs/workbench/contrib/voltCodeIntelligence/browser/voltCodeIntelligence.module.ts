/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isWeb } from '../../../../base/common/platform.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IVoltFeatureModule, IVoltFeatureModuleHost } from '../../voltCustomize/browser/voltFeatureModules.js';
import { CODE_INTELLIGENCE_SECTION_ID } from '../common/voltCodeIntelligence.js';
import { CodeIntelligencePage } from './codeIntelligencePage.js';
import { CodeIndexWarmup, CodeIntelligenceHostTools } from './codeIntelligenceTools.js';

/**
 * The Code Intelligence feature (the `volt.code-intelligence` built-in extension): the
 * instant_grep / find_symbol / find_files host tools agents with their own tools call, the
 * background index warmup and the Settings page. It loads once the window has restored (agents may
 * call its tools at any time) and all of it goes when the extension is disabled. The index service
 * and its settings stay in core.
 */
export const codeIntelligenceModule: IVoltFeatureModule = {
	activate(host: IVoltFeatureModuleHost): void {
		const { instantiationService, subscriptions } = host;

		host.registerPart('settingsKitPage', CODE_INTELLIGENCE_SECTION_ID, {
			render: (pageInstantiationService, kit) => pageInstantiationService.createInstance(CodeIntelligencePage, kit).render(),
		});

		// The desktop window serves the volt MCP server's tool calls; in a browser the agent server does.
		if (!isWeb) {
			subscriptions.add(instantiationService.createInstance(CodeIntelligenceHostTools));
		}

		// Warming the index waits until the window is idle, as it did before it was a module.
		void instantiationService.invokeFunction(accessor => accessor.get(ILifecycleService)).when(LifecyclePhase.Eventually).then(() => {
			if (!subscriptions.isDisposed) {
				subscriptions.add(instantiationService.createInstance(CodeIndexWarmup));
			}
		});
	},
};
