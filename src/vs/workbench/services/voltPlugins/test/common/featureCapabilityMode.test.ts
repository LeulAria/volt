/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Ceilings enforced (spec M.4 M5, G.10, G.12). M5-MODE-1: a built-in is enforced only when its
// manifest and its own API namespace show 0 would-be denials under enforcement. M5-ENFORCE-1, 2: an
// enforced built-in calling beyond its manifest or ceiling is refused before Volt runs anything,
// while a report-mode one is logged and runs. M5-ZERO-PROMPT-1, 2: in-ceiling first-party calls are
// allowed with no prompt and without ever consulting the consent store.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { declarationsOutsideCeiling, FIRST_PARTY_ENFORCED, firstPartyCapabilityMode, firstPartyCeiling } from '../../../../../platform/voltPlugins/common/firstPartyCeilings.js';
import { VOLT_FEATURE_MANIFESTS } from '../../../../contrib/voltCustomize/common/voltFeatureManifests.generated.js';
import { HOST_TOOL_SANDBOX_CLASSES } from '../../../voltRuntime/common/hostToolSandbox.js';
import { ICapabilityReporter, ICapabilityRequest, IVoltPluginPrincipal, IWouldBeDenial, toolClassCapability, VoltCapabilityError } from '../../common/capabilities.js';
import { IVoltConsentStore, VoltExtensionCapabilityPolicy } from '../../common/extensionCapabilityPolicy.js';
import { VoltFeatureCapabilityReporter } from '../../common/featureCapabilityMode.js';
import { createVoltApi, IVoltApi, IVoltApiBackend } from '../../common/voltApi.js';
import { IVoltCapabilityDeclaration, IVoltPluginManifest } from '../../common/voltContributions.js';

function idOf(manifest: IVoltPluginManifest): string {
	return `${manifest.publisher}.${manifest.name}`;
}

function principalOf(manifest: IVoltPluginManifest, capabilities = manifest.contributes?.voltCapabilities ?? {}): IVoltPluginPrincipal {
	return { extensionId: idOf(manifest), firstParty: true, capabilities };
}

/** A concrete request for each declared capability and target (`*` filled in). */
function declaredRequests(declared: readonly IVoltCapabilityDeclaration[]): ICapabilityRequest[] {
	return declared.flatMap(entry => {
		const capability = entry.id.replace(/:\*$/, entry.id.startsWith('net.listen') ? ':5173' : ':example');
		const targets = entry.targets?.length ? entry.targets.map(target => target.replace(/\*/g, 'x')) : [undefined];
		return targets.map(target => ({ api: 'declared', capability, ...(target !== undefined ? { target } : {}) }));
	});
}

function fakeBackend(store: DisposableStore, calls: string[]): IVoltApiBackend {
	const settings = store.add(new Emitter<{ affects(key: string): boolean }>());
	const note = { name: 'n', description: 'd', body: 'b', type: 'project' as const, scope: 'project' as const };
	return {
		registerTool: info => { calls.push(`registerTool:${info.name}`); return toDisposable(() => { }); },
		invokeTool: async name => { calls.push(`invokeTool:${name}`); return { text: name }; },
		storageGet: () => undefined,
		storageSet: () => { },
		storageKeys: () => [],
		getSetting: () => undefined,
		updateSetting: async () => { },
		onDidChangeSettings: settings.event,
		executeCommand: async id => { calls.push(`executeCommand:${id}`); },
		registerCommand: () => toDisposable(() => { }),
		isOn: () => true,
		listChats: async () => [],
		currentChat: () => undefined,
		listMemories: async () => [],
		readMemory: async () => undefined,
		writeMemory: async () => note as never,
		deleteMemory: async () => true,
		openBrowser: async () => { calls.push('openBrowser'); },
		browserPageUrl: async () => undefined,
		listAutomations: async () => [],
		scheduleAutomation: async () => ({}) as never,
		readUsage: async () => ({}) as never,
		listPullRequests: async () => [],
	};
}

