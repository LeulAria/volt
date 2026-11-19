/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltHttpWire.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { HTTP_SETTINGS_DEFAULTS, HTTP_TLS_PROTOCOLS, HttpRequestSettingKey, HttpVersionSetting, IHttpRequestSettings, isHttpSettingDefault } from '../common/httpCollection.js';
import { createHttpCheck, createHttpDropdown } from './voltHttpWidgets.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';

type SwitchKey = 'strictSSL' | 'followRedirects' | 'followOriginalHttpMethod' | 'followAuthorizationHeader' | 'removeRefererHeaderOnRedirect' | 'strictHttpParser' | 'encodeUrl' | 'disableCookies' | 'tlsPreferServerCiphers';

interface ISettingRow {
	readonly key: HttpRequestSettingKey;
	readonly title: string;
	readonly description: string;
}

/** The rows in Postman's order, with its wording. */
function settingRows(): ISettingRow[] {
	return [
		{ key: 'httpVersion', title: localize('voltHttp.setHttpVersion', "HTTP version"), description: localize('voltHttp.setHttpVersionDesc', "Select the HTTP version to use for sending the request.") },
		{ key: 'strictSSL', title: localize('voltHttp.setStrictSsl', "Enable SSL certificate verification"), description: localize('voltHttp.setStrictSslDesc', "Verify SSL certificates when sending a request. Verification failures will result in the request being aborted.") },
		{ key: 'followRedirects', title: localize('voltHttp.setFollowRedirects', "Automatically follow redirects"), description: localize('voltHttp.setFollowRedirectsDesc', "Follow HTTP 3xx responses as redirects.") },
		{ key: 'followOriginalHttpMethod', title: localize('voltHttp.setOriginalMethod', "Follow original HTTP Method"), description: localize('voltHttp.setOriginalMethodDesc', "Redirect with the original HTTP method instead of the default behavior of redirecting with GET.") },
		{ key: 'followAuthorizationHeader', title: localize('voltHttp.setFollowAuth', "Follow Authorization header"), description: localize('voltHttp.setFollowAuthDesc', "Retain authorization header when a redirect happens to a different hostname.") },
		{ key: 'removeRefererHeaderOnRedirect', title: localize('voltHttp.setRemoveReferer', "Remove referer header on redirect"), description: localize('voltHttp.setRemoveRefererDesc', "Remove the referer header when a redirect happens.") },
		{ key: 'strictHttpParser', title: localize('voltHttp.setStrictParser', "Enable strict HTTP parser"), description: localize('voltHttp.setStrictParserDesc', "Restrict responses with invalid HTTP headers.") },
		{ key: 'encodeUrl', title: localize('voltHttp.setEncodeUrl', "Encode URL automatically"), description: localize('voltHttp.setEncodeUrlDesc', "Encode the URL's path, query parameters, and authentication fields.") },
		{ key: 'disableCookies', title: localize('voltHttp.setDisableCookies', "Disable cookie jar"), description: localize('voltHttp.setDisableCookiesDesc', "Existing cookies in the cookie jar will not be added as headers for this request.") },
		{ key: 'tlsPreferServerCiphers', title: localize('voltHttp.setServerCiphers', "Use server cipher suite during handshake"), description: localize('voltHttp.setServerCiphersDesc', "Use the server's cipher suite order instead of the client's during handshake.") },
		{ key: 'maxRedirects', title: localize('voltHttp.setMaxRedirects', "Maximum number of redirects"), description: localize('voltHttp.setMaxRedirectsDesc', "Set a cap on the maximum number of redirects to follow.") },
		{ key: 'tlsDisabledProtocols', title: localize('voltHttp.setTlsProtocols', "TLS/SSL protocols disabled during handshake"), description: localize('voltHttp.setTlsProtocolsDesc', "Specify the SSL and TLS protocol versions to be disabled during handshake. All other protocols will be enabled.") },
		{ key: 'tlsCipherSuites', title: localize('voltHttp.setCiphers', "Cipher suite selection"), description: localize('voltHttp.setCiphersDesc', "Order of cipher suites that the SSL server profile uses to establish a secure connection.") },
		{ key: 'timeoutMs', title: localize('voltHttp.setTimeout', "Request timeout"), description: localize('voltHttp.setTimeoutDesc', "How long to wait for the response, in milliseconds. Empty waits the default 60 seconds.") },
	];
}

