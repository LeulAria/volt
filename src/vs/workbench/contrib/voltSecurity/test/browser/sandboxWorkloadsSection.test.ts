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
});
