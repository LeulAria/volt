/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The window's half of turning a feature without a module off (customize.md 6.1d): the user
// disables `volt.orchestra`, `volt.dev-environment` or `volt.http-client` in Extensions; the feature
// service takes its tools from the window's agents (and tells the agent server), and its Settings
// page, views, Command Palette entries, mentions and "+" menu entry go with it. On again, all come
// back. The agent server's half is FEAT-ORCH-3 / FEAT-IDE-3 / FEAT-HTTP-3 in serverFeatureEnablement.test.ts.

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { MenuId, MenuRegistry, isIMenuItem } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpression } from '../../../../../platform/contextkey/common/contextkey.js';
import { IGlobalExtensionEnablementService, ILocalExtension } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { ExtensionIdentifier, ExtensionType } from '../../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import product from '../../../../../platform/product/common/product.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { firstPartyCeiling } from '../../../../../platform/voltPlugins/common/firstPartyCeilings.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { Extensions as ViewExtensions, IViewsRegistry } from '../../../../common/views.js';
import { EnablementState, IWorkbenchExtensionEnablementService, IWorkbenchExtensionManagementService } from '../../../../services/extensionManagement/common/extensionManagement.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { VoltHostToolService } from '../../../../services/voltRuntime/browser/host/hostToolService.js';
import { IVoltBrowserAccessService } from '../../../../services/voltRuntime/common/browserAccess.js';
import { IVoltFeatureEnablementMirror } from '../../../../services/voltRuntime/common/hostTools.js';
import { IDE_GATEWAY_TOOL_NAME } from '../../../../services/voltRuntime/common/ide/ideCapabilities.js';
import { DEV_ENVIRONMENT_FEATURE_ID, IDE_TOOL_NAMES, IDE_TOOLS } from '../../../../services/voltRuntime/common/ide/ideTools.js';
import { JOB_WATCH_TOOL_NAMES, JOB_WATCH_TOOLS } from '../../../../services/voltRuntime/common/jobs/jobWatch.js';
import { ORCHESTRA_FEATURE_ID, ORCHESTRA_TOOL_NAMES, ORCHESTRA_TOOLS } from '../../../../services/voltRuntime/common/orchestration/orchestra.js';
import { orchestraMentionsShown } from '../../../voltAgent/browser/composer/agentMentions.js';
import type { IIdeCapabilityContext } from '../../../voltAgent/browser/ide/capabilities/capability.js';
import { visibleSurfaceMenuItems } from '../../../voltAgent/browser/workspace/agentSurfaceAddMenu.js';
// The views and commands under test register themselves when imported, as in the window.
import '../../../voltAgent/browser/ide/agentIdeSessionsView.js';
import { HttpCodeLens } from '../../../voltHttp/browser/voltHttp.contribution.js';
import { HTTP_CLIENT_OFF, whileHttpClientOn } from '../../../voltHttp/browser/voltHttpFeature.js';
import { VOLT_HTTP_HISTORY_VIEW_ID, VOLT_HTTP_REQUESTS_VIEW_ID } from '../../../voltHttp/browser/voltHttpViews.js';
import { HTTP_CLIENT_FEATURE_ID, HTTP_CLIENT_SURFACE_ID } from '../../../voltHttp/common/voltHttp.js';
import { isFirstPartyExtension } from '../../browser/voltExtensionApiService.js';
import { VoltFeatureService } from '../../browser/voltFeatureService.js';
import { VOLT_FEATURE_MANIFESTS } from '../../common/voltFeatureManifests.generated.js';
import { VOLT_FEATURES, voltFeatureOn, whileVoltFeatureOn } from '../../common/voltFeatures.js';

const AGENT_SESSIONS_VIEW_ID = 'workbench.view.voltAgentSessions.list';
const CONTAINER_TOOLS_ID = 'ms-azuretools.vscode-containers';

/** The window's own tool service; the agent server is told through `mirrorFeatureEnablement`. */
class RecordingHostTools extends VoltHostToolService {
	readonly mirrored: IVoltFeatureEnablementMirror[] = [];
	override mirrorFeatureEnablement(state?: IVoltFeatureEnablementMirror): void {
		if (state) {
			this.mirrored.push(state);
		}
	}
}

