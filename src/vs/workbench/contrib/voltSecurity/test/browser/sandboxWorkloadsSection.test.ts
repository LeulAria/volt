/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISandboxWorkloadInfo } from '../../../../../platform/voltSandbox/common/sandboxWorkloads.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltAgentServerMainService } from '../../../../../platform/voltAgentServer/common/agentServerService.js';
import { deniedSummary, freshDenials } from '../../browser/sandboxDenialNotifier.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { SandboxWorkloadsSection } from '../../browser/sandboxWorkloadsSection.js';

function workload(id: string, overrides: Partial<ISandboxWorkloadInfo> = {}): ISandboxWorkloadInfo {
	return {
		id,
		principalId: `p-${id}`,
		subject: `chat:${id}`,
		label: `host ${id}`,
		lifetime: 'host',
		backend: 'seatbelt',
		state: 'running',
		status: 'sandboxed',
		unenforced: [],
		attestation: { principalId: `p-${id}`, backend: 'seatbelt', backendVersion: 'n/a', osBuild: '25A1', launchPolicyHash: 'ab'.repeat(32), evidence: { sandbox_check: 1 }, canary: { credOpen: 'denied' }, unenforced: [], layers: { processTracking: { active: true, detail: 'kqueue' } }, attestedAt: 1 },
		policy: { name: 'workspace', network: 'none', allowedHosts: 0, readsEverything: false, read: ['~/ws'], write: ['~/ws'], denied: 3, limits: {} },
		startedAt: 1,
		restarts: 0,
		resources: { at: 1, cpuMs: 1500, memoryBytes: 64 * 1024 * 1024, processes: 2, sources: ['poll'] },
		...overrides,
	};
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) {
			throw new Error('timed out');
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

suite('Volt Security page: sandboxed processes (C5)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('SEC-PAGE-1: lists every workload with its principal, backend, attestation and resources; Stop ends it', async () => {
		const disposables = store.add(new DisposableStore());
		const changed = disposables.add(new Emitter<void>());
		let rows = [workload('a'), workload('b', { lifetime: 'command', status: 'partial', unenforced: ['network.listen'], label: 'claude agent' })];
		const stopped: string[] = [];
		const instantiation = workbenchInstantiationService(undefined, disposables);
		const stdio: Partial<IVoltStdioService> = {
			sandboxWorkloads: async () => rows,
			stopSandboxWorkload: async (id: string) => {
				stopped.push(id);
				rows = rows.filter(row => row.id !== id);
				changed.fire();
				return true;
			},
			onDidChangeSandboxWorkloads: changed.event,
		};
		instantiation.stub(IVoltStdioService, stdio);
		instantiation.stub(IVoltAgentServerMainService, {});
		const page = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		disposables.add({ dispose: () => page.remove() });
		const pageStore = disposables.add(new DisposableStore());
		instantiation.createInstance(SandboxWorkloadsSection, {
			store: pageStore,
			sectionLabel: label => void (page.appendChild(mainWindow.document.createElement('h3')).textContent = label),
			sectionHint: text => void (page.appendChild(mainWindow.document.createElement('p')).textContent = text),
			settingsGroup: () => page.appendChild(mainWindow.document.createElement('div')),
			isCurrent: () => true,
		}).render();

		const rowsShown = () => [...page.querySelectorAll<HTMLElement>('.volt-security-workload')];
		await until(() => rowsShown().length === 2);
		const [host, agent] = rowsShown();
		assert.match(host.textContent ?? '', /host a/);
		assert.match(host.textContent ?? '', /macOS Seatbelt, fully sandboxed, attested/);
		assert.match(host.textContent ?? '', /No network, writes 1 folders, 64 MB, 1\.5 s CPU, 2 processes/);
		assert.match(agent.textContent ?? '', /not enforced: network\.listen/);
		const detail = host.getAttribute('data-volt-tooltip') ?? '';
		assert.match(detail, /chat:a \(p-a\)/, 'the principal');
		assert.match(detail, /sandbox_check=1/, 'the attestation evidence');
		assert.match(detail, new RegExp('ab'.repeat(32)), 'the launch policy hash');
		assert.match(detail, /Second layers: processTracking on \(kqueue\)/, 'the second layers (C4)');
		assert.ok(page.querySelector('.volt-security-empty')?.hasAttribute('hidden'));

		host.querySelector<HTMLElement>('.monaco-button')!.click();
		await until(() => rowsShown().length === 1);
		assert.deepStrictEqual(stopped, ['a']);
		assert.match(rowsShown()[0].textContent ?? '', /claude agent/);

		rows = [];
		changed.fire();
		await until(() => !page.querySelector('.volt-security-empty')?.hasAttribute('hidden'));
		assert.strictEqual(rowsShown().length, 0);
	});

	test('SEC-PAGE-2: a host that reports nothing says so', () => {
		const disposables = store.add(new DisposableStore());
		const instantiation = workbenchInstantiationService(undefined, disposables);
		const silent: Partial<IVoltStdioService> = {};
		instantiation.stub(IVoltStdioService, silent);
		instantiation.stub(IVoltAgentServerMainService, {});
		const page = mainWindow.document.createElement('div');
		instantiation.createInstance(SandboxWorkloadsSection, {
			store: disposables.add(new DisposableStore()),
			sectionLabel: () => undefined,
			sectionHint: () => undefined,
			settingsGroup: () => page.appendChild(mainWindow.document.createElement('div')),
			isCurrent: () => true,
		}).render();
		assert.match(page.textContent ?? '', /not reported here/);
	});

	test('SEC-PAGE-MCP: an MCP server is listed with its server name and its chat; Stop ends it', async () => {
		const disposables = store.add(new DisposableStore());
		const changed = disposables.add(new Emitter<void>());
		let rows = [
			workload('m1', { label: 'MCP github', subject: `mcp:${'cd'.repeat(32)}`, onBehalfOf: { subject: 'chat:0f1e2d3c4b5a69788796' } }),
			workload('m2', { label: 'MCP linear', subject: `mcp:${'ef'.repeat(32)}`, onBehalfOf: { subject: 'chat:abc', label: 'Fix the login page' } }),
		];
		const stopped: string[] = [];
		const instantiation = workbenchInstantiationService(undefined, disposables);
		const stdio: Partial<IVoltStdioService> = {
			sandboxWorkloads: async () => rows,
			stopSandboxWorkload: async (id: string) => {
				stopped.push(id);
				rows = rows.filter(row => row.id !== id);
				changed.fire();
				return true;
			},
			onDidChangeSandboxWorkloads: changed.event,
		};
		instantiation.stub(IVoltStdioService, stdio);
		instantiation.stub(IVoltAgentServerMainService, {});
		const page = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		disposables.add({ dispose: () => page.remove() });
		instantiation.createInstance(SandboxWorkloadsSection, {
			store: disposables.add(new DisposableStore()),
			sectionLabel: () => undefined,
			sectionHint: () => undefined,
			settingsGroup: () => page.appendChild(mainWindow.document.createElement('div')),
			isCurrent: () => true,
		}).render();
		const rowsShown = () => [...page.querySelectorAll<HTMLElement>('.volt-security-workload')];
		await until(() => rowsShown().length === 2);
		const [byId, byTitle] = rowsShown();
		assert.match(byId.querySelector('.volt-security-workload-title')?.textContent ?? '', /^MCP github, chat 0f1e2d3c$/);
		assert.match(byTitle.querySelector('.volt-security-workload-title')?.textContent ?? '', /^MCP linear, chat Fix the login page$/);
		assert.match(byId.getAttribute('data-volt-tooltip') ?? '', /Works for: chat:0f1e2d3c4b5a69788796/);
		assert.match(byId.getAttribute('data-volt-tooltip') ?? '', new RegExp(`Principal: mcp:${'cd'.repeat(32)}`));
		byId.querySelector<HTMLElement>('.monaco-button')!.click();
		await until(() => rowsShown().length === 1);
		assert.deepStrictEqual(stopped, ['m1']);
	});

	test('SEC-PAGE-T3: the agent server\'s sandboxed extension hosts are listed beside the window\'s, with what was blocked; Stop goes to the server', async () => {
		const disposables = store.add(new DisposableStore());
		const instantiation = workbenchInstantiationService(undefined, disposables);
		instantiation.stub(IVoltStdioService, { sandboxWorkloads: async () => [workload('agent')] } satisfies Partial<IVoltStdioService>);
		let serverRows = [workload('ext', {
			label: 'extension volt-examples.volt-agent-lab', subject: 'plugin:volt-examples.volt-agent-lab@local', deniedCount: 3,
			denials: [{ kind: 'read', target: '~/.ssh/id_ed25519', at: 1, count: 2 }, { kind: 'network', target: 'evil.example:443', at: 2, count: 1 }],
		})];
		const stoppedOnServer: string[] = [];
		instantiation.stub(IVoltAgentServerMainService, {
			sandboxWorkloads: async () => serverRows,
			stopSandboxWorkload: async (id: string) => { stoppedOnServer.push(id); serverRows = []; return true; },
		} satisfies Partial<IVoltAgentServerMainService>);
		const page = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		disposables.add({ dispose: () => page.remove() });
		instantiation.createInstance(SandboxWorkloadsSection, {
			store: disposables.add(new DisposableStore()),
			sectionLabel: () => undefined,
			sectionHint: () => undefined,
			settingsGroup: () => page.appendChild(mainWindow.document.createElement('div')),
			isCurrent: () => true,
		}).render();
		const rowsShown = () => [...page.querySelectorAll<HTMLElement>('.volt-security-workload')];
		await until(() => rowsShown().length === 2);
		const ext = rowsShown().find(row => /volt-agent-lab/.test(row.textContent ?? ''))!;
		assert.match(ext.textContent ?? '', /3 blocked/);
		const detail = ext.getAttribute('data-volt-tooltip') ?? '';
		assert.match(detail, /Blocked: connect to evil\.example:443 \(1x/);
		assert.match(detail, /Blocked: read ~\/\.ssh\/id_ed25519 \(2x/);
		assert.ok(detail.indexOf('evil.example') < detail.indexOf('id_ed25519'), 'newest first');
		assert.ok(detail.indexOf('Blocked: ') < detail.indexOf('Network: '), 'the refusals come before the policy, which runs to dozens of lines');
		ext.querySelector<HTMLElement>('.monaco-button')!.click();
		await until(() => rowsShown().length === 1);
		assert.deepStrictEqual(stoppedOnServer, ['ext']);
	});

	test('SEC-DENY-1: the runtime warning names only new refusals of extension and plugin hosts, once each', () => {
		const seen = new Set<string>();
		const ext = workload('ext', { subject: 'plugin:acme.lab@local', denials: [{ kind: 'read', target: '~/.aws/credentials', at: 1, count: 1 }] });
		const chat = workload('chat', { denials: [{ kind: 'write', target: '/etc/hosts', at: 1, count: 1 }] });
		assert.deepStrictEqual(freshDenials(seen, [ext, chat]).map(fresh => [fresh.workload.id, fresh.denials.map(d => d.target)]), [['ext', ['~/.aws/credentials']]], 'chats warn in their transcript instead');
		assert.deepStrictEqual(freshDenials(seen, [ext]), [], 'the same refusal again is not news');
		const restarted = workload('ext-2', { subject: 'plugin:acme.lab@local', denials: [{ kind: 'read', target: '~/.aws/credentials', at: 3, count: 4 }, { kind: 'network', target: 'evil.example:443', at: 4, count: 1 }] });
		assert.deepStrictEqual(freshDenials(seen, [restarted]).map(fresh => fresh.denials.map(d => d.target)), [['evil.example:443']], 'a restarted host is the same extension');
		assert.strictEqual(deniedSummary([{ kind: 'read', target: '~/.ssh/id_ed25519' }]), 'it tried to read ~/.ssh/id_ed25519');
		assert.strictEqual(deniedSummary([{ kind: 'read', target: 'a' }, { kind: 'network', target: 'b:443' }]), 'it tried to read a and connect to b:443');
		assert.strictEqual(deniedSummary([{ kind: 'read', target: 'a' }, { kind: 'write', target: 'b' }, { kind: 'network', target: 'c:443' }, { kind: 'process', target: 'curl' }, { kind: 'limit', target: 'memory' }]), 'it tried to read a, write b, connect to c:443 and 2 more');
	});
});
