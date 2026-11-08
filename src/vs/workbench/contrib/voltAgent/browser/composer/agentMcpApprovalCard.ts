/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentMcpApproval.css';
import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { diffMcpServerSpec, IVoltMcpServerSpec, IVoltMcpSpecChange } from '../../../../services/voltRuntime/common/harness/mcpApprovals.js';
import { VoltMode } from '../../../../services/voltRuntime/common/modes.js';
import { IAgentRuntimeService, IVoltMcpApprovalRequest } from '../../../../services/voltRuntime/common/runtime.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';

export interface IAgentMcpApprovalCardDelegate {
	/** The user decided: the composer warms up again, so an approved server starts now. */
	onDidDecide(): void;
	/** The card's height changed: the composer lays out again. */
	onDidChangeHeight(): void;
}

/**
 * "Allow the project's MCP server?": a repository's own MCP server (`.mcp.json` and friends) waits
 * here until the user approves exactly what it runs: the command, its arguments, the binary the
 * command resolves to, the working folder and the names of its environment variables (values may
 * be secrets and stay out). A changed server shows what changed since the last decision. Approving
 * in a folder that isn't trusted asks to trust it first (B-02). In the composer stack like the
 * worktree setup card.
 */
export class AgentMcpApprovalCard extends Disposable {

	readonly element: HTMLElement;
	private requests: readonly IVoltMcpApprovalRequest[] = [];
	private context: { readonly sessionId: string; readonly providerRef: string | undefined; readonly mode: VoltMode } | undefined;
	private generation = 0;
	private busy = false;
	private readonly renderStore = this._register(new DisposableStore());

	constructor(
		private readonly delegate: IAgentMcpApprovalCardDelegate,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IWorkspaceTrustManagementService private readonly workspaceTrust: IWorkspaceTrustManagementService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.element = $('.volt-mcp-approval.hidden');
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('voltMcpApproval.aria', "MCP server approval"));
	}

	/** Reads the chat's waiting servers again (the chat, its model or mode changed, or the composer got focus). */
	refresh(sessionId: string | undefined, providerRef: string | undefined, mode: VoltMode): void {
		this.context = sessionId ? { sessionId, providerRef, mode } : undefined;
		const generation = ++this.generation;
		if (!this.context) {
			this.show([]);
			return;
		}
		void this.runtime.listMcpApprovalRequests(this.context.sessionId, providerRef, mode).then(requests => {
			if (generation === this.generation) {
				this.show(requests);
			}
		}, () => undefined);
	}

	private show(requests: readonly IVoltMcpApprovalRequest[]): void {
		this.requests = requests;
		this.render();
	}

	private render(): void {
		this.renderStore.clear();
		clearNode(this.element);
		const wasHidden = this.element.classList.contains('hidden');
		const request = this.requests[0];
		this.element.classList.toggle('hidden', !request);
		if (!request) {
			if (!wasHidden) {
				this.delegate.onDidChangeHeight();
			}
			return;
		}
		const head = append(this.element, $('.volt-mcp-approval-head'));
		append(head, $('span.volt-mcp-approval-mark')).appendChild(renderIcon(Codicon.server));
		const title = append(head, $('span.volt-mcp-approval-title'));
		title.textContent = request.approval === 'changed'
			? localize('voltMcpApproval.changedTitle', "Project MCP server \"{0}\" changed", request.name)
			: localize('voltMcpApproval.title', "Allow project MCP server \"{0}\"?", request.name);
		const detail = append(head, $('span.volt-mcp-approval-detail'));
		detail.textContent = this.requests.length > 1
			? localize('voltMcpApproval.fromMore', "{0} · 1 of {1}", request.file, this.requests.length)
			: request.file;
		setAgentTooltip(detail, URI.joinPath(request.root, request.file).fsPath);

		append(this.element, $('.volt-mcp-approval-lead')).textContent = request.approval === 'untrusted'
			? localize('voltMcpApproval.untrustedLead', "You approved this server, but its folder is no longer trusted. It runs as you, with your files and network.")
			: localize('voltMcpApproval.lead', "This repository asks Volt to start this program for the models Volt runs. It runs as you, with your files and network. Allow it only if you trust what it runs.");

		if (request.previous) {
			this.renderChanges(diffMcpServerSpec(request.previous, request.spec));
		}
		this.renderSpec(request.spec);

		const actions = append(this.element, $('.volt-mcp-approval-actions'));
		const allow = this.renderStore.add(createVoltButton(actions, 'primary'));
		allow.label = localize('voltMcpApproval.allow', "Approve");
		allow.enabled = !this.busy;
		this.renderStore.add(allow.onDidClick(() => void this.decide(request, true)));
		const deny = this.renderStore.add(createVoltButton(actions, 'secondary'));
		deny.label = localize('voltMcpApproval.deny', "Don't Allow");
		deny.enabled = !this.busy;
		this.renderStore.add(deny.onDidClick(() => void this.decide(request, false)));
		this.delegate.onDidChangeHeight();
	}

	private renderChanges(changes: readonly IVoltMcpSpecChange[]): void {
		const box = append(this.element, $('.volt-mcp-approval-changes'));
		append(box, $('.volt-mcp-approval-section')).textContent = localize('voltMcpApproval.changedSince', "Changed since your last decision");
		if (!changes.length) {
			append(box, $('.volt-mcp-approval-change')).textContent = localize('voltMcpApproval.hiddenChange', "The value of an environment variable or header changed.");
			return;
		}
		for (const change of changes) {
			const row = append(box, $('.volt-mcp-approval-change'));
			append(row, $('span.volt-mcp-approval-label')).textContent = fieldLabel(change.field);
			append(row, $('code.volt-mcp-approval-before')).textContent = change.before || localize('voltMcpApproval.none', "(none)");
			append(row, $('span.volt-mcp-approval-arrow')).appendChild(renderIcon(Codicon.arrowRight));
			append(row, $('code.volt-mcp-approval-after')).textContent = change.after || localize('voltMcpApproval.none', "(none)");
		}
	}

	private renderSpec(spec: IVoltMcpServerSpec): void {
		const table = append(this.element, $('.volt-mcp-approval-spec'));
		const row = (label: string, value: string) => {
			append(table, $('span.volt-mcp-approval-label')).textContent = label;
			append(table, $('code.volt-mcp-approval-value')).textContent = value;
		};
		if (spec.kind === 'http') {
			row(fieldLabel('url'), spec.url);
			row(fieldLabel('headers'), spec.headerNames.join(', ') || localize('voltMcpApproval.none', "(none)"));
			return;
		}
		row(fieldLabel('command'), spec.command);
		row(fieldLabel('args'), spec.args.length ? spec.args.map(quoteArg).join(' ') : localize('voltMcpApproval.none', "(none)"));
		row(fieldLabel('binary'), spec.binary ?? localize('voltMcpApproval.notFound', "(not found on PATH)"));
		row(fieldLabel('cwd'), spec.cwd);
		row(fieldLabel('env'), spec.envNames.join(', ') || localize('voltMcpApproval.none', "(none)"));
	}

	private async decide(request: IVoltMcpApprovalRequest, allow: boolean): Promise<void> {
		if (this.busy) {
			return;
		}
		this.busy = true;
		this.render();
		try {
			if (allow && !(await this.ensureTrusted(request.root))) {
				return;
			}
			await this.runtime.decideMcpServer(request.root, request.name, request.digest, allow);
			if (allow) {
				this.delegate.onDidDecide();
			}
		} catch (err) {
			this.notificationService.warn(err instanceof Error ? err.message : String(err));
		} finally {
			this.busy = false;
			if (this.context) {
				this.refresh(this.context.sessionId, this.context.providerRef, this.context.mode);
			} else {
				this.render();
			}
		}
	}

	/** Project servers run only in trusted folders: approving in one that isn't asks to trust it. */
	private async ensureTrusted(root: URI): Promise<boolean> {
		if ((await this.workspaceTrust.getUriTrustInfo(root)).trusted) {
			return true;
		}
		const { confirmed } = await this.dialogService.confirm({
			message: localize('voltMcpApproval.trustMessage', "Trust the folder \"{0}\"?", basename(root)),
			detail: localize('voltMcpApproval.trustDetail', "Volt starts a project's MCP servers only in folders you trust. Trusting {0} also lets its tasks, hooks and other configuration run.", root.fsPath),
			primaryButton: localize({ key: 'voltMcpApproval.trust', comment: ['&& denotes a mnemonic'] }, "&&Trust Folder and Approve"),
		});
		if (!confirmed) {
			return false;
		}
		await this.workspaceTrust.setUrisTrust([root], true);
		return (await this.workspaceTrust.getUriTrustInfo(root)).trusted;
	}
}

