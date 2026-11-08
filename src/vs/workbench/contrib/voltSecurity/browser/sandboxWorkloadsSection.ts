/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltSecurity.css';
import { $, append, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { SandboxBackendId } from '../../../../platform/voltSandbox/common/sandboxBackend.js';
import { ISandboxPolicySummary, ISandboxResourceSample, ISandboxWorkloadInfo, SandboxWorkloadState } from '../../../../platform/voltSandbox/common/sandboxWorkloads.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';

/** What the Security page lends this section (Volt Settings' page kit). */
export interface ISandboxWorkloadsKit {
	readonly store: DisposableStore;
	sectionLabel(label: string): void;
	sectionHint(text: string): void;
	/** A bordered block under the current section label. */
	settingsGroup(): HTMLElement;
	/** Whether the page is still the one shown (a late result must not land on another page). */
	isCurrent(): boolean;
}

const ROW_HEIGHT = 66;
/** Resource numbers move; the list reads them again this often while the page is shown. */
const REFRESH_MS = 2_000;

const BACKEND_LABELS: Record<SandboxBackendId, string> = {
	seatbelt: localize('voltSecurity.backend.seatbelt', "macOS Seatbelt"),
	bubblewrap: localize('voltSecurity.backend.bubblewrap', "Linux bubblewrap"),
	mxc: localize('voltSecurity.backend.mxc', "Windows AppContainer"),
	unsupported: localize('voltSecurity.backend.unsupported', "No sandbox"),
};

const STATE_LABELS: Record<SandboxWorkloadState, string> = {
	launching: localize('voltSecurity.state.launching', "Starting"),
	attesting: localize('voltSecurity.state.attesting', "Checking its sandbox"),
	running: localize('voltSecurity.state.running', "Running"),
	idle: localize('voltSecurity.state.idle', "Idle"),
	backoff: localize('voltSecurity.state.backoff', "Restarting after a crash"),
	broken: localize('voltSecurity.state.broken', "Stopped after repeated crashes"),
	stopping: localize('voltSecurity.state.stopping', "Stopping"),
	stopped: localize('voltSecurity.state.stopped', "Stopped"),
	failed: localize('voltSecurity.state.failed', "Refused"),
};

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) {
		return localize('voltSecurity.kb', "{0} KB", Math.max(1, Math.round(bytes / 1024)));
	}
	if (bytes < 1024 * 1024 * 1024) {
		return localize('voltSecurity.mb', "{0} MB", Math.round(bytes / (1024 * 1024)));
	}
	return localize('voltSecurity.gb', "{0} GB", (bytes / (1024 * 1024 * 1024)).toFixed(1));
}

function formatCpu(ms: number): string {
	return ms < 60_000
		? localize('voltSecurity.cpuSeconds', "{0} s CPU", (ms / 1000).toFixed(1))
		: localize('voltSecurity.cpuMinutes', "{0} min CPU", (ms / 60_000).toFixed(1));
}

function networkText(policy: ISandboxPolicySummary): string {
	switch (policy.network) {
		case 'none': return localize('voltSecurity.net.none', "No network");
		case 'proxy': return localize('voltSecurity.net.proxy', "Network through Volt's proxy ({0} hosts allowed)", policy.allowedHosts);
		case 'host': return localize('voltSecurity.net.host', "Full network");
	}
}

function resourcesText(sample: ISandboxResourceSample | undefined): string | undefined {
	return sample ? localize('voltSecurity.resources', "{0}, {1}, {2} processes", formatBytes(sample.memoryBytes), formatCpu(sample.cpuMs), sample.processes) : undefined;
}

/** "Sandboxed" or what is not enforced; a host's restarts and last error. */
function statusText(row: ISandboxWorkloadInfo): string {
	const parts = [
		BACKEND_LABELS[row.backend] ?? row.backend,
		row.status === 'sandboxed'
			? localize('voltSecurity.sandboxed', "fully sandboxed")
			: localize('voltSecurity.partial', "not enforced: {0}", row.unenforced.join(', ')),
		row.attestation ? localize('voltSecurity.attested', "attested") : localize('voltSecurity.notAttested', "not attested yet"),
	];
	if (row.restarts) {
		parts.push(localize('voltSecurity.restarts', "{0} restarts", row.restarts));
	}
	return parts.join(', ');
}

/** Its name, and the chat it works for (an MCP server's): "MCP github, chat Fix login" or "..., chat 1a2b3c4d". */
export function titleText(row: ISandboxWorkloadInfo): string {
	const chat = row.onBehalfOf;
	if (!chat) {
		return row.label;
	}
	const id = chat.subject.startsWith('chat:') ? chat.subject.slice('chat:'.length) : chat.subject;
	return localize('voltSecurity.titleForChat', "{0}, chat {1}", row.label, chat.label ?? id.slice(0, 8));
}

