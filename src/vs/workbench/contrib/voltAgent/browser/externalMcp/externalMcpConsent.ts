/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/externalMcp.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { describeRedirect } from '../../../../../platform/voltExternalMcp/common/externalMcpOAuth.js';
import { ExternalMcpScope, IExternalMcpConsentDecision, IExternalMcpConsentRequest } from '../../../../../platform/voltExternalMcp/common/voltExternalMcp.js';
import { showVoltModal } from '../../../voltProjects/browser/ui/voltModal.js';
import { scopeCopy } from './externalMcpScopes.js';

/**
 * "Connect Claude Code to Volt?": what an outside agent asks for, where the approval goes, and
 * one checkbox per requested scope (untick to grant less). The name is the agent's own claim,
 * so it is marked unverified and the redirect is shown in full. Closing the dialog denies.
 */
export function showExternalMcpConsent(layoutService: ILayoutService, request: IExternalMcpConsentRequest, answer: (decision: IExternalMcpConsentDecision) => void): IDisposable {
	let answered = false;
	const decide = (decision: IExternalMcpConsentDecision) => {
		if (!answered) {
			answered = true;
			answer(decision);
		}
	};
	return showVoltModal(layoutService, {
		title: localize('externalMcp.consent.title', "Connect an outside agent"),
		width: 520,
		height: 560,
		headless: true,
		className: 'volt-external-mcp-consent',
		onDidClose: () => decide({ approve: false }),
		render: (body, close) => {
			const store = new DisposableStore();
			const content = append(body, $('.volt-external-mcp-consent-content'));

			const head = append(content, $('.head'));
			append(head, $('.mark')).appendChild(renderIcon(Codicon.plug));
			const titles = append(head, $('.titles'));
			append(titles, $('h2')).textContent = localize('externalMcp.consent.ask', "Allow {0} to use Volt?", request.clientName);
			const meta = append(titles, $('.meta'));
			append(meta, $('span.unverified')).textContent = localize('externalMcp.consent.unverified', "Name not verified");
			append(meta, $('span')).textContent = request.newClient
				? localize('externalMcp.consent.new', "Registered just now")
				: localize('externalMcp.consent.known', "Connected before");

			append(content, $('p.lead')).textContent = localize('externalMcp.consent.lead', "An agent running outside Volt wants to work with your chats over MCP. Allow it only if you just started this connection from that agent.");

			append(content, $('.section')).textContent = localize('externalMcp.consent.access', "It asks to");
			const list = append(content, $('.scopes'));
			const chosen = new Set<ExternalMcpScope>(request.scopes);
			const buttons: { allow?: Button } = {};
			for (const scope of request.scopes) {
				const copy = scopeCopy(scope);
				const row = append(list, $('label.scope'));
				const box = append(row, $('input')) as HTMLInputElement;
				box.type = 'checkbox';
				box.checked = true;
				box.dataset.scope = scope;
				const text = append(row, $('.text'));
				append(text, $('.title')).textContent = copy.title;
				append(text, $('.detail')).textContent = copy.detail;
				store.add(addDisposableListener(box, 'change', () => {
					if (box.checked) {
						chosen.add(scope);
					} else {
						chosen.delete(scope);
					}
					if (buttons.allow) {
						buttons.allow.enabled = chosen.size > 0;
					}
				}));
			}

			const where = describeRedirect(request.redirectUri);
			append(content, $('.section')).textContent = localize('externalMcp.consent.returns', "Approval goes to");
			const redirect = append(content, $('.redirect'));
			append(redirect, $('code')).textContent = request.redirectUri;
			append(redirect, $('.hint')).textContent = where.local
				? localize('externalMcp.consent.local', "{0}.", capitalize(where.label))
				: localize('externalMcp.consent.remote', "A server at {0}: whoever runs it gets this access.", where.label);

			append(content, $('p.fine')).textContent = localize('externalMcp.consent.fine', "Its chats and messages show as coming from it. Revoke it any time in Settings > Connected agents.");

			const footer = append(body, $('.volt-add-footer'));
			const timer = append(footer, $('span.volt-add-footer-hint'));
			const tick = () => {
				const left = Math.max(0, Math.round((request.expiresAt - Date.now()) / 1000));
				timer.textContent = localize('externalMcp.consent.expires', "Expires in {0}:{1}", Math.floor(left / 60), String(left % 60).padStart(2, '0'));
				if (left === 0) {
					close();
				}
			};
			tick();
			const window = getWindow(body);
			const interval = window.setInterval(tick, 1000);
			store.add(toDisposable(() => window.clearInterval(interval)));
			const deny = store.add(new Button(footer, { ...defaultButtonStyles, secondary: true }));
			deny.label = localize('externalMcp.consent.deny', "Deny");
			deny.element.classList.add('deny');
			store.add(deny.onDidClick(() => {
				decide({ approve: false });
				close();
			}));
			const allow = buttons.allow = store.add(new Button(footer, defaultButtonStyles));
			allow.label = localize('externalMcp.consent.allow', "Allow");
			allow.element.classList.add('allow');
			store.add(allow.onDidClick(() => {
				decide({ approve: true, scopes: request.scopes.filter(scope => chosen.has(scope)) });
				close();
			}));
			// Deny has focus: Enter on a dialog that popped up unasked must not grant access.
			deny.focus();
			return store;
		},
	});
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
