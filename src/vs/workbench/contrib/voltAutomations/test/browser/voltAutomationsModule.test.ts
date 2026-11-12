/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { createVoltFeatureModuleEditorSerializer, VoltFeatureModuleEditorPlaceholder } from '../../../voltCustomize/browser/voltFeatureModuleService.js';
import { editorPaneFor, paletteEntries as palette, setupVoltFeatureModule } from '../../../voltCustomize/test/browser/voltFeatureModuleTestUtils.js';
import { AUTOMATIONS_EDITOR_INPUT_TYPE_ID, AUTOMATIONS_FEATURE_ID, NEW_AUTOMATION_COMMAND_ID, OPEN_AUTOMATION_RUNS_COMMAND_ID, OPEN_AUTOMATIONS_COMMAND_ID, OPEN_AUTOMATIONS_ROUTE_COMMAND_ID } from '../../common/voltAutomations.js';
import { AutomationsEditorInput } from '../../browser/automationsEditor.js';
// Evaluated with the test file, so what its imports register at load time isn't counted as a test's leak.
import '../../browser/voltAutomations.module.js';

const COMMANDS = [OPEN_AUTOMATIONS_COMMAND_ID, NEW_AUTOMATION_COMMAND_ID, OPEN_AUTOMATION_RUNS_COMMAND_ID, OPEN_AUTOMATIONS_ROUTE_COMMAND_ID, 'voltAgent.automations.openInTools', 'voltAgent.workflows.openInTools'];

suite('Volt Automations module', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const setup = () => setupVoltFeatureModule(store, AUTOMATIONS_FEATURE_ID);
	const pane = () => editorPaneFor(new AutomationsEditorInput());

	test('MOD-AUTOMATIONS-1: nothing loads at startup; its commands stand in, and the first use loads it', async () => {
		const { service } = setup();
		assert.strictEqual(service.isActive(AUTOMATIONS_FEATURE_ID), false);
		const stubs = COMMANDS.map(id => CommandsRegistry.getCommand(id));
		assert.ok(stubs.every(Boolean), 'a stub stands in for each of its commands');
		assert.strictEqual(palette(OPEN_AUTOMATIONS_COMMAND_ID), 1, 'Show Automations is in the Command Palette before it loads');
		assert.strictEqual(pane(), undefined, 'no editor pane until it loads');

		await service.activate(AUTOMATIONS_FEATURE_ID);
		assert.ok(service.isActive(AUTOMATIONS_FEATURE_ID));
		COMMANDS.forEach((id, i) => assert.notStrictEqual(CommandsRegistry.getCommand(id), stubs[i], `${id} is the module's own now`));
		assert.strictEqual(palette(OPEN_AUTOMATIONS_COMMAND_ID), 1, 'listed once (the module\'s action, not the stub)');
		assert.ok(pane(), 'its editor pane is registered');
	});

	test('MOD-AUTOMATIONS-TOGGLE: disabling the extension unloads the pages and closes their tabs; enabling it needs no reload', async () => {
		const { service, features, open, closed } = setup();
		await service.activate(AUTOMATIONS_FEATURE_ID);
		const tab = new AutomationsEditorInput();
		open.push({ groupId: 1, editor: tab });

		await features.setEnabled(AUTOMATIONS_FEATURE_ID, false);
		assert.strictEqual(service.isActive(AUTOMATIONS_FEATURE_ID), false);
		assert.deepStrictEqual(COMMANDS.filter(id => CommandsRegistry.getCommand(id)), [], 'its commands are gone, stubs included');
		assert.strictEqual(palette(OPEN_AUTOMATIONS_COMMAND_ID), 0);
		assert.strictEqual(pane(), undefined, 'its editor pane is gone');
		assert.deepStrictEqual(closed.map(identifier => identifier.editor), [tab], 'its open tab closed');

		await features.setEnabled(AUTOMATIONS_FEATURE_ID, true);
		assert.ok(COMMANDS.every(id => CommandsRegistry.getCommand(id)), 'stubs are back');
		assert.strictEqual(service.isActive(AUTOMATIONS_FEATURE_ID), false, 'loading waits for a use');
		await service.activate(AUTOMATIONS_FEATURE_ID);
		assert.ok(pane());
		tab.dispose();
	});

	test('MOD-AUTOMATIONS-RESTORE: a restored Automations tab waits as a placeholder and comes back on its page', async () => {
		const { service, instantiation } = setup();
		const serializer = createVoltFeatureModuleEditorSerializer(AUTOMATIONS_FEATURE_ID, AUTOMATIONS_EDITOR_INPUT_TYPE_ID);
		const placeholder = serializer.deserialize(instantiation, JSON.stringify({ runs: true }));
		assert.ok(placeholder instanceof VoltFeatureModuleEditorPlaceholder);
		await service.activate(AUTOMATIONS_FEATURE_ID);
		const real = placeholder.resolveModuleEditor(instantiation);
		assert.ok(real instanceof AutomationsEditorInput);
		assert.deepStrictEqual(real.route, { page: 'runs' });
		assert.strictEqual(serializer.serialize(real), JSON.stringify({ runs: true }));
		placeholder.dispose();
		real.dispose();
	});

	test('MOD-AUTOMATIONS-GRANTS: it runs with only its manifest\'s grants (report mode: no would-be denial)', async () => {
		const { service, reporter } = setup();
		await service.activate(AUTOMATIONS_FEATURE_ID);
		assert.deepStrictEqual(reporter.reports, []);
	});
});
