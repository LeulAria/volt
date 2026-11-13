/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IVoltAccountsService, IVoltClaudeAccountsState } from '../../../../../platform/voltAccounts/common/voltAccounts.js';
import { IVoltFeatureModule } from '../../../voltCustomize/browser/voltFeatureModules.js';
import { setupVoltFeatureModule } from '../../../voltCustomize/test/browser/voltFeatureModuleTestUtils.js';
import { CLAUDE_ACCOUNTS_FEATURE_ID, IClaudeAccountsSectionHost, IVoltClaudeAccountsModule } from '../../common/voltClaudeAccounts.js';
// Evaluated with the test file, so what its imports register at load time isn't counted as a test's leak.
import '../../browser/voltClaudeAccounts.module.js';

const STATE: IVoltClaudeAccountsState = {
	switching: 'manual',
	threshold: 90,
	accounts: [
		{ id: 'a', email: 'a@x.com', active: true, addedAt: 1, plan: 'Max 20x' },
		{ id: 'b', email: 'b@x.com', active: false, addedAt: 2 },
	],
};

suite('Volt Claude accounts module', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** The loader with the real entry, a broker that records switches, and Providers & Models' side. */
	function setup(withBroker = true) {
		const setup = setupVoltFeatureModule(store, CLAUDE_ACCOUNTS_FEATURE_ID);
		const changed = store.add(new Emitter<void>());
		const switched: string[] = [];
		setup.instantiation.stub(IConfigurationService, new TestConfigurationService());
		if (withBroker) {
			setup.instantiation.stub(IVoltAccountsService, new class extends mock<IVoltAccountsService>() {
				override readonly onDidChangeClaudeAccounts = changed.event;
				override async getClaudeAccounts() { return STATE; }
				override async switchClaudeAccount(id: string) { switched.push(id); return STATE; }
			});
		}
		const renderStore = store.add(new DisposableStore());
		const buttons = new Map<string, () => void>();
		let rerenders = 0;
		const div = () => mainWindow.document.createElement('div');
		const host: IClaudeAccountsSectionHost = {
			renderStore: () => renderStore,
			rerender: () => rerenders++,
			isShowing: () => true,
			revealWorkbench: () => { },
			sectionTitle: (parent, title) => parent.appendChild(Object.assign(div(), { textContent: title })),
			link: parent => parent.appendChild(div()),
			button: (parent, label, _kind, tooltip, run) => { buttons.set(tooltip, run); return parent.appendChild(Object.assign(div(), { textContent: label })); },
			row: parent => parent.appendChild(div()),
			switch: parent => parent.appendChild(div()),
			dropdown: () => { },
			valueRow: () => { },
			privateText: (parent, text) => parent.append(text),
			runInTerminal: async () => Event.None,
			refreshProvider: async () => { },
		};
		return { ...setup, changed, switched, host, buttons, rerenders: () => rerenders };
	}

	test('MOD-CLAUDE-1: nothing loads at startup; Providers & Models loads it and its section goes through the broker', async () => {
		const { service, instantiation, host, buttons, switched, changed, rerenders } = setup();
		assert.strictEqual(service.isActive(CLAUDE_ACCOUNTS_FEATURE_ID), false);
		const module = await service.activate<IVoltFeatureModule & IVoltClaudeAccountsModule>(CLAUDE_ACCOUNTS_FEATURE_ID);
		const section = module?.createProvidersSection(instantiation, host);
		assert.ok(section);
		changed.fire();
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));
		assert.strictEqual(rerenders(), 1, 'a change at the broker redraws the page');
		const parent = mainWindow.document.createElement('div');
		section.render(parent);
		assert.deepStrictEqual([...parent.querySelectorAll('.volt-pm-account .email')].map(node => node.textContent), ['a@x.com', 'b@x.com'], 'the account in use first');
		buttons.get('Make b@x.com Claude Code\'s account')!();
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));
		assert.deepStrictEqual(switched, ['b'], 'Switch asks the broker');
		section.dispose();
	});

	test('MOD-CLAUDE-WEB: without the accounts broker (the browser workbench) there is no section', async () => {
		const { service, instantiation, host } = setup(false);
		const module = await service.activate<IVoltFeatureModule & IVoltClaudeAccountsModule>(CLAUDE_ACCOUNTS_FEATURE_ID);
		assert.strictEqual(module?.createProvidersSection(instantiation, host), undefined);
	});

	test('MOD-CLAUDE-TOGGLE: disabling the extension unloads it and its section stops listening; enabling it needs no reload', async () => {
		const { service, features, instantiation, host, changed, rerenders } = setup();
		const module = await service.activate<IVoltFeatureModule & IVoltClaudeAccountsModule>(CLAUDE_ACCOUNTS_FEATURE_ID);
		module!.createProvidersSection(instantiation, host);
		await features.setEnabled(CLAUDE_ACCOUNTS_FEATURE_ID, false);
		assert.strictEqual(service.isActive(CLAUDE_ACCOUNTS_FEATURE_ID), false);
		changed.fire();
		await new Promise(resolve => mainWindow.setTimeout(resolve, 0));
		assert.strictEqual(rerenders(), 0, 'the unloaded section no longer listens to the broker');
		await features.setEnabled(CLAUDE_ACCOUNTS_FEATURE_ID, true);
		assert.ok(await service.activate(CLAUDE_ACCOUNTS_FEATURE_ID));
	});

	test('MOD-CLAUDE-GRANTS: it runs with only its manifest\'s grants (report mode: no would-be denial)', async () => {
		const { service, reporter } = setup();
		await service.activate(CLAUDE_ACCOUNTS_FEATURE_ID);
		assert.deepStrictEqual(reporter.reports, []);
	});
});