suite('Volt feature service: features without a module', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(initiallyOff: readonly string[] = []) {
		const off = new Set(initiallyOff);
		const changed = store.add(new Emitter<void>());
		const local = (id: string) => ({ identifier: { id }, type: ExtensionType.System }) as unknown as ILocalExtension;
		const installed = ['volt.orchestra', 'volt.dev-environment', 'volt.http-client', 'volt.code-intelligence', CONTAINER_TOOLS_ID].map(local);
		const global = { getDisabledExtensions: () => [...off].map(id => ({ id })) } as unknown as IGlobalExtensionEnablementService;
		const enablement = {
			onEnablementChanged: changed.event,
			getEnablementState: (extension: ILocalExtension) => off.has(extension.identifier.id) ? EnablementState.DisabledGlobally : EnablementState.EnabledGlobally,
			setEnablement: async (extensions: ILocalExtension[], state: EnablementState) => {
				for (const extension of extensions) {
					if (state === EnablementState.DisabledGlobally) {
						off.add(extension.identifier.id);
					} else {
						off.delete(extension.identifier.id);
					}
				}
				return [];
			},
		} as unknown as IWorkbenchExtensionEnablementService;
		const management = { getInstalled: async () => installed, onDidInstallExtensions: Event.None, onDidUninstallExtension: Event.None } as unknown as IWorkbenchExtensionManagementService;
		const extensions = { onDidChangeExtensions: Event.None } as unknown as IExtensionService;
		const commands = { _serviceBrand: undefined, onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None, executeCommand: async () => undefined } as unknown as ICommandService;
		const files = { readFile: async () => { throw new Error('missing'); } } as unknown as IFileService;
		const workspace = { getWorkspace: () => ({ folders: [{ uri: URI.file('/ws') }] }) } as unknown as IWorkspaceContextService;
		const access = { blockReason: () => undefined } as unknown as IVoltBrowserAccessService;
		const tools = store.add(new RecordingHostTools(commands, files, workspace, access));
		// Where they run, the Orchestra and IDE services serve their tools through this service; job waits are core.
		for (const tools_ of [ORCHESTRA_TOOLS, IDE_TOOLS, JOB_WATCH_TOOLS]) {
			store.add(tools.registerToolProvider({ tools: tools_, invoke: async name => ({ text: `ran ${name}` }) }));
		}
		const contextKeys = store.add(new ContextKeyService(new TestConfigurationService()));
		const features = store.add(new VoltFeatureService(global, enablement, management, extensions, contextKeys, tools, new NullLogService()));
		const matches = (when: ContextKeyExpression | undefined) => contextKeys.contextMatchesRules(when);
		/** Which of these tools the window's agents are offered, and which a call reaches. */
		const served = async (names: readonly string[]) => {
			const listed = new Set(tools.listTools().map(tool => tool.name));
			const ran: string[] = [];
			for (const name of names) {
				const result = await tools.invokeTool(name, {}, { sessionId: 's1' });
				if (result.text === `ran ${name}`) {
					ran.push(name);
				} else {
					assert.match(result.error ?? '', /turned off/, `${name} is refused because its feature is off`);
				}
			}
			return { listed: names.filter(name => listed.has(name)), ran };
		};
		return { features, tools, matches, served };
	}

	const view = (id: string) => {
		const descriptor = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).getView(id);
		assert.ok(descriptor, `${id} is registered`);
		return descriptor;
	};

	const palette = (commandId: string) => {
		const item = MenuRegistry.getMenuItems(MenuId.CommandPalette).find(entry => isIMenuItem(entry) && entry.command.id === commandId);
		assert.ok(item, `${commandId} is in the Command Palette`);
		return item.when;
	};

	test('FEAT-ORCH-2: volt.orchestra off: its tools leave the window\'s agents, Settings > Orchestration, Measure and @ Agents / @ Machines go, the agent server is told; on again, all come back', async () => {
		// Off at startup, from the global list, before the installed extensions are read.
		const { features, tools, matches, served } = setup(['volt.orchestra']);
		assert.deepStrictEqual(await served(ORCHESTRA_TOOL_NAMES), { listed: [], ran: [] });
		assert.deepStrictEqual(await served(IDE_TOOL_NAMES), { listed: [...IDE_TOOL_NAMES], ran: [...IDE_TOOL_NAMES] }, 'Dev environment is untouched');
		assert.strictEqual(features.isEnabled(ORCHESTRA_FEATURE_ID), false);
		assert.strictEqual(features.isOn('section', 'orchestration'), false, 'Settings > Orchestration');
		assert.strictEqual(matches(voltFeatureOn(ORCHESTRA_FEATURE_ID)), false, 'Measure (its precondition) in the Command Palette');
		assert.strictEqual(orchestraMentionsShown(features), false, '@ Agents and @ Machines');

		await features.setEnabled(ORCHESTRA_FEATURE_ID, true);
		assert.deepStrictEqual(await served(ORCHESTRA_TOOL_NAMES), { listed: [...ORCHESTRA_TOOL_NAMES], ran: [...ORCHESTRA_TOOL_NAMES] });
		assert.strictEqual(features.isOn('section', 'orchestration'), true);
		assert.strictEqual(matches(voltFeatureOn(ORCHESTRA_FEATURE_ID)), true);
		assert.strictEqual(orchestraMentionsShown(features), true);
		assert.deepStrictEqual(tools.mirrored.at(-1), { global: [], workspace: [] }, 'the agent server is told it is on');

		await features.setEnabled(ORCHESTRA_FEATURE_ID, false);
		assert.deepStrictEqual(tools.mirrored.at(-1), { global: [ORCHESTRA_FEATURE_ID], workspace: [] }, 'the agent server is told it is off');
		assert.deepStrictEqual((await served(ORCHESTRA_TOOL_NAMES)).listed, []);
		// Without the feature service (a workbench slice), the mentions stay.
		assert.strictEqual(orchestraMentionsShown(undefined), true);
	});

	test('FEAT-IDE-2: volt.dev-environment off: tests, debug, tasks and ide leave the window\'s agents, the Agent Sessions view and the Testing view\'s Volt tests go; on again, all come back', async () => {
		const { features, tools, matches, served } = setup();
		// What the Testing view's Volt tests controller gate (agentIdeService.ts) keeps, with the real service.
		const controllers: string[] = [];
		const gate = whileVoltFeatureOn(features, DEV_ENVIRONMENT_FEATURE_ID, () => {
			controllers.push('made');
			return toDisposable(() => controllers.push('disposed'));
		});
		assert.deepStrictEqual(controllers, ['made']);
		assert.deepStrictEqual((await served(IDE_TOOL_NAMES)).ran, [...IDE_TOOL_NAMES]);
		assert.strictEqual(matches(view(AGENT_SESSIONS_VIEW_ID).when), true);

		await features.setEnabled(DEV_ENVIRONMENT_FEATURE_ID, false);
		assert.deepStrictEqual(await served(IDE_TOOL_NAMES), { listed: [], ran: [] });
		assert.deepStrictEqual(await served(ORCHESTRA_TOOL_NAMES), { listed: [...ORCHESTRA_TOOL_NAMES], ran: [...ORCHESTRA_TOOL_NAMES] }, 'Orchestra is untouched');
		assert.deepStrictEqual(await served(JOB_WATCH_TOOL_NAMES), { listed: [...JOB_WATCH_TOOL_NAMES], ran: [...JOB_WATCH_TOOL_NAMES] }, 'job waits are core');
		assert.strictEqual(matches(view(AGENT_SESSIONS_VIEW_ID).when), false, 'the Agent Sessions view');
		assert.deepStrictEqual(controllers, ['made', 'disposed'], 'the Volt tests controller is gone');
		assert.deepStrictEqual(tools.mirrored.at(-1), { global: [DEV_ENVIRONMENT_FEATURE_ID], workspace: [] });

		await features.setEnabled(DEV_ENVIRONMENT_FEATURE_ID, true);
		assert.deepStrictEqual(await served(IDE_TOOL_NAMES), { listed: [...IDE_TOOL_NAMES], ran: [...IDE_TOOL_NAMES] });
		assert.strictEqual(matches(view(AGENT_SESSIONS_VIEW_ID).when), true);
		assert.deepStrictEqual(controllers, ['made', 'disposed', 'made']);
		gate.dispose();
	});

	test('FEAT-HTTP-2: volt.http-client off: the + menu entry, the Requests and History views, its Command Palette entries and the .http CodeLens go, and ide http sends nothing; on again, all come back', async () => {
		const { features, tools, matches, served } = setup();
		const configuration = new TestConfigurationService();
		const languageFeatures = new LanguageFeaturesService();
		store.add(new HttpCodeLens(languageFeatures, features));
		const httpFile = { uri: URI.file('/ws/api.http'), getLanguageId: () => 'http', isTooLargeForSyncing: () => false, isForSimpleWidget: false } as unknown as ITextModel;
		const sent: string[] = [];
		const http = whileHttpClientOn({ id: 'http', invoke: async op => { sent.push(op); return { text: 'HTTP/1.1 200 OK' }; } }, features);
		const ctx = { root: URI.file('/ws'), chatId: 'c1', token: CancellationToken.None } as unknown as IIdeCapabilityContext;
		const surfaces = () => visibleSurfaceMenuItems(configuration, features).map(item => item.id);
		const toolsBefore = tools.listTools().map(tool => tool.name);

		assert.ok(surfaces().includes(HTTP_CLIENT_SURFACE_ID));
		assert.strictEqual(languageFeatures.codeLensProvider.has(httpFile), true);
		assert.deepStrictEqual(await http.invoke('send', { method: 'GET', url: 'http://localhost:1' }, ctx), { text: 'HTTP/1.1 200 OK' });

		await features.setEnabled(HTTP_CLIENT_FEATURE_ID, false);
		assert.ok(!surfaces().includes(HTTP_CLIENT_SURFACE_ID), 'the + menu entry');
		assert.ok(surfaces().includes('terminal'), 'the rest of the + menu stays');
		assert.strictEqual(matches(view(VOLT_HTTP_REQUESTS_VIEW_ID).when), false, 'the Requests view');
		assert.strictEqual(matches(view(VOLT_HTTP_HISTORY_VIEW_ID).when), false, 'the History view');
		assert.strictEqual(matches(palette('volt.http.newRequest')), false);
		assert.strictEqual(matches(palette('volt.http.selectEnvironment')), false);
		assert.strictEqual(languageFeatures.codeLensProvider.has(httpFile), false, 'the CodeLens');
		assert.deepStrictEqual(await http.invoke('send', { method: 'GET', url: 'http://localhost:1' }, ctx), { text: HTTP_CLIENT_OFF, isError: true });
		assert.deepStrictEqual(sent, ['send'], 'nothing was sent while it was off');
		// It serves no tool of its own: the ide gateway (Dev environment) stays, and so does every other tool.
		assert.deepStrictEqual(tools.listTools().map(tool => tool.name), toolsBefore);
		assert.deepStrictEqual((await served([IDE_GATEWAY_TOOL_NAME])).ran, [IDE_GATEWAY_TOOL_NAME]);
		assert.deepStrictEqual(tools.mirrored.at(-1), { global: [HTTP_CLIENT_FEATURE_ID], workspace: [] });

		await features.setEnabled(HTTP_CLIENT_FEATURE_ID, true);
		assert.ok(surfaces().includes(HTTP_CLIENT_SURFACE_ID));
		assert.strictEqual(matches(view(VOLT_HTTP_REQUESTS_VIEW_ID).when), true);
		assert.strictEqual(matches(view(VOLT_HTTP_HISTORY_VIEW_ID).when), true);
		assert.strictEqual(matches(palette('volt.http.newRequest')), true);
		assert.strictEqual(languageFeatures.codeLensProvider.has(httpFile), true);
		assert.deepStrictEqual(await http.invoke('send', { method: 'GET', url: 'http://localhost:1' }, ctx), { text: 'HTTP/1.1 200 OK' });
	});

	test('FEAT-IDE-4: Container Tools is a VS Code built-in that came with the dev environment, not a Volt feature', async () => {
		assert.ok(product.builtInExtensions?.some(extension => extension.name === CONTAINER_TOOLS_ID), 'shipped as a built-in (product.json)');
		// No catalog entry, no manifest under extensions/volt-*, so no switch and nothing it can take away.
		assert.ok(!VOLT_FEATURES.some(feature => feature.extensionId?.toLowerCase() === CONTAINER_TOOLS_ID));
		assert.ok(!VOLT_FEATURE_MANIFESTS.some(manifest => `${manifest.publisher}.${manifest.name}` === CONTAINER_TOOLS_ID));
		// Not first party: no ceiling, never trusted core, so the Access page doesn't list it as Volt's built-in.
		assert.strictEqual(firstPartyCeiling(CONTAINER_TOOLS_ID), undefined);
		assert.strictEqual(isFirstPartyExtension({ identifier: new ExtensionIdentifier(CONTAINER_TOOLS_ID), publisher: 'ms-azuretools', isBuiltin: true, isUserBuiltin: false }), false);
		assert.strictEqual(isFirstPartyExtension({ identifier: new ExtensionIdentifier('volt.dev-environment'), publisher: 'volt', isBuiltin: true, isUserBuiltin: false }), true);
		// Disabling it in Extensions turns no Volt feature off.
		const { features, served } = setup([CONTAINER_TOOLS_ID]);
		assert.ok(VOLT_FEATURES.every(feature => features.isEnabled(feature.id)));
		assert.deepStrictEqual((await served(IDE_TOOL_NAMES)).ran, [...IDE_TOOL_NAMES]);
	});
});
