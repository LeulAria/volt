/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { voltPartIdFromContext } from '../../common/voltCustomizeContext.js';
import { HOST_TOOL_SANDBOX_CLASSES } from '../../../../services/voltRuntime/common/hostToolSandbox.js';
import { VOLT_FEATURE_MANIFESTS } from '../../common/voltFeatureManifests.generated.js';
import { loadVoltFeatures, VOLT_FEATURE_CATEGORIES, VOLT_FEATURES, VOLT_FEATURES_HAND_WRITTEN, VOLT_FEATURES_SOURCE, VoltFeatureCategoryId, voltFeatureOwning, voltFeatureSettingMatches } from '../../common/voltFeatures.js';
import { resolveVoltSlotPlacement, unplacedVoltSlotItems, VOLT_SLOT_ITEMS } from '../../common/voltSlots.js';

suite('Volt features', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ids and extensions are unique, and every category exists', () => {
		const ids = VOLT_FEATURES.map(feature => feature.id);
		assert.strictEqual(new Set(ids).size, ids.length);
		const extensions = VOLT_FEATURES.flatMap(feature => feature.extensionId ? [feature.extensionId] : []);
		assert.strictEqual(new Set(extensions).size, extensions.length);
		assert.ok(extensions.every(id => /^volt\.[a-z0-9-]+$/.test(id)), extensions.join(', '));
		const categories = new Set(VOLT_FEATURE_CATEGORIES.map(category => category.id));
		assert.deepStrictEqual(VOLT_FEATURES.filter(feature => !categories.has(feature.category)).map(feature => feature.id), []);
	});

	test('a part belongs to at most one optional feature, and core parts to none', () => {
		const seen = new Map<string, string>();
		for (const feature of VOLT_FEATURES.filter(entry => entry.extensionId)) {
			for (const [part, list] of [['item', feature.items], ['section', feature.sections], ['tool', feature.tools], ['provider', feature.providers]] as const) {
				for (const id of list ?? []) {
					const key = `${part}:${id}`;
					assert.ok(!seen.has(key), `${key} is in ${seen.get(key)} and ${feature.id}`);
					seen.set(key, feature.id);
				}
			}
		}
		assert.strictEqual(voltFeatureOwning('tool', 'manage_automations'), 'automations');
		assert.strictEqual(voltFeatureOwning('provider', 'grok'), 'provider.grok');
		assert.strictEqual(voltFeatureOwning('item', 'volt.usage'), 'usage');
		// Core: chats, queues and the settings gear have no switch.
		assert.strictEqual(voltFeatureOwning('tool', 'thread_send'), undefined);
		assert.strictEqual(voltFeatureOwning('tool', 'queue_send_now'), undefined);
		assert.strictEqual(voltFeatureOwning('item', 'volt.settings'), undefined);
	});

	test('every button a feature names is a real slot item', () => {
		const items = new Set(VOLT_SLOT_ITEMS.map(item => item.id));
		assert.deepStrictEqual(VOLT_FEATURES.flatMap(feature => feature.items ?? []).filter(id => !items.has(id)), []);
	});

	test('a turned-off button goes nowhere, even where a layout names it', () => {
		const off = new Set(['volt.usage', 'volt.extensions']);
		const placement = resolveVoltSlotPlacement({ 'sidebar.header': ['volt.usage'], 'activityBar.top': ['volt.extensions', 'volt.search'] }, id => !off.has(id));
		assert.ok(!placement['sidebar.header'].includes('volt.usage'));
		assert.ok(!placement['sidebar.footer'].includes('volt.usage'));
		assert.deepStrictEqual(placement['activityBar.top'], ['volt.search']);
		assert.ok(!unplacedVoltSlotItems(placement, id => !off.has(id)).includes('volt.extensions'));
		// With everything on, nothing changes.
		assert.deepStrictEqual(resolveVoltSlotPlacement(undefined, () => true), resolveVoltSlotPlacement(undefined));
	});

	test('a capability chip leads back to its row', () => {
		assert.strictEqual(voltPartIdFromContext('<volt_capability id="volt/usage" label="Usage" kind="feature">\nmore'), 'volt/usage');
		assert.strictEqual(voltPartIdFromContext('<volt_part id="composer" label="Message box">'), 'composer');
		assert.strictEqual(voltPartIdFromContext('<volt_other id="x">'), undefined);
	});

	test('M1 catalog parity: the catalog generated from the manifests deep-equals the hand-written one', () => {
		assert.deepStrictEqual(VOLT_FEATURES_SOURCE, { source: 'manifests' });
		assert.strictEqual(VOLT_FEATURE_MANIFESTS.length, 33);
		assert.deepStrictEqual(VOLT_FEATURES, VOLT_FEATURES_HAND_WRITTEN);
	});

	test('M1 rollback: manifests that do not validate fall back to the hand-written catalog', () => {
		const broken = VOLT_FEATURE_MANIFESTS.map(manifest => manifest.name === 'usage'
			? { ...manifest, contributes: { ...manifest.contributes, voltModule: { ...manifest.contributes!.voltModule!, category: 'nowhere' as VoltFeatureCategoryId } } }
			: manifest);
		const loaded = loadVoltFeatures(broken);
		assert.strictEqual(loaded.source, 'hand-written');
		assert.match(loaded.error ?? '', /volt\.usage: contributes\.voltModule\.category/);
		assert.strictEqual(loaded.features, VOLT_FEATURES_HAND_WRITTEN);
		// Two manifests claiming one feature id also fall back.
		const twice = [...VOLT_FEATURE_MANIFESTS, { ...VOLT_FEATURE_MANIFESTS[0], name: 'copy' }];
		assert.strictEqual(loadVoltFeatures(twice).source, 'hand-written');
	});

	test('M1: a manifest tool declares the class Volt gives it', () => {
		for (const manifest of VOLT_FEATURE_MANIFESTS) {
			for (const tool of manifest.contributes?.voltTools ?? []) {
				assert.strictEqual(tool.class, HOST_TOOL_SANDBOX_CLASSES[tool.name], `${manifest.name}: ${tool.name}`);
			}
		}
	});

	test('setting prefixes match keys under them only', () => {
		const automations = VOLT_FEATURES.find(feature => feature.id === 'automations')!;
		assert.ok(voltFeatureSettingMatches(automations, 'volt.automations.enabled'));
		assert.ok(!voltFeatureSettingMatches(automations, 'volt.automationsX'));
	});
});
