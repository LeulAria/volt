/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IVoltAgentWindowService } from '../../../services/voltPlugins/browser/voltAgentWindow.js';
import { IVoltPluginService } from '../../../services/voltPlugins/common/voltApi.js';
import { IVoltHostToolCall, IVoltHostToolResult } from '../../../services/voltRuntime/common/hostTools.js';
import { IMultiDiffSourceResolverService } from '../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { IVoltFeatureModule, IVoltFeatureModuleHost } from '../../voltCustomize/browser/voltFeatureModules.js';
import { COMMIT_REVIEW_FEATURE_ID, IAgentCommitPlanService, ICommitReviewModule } from '../common/voltCommitReview.js';
import { AgentCommitPlanService } from './agentCommitPlanService.js';
import { AgentCommitPlanTray, COMMIT_PLAN_CONTENT_SCHEME, COMMIT_PLAN_HEAD_SCHEME, CommitPlanContentProvider, CommitPlanDiffSourceResolver, CommitPlanHeadContentProvider } from './agentCommitPlanTray.js';

/**
 * The commit review, a module of the `volt.commit-review` built-in extension (spec M3): agents'
 * propose_commits / await_commits / rename_branch, the review card above each chat's composer and
 * its diffs. Core's module table (`voltFeatureModuleTable.ts`) lists its tools from startup and
 * loads it on the first call, or when a chat's Draft Commits asks for it. Disabling the extension
 * disposes the service (and its tools), the cards in open chats and the diff providers.
 */
class CommitReviewModule implements IVoltFeatureModule, ICommitReviewModule {

	private service: AgentCommitPlanService | undefined;

	get plans(): IAgentCommitPlanService {
		if (!this.service) {
			throw new Error('The commit review module is not active.');
		}
		return this.service;
	}

	activate(host: IVoltFeatureModuleHost): void {
		const { plugin, subscriptions } = host;
		const service = this.service = subscriptions.add(host.instantiationService.createInstance(AgentCommitPlanService));
		subscriptions.add({ dispose: () => this.service === service && (this.service = undefined) });
		// Its uses of git, checked against its manifest (report mode: logged, never refused).
		const reporter = host.instantiationService.invokeFunction(accessor => accessor.get(IVoltPluginService).reporter);
		const principal = { extensionId: plugin.extensionId, label: plugin.manifest.contributes?.voltModule?.label, firstParty: true, capabilities: plugin.manifest.contributes?.voltCapabilities ?? {} };
		service.setCapabilityCheck(request => reporter.check(principal, request));
		// Its own views and providers get the service by injection, from a child of the window's.
		const child = subscriptions.add(host.instantiationService.createChild(new ServiceCollection([IAgentCommitPlanService, service])));
		child.invokeFunction(accessor => {
			subscriptions.add(accessor.get(IMultiDiffSourceResolverService).registerResolver(subscriptions.add(child.createInstance(CommitPlanDiffSourceResolver))));
			const textModels = accessor.get(ITextModelService);
			subscriptions.add(textModels.registerTextModelContentProvider(COMMIT_PLAN_HEAD_SCHEME, child.createInstance(CommitPlanHeadContentProvider)));
			subscriptions.add(textModels.registerTextModelContentProvider(COMMIT_PLAN_CONTENT_SCHEME, subscriptions.add(child.createInstance(CommitPlanContentProvider))));
			// The review card in every chat's composer, open ones too.
			subscriptions.add(accessor.get(IVoltAgentWindowService).registerComposerTray(COMMIT_REVIEW_FEATURE_ID, trayHost => child.createInstance(AgentCommitPlanTray, trayHost)));
		});
	}

	invokeTool(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		if (!this.service) {
			return Promise.resolve({ error: `${name} is not available: the commit review is turned off.` });
		}
		return this.service.invokeTool(name, args, call);
	}
}

export const commitReviewModule = new CommitReviewModule();
