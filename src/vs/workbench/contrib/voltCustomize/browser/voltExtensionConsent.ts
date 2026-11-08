/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../voltProjects/browser/media/addProject.css';
import './media/voltExtensionConsent.css';
import { $, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { VoltCapabilityClass } from '../../../services/voltPlugins/common/capabilities.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { showVoltModal } from '../../voltProjects/browser/ui/voltModal.js';

/** What Volt says a capability lets an extension do: Volt's words, never the extension's. */
export interface IVoltCapabilityCopy {
	readonly title: string;
	readonly detail: string;
}

/** Volt-authored text for the medium and high capabilities the extension API can grant. */
export function voltCapabilityCopy(capability: string): IVoltCapabilityCopy {
	const bare = capability.replace(/@\d+$/, '');
	switch (bare) {
		case 'agents.read:any': return { title: localize('cap.agentsReadAny', "Read your chats"), detail: localize('cap.agentsReadAny.detail', "List every chat and read what you and the agents wrote in them, including Volt's memory notes and automations.") };
		case 'agents.send': return { title: localize('cap.agentsSend', "Act in your chats"), detail: localize('cap.agentsSend.detail', "Send messages to chats' agents, run Volt's tools in a chat and draw on your Scratch board. Agents treat these messages as coming from the extension, not from you.") };
		case 'agents.create': return { title: localize('cap.agentsCreate', "Start chats"), detail: localize('cap.agentsCreate.detail', "Start new chats with an agent of your choice. The agents use your accounts and your usage limits.") };
		case 'agents.context': return { title: localize('cap.agentsContext', "Change what agents remember"), detail: localize('cap.agentsContext.detail', "Save, change and delete Volt's memory notes, which every later chat reads.") };
		case 'agents.read:other': return { title: localize('cap.agentsReadOther', "Read other chats' terminals"), detail: localize('cap.agentsReadOther.detail', "Read what other chats ran and printed.") };
		case 'agents.hooks': return { title: localize('cap.agentsHooks', "Hook into agent turns"), detail: localize('cap.agentsHooks.detail', "Run code before and after agents' turns.") };
		case 'browser.read': return { title: localize('cap.browserRead', "Read pages in Volt's browser"), detail: localize('cap.browserRead.detail', "Read the address and the text of the page open in a chat's browser tab, which may be signed in to your accounts.") };
		case 'browser.drive': return { title: localize('cap.browserDrive', "Use Volt's browser"), detail: localize('cap.browserDrive.detail', "Open pages and act in Volt's browser, which keeps your sign-ins.") };
		case 'automations.schedule': return { title: localize('cap.automations', "Schedule agent runs"), detail: localize('cap.automations.detail', "Create automations that start agents on a schedule, while you are away.") };
		case 'hosting.read': return { title: localize('cap.hostingRead', "Read your pull requests"), detail: localize('cap.hostingRead.detail', "Read the pull requests linked to your chats, through your GitHub sign-in.") };
		case 'hosting.write': return { title: localize('cap.hostingWrite', "Change your pull requests"), detail: localize('cap.hostingWrite.detail', "Comment on, review and change pull requests as you.") };
		case 'git.read': return { title: localize('cap.gitRead', "Read your repositories' history"), detail: localize('cap.gitRead.detail', "Read commits, branches and changes in your projects.") };
		case 'git.write': return { title: localize('cap.gitWrite', "Change your repositories"), detail: localize('cap.gitWrite.detail', "Commit, check out and change branches in your projects.") };
		case 'git.push': return { title: localize('cap.gitPush', "Push to your remotes"), detail: localize('cap.gitPush.detail', "Push branches to your remotes as you.") };
		case 'files.write': return { title: localize('cap.filesWrite', "Change files through Volt"), detail: localize('cap.filesWrite.detail', "Change files in your projects through Volt's tools.") };
		case 'terminals.read': return { title: localize('cap.terminalsRead', "Read terminals"), detail: localize('cap.terminalsRead.detail', "Read what Volt's terminals printed.") };
		case 'terminals.run': return { title: localize('cap.terminalsRun', "Run commands"), detail: localize('cap.terminalsRun.detail', "Run commands in a chat's terminal, inside that chat's sandbox.") };
		case 'clipboard.read': return { title: localize('cap.clipboard', "Read your clipboard"), detail: localize('cap.clipboard.detail', "Read what you copied.") };
		case 'devices.drive': return { title: localize('cap.devices', "Use simulators and emulators"), detail: localize('cap.devices.detail', "Boot, tap and type on iOS simulators and Android emulators.") };
		case 'net.local.connect': return { title: localize('cap.netLocal', "Reach your local network"), detail: localize('cap.netLocal.detail', "Connect to devices and services on your local network.") };
	}
	const colon = bare.indexOf(':');
	const base = colon > 0 ? bare.slice(0, colon) : bare;
	const target = colon > 0 ? bare.slice(colon + 1) : '';
	switch (base) {
		case 'secrets.use': return { title: localize('cap.secretsUse', "Use your {0} sign-in", target), detail: localize('cap.secretsUse.detail', "Make requests signed in as you to {0}. The extension never sees the credential.", target) };
		case 'commands.execute': return { title: localize('cap.command', "Run Volt's \"{0}\" command", target), detail: localize('cap.command.detail', "Run a Volt command that is otherwise only Volt's own.") };
		case 'net.loopback.connect': return { title: localize('cap.loopback', "Connect to port {0} on this computer", target), detail: localize('cap.loopback.detail', "Talk to the service listening on that port, such as a local model server.") };
		case 'net.listen': return { title: localize('cap.listen', "Listen on port {0}", target), detail: localize('cap.listen.detail', "Serve on a port other programs can connect to.") };
	}
	return { title: bare, detail: localize('cap.unknown', "A Volt capability of the extension API.") };
}

export interface IVoltExtensionConsentRequest {
	readonly extensionName: string;
	readonly publisher: string;
	readonly capability: string;
	readonly class: VoltCapabilityClass;
	/** The extension's own reason from its manifest: shown as its claim, never as Volt's text. */
	readonly reason?: string;
}

/**
 * "Allow Acme Notes to read your chats?": one capability, in Volt's words, with the extension's
 * stated reason marked as its claim. Closing the dialog refuses; Don't Allow has focus.
 */
export function showVoltExtensionConsent(layoutService: ILayoutService, request: IVoltExtensionConsentRequest, answer: (granted: boolean) => void): IDisposable {
	let answered = false;
	const decide = (granted: boolean) => {
		if (!answered) {
			answered = true;
			answer(granted);
		}
	};
	const copy = voltCapabilityCopy(request.capability);
	return showVoltModal(layoutService, {
		title: localize('voltExtensionConsent.title', "Extension permission"),
		width: 480,
		height: 360,
		headless: true,
		className: 'volt-extension-consent',
		onDidClose: () => decide(false),
		render: (body, close) => {
			const store = new DisposableStore();
			const content = append(body, $('.volt-extension-consent-content'));
			const head = append(content, $('.head'));
			append(head, $('.mark')).appendChild(renderIcon(Codicon.extensions));
			const titles = append(head, $('.titles'));
			append(titles, $('h2')).textContent = localize('voltExtensionConsent.ask', "Allow {0} to {1}?", request.extensionName, copy.title.charAt(0).toLowerCase() + copy.title.slice(1));
			append(titles, $('.meta')).textContent = localize('voltExtensionConsent.meta', "Extension by {0}, asks for {1}", request.publisher, request.capability);
			append(content, $('p.what')).textContent = copy.detail;
			if (request.reason) {
				append(content, $('p.claim')).textContent = localize('voltExtensionConsent.claim', "The extension says: \"{0}\"", request.reason);
			}
			append(content, $('p.fine')).textContent = request.class === 'high'
				? localize('voltExtensionConsent.fineHigh', "This is a high-risk permission. Allow it only if you trust this extension. You can take it back on the extension's page in Extensions.")
				: localize('voltExtensionConsent.fine', "You can take it back on the extension's page in Extensions.");

			const footer = append(body, $('.volt-add-footer'));
			append(footer, $('span.volt-add-footer-hint'));
			const deny = store.add(createVoltButton(footer));
			deny.label = localize('voltExtensionConsent.deny', "Don't Allow");
			deny.element.classList.add('deny');
			store.add(deny.onDidClick(() => {
				decide(false);
				close();
			}));
			const allow = store.add(createVoltButton(footer, 'primary'));
			allow.label = localize('voltExtensionConsent.allow', "Allow");
			allow.element.classList.add('allow');
			store.add(allow.onDidClick(() => {
				decide(true);
				close();
			}));
			// Don't Allow has focus: Enter on a dialog that popped up unasked must not grant access.
			deny.focus();
			return store;
		},
	});
}
