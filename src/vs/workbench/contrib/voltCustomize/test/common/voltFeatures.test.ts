/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { voltPartIdFromContext } from '../../common/voltCustomizeContext.js';
import { CODE_ACTION_TOOL_NAME, CODE_NAV_TOOL_NAME, DIAGNOSTICS_TOOL_NAME } from '../../../../services/voltRuntime/common/codeIntelligence.js';
import { HOST_TOOL_SANDBOX_CLASSES } from '../../../../services/voltRuntime/common/hostToolSandbox.js';
import { DEV_ENVIRONMENT_FEATURE_ID, IDE_TOOL_NAMES } from '../../../../services/voltRuntime/common/ide/ideTools.js';
import { JOB_WATCH_TOOL_NAMES } from '../../../../services/voltRuntime/common/jobs/jobWatch.js';
import { ORCHESTRA_FEATURE_ID, ORCHESTRA_TOOL_NAMES } from '../../../../services/voltRuntime/common/orchestration/orchestra.js';
import { HTTP_CLIENT_FEATURE_ID, HTTP_CLIENT_SURFACE_ID } from '../../../voltHttp/common/voltHttp.js';
import { VOLT_FEATURE_MANIFESTS } from '../../common/voltFeatureManifests.generated.js';
import { IVoltFeatureService, loadVoltFeatures, VOLT_FEATURE_CATEGORIES, VOLT_FEATURES, VOLT_FEATURES_HAND_WRITTEN, VOLT_FEATURES_SOURCE, voltFeature, VoltFeatureCategoryId, voltFeatureContextKey, voltFeatureOn, voltFeatureOwning, voltFeatureSettingMatches, whileVoltFeatureOn } from '../../common/voltFeatures.js';
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

	test('FEAT-R4-1: Orchestra, Dev environment and the HTTP client are listed with their extensions and parts; job waits are core Terminals', () => {
		const listed = (id: string, extensionId: string) => {
			const feature = voltFeature(id);
			assert.ok(feature, `${id} is listed`);
			assert.strictEqual(feature.extensionId, extensionId);
			assert.ok(VOLT_FEATURE_MANIFESTS.some(manifest => `${manifest.publisher}.${manifest.name}` === extensionId && manifest.contributes?.voltModule?.feature === id), `${extensionId} carries ${id}`);
			return feature;
		};
		const orchestra = listed(ORCHESTRA_FEATURE_ID, 'volt.orchestra');
		assert.deepStrictEqual(orchestra.tools, [...ORCHESTRA_TOOL_NAMES]);
		assert.deepStrictEqual(orchestra.sections, ['orchestration'], 'Settings > Orchestration');
		assert.deepStrictEqual(orchestra.commands, ['volt.orchestra.measureCapacity']);
		const dev = listed(DEV_ENVIRONMENT_FEATURE_ID, 'volt.dev-environment');
		assert.deepStrictEqual(dev.tools, ['tests', 'debug', 'tasks', 'ide']);
		assert.deepStrictEqual(dev.tools, [...IDE_TOOL_NAMES]);
		const http = listed(HTTP_CLIENT_FEATURE_ID, 'volt.http-client');
		assert.deepStrictEqual(http.surfaces, [HTTP_CLIENT_SURFACE_ID], 'the right panel\'s + menu entry');
		assert.strictEqual(http.tools, undefined, 'agents send requests through the ide gateway (Dev environment)');
		// The language-server tools joined Code Intelligence.
		const codeIntelligence = listed('codeIntelligence', 'volt.code-intelligence');
		for (const name of [CODE_NAV_TOOL_NAME, DIAGNOSTICS_TOOL_NAME, CODE_ACTION_TOOL_NAME]) {
			assert.ok(codeIntelligence.tools?.includes(name), name);
		}
		// Each part has one switch.
		for (const name of ORCHESTRA_TOOL_NAMES) {
			assert.strictEqual(voltFeatureOwning('tool', name), ORCHESTRA_FEATURE_ID, name);
		}
		for (const name of IDE_TOOL_NAMES) {
			assert.strictEqual(voltFeatureOwning('tool', name), DEV_ENVIRONMENT_FEATURE_ID, name);
		}
		assert.strictEqual(voltFeatureOwning('section', 'orchestration'), ORCHESTRA_FEATURE_ID);
		assert.strictEqual(voltFeatureOwning('surface', HTTP_CLIENT_SURFACE_ID), HTTP_CLIENT_FEATURE_ID);
		// Job waits are Volt's core: under Terminals, with no switch.
		const terminals = voltFeature('terminals')!;
		assert.strictEqual(terminals.extensionId, undefined);
		for (const name of JOB_WATCH_TOOL_NAMES) {
			assert.ok(terminals.tools?.includes(name), name);
			assert.strictEqual(voltFeatureOwning('tool', name), undefined, `${name} has no switch`);
		}
	});

	test('FEAT-R4-3: every tool a feature lists is classified by the sandbox gate, and a manifest declares the class Volt gives it', () => {
		let checked = 0;
		for (const feature of VOLT_FEATURES) {
			for (const name of feature.tools ?? []) {
				assert.ok(Object.prototype.hasOwnProperty.call(HOST_TOOL_SANDBOX_CLASSES, name), `${feature.id}: ${name} is not classified (the gate refuses it for sandboxed chats)`);
				checked++;
			}
		}
		for (const name of ['orchestra', 'dev-environment', 'code-intelligence']) {
			const manifest = VOLT_FEATURE_MANIFESTS.find(entry => entry.name === name)!;
			const tools = manifest.contributes?.voltTools ?? [];
			assert.ok(tools.length, `${name} declares its tools`);
			for (const tool of tools) {
				assert.strictEqual(tool.class, HOST_TOOL_SANDBOX_CLASSES[tool.name], `${name}: ${tool.name}`);
			}
		}
		assert.strictEqual(HOST_TOOL_SANDBOX_CLASSES['machine_run'], 'escapes');
		assert.strictEqual(HOST_TOOL_SANDBOX_CLASSES['tests'], 'sandboxed');
		assert.ok(checked > 100, `checked ${checked} tools`);
	});

	test('FEAT-R4-5: a feature without a module: its when clause and what it keeps follow the switch', () => {
		const on = voltFeatureOn(HTTP_CLIENT_FEATURE_ID);
		const context = (value: boolean | undefined) => ({ getValue: <T>(key: string) => (key === voltFeatureContextKey(HTTP_CLIENT_FEATURE_ID) ? value : undefined) as T | undefined });
		assert.strictEqual(voltFeatureContextKey(HTTP_CLIENT_FEATURE_ID), 'voltFeature.httpClient');
		assert.strictEqual(on.evaluate(context(true)), true);
		assert.strictEqual(on.evaluate(context(false)), false, 'off: views and Command Palette entries go');
		// The eager feature service binds the key at startup; a part nothing has said is on stays hidden.
		assert.strictEqual(on.evaluate(context(undefined)), false);

		const changed = new Emitter<void>();
		const off = new Set<string>([DEV_ENVIRONMENT_FEATURE_ID]);
		const features: IVoltFeatureService = {
			_serviceBrand: undefined,
			onDidChange: changed.event,
			isEnabled: id => !off.has(id),
			isOn: () => true,
			setEnabled: async (id, enabled) => { if (enabled) { off.delete(id); } else { off.add(id); } changed.fire(); },
		};
		const made: string[] = [];
		const kept = whileVoltFeatureOn(features, DEV_ENVIRONMENT_FEATURE_ID, () => {
			made.push('made');
			return toDisposable(() => made.push('disposed'));
		});
		assert.deepStrictEqual(made, [], 'nothing while it is off');
		void features.setEnabled(DEV_ENVIRONMENT_FEATURE_ID, true);
		void features.setEnabled(HTTP_CLIENT_FEATURE_ID, false);
		assert.deepStrictEqual(made, ['made'], 'made once it turns on, and not again for another feature');
		void features.setEnabled(DEV_ENVIRONMENT_FEATURE_ID, false);
		assert.deepStrictEqual(made, ['made', 'disposed'], 'disposed when it turns off');
		void features.setEnabled(DEV_ENVIRONMENT_FEATURE_ID, true);
		kept.dispose();
		assert.deepStrictEqual(made, ['made', 'disposed', 'made', 'disposed'], 'and with the gate');
		changed.dispose();
	});
});
