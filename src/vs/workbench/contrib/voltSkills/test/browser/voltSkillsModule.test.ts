/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { createVoltFeatureModuleEditorSerializer, VoltFeatureModuleEditorPlaceholder } from '../../../voltCustomize/browser/voltFeatureModuleService.js';
import { editorPaneFor, paletteEntries, setupVoltFeatureModule } from '../../../voltCustomize/test/browser/voltFeatureModuleTestUtils.js';
import { OPEN_SKILLS_COMMAND_ID, OPEN_SKILLS_MARKETPLACE_COMMAND_ID, SKILLS_EDITOR_INPUT_TYPE_ID, SKILLS_FEATURE_ID, skillsTrail } from '../../common/voltSkills.js';
import { AgentCustomizeEditorInput } from '../../browser/agentCustomizeEditor.js';
// Evaluated with the test file, so what its imports register at load time isn't counted as a test's leak.
import '../../browser/voltSkills.module.js';

const COMMANDS = [OPEN_SKILLS_COMMAND_ID, OPEN_SKILLS_MARKETPLACE_COMMAND_ID];

suite('Volt Skills & Plugins module', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const setup = () => setupVoltFeatureModule(store, SKILLS_FEATURE_ID);
	const pane = () => editorPaneFor(new AgentCustomizeEditorInput());

	test('MOD-SKILLS-1: nothing loads at startup; its commands stand in, and the first use loads it', async () => {
		const { service } = setup();
		assert.strictEqual(service.isActive(SKILLS_FEATURE_ID), false);
		const stubs = COMMANDS.map(id => CommandsRegistry.getCommand(id));
		assert.ok(stubs.every(Boolean), 'a stub stands in for each of its commands');
		assert.strictEqual(paletteEntries(OPEN_SKILLS_COMMAND_ID), 1);
		assert.strictEqual(paletteEntries(OPEN_SKILLS_MARKETPLACE_COMMAND_ID), 1);
		assert.strictEqual(pane(), undefined, 'no editor pane until it loads');

		await service.activate(SKILLS_FEATURE_ID);
		COMMANDS.forEach((id, i) => assert.notStrictEqual(CommandsRegistry.getCommand(id), stubs[i], `${id} is the module's own now`));
		assert.strictEqual(paletteEntries(OPEN_SKILLS_COMMAND_ID), 1, 'listed once');
		assert.ok(pane(), 'its editor pane is registered');
	});

	test('MOD-SKILLS-TOGGLE: disabling the extension unloads the page and closes its tab; enabling it needs no reload', async () => {
		const { service, features, open, closed } = setup();
		await service.activate(SKILLS_FEATURE_ID);
		const tab = new AgentCustomizeEditorInput();
		open.push({ groupId: 1, editor: tab });

		await features.setEnabled(SKILLS_FEATURE_ID, false);
		assert.strictEqual(service.isActive(SKILLS_FEATURE_ID), false);
		assert.deepStrictEqual(COMMANDS.filter(id => CommandsRegistry.getCommand(id)), [], 'its commands are gone, stubs included');
		assert.strictEqual(pane(), undefined, 'its editor pane is gone');
		assert.deepStrictEqual(closed.map(identifier => identifier.editor), [tab], 'its open tab closed');

		await features.setEnabled(SKILLS_FEATURE_ID, true);
		assert.ok(COMMANDS.every(id => CommandsRegistry.getCommand(id)), 'stubs are back');
		await service.activate(SKILLS_FEATURE_ID);
		assert.ok(pane());
		tab.dispose();
	});

	test('MOD-SKILLS-RESTORE: a restored tab waits as a placeholder; the title bar reads its trail through the contract', async () => {
		const { service, instantiation } = setup();
		const serializer = createVoltFeatureModuleEditorSerializer(SKILLS_FEATURE_ID, SKILLS_EDITOR_INPUT_TYPE_ID);
		const placeholder = serializer.deserialize(instantiation, '');
		assert.ok(placeholder instanceof VoltFeatureModuleEditorPlaceholder);
		assert.strictEqual(skillsTrail(placeholder), undefined, 'no trail before the module loads');
		await service.activate(SKILLS_FEATURE_ID);
		const real = placeholder.resolveModuleEditor(instantiation);
		assert.ok(real instanceof AgentCustomizeEditorInput);
		real.setCrumbs([{ label: 'Marketplace' }]);
		assert.deepStrictEqual(skillsTrail(real)?.crumbs.map(crumb => crumb.label), ['Marketplace']);
		placeholder.dispose();
		real.dispose();
	});

	test('MOD-SKILLS-GRANTS: it runs with only its manifest\'s grants (report mode: no would-be denial)', async () => {
		const { service, reporter } = setup();
		await service.activate(SKILLS_FEATURE_ID);
		assert.deepStrictEqual(reporter.reports, []);
	});
});
