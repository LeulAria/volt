/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IVoltAgentWindowService, VoltComposerTrayFactory } from '../../../../services/voltPlugins/browser/voltAgentWindow.js';
import { ReportModeCapabilityReporter } from '../../../../services/voltPlugins/common/capabilities.js';
import { IVoltApi, IVoltPluginContext, IVoltPluginService } from '../../../../services/voltPlugins/common/voltApi.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { COMMIT_PLAN_TOOL_NAMES, IVoltHostToolProvider, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IMultiDiffSourceResolverService } from '../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { IAgentPullRequestService } from '../../../voltAgent/browser/pullRequests/agentPullRequestService.js';
import { IVoltFeatureModule, IVoltFeatureModuleService } from '../../../voltCustomize/browser/voltFeatureModules.js';
import { VoltFeatureModuleService } from '../../../voltCustomize/browser/voltFeatureModuleService.js';
import { VOLT_FEATURE_MODULES } from '../../../voltCustomize/browser/voltFeatureModuleTable.js';
import { VOLT_FEATURE_MANIFESTS } from '../../../voltCustomize/common/voltFeatureManifests.generated.js';
import { IVoltFeatureService, VoltFeaturePart } from '../../../voltCustomize/common/voltFeatures.js';
import { COMMIT_REVIEW_FEATURE_ID, ICommitReviewModule } from '../../common/voltCommitReview.js';

class FakeFeatures implements IVoltFeatureService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange = this._onDidChange.event;
	readonly off = new Set<string>();
	isEnabled(featureId: string): boolean { return !this.off.has(featureId); }
	isOn(_part: VoltFeaturePart, _id: string): boolean { return true; }
	async setEnabled(featureId: string, enabled: boolean): Promise<void> {
		if (enabled) {
			this.off.delete(featureId);
		} else {
			this.off.add(featureId);
		}
		this._onDidChange.fire();
	}
	dispose(): void { this._onDidChange.dispose(); }
}

/** `volt.commit-review`'s real manifest and a report-mode reporter. */
class FakePlugins {
	readonly reporter = new ReportModeCapabilityReporter(() => { });
	private context: IVoltPluginContext | undefined;
	getContext(extensionId: string): IVoltPluginContext | undefined {
		const manifest = VOLT_FEATURE_MANIFESTS.find(candidate => `${candidate.publisher}.${candidate.name}` === extensionId);
		if (!manifest) {
			return undefined;
		}
		this.context ??= { extensionId, featureId: COMMIT_REVIEW_FEATURE_ID, manifest, volt: {} as IVoltApi, subscriptions: new DisposableStore() };
		return this.context;
	}
	dispose(): void {
		this.context?.subscriptions.dispose();
		this.reporter.dispose();
	}
}

