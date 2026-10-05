/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVoltPrCheck, IVoltPullRequest, VoltPrCheckState, VoltPrChecksState, VoltPrErrorCode, VoltPrState } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { AgentEditor } from '../editor/agentEditor.js';
import { AgentEditorInput, OPEN_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';
import { openInAgentTools } from '../workspace/agentSurfaceHost.js';
import { AgentPullRequestEditorInput, AgentPullRequestTarget } from './agentPullRequestEditorInput.js';

export function prStateIcon(state: VoltPrState): ThemeIcon {
	switch (state) {
		case 'open': return Codicon.gitPullRequest;
		case 'draft': return Codicon.gitPullRequestDraft;
		case 'merged': return Codicon.gitMerge;
		case 'closed': return Codicon.gitPullRequestClosed;
	}
}

export function prStateLabel(state: VoltPrState): string {
	switch (state) {
		case 'open': return localize('voltPr.state.open', "Open");
		case 'draft': return localize('voltPr.state.draft', "Draft");
		case 'merged': return localize('voltPr.state.merged', "Merged");
		case 'closed': return localize('voltPr.state.closed', "Closed");
	}
}

export function checkIcon(state: VoltPrCheckState | VoltPrChecksState): ThemeIcon {
	switch (state) {
		case 'success': return Codicon.passFilled;
		case 'failure': return Codicon.error;
		case 'pending': return Codicon.circleLargeFilled;
		case 'cancelled': return Codicon.circleSlash;
		case 'skipped':
		case 'neutral': return Codicon.circleSlash;
		case 'none': return Codicon.circleLarge;
	}
}

export function checksLabel(pr: Pick<IVoltPullRequest, 'checks'>): string {
	const checks = pr.checks;
	switch (checks.state) {
		case 'none': return localize('voltPr.checks.none', "No checks");
		case 'success': return checks.total === 1 ? localize('voltPr.checks.passedOne', "1 check passed") : localize('voltPr.checks.passed', "All {0} checks passed", checks.passed + checks.skipped);
		case 'failure': return checks.failed === 1 ? localize('voltPr.checks.failedOne', "1 failing check") : localize('voltPr.checks.failed', "{0} failing checks", checks.failed);
		case 'pending': return checks.pending === 1 ? localize('voltPr.checks.pendingOne', "1 check running") : localize('voltPr.checks.pending', "{0} checks running", checks.pending);
	}
}

/** "5m ago" style. */
export function ago(at: number): string {
	return at ? fromNow(at, true) : '';
}

export function checkDuration(check: IVoltPrCheck): string | undefined {
	if (!check.startedAt || !check.completedAt || check.completedAt < check.startedAt) {
		return undefined;
	}
	const seconds = Math.round((check.completedAt - check.startedAt) / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** An icon in a span with the state's color class (`state-open`, `check-failure`, ...). */
export function iconSpan(parent: HTMLElement, icon: ThemeIcon, className: string): HTMLElement {
	const span = append(parent, $(`span.volt-pr-icon.${className}`));
	span.appendChild(renderIcon(icon));
	return span;
}

/** A 20px avatar from GitHub, with the login's first letter while it loads or when it fails. */
export function avatar(parent: HTMLElement, login: string, url: string | undefined, size = 20): HTMLElement {
	const holder = append(parent, $('span.volt-pr-avatar'));
	holder.style.width = holder.style.height = `${size}px`;
	holder.textContent = (login[0] ?? '?').toUpperCase();
	holder.title = login;
	if (url && /^https:\/\//.test(url)) {
		const img = document.createElement('img');
		img.alt = '';
		img.width = img.height = size;
		img.referrerPolicy = 'no-referrer';
		img.src = url.includes('?') ? `${url}&s=${size * 2}` : `${url}?s=${size * 2}`;
		img.onload = () => {
			holder.textContent = '';
			holder.appendChild(img);
		};
	}
	return holder;
}

/** Opens a pull request (or the new pull request form) as a tab in the chat's tools, or as an editor in the IDE layout. */
export async function openPullRequest(accessor: ServicesAccessor, target: AgentPullRequestTarget, sessionId?: string): Promise<void> {
	const instantiationService = accessor.get(IInstantiationService);
	const editorService = accessor.get(IEditorService);
	const input = instantiationService.createInstance(AgentPullRequestEditorInput, target, sessionId);
	const opened = openInAgentTools(input, sessionId);
	if (opened) {
		await opened;
		return;
	}
	await editorService.openEditor(input, { pinned: true });
}

/**
 * Puts `text` in a chat's composer (after what is already typed) and focuses it, opening the chat
 * when needed: the user reads and sends it. T3 Code hands off PR fixes the same way.
 */
export async function composeInChat(accessor: ServicesAccessor, sessionId: string, text: string): Promise<boolean> {
	const commandService = accessor.get(ICommandService);
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const findPane = (): AgentEditor | undefined => {
		for (const part of editorGroupsService.parts.length ? editorGroupsService.parts : [editorGroupsService.mainPart]) {
			for (const group of part.groups) {
				const pane = group.activeEditorPane;
				if (pane instanceof AgentEditor && pane.input instanceof AgentEditorInput && pane.input.sessionId === sessionId) {
					return pane;
				}
			}
		}
		return undefined;
	};
	let pane = findPane();
	if (!pane) {
		await commandService.executeCommand(OPEN_AGENT_COMMAND_ID, sessionId);
		pane = findPane();
	}
	if (!pane) {
		return false;
	}
	const input = pane.input as AgentEditorInput;
	const existing = (input.draft ?? '').trim();
	pane.prefillDraft(existing ? `${existing}\n\n${text}` : text, existing ? input.draftMentions : undefined);
	return true;
}

/** A chat on screen: the active editor group's first, then any visible one (the side panel in the IDE layout). */
export function visibleChatSession(accessor: ServicesAccessor): string | undefined {
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const parts = editorGroupsService.parts.length ? editorGroupsService.parts : [editorGroupsService.mainPart];
	const active = editorGroupsService.activeGroup.activeEditor;
	if (active instanceof AgentEditorInput) {
		return active.sessionId;
	}
	for (const part of parts) {
		for (const group of part.groups) {
			const pane = group.activeEditorPane;
			if (pane instanceof AgentEditor && pane.input instanceof AgentEditorInput) {
				return pane.input.sessionId;
			}
		}
	}
	return undefined;
}

/** Runs `gh auth login` for `host` in a terminal, where the CLI walks the user through it. */
export async function signInWithGh(accessor: ServicesAccessor, host: string): Promise<void> {
	const terminalService = accessor.get(ITerminalService);
	const terminal = await terminalService.createTerminal({ config: { name: localize('voltPr.signIn', "GitHub Sign In") } });
	terminalService.setActiveInstance(terminal);
	await terminalService.revealActiveTerminal();
	const safeHost = /^[a-z0-9.-]+$/i.test(host) ? host : 'github.com';
	await terminal.sendText(`gh auth login --hostname ${safeHost} --web --git-protocol https`, true);
}

/** What to tell the user, and offer, when a host cannot be read. */
export function problemText(code: VoltPrErrorCode | undefined, message: string): { title: string; detail: string; action?: 'signIn' | 'install' | 'retry' } {
	switch (code) {
		case 'noCli':
			return { title: localize('voltPr.problem.noCli', "The GitHub CLI is not installed"), detail: localize('voltPr.problem.noCliDetail', "Volt reads pull requests through gh, with the accounts you sign in to there."), action: 'install' };
		case 'noAuth':
			return { title: localize('voltPr.problem.noAuth', "Sign in to GitHub"), detail: message, action: 'signIn' };
		case 'unsupported':
			return { title: localize('voltPr.problem.unsupported', "Not supported yet"), detail: message };
		case 'rateLimited':
			return { title: localize('voltPr.problem.rate', "GitHub rate limit reached"), detail: message, action: 'retry' };
		case 'network':
			return { title: localize('voltPr.problem.network', "GitHub could not be reached"), detail: message, action: 'retry' };
		case 'notFound':
			return { title: localize('voltPr.problem.notFound', "Not found"), detail: message, action: 'retry' };
		default:
			return { title: localize('voltPr.problem.failed', "Something went wrong"), detail: message, action: 'retry' };
	}
}
