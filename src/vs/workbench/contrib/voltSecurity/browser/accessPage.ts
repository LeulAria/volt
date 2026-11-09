/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltSecurity.css';
import { $, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { firstPartyCeiling } from '../../../../platform/voltPlugins/common/firstPartyCeilings.js';
import { grantExpiry, IGrant } from '../../../../platform/voltSandbox/common/grants.js';
import { extensionSubject, isChatSubject, SubjectKey, subjectChatId, subjectExtensionId } from '../../../../platform/voltSandbox/common/principals.js';
import { accessSubjects, describeGrantScope, IAccessSubject, IAccessSubjectInput, ITrustHistoryEntry } from '../../../../platform/voltSandbox/common/trust.js';
import type { IVoltPromptBudget } from '../../../../platform/voltStdio/common/voltStdio.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IVoltExtensionApiService } from '../../../services/voltPlugins/common/voltExtensionApi.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltTrustService } from '../../../services/voltTrust/common/voltTrust.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { ISandboxWorkloadsKit } from './sandboxWorkloadsSection.js';

const SUBJECT_HEIGHT = 58;
const GRANT_HEIGHT = 44;
const HISTORY_HEIGHT = 44;
const HISTORY_LIMIT = 50;

type AccessRow =
	| { readonly kind: 'subject'; readonly subject: IAccessSubject; readonly budget?: IVoltPromptBudget }
	| { readonly kind: 'grant'; readonly subject: IAccessSubject; readonly grant: IGrant };

function rowId(row: AccessRow): string {
	return row.kind === 'subject' ? `s:${row.subject.subject}` : `g:${row.grant.id}`;
}

function when(at: number): string {
	return new Date(at).toLocaleString();
}

/** "For this chat", "This run", "Always": how long a grant holds (G.4). */
export function grantLifetime(grant: IGrant): string {
	switch (grant.kind) {
		case 'once': return localize('voltAccess.once', "Once");
		case 'session': return grant.sessionId && grant.subject === `chat:${grant.sessionId}` ? localize('voltAccess.forChat', "For this chat") : localize('voltAccess.thisRun', "This run");
		case 'workspace': return localize('voltAccess.workspace', "In {0}", grant.workspace ?? '');
		case 'picker': return localize('voltAccess.picked', "Picked file");
		default: {
			const expiry = grantExpiry(grant);
			return expiry !== undefined ? localize('voltAccess.alwaysUntil', "Always, unless unused until {0}", new Date(expiry).toLocaleDateString()) : localize('voltAccess.always', "Always");
		}
	}
}

function kindLabel(subject: IAccessSubject): string {
	switch (subject.kind) {
		case 'builtin': return localize('voltAccess.kind.builtin', "Built-in");
		case 'extension': return localize('voltAccess.kind.extension', "Extension");
		case 'chat': return localize('voltAccess.kind.chat', "Chat");
		default: return localize('voltAccess.kind.other', "Other");
	}
}

function subjectSummary(row: Extract<AccessRow, { kind: 'subject' }>): string {
	const { subject } = row;
	if (subject.kind === 'builtin') {
		return localize('voltAccess.builtinSummary', "Allowed by Volt without asking, within its compiled ceiling: {0}", subject.ceiling?.join(', ') || localize('voltAccess.nothing', "nothing beyond its own storage and UI"));
	}
	const parts: string[] = [];
	parts.push(subject.grants.length ? localize('voltAccess.grants', "{0} allowed", subject.grants.length) : localize('voltAccess.noGrants', "Nothing allowed beyond what it declares as low"));
	if (subject.refusals.length) {
		parts.push(localize('voltAccess.refused', "refused: {0}", subject.refusals.map(refusal => refusal.capability.replace(/@\d+$/, '')).join(', ')));
	}
	return parts.join('; ');
}

function subjectMeta(row: Extract<AccessRow, { kind: 'subject' }>, budgetToday: number): string {
	const parts: string[] = [];
	parts.push(row.subject.lastUsedAt ? localize('voltAccess.lastUsed', "Last used {0}", when(row.subject.lastUsedAt)) : localize('voltAccess.neverUsed', "Not used yet"));
	if (row.subject.kind !== 'builtin') {
		if (row.budget?.autoDenied) {
			parts.push(localize('voltAccess.paused', "prompts were paused after {0} refusals; opening this page resumed them", row.budget.refusals));
		} else {
			parts.push(localize('voltAccess.promptsToday', "{0} of 3 prompts today", Math.max(budgetToday, row.budget?.promptsToday ?? 0)));
		}
	}
	return parts.join(', ');
}

