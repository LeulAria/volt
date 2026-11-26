/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P4 in the window: the denial card, gesture tokens, the install sheet, the Access page and the
 * trust service's grant path. A test can't make a trusted input event, so these prove the
 * refusals (synthetic clicks, forged tokens, inert buttons) and drive the grant path with tokens
 * the registry minted, the way a trusted click would.
 */

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../../../platform/extensions/common/extensions.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IGrant } from '../../../../../platform/voltSandbox/common/grants.js';
import { SubjectKey } from '../../../../../platform/voltSandbox/common/principals.js';
import { ISandboxDenial } from '../../../../../platform/voltSandbox/common/sandboxDenials.js';
import { EMPTY_TRUST_STATE, GestureTokenRegistry, ITrustChange, ITrustState, PromptBudget } from '../../../../../platform/voltSandbox/common/trust.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IVoltPluginPrincipal } from '../../../../services/voltPlugins/common/capabilities.js';
import { IStoredConsents, IVoltConsentStore, VoltExtensionCapabilityPolicy } from '../../../../services/voltPlugins/common/extensionCapabilityPolicy.js';
import { showVoltExtensionConsent } from '../../../voltCustomize/browser/voltExtensionConsent.js';
import { IVoltExtensionApiService } from '../../../../services/voltPlugins/common/voltExtensionApi.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { VoltTrustService } from '../../../../services/voltTrust/browser/voltTrustService.js';
import { IVoltTrustService } from '../../../../services/voltTrust/common/voltTrust.js';
import { renderSandboxDenialCard, RUN_OUTSIDE_CONFIRMATION } from '../../../voltAgent/browser/editor/sandboxDenialCard.js';
import { AccessPageSection } from '../../browser/accessPage.js';
import { installSheetDrafts, installSheetGroups, installSheetKey } from '../../browser/installSheet.js';
import { permissionsSummaryText } from '../../browser/permissionsSummary.js';

