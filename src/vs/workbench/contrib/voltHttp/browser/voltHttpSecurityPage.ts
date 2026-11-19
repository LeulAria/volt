/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltHttpSecurity.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { Action, Separator } from '../../../../base/common/actions.js';
import { raceCancellation, RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname, joinPath, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList, WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { findHttpItemByPath, httpRequestLabel, httpRequestsOf, IHttpItem } from '../common/httpCollection.js';
import { httpRequestBadge, httpRequestBadgeKey } from '../common/httpProtocols.js';
import { HTTP_SECURITY_CATEGORIES, HTTP_SECURITY_CHECKS, HTTP_SECURITY_MAX_RATE, HTTP_SECURITY_OWASP, HTTP_SECURITY_SEVERITIES, HttpSecurityCategory, HttpSecuritySeverity, HttpSecurityTriage, httpSecurityCheck, httpSecurityEndpointLabel, httpSecurityFindingText, httpSecurityHtmlReport, httpSecurityJsonReport, httpSecurityMarkdownReport, httpSecuritySarifReport, httpSecurityUrl, IHttpSecurityCheck, IHttpSecurityEvidence, IHttpSecurityFile, IHttpSecurityFinding, IHttpSecurityTarget, isHttpSecurityCheckEnabled, isHttpSecurityFindingOpen, normalizeHttpSecurityOptions, sortHttpSecurityFindings, summarizeHttpSecurity } from '../common/httpSecurity.js';
import { httpDraftKey, IVoltHttpCollections } from './voltHttpCollections.js';
import { httpSecurityCountsText, IHttpSecurityScanState, IVoltHttpSecurity } from './voltHttpSecurity.js';
import { IHttpToolPage, IHttpToolPageHost, IHttpToolTabState } from './voltHttpToolPages.js';
import { createHttpAiModelButton, httpAiModelRef } from './voltHttpAiModel.js';
import { createHttpAgentIcon, createHttpChatIcon } from './voltHttpIcons.js';
import { createHttpCheck, createHttpDropdown, createHttpIconButton, decorateHttpHeadButton, renderHttpAiAnswer, renderHttpTabs, showHttpActionMenu } from './voltHttpWidgets.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';

type SecurityTab = 'setup' | 'findings' | 'report';
type FindingSort = 'severity' | 'endpoint' | 'check';
type ReportFormat = 'html' | 'markdown' | 'sarif' | 'json';

const NARROW = 720;
const TREE_ROW = 26;
const CHECK_ROW = 44;
const CATEGORY_ROW = 30;
const HOST_ROW = 44;
const FINDING_ROW = 44;
const MAX_TREE_ROWS = 12;
const MAX_FINDING_ROWS = 12;
const AI_TIMEOUT_MS = 180_000;
const TOP_FOR_CHAT = 15;
/** The separator between a row's facts: a middle dot (U+00B7) with a space either side. */
const DOT = ` ${String.fromCharCode(0xb7)} `;

const SEVERITY_LABELS: Readonly<Record<HttpSecuritySeverity, string>> = {
	critical: localize('voltHttp.secSevCritical', "Critical"),
	high: localize('voltHttp.secSevHigh', "High"),
	medium: localize('voltHttp.secSevMedium', "Medium"),
	low: localize('voltHttp.secSevLow', "Low"),
	info: localize('voltHttp.secSevInfo', "Info"),
};

const TRIAGE_LABELS: Readonly<Record<HttpSecurityTriage, string>> = {
	falsePositive: localize('voltHttp.secTriageFalsePositive', "False Positive"),
	accepted: localize('voltHttp.secTriageAccepted', "Accepted Risk"),
	fixed: localize('voltHttp.secTriageFixed', "Fixed"),
};

const CONFIDENCE_LABELS: Readonly<Record<IHttpSecurityFinding['confidence'], string>> = {
	certain: localize('voltHttp.secConfCertain', "Certain"),
	firm: localize('voltHttp.secConfFirm', "Firm"),
	tentative: localize('voltHttp.secConfTentative', "Tentative"),
};

/** Who the triage model is. */
export const HTTP_SECURITY_TRIAGE_SYSTEM_PROMPT = 'You are an application security engineer triaging the findings of an automated API security scan for the developer who owns the API. Answer in plain text with short headed sections, no tables, no tool use and no questions.';

/**
 * What the triage model is asked: the open findings (their evidence is already masked), to group
 * duplicates, name likely false positives with reasons, order by real risk and write fixes for
 * the stack the responses show. Pure, so it can be tested.
 */
export function httpSecurityTriagePrompt(file: Pick<IHttpSecurityFile, 'name' | 'description'>, findings: readonly IHttpSecurityFinding[]): string {
	const stack = new Set<string>();
	for (const finding of findings) {
		for (const [key, value] of finding.evidence.response.headers) {
			if (/^(?:server|x-powered-by|x-aspnet-version)$/i.test(key)) {
				stack.add(`${key}: ${value}`);
			}
		}
	}
	const cut = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}...` : value;
	return [
		`Triage the open findings of the security scan "${file.name}" of the developer's own API.${file.description ? ` About the API: ${file.description}` : ''}`,
		'',
		'Do this:',
		'1. Group findings that are the same underlying problem (one fix closes them all).',
		'2. Name the findings that are likely false positives and say why, from the evidence.',
		'3. Order what is left by real risk to this API (not only the scanner\'s severity), one line of reasoning each.',
		'4. For each group write the concrete fix for this stack (framework settings, middleware or code), short.',
		'Refer to findings by their [id]. Do not invent findings. Be brief.',
		'',
		stack.size ? `The responses name this software: ${[...stack].slice(0, 6).join('; ')}.` : 'The responses do not name the server software; infer the stack only from the evidence.',
		'',
		'Findings:',
		...findings.map(finding => [
			`[${finding.fingerprint}] ${finding.severity}/${finding.confidence} ${finding.checkId}: ${finding.title}`,
			`  ${httpSecurityEndpointLabel(finding.endpoint)}${finding.parameter ? ` parameter ${finding.parameter}` : ''}${finding.occurrences && finding.occurrences > 1 ? ` (seen on ${finding.occurrences} requests)` : ''}`,
			`  ${cut(finding.description, 400)}`,
			`  Response ${finding.evidence.response.status || 'none'}${finding.evidence.match ? `, matched: ${cut(finding.evidence.match, 120)}` : ''}`,
			...(finding.evidence.response.body ? [`  Body excerpt: ${cut(finding.evidence.response.body.replace(/\s+/g, ' '), 240)}`] : []),
		].join('\n')),
	].join('\n');
}

/** The line that tells an agent what it may do with a scan it is shown. */
function chatInstructions(path: string): string {
	return localize('voltHttp.secChatHint', "You can read this scan and re-run its passive checks with the `ide http` ops security_get, security_scan and security_report (path: {0}), and look at the server code that handles these endpoints. Active probing needs the user's authorization for each host in the Volt Client; you cannot grant it.", path);
}

function evidenceLines(evidence: IHttpSecurityEvidence): { readonly request: string; readonly response: string } {
	const request = [`${evidence.request.method} ${evidence.request.url}`, ...evidence.request.headers.map(([key, value]) => `${key}: ${value}`), ...(evidence.request.body ? ['', evidence.request.body] : [])].join('\n');
	const response = evidence.response.status
		? [`HTTP ${evidence.response.status}`, ...evidence.response.headers.map(([key, value]) => `${key}: ${value}`), ...(evidence.response.body ? ['', evidence.response.body] : [])].join('\n')
		: localize('voltHttp.secNoResponse', "No response. {0}", evidence.response.error ?? '');
	return { request, response };
}

/** Text with every occurrence of `match` wrapped in a mark: text nodes only. */
function appendMarked(parent: HTMLElement, value: string, match: string | undefined): void {
	if (!match) {
		parent.textContent = value;
		return;
	}
	let at = 0;
	for (let index = value.indexOf(match); index >= 0 && match; index = value.indexOf(match, at)) {
		parent.appendChild(parent.ownerDocument.createTextNode(value.slice(at, index)));
		append(parent, $('mark.volt-http-sec-mark')).textContent = match;
		at = index + match.length;
	}
	parent.appendChild(parent.ownerDocument.createTextNode(value.slice(at)));
}

// --- Rows ------------------------------------------------------------------------------------------

interface ITargetNode {
	readonly kind: 'collection' | 'folder' | 'request';
	readonly id: string;
	readonly label: string;
	readonly collection: URI;
	/** The collection as the file names it. */
	readonly ref: string;
	readonly path: readonly string[];
	/** The request keys under it (itself for a request). */
	readonly keys: readonly string[];
	readonly method?: string;
	readonly badgeKey?: string;
	readonly children: ITargetNode[];
}

interface ITargetTemplate {
	readonly check: HTMLElement;
	readonly icon: HTMLElement;
	readonly method: HTMLElement;
	readonly label: HTMLElement;
	readonly detail: HTMLElement;
}

type CheckRow = { readonly kind: 'category'; readonly category: HttpSecurityCategory; readonly checks: readonly IHttpSecurityCheck[] } | { readonly kind: 'check'; readonly check: IHttpSecurityCheck };

interface ICheckTemplate {
	readonly row: HTMLElement;
	readonly check: HTMLElement;
	readonly title: HTMLElement;
	readonly tag: HTMLElement;
	readonly description: HTMLElement;
}

interface IHostRow {
	readonly host: string;
	readonly requests: number;
	readonly authorizedAt?: string;
}

interface IFindingTemplate {
	readonly row: HTMLElement;
	readonly severity: HTMLElement;
	readonly title: HTMLElement;
	readonly method: HTMLElement;
	readonly path: HTMLElement;
	readonly detail: HTMLElement;
}

// --- The page --------------------------------------------------------------------------------------

/**
 * A security scan's tab: Setup (targets, checks, the active checks and the user's per-host
 * authorization), Findings (summary, charts, the list and one finding's detail) and Report. The
 * scan itself runs in `IVoltHttpSecurity`: this page only shows it, so it can come and go.
 */
export class HttpSecurityPage extends Disposable implements IHttpToolPage {

