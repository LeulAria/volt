/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../../../platform/extensions/common/extensions.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ExtensionMessageCollector, ExtensionPoint, IExtensionPointUser } from '../../../../services/extensions/common/extensionsRegistry.js';
import { IVoltContributes, VOLT_CONTRIBUTION_POINTS } from '../../../../services/voltPlugins/common/voltContributions.js';
import { VOLT_EXTENSION_POINTS } from '../../../../services/voltPlugins/common/voltExtensionPoints.js';
import { IVoltHostToolProvider, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IVoltFeatureService } from '../../common/voltFeatures.js';
import { VoltPluginService } from '../../browser/voltPluginService.js';

suite('Volt plugin service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function description(id: string, builtin: boolean): IExtensionDescription {
		const [publisher, name] = id.split('.');
		return { identifier: new ExtensionIdentifier(id), publisher, name, version: '1.0.0', engines: { vscode: '*' }, isBuiltin: builtin, isUserBuiltin: false, isUnderDevelopment: false, extensionLocation: URI.file(`/ext/${id}`), targetPlatform: 'undefined' } as unknown as IExtensionDescription;
	}

	/** What the extension service hands the registry: every enabled extension's Volt points. */
	function load(extensions: readonly { readonly id: string; readonly builtin?: boolean; readonly contributes: IVoltContributes }[], errors: string[]) {
		for (const point of VOLT_CONTRIBUTION_POINTS) {
			const users: IExtensionPointUser<unknown>[] = [];
			for (const extension of extensions) {
				const value = extension.contributes[point];
				if (value !== undefined) {
					const desc = description(extension.id, !!extension.builtin);
					users.push({ description: desc, value, collector: new ExtensionMessageCollector(message => errors.push(`${message.extensionId.value}: ${message.message}`), desc, point) });
				}
			}
			const extensionPoint = VOLT_EXTENSION_POINTS[point];
			assert.ok(extensionPoint instanceof ExtensionPoint);
			extensionPoint.acceptUsers(users);
		}
	}

	function setup() {
		const providers = new Set<IVoltHostToolProvider>();
		const hostTools = {
			registerToolProvider: (provider: IVoltHostToolProvider) => {
				providers.add(provider);
				return toDisposable(() => providers.delete(provider));
			},
			invokeTool: async (name: string) => ({ text: `ran ${name}` }),
		} as unknown as IVoltHostToolService;
		const features = { isOn: () => true } as unknown as IVoltFeatureService;
		const warnings: string[] = [];
		const log = new class extends NullLogService { override warn(message: string) { warnings.push(message); } };
		const storage = store.add(new InMemoryStorageService());
		const service = store.add(new VoltPluginService(hostTools, storage, new TestConfigurationService(), {} as unknown as ICommandService, features, log));
		store.add(toDisposable(() => load([], [])));
		return { service, providers, warnings };
	}

	const notes: IVoltContributes = {
		voltModule: { feature: 'notes', label: 'Notes', description: 'Notes.', category: 'productivity', icon: 'note', order: 1 },
		voltTools: [{ name: 'notes_read', class: 'safe' }],
		voltCapabilities: { required: [{ id: 'tools.register', class: 'low' }] },
	};

	test('reads valid contributions, reports invalid ones on their extension and leaves them out', async () => {
		const { service } = setup();
		const errors: string[] = [];
		load([
			{ id: 'volt.notes', builtin: true, contributes: notes },
			{ id: 'acme.bad', contributes: { ...notes, voltModule: { ...notes.voltModule!, feature: 'bad' }, voltTools: [{ name: 'desktop_act', class: 'safe' }] } },
		], errors);
		await timeout(1);
		assert.deepStrictEqual(service.plugins().map(plugin => [plugin.extensionId, plugin.firstParty]), [['volt.notes', true], ['acme.bad', false]]);
		assert.deepStrictEqual(service.plugin('volt.notes')?.manifest.contributes, notes);
		assert.strictEqual(service.plugin('acme.bad')?.manifest.contributes?.voltTools, undefined);
		assert.deepStrictEqual(errors, ['acme.bad: contributes.voltTools: desktop_act is a "escapes" tool and can\'t be declared "safe"']);
	});

	test('a context runs in report mode, and an extension that goes away is unloaded', async () => {
		const { service, providers, warnings } = setup();
		load([{ id: 'volt.notes', builtin: true, contributes: notes }], []);
		await timeout(1);
		const context = service.getContext('volt.notes')!;
		assert.strictEqual(context.featureId, 'notes');
		assert.strictEqual(service.getContext('volt.notes'), context, 'one context per extension');
		context.volt.tools.register('notes_read', () => ({ text: 'n' }));
		assert.strictEqual(providers.size, 1);
		// Not declared: logged, still runs.
		context.volt.storage.set('k', 1);
		assert.strictEqual((await context.volt.agents.create({ title: 'x' })).text, 'ran thread_launch');
		assert.deepStrictEqual(service.reporter.reports.map(report => report.capability), ['agents.create']);
		assert.strictEqual(warnings.length, 1);

		// Disabled: its contributions are gone, and so is what it registered.
		load([], []);
		await timeout(1);
		assert.strictEqual(service.plugin('volt.notes'), undefined);
		assert.strictEqual(providers.size, 0);
		assert.strictEqual(service.getContext('volt.notes'), undefined);
	});
});