class AccessDelegate implements IListVirtualDelegate<AccessRow> {
	getHeight(row: AccessRow): number {
		return row.kind === 'subject' ? SUBJECT_HEIGHT : GRANT_HEIGHT;
	}
	getTemplateId(row: AccessRow): string {
		return row.kind === 'subject' ? SubjectRenderer.ID : GrantRenderer.ID;
	}
}

interface ISubjectTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly title: HTMLElement;
	readonly chip: HTMLElement;
	readonly summary: HTMLElement;
	readonly meta: HTMLElement;
	readonly action: ReturnType<typeof createVoltButton>;
	readonly store: DisposableStore;
	current?: Extract<AccessRow, { kind: 'subject' }>;
}

class SubjectRenderer implements IListRenderer<AccessRow, ISubjectTemplate> {
	static readonly ID = 'voltAccessSubject';
	readonly templateId = SubjectRenderer.ID;

	constructor(private readonly onReset: (subject: IAccessSubject) => void, private readonly promptsToday: (subject: SubjectKey) => number) { }

	renderTemplate(container: HTMLElement): ISubjectTemplate {
		const store = new DisposableStore();
		const row = append(container, $('.volt-security-workload.volt-access-subject'));
		const icon = append(row, $('.volt-security-workload-icon'));
		const copy = append(row, $('.volt-security-workload-copy'));
		const head = append(copy, $('.volt-security-workload-head'));
		const title = append(head, $('span.volt-security-workload-title'));
		const chip = append(head, $('span.volt-security-workload-state'));
		const summary = append(copy, $('.volt-security-workload-meta'));
		const meta = append(copy, $('.volt-security-workload-meta'));
		const action = store.add(createVoltButton(append(row, $('.volt-security-workload-actions')), 'secondary'));
		const template: ISubjectTemplate = { row, icon, title, chip, summary, meta, action, store };
		store.add(action.onDidClick(() => {
			if (template.current) {
				action.enabled = false;
				this.onReset(template.current.subject);
			}
		}));
		return template;
	}

	renderElement(row: AccessRow, _index: number, template: ISubjectTemplate): void {
		if (row.kind !== 'subject') {
			return;
		}
		template.current = row;
		const subject = row.subject;
		template.icon.replaceChildren(renderIcon(subject.kind === 'builtin' ? Codicon.verified : subject.kind === 'chat' ? Codicon.commentDiscussion : Codicon.extensions));
		template.title.textContent = subject.label;
		template.chip.textContent = kindLabel(subject);
		template.summary.textContent = subjectSummary(row);
		template.meta.textContent = subjectMeta(row, this.promptsToday(subject.subject));
		setAgentTooltip(template.row, subject.subject);
		// Refusals are forgotten here, so the extension may ask again; grants have their own rows.
		const canReset = subject.kind !== 'builtin' && subject.refusals.length > 0;
		template.action.element.parentElement!.hidden = !canReset;
		template.action.label = localize('voltAccess.askAgain', "Let It Ask Again");
		template.action.element.title = localize('voltAccess.askAgainTitle', "Forget its refusals: it may ask for them again");
		template.action.enabled = canReset;
	}

	disposeTemplate(template: ISubjectTemplate): void {
		template.store.dispose();
	}
}

interface IGrantTemplate {
	readonly title: HTMLElement;
	readonly meta: HTMLElement;
	readonly revoke: ReturnType<typeof createVoltButton>;
	readonly store: DisposableStore;
	current?: IGrant;
}

class GrantRenderer implements IListRenderer<AccessRow, IGrantTemplate> {
	static readonly ID = 'voltAccessGrant';
	readonly templateId = GrantRenderer.ID;

	constructor(private readonly onRevoke: (grant: IGrant) => void) { }

	renderTemplate(container: HTMLElement): IGrantTemplate {
		const store = new DisposableStore();
		const row = append(container, $('.volt-security-workload.volt-access-grant'));
		const copy = append(row, $('.volt-security-workload-copy'));
		const title = append(copy, $('span.volt-security-workload-title'));
		const meta = append(copy, $('.volt-security-workload-meta'));
		const revoke = store.add(createVoltButton(append(row, $('.volt-security-workload-actions')), 'danger'));
		revoke.label = localize('voltAccess.revoke', "Revoke");
		const template: IGrantTemplate = { title, meta, revoke, store };
		store.add(revoke.onDidClick(() => {
			if (template.current) {
				revoke.enabled = false;
				this.onRevoke(template.current);
			}
		}));
		return template;
	}

	renderElement(row: AccessRow, _index: number, template: IGrantTemplate): void {
		if (row.kind !== 'grant') {
			return;
		}
		template.current = row.grant;
		template.title.textContent = describeGrantScope(row.grant);
		template.meta.textContent = localize('voltAccess.grantMeta', "{0}, allowed {1}, last used {2}", grantLifetime(row.grant), when(row.grant.grantedAt), when(row.grant.lastUsedAt));
		template.revoke.enabled = true;
	}

