/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions } from '../../../../common/editor.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { ReportModeCapabilityReporter } from '../../../../services/voltPlugins/common/capabilities.js';
import { IVoltApi, IVoltPluginContext, IVoltPluginService } from '../../../../services/voltPlugins/common/voltApi.js';
import { VOLT_FEATURE_MANIFESTS } from '../../../voltCustomize/common/voltFeatureManifests.generated.js';
import { IVoltFeatureService, VoltFeaturePart } from '../../../voltCustomize/common/voltFeatures.js';
import { IVoltFeatureModuleService } from '../../../voltCustomize/browser/voltFeatureModules.js';
import { createVoltFeatureModuleEditorSerializer, VoltFeatureModuleService } from '../../../voltCustomize/browser/voltFeatureModuleService.js';
import { VOLT_FEATURE_MODULES } from '../../../voltCustomize/browser/voltFeatureModuleTable.js';
import { GIT_GRAPH_ASK_AGENT_COMMAND_ID, GIT_GRAPH_FEATURE_ID, GIT_GRAPH_FILE_HISTORY_COMMAND_ID, GIT_GRAPH_INPUT_TYPE_ID, GIT_GRAPH_REVEAL_COMMIT_COMMAND_ID, OPEN_GIT_GRAPH_COMMAND_ID, OPEN_GIT_GRAPH_IN_TOOLS_COMMAND_ID } from '../../common/voltGitGraph.js';
import { checkGitGraph, gitCommandCapability } from '../../browser/gitGraphAccess.js';
import { GitGraphEditorInput } from '../../browser/gitGraphInput.js';

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

/** The plugin service as the module sees it: `volt.git-graph`'s real manifest and a report-mode reporter. */
class FakePlugins {
	readonly reporter = new ReportModeCapabilityReporter(() => { });
	private context: IVoltPluginContext | undefined;
	getContext(extensionId: string): IVoltPluginContext | undefined {
		const manifest = VOLT_FEATURE_MANIFESTS.find(candidate => `${candidate.publisher}.${candidate.name}` === extensionId);
		if (!manifest) {
			return undefined;
		}
		this.context ??= { extensionId, featureId: GIT_GRAPH_FEATURE_ID, manifest, volt: {} as IVoltApi, subscriptions: new DisposableStore() };
		return this.context;
	}
	dispose(): void {
		this.context?.subscriptions.dispose();
		this.reporter.dispose();
	}
}