suite('Volt commit review module', () => {

	const entry = VOLT_FEATURE_MODULES.find(candidate => candidate.feature === COMMIT_REVIEW_FEATURE_ID)!;
	// The first import evaluates the module's own imports (their singletons aren't the module's to dispose).
	suiteSetup(() => entry.load());
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const features = new FakeFeatures();
		const plugins = new FakePlugins();
		store.add({ dispose: () => { features.dispose(); plugins.dispose(); } });
		const providers = new Set<IVoltHostToolProvider>();
		const trays = new Map<string, VoltComposerTrayFactory>();
		const renamed: string[] = [];
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IVoltFeatureService, features);
		instantiation.stub(IVoltPluginService, plugins as unknown as IVoltPluginService);
		instantiation.stub(IExtensionService, { whenInstalledExtensionsRegistered: async () => true } as unknown as IExtensionService);
		instantiation.stub(ILogService, new NullLogService());
		instantiation.stub(ICommandService, {} as ICommandService);
		instantiation.stub(IVoltHostToolService, new class extends mock<IVoltHostToolService>() {
			override registerToolProvider(provider: IVoltHostToolProvider): IDisposable {
				providers.add(provider);
				return toDisposable(() => providers.delete(provider));
			}
		});
		instantiation.stub(IVoltAgentWindowService, new class extends mock<IVoltAgentWindowService>() {
			override registerComposerTray(id: string, factory: VoltComposerTrayFactory): IDisposable {
				trays.set(id, factory);
				return toDisposable(() => trays.delete(id));
			}
		});
		instantiation.stub(IMultiDiffSourceResolverService, new class extends mock<IMultiDiffSourceResolverService>() {
			override registerResolver() { return Disposable.None; }
		});
		instantiation.stub(ITextModelService, new class extends mock<ITextModelService>() {
			override registerTextModelContentProvider() { return Disposable.None; }
		});
		instantiation.stub(IModelService, new class extends mock<IModelService>() {
			override getModels() { return []; }
		});
		instantiation.stub(IAgentRuntimeService, new class extends mock<IAgentRuntimeService>() {
			override readonly onDidEmit = Event.None;
			override chatFor(sessionId: string) { return sessionId; }
		});
		instantiation.stub(IAgentHistoryService, new class extends mock<IAgentHistoryService>() {
			override list() { return []; }
		});
		instantiation.stub(IAgentPullRequestService, new class extends mock<IAgentPullRequestService>() {
			override folderFor() { return '/repo'; }
			override readonly api = new class extends mock<IAgentPullRequestService['api']>() {
				override async gitStatus() { return { root: '/repo', branch: 'volt/abcd1234', files: [] } as unknown as Awaited<ReturnType<IAgentPullRequestService['api']['gitStatus']>>; }
				override async renameBranch({ name }: { folder: string; name: string }) {
					renamed.push(name);
					return { previous: 'volt/abcd1234', branch: name };
				}
			};
		});
		const service = store.add(instantiation.createInstance(VoltFeatureModuleService, [entry]));
		instantiation.stub(IVoltFeatureModuleService, service);
		const tools = () => [...providers].flatMap(provider => provider.tools.map(tool => tool.name));
		const call = (name: string, args: Record<string, unknown>) => {
			const provider = [...providers].find(candidate => candidate.tools.some(tool => tool.name === name));
			assert.ok(provider, `${name} is listed`);
			return provider.invoke(name, args, { sessionId: 'chat-1' });
		};
		return { service, features, plugins, providers, trays, renamed, tools, call };
	}

	const review = (service: VoltFeatureModuleService) => service.getActive<IVoltFeatureModule & ICommitReviewModule>(COMMIT_REVIEW_FEATURE_ID);

	test('CR-MOD-1: the manifest names the feature folder; the table lists its tools', () => {
		const manifest = VOLT_FEATURE_MANIFESTS.find(candidate => candidate.contributes?.voltModule?.feature === COMMIT_REVIEW_FEATURE_ID);
		assert.strictEqual(manifest?.contributes?.voltModule?.entry, 'voltCommitReview');
		assert.deepStrictEqual(entry.tools?.map(tool => tool.name), [...COMMIT_PLAN_TOOL_NAMES]);
		assert.deepStrictEqual(entry.tools?.map(tool => tool.name), manifest.contributes.voltTools?.map(tool => tool.name), 'what the manifest declares');
	});

	test('CR-LAZY-1: agents see its tools before it loads; the first call loads it and runs', async () => {
		const { service, trays, renamed, tools, call } = setup();
		assert.strictEqual(service.isActive(COMMIT_REVIEW_FEATURE_ID), false, 'nothing loads at startup');
		assert.deepStrictEqual(tools(), [...COMMIT_PLAN_TOOL_NAMES], 'the stubs list the tools');
		assert.strictEqual(trays.size, 0, 'no card in the composers yet');
		const result = await call('rename_branch', { name: 'feat/commit-review' });
		assert.ok(!result.error, result.error);
		assert.deepStrictEqual(renamed, ['feat/commit-review']);
		assert.ok(service.isActive(COMMIT_REVIEW_FEATURE_ID));
		assert.deepStrictEqual(tools(), [...COMMIT_PLAN_TOOL_NAMES], 'the module\'s own provider replaced the stubs');
		assert.ok(trays.has(COMMIT_REVIEW_FEATURE_ID), 'every composer gets its card');
		// Later calls reach the module's provider.
		await call('rename_branch', { name: 'fix/second' });
		assert.deepStrictEqual(renamed, ['feat/commit-review', 'fix/second']);
	});

	test('CR-TOGGLE-1: disabling the extension unloads it without a reload; enabling it lists the tools again', async () => {
		const { service, features, trays, tools } = setup();
		const loaded = review(service) ?? await service.activate<IVoltFeatureModule & ICommitReviewModule>(COMMIT_REVIEW_FEATURE_ID);
		assert.ok(loaded);
		loaded.plans.startDrafting('chat-1');
		assert.ok(loaded.plans.drafting('chat-1'));
		await features.setEnabled(COMMIT_REVIEW_FEATURE_ID, false);
		assert.strictEqual(review(service), undefined);
		assert.deepStrictEqual(tools(), [], 'its tools are gone, stubs included');
		assert.strictEqual(trays.size, 0, 'and its card from every composer');
		assert.strictEqual(await service.activate(COMMIT_REVIEW_FEATURE_ID), undefined, 'an off feature does not load');
		await features.setEnabled(COMMIT_REVIEW_FEATURE_ID, true);
		assert.deepStrictEqual(tools(), [...COMMIT_PLAN_TOOL_NAMES], 'the stubs are back');
		assert.strictEqual(service.isActive(COMMIT_REVIEW_FEATURE_ID), false, 'and loading waits for a use');
		const again = await service.activate<IVoltFeatureModule & ICommitReviewModule>(COMMIT_REVIEW_FEATURE_ID);
		assert.ok(again);
		assert.strictEqual(again.plans.drafting('chat-1'), false, 'a fresh review: nothing carried over');
	});

	test('CR-REPORT-1: with only its manifest grants, renaming a branch has 0 would-be denials', async () => {
		const { plugins, call } = setup();
		await call('rename_branch', { name: 'feat/x' });
		await call('propose_commits', { commits: [] });
		assert.strictEqual(plugins.reporter.reports.length, 0, plugins.reporter.reports.map(report => report.reason).join('; '));
	});
});