/** What each built-in calls through its own API namespace, beyond its tools and declared capabilities. */
const OWN_NAMESPACE: Readonly<Record<string, (volt: IVoltApi) => Promise<unknown>[]>> = {
	'volt.memory': volt => [volt.memory.list(), volt.memory.read('n'), volt.memory.write({ name: 'n', description: 'd', body: 'b' }), volt.memory.delete('n')],
	'volt.browser': volt => [volt.browser.open('https://example.com/'), volt.browser.readPage({ chatId: 'chat-1' })],
	'volt.visuals': volt => [volt.visuals.renderChart({ charts: [] } as never), volt.visuals.drawOnScratch({} as never)],
	'volt.automations': volt => [volt.automations.list(), volt.automations.schedule({ name: 'nightly', instructions: 'x', schedule: {} as never, chatId: 'chat-1' })],
	'volt.usage': volt => [volt.usage.get(), volt.net.fetch({ url: 'https://api.example.com/usage', secret: volt.secrets.ref('claude') } as never)],
	'volt.pull-requests': volt => [volt.pullRequests.list('chat-1'), volt.pullRequests.link('chat-1', 'https://github.com/o/r/pull/1')],
	'volt.provider-openrouter': volt => [volt.net.fetch({ url: 'https://openrouter.ai/api/v1/models', secret: volt.secrets.ref('openrouter') } as never)],
};