/** The hover: everything the attestation record and the policy say (F.12). */
function detailText(row: ISandboxWorkloadInfo): string {
	const lines = [
		localize('voltSecurity.detail.principal', "Principal: {0}", row.subject ? `${row.subject} (${row.principalId})` : row.principalId),
		...(row.onBehalfOf ? [localize('voltSecurity.detail.onBehalfOf', "Works for: {0}", row.onBehalfOf.label ? `${row.onBehalfOf.label} (${row.onBehalfOf.subject})` : row.onBehalfOf.subject)] : []),
		localize('voltSecurity.detail.started', "Started: {0}", new Date(row.startedAt).toLocaleString()),
	];
	const attestation = row.attestation;
	if (attestation) {
		lines.push(
			localize('voltSecurity.detail.backend', "Backend: {0} {1} on {2}", BACKEND_LABELS[attestation.backend] ?? attestation.backend, attestation.backendVersion, attestation.osBuild),
			localize('voltSecurity.detail.policy', "Launch policy: {0}", attestation.launchPolicyHash),
			localize('voltSecurity.detail.evidence', "Evidence: {0}", Object.entries(attestation.evidence).map(([key, value]) => `${key}=${value}`).join(', ') || '-'),
			localize('voltSecurity.detail.canary', "Canary: {0}", Object.entries(attestation.canary).map(([key, value]) => `${key}=${value}`).join(', ') || '-'),
			localize('voltSecurity.detail.attestedAt', "Attested: {0}", new Date(attestation.attestedAt).toLocaleString()),
		);
	}
	const policy = row.policy;
	lines.push(
		localize('voltSecurity.detail.profile', "Policy: {0}", policy.name),
		localize('voltSecurity.detail.network', "Network: {0}", networkText(policy)),
		policy.readsEverything
			? localize('voltSecurity.detail.readAll', "Reads: everything except denied paths")
			: localize('voltSecurity.detail.read', "Reads: {0}", policy.read.join(', ') || '-'),
		localize('voltSecurity.detail.write', "Writes: {0}", policy.write.join(', ') || '-'),
		localize('voltSecurity.detail.denied', "Denied paths and patterns: {0}", policy.denied),
	);
	const limits = Object.entries(policy.limits).map(([key, value]) => `${key}=${value}`);
	if (limits.length) {
		lines.push(localize('voltSecurity.detail.limits', "Limits: {0}", limits.join(', ')));
	}
	if (row.detail) {
		lines.push(localize('voltSecurity.detail.last', "Last: {0}", row.detail));
	}
	return lines.join('\n');
}

class WorkloadDelegate implements IListVirtualDelegate<ISandboxWorkloadInfo> {
	getHeight(): number {
		return ROW_HEIGHT;
	}
	getTemplateId(): string {
		return WorkloadRenderer.ID;
	}
}

interface IWorkloadTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly title: HTMLElement;
	readonly state: HTMLElement;
	readonly status: HTMLElement;
	readonly policy: HTMLElement;
	readonly stop: ReturnType<typeof createVoltButton>;
	readonly store: DisposableStore;
	workload?: ISandboxWorkloadInfo;
}

class WorkloadRenderer implements IListRenderer<ISandboxWorkloadInfo, IWorkloadTemplate> {
	static readonly ID = 'voltSandboxWorkload';
	readonly templateId = WorkloadRenderer.ID;

	constructor(private readonly onStop: (workload: ISandboxWorkloadInfo) => void) { }

	renderTemplate(container: HTMLElement): IWorkloadTemplate {
		const store = new DisposableStore();
		const row = append(container, $('.volt-security-workload'));
		const icon = append(row, $('.volt-security-workload-icon'));
		const copy = append(row, $('.volt-security-workload-copy'));
		const head = append(copy, $('.volt-security-workload-head'));
		const title = append(head, $('span.volt-security-workload-title'));
		const state = append(head, $('span.volt-security-workload-state'));
		const status = append(copy, $('.volt-security-workload-meta'));
		const policy = append(copy, $('.volt-security-workload-meta'));
		const stop = store.add(createVoltButton(append(row, $('.volt-security-workload-actions')), 'secondary'));
		const template: IWorkloadTemplate = { row, icon, title, state, status, policy, stop, store };
		store.add(stop.onDidClick(() => {
			if (template.workload) {
				stop.enabled = false;
				this.onStop(template.workload);
			}
		}));
		return template;
	}