	private readonly uri: URI;
	private readonly root: URI | undefined;
	private readonly element: HTMLElement;
	private readonly nameInput: HTMLInputElement;
	private readonly progressEl: HTMLElement;
	private readonly scanButton: ReturnType<typeof createVoltButton>;
	private readonly tabsEl: HTMLElement;
	private readonly body: HTMLElement;
	private readonly view = this._register(new DisposableStore());
	private readonly aiRun = this._register(new MutableDisposable());
	private readonly scheduler: RunOnceScheduler;
	private wasRunning = false;

	/** The parts of the tab in front that refresh in place. */
	private targetTree: WorkbenchObjectTree<ITargetNode> | undefined;
	private targetHost: HTMLElement | undefined;
	private targetNodes: ITargetNode[] = [];
	private picked = new Set<string>();
	private checkList: WorkbenchList<CheckRow> | undefined;
	private checkHost: HTMLElement | undefined;
	private activeEl: HTMLElement | undefined;
	private readonly activeStore = this._register(new DisposableStore());
	private hostList: WorkbenchList<IHostRow> | undefined;
	private hostRows: IHostRow[] = [];
	private summaryEl: HTMLElement | undefined;
	private aiEl: HTMLElement | undefined;
	private chartsEl: HTMLElement | undefined;
	private notesEl: HTMLElement | undefined;
	private toolbarEl: HTMLElement | undefined;
	private readonly toolbarStore = this._register(new DisposableStore());
	private readonly summaryStore = this._register(new DisposableStore());
	private findingList: WorkbenchList<IHttpSecurityFinding> | undefined;
	private findingHost: HTMLElement | undefined;
	private findingRows: IHttpSecurityFinding[] = [];
	private detailEl: HTMLElement | undefined;
	private readonly detailStore = this._register(new DisposableStore());
	private readonly aiStore = this._register(new DisposableStore());
	private detailFor: IHttpSecurityFinding | undefined;
	private resendMessage: { readonly fingerprint: string; readonly text: string } | undefined;