	disposeTemplate(template: IGrantTemplate): void {
		template.store.dispose();
	}
}

class HistoryDelegate implements IListVirtualDelegate<ITrustHistoryEntry> {
	getHeight(): number {
		return HISTORY_HEIGHT;
	}
	getTemplateId(): string {
		return HistoryRenderer.ID;
	}
}

interface IHistoryTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly title: HTMLElement;
	readonly meta: HTMLElement;
}

const SOURCE_LABELS: Record<ITrustHistoryEntry['source'], string> = {
	network: localize('voltAccess.source.network', "network broker"),
	broker: localize('voltAccess.source.broker', "files, git, secrets or terminals broker"),
	decision: localize('voltAccess.source.decision', "Policy Authority"),
};

class HistoryRenderer implements IListRenderer<ITrustHistoryEntry, IHistoryTemplate> {
	static readonly ID = 'voltAccessHistory';
	readonly templateId = HistoryRenderer.ID;

	constructor(private readonly label: (subject: SubjectKey) => string) { }

	renderTemplate(container: HTMLElement): IHistoryTemplate {
		const row = append(container, $('.volt-security-workload.volt-access-history'));
		const icon = append(row, $('.volt-security-workload-icon'));
		const copy = append(row, $('.volt-security-workload-copy'));
		const title = append(copy, $('span.volt-security-workload-title'));
		const meta = append(copy, $('.volt-security-workload-meta'));
		return { row, icon, title, meta };
	}

	renderElement(entry: ITrustHistoryEntry, _index: number, template: IHistoryTemplate): void {
		template.icon.replaceChildren(renderIcon(entry.decision === 'allow' ? Codicon.check : entry.decision === 'deny' ? Codicon.circleSlash : Codicon.debugDisconnect));
		template.row.classList.toggle('denied', entry.decision === 'deny');
		const verb = entry.decision === 'allow' ? localize('voltAccess.allowed', "Allowed") : entry.decision === 'deny' ? localize('voltAccess.denied', "Denied") : localize('voltAccess.closed', "Closed");
		template.title.textContent = `${verb} ${entry.action}${entry.target ? ` ${entry.target}` : ''}`;
		template.meta.textContent = [this.label(entry.subject), SOURCE_LABELS[entry.source], when(entry.at), entry.reason].filter(Boolean).join(', ');
	}

	disposeTemplate(): void { }
}

/**
 * Settings, Access (spec P4, G.12): every subject that can hold permissions (built-in features
 * with their compiled ceilings, third-party extensions, chats with standing grants) with its
 * grants, refusals, last use and prompt budget, each grant revocable; then the history, from the
 * Policy Authority's decision log and the brokers' audit logs. Opening the page resumes prompts
 * that two refusals paused (G.12). A revocation is a grant-store write: the network broker closes
 * the tunnels it allowed, the extension API refuses the next call.
 */
export class AccessPageSection {

	constructor(
		private readonly kit: ISandboxWorkloadsKit,
		@IVoltTrustService private readonly trust: IVoltTrustService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IVoltExtensionApiService private readonly extensionApi: IVoltExtensionApiService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	render(): void {
		const { kit, trust } = this;
		const status = trust.state.status;
		if (status === 'torn') {
			kit.sectionHint(localize('voltAccess.torn', "Permissions were reset: Volt could not read the permissions file, so it started again from nothing. Built-in features keep theirs."));
		} else if (trust.state.readOnly) {
			kit.sectionHint(localize('voltAccess.newer', "A newer Volt wrote the permissions file. This version reads it without third-party permissions and can't add any to it. Revoking still works."));
		}

		kit.sectionLabel(localize('voltAccess.permissions', "Permissions"));
		kit.sectionHint(localize('voltAccess.permissionsHint', "What each extension, built-in feature and chat may do beyond its sandbox. Revoking takes effect at once: connections it allowed close, and the next use asks again."));
		const group = kit.settingsGroup();
		const empty = append(group, $('.volt-security-empty'));
		const listHost = append(group, $('.volt-security-workloads.volt-access-list'));
		let disposed = false;
		kit.store.add(toDisposable(() => { disposed = true; }));
		let budgets: readonly IVoltPromptBudget[] = [];
		let historyRows: readonly ITrustHistoryEntry[] = [];
		const list = kit.store.add(this.instantiationService.createInstance(WorkbenchList<AccessRow>, 'VoltAccessPermissions', listHost, new AccessDelegate(), [
			new SubjectRenderer(subject => void trust.record({ unrefuse: subject.refusals.map(refusal => ({ subject: refusal.subject, capability: refusal.capability })) }, 'access-page').catch(() => undefined), subject => trust.budget.state(subject).promptsToday),
			new GrantRenderer(grant => void trust.narrow({ revoke: [grant.id] }).catch(() => undefined)),
		], {
			identityProvider: { getId: rowId },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltAccess.aria', "Permissions"),
				getAriaLabel: (row: AccessRow) => row.kind === 'subject' ? `${row.subject.label}, ${kindLabel(row.subject)}, ${subjectSummary(row)}` : `${describeGrantScope(row.grant)}, ${grantLifetime(row.grant)}`,
			},
		}));

		kit.sectionLabel(localize('voltAccess.history', "History"));
		kit.sectionHint(localize('voltAccess.historyHint', "The latest permission decisions and broker requests. Files the brokers touched are shown by a one-way code, never by name."));
		const historyGroup = kit.settingsGroup();
		const historyEmpty = append(historyGroup, $('.volt-security-empty'));
		historyEmpty.textContent = localize('voltAccess.noHistory', "Nothing recorded yet.");
		const historyHost = append(historyGroup, $('.volt-security-workloads.volt-access-list'));
		const historyList = kit.store.add(this.instantiationService.createInstance(WorkbenchList<ITrustHistoryEntry>, 'VoltAccessHistory', historyHost, new HistoryDelegate(), [new HistoryRenderer(subject => this.label(subject))], {
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltAccess.historyAria', "Permission history"),
				getAriaLabel: (entry: ITrustHistoryEntry) => `${entry.decision} ${entry.action} ${entry.target ?? ''}, ${this.label(entry.subject)}`,
			},
		}));