suite('Volt first-party ceilings enforced (M5)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** Runs a built-in's whole surface under enforcement and returns what would be denied (nothing is refused). */
	async function wouldBeDenials(manifest: IVoltPluginManifest): Promise<IWouldBeDenial[]> {
		const disposables = store.add(new DisposableStore());
		const policy = disposables.add(new VoltExtensionCapabilityPolicy({ state: () => undefined }));
		const denials: IWouldBeDenial[] = [];
		const recording: ICapabilityReporter = {
			mode: 'report',
			onDidReport: policy.onDidReport,
			check: (principal, request) => {
				const verdict = policy.check(principal, request);
				if (verdict.denial) {
					denials.push(verdict.denial);
				}
				return { allowed: true };
			},
		};
		const principal = principalOf(manifest);
		const declared = [...principal.capabilities.required ?? [], ...principal.capabilities.optional ?? []];
		for (const request of declaredRequests(declared)) {
			recording.check(principal, request);
		}
		const volt = createVoltApi(principal, manifest, fakeBackend(disposables, []), recording, disposables);
		for (const tool of manifest.contributes?.voltTools ?? []) {
			volt.tools.register(tool.name, () => ({ text: '' }));
		}
		const own = OWN_NAMESPACE[principal.extensionId];
		if (own) {
			await Promise.allSettled(own(volt));
		}
		disposables.dispose();
		return denials;
	}

	test('M5-MODE-1: only built-ins with 0 would-be denials under enforcement are enforced', async () => {
		const zero: string[] = [];
		const denied = new Map<string, string[]>();
		for (const manifest of VOLT_FEATURE_MANIFESTS) {
			const denials = await wouldBeDenials(manifest);
			if (denials.length) {
				denied.set(idOf(manifest), denials.map(denial => `${denial.capability}:${denial.deniedBy}`));
			} else {
				zero.push(idOf(manifest));
			}
		}
		for (const id of FIRST_PARTY_ENFORCED) {
			assert.ok(firstPartyCeiling(id), `${id} is enforced but has no ceiling`);
			assert.ok(zero.includes(id), `${id} is enforced but would be denied: ${denied.get(id)?.join(', ')}`);
		}
		// The evidence the list was made from: every built-in not enforced has a would-be denial today.
		assert.deepStrictEqual(zero.filter(id => !FIRST_PARTY_ENFORCED.has(id)), [], 'a built-in shows 0 would-be denials but is not enforced; add it after its release in report mode');
	});

	test('M5-ENFORCE-1: an enforced built-in calling beyond its manifest or its ceiling is refused before Volt runs anything', async () => {
		const reporter = store.add(new VoltFeatureCapabilityReporter(() => { }));
		const calls: string[] = [];
		const disposables = store.add(new DisposableStore());
		const manifest = VOLT_FEATURE_MANIFESTS.find(entry => idOf(entry) === 'volt.code-intelligence')!;
		assert.strictEqual(firstPartyCapabilityMode('volt.code-intelligence'), 'enforce');
		// Undeclared: refused by the manifest.
		const volt = createVoltApi(principalOf(manifest), manifest, fakeBackend(disposables, calls), reporter, disposables);
		// The check throws before the call starts; the async wrapper turns that into the rejection.
		await assert.rejects(async () => volt.agents.create({ title: 'x' }), (error: VoltCapabilityError) => error.name === VoltCapabilityError.NAME && error.deniedBy === 'manifest' && error.capability === 'agents.create');
		// A tampered manifest that declares more: refused by the compiled ceiling.
		const widened = { required: [...manifest.contributes!.voltCapabilities!.required!, { id: 'agents.send', class: 'medium' as const }] };
		const tampered = createVoltApi(principalOf(manifest, widened), manifest, fakeBackend(disposables, calls), reporter, disposables);
		await assert.rejects(async () => tampered.agents.send('chat-1', 'run rm -rf'), (error: VoltCapabilityError) => error.deniedBy === 'ceiling' && error.capability === 'agents.send');
		// Critical never passes, declared or not.
		assert.throws(() => tampered.tools.register('desktop_act', () => ({ text: '' })), (error: VoltCapabilityError) => error.deniedBy === 'manifest' || error.deniedBy === 'critical');
		assert.deepStrictEqual(calls, [], 'nothing reached Volt');
		assert.deepStrictEqual(reporter.reports, [], 'enforcement is not report mode');
		disposables.dispose();
	});

	test('M5-ENFORCE-2: the same call from a report-mode built-in runs and is logged once', async () => {
		const logs: string[] = [];
		const reporter = store.add(new VoltFeatureCapabilityReporter(message => logs.push(message)));
		const calls: string[] = [];
		const disposables = store.add(new DisposableStore());
		const manifest = VOLT_FEATURE_MANIFESTS.find(entry => idOf(entry) === 'volt.memory')!;
		assert.strictEqual(firstPartyCapabilityMode('volt.memory'), 'report');
		const volt = createVoltApi(principalOf(manifest), manifest, fakeBackend(disposables, calls), reporter, disposables);
		await volt.agents.create({ title: 'x' });
		await volt.agents.create({ title: 'y' });
		assert.deepStrictEqual(calls, ['invokeTool:thread_launch', 'invokeTool:thread_launch']);
		assert.deepStrictEqual(reporter.reports.map(report => `${report.extensionId}:${report.capability}:${report.deniedBy}`), ['volt.memory:agents.create:manifest']);
		assert.strictEqual(logs.length, 1);
		// A third party is never enforced through this path, whatever its id says.
		assert.strictEqual(reporter.modeFor({ extensionId: 'volt.code-intelligence', firstParty: false, capabilities: {} }), 'report');
		// Case does not change the mode, and an unknown built-in stays in report mode.
		assert.strictEqual(firstPartyCapabilityMode('VOLT.Code-Intelligence'), 'enforce');
		assert.strictEqual(firstPartyCapabilityMode('volt.notreal'), 'report');
		disposables.dispose();
	});

	test('M5-ZERO-PROMPT-1: every in-ceiling call of an enforced built-in is allowed with no prompt', () => {
		const reporter = store.add(new VoltFeatureCapabilityReporter(() => { }));
		let checked = 0;
		for (const manifest of VOLT_FEATURE_MANIFESTS.filter(entry => FIRST_PARTY_ENFORCED.has(idOf(entry)))) {
			const principal = principalOf(manifest);
			for (const request of declaredRequests([...principal.capabilities.required ?? [], ...principal.capabilities.optional ?? []])) {
				assert.deepStrictEqual(reporter.check(principal, request), { allowed: true }, `${principal.extensionId} ${request.capability} ${request.target ?? ''}`);
				checked++;
			}
		}
		assert.ok(checked > 20, `checked ${checked} calls`);
	});

	test('FEAT-R4-2: Orchestra, Dev environment and the HTTP client: a ceiling as narrow as the manifest, enforced or in report mode for a reason', async () => {
		const declaredIds = (manifest: IVoltPluginManifest) => {
			const capabilities = manifest.contributes?.voltCapabilities ?? {};
			return [...capabilities.required ?? [], ...capabilities.optional ?? []];
		};
		for (const id of ['volt.orchestra', 'volt.dev-environment', 'volt.http-client', 'volt.code-intelligence']) {
			const manifest = VOLT_FEATURE_MANIFESTS.find(entry => idOf(entry) === id)!;
			const ceiling = firstPartyCeiling(id);
			assert.ok(ceiling, `${id} has a first-party ceiling`);
			const declared = declaredIds(manifest);
			assert.deepStrictEqual(declarationsOutsideCeiling(id, declared), [], `${id} declares only what its ceiling holds`);
			assert.deepStrictEqual(ceiling.filter(entry => !declared.some(declaration => declaration.id === entry.id)).map(entry => entry.id), [], `${id}'s ceiling holds nothing its manifest doesn't declare`);
			// Every tool it serves: the capability its class implies is declared, so serving it is never refused for that.
			for (const tool of manifest.contributes?.voltTools ?? []) {
				const implied = toolClassCapability(HOST_TOOL_SANDBOX_CLASSES[tool.name]);
				assert.ok(declared.some(declaration => declaration.id === implied), `${id}: ${tool.name} (${HOST_TOOL_SANDBOX_CLASSES[tool.name]}) needs ${implied}`);
			}
			// Every declaration says why (the extension page and the consent dialog show it).
			for (const declaration of declared.filter(entry => entry.id !== 'tools.register')) {
				assert.ok(declaration.reason?.trim(), `${id}: ${declaration.id} has no reason`);
			}
		}
		// The HTTP client declares nothing critical: 0 would-be denials, so it is enforced.
		const http = VOLT_FEATURE_MANIFESTS.find(entry => idOf(entry) === 'volt.http-client')!;
		assert.deepStrictEqual(await wouldBeDenials(http), []);
		assert.strictEqual(firstPartyCapabilityMode('volt.http-client'), 'enforce');
		// Orchestra and Dev environment run programs on the host (spawn.unsandboxed; the ide gateway's
		// extensions capability runs commands, commands.execute:*). The API never grants critical, so
		// their only would-be denials are those, and they stay in report mode until that changes.
		for (const id of ['volt.orchestra', 'volt.dev-environment']) {
			const manifest = VOLT_FEATURE_MANIFESTS.find(entry => idOf(entry) === id)!;
			const denials = await wouldBeDenials(manifest);
			assert.ok(denials.length, `${id} shows its would-be denials`);
			assert.deepStrictEqual(denials.filter(denial => denial.deniedBy !== 'critical').map(denial => `${denial.capability}:${denial.deniedBy}`), [], `${id}: every would-be denial is a critical capability`);
			const critical = new Set(declaredIds(manifest).filter(entry => entry.class === 'critical').map(entry => entry.id.replace(/:\*$/, '')));
			assert.ok(denials.every(denial => [...critical].some(capability => denial.capability.startsWith(capability))), `${id}: ${denials.map(denial => denial.capability).join(', ')}`);
			assert.strictEqual(firstPartyCapabilityMode(id), 'report');
		}
	});

	test('M5-ZERO-PROMPT-2: a built-in never consults consent, so it is never asked (G.12)', () => {
		const consents: IVoltConsentStore = { state: () => { throw new Error('first party looked up consent'); } };
		const policy = store.add(new VoltExtensionCapabilityPolicy(consents));
		for (const manifest of VOLT_FEATURE_MANIFESTS) {
			const principal = principalOf(manifest);
			for (const request of declaredRequests([...principal.capabilities.required ?? [], ...principal.capabilities.optional ?? []])) {
				const verdict = policy.check(principal, request);
				assert.ok(!verdict.denial?.promptable, `${principal.extensionId} ${request.capability} would prompt`);
				assert.notStrictEqual(verdict.denial?.deniedBy, 'consent', `${principal.extensionId} ${request.capability}`);
			}
		}
	});
});
