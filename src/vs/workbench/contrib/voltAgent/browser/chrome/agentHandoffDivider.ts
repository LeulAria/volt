/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { formatContextTokens } from '../context/agentContextUsage.js';
import type { IAgentContextHandoffInfo, IAgentUserMessage } from '../editor/agentEditor.js';
import { setAgentTooltip } from './agentTooltip.js';

/** Dividers the user opened, by message; a redraw of the transcript keeps them open. */
const opened = new WeakSet<object>();

/** "18.2K tokens": what a handoff cost, as the context meter counts. */
function tokens(count: number): string {
	return localize('voltAgent.handoff.tokens', "{0} tokens", formatContextTokens(count));
}

/** The divider's words: "Switched to GPT-5.5 · handed off 18.2K tokens", "Back on Claude Haiku 4.5 · caught up on 2 turns". */
export function handoffDividerText(handoff: IAgentUserMessage['handoff'], info: IAgentContextHandoffInfo | undefined): { readonly label: string; readonly detail?: string } | undefined {
	if (info?.reason === 'return') {
		return {
			label: localize('voltAgent.handoff.backOn', "Back on {0}", info.toLabel),
			detail: info.turns === 1
				? localize('voltAgent.handoff.caughtUpOne', "caught up on 1 turn, {0}", tokens(info.tokens))
				: localize('voltAgent.handoff.caughtUp', "caught up on {0} turns, {1}", info.turns, tokens(info.tokens)),
		};
	}
	if (info?.reason === 'fork') {
		return { label: localize('voltAgent.handoff.forked', "Forked conversation"), detail: localize('voltAgent.handoff.handedOff', "handed off {0}", tokens(info.tokens)) };
	}
	if (!handoff && info?.reason !== 'switch') {
		// A fresh session of the same model (the old one was let go): nothing changed for the user.
		return undefined;
	}
	const to = info?.toLabel ?? handoff!.toLabel;
	const label = handoff?.by === 'agent'
		? localize('voltAgent.handoff.handedTo', "Handed off to {0}", to)
		: localize('voltAgent.handoff.switchedTo', "Switched to {0}", to);
	return { label, ...(info ? { detail: localize('voltAgent.handoff.handedOff', "handed off {0}", tokens(info.tokens)) } : {}) };
}

/** What the hover says about a handoff: where it went and how the budget was spent. */
export function handoffTooltip(handoff: IAgentUserMessage['handoff'], info: IAgentContextHandoffInfo | undefined): string {
	const lines: string[] = [];
	const from = info?.fromLabel ?? handoff?.fromLabel;
	const to = info?.toLabel ?? handoff?.toLabel;
	if (from && to) {
		lines.push(`${from} → ${to}`);
	}
	if (handoff?.by === 'agent') {
		lines.push(handoff.reason ? localize('voltAgent.handoff.agentReason', "The agent handed the chat over: {0}", handoff.reason) : localize('voltAgent.handoff.agent', "The agent handed the chat over with a brief"));
	}
	if (!info) {
		lines.push(localize('voltAgent.handoff.user', "You switched models; the conversation so far went with it"));
		return lines.join('\n');
	}
	if (info.reused) {
		lines.push(localize('voltAgent.handoff.reused', "Its earlier session was still running, so only the turns it missed were sent."));
	}
	lines.push(localize('voltAgent.handoff.stats', "{0} of a {1} budget: {2} recent turns verbatim, {3} condensed, {4} left out.", tokens(info.tokens), formatContextTokens(info.budget), info.verbatimTurns, info.condensedTurns, info.omittedTurns));
	if (info.toolCalls || info.files) {
		lines.push(localize('voltAgent.handoff.toolStats', "{0} tool calls as one-line summaries, {1} changed files as paths.", info.toolCalls, info.files));
	}
	lines.push(localize('voltAgent.handoff.open', "Click to see what was sent."));
	return lines.join('\n');
}

/**
 * The quiet divider above a turn the chat handed to another session: "Switched to GPT-5.5 ·
 * handed off 18.2K tokens". A click opens the text that was sent, under its numbers.
 */
export function renderHandoffDivider(parent: HTMLElement, message: IAgentUserMessage, store: DisposableStore): void {
	const info = message.contextHandoff;
	const text = handoffDividerText(message.handoff, info);
	if (!text) {
		return;
	}
	const open = !!info && opened.has(message);
	const el = append(parent, $('.volt-tr-compaction.volt-tr-handoff.completed'));
	el.classList.toggle('open', open);
	const line = append(el, $('.volt-tr-compaction-line'));
	const pill = append(line, $(info ? 'button.volt-tr-compaction-pill' : 'span.volt-tr-compaction-pill'));
	const icon = append(pill, $('span.volt-tr-compaction-icon'));
	icon.appendChild(renderIcon(info?.reason === 'fork' ? Codicon.repoForked : Codicon.arrowSwap));
	append(pill, $('span.volt-tr-compaction-label')).textContent = text.label;
	if (text.detail) {
		append(pill, $('span.volt-tr-compaction-detail')).textContent = `· ${text.detail}`;
	}
	setAgentTooltip(pill, handoffTooltip(message.handoff, info));
	if (!info) {
		return;
	}
	(pill as HTMLButtonElement).type = 'button';
	pill.setAttribute('aria-expanded', String(open));
	append(pill, $('span.volt-tr-chevron')).appendChild(renderIcon(Codicon.chevronDown));
	let body: HTMLElement | undefined;
	const show = (visible: boolean) => {
		el.classList.toggle('open', visible);
		pill.setAttribute('aria-expanded', String(visible));
		if (visible && !body) {
			body = append(el, $('.volt-tr-compaction-summary.volt-tr-handoff-sent'));
			const stats = append(body, $('.volt-tr-handoff-stats'));
			stats.textContent = [
				localize('voltAgent.handoff.sentTo', "Sent to {0}", info.toLabel),
				tokens(info.tokens),
				localize('voltAgent.handoff.budget', "budget {0}", formatContextTokens(info.budget)),
				localize('voltAgent.handoff.turns', "{0} verbatim · {1} condensed · {2} left out", info.verbatimTurns, info.condensedTurns, info.omittedTurns),
			].join(' · ');
			append(body, $('pre.volt-tr-handoff-text')).textContent = info.text;
		}
		if (body) {
			body.style.display = visible ? '' : 'none';
		}
	};
	show(open);
	store.add(addDisposableListener(pill, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		const next = !opened.has(message);
		if (next) {
			opened.add(message);
		} else {
			opened.delete(message);
		}
		show(next);
	}));
}