		const draw = () => {
			if (disposed || !kit.isCurrent()) {
				return;
			}
			const subjects = accessSubjects(trust.state, this.knownSubjects(), historyRows, subject => this.label(subject));
			const rows: AccessRow[] = [];
			for (const subject of subjects) {
				const budget = budgets.find(entry => entry.subject === subject.subject);
				rows.push({ kind: 'subject', subject, ...(budget ? { budget } : {}) });
				for (const grant of subject.grants) {
					rows.push({ kind: 'grant', subject, grant });
				}
			}
			empty.hidden = rows.length > 0;
			empty.textContent = localize('voltAccess.none', "Nothing holds a permission yet.");
			const height = rows.reduce((sum, row) => sum + (row.kind === 'subject' ? SUBJECT_HEIGHT : GRANT_HEIGHT), 0);
			listHost.style.height = `${height}px`;
			list.layout(height);
			list.splice(0, list.length, rows);
			historyEmpty.hidden = historyRows.length > 0;
			historyHost.style.height = `${historyRows.length * HISTORY_HEIGHT}px`;
			historyList.layout(historyRows.length * HISTORY_HEIGHT);
			historyList.splice(0, historyList.length, [...historyRows]);
		};
		const load = async () => {
			[budgets, historyRows] = await Promise.all([trust.brokerBudgets(), trust.history(HISTORY_LIMIT)]);
			draw();
		};
		kit.store.add(trust.onDidChange(() => void load()));
		// Opening the page resumes prompts two refusals paused (G.12); the budgets are read first, to show it.
		void trust.refresh().then(load).then(() => trust.resetBudgets());
		draw();
	}

	/** Built-in features with their ceilings and the installed extensions that declare Volt capabilities. */
	private knownSubjects(): IAccessSubjectInput[] {
		const out: IAccessSubjectInput[] = [];
		for (const extension of this.extensionService.extensions) {
			const id = extension.identifier.value;
			const ceiling = firstPartyCeiling(id);
			const label = extension.displayName ?? extension.name;
			if (extension.isBuiltin && !extension.isUserBuiltin && extension.publisher === 'volt' && ceiling) {
				out.push({ subject: extensionSubject(id, true), label, kind: 'builtin', ceiling: ceiling.map(entry => entry.targets?.length ? `${entry.id} ${entry.targets.join(', ')}` : entry.id) });
			} else if (!extension.isBuiltin && extension.contributes && 'voltCapabilities' in extension.contributes) {
				out.push({ subject: this.extensionApi.subjectOf?.(id) ?? extensionSubject(id, false), label, kind: 'extension' });
			}
		}
		return out;
	}

	private label(subject: SubjectKey): string {
		if (isChatSubject(subject)) {
			const id = subjectChatId(subject)!;
			const title = this.history.get(id)?.title;
			return title ? localize('voltAccess.chatLabel', "Chat \"{0}\"", title) : localize('voltAccess.chatId', "Chat {0}", id.slice(0, 8));
		}
		const id = subjectExtensionId(subject);
		if (id) {
			const extension = this.extensionService.extensions.find(candidate => candidate.identifier.value.toLowerCase() === id);
			return extension?.displayName ?? extension?.name ?? id;
		}
		return subject;
	}
}
