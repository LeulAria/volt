/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/sandboxDenialCard.css';
import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { chatSubject, IUserGestureToken } from '../../../../../platform/voltSandbox/common/principals.js';
import { ISandboxDenial } from '../../../../../platform/voltSandbox/common/sandboxDenials.js';
import { bindGestureButton } from '../../../../services/voltTrust/browser/gestureTokens.js';
import { IVoltTrustService } from '../../../../services/voltTrust/common/voltTrust.js';
import { createVoltButton, VoltButtonKind } from '../chrome/voltButton.js';

/** The word the user types to take a chat out of its sandbox (critical: never one click, G.8). */
export const RUN_OUTSIDE_CONFIRMATION = 'off';

export interface ISandboxDenialCardOptions {
	readonly denial: ISandboxDenial;
	readonly chatId: string;
	readonly trust: IVoltTrustService;
	/** The chat's running agent process (what the broker's denial belongs to); undefined: its run ended. */
	readonly processId: () => string | undefined;
	/** Dismisses the card. */
	readonly dismiss: () => void;
	/** Retries the step the sandbox blocked. */
	readonly retry: () => void;
	/** Write denials: "Allow Folder" (checked, then written into the chat's sandbox settings). */
	readonly allowFolder?: () => void;
	/** A network denial without a broker record (the legacy proxy): the host joins the chat's allowed hosts. */
	readonly allowHostSetting?: () => void;
	/** Takes the chat out of its sandbox, after the typed confirmation. */
	readonly runOutside: () => void;
	/** Settings, Access: the budget resets there (G.12). */
	readonly openAccess: () => void;
}

/**
 * The denial card's body (spec P4, I.4 "Approval", G.3, G.12): what was denied and why, and the
 * fixes Volt offers. Volt writes every sentence. A network denial gets Allow buttons only when the
 * broker recorded it (B-34: an agent can't print a fake denial and get buttons) and its prompt
 * budget allows (`promptable`); Allow and Allow for This Chat name the broker's denial and epoch,
 * and the broker rebuilds the rule from its record. Every widening button is gesture-armed
 * (inert for 500 ms, pointer movement, a trusted event). Taking the chat out of its sandbox
 * (`spawn.unsandboxed`, critical) is never one click: the user types `off` first.
 */
export function renderSandboxDenialCard(tray: HTMLElement, options: ISandboxDenialCardOptions, store: DisposableStore): void {
	const { denial, trust } = options;
	const principal = chatSubject(options.chatId);
	const why = append(tray, $('.volt-agent-run-tray-detail.volt-sandbox-denial-why'));
	const row = append(tray, $('.volt-agent-run-tray-actions.volt-sandbox-denial-actions'));
	const note = append(tray, $('.volt-agent-run-tray-detail.volt-sandbox-denial-note'));
	note.hidden = true;
	const say = (text: string) => {
		note.hidden = false;
		note.setAttribute('role', 'alert');
		note.textContent = text;
	};
	const button = (label: string, kind: VoltButtonKind, title: string): Button => {
		const made = store.add(createVoltButton(row, kind));
		made.label = label;
		made.element.title = title;
		return made;
	};
	const armed = (made: Button, run: () => void) => store.add(bindGestureButton(made, trust.gestures, principal, () => run(), { area: tray }));
	const recorded = denial.kind === 'network' && !!denial.denialId && denial.epoch !== undefined;
	const offered = denial.promptable !== false;
	why.textContent = whyText(denial, recorded && offered);

	const skip = button(localize('voltSandboxCard.skip', "Skip"), 'ghost', localize('voltSandboxCard.skipTitle', "Leave it blocked"));
	store.add(skip.onDidClick(() => {
		const id = options.processId();
		if (recorded && id) {
			// Two Skips and the broker offers nothing more until the Access page is opened (G.12).
			void trust.refuseDenial(id, denial.denialId!);
		}
		options.dismiss();
	}));

	if (denial.kind === 'network' && !offered) {
		const open = button(localize('voltSandboxCard.openAccess', "Review Access"), 'secondary', localize('voltSandboxCard.openAccessTitle', "Open Settings, Access, where this chat's permissions are"));
		store.add(open.onDidClick(() => options.openAccess()));
	} else if (denial.kind === 'network' && recorded) {
		const forChat = button(localize('voltSandboxCard.allowForChat', "Allow for This Chat"), 'secondary', localize('voltSandboxCard.allowForChatTitle', "Let this chat reach {0} from now on, until you revoke it in Settings, Access", denial.target));
		const once = button(localize('voltSandboxCard.allow', "Allow"), 'primary', localize('voltSandboxCard.allowTitle', "Let this run of the agent reach {0}", denial.target));
		const allowed = (scope: 'run' | 'chat') => {
			// Done: the buttons go, and the card says what now holds.
			row.hidden = true;
			note.hidden = false;
			note.removeAttribute('role');
			note.textContent = scope === 'chat'
				? localize('voltSandboxCard.allowedChat', "Allowed for this chat: {0}", denial.target)
				: localize('voltSandboxCard.allowedRun', "Allowed for this run: {0}", denial.target);
			options.retry();
		};
		const answer = (scope: 'run' | 'chat', token: IUserGestureToken) => void answerNetworkDenial(options, scope, token).then(result => {
			if (!tray.isConnected) {
				return;
			}
			if (result.kind === 'allowed') {
				allowed(scope);
			} else if (result.kind === 'ended') {
				// "Allow" is for the run that was blocked; once it is over only the chat-wide answer helps.
				once.enabled = false;
				say(localize('voltSandboxCard.ended', "The run that was blocked has ended. Allow for This Chat lets this chat's next runs reach {0}.", denial.target));
			} else {
				say(localize('voltSandboxCard.notAllowed', "Not allowed: {0}", result.reason));
			}
		});
		store.add(bindGestureButton(forChat, trust.gestures, principal, token => answer('chat', token), { area: tray }));
		store.add(bindGestureButton(once, trust.gestures, principal, token => answer('run', token), { area: tray }));
	} else if (denial.kind === 'network' && options.allowHostSetting) {
		const allow = button(localize('voltSandboxCard.allowForChat', "Allow for This Chat"), 'primary', localize('voltSandboxCard.allowHostTitle', "Add {0} to this chat's allowed hosts", denial.target));
		armed(allow, options.allowHostSetting);
	} else if (denial.kind === 'write' && options.allowFolder) {
		const allow = button(localize('voltSandboxCard.allowFolder', "Allow Folder"), 'primary', localize('voltSandboxCard.allowFolderTitle', "Let this chat write in that folder"));
		armed(allow, options.allowFolder);
	}

	// Critical (spawn.unsandboxed): typed confirmation, never one click (G.8).
	const outside = button(localize('voltSandboxCard.outside', "Run Outside Sandbox"), 'ghost', localize('voltSandboxCard.outsideTitle', "Turn the sandbox off for this chat and retry the step"));
	store.add(outside.onDidClick(() => {
		outside.enabled = false;
		renderConfirmation(tray, options, store);
	}));
}