async function until(check: () => boolean, ms = 3_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) {
			throw new Error('timed out');
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

function grant(id: string, subject: SubjectKey, overrides: Partial<IGrant> = {}): IGrant {
	return { id, subject, capability: 'net.connect@1', scope: { targets: ['api.test'] }, kind: 'session', sessionId: subject.slice('chat:'.length), source: 'user', grantedAt: 1, lastUsedAt: 2, epoch: 1, ...overrides };
}

/** A trust service double: records what the window asked of it. */
class FakeTrust implements IVoltTrustService {
	declare readonly _serviceBrand: undefined;
	state: ITrustState = EMPTY_TRUST_STATE;
	readonly onDidChange: Event<ITrustState>;
	readonly whenReady = Promise.resolve();
	readonly budget = new PromptBudget();
	readonly gestures = new GestureTokenRegistry();
	readonly approvals: unknown[][] = [];
	readonly refusals: string[] = [];
	readonly narrowed: ITrustChange[] = [];
	resets = 0;
	constructor(private readonly changes: Emitter<ITrustState>) {
		this.onDidChange = changes.event;
	}
	async refresh() { return this.state; }
	async grant() { return { epoch: 1, changed: true }; }
	async narrow(change: ITrustChange) {
		this.narrowed.push(change);
		this.state = { ...this.state, epoch: this.state.epoch + 1, grants: this.state.grants.filter(grant => !change.revoke?.includes(grant.id)) };
		this.changes.fire(this.state);
		return { epoch: this.state.epoch, changed: true };
	}
	async record() { return { epoch: 1, changed: true }; }
	async approveDenial(...args: unknown[]) { this.approvals.push(args); return { ok: true as const, epoch: 2 }; }
	async refuseDenial(_processId: string, denialId: string) { this.refusals.push(denialId); }
	async history() { return [{ at: 5, source: 'network' as const, subject: 'chat:c1' as const, action: 'CONNECT', target: 'api.test', decision: 'allow' as const }, { at: 4, source: 'decision' as const, subject: 'plugin:acme.notes@local' as const, action: 'agents.send', decision: 'deny' as const, reason: 'needs consent' }]; }
	async brokerBudgets() { return [{ subject: 'chat:c1' as const, refusals: 2, autoDenied: true, promptsToday: 1 }]; }
	async resetBudgets() { this.resets++; }
}

suite('Volt permission UX in the window (P4)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function card(denial: ISandboxDenial, overrides: { processId?: string } = {}) {
		const disposables = store.add(new DisposableStore());
		const trust = new FakeTrust(disposables.add(new Emitter<ITrustState>()));
		const tray = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		disposables.add({ dispose: () => tray.remove() });
		const calls: string[] = [];
		renderSandboxDenialCard(tray, {
			denial, chatId: 'c1', trust,
			processId: () => 'processId' in overrides ? overrides.processId : 'proc-1',
			dismiss: () => calls.push('dismiss'),
			retry: () => calls.push('retry'),
			allowFolder: () => calls.push('folder'),
			runOutside: () => calls.push('outside'),
			openAccess: () => calls.push('access'),
		}, disposables);
		const buttons = () => [...tray.querySelectorAll<HTMLElement>('.monaco-button')].map(button => button.textContent ?? '');
		const button = (label: string) => [...tray.querySelectorAll<HTMLElement>('.monaco-button')].find(candidate => candidate.textContent === label)!;
		return { tray, trust, calls, buttons, button };
	}

	test('UX-FORGE-1 / UX-1: only a denial the broker recorded gets Allow buttons; an agent-printed one gets none', () => {
		const forged = card({ kind: 'network', target: 'evil.test', source: 'output' });
		assert.deepStrictEqual(forged.buttons(), ['Skip', 'Run Outside Sandbox'], 'no Allow for a denial without the broker\'s record');
		const real = card({ kind: 'network', target: 'api.test', source: 'proxy', denialId: 'd1', epoch: 3 });
		assert.deepStrictEqual(real.buttons(), ['Skip', 'Allow for This Chat', 'Allow', 'Run Outside Sandbox']);
		assert.match(real.tray.textContent ?? '', /only reaches the hosts it was allowed/, 'why, in Volt\'s words');
	});

	test('UX-3: a spent prompt budget offers no Allow, only the way to Settings, Access', () => {
		const spent = card({ kind: 'network', target: 'api.test', source: 'proxy', denialId: 'd1', epoch: 3, promptable: false });
		assert.deepStrictEqual(spent.buttons(), ['Skip', 'Review Access', 'Run Outside Sandbox']);
		spent.button('Review Access').click();
		assert.deepStrictEqual(spent.calls, ['access']);
	});

	test('UX-2 / UX-5: Allow is inert for 500 ms, and a synthetic click never approves; Skip counts as a refusal', async () => {
		const { trust, button, calls } = card({ kind: 'network', target: 'api.test', source: 'proxy', denialId: 'd1', epoch: 3 });
		assert.ok(button('Allow').classList.contains('disabled'), 'inert when shown');
		button('Allow').click();
		await until(() => !button('Allow').classList.contains('disabled'), 2_000);
		button('Allow').dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
		button('Allow').click();
		button('Allow for This Chat').click();
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepStrictEqual(trust.approvals, [], 'element.click() is not the user (isTrusted false): no token, no approval');
		button('Skip').click();
		await until(() => trust.refusals.length === 1);
		assert.deepStrictEqual(trust.refusals, ['d1']);
		assert.deepStrictEqual(calls, ['dismiss']);
	});

	test('UX-4: running outside the sandbox (critical) is never one click: the word must be typed, then a real click', () => {
		const { tray, button, calls } = card({ kind: 'write', target: '/etc/hosts', source: 'os' });
		button('Run Outside Sandbox').click();
		assert.deepStrictEqual(calls, [], 'the first click only asks');
		const input = tray.querySelector<HTMLInputElement>('.volt-sandbox-denial-confirm-input')!;
		const confirm = button('Turn Off Sandbox');
		assert.ok(confirm.classList.contains('disabled'), 'disabled until the word is typed');
		input.value = 'of';
		input.dispatchEvent(new InputEvent('input'));
		assert.ok(confirm.classList.contains('disabled'));
		input.value = RUN_OUTSIDE_CONFIRMATION.toUpperCase();
		input.dispatchEvent(new InputEvent('input'));
		assert.ok(!confirm.classList.contains('disabled'));
		confirm.click();
		assert.deepStrictEqual(calls, [], 'a synthetic click still does nothing');
	});

	test('UX-APPROVE-2 / UX-FORGE-2: the trust service approves through the broker only with a token minted for the chat', async () => {
		const disposables = store.add(new DisposableStore());
		const asked: unknown[][] = [];
		const committed: ITrustChange[] = [];
		const stdio: Partial<IVoltStdioService> = {
			trustState: async () => EMPTY_TRUST_STATE,
			trustCommit: async change => { committed.push(change); return { epoch: 1, changed: true }; },
			approveSandboxDenial: async (...args) => { asked.push(args); return { ok: true, epoch: 4 }; },
		};
		const trust = disposables.add(new VoltTrustService(stdio as IVoltStdioService, new NullLogService()));
		await trust.whenReady;
		const forged = { id: 'g1.x', principal: 'chat:c1', issuedAt: Date.now(), consumed: false };
		assert.ok(!(await trust.approveDenial('c1', 'proc-1', 'd1', 3, 'chat', forged)).ok, 'a token object the window did not mint');
		assert.ok(!(await trust.approveDenial('c1', 'proc-1', 'd1', 3, 'chat', trust.gestures.mint('chat:other'))).ok, 'another chat\'s token');
		assert.deepStrictEqual(asked, []);
		const result = await trust.approveDenial('c1', 'proc-1', 'd1', 3, 'chat', trust.gestures.mint('chat:c1'));
		assert.ok(result.ok);
		assert.deepStrictEqual(asked, [['proc-1', 'd1', 3, 'chat']], 'the denial id, its epoch and the scope, nothing the client chose about the host');

		const draft = { id: 'x', subject: 'plugin:acme.notes@local' as const, capability: 'agents.send@1', scope: {}, kind: 'persistent' as const, source: 'user' as const, grantedAt: 1, lastUsedAt: 1 };
		await assert.rejects(trust.grant(draft.subject, [draft], undefined), /not given by a click/);
		const token = trust.gestures.mint(draft.subject);
		await trust.grant(draft.subject, [draft], token);
		await assert.rejects(trust.grant(draft.subject, [draft], token), /not given by a click/, 'single use');
		assert.strictEqual(committed.length, 1);
	});

	test('UX-SHEET-1: the install sheet groups declared capabilities by class; Allow grants the medium ones only', () => {
		const declared: Record<string, unknown> = {
			voltCapabilities: {
				required: [{ id: 'net.connect', targets: ['api.linear.app'] }, { id: 'agents.send', reason: 'to post updates' }, { id: 'agents.create' }, { id: 'desktop.control' }],
				optional: [{ id: 'git.read' }, { id: 'ui.contribute' }],
			},
		};
		const extension: Pick<IExtensionDescription, 'contributes'> = { contributes: declared as IExtensionDescription['contributes'] };
		const groups = installSheetGroups(extension);
		assert.deepStrictEqual(groups.map(group => [group.class, group.capabilities.map(entry => entry.id)]), [
			['low', ['net.connect']],
			['medium', ['agents.send', 'git.read']],
			['high', ['agents.create']],
			['critical', ['desktop.control']],
		]);
		assert.match(groups.find(group => group.class === 'critical')!.outcome, /Never allowed/);
		const drafts = installSheetDrafts('plugin:acme.linear@local', groups, 7);
		assert.deepStrictEqual(drafts.map(draft => [draft.capability, draft.kind, draft.source]), [['agents.send@1', 'persistent', 'user'], ['git.read@1', 'persistent', 'user']]);
		const widerDeclared: Record<string, unknown> = { voltCapabilities: { required: [{ id: 'agents.send' }, { id: 'git.write' }] } };
		const wider = installSheetGroups({ contributes: widerDeclared as IExtensionDescription['contributes'] });
		assert.notStrictEqual(installSheetKey('plugin:acme.linear@local', groups), installSheetKey('plugin:acme.linear@local', wider), 'a changed declaration asks again');
	});

	test('UX-ACCESS-2: the Access page lists subjects and their grants; Revoke narrows the store; opening it resumes prompts', async () => {
		const disposables = store.add(new DisposableStore());
		const changes = disposables.add(new Emitter<ITrustState>());
		const trust = new FakeTrust(changes);
		trust.state = { ...EMPTY_TRUST_STATE, epoch: 3, status: 'ok', grants: [grant('g-chat', 'chat:c1'), grant('g-ext', 'plugin:acme.notes@local', { capability: 'agents.send@1', scope: {}, kind: 'persistent', sessionId: undefined })], refusals: [{ subject: 'plugin:acme.notes@local', capability: 'git.read@1', at: 1 }] };
		const instantiation = workbenchInstantiationService(undefined, disposables);
		instantiation.stub(IVoltTrustService, trust);
		const declaresVolt: Record<string, unknown> = { voltCapabilities: {} };
		const extensions: Partial<IExtensionDescription>[] = [
			{ identifier: new ExtensionIdentifier('volt.usage'), name: 'usage', displayName: 'Usage', publisher: 'volt', isBuiltin: true, isUserBuiltin: false, contributes: {} },
			{ identifier: new ExtensionIdentifier('acme.notes'), name: 'notes', displayName: 'Acme Notes', publisher: 'acme', isBuiltin: false, contributes: declaresVolt as IExtensionDescription['contributes'] },
		];
		const extensionService: Partial<IExtensionService> = { extensions: extensions as IExtensionDescription[] };
		instantiation.stub(IExtensionService, extensionService);
		const extensionApi: Partial<IVoltExtensionApiService> = { subjectOf: (id: string) => `plugin:${id}@local` };
		instantiation.stub(IVoltExtensionApiService, extensionApi);
		const history: Partial<IAgentHistoryService> = { get: () => undefined };
		instantiation.stub(IAgentHistoryService, history);
		const page = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		disposables.add({ dispose: () => page.remove() });
		instantiation.createInstance(AccessPageSection, {
			store: disposables.add(new DisposableStore()),
			sectionLabel: label => void (page.appendChild(mainWindow.document.createElement('h3')).textContent = label),
			sectionHint: text => void (page.appendChild(mainWindow.document.createElement('p')).textContent = text),
			settingsGroup: () => page.appendChild(mainWindow.document.createElement('div')),
			isCurrent: () => true,
		}).render();
		const subjects = () => [...page.querySelectorAll<HTMLElement>('.volt-access-subject')].map(row => row.querySelector('.volt-security-workload-title')?.textContent);
		await until(() => page.querySelectorAll('.volt-access-history').length === 2);
		assert.deepStrictEqual(subjects(), ['Acme Notes', 'Chat c1', 'Usage']);
		const text = page.textContent ?? '';
		assert.match(text, /refused: git\.read/);
		assert.match(text, /For this chat/);
		assert.match(text, /Allowed by Volt without asking, within its compiled ceiling/, 'built-ins show their ceiling, no prompts');
		assert.match(text, /prompts were paused after 2 refusals/);
		assert.match(text, /Denied agents\.send/, 'the decision log in the history');
		await until(() => trust.resets === 1);
		const grantRows = [...page.querySelectorAll<HTMLElement>('.volt-access-grant')];
		assert.strictEqual(grantRows.length, 2);
		const chatRow = grantRows.find(row => /net\.connect api\.test/.test(row.textContent ?? ''))!;
		chatRow.querySelector<HTMLElement>('.monaco-button')!.click();
		await until(() => trust.narrowed.length === 1);
		assert.deepStrictEqual(trust.narrowed[0].revoke, ['g-chat']);
		await until(() => page.querySelectorAll('.volt-access-grant').length === 1);
	});

	test('UX-GRANT-3: extension consents come from the grant store, judged by the Authority (expiry, refusals, signer subject)', () => {
		const now = 100 * 24 * 60 * 60 * 1000;
		let stored: IStoredConsents = { subject: 'plugin:acme.notes@gallery:acme', epoch: 4, grants: [], refusals: [] };
		const used: string[] = [];
		const consents: IVoltConsentStore = { state: () => 'granted', stored: () => stored, used: (_id, capability) => used.push(capability) };
		const policy = store.add(new VoltExtensionCapabilityPolicy(consents, { now: () => now }));
		const principal: IVoltPluginPrincipal = { extensionId: 'acme.notes', firstParty: false, capabilities: { required: [{ id: 'agents.send', class: 'medium' }, { id: 'agents.create', class: 'high' }] } };
		const ask = (capability: string) => policy.check(principal, { api: 'test', capability });
		assert.strictEqual(ask('agents.send').allowed, false, 'the store answers, not the features store\'s "granted"');
		assert.strictEqual(ask('agents.send').denial?.promptable, true);
		stored = { ...stored, grants: [grant('c', 'plugin:acme.notes@gallery:acme', { capability: 'agents.send@1', scope: {}, kind: 'persistent', sessionId: undefined, grantedAt: now - 1000, lastUsedAt: now - 1000 })] };
		assert.strictEqual(ask('agents.send').allowed, true);
		assert.deepStrictEqual(used, ['agents.send'], 'a use moves the grant\'s last use');
		stored = { ...stored, grants: [grant('c', 'plugin:acme.notes@gallery:acme', { capability: 'agents.send@1', scope: {}, kind: 'persistent', sessionId: undefined, grantedAt: 1, lastUsedAt: 1 })] };
		assert.strictEqual(ask('agents.send').allowed, false, 'unused for 30 days: expired (G.4)');
		stored = { ...stored, grants: [], refusals: [{ subject: 'plugin:acme.notes@gallery:acme', capability: 'agents.create@1', at: 1 }] };
		const refused = ask('agents.create');
		assert.strictEqual(refused.allowed, false);
		assert.ok(!refused.denial?.promptable, 'a refusal is not asked again');
	});

	test('UX-5b: the consent dialog\'s Allow needs a real click: a synthetic one answers nothing', async () => {
		const disposables = store.add(new DisposableStore());
		const container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		disposables.add({ dispose: () => container.remove() });
		const layout: Partial<ILayoutService> = { activeContainer: container };
		const answers: [boolean, boolean][] = [];
		const registry = new GestureTokenRegistry();
		disposables.add(showVoltExtensionConsent(layout as ILayoutService, { extensionName: 'Acme', publisher: 'acme', capability: 'agents.send', class: 'medium', gesture: { registry, principal: 'plugin:acme.notes@local' } }, (granted, gesture) => answers.push([granted, !!gesture])));
		const allow = container.querySelector<HTMLElement>('.volt-extension-consent .allow')!;
		assert.ok(allow.classList.contains('disabled'), 'inert when shown');
		await new Promise(resolve => setTimeout(resolve, 550));
		allow.click();
		assert.deepStrictEqual(answers, []);
		container.querySelector<HTMLElement>('.volt-extension-consent .deny')!.click();
		assert.deepStrictEqual(answers, [[false, false]]);
	});

	test('UX-SEC-1: the Security page says how many permissions are held and what was denied lately', () => {
		const state: ITrustState = { ...EMPTY_TRUST_STATE, grants: [grant('a', 'chat:c1'), grant('b', 'chat:c1'), grant('c', 'plugin:x.y@local')] };
		const now = 10 * 24 * 60 * 60 * 1000;
		const text = permissionsSummaryText(state, [
			{ at: now - 1000, source: 'network', subject: 'chat:c1', action: 'CONNECT', decision: 'deny' },
			{ at: now - 2000, source: 'network', subject: 'chat:c1', action: 'CONNECT', decision: 'allow' },
			{ at: 1, source: 'network', subject: 'chat:c1', action: 'CONNECT', decision: 'deny' },
		], now);
		assert.strictEqual(text, '3 permissions held by 2 extensions and chats. Last 7 days: 1 denied, 1 allowed.');
	});
});
