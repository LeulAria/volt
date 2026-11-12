/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IVoltFeatureModule } from '../../../voltCustomize/browser/voltFeatureModules.js';
import { setupVoltFeatureModule } from '../../../voltCustomize/test/browser/voltFeatureModuleTestUtils.js';
import { IDevicesPageHost, IVoltRemoteDevicesModule, REMOTE_DEVICES_FEATURE_ID } from '../../common/voltRemoteDevices.js';
// Evaluated with the test file, so what its imports register at load time isn't counted as a test's leak.
import '../../browser/voltRemoteDevices.module.js';

suite('Volt Remote devices module', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const setup = setupVoltFeatureModule(store, REMOTE_DEVICES_FEATURE_ID);
		setup.instantiation.stub(IDialogService, new class extends mock<IDialogService>() { });
		setup.instantiation.stub(IQuickInputService, new class extends mock<IQuickInputService>() { });
		setup.instantiation.stub(ILayoutService, new class extends mock<ILayoutService>() { });
		return setup;
	}

	/** Settings' side of the page: what it was asked to draw. */
	function host(renderStore: DisposableStore) {
		const drawn: string[] = [];
		const page: IDevicesPageHost = {
			store: renderStore,
			target: () => document.createElement('div'),
			sectionLabel: label => drawn.push(`label ${label}`),
			settingsGroup: () => document.createElement('div'),
			settingRow: (_parent, title) => { drawn.push(`row ${title}`); return document.createElement('div'); },
			empty: text => drawn.push(`empty ${text}`),
			rerender: () => { },
		};
		return { page, drawn };
	}

	test('MOD-REMOTE-1: nothing loads at startup; Settings loads it for the Devices page', async () => {
		const { service, instantiation } = setup();
		assert.strictEqual(service.isActive(REMOTE_DEVICES_FEATURE_ID), false, 'no command or tab loads it: only the page does');
		const module = await service.activate<IVoltFeatureModule & IVoltRemoteDevicesModule>(REMOTE_DEVICES_FEATURE_ID);
		assert.ok(module);
		const renderStore = store.add(new DisposableStore());
		const { page, drawn } = host(renderStore);
		// No agent server in this window: the page says how to turn pairing on (pairing is core).
		await module.createDevicesPage(instantiation, page).render(() => true);
		assert.strictEqual(drawn.length, 1);
		assert.match(drawn[0], /^empty Pairing runs through Volt's agent server/);
	});

	test('MOD-REMOTE-TOGGLE: disabling the extension unloads it; enabling it needs no reload', async () => {
		const { service, features } = setup();
		await service.activate(REMOTE_DEVICES_FEATURE_ID);
		await features.setEnabled(REMOTE_DEVICES_FEATURE_ID, false);
		assert.strictEqual(service.isActive(REMOTE_DEVICES_FEATURE_ID), false);
		assert.strictEqual(await service.activate(REMOTE_DEVICES_FEATURE_ID), undefined, 'off: Settings gets no page');
		await features.setEnabled(REMOTE_DEVICES_FEATURE_ID, true);
		assert.ok(await service.activate(REMOTE_DEVICES_FEATURE_ID));
	});

	test('MOD-REMOTE-GRANTS: it runs with only its manifest\'s grants (report mode: no would-be denial)', async () => {
		const { service, reporter } = setup();
		await service.activate(REMOTE_DEVICES_FEATURE_ID);
		assert.deepStrictEqual(reporter.reports, []);
	});
});