const SWITCH_KEYS: ReadonlySet<string> = new Set<SwitchKey>(['strictSSL', 'followRedirects', 'followOriginalHttpMethod', 'followAuthorizationHeader', 'removeRefererHeaderOnRedirect', 'strictHttpParser', 'encodeUrl', 'disableCookies', 'tlsPreferServerCiphers']);

export interface IHttpRequestSettingsViewOptions {
	readonly settings: IHttpRequestSettings | undefined;
	readonly contextViewService: IContextViewService;
	readonly store: DisposableStore;
	/** `mutate` changes the request's settings in place: a setting back at its default is deleted from them. */
	readonly onChange: (mutate: (settings: IHttpRequestSettings) => void) => void;
}

/**
 * The body of a plain HTTP request's Settings tab, as Postman's: a row per setting with its title,
 * what it does, and its control at the right (a switch, a dropdown, a field). A row whose value is
 * not the default offers "Restore default". Rows are changed in place, never redrawn, so a field
 * keeps its caret while it is typed in.
 */
export function renderHttpRequestSettings(parent: HTMLElement, options: IHttpRequestSettingsViewOptions): void {
	const local: IHttpRequestSettings = { ...options.settings };
	const store = options.store;
	const list = append(parent, $('.volt-http-set'));
	list.setAttribute('role', 'group');
	list.setAttribute('aria-label', localize('voltHttp.setAria', "Request settings"));
	/** Shows each row's value again (after a restore). */
	const shows: (() => void)[] = [];

	const apply = <K extends HttpRequestSettingKey>(key: K, value: IHttpRequestSettings[K] | undefined) => {
		const write = (target: IHttpRequestSettings) => {
			if (value === undefined || isHttpSettingDefault({ [key]: value }, key)) {
				delete target[key];
			} else {
				target[key] = value;
			}
		};
		write(local);
		options.onChange(write);
	};

	for (const row of settingRows()) {
		const key = row.key;
		const line = append(list, $('.volt-http-set-row'));
		const text = append(line, $('.volt-http-set-text'));
		const head = append(text, $('.volt-http-set-head'));
		append(head, $('span.volt-http-set-title')).textContent = row.title;
		const restore = append(head, $('button.volt-http-link.volt-http-set-restore')) as HTMLButtonElement;
		restore.type = 'button';
		restore.textContent = localize('voltHttp.setRestore', "Restore default");
		restore.setAttribute('aria-label', localize('voltHttp.setRestoreAria', "Restore the default of {0}", row.title));
		append(text, $('.volt-http-set-description')).textContent = row.description;
		const control = append(line, $('.volt-http-set-control'));
		let show: () => void;

		if (SWITCH_KEYS.has(key)) {
			const flag = key as SwitchKey;
			const state = append(control, $('span.volt-http-switch-state'));
			state.setAttribute('aria-hidden', 'true');
			const toggle = append(control, $('button.volt-http-switch')) as HTMLButtonElement;
			toggle.type = 'button';
			toggle.setAttribute('role', 'switch');
			toggle.setAttribute('aria-label', row.title);
			setAgentTooltip(toggle, row.description);
			append(toggle, $('span.volt-http-switch-knob'));
			const valueOf = () => local[flag] ?? HTTP_SETTINGS_DEFAULTS[flag];
			show = () => {
				const on = valueOf();
				toggle.setAttribute('aria-checked', String(on));
				toggle.classList.toggle('on', on);
				state.textContent = on ? localize('voltHttp.setOn', "ON") : localize('voltHttp.setOff', "OFF");
			};
			store.add(addDisposableListener(toggle, EventType.CLICK, () => {
				apply(flag, !valueOf());
				refresh();
			}));
		} else if (key === 'httpVersion') {
			const dropdown = createHttpDropdown<HttpVersionSetting>(control, options.contextViewService, {
				options: [
					{ id: 'auto', label: localize('voltHttp.setVersionAuto', "Auto"), description: localize('voltHttp.setVersionAutoDesc', "HTTP/2 when the server offers it, else HTTP/1.x.") },
					{ id: 'http1', label: localize('voltHttp.setVersion1', "HTTP/1.x") },
					{ id: 'http2', label: localize('voltHttp.setVersion2', "HTTP/2") },
				],
				value: local.httpVersion ?? 'auto',
				ariaLabel: row.title,
				align: 'right',
				onChange: value => {
					apply('httpVersion', value);
					refresh();
				},
			}, store);
			show = () => dropdown.set(local.httpVersion ?? 'auto');
		} else if (key === 'tlsDisabledProtocols') {
			control.classList.add('checks');
			const checks = HTTP_TLS_PROTOCOLS.map(protocol => {
				const label = protocol.replace('_', '.');
				const item = append(control, $('.volt-http-set-check'));
				const check = createHttpCheck(item, false, localize('voltHttp.setTlsDisable', "Disable {0}", label), checked => {
					const next = HTTP_TLS_PROTOCOLS.filter(other => other === protocol ? checked : local.tlsDisabledProtocols?.includes(other));
					apply('tlsDisabledProtocols', next);
					refresh();
				});
				const name = append(item, $('span'));
				name.textContent = label;
				store.add(addDisposableListener(name, EventType.CLICK, () => check.element.click()));
				return { protocol, check };
			});
			show = () => {
				for (const { protocol, check } of checks) {
					check.checked = !!local.tlsDisabledProtocols?.includes(protocol);
				}
			};
		} else {
			const input = append(control, $('input.volt-http-set-input')) as HTMLInputElement;
			input.type = 'text';
			input.spellcheck = false;
			input.autocomplete = 'off';
			input.setAttribute('aria-label', row.title);
			if (key === 'tlsCipherSuites') {
				input.classList.add('wide');
				input.placeholder = localize('voltHttp.setCiphersPlaceholder', "Enter cipher suites");
				show = () => input.value = (local.tlsCipherSuites ?? []).join(':');
				store.add(addDisposableListener(input, EventType.INPUT, () => {
					apply('tlsCipherSuites', input.value.split(/[\s,:]+/).filter(Boolean));
					refresh(input);
				}));
			} else {
				const numeric: 'maxRedirects' | 'timeoutMs' = key === 'timeoutMs' ? 'timeoutMs' : 'maxRedirects';
				input.inputMode = 'numeric';
				input.placeholder = numeric === 'timeoutMs' ? '60000' : String(HTTP_SETTINGS_DEFAULTS.maxRedirects);
				show = () => input.value = local[numeric] !== undefined ? String(local[numeric]) : '';
				store.add(addDisposableListener(input, EventType.INPUT, () => {
					const digits = input.value.replace(/\D+/g, '').slice(0, 7);
					if (digits !== input.value) {
						input.value = digits;
					}
					apply(numeric, digits ? Number(digits) : undefined);
					refresh(input);
				}));
				// What was typed and what is kept can differ (the default typed out, a leading zero): shown on leaving.
				store.add(addDisposableListener(input, EventType.BLUR, () => show()));
			}
		}

		store.add(addDisposableListener(restore, EventType.CLICK, () => {
			apply(key, undefined);
			refresh();
		}));
		shows.push(() => {
			const changed = !isHttpSettingDefault(local, key);
			line.classList.toggle('changed', changed);
			restore.classList.toggle('shown', changed);
		});
		shows.push(show);
		// The field being typed in keeps its text as typed.
		const index = shows.length - 1;
		line.dataset.show = String(index);
	}

	/** Every row's value and "Restore default" again; `typing` is left as the user has it. */
	function refresh(typing?: HTMLInputElement): void {
		const skip = typing ? Number(typing.closest<HTMLElement>('.volt-http-set-row')?.dataset.show) : -1;
		shows.forEach((show, index) => {
			if (index !== skip) {
				show();
			}
		});
	}
	refresh();
}