	constructor(
		parent: HTMLElement,
		private readonly state: IHttpToolTabState,
		private readonly host: IHttpToolPageHost,
		@IVoltHttpSecurity private readonly security: IVoltHttpSecurity,
		@IVoltHttpCollections private readonly collections: IVoltHttpCollections,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
	) {
		super();
		this.uri = state.uri;
		this.root = security.rootOf(this.uri, host.root);
		this.element = append(parent, $('.volt-http-page.volt-http-sec'));

		const head = append(this.element, $('.volt-http-sec-head'));
		append(head, $('span.volt-http-sec-head-icon')).appendChild(renderIcon(Codicon.shield));
		this.nameInput = append(head, $('input.volt-http-sec-name')) as HTMLInputElement;
		this.nameInput.type = 'text';
		this.nameInput.spellcheck = false;
		this.nameInput.setAttribute('aria-label', localize('voltHttp.secName', "Scan name"));
		this._register(addDisposableListener(this.nameInput, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				this.nameInput.blur();
			} else if (event.key === 'Escape') {
				this.nameInput.value = this.file?.name ?? '';
				this.nameInput.blur();
			}
		}));
		this._register(addDisposableListener(this.nameInput, EventType.BLUR, () => {
			const name = this.nameInput.value.trim();
			if (name && name !== this.file?.name) {
				void this.security.rename(this.uri, name).then(() => this.host.tabChanged());
			} else {
				this.nameInput.value = this.file?.name ?? '';
			}
		}));
		this.progressEl = append(head, $('span.volt-http-sec-progress'));
		this.progressEl.setAttribute('role', 'status');
		const actions = append(head, $('.volt-http-sec-head-actions'));
		const triage = this._register(createVoltButton(actions, 'ghost'));
		decorateHttpHeadButton(triage, createHttpAgentIcon(), localize('voltHttp.secTriageAi', "Triage with AI"));
		this._register(triage.onDidClick(() => this.startTriage()));
		const chat = this._register(createVoltButton(actions, 'ghost'));
		decorateHttpHeadButton(chat, createHttpChatIcon(), localize('voltHttp.secInvestigate', "Investigate in Chat"));
		this._register(chat.onDidClick(() => this.investigateScan()));
		createHttpIconButton(actions, Codicon.ellipsis, localize('voltHttp.secMore', "More Actions"), button => this.showMore(button));
		this.scanButton = this._register(createVoltButton(actions, 'primary'));
		this._register(this.scanButton.onDidClick(() => this.toggleScan()));

		this.tabsEl = append(this.element, $('.volt-http-tabs.volt-http-sec-tabs'));
		this.body = append(this.element, $('.volt-http-sec-body'));

		this.scheduler = this._register(new RunOnceScheduler(() => this.onScanProgress(), 150));
		this._register(security.onDidChangeScan(this.uri)(scan => {
			// The start and the end show at once; what lies between, a few times a second.
			if (scan.running !== this.wasRunning) {
				this.scheduler.cancel();
				this.onScanProgress();
			} else {
				this.scheduler.schedule();
			}
		}));
		this._register(security.onDidChangeFile(uri => {
			if (uri.toString() === this.uri.toString()) {
				this.onFileChanged();
			}
		}));
		this.wasRunning = !!security.scanOf(this.uri)?.running;
		this.renderHead();
		void security.load(this.uri).then(() => {
			if (!this._store.isDisposed) {
				this.renderHead();
				this.renderTab();
			}
		});
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}

	// --- State -----------------------------------------------------------------------------------

	private get file(): IHttpSecurityFile | undefined {
		return this.security.get(this.uri)?.file;
	}

	private get scan(): IHttpSecurityScanState | undefined {
		return this.security.scanOf(this.uri);
	}

	private get tab(): SecurityTab {
		const tab = this.state.memory.tab;
		return tab === 'findings' || tab === 'report' ? tab : tab === 'setup' ? 'setup' : this.file?.lastScan || this.scan ? 'findings' : 'setup';
	}

	private setTab(tab: SecurityTab): void {
		if (this.state.memory.tab !== tab || !this.body.childElementCount) {
			this.state.memory.tab = tab;
			this.renderTab();
		}
	}

	private findings(): readonly IHttpSecurityFinding[] {
		return this.scan?.findings ?? this.file?.lastScan?.findings ?? [];
	}

	private filePath(): string {
		return (this.root && relativePath(this.root, this.uri)) || this.uri.fsPath;
	}

	private onScanProgress(): void {
		if (this._store.isDisposed) {
			return;
		}
		const running = !!this.scan?.running;
		const ended = this.wasRunning && !running;
		this.wasRunning = running;
		this.renderHead();
		if (this.tab === 'findings') {
			this.refreshFindings();
		} else if (ended && this.tab === 'report') {
			this.renderTab();
		}
	}

	private onFileChanged(): void {
		this.renderHead();
		switch (this.tab) {
			case 'setup': this.refreshSetup(); break;
			case 'findings': this.refreshFindings(); break;
			case 'report': this.renderTab(); break;
		}
	}

	// --- Head ------------------------------------------------------------------------------------

	private renderHead(): void {
		const file = this.file;
		const entry = this.security.get(this.uri);
		if (this.element.ownerDocument.activeElement !== this.nameInput) {
			this.nameInput.value = file?.name ?? basename(this.uri);
		}
		const scan = this.scan;
		const running = !!scan?.running;
		this.scanButton.label = running ? localize('voltHttp.secStop', "Stop") : localize('voltHttp.secScan', "Scan");
		this.scanButton.enabled = !!entry && !entry.error;
		this.progressEl.classList.toggle('running', running);
		clearNode(this.progressEl);
		if (running && scan) {
			append(this.progressEl, $('span.volt-http-spinner')).appendChild(renderIcon(Codicon.loading));
			const text = scan.stage === 'resolving'
				// allow-any-unicode-next-line
				? localize('voltHttp.secPreparing', "Preparing…")
				: localize('voltHttp.secProgress', "{0} of {1} requests, {2} probes sent", scan.done, scan.total, scan.probes);
			append(this.progressEl, $('span')).textContent = scan.stage === 'probing' ? `${text} ${localize('voltHttp.secProbing', "(active checks)")}` : text;
			setAgentTooltip(this.progressEl, scan.current ?? '');
		} else if (entry?.error) {
			append(this.progressEl, $('span.error')).textContent = localize('voltHttp.secUnreadable', "This file cannot be read: {0}", entry.error);
		} else if (file?.lastScan) {
			const at = Date.parse(file.lastScan.at);
			append(this.progressEl, $('span')).textContent = Number.isFinite(at) ? localize('voltHttp.secLastScan', "Scanned {0}", fromNow(at, true)) : '';
			setAgentTooltip(this.progressEl, file.lastScan.at);
		}
		renderHttpTabs(this.tabsEl, [
			{ id: 'setup', label: localize('voltHttp.secTabSetup', "Setup") },
			{ id: 'findings', label: localize('voltHttp.secTabFindings', "Findings"), ...(this.findings().length ? { count: this.findings().filter(finding => isHttpSecurityFindingOpen(finding, file?.triage ?? {})).length } : {}) },
			{ id: 'report', label: localize('voltHttp.secTabReport', "Report") },
		], this.tab, id => this.setTab(id));
	}

	private toggleScan(): void {
		if (this.scan?.running) {
			this.security.stop(this.uri);
			return;
		}
		const file = this.file;
		if (file && !file.targets.length) {
			this.setTab('setup');
			this.notificationService.info(localize('voltHttp.secNoTargets', "Pick the requests to scan under Targets first."));
			return;
		}
		this.state.memory.tab = 'findings';
		this.resendMessage = undefined;
		void this.security.scan(this.uri, { ...(this.host.root ? { root: this.host.root } : {}) });
		this.renderTab();
	}

	private showMore(anchor: HTMLElement): void {
		const action = (id: string, label: string, run: () => void, enabled = true) => new Action(id, label, undefined, enabled, async () => run());
		const scanned = !!this.file?.lastScan;
		const menu = showHttpActionMenu(this.contextViewService, anchor, this.element, [
			action('sec.exportHtml', localize('voltHttp.secExportHtml', "Export Report as HTML"), () => void this.export('html'), scanned),
			action('sec.exportMarkdown', localize('voltHttp.secExportMarkdown', "Export Report as Markdown"), () => void this.export('markdown'), scanned),
			action('sec.exportSarif', localize('voltHttp.secExportSarif', "Export Report as SARIF"), () => void this.export('sarif'), scanned),
			action('sec.exportJson', localize('voltHttp.secExportJson', "Export Report as JSON"), () => void this.export('json'), scanned),
			new Separator(),
			action('sec.reveal', localize('voltHttp.secReveal', "Reveal File"), () => this.host.revealFile(this.uri)),
		], localize('voltHttp.secMoreAria', "Security scan actions"));
		this.view.add(menu);
	}

	private async export(format: ReportFormat): Promise<void> {
		const file = this.file;
		if (!file) {
			return;
		}
		const extension = format === 'markdown' ? 'md' : format;
		const text = format === 'html' ? httpSecurityHtmlReport(file) : format === 'markdown' ? httpSecurityMarkdownReport(file) : format === 'sarif' ? httpSecuritySarifReport(file) : httpSecurityJsonReport(file);
		const stem = basename(this.uri).replace(/\.volt-security\.json$/, '') || 'security-scan';
		const target = await this.fileDialogService.showSaveDialog({
			title: localize('voltHttp.secExportTitle', "Export Security Report"),
			defaultUri: joinPath(dirname(this.uri), `${stem}-report.${extension}`),
			filters: [{ name: format.toUpperCase(), extensions: [extension] }],
		});
		if (!target) {
			return;
		}
		try {
			await this.fileService.writeFile(target, VSBuffer.fromString(text));
			this.notificationService.info(localize('voltHttp.secExported', "Report saved to {0}.", basename(target)));
		} catch (err) {
			this.notificationService.error(localize('voltHttp.secExportFailed', "The report could not be saved: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	// --- Tabs ------------------------------------------------------------------------------------

	private renderTab(): void {
		this.view.clear();
		this.activeStore.clear();
		this.toolbarStore.clear();
		this.summaryStore.clear();
		this.detailStore.clear();
		this.aiStore.clear();
		this.targetTree = this.checkList = this.hostList = this.findingList = undefined;
		this.targetHost = this.checkHost = this.activeEl = this.summaryEl = this.aiEl = this.chartsEl = this.notesEl = this.toolbarEl = this.findingHost = this.detailEl = undefined;
		this.detailFor = undefined;
		clearNode(this.body);
		this.renderHead();
		const entry = this.security.get(this.uri);
		if (!entry) {
			// allow-any-unicode-next-line
			append(this.body, $('.volt-http-empty.center')).textContent = localize('voltHttp.secLoading', "Loading…");
			return;
		}
		if (entry.error) {
			const empty = append(this.body, $('.volt-http-empty.center'));
			empty.textContent = localize('voltHttp.secBroken', "{0} is not a security scan Volt can read: {1}", basename(this.uri), entry.error);
			return;
		}
		switch (this.tab) {
			case 'setup': this.renderSetup(); break;
			case 'findings': this.renderFindings(); break;
			case 'report': this.renderReport(); break;
		}
	}

	layout(width: number, _height: number): void {
		this.element.classList.toggle('narrow', width < NARROW);
		this.layoutLists();
	}

	private layoutLists(): void {
		if (this.targetTree && this.targetHost) {
			const height = Math.min(this.targetTree.contentHeight, MAX_TREE_ROWS * TREE_ROW);
			this.targetHost.style.height = `${height}px`;
			this.targetTree.layout(height);
		}
		if (this.checkList && this.checkHost) {
			this.checkList.layout(Number.parseInt(this.checkHost.style.height, 10) || 0);
		}
		if (this.hostList) {
			this.hostList.layout(this.hostRows.length * HOST_ROW);
		}
		if (this.findingList && this.findingHost) {
			const height = Math.max(1, Math.min(this.findingRows.length, MAX_FINDING_ROWS)) * FINDING_ROW;
			this.findingHost.style.height = `${this.findingRows.length ? height : 0}px`;
			this.findingHost.classList.toggle('empty', !this.findingRows.length);
			this.findingList.layout(this.findingRows.length ? height : 0);
		}
	}

	private section(parent: HTMLElement, title: string, hint?: string): HTMLElement {
		const section = append(parent, $('.volt-http-sec-section'));
		const head = append(section, $('.volt-http-sec-section-head'));
		append(head, $('.volt-http-sec-section-title')).textContent = title;
		if (hint) {
			append(section, $('.volt-http-note.volt-http-sec-section-hint')).textContent = hint;
		}
		return section;
	}

	// --- Setup -----------------------------------------------------------------------------------

	private renderSetup(): void {
		const file = this.file!;
		const page = append(this.body, $('.volt-http-sec-setup'));

		const about = this.section(page, localize('voltHttp.secAbout', "Description"));
		const description = append(about, $('input.volt-http-input.volt-http-sec-description')) as HTMLInputElement;
		description.type = 'text';
		description.spellcheck = false;
		description.value = file.description;
		description.placeholder = localize('voltHttp.secDescriptionPlaceholder', "What this scan covers (optional)");
		description.setAttribute('aria-label', localize('voltHttp.secDescriptionAria', "Scan description"));
		this.view.add(addDisposableListener(description, EventType.CHANGE, () => void this.security.update(this.uri, next => next.description = description.value.trim())));

		const targets = this.section(page, localize('voltHttp.secTargets', "Targets"), localize('voltHttp.secTargetsHint', "The requests to scan. Each is sent once, the way Send sends it, and its answer is checked."));
		this.targetHost = append(targets, $('.volt-http-sec-tree'));
		void this.buildTargets();

		const checks = this.section(page, localize('voltHttp.secChecks', "Checks"), localize('voltHttp.secChecksHint', "Passive checks read the answers the requests get anyway. Active ones send extra requests and run only when Active checks are on."));
		this.checkHost = append(checks, $('.volt-http-sec-list'));
		this.buildChecks();

		this.activeEl = append(page, $('.volt-http-sec-section.volt-http-sec-active'));
		this.renderActive();
		void this.loadHosts();
	}

	/** Brings Setup up to date with the file without drawing it again (scroll and focus stay). */
	private refreshSetup(): void {
		if (!this.checkList) {
			return;
		}
		this.pickedFromFile();
		this.targetTree?.rerender();
		this.checkList.rerender();
		this.renderActive();
		void this.loadHosts();
	}

	private async buildTargets(): Promise<void> {
		const entries = await this.collections.collections(this.host.root);
		const treeHost = this.targetHost;
		if (this._store.isDisposed || !treeHost || treeHost !== this.targetHost) {
			return;
		}
		const nodes: ITargetNode[] = [];
		for (const entry of entries) {
			if (entry.error) {
				continue;
			}
			const ref = this.security.collectionRef(this.root, entry.uri);
			const walk = (items: readonly IHttpItem[], path: readonly string[]): ITargetNode[] => items.map(item => {
				const itemPath = [...path, item.name];
				if (item.kind === 'request') {
					const request = this.collections.draftOf(httpDraftKey(entry.uri, item.id)) ?? item;
					return { kind: 'request', id: `${entry.uri.toString()}#${item.id}`, label: httpRequestLabel(request), collection: entry.uri, ref, path: itemPath, keys: [httpDraftKey(entry.uri, item.id)], method: httpRequestBadge(request), badgeKey: httpRequestBadgeKey(request), children: [] };
				}
				const children = walk(item.items, itemPath);
				return { kind: 'folder', id: `${entry.uri.toString()}#${item.id}`, label: item.name, collection: entry.uri, ref, path: itemPath, keys: children.flatMap(child => child.keys), children };
			});
			const children = walk(entry.collection.items, []);
			if (children.length) {
				const label = entry.collection.format === 'postman' ? entry.collection.name : ref;
				nodes.push({ kind: 'collection', id: entry.uri.toString(), label, collection: entry.uri, ref, path: [], keys: children.flatMap(child => child.keys), children });
			}
		}
		this.targetNodes = nodes;
		this.pickedFromFile();
		if (!nodes.length) {
			append(treeHost, $('.volt-http-empty.volt-http-sec-empty')).textContent = localize('voltHttp.secNoCollections', "No collections in this project yet. Add a collection or an .http file first.");
			return;
		}
		const delegate: IListVirtualDelegate<ITargetNode> = { getHeight: () => TREE_ROW, getTemplateId: () => 'target' };
		const renderer: ITreeRenderer<ITargetNode, void, ITargetTemplate> = {
			templateId: 'target',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-row.tree.volt-http-sec-target-row'));
				const check = append(row, $('span.volt-http-check'));
				return { check, icon: append(row, $('span.volt-http-row-icon')), method: append(row, $('span.volt-http-row-method')), label: append(row, $('span.volt-http-row-label')), detail: append(row, $('span.volt-http-row-detail')) };
			},
			renderElement: (node: ITreeNode<ITargetNode, void>, _index, template) => {
				const element = node.element;
				const picked = element.keys.filter(key => this.picked.has(key)).length;
				const all = picked > 0 && picked === element.keys.length;
				template.check.classList.toggle('checked', picked > 0);
				template.check.replaceChildren(renderIcon(all || !picked ? Codicon.check : Codicon.dash));
				template.icon.replaceChildren();
				if (element.kind !== 'request') {
					template.icon.appendChild(renderIcon(element.kind === 'collection' ? Codicon.library : Codicon.folder));
				}
				template.method.textContent = element.method ?? '';
				if (element.badgeKey) {
					template.method.dataset.method = element.badgeKey;
				} else {
					template.method.removeAttribute('data-method');
				}
				template.label.textContent = element.label;
				template.detail.textContent = element.kind === 'request' ? '' : localize('voltHttp.secPickedOf', "{0} of {1}", picked, element.keys.length);
			},
			disposeTemplate: () => { },
		};
		const tree = this.targetTree = this.view.add(this.instantiationService.createInstance(WorkbenchObjectTree<ITargetNode>, 'VoltHttpSecurityTargets', treeHost, delegate, [renderer], {
			accessibilityProvider: {
				getAriaLabel: node => {
					const picked = node.keys.filter(key => this.picked.has(key)).length;
					return `${node.method ? `${node.method} ` : ''}${node.label}, ${picked === node.keys.length ? localize('voltHttp.secAriaPicked', "picked") : picked ? localize('voltHttp.secAriaSome', "{0} of {1} picked", picked, node.keys.length) : localize('voltHttp.secAriaNotPicked', "not picked")}`;
				},
				getWidgetAriaLabel: () => localize('voltHttp.secTargetsAria', "Requests to scan"),
				getRole: () => 'checkbox',
				isChecked: node => node.keys.length > 0 && node.keys.every(key => this.picked.has(key)),
			},
			multipleSelectionSupport: false,
			identityProvider: { getId: node => node.id },
			alwaysConsumeMouseWheel: false,
		}));
		this.view.add(tree.onMouseClick(event => {
			const element = event.element;
			const target = event.browserEvent.target;
			const onCheck = target instanceof Element && !!target.closest('.volt-http-check');
			if (element && (onCheck || element.kind === 'request')) {
				this.toggleTarget(element);
			}
		}));
		this.view.add(tree.onKeyDown(event => {
			if (event.key === ' ') {
				event.preventDefault();
				event.stopPropagation();
				const [focused] = tree.getFocus();
				if (focused) {
					this.toggleTarget(focused);
				}
			}
		}));
		this.view.add(tree.onDidChangeContentHeight(() => this.layoutLists()));
		const toElement = (node: ITargetNode): IObjectTreeElement<ITargetNode> => ({ element: node, children: node.children.map(toElement), collapsible: node.kind !== 'request', collapsed: node.kind === 'folder' });
		tree.setChildren(null, nodes.map(toElement));
		this.layoutLists();
	}

	/** The picked requests as the file's targets say. */
	private pickedFromFile(): void {
		const file = this.file;
		this.picked = new Set();
		if (!file) {
			return;
		}
		for (const target of file.targets) {
			const uri = this.security.collectionUri(this.root, target.collection);
			const entry = uri ? this.collections.get(uri) : undefined;
			if (!uri || !entry || entry.error) {
				continue;
			}
			if (!target.path?.length) {
				httpRequestsOf(entry.collection.items).forEach(({ request }) => this.picked.add(httpDraftKey(uri, request.id)));
				continue;
			}
			const item = findHttpItemByPath(entry.collection, target.path);
			if (item?.kind === 'request') {
				this.picked.add(httpDraftKey(uri, item.id));
			} else if (item) {
				httpRequestsOf(item.items).forEach(({ request }) => this.picked.add(httpDraftKey(uri, request.id)));
			}
		}
	}

	private toggleTarget(node: ITargetNode): void {
		const all = node.keys.length > 0 && node.keys.every(key => this.picked.has(key));
		for (const key of node.keys) {
			if (all) {
				this.picked.delete(key);
			} else {
				this.picked.add(key);
			}
		}
		this.targetTree?.rerender();
		// Targets as short as they go: a whole collection or folder when every request in it is picked.
		const targets: IHttpSecurityTarget[] = [];
		const walk = (nodes: readonly ITargetNode[]) => {
			for (const item of nodes) {
				const count = item.keys.filter(key => this.picked.has(key)).length;
				if (!count) {
					continue;
				}
				if (count === item.keys.length) {
					targets.push({ collection: item.ref, ...(item.kind === 'collection' ? {} : { path: [...item.path] }) });
				} else {
					walk(item.children);
				}
			}
		};
		walk(this.targetNodes);
		const shown = new Set(this.targetNodes.map(item => item.ref));
		void this.security.update(this.uri, file => {
			// Targets in collections this project no longer shows stay as they are.
			file.targets = [...file.targets.filter(target => !shown.has(target.collection)), ...targets];
		});
	}

	private buildChecks(): void {
		const host = this.checkHost!;
		const rows: CheckRow[] = [];
		for (const category of Object.keys(HTTP_SECURITY_CATEGORIES) as HttpSecurityCategory[]) {
			const checks = HTTP_SECURITY_CHECKS.filter(check => check.category === category);
			if (checks.length) {
				rows.push({ kind: 'category', category, checks }, ...checks.map(check => ({ kind: 'check' as const, check })));
			}
		}
		const height = rows.reduce((sum, row) => sum + (row.kind === 'category' ? CATEGORY_ROW : CHECK_ROW), 0);
		host.style.height = `${height}px`;
		const enabled = (id: string) => !!this.file && isHttpSecurityCheckEnabled(this.file, id);
		const renderer: IListRenderer<CheckRow, ICheckTemplate> = {
			templateId: 'check',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-sec-check-row'));
				const check = append(row, $('span.volt-http-check'));
				check.appendChild(renderIcon(Codicon.check));
				const text = append(row, $('.volt-http-sec-check-text'));
				const line = append(text, $('.volt-http-sec-check-line'));
				const title = append(line, $('span.volt-http-sec-check-title'));
				const tag = append(line, $('span.volt-http-sec-tag'));
				return { row, check, title, tag, description: append(text, $('.volt-http-sec-check-description')) };
			},
			renderElement: (row, _index, template) => {
				template.row.classList.toggle('category', row.kind === 'category');
				if (row.kind === 'category') {
					const on = row.checks.filter(check => enabled(check.id)).length;
					template.check.classList.toggle('checked', on > 0);
					template.check.replaceChildren(renderIcon(on === row.checks.length || !on ? Codicon.check : Codicon.dash));
					template.title.textContent = HTTP_SECURITY_CATEGORIES[row.category];
					template.tag.textContent = localize('voltHttp.secOnOf', "{0} of {1} on", on, row.checks.length);
					template.tag.className = 'volt-http-sec-tag muted';
					template.description.textContent = '';
					setAgentTooltip(template.row, '');
					return;
				}
				const check = row.check;
				template.check.classList.toggle('checked', enabled(check.id));
				template.check.replaceChildren(renderIcon(Codicon.check));
				template.title.textContent = check.title;
				template.tag.textContent = check.active ? localize('voltHttp.secActiveTag', "Active") : '';
				template.tag.className = `volt-http-sec-tag${check.active ? ' active' : ''}`;
				template.description.textContent = check.description;
				setAgentTooltip(template.row, `${check.description}\n\n${check.risk}\n\nOWASP ${check.owasp} ${HTTP_SECURITY_OWASP[check.owasp]}${check.cwe !== undefined ? `, CWE-${check.cwe}` : ''}`);
			},
			disposeTemplate: () => { },
		};
		const list = this.checkList = this.view.add(this.instantiationService.createInstance(WorkbenchList<CheckRow>, 'VoltHttpSecurityChecks', host, { getHeight: row => row.kind === 'category' ? CATEGORY_ROW : CHECK_ROW, getTemplateId: () => 'check' }, [renderer], {
			accessibilityProvider: {
				getAriaLabel: row => row.kind === 'category' ? HTTP_SECURITY_CATEGORIES[row.category] : `${row.check.title}${row.check.active ? `, ${localize('voltHttp.secActiveTag', "Active")}` : ''}: ${row.check.description}`,
				getWidgetAriaLabel: () => localize('voltHttp.secChecksAria', "Checks"),
				getRole: () => 'checkbox',
				isChecked: row => row.kind === 'category' ? row.checks.every(check => enabled(check.id)) : enabled(row.check.id),
			},
			multipleSelectionSupport: false,
			identityProvider: { getId: row => row.kind === 'category' ? `category:${row.category}` : row.check.id },
			alwaysConsumeMouseWheel: false,
		}));
		const toggle = (row: CheckRow) => {
			const ids = row.kind === 'category' ? row.checks.map(check => check.id) : [row.check.id];
			const next = !ids.every(enabled);
			void this.security.update(this.uri, file => {
				for (const id of ids) {
					if (next) {
						delete file.checks[id];
					} else {
						file.checks[id] = false;
					}
				}
			});
		};
		this.view.add(list.onMouseClick(event => event.element && toggle(event.element)));
		this.view.add(list.onKeyDown(event => {
			if (event.key === ' ' || event.key === 'Enter') {
				event.preventDefault();
				event.stopPropagation();
				const [focused] = list.getFocusedElements();
				if (focused) {
					toggle(focused);
				}
			}
		}));
		list.layout(height);
		list.splice(0, 0, rows);
	}

	private renderActive(): void {
		const parent = this.activeEl;
		const file = this.file;
		if (!parent || !file) {
			return;
		}
		this.activeStore.clear();
		this.hostList = undefined;
		clearNode(parent);
		const options = normalizeHttpSecurityOptions(file.options);
		const head = append(parent, $('.volt-http-sec-section-head'));
		append(head, $('.volt-http-sec-section-title')).textContent = localize('voltHttp.secActiveTitle', "Active checks");

		const toggleRow = append(parent, $('.volt-http-sec-toggle'));
		const activeLabel = localize('voltHttp.secActiveOn', "Run active checks");
		const active = createHttpCheck(toggleRow, options.active, activeLabel, checked => void this.security.update(this.uri, next => next.options = { ...normalizeHttpSecurityOptions(next.options), active: checked }));
		const label = append(toggleRow, $('span.volt-http-sec-toggle-label'));
		label.textContent = activeLabel;
		this.activeStore.add(addDisposableListener(label, EventType.CLICK, () => active.element.click()));
		append(parent, $('.volt-http-note.volt-http-sec-explain')).textContent = localize('voltHttp.secActiveExplain', "Active checks send extra requests to your API: each request again without its credentials or with one parameter changed to a harmless detection string (a single quote, {{7*7}}, <volt-xss-probe>, ../../etc/passwd), an Origin and a redirect target that do not exist, and at most 15 identical requests to look for rate limiting. Nothing destructive or time based is sent, DELETE never is, and they go out at most {0} per second, only to the hosts you authorize below.", options.requestsPerSecond);

		append(parent, $('.volt-http-sublabel')).textContent = localize('voltHttp.secHosts', "Hosts");
		const hostHost = append(parent, $('.volt-http-sec-list.volt-http-sec-hosts'));
		const hostNote = append(parent, $('.volt-http-note.volt-http-sec-host-note'));
		this.renderHosts(hostHost, hostNote);

		const unsafeRow = append(parent, $('.volt-http-sec-toggle'));
		const unsafeLabel = localize('voltHttp.secUnsafe', "Also test requests that change data (POST, PUT, PATCH)");
		const unsafe = createHttpCheck(unsafeRow, options.includeUnsafeMethods, unsafeLabel, checked => void this.security.update(this.uri, next => next.options = { ...normalizeHttpSecurityOptions(next.options), includeUnsafeMethods: checked }));
		const unsafeText = append(unsafeRow, $('span.volt-http-sec-toggle-label'));
		unsafeText.textContent = unsafeLabel;
		this.activeStore.add(addDisposableListener(unsafeText, EventType.CLICK, () => unsafe.element.click()));
		const warning = append(parent, $('.volt-http-sec-warning'));
		warning.classList.toggle('on', options.includeUnsafeMethods);
		append(warning, $('span.volt-http-sec-warning-icon')).appendChild(renderIcon(Codicon.warning));
		append(warning, $('span')).textContent = localize('voltHttp.secUnsafeWarning', "These requests are then sent as they are and again with changed bodies, which can create or change records. Point the scan at a test environment. DELETE is never sent.");

		const rateRow = append(parent, $('.volt-http-sec-rate'));
		append(rateRow, $('span.volt-http-sec-toggle-label')).textContent = localize('voltHttp.secRate', "Requests per second");
		const rates = [1, 2, 5, 10, HTTP_SECURITY_MAX_RATE];
		const current = options.requestsPerSecond;
		const choices = [...new Set([...rates, current])].sort((a, b) => a - b);
		createHttpDropdown(rateRow, this.contextViewService, {
			options: choices.map(rate => ({ id: String(rate), label: rate === 1 ? localize('voltHttp.secRateOne', "1 per second") : localize('voltHttp.secRateMany', "{0} per second", rate), ...(rate === 5 ? { description: localize('voltHttp.secRateDefault', "The default") } : {}) })),
			value: String(current),
			ariaLabel: localize('voltHttp.secRateAria', "Requests per second"),
			onChange: value => void this.security.update(this.uri, next => next.options = { ...normalizeHttpSecurityOptions(next.options), requestsPerSecond: Number(value) }),
		}, this.activeStore);
	}

	private renderHosts(listHost: HTMLElement, note: HTMLElement): void {
		const rows = this.hostRows;
		listHost.classList.toggle('empty', !rows.length);
		if (!rows.length) {
			listHost.style.height = '0px';
			note.textContent = this.file?.targets.length ? localize('voltHttp.secHostsNone', "The targets' URLs do not resolve to a host yet: pick an environment that fills in their variables.") : localize('voltHttp.secHostsPick', "Pick targets to see the hosts they go to.");
			return;
		}
		note.textContent = localize('voltHttp.secHostsHint', "Active checks run only when every host the targets go to is ticked. Only you can tick them, here; agents cannot, and a host only written into the scan file stays unticked.");
		const authorize = localize('voltHttp.secAuthorize', "I own this API or have permission to test it");
		const renderer: IListRenderer<IHostRow, { readonly check: HTMLElement; readonly host: HTMLElement; readonly count: HTMLElement; readonly text: HTMLElement }> = {
			templateId: 'host',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-sec-check-row.volt-http-sec-host-row'));
				const check = append(row, $('span.volt-http-check'));
				check.appendChild(renderIcon(Codicon.check));
				const text = append(row, $('.volt-http-sec-check-text'));
				const line = append(text, $('.volt-http-sec-check-line'));
				return { check, host: append(line, $('span.volt-http-sec-host')), count: append(line, $('span.volt-http-sec-tag.muted')), text: append(text, $('.volt-http-sec-check-description')) };
			},
			renderElement: (row, _index, template) => {
				template.check.classList.toggle('checked', !!row.authorizedAt);
				template.host.textContent = row.host;
				template.count.textContent = row.requests === 1 ? localize('voltHttp.secOneRequest', "1 request") : row.requests ? localize('voltHttp.secRequests', "{0} requests", row.requests) : localize('voltHttp.secNotInTargets', "not in the targets");
				const at = row.authorizedAt ? Date.parse(row.authorizedAt) : NaN;
				template.text.textContent = row.authorizedAt ? `${authorize}${Number.isFinite(at) ? ` (${localize('voltHttp.secAuthorizedAt', "ticked {0}", new Date(at).toLocaleDateString())})` : ''}` : authorize;
			},
			disposeTemplate: () => { },
		};
		const list = this.hostList = this.activeStore.add(this.instantiationService.createInstance(WorkbenchList<IHostRow>, 'VoltHttpSecurityHosts', listHost, { getHeight: () => HOST_ROW, getTemplateId: () => 'host' }, [renderer], {
			accessibilityProvider: {
				getAriaLabel: row => `${row.host}: ${authorize}`,
				getWidgetAriaLabel: () => localize('voltHttp.secHostsAria', "Hosts you authorize for active checks"),
				getRole: () => 'checkbox',
				isChecked: row => !!row.authorizedAt,
			},
			multipleSelectionSupport: false,
			identityProvider: { getId: row => row.host },
			alwaysConsumeMouseWheel: false,
		}));
		const toggle = (row: IHostRow) => void this.security.setAuthorized(this.uri, row.host, !row.authorizedAt);
		this.activeStore.add(list.onMouseClick(event => event.element && toggle(event.element)));
		this.activeStore.add(list.onKeyDown(event => {
			if (event.key === ' ' || event.key === 'Enter') {
				event.preventDefault();
				event.stopPropagation();
				const [focused] = list.getFocusedElements();
				if (focused) {
					toggle(focused);
				}
			}
		}));
		listHost.style.height = `${rows.length * HOST_ROW}px`;
		list.layout(rows.length * HOST_ROW);
		list.splice(0, 0, rows);
	}

	/** The hosts the targets go to, and the ones authorized before (to take an authorization back). */
	private async loadHosts(): Promise<void> {
		const found = await this.security.hostsOf(this.uri, this.host.root).catch(() => ({ hosts: [], unresolved: 0 }));
		const file = this.file;
		if (this._store.isDisposed || !file || !this.activeEl) {
			return;
		}
		const rows = new Map<string, IHostRow>();
		for (const item of found.hosts) {
			rows.set(item.host, { host: item.host, requests: item.requests });
		}
		// Only what the user ticked in this Volt counts; a host merely written into the file shows unticked.
		for (const item of file.authorizedHosts) {
			if (!rows.has(item.host)) {
				rows.set(item.host, { host: item.host, requests: 0 });
			}
		}
		for (const item of this.security.authorizedHostsOf(this.uri)) {
			rows.set(item.host, { host: item.host, requests: rows.get(item.host)?.requests ?? 0, authorizedAt: item.at || new Date(0).toISOString() });
		}
		const next = [...rows.values()].sort((a, b) => b.requests - a.requests || a.host.localeCompare(b.host));
		if (JSON.stringify(next) !== JSON.stringify(this.hostRows) || !this.hostList) {
			this.hostRows = next;
			this.renderActive();
		}
	}

	// --- Findings --------------------------------------------------------------------------------

	private visibleFindings(): IHttpSecurityFinding[] {
		const triage = this.file?.triage ?? {};
		const filter = HTTP_SECURITY_SEVERITIES.find(severity => severity === this.state.memory.filter);
		const hideTriaged = this.state.memory.hideTriaged === true;
		const sort: FindingSort = this.state.memory.sort === 'endpoint' || this.state.memory.sort === 'check' ? this.state.memory.sort : 'severity';
		let rows = sortHttpSecurityFindings(this.findings()).filter(finding => (!filter || finding.severity === filter) && (!hideTriaged || isHttpSecurityFindingOpen(finding, triage)));
		if (sort === 'endpoint') {
			rows = rows.sort((a, b) => httpSecurityEndpointLabel(a.endpoint).localeCompare(httpSecurityEndpointLabel(b.endpoint)));
		} else if (sort === 'check') {
			rows = rows.sort((a, b) => a.checkId.localeCompare(b.checkId));
		}
		// Open ones first, triaged ones after, each group in the order picked.
		return [...rows.filter(finding => isHttpSecurityFindingOpen(finding, triage)), ...rows.filter(finding => !isHttpSecurityFindingOpen(finding, triage))];
	}

	private renderFindings(): void {
		const page = append(this.body, $('.volt-http-sec-findings'));
		this.summaryEl = append(page, $('.volt-http-sec-summary'));
		this.aiEl = append(page, $('.volt-http-sec-ai'));
		this.chartsEl = append(page, $('.volt-http-sec-charts'));
		this.notesEl = append(page, $('.volt-http-sec-notes'));
		const split = append(page, $('.volt-http-sec-split'));
		const listColumn = append(split, $('.volt-http-sec-list-column'));
		this.toolbarEl = append(listColumn, $('.volt-http-sec-toolbar'));
		this.findingHost = append(listColumn, $('.volt-http-sec-list.volt-http-sec-finding-list'));
		this.detailEl = append(split, $('.volt-http-sec-detail'));

		const renderer: IListRenderer<IHttpSecurityFinding, IFindingTemplate> = {
			templateId: 'finding',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-sec-finding-row'));
				const severity = append(row, $('span.volt-http-sec-badge'));
				const main = append(row, $('.volt-http-sec-finding-main'));
				const title = append(main, $('.volt-http-sec-finding-title'));
				const meta = append(main, $('.volt-http-sec-finding-meta'));
				return { row, severity, title, method: append(meta, $('span.volt-http-row-method')), path: append(meta, $('span.volt-http-sec-finding-path')), detail: append(meta, $('span.volt-http-sec-finding-detail')) };
			},
			renderElement: (finding, _index, template) => {
				const triage = this.file?.triage[finding.fingerprint];
				template.row.classList.toggle('triaged', !!triage);
				template.severity.dataset.severity = finding.severity;
				template.severity.textContent = SEVERITY_LABELS[finding.severity];
				template.title.textContent = finding.title;
				template.method.textContent = finding.endpoint.method;
				template.method.dataset.method = finding.endpoint.method.toUpperCase();
				const url = httpSecurityUrl(finding.endpoint.url);
				template.path.textContent = `${url ? url.pathname : finding.endpoint.url}${finding.parameter ? `${DOT}${finding.parameter}` : ''}`;
				template.detail.textContent = [CONFIDENCE_LABELS[finding.confidence], ...(finding.occurrences && finding.occurrences > 1 ? [localize('voltHttp.secSeenOn', "{0} requests", finding.occurrences)] : []), ...(triage ? [TRIAGE_LABELS[triage]] : [])].join(DOT);
				setAgentTooltip(template.row, `${finding.title}\n${finding.endpoint.method} ${finding.endpoint.url}`);
			},
			disposeTemplate: () => { },
		};
		const list = this.findingList = this.view.add(this.instantiationService.createInstance(WorkbenchList<IHttpSecurityFinding>, 'VoltHttpSecurityFindings', this.findingHost, { getHeight: () => FINDING_ROW, getTemplateId: () => 'finding' }, [renderer], {
			accessibilityProvider: {
				getAriaLabel: finding => `${SEVERITY_LABELS[finding.severity]}: ${finding.title}, ${httpSecurityEndpointLabel(finding.endpoint)}, ${CONFIDENCE_LABELS[finding.confidence]}`,
				getWidgetAriaLabel: () => localize('voltHttp.secFindingsAria', "Findings"),
			},
			multipleSelectionSupport: false,
			identityProvider: { getId: finding => finding.fingerprint },
			alwaysConsumeMouseWheel: false,
		}));
		this.view.add(list.onDidChangeSelection(event => {
			const [finding] = event.elements;
			if (finding && finding.fingerprint !== this.state.memory.selected) {
				this.state.memory.selected = finding.fingerprint;
				this.renderDetail();
			}
		}));
		this.refreshFindings();
	}

	/** Brings the Findings tab up to date with the scan and the file, keeping the selection. */
	private refreshFindings(): void {
		if (!this.findingList) {
			return;
		}
		this.renderSummary();
		this.renderAi();
		this.renderCharts();
		this.renderNotes();
		this.renderToolbar();
		const rows = this.findingRows = this.visibleFindings();
		const list = this.findingList;
		list.splice(0, list.length, rows);
		this.layoutLists();
		const selected = typeof this.state.memory.selected === 'string' ? this.state.memory.selected : undefined;
		let index = rows.findIndex(finding => finding.fingerprint === selected);
		if (index < 0 && rows.length) {
			index = 0;
			this.state.memory.selected = rows[0].fingerprint;
		}
		if (index >= 0) {
			list.setSelection([index]);
			list.setFocus([index]);
		}
		this.renderDetail();
	}

	private renderSummary(): void {
		const parent = this.summaryEl!;
		this.summaryStore.clear();
		clearNode(parent);
		const file = this.file;
		const findings = this.findings();
		const scan = this.scan;
		const record = file?.lastScan;
		if (!findings.length && !scan && !record) {
			const empty = append(parent, $('.volt-http-sec-empty-state'));
			append(empty, $('.volt-http-sec-empty-title')).textContent = localize('voltHttp.secNoScan', "No scan yet");
			append(empty, $('.volt-http-note')).textContent = localize('voltHttp.secNoScanHint', "Pick targets under Setup and press Scan. Passive checks read the answers your requests already get; nothing extra is sent until you turn on active checks and authorize the hosts.");
			return;
		}
		const summary = summarizeHttpSecurity(findings, file?.triage ?? {});
		// A scan that read no answer has nothing to grade: an A there would read as "secure".
		const nothingRead = !scan?.running && !findings.length && (scan?.requests ?? record?.requests ?? 0) === 0;
		const grade = append(parent, $('.volt-http-sec-grade'));
		grade.dataset.grade = nothingRead ? 'none' : summary.grade;
		setAgentTooltip(grade, nothingRead ? localize('voltHttp.secNoGradeTitle', "No request was scanned, so there is nothing to grade. The notes below say why.") : summary.explanation);
		append(grade, $('span.volt-http-sec-grade-letter')).textContent = nothingRead ? '-' : summary.grade;
		const gradeText = append(grade, $('span.volt-http-sec-grade-text'));
		append(gradeText, $('span.volt-http-sec-grade-score')).textContent = nothingRead ? localize('voltHttp.secNoGrade', "Nothing scanned") : localize('voltHttp.secScore', "{0} of 100", summary.score);
		append(gradeText, $('span.volt-http-sec-grade-caption')).textContent = nothingRead ? localize('voltHttp.secNoGradeCaption', "No grade") : scan?.running ? localize('voltHttp.secSoFar', "so far") : localize('voltHttp.secScoreCaption', "Score");

		const chips = append(parent, $('.volt-http-sec-chips'));
		const filter = this.state.memory.filter;
		for (const severity of HTTP_SECURITY_SEVERITIES) {
			const chip = append(chips, $('button.volt-http-sec-chip')) as HTMLButtonElement;
			chip.type = 'button';
			chip.dataset.severity = severity;
			chip.classList.toggle('active', filter === severity);
			chip.setAttribute('aria-pressed', String(filter === severity));
			setAgentTooltip(chip, filter === severity ? localize('voltHttp.secChipClear', "Show every severity") : localize('voltHttp.secChipFilter', "Show only {0} findings", SEVERITY_LABELS[severity]));
			append(chip, $('span.volt-http-sec-dot'));
			append(chip, $('span.volt-http-sec-chip-count')).textContent = String(summary.bySeverity[severity]);
			append(chip, $('span.volt-http-sec-chip-label')).textContent = SEVERITY_LABELS[severity];
			this.summaryStore.add(addDisposableListener(chip, EventType.CLICK, () => {
				this.state.memory.filter = filter === severity ? undefined : severity;
				this.refreshFindings();
			}));
		}
		const stats = append(parent, $('.volt-http-sec-stats'));
		const requests = scan?.requests ?? record?.requests ?? 0;
		const probes = scan?.probes ?? record?.probes ?? 0;
		append(stats, $('span')).textContent = requests === 1 ? localize('voltHttp.secStatRequest', "1 request scanned") : localize('voltHttp.secStatRequests', "{0} requests scanned", requests);
		append(stats, $('span')).textContent = probes === 1 ? localize('voltHttp.secStatProbe', "1 probe sent") : localize('voltHttp.secStatProbes', "{0} probes sent", probes);
		if (summary.triaged) {
			append(stats, $('span')).textContent = localize('voltHttp.secStatTriaged', "{0} triaged", summary.triaged);
		}
		const active = scan ? scan.active : record?.active;
		append(stats, $('span')).textContent = active ? localize('voltHttp.secStatActive', "Passive and active checks") : localize('voltHttp.secStatPassive', "Passive checks only");
	}

	private renderCharts(): void {
		const parent = this.chartsEl!;
		clearNode(parent);
		const findings = this.findings();
		if (!findings.length) {
			return;
		}
		const summary = summarizeHttpSecurity(findings, this.file?.triage ?? {});
		const total = HTTP_SECURITY_SEVERITIES.reduce((sum, severity) => sum + summary.bySeverity[severity], 0);

		const severityChart = append(parent, $('.volt-http-sec-chart'));
		append(severityChart, $('.volt-http-sec-chart-title')).textContent = localize('voltHttp.secChartSeverity', "Open findings by severity");
		const bar = append(severityChart, $('.volt-http-sec-stack'));
		bar.setAttribute('role', 'img');
		bar.setAttribute('aria-label', HTTP_SECURITY_SEVERITIES.map(severity => `${SEVERITY_LABELS[severity]} ${summary.bySeverity[severity]}`).join(', '));
		if (!total) {
			bar.classList.add('empty');
		}
		for (const severity of HTTP_SECURITY_SEVERITIES) {
			const count = summary.bySeverity[severity];
			if (count) {
				const segment = append(bar, $('span.volt-http-sec-segment'));
				segment.dataset.severity = severity;
				segment.style.flexGrow = String(count);
				setAgentTooltip(segment, `${SEVERITY_LABELS[severity]}: ${count}`);
			}
		}
		const legend = append(severityChart, $('.volt-http-sec-legend'));
		for (const severity of HTTP_SECURITY_SEVERITIES) {
			const key = append(legend, $('span.volt-http-sec-key'));
			key.dataset.severity = severity;
			append(key, $('span.volt-http-sec-dot'));
			append(key, $('span')).textContent = SEVERITY_LABELS[severity];
			append(key, $('b')).textContent = String(summary.bySeverity[severity]);
		}

		const owaspChart = append(parent, $('.volt-http-sec-chart'));
		append(owaspChart, $('.volt-http-sec-chart-title')).textContent = localize('voltHttp.secChartOwasp', "Open findings by OWASP API Security Top 10 (2023)");
		const rows = append(owaspChart, $('.volt-http-sec-bars'));
		rows.setAttribute('role', 'img');
		rows.setAttribute('aria-label', summary.byOwasp.map(item => `${item.id} ${item.title}: ${item.count}`).join(', '));
		const most = Math.max(1, ...summary.byOwasp.map(item => item.count));
		for (const item of summary.byOwasp) {
			const row = append(rows, $('.volt-http-sec-bar-row'));
			row.classList.toggle('none', !item.count);
			setAgentTooltip(row, `${item.id} ${item.title}: ${item.count}`);
			append(row, $('span.volt-http-sec-bar-id')).textContent = item.id;
			append(row, $('span.volt-http-sec-bar-label')).textContent = item.title;
			const track = append(row, $('span.volt-http-sec-bar-track'));
			if (item.count) {
				const fill = append(track, $('span.volt-http-sec-bar-fill'));
				fill.style.width = `${Math.max(3, (item.count / most) * 100)}%`;
				if (item.worst) {
					fill.dataset.severity = item.worst;
				}
			}
			append(row, $('span.volt-http-sec-bar-count')).textContent = String(item.count);
		}
	}

	private renderNotes(): void {
		const parent = this.notesEl!;
		clearNode(parent);
		const notes = this.scan?.notes ?? this.file?.lastScan?.notes ?? [];
		const error = this.scan?.error;
		if (error) {
			append(parent, $('.volt-http-sec-note.error')).textContent = localize('voltHttp.secScanFailed', "The scan failed: {0}", error);
		}
		if (this.scan?.stopped || (!this.scan && this.file?.lastScan?.stopped)) {
			append(parent, $('.volt-http-sec-note')).textContent = localize('voltHttp.secStopped', "The scan was stopped before the end.");
		}
		for (const note of notes.slice(0, 8)) {
			append(parent, $('.volt-http-sec-note')).textContent = note;
		}
		if (notes.length > 8) {
			append(parent, $('.volt-http-sec-note')).textContent = localize('voltHttp.secMoreNotes', "{0} more notes in the report.", notes.length - 8);
		}
	}

	private renderToolbar(): void {
		const parent = this.toolbarEl!;
		this.toolbarStore.clear();
		clearNode(parent);
		const findings = this.findings();
		if (!findings.length) {
			if (this.scan?.running || this.file?.lastScan) {
				const read = this.scan?.requests ?? this.file?.lastScan?.requests ?? 0;
				append(parent, $('.volt-http-note')).textContent = this.scan?.running ? localize('voltHttp.secNothingYet', "Nothing found yet.") : read ? localize('voltHttp.secNothing', "The enabled checks found nothing.") : localize('voltHttp.secNothingRead', "No request was scanned, so nothing was checked.");
			}
			return;
		}
		const count = append(parent, $('span.volt-http-sec-count'));
		const shown = this.findingRows.length || this.visibleFindings().length;
		count.textContent = shown === findings.length ? localize('voltHttp.secCount', "{0} findings", findings.length) : localize('voltHttp.secCountOf', "{0} of {1} findings", shown, findings.length);
		const filter = HTTP_SECURITY_SEVERITIES.find(severity => severity === this.state.memory.filter);
		if (filter) {
			const clear = append(parent, $('button.volt-http-link')) as HTMLButtonElement;
			clear.type = 'button';
			clear.textContent = localize('voltHttp.secClearFilter', "Show All");
			this.toolbarStore.add(addDisposableListener(clear, EventType.CLICK, () => {
				this.state.memory.filter = undefined;
				this.refreshFindings();
			}));
		}
		append(parent, $('.volt-http-spacer'));
		const hideLabel = localize('voltHttp.secHideTriaged', "Hide triaged");
		const hide = createHttpCheck(parent, this.state.memory.hideTriaged === true, hideLabel, checked => {
			this.state.memory.hideTriaged = checked;
			this.refreshFindings();
		});
		const hideText = append(parent, $('span.volt-http-sec-toggle-label'));
		hideText.textContent = hideLabel;
		this.toolbarStore.add(addDisposableListener(hideText, EventType.CLICK, () => hide.element.click()));
		const sort = this.state.memory.sort === 'endpoint' || this.state.memory.sort === 'check' ? this.state.memory.sort : 'severity';
		createHttpDropdown<FindingSort>(parent, this.contextViewService, {
			options: [
				{ id: 'severity', label: localize('voltHttp.secSortSeverity', "By Severity") },
				{ id: 'endpoint', label: localize('voltHttp.secSortEndpoint', "By Endpoint") },
				{ id: 'check', label: localize('voltHttp.secSortCheck', "By Check") },
			],
			value: sort,
			ariaLabel: localize('voltHttp.secSortAria', "Sort findings"),
			align: 'right',
			onChange: value => {
				this.state.memory.sort = value;
				this.refreshFindings();
			},
		}, this.toolbarStore);
	}

	private selectedFinding(): IHttpSecurityFinding | undefined {
		const selected = this.state.memory.selected;
		return this.findingRows.find(finding => finding.fingerprint === selected);
	}

	private renderDetail(): void {
		const parent = this.detailEl;
		if (!parent) {
			return;
		}
		const finding = this.selectedFinding();
		const triage = finding ? this.file?.triage[finding.fingerprint] : undefined;
		// The same finding as drawn, in the same state: leave it (and the reader's place) alone.
		if (finding && this.detailFor === finding && parent.dataset.triage === (triage ?? '') && parent.dataset.resend === (this.resendMessage?.fingerprint === finding.fingerprint ? this.resendMessage.text : '')) {
			return;
		}
		this.detailFor = finding;
		this.detailStore.clear();
		clearNode(parent);
		parent.classList.toggle('hidden', !finding);
		if (!finding) {
			return;
		}
		parent.dataset.triage = triage ?? '';
		parent.dataset.resend = this.resendMessage?.fingerprint === finding.fingerprint ? this.resendMessage.text : '';
		const check = httpSecurityCheck(finding.checkId);

		const head = append(parent, $('.volt-http-sec-detail-head'));
		const badge = append(head, $('span.volt-http-sec-badge'));
		badge.dataset.severity = finding.severity;
		badge.textContent = SEVERITY_LABELS[finding.severity];
		append(head, $('.volt-http-sec-detail-title')).textContent = finding.title;
		const meta = append(parent, $('.volt-http-sec-detail-meta'));
		const method = append(meta, $('span.volt-http-row-method'));
		method.textContent = finding.endpoint.method;
		method.dataset.method = finding.endpoint.method.toUpperCase();
		append(meta, $('span.volt-http-sec-detail-url')).textContent = finding.endpoint.url;
		const facts = append(parent, $('.volt-http-sec-detail-facts'));
		const fact = (label: string, value: string) => {
			const item = append(facts, $('span'));
			append(item, $('span.muted')).textContent = `${label} `;
			append(item, $('span')).textContent = value;
		};
		fact(localize('voltHttp.secFactConfidence', "Confidence"), CONFIDENCE_LABELS[finding.confidence]);
		if (finding.parameter) {
			fact(localize('voltHttp.secFactParameter', "Parameter"), finding.parameter);
		}
		if (finding.occurrences && finding.occurrences > 1) {
			fact(localize('voltHttp.secFactSeen', "Seen on"), localize('voltHttp.secFactSeenValue', "{0} requests of this host", finding.occurrences));
		}
		if (finding.endpoint.path.length) {
			fact(localize('voltHttp.secFactRequest', "Request"), finding.endpoint.path.join(' / '));
		}

		const actions = append(parent, $('.volt-http-sec-detail-actions'));
		const open = this.detailStore.add(createVoltButton(actions, 'secondary'));
		open.label = localize('voltHttp.secOpenRequest', "Open Request");
		this.detailStore.add(open.onDidClick(async () => {
			const located = await this.security.locate(this.uri, finding, this.host.root);
			if (located) {
				this.host.openRequest(located.collection, located.id, located.exchange);
			} else {
				this.notificationService.info(localize('voltHttp.secNoRequest', "The request of this finding is no longer in its collection."));
			}
		}));
		const resend = this.detailStore.add(createVoltButton(actions, 'secondary'));
		resend.label = check?.active ? localize('voltHttp.secResendProbe', "Resend Probe") : localize('voltHttp.secResend', "Resend Request");
		resend.enabled = !this.scan?.running;
		this.detailStore.add(resend.onDidClick(async () => {
			resend.enabled = false;
			const result = await this.security.resend(this.uri, finding.fingerprint, this.host.root).catch(err => ({ reproduced: false, message: err instanceof Error ? err.message : String(err) }));
			this.resendMessage = { fingerprint: finding.fingerprint, text: result.message };
			if (!this._store.isDisposed) {
				this.detailFor = undefined;
				this.renderDetail();
			}
		}));
		createHttpDropdown<'open' | HttpSecurityTriage>(actions, this.contextViewService, {
			options: [
				{ id: 'open', label: localize('voltHttp.secTriageOpen', "Open"), description: localize('voltHttp.secTriageOpenDesc', "Counts in the score") },
				{ id: 'falsePositive', label: TRIAGE_LABELS.falsePositive, description: localize('voltHttp.secTriageFalsePositiveDesc', "Not a real weakness") },
				{ id: 'accepted', label: TRIAGE_LABELS.accepted, description: localize('voltHttp.secTriageAcceptedDesc', "Known and accepted") },
				{ id: 'fixed', label: TRIAGE_LABELS.fixed, description: localize('voltHttp.secTriageFixedDesc', "Fixed; the next scan shows whether it is gone") },
			],
			value: triage ?? 'open',
			ariaLabel: localize('voltHttp.secTriageAria', "Mark this finding"),
			width: 260,
			onChange: value => void this.security.setTriage(this.uri, finding.fingerprint, value === 'open' ? undefined : value),
		}, this.detailStore);
		append(actions, $('.volt-http-spacer'));
		createHttpIconButton(actions, Codicon.copy, localize('voltHttp.secCopy', "Copy Finding"), () => void this.clipboardService.writeText(httpSecurityFindingText(finding, triage)));
		createHttpIconButton(actions, Codicon.commentDiscussion, localize('voltHttp.secInvestigateFinding', "Investigate in Chat"), () => this.investigateFinding(finding));
		if (this.resendMessage?.fingerprint === finding.fingerprint) {
			append(parent, $('.volt-http-sec-note.volt-http-sec-resend')).textContent = this.resendMessage.text;
		}

		const block = (title: string, text: string) => {
			const section = append(parent, $('.volt-http-sec-detail-block'));
			append(section, $('.volt-http-sec-detail-label')).textContent = title;
			append(section, $('.volt-http-sec-detail-text')).textContent = text;
			return section;
		};
		const what = check && finding.description.endsWith(check.risk) ? finding.description.slice(0, -check.risk.length).trim() : finding.description;
		block(localize('voltHttp.secWhat', "What it is"), what || (check?.description ?? ''));
		if (check && what !== finding.description) {
			block(localize('voltHttp.secWhy', "Why it matters"), check.risk);
		}
		const evidence = evidenceLines(finding.evidence);
		const evidenceBlock = append(parent, $('.volt-http-sec-detail-block'));
		append(evidenceBlock, $('.volt-http-sec-detail-label')).textContent = localize('voltHttp.secEvidence', "Evidence");
		if (finding.evidence.match) {
			const matched = append(evidenceBlock, $('.volt-http-sec-detail-text'));
			append(matched, $('span.muted')).textContent = `${localize('voltHttp.secMatched', "Matched")} `;
			append(matched, $('code.volt-http-sec-code')).textContent = finding.evidence.match;
		}
		append(evidenceBlock, $('.volt-http-sec-pre-label')).textContent = localize('voltHttp.secRequestSent', "Request sent");
		appendMarked(append(evidenceBlock, $('pre.volt-http-sec-pre')), evidence.request, finding.evidence.match);
		append(evidenceBlock, $('.volt-http-sec-pre-label')).textContent = localize('voltHttp.secResponse', "Response");
		appendMarked(append(evidenceBlock, $('pre.volt-http-sec-pre')), evidence.response, finding.evidence.match);
		block(localize('voltHttp.secReference', "Reference"), `OWASP ${finding.owasp}:2023 ${HTTP_SECURITY_OWASP[finding.owasp]}${finding.cwe !== undefined ? `, CWE-${finding.cwe}` : ''}`);
		block(localize('voltHttp.secFix', "Fix"), finding.remediation);
	}

	// --- Report ----------------------------------------------------------------------------------

	private renderReport(): void {
		const file = this.file!;
		const page = append(this.body, $('.volt-http-sec-report'));
		const bar = append(page, $('.volt-http-sec-report-actions'));
		append(bar, $('span.volt-http-sec-report-label')).textContent = localize('voltHttp.secExport', "Export");
		const formats: [ReportFormat, string][] = [
			['html', 'HTML'],
			['markdown', 'Markdown'],
			['sarif', 'SARIF'],
			['json', 'JSON'],
		];
		// Four equal choices: none is the page's main action (that is Scan).
		formats.forEach(([format, label]) => {
			const button = this.view.add(createVoltButton(bar, 'secondary'));
			button.label = label;
			button.enabled = !!file.lastScan;
			this.view.add(button.onDidClick(() => void this.export(format)));
		});
		append(bar, $('.volt-http-spacer'));
		createHttpIconButton(bar, Codicon.copy, localize('voltHttp.secCopyReport', "Copy Report as Markdown"), () => void this.clipboardService.writeText(httpSecurityMarkdownReport(file)));
		if (this.scan?.running) {
			append(page, $('.volt-http-note')).textContent = localize('voltHttp.secReportRunning', "A scan is running: the report shows the last finished one until it ends.");
		}
		// The report is Markdown: drawn as a document (headings, lists, tables), the way the exported file reads.
		renderHttpAiAnswer(append(page, $('.volt-http-sec-report-doc')), httpSecurityMarkdownReport(file));
	}

	// --- AI and chat -----------------------------------------------------------------------------

	private modelRef(): string | undefined {
		return httpAiModelRef(this.instantiationService);
	}

	private startTriage(): void {
		this.state.memory.aiOpen = true;
		if (this.tab !== 'findings') {
			this.setTab('findings');
		}
		if (!this.aiRun.value) {
			void this.runTriage();
		}
		this.renderAi();
	}

	private async runTriage(): Promise<void> {
		const file = this.file;
		const open = sortHttpSecurityFindings(this.findings().filter(finding => isHttpSecurityFindingOpen(finding, file?.triage ?? {})));
		this.state.memory.aiAnswer = '';
		this.state.memory.aiError = undefined;
		if (!file || !open.length) {
			this.state.memory.aiError = localize('voltHttp.secAiNothing', "There are no open findings to triage. Run a scan first.");
			this.renderAi();
			return;
		}
		const ref = this.modelRef();
		if (!ref) {
			this.state.memory.aiError = localize('voltHttp.secAiNoModel', "No model is set up. Add one in Settings, Providers & Models.");
			this.renderAi();
			return;
		}
		const cancel = new CancellationTokenSource();
		const timer = setTimeout(() => cancel.cancel(), AI_TIMEOUT_MS);
		this.aiRun.value = toDisposable(() => {
			clearTimeout(timer);
			cancel.dispose(true);
		});
		this.renderAi();
		const prompt = httpSecurityTriagePrompt(file, open.slice(0, 60));
		let answer = '';
		let failure: string | undefined;
		const show = () => {
			this.state.memory.aiAnswer = answer;
			const text = this.aiEl?.querySelector<HTMLElement>('.volt-http-sec-ai-text');
			if (text) {
				renderHttpAiAnswer(text, this.withFindingNames(answer));
			}
		};
		try {
			if (this.runtime.resolveCatalogItem(ref)?.kind === 'agent') {
				const text = await raceCancellation(this.runtime.generateText(prompt, { ref, systemPrompt: HTTP_SECURITY_TRIAGE_SYSTEM_PROMPT, timeoutMs: AI_TIMEOUT_MS - 5000 }), cancel.token);
				if (text === undefined && !cancel.token.isCancellationRequested) {
					failure = localize('voltHttp.secAiAgentFailed', "{0} did not answer. Check that it is signed in, or pick another model.", this.runtime.resolveCatalogItem(ref)?.label ?? ref);
				}
				answer = text ?? '';
				show();
			} else {
				for await (const event of this.runtime.streamModel(ref, [{ role: 'system', content: HTTP_SECURITY_TRIAGE_SYSTEM_PROMPT }, { role: 'user', content: prompt }], this.runtime.getModelOptions(ref), cancel.token, 'code')) {
					if (cancel.token.isCancellationRequested) {
						break;
					}
					if (event.type === 'text.delta' && event.delta) {
						answer += event.delta;
						show();
					} else if (event.type === 'error') {
						failure = event.message;
						break;
					}
				}
			}
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err);
		}
		const cancelled = cancel.token.isCancellationRequested;
		this.aiRun.clear();
		if (this._store.isDisposed) {
			return;
		}
		this.state.memory.aiAnswer = answer;
		this.state.memory.aiError = failure ?? (cancelled && !answer ? localize('voltHttp.secAiStopped', "Stopped.") : undefined);
		this.renderAi();
	}

	/** The model cites findings by fingerprint (`[5d7c…]`); the reader sees their titles instead. */
	private withFindingNames(answer: string): string {
		const titles = new Map(this.findings().map(finding => [finding.fingerprint, finding.title]));
		return answer.replace(/\[([0-9a-f]{8,})\]/g, (match, id: string) => {
			const title = titles.get(id);
			return title ? `*${title.replace(/[*_`\[\]]/g, '')}*` : match;
		});
	}

	private renderAi(): void {
		const parent = this.aiEl;
		if (!parent) {
			return;
		}
		if (this.state.memory.aiOpen !== true) {
			clearNode(parent);
			parent.classList.add('hidden');
			return;
		}
		parent.classList.remove('hidden');
		// Drawn once per state; the answer itself streams into its text node.
		const running = !!this.aiRun.value;
		const key = `${running}|${this.state.memory.aiError ?? ''}|${!!this.state.memory.aiAnswer}`;
		if (parent.dataset.key === key && parent.childElementCount) {
			const text = parent.querySelector<HTMLElement>('.volt-http-sec-ai-text');
			if (text) {
				renderHttpAiAnswer(text, this.withFindingNames(typeof this.state.memory.aiAnswer === 'string' ? this.state.memory.aiAnswer : ''));
			}
			return;
		}
		const store = this.aiStore;
		store.clear();
		clearNode(parent);
		const head = append(parent, $('.volt-http-sec-ai-head'));
		append(head, $('span.volt-http-sec-ai-title')).textContent = localize('voltHttp.secAiTitle', "AI triage");
		append(head, $('span.volt-http-note')).textContent = localize('voltHttp.secAiNote', "Advice only: it never changes a finding's status.");
		append(head, $('.volt-http-spacer'));
		this.modelButton(head, store);
		const run = store.add(createVoltButton(head, running ? 'secondary' : 'primary'));
		run.label = running ? localize('voltHttp.secAiStop', "Stop") : localize('voltHttp.secAiRun', "Triage Again");
		store.add(run.onDidClick(() => running ? this.aiRun.clear() : void this.runTriage().then(() => this.renderAi())));
		createHttpIconButton(head, Codicon.close, localize('voltHttp.secAiClose', "Close"), () => {
			this.aiRun.clear();
			this.state.memory.aiOpen = false;
			this.renderAi();
		});
		const error = this.state.memory.aiError;
		if (typeof error === 'string' && error) {
			append(parent, $('.volt-http-sec-note.error')).textContent = error;
		}
		const text = append(parent, $('.volt-http-sec-ai-text'));
		const answer = typeof this.state.memory.aiAnswer === 'string' ? this.state.memory.aiAnswer : '';
		// allow-any-unicode-next-line
		renderHttpAiAnswer(text, this.withFindingNames(answer), running ? localize('voltHttp.secAiWorking', "Reading the findings…") : '');
		if (answer) {
			createHttpIconButton(head, Codicon.copy, localize('voltHttp.secAiCopy', "Copy Triage"), () => void this.clipboardService.writeText(typeof this.state.memory.aiAnswer === 'string' ? this.state.memory.aiAnswer : ''));
		}
		parent.dataset.key = key;
	}

	/** The button that shows and picks the triage model. */
	private modelButton(parent: HTMLElement, store: DisposableStore): void {
		createHttpAiModelButton(parent, this.instantiationService, store, localize('voltHttp.secAiModel', "The model that triages the findings"), AnchorAlignment.RIGHT);
	}

	private investigateScan(): void {
		const file = this.file;
		if (!file) {
			return;
		}
		const findings = this.findings();
		const open = sortHttpSecurityFindings(findings.filter(finding => isHttpSecurityFindingOpen(finding, file.triage)));
		const summary = summarizeHttpSecurity(findings, file.triage);
		const text = [
			`Security scan "${file.name}" (${this.filePath()}) of the user's own API.`,
			findings.length ? `Score ${summary.score}/100 (${summary.grade}); open findings: ${httpSecurityCountsText(findings, file.triage)}.` : 'No findings yet (no scan has run, or it found nothing).',
			'',
			...open.slice(0, TOP_FOR_CHAT).flatMap(finding => [httpSecurityFindingText(finding), '']),
			...(open.length > TOP_FOR_CHAT ? [`${open.length - TOP_FOR_CHAT} more open findings: read them with security_report.`, ''] : []),
			chatInstructions(this.filePath()),
		].join('\n');
		this.host.addToChat(localize('voltHttp.secChatScan', "Security scan: {0}", file.name), text);
	}

	private investigateFinding(finding: IHttpSecurityFinding): void {
		const triage = this.file?.triage[finding.fingerprint];
		this.host.addToChat(localize('voltHttp.secChatFinding', "Finding: {0}", finding.title), [
			`A finding of the security scan "${this.file?.name ?? ''}" (${this.filePath()}) of the user's own API.`,
			'',
			httpSecurityFindingText(finding, triage),
			'',
			chatInstructions(this.filePath()),
		].join('\n'));
	}
}