	renderElement(workload: ISandboxWorkloadInfo, _index: number, template: IWorkloadTemplate): void {
		template.workload = workload;
		const broken = workload.state === 'broken' || workload.state === 'failed';
		template.icon.replaceChildren(renderIcon(broken ? Codicon.warning : workload.status === 'partial' ? Codicon.shield : workload.lifetime === 'host' ? Codicon.server : Codicon.terminal));
		template.row.classList.toggle('broken', broken);
		template.row.classList.toggle('partial', workload.status === 'partial');
		template.title.textContent = titleText(workload);
		template.state.textContent = STATE_LABELS[workload.state] ?? workload.state;
		template.status.textContent = statusText(workload);
		const resources = resourcesText(workload.resources);
		template.policy.textContent = [networkText(workload.policy), localize('voltSecurity.writes', "writes {0} folders", workload.policy.write.length), resources].filter(Boolean).join(', ');
		setAgentTooltip(template.row, detailText(workload));
		template.stop.label = broken ? localize('voltSecurity.dismiss', "Dismiss") : localize('voltSecurity.stop', "Stop");
		template.stop.element.title = broken
			? localize('voltSecurity.dismissTitle', "Remove it from this list")
			: localize('voltSecurity.stopTitle', "Stop it and every process it started");
		template.stop.enabled = workload.state !== 'stopping';
	}

	disposeTemplate(template: IWorkloadTemplate): void {
		template.store.dispose();
	}
}

/**
 * The Security page's "Sandboxed processes" (spec F.12, M.3 C5): every sandboxed process the
 * execution host runs (agents, commands, terminals, long-lived hosts) with its principal, backend,
 * attestation evidence, policy and resource use, and a Stop button that ends its whole tree.
 */
export class SandboxWorkloadsSection {

	constructor(
		private readonly kit: ISandboxWorkloadsKit,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	render(): void {
		const { kit, stdio } = this;
		kit.sectionLabel(localize('voltSecurity.workloads', "Sandboxed processes"));
		kit.sectionHint(isMacintosh
			? localize('voltSecurity.workloadsHintMac', "What runs in a sandbox right now and the evidence Volt checked before letting it start. On macOS a sandboxed process can still read the environment of your other processes, so Volt keeps secrets out of environments.")
			: localize('voltSecurity.workloadsHint', "What runs in a sandbox right now and the evidence Volt checked before letting it start."));
		const group = kit.settingsGroup();
		const load = stdio.sandboxWorkloads?.bind(stdio);
		if (!load) {
			append(group, $('.volt-security-empty')).textContent = localize('voltSecurity.unavailable', "Sandboxed processes are not reported here.");
			return;
		}
		const empty = append(group, $('.volt-security-empty'));
		empty.textContent = localize('voltSecurity.none', "Nothing runs in a sandbox right now.");
		const listHost = append(group, $('.volt-security-workloads'));
		listHost.hidden = true;
		let refreshing: Promise<void> | undefined;
		let again = false;
		const refresh = (): Promise<void> => {
			if (refreshing) {
				again = true;
				return refreshing;
			}
			refreshing = (async () => {
				try {
					const rows = await load().catch(() => [] as readonly ISandboxWorkloadInfo[]);
					if (!kit.isCurrent() || listDisposed) {
						return;
					}
					empty.hidden = rows.length > 0;
					listHost.hidden = rows.length === 0;
					listHost.style.height = `${rows.length * ROW_HEIGHT}px`;
					list.layout(rows.length * ROW_HEIGHT);
					list.splice(0, list.length, rows);
				} finally {
					refreshing = undefined;
					if (again) {
						again = false;
						void refresh();
					}
				}
			})();
			return refreshing;
		};
		const stop = (workload: ISandboxWorkloadInfo) => {
			void (stdio.stopSandboxWorkload?.(workload.id) ?? Promise.resolve(false)).catch(() => false).then(() => refresh());
		};
		const list = kit.store.add(this.instantiationService.createInstance(WorkbenchList<ISandboxWorkloadInfo>, 'VoltSandboxWorkloads', listHost, new WorkloadDelegate(), [new WorkloadRenderer(stop)], {
			identityProvider: { getId: (workload: ISandboxWorkloadInfo) => workload.id },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltSecurity.workloadsAria', "Sandboxed processes"),
				getAriaLabel: (workload: ISandboxWorkloadInfo) => localize('voltSecurity.workloadAria', "{0}, {1}, {2}", titleText(workload), STATE_LABELS[workload.state] ?? workload.state, statusText(workload)),
			},
		}));
		let listDisposed = false;
		kit.store.add(toDisposable(() => { listDisposed = true; }));
		if (stdio.onDidChangeSandboxWorkloads) {
			kit.store.add(stdio.onDidChangeSandboxWorkloads(() => void refresh()));
		}
		const window = getWindow(listHost);
		const timer = window.setInterval(() => {
			if (kit.isCurrent()) {
				void refresh();
			}
		}, REFRESH_MS);
		kit.store.add(toDisposable(() => window.clearInterval(timer)));
		void refresh();
	}
}