export type NetworkDenialAnswer = { readonly kind: 'allowed' } | { readonly kind: 'ended' } | { readonly kind: 'refused'; readonly reason: string };

/**
 * A gesture-armed answer to a recorded network denial. `chat`: the broker's record of the chat's
 * denial decides, with or without a live run (the refused agent process has usually ended by the
 * time the card is read). `run`: only for the run that was blocked, while it is still running.
 */
export async function answerNetworkDenial(options: Pick<ISandboxDenialCardOptions, 'denial' | 'chatId' | 'trust' | 'processId'>, scope: 'run' | 'chat', token: IUserGestureToken): Promise<NetworkDenialAnswer> {
	const { denial, trust } = options;
	if (!denial.denialId || denial.epoch === undefined) {
		return { kind: 'refused', reason: 'Volt has no record of this denial' };
	}
	let result;
	if (scope === 'chat') {
		result = await trust.approveChatDenial(options.chatId, denial.denialId, denial.epoch, token);
	} else {
		const id = options.processId();
		if (!id) {
			return { kind: 'ended' };
		}
		result = await trust.approveDenial(options.chatId, id, denial.denialId, denial.epoch, 'run', token);
	}
	return result.ok ? { kind: 'allowed' } : { kind: 'refused', reason: result.reason };
}

function whyText(denial: ISandboxDenial, offered: boolean): string {
	switch (denial.kind) {
		case 'network':
			if (denial.promptable === false) {
				return localize('voltSandboxCard.whyBudget', "This chat's network only reaches the hosts it was allowed. Volt stopped offering more for now: it was refused twice or asked too often. Review it in Settings, Access.");
			}
			return offered
				? localize('voltSandboxCard.whyNetwork', "This chat's network only reaches the hosts it was allowed. Allow lets this run of the agent reach {0}; Allow for This Chat keeps it for the chat until you revoke it.", denial.target)
				: localize('voltSandboxCard.whyNetworkPlain', "This chat's network only reaches the hosts it was allowed.");
		case 'write': return localize('voltSandboxCard.whyWrite', "This chat's sandbox writes only in its project and the folders it was allowed.");
		case 'read': return localize('voltSandboxCard.whyRead', "This chat's sandbox reads its project, the system's tools and its own state, and never your credentials.");
		default: return localize('voltSandboxCard.whyLaunch', "This chat's sandbox does not let its agent start that program.");
	}
}

/** "Type off to confirm": the only way from a card to a chat without its sandbox. */
function renderConfirmation(tray: HTMLElement, options: ISandboxDenialCardOptions, store: DisposableStore): void {
	const box = append(tray, $('.volt-sandbox-denial-confirm'));
	append(box, $('.volt-agent-run-tray-detail')).textContent = localize('voltSandboxCard.confirmText', "Without its sandbox this chat's agent can read and change any of your files, use your credentials and reach any host. Type \"{0}\" to turn the sandbox off for this chat.", RUN_OUTSIDE_CONFIRMATION);
	const line = append(box, $('.volt-sandbox-denial-confirm-line'));
	const input = append(line, $<HTMLInputElement>('input.volt-sandbox-denial-confirm-input'));
	input.type = 'text';
	input.spellcheck = false;
	input.setAttribute('aria-label', localize('voltSandboxCard.confirmAria', "Type {0} to confirm", RUN_OUTSIDE_CONFIRMATION));
	const confirm = store.add(createVoltButton(line, 'danger'));
	confirm.label = localize('voltSandboxCard.turnOff', "Turn Off Sandbox");
	confirm.enabled = false;
	const typed = () => input.value.trim().toLowerCase() === RUN_OUTSIDE_CONFIRMATION;
	store.add(addDisposableListener(input, 'input', () => { confirm.enabled = typed(); }));
	store.add(confirm.onDidClick(e => {
		// The typed word and a real click or key press, both (G.7).
		if (typed() && e?.isTrusted) {
			options.runOutside();
		}
	}));
	input.focus();
}
