/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FEAT-R4-6: the window's half of turning a feature without a module off (customize.md 6.1d). The
// user disables `volt.orchestra`, `volt.dev-environment` or `volt.http-client` in Extensions: the
// feature service takes its tools from the agents (and tells the agent server), and the views and
// Command Palette entries that follow `voltFeatureOn` go with it.

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuId, MenuRegistry, isIMenuItem } from '../../../../../platform/actions/common/actions.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpression } from '../../../../../platform/contextkey/common/contextkey.js';
import { IGlobalExtensionEnablementService, ILocalExtension } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { ExtensionType } from '../../../../../platform/extensions/common/extensions.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as ViewExtensions, IViewsRegistry } from '../../../../common/views.js';
import { EnablementState, IWorkbenchExtensionEnablementService, IWorkbenchExtensionManagementService } from '../../../../services/extensionManagement/common/extensionManagement.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { DEV_ENVIRONMENT_FEATURE_ID, IDE_TOOL_NAMES } from '../../../../services/voltRuntime/common/ide/ideTools.js';
import { ORCHESTRA_FEATURE_ID, ORCHESTRA_TOOL_NAMES } from '../../../../services/voltRuntime/common/orchestration/orchestra.js';
// The views and commands under test register themselves when imported, as in the window.
import '../../../voltAgent/browser/ide/agentIdeSessionsView.js';
import '../../../voltHttp/browser/voltHttp.contribution.js';
import { VOLT_HTTP_HISTORY_VIEW_ID, VOLT_HTTP_REQUESTS_VIEW_ID } from '../../../voltHttp/browser/voltHttpViews.js';
import { HTTP_CLIENT_FEATURE_ID, HTTP_CLIENT_SURFACE_ID } from '../../../voltHttp/common/voltHttp.js';
import { VoltFeatureService } from '../../browser/voltFeatureService.js';
import { voltFeatureOn } from '../../common/voltFeatures.js';

const AGENT_SESSIONS_VIEW_ID = 'workbench.view.voltAgentSessions.list';

suite('Volt feature service: features without a module', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(initiallyOff: readonly string[]) {
		const off = new Set(initiallyOff);
		const changed = store.add(new Emitter<void>());
		const local = (id: string) => ({ identifier: { id }, type: ExtensionType.System }) as unknown as ILocalExtension;
		const installed = ['volt.orchestra', 'volt.dev-environment', 'volt.http-client', 'volt.code-intelligence'].map(local);
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
		const disabledTools: string[][] = [];
		const mirrored: { global: readonly string[]; workspace: readonly string[] }[] = [];
		const hostTools = {
			setDisabledTools: (names: Iterable<string>) => disabledTools.push([...names]),
			mirrorFeatureEnablement: (state: { global: readonly string[]; workspace: readonly string[] }) => mirrored.push(state),
		} as unknown as IVoltHostToolService;
		const contextKeys = store.add(new ContextKeyService(new TestConfigurationService()));
		const features = store.add(new VoltFeatureService(global, enablement, management, extensions, contextKeys, hostTools, new NullLogService()));
		const matches = (when: ContextKeyExpression | undefined) => contextKeys.contextMatchesRules(when);
		return { features, disabledTools, mirrored, matches };
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

	test('FEAT-R4-6: a turned-off Orchestra, Dev environment or HTTP client loses its tools, its views and its Command Palette entries; on again, they come back', async () => {
		const { features, disabledTools, mirrored, matches } = setup(['volt.orchestra']);
		// At startup, from the global list, before the installed extensions are read.
		assert.deepStrictEqual(disabledTools.at(-1), [...ORCHESTRA_TOOL_NAMES]);
		assert.strictEqual(features.isEnabled(ORCHESTRA_FEATURE_ID), false);
		assert.strictEqual(features.isOn('section', 'orchestration'), false, 'Settings > Orchestration');
		assert.strictEqual(matches(voltFeatureOn(ORCHESTRA_FEATURE_ID)), false, 'Measure in the Command Palette');

		await features.setEnabled(DEV_ENVIRONMENT_FEATURE_ID, false);
		assert.deepStrictEqual(disabledTools.at(-1), [...ORCHESTRA_TOOL_NAMES, ...IDE_TOOL_NAMES]);
		assert.deepStrictEqual(mirrored.at(-1), { global: [ORCHESTRA_FEATURE_ID, DEV_ENVIRONMENT_FEATURE_ID], workspace: [] }, 'the agent server is told');
		assert.strictEqual(matches(view(AGENT_SESSIONS_VIEW_ID).when), false, 'the Agent Sessions view');
		assert.strictEqual(matches(view(VOLT_HTTP_REQUESTS_VIEW_ID).when), true, 'the HTTP client is still on');

		await features.setEnabled(HTTP_CLIENT_FEATURE_ID, false);
		assert.strictEqual(features.isOn('surface', HTTP_CLIENT_SURFACE_ID), false, 'the + menu entry');
		assert.strictEqual(matches(view(VOLT_HTTP_REQUESTS_VIEW_ID).when), false, 'the Requests view');
		assert.strictEqual(matches(view(VOLT_HTTP_HISTORY_VIEW_ID).when), false, 'the History view');
		assert.strictEqual(matches(palette('volt.http.newRequest')), false);
		assert.strictEqual(matches(palette('volt.http.selectEnvironment')), false);
		assert.deepStrictEqual(disabledTools.at(-1), [...ORCHESTRA_TOOL_NAMES, ...IDE_TOOL_NAMES], 'the HTTP client serves no tools of its own');
		// Other features are untouched.
		assert.strictEqual(features.isEnabled('codeIntelligence'), true);

		for (const id of [ORCHESTRA_FEATURE_ID, DEV_ENVIRONMENT_FEATURE_ID, HTTP_CLIENT_FEATURE_ID]) {
			await features.setEnabled(id, true);
		}
		assert.deepStrictEqual(disabledTools.at(-1), []);
		assert.strictEqual(features.isOn('section', 'orchestration'), true);
		assert.strictEqual(matches(view(AGENT_SESSIONS_VIEW_ID).when), true);
		assert.strictEqual(matches(view(VOLT_HTTP_REQUESTS_VIEW_ID).when), true);
		assert.strictEqual(matches(palette('volt.http.newRequest')), true);
	});
});