suite('Volt Git Graph module', () => {

	const entry = VOLT_FEATURE_MODULES.find(candidate => candidate.feature === GIT_GRAPH_FEATURE_ID)!;
	// The first import evaluates the editor's own imports (their singletons aren't the module's to dispose).
	suiteSetup(() => entry.load());
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const features = new FakeFeatures();
		const plugins = new FakePlugins();
		store.add({ dispose: () => { features.dispose(); plugins.dispose(); } });
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IVoltFeatureService, features);
		instantiation.stub(IVoltPluginService, plugins as unknown as IVoltPluginService);
		instantiation.stub(IExtensionService, { whenInstalledExtensionsRegistered: async () => true } as unknown as IExtensionService);
		instantiation.stub(ILogService, new NullLogService());
		instantiation.stub(ICommandService, {} as ICommandService);
		const service = store.add(instantiation.createInstance(VoltFeatureModuleService, [entry]));
		instantiation.stub(IVoltFeatureModuleService, service);
		return { service, features, plugins, instantiation };
	}

	/** How many entries `menu` has for `id` (a stub's or the module's). */
	const menuEntries = (menu: MenuId, id: string) => MenuRegistry.getMenuItems(menu).filter(item => isIMenuItem(item) && item.command.id === id).length;
	const paneFor = (input: GitGraphEditorInput) => Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).getEditorPane(input);

	test('GG-MOD-1: the manifest names the feature folder and the table loads it', () => {
		const manifest = VOLT_FEATURE_MANIFESTS.find(candidate => candidate.contributes?.voltModule?.feature === GIT_GRAPH_FEATURE_ID);
		assert.strictEqual(manifest?.contributes?.voltModule?.entry, 'voltGitGraph');
		assert.ok(entry, 'the module table has the Git Graph');
		assert.deepStrictEqual(entry.editors, [GIT_GRAPH_INPUT_TYPE_ID]);
		for (const id of manifest.contributes.voltModule.commands ?? []) {
			assert.ok(entry.commands?.some(command => command.id === id), `${id} has a stub until the module loads`);
		}
	});

	test('GG-MOD-2: before it loads, stubs keep the commands reachable as before, menus included', () => {
		const input = store.add(new GitGraphEditorInput());
		const { service } = setup();
		assert.strictEqual(service.isActive(GIT_GRAPH_FEATURE_ID), false, 'nothing loads at startup');
		// The git extension runs these two; the stubs keep their exported visibility.
		assert.strictEqual(CommandsRegistry.getCommandVisibility(OPEN_GIT_GRAPH_COMMAND_ID), 'exported:git.read');
		assert.strictEqual(CommandsRegistry.getCommandVisibility(GIT_GRAPH_ASK_AGENT_COMMAND_ID), 'exported:agents.send');
		assert.strictEqual(CommandsRegistry.getCommandVisibility(OPEN_GIT_GRAPH_IN_TOOLS_COMMAND_ID), 'public');
		assert.strictEqual(menuEntries(MenuId.SCMHistoryTitle, OPEN_GIT_GRAPH_COMMAND_ID), 1, 'the SCM graph\'s "Open Git Graph" button');
		assert.strictEqual(menuEntries(MenuId.ExplorerContext, GIT_GRAPH_FILE_HISTORY_COMMAND_ID), 1);
		assert.strictEqual(menuEntries(MenuId.SCMHistoryItemContext, GIT_GRAPH_REVEAL_COMMIT_COMMAND_ID), 1);
		assert.strictEqual(menuEntries(MenuId.CommandPalette, OPEN_GIT_GRAPH_COMMAND_ID), 1);
		assert.strictEqual(paneFor(input), undefined, 'its editor pane comes with the module');
	});

	test('GG-TOGGLE-1: enabling and disabling the extension loads and unloads it without a reload', async () => {
		const input = store.add(new GitGraphEditorInput());
		const { service, features, instantiation } = setup();
		assert.ok(await service.activate(GIT_GRAPH_FEATURE_ID));
		assert.ok(service.isActive(GIT_GRAPH_FEATURE_ID));
		assert.ok(paneFor(input), 'the Git Graph editor pane is registered');
		assert.strictEqual(CommandsRegistry.getCommandVisibility(OPEN_GIT_GRAPH_COMMAND_ID), 'exported:git.read');
		assert.strictEqual(menuEntries(MenuId.SCMHistoryTitle, OPEN_GIT_GRAPH_COMMAND_ID), 1, 'the module\'s own entry, the stub\'s gone');
		assert.strictEqual(menuEntries(MenuId.CommandPalette, OPEN_GIT_GRAPH_COMMAND_ID), 1);
		// A saved tab restores through the module's serializer.
		const restored = createVoltFeatureModuleEditorSerializer(GIT_GRAPH_FEATURE_ID, GIT_GRAPH_INPUT_TYPE_ID).deserialize(instantiation, JSON.stringify({ root: '/repo' }));
		assert.ok(restored instanceof GitGraphEditorInput);
		assert.strictEqual(restored.repositoryRoot, '/repo');
		restored.dispose();

		await features.setEnabled(GIT_GRAPH_FEATURE_ID, false);
		assert.strictEqual(service.isActive(GIT_GRAPH_FEATURE_ID), false);
		assert.strictEqual(paneFor(input), undefined, 'its editor pane went with it');
		assert.strictEqual(CommandsRegistry.getCommand(OPEN_GIT_GRAPH_COMMAND_ID), undefined, 'its commands too, stubs included');
		assert.strictEqual(CommandsRegistry.getCommand(GIT_GRAPH_ASK_AGENT_COMMAND_ID), undefined);
		assert.strictEqual(menuEntries(MenuId.SCMHistoryTitle, OPEN_GIT_GRAPH_COMMAND_ID), 0);
		assert.strictEqual(menuEntries(MenuId.EditorContext, 'volt.gitGraph.explainLines'), 0);
		assert.strictEqual(createVoltFeatureModuleEditorSerializer(GIT_GRAPH_FEATURE_ID, GIT_GRAPH_INPUT_TYPE_ID).deserialize(instantiation, ''), undefined, 'an off feature\'s tab is dropped');

		await features.setEnabled(GIT_GRAPH_FEATURE_ID, true);
		assert.ok(CommandsRegistry.getCommand(OPEN_GIT_GRAPH_COMMAND_ID), 'the stubs are back');
		assert.strictEqual(service.isActive(GIT_GRAPH_FEATURE_ID), false, 'and loading waits for a use');
		assert.ok(await service.activate(GIT_GRAPH_FEATURE_ID), 'it activates again');
		assert.ok(paneFor(input));
	});

	test('GG-REPORT-1: with only its manifest grants, what it does to git and chats has 0 would-be denials', async () => {
		const { service, plugins } = setup();
		await service.activate(GIT_GRAPH_FEATURE_ID);
		// Every check the module makes (gitGraphEditor.ts, voltGitGraph.module.ts).
		checkGitGraph('readHistory', 'git.read', '/repo');
		checkGitGraph('readCommit', 'git.read', '/repo');
		checkGitGraph('askAgent', 'agents.send');
		for (const command of ['git.fetch', 'git.pull', 'git.push', 'git.branch', 'git.sync', 'git.publish', 'git.graph.checkoutDetached', 'git.graph.cherryPick', 'git.graph.revert', 'git.createTag', 'git.copyCommitId', 'git.graph.deleteBranch']) {
			checkGitGraph('menu', gitCommandCapability(command)!, command);
		}
		assert.strictEqual(plugins.reporter.reports.length, 0, plugins.reporter.reports.map(report => report.reason).join('; '));
		// The check is live: a use the manifest doesn't declare is reported.
		checkGitGraph('test', 'hosting.read');
		assert.deepStrictEqual(plugins.reporter.reports.map(report => `${report.extensionId}:${report.capability}`), ['volt.git-graph:hosting.read']);
	});

	test('GG-REPORT-2: git commands map to the capability they need', () => {
		assert.strictEqual(gitCommandCapability('git.push'), 'git.push');
		assert.strictEqual(gitCommandCapability('git.sync'), 'git.push');
		assert.strictEqual(gitCommandCapability('git.publish'), 'git.push');
		assert.strictEqual(gitCommandCapability('git.copyCommitId'), 'git.read');
		assert.strictEqual(gitCommandCapability('git.graph.cherryPick'), 'git.write');
		assert.strictEqual(gitCommandCapability('workbench.view.scm'), undefined);
	});
});