function fieldLabel(field: IVoltMcpSpecChange['field']): string {
	switch (field) {
		case 'kind': return localize('voltMcpApproval.field.kind', "Type");
		case 'command': return localize('voltMcpApproval.field.command', "Command");
		case 'args': return localize('voltMcpApproval.field.args', "Arguments");
		case 'cwd': return localize('voltMcpApproval.field.cwd', "Working folder");
		case 'binary': return localize('voltMcpApproval.field.binary', "Runs");
		case 'env': return localize('voltMcpApproval.field.env', "Environment");
		case 'url': return localize('voltMcpApproval.field.url', "URL");
		case 'headers': return localize('voltMcpApproval.field.headers', "Headers");
	}
}

/** An argument as a shell would need it, so the line shows where each one starts and ends. */
function quoteArg(arg: string): string {
	return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * A folder that stops being trusted loses its project MCP approvals. The agent server can't see
 * Workspace Trust, so there an approval stands for it; this keeps the two in step.
 */
class McpApprovalTrustContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltMcpApprovalTrust';

	constructor(
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IWorkspaceTrustManagementService private readonly workspaceTrust: IWorkspaceTrustManagementService,
	) {
		super();
		this._register(this.workspaceTrust.onDidChangeTrustedFolders(() => void this.sweep()));
		this._register(this.workspaceTrust.onDidChangeTrust(() => void this.sweep()));
		void this.workspaceTrust.workspaceTrustInitialized.then(() => this.sweep());
	}

	private async sweep(): Promise<void> {
		try {
			const approvals = (await this.runtime.listMcpApprovals()).filter(record => record.decision === 'allow');
			const folders = new Map<string, URI>();
			for (const record of approvals) {
				folders.set(record.root, record.folder ? URI.parse(record.folder) : URI.file(record.root));
			}
			for (const [root, folder] of folders) {
				if (!(await this.workspaceTrust.getUriTrustInfo(folder)).trusted) {
					await this.runtime.revokeMcpApproval(root);
				}
			}
		} catch {
			// The agent server is not up yet: the next trust change sweeps again.
		}
	}
}

registerWorkbenchContribution2(McpApprovalTrustContribution.ID, McpApprovalTrustContribution, WorkbenchPhase.Eventually);
