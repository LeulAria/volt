/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltHttpAuth.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer } from '../../../../base/browser/ui/list/list.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IVoltHttpOAuth, VoltOAuthSignInResult } from '../../../../platform/voltHttp/common/voltHttpOAuth.js';
import { HTTP_JWT_ALGORITHMS, httpJwtUsesSecret } from '../common/httpAuth.js';
import { findHttpItem, HttpAuthType, httpAuthParam, httpRequestsOf, IHttpAuth, IHttpCollection, IHttpFolder, IHttpKeyValue, IHttpScripts } from '../common/httpCollection.js';
import { httpRandomHex } from '../common/httpCrypto.js';
import { HttpOAuth2Grant, httpOAuth2AuthorizeUrl, httpOAuth2CodeFrom, httpOAuth2GrantOf, httpOAuth2TokenRequest, httpPkceChallenge, httpPkceVerifier, parseHttpOAuth2Token } from '../common/httpOAuth2.js';
import { IHttpCollectionEntry, IHttpEnvironmentEntry, IHttpRunResult, IHttpRunSummary, IVoltHttpCollections } from './voltHttpCollections.js';
import { IHttpExchange, IVoltHttpService } from './voltHttpService.js';
import { createHttpCheck, createHttpDropdown, createHttpVariableField, formatHttpDuration, HttpKeyValueTable, httpStatusClass, HttpVariableLookup, IHttpVariableField, renderHttpTabs } from './voltHttpWidgets.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';

export type HttpCollectionPageTab = 'overview' | 'variables' | 'auth' | 'scripts' | 'runs';

/** What a collection or folder tab keeps while another tab is in front. */
export interface IHttpCollectionTabState {
	collection: URI;
	/** The folder the tab shows; the collection itself when absent. */
	folderId?: string;
	tab: HttpCollectionPageTab;
	scriptTab: 'preRequest' | 'test';
	running?: CancellationTokenSource;
	results: IHttpRunResult[];
	summary?: IHttpRunSummary;
	runError?: string;
	iterations: number;
	delayMs: number;
	stopOnFailure: boolean;
}

export interface IHttpPageHost {
	readonly root: URI | undefined;
	readonly variables: HttpVariableLookup;
	tabChanged(): void;
	openRequest(collection: URI, id: string, exchange?: IHttpExchange): void;
	exportCollection(collection: URI): void;
	revealFile(uri: URI): void;
}

export interface IHttpAuthEditorOptions {
	readonly auth: IHttpAuth;
	/** Whether "Inherit from Parent" is offered. */
	readonly inheritable: boolean;
	/** What "Inherit from Parent" resolves to, told under the picker. */
	readonly inheritedHelp?: string;
	readonly variables: HttpVariableLookup;
	readonly contextViewService: IContextViewService;
	readonly store: DisposableStore;
	/**
	 * `redraw`: what is shown depends on the change (the type, a grant, an algorithm), so the
	 * editor is drawn again from the changed auth.
	 */
	readonly onChange: (mutate: (auth: IHttpAuth) => void, redraw: boolean) => void;
	/** Sends OAuth 2.0's token request (a form-encoded POST) and returns the answer. */
	readonly requestToken?: (request: { url: string; headers: [string, string][]; body: string }) => Promise<{ status: number; body: string } | { error: string }>;
	/** Opens OAuth 2.0's sign-in page in the user's browser. */
	readonly openExternal?: (url: string) => void;
	/**
	 * Opens OAuth 2.0's sign-in page in Volt's own sign-in window and waits for it to reach the
	 * callback (`IVoltHttpOAuth`). Without it, or `unsupported`, the user signs in in the browser.
	 */
	readonly signIn?: (authorizeUrl: string, callbackUrl: string) => Promise<VoltOAuthSignInResult>;
}

/** Postman's order. `other` (a type Volt does not know) is offered only while it is the type. */
const HTTP_AUTH_TYPE_ORDER: readonly HttpAuthType[] = ['inherit', 'none', 'basic', 'bearer', 'jwt', 'digest', 'oauth1', 'oauth2', 'hawk', 'awsv4', 'ntlm', 'apikey', 'edgegrid', 'asap'];

/** An authorization type's name, as Postman writes it. */
export function httpAuthTypeLabel(type: HttpAuthType): string {
	switch (type) {
		case 'inherit': return localize('voltHttp.authLabelInherit', "Inherit auth from parent");
		case 'none': return localize('voltHttp.authNone', "No Auth");
		case 'basic': return localize('voltHttp.authBasic', "Basic Auth");
		case 'bearer': return localize('voltHttp.authBearer', "Bearer Token");
		case 'jwt': return localize('voltHttp.authLabelJwt', "JWT Bearer");
		case 'digest': return localize('voltHttp.authLabelDigest', "Digest Auth");
		case 'oauth1': return localize('voltHttp.authLabelOauth1', "OAuth 1.0");
		case 'oauth2': return localize('voltHttp.authLabelOauth2', "OAuth 2.0");
		case 'hawk': return localize('voltHttp.authLabelHawk', "Hawk Authentication");
		case 'awsv4': return localize('voltHttp.authLabelAws', "AWS Signature");
		case 'ntlm': return localize('voltHttp.authLabelNtlm', "NTLM Authentication");
		case 'apikey': return localize('voltHttp.authKey', "API Key");
		case 'edgegrid': return localize('voltHttp.authLabelEdgeGrid', "Akamai EdgeGrid");
		case 'asap': return localize('voltHttp.authLabelAsap', "ASAP (Atlassian)");
		case 'other': return localize('voltHttp.authOther', "Other (kept as in the file)");
	}
}

function httpAuthHelp(type: HttpAuthType, inherited: string | undefined): string {
	switch (type) {
		case 'inherit': return inherited ?? localize('voltHttp.authInheritPlain', "Uses the authorization of the folder or collection above.");
		case 'none': return localize('voltHttp.authNoneHelp', "No authorization is sent.");
		case 'basic': return localize('voltHttp.authBasicHelp', "The username and password are sent in the Authorization header.");
		case 'bearer': return localize('voltHttp.authBearerHelp', "The token is sent in the Authorization header as \"Bearer <token>\". Use {{variables}} to keep secrets in an environment.");
		case 'jwt': return localize('voltHttp.authJwtHelp', "A JSON Web Token is signed from the payload each time the request is sent, and added to a header or the URL. {{variables}} in the payload are filled in first.");
		case 'digest': return localize('voltHttp.authDigestHelp', "Volt sends the request, reads the realm and nonce from the server's 401 answer, and sends it again with the digest. With Realm and Nonce filled in, the digest goes with the first request.");
		case 'oauth1': return localize('voltHttp.authOauth1Help', "The request is signed with the consumer and token secrets (RFC 5849) each time it is sent.");
		case 'oauth2': return localize('voltHttp.authOauth2Help', "Sends the access token below. To get a new one: Client Credentials, Password Credentials and Refresh are one request to the token URL. For Authorization Code, Get New Access Token opens the provider's sign-in in a Volt window and exchanges the code when the provider sends that window to the Callback URL. With Authorize using browser, the sign-in opens in your browser instead: paste the address it ends on (or the code) and Exchange Code. Nothing listens on the Callback URL, so any registered address works.");
		case 'hawk': return localize('voltHttp.authHawkHelp', "The request is signed with Hawk (an id, a key, a timestamp and a nonce) each time it is sent.");
		case 'awsv4': return localize('voltHttp.authAwsHelp', "The request is signed with AWS Signature Version 4 each time it is sent.");
		case 'ntlm': return localize('voltHttp.authNtlmHelp', "The username and password answer the server's NTLM challenge, a few round trips that Volt makes when the request is sent.");
		case 'apikey': return localize('voltHttp.authKeyHelp', "The key and value are sent as a request header or a query parameter.");
		case 'edgegrid': return localize('voltHttp.authEdgeGridHelp', "The request is signed with Akamai EdgeGrid (EG1-HMAC-SHA256) each time it is sent.");
		case 'asap': return localize('voltHttp.authAsapHelp', "A short-lived token signed with your private key (Atlassian's service-to-service auth) is sent as \"Bearer <token>\".");
		case 'other': return localize('voltHttp.authOtherHelp', "Volt does not edit or send this authorization type. It stays in the file as it is, for Postman.");
	}
}

/** Which types have "Advanced configuration" open, for the rest of the session. */
const httpAuthAdvancedOpen = new Set<HttpAuthType>();

/** A sign-in page opened for an authorization code: the state its redirect must carry back, and PKCE's verifier. */
const httpAuthSignIns = new Map<string, { readonly state: string; readonly verifier?: string }>();

/** `{{name}}` filled in from the variables in scope; an unknown one stays as written. */
function resolveHttpAuthVariables(text: string, variables: HttpVariableLookup): string {
	const known = variables();
	let out = text;
	for (let pass = 0; pass < 5 && out.includes('{{'); pass++) {
		const next = out.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, name: string) => known?.get(name)?.value ?? whole);
		if (next === out) {
			break;
		}
		out = next;
	}
	return out;
}

function httpAuthLifetime(seconds: number): string {
	if (seconds < 120) {
		return localize('voltHttp.authSeconds', "{0} s", seconds);
	}
	if (seconds < 7200) {
		return localize('voltHttp.authMinutes', "{0} min", Math.round(seconds / 60));
	}
	if (seconds < 172800) {
		return localize('voltHttp.authHours', "{0} h", Math.round(seconds / 3600));
	}
	return localize('voltHttp.authDays', "{0} days", Math.round(seconds / 86400));
}

interface IHttpAuthChoice<T extends string> {
	readonly id: T;
	readonly label: string;
}

/**
 * Postman's auth page: the type, what it does and where it goes on the left; its fields on the
 * right, the common ones first and the rest under "Advanced configuration".
 */
export function renderHttpAuthEditor(parent: HTMLElement, options: IHttpAuthEditorOptions): void {
	const auth = options.auth;
	const store = options.store;
	// The fields as they are now: an edit reaches the caller's model, not this `auth`, until a redraw.
	const params: Record<string, string> = { ...auth.params };
	let token = auth.token;
	const param = (key: string) => httpAuthParam({ ...auth, params }, key);
	const flag = (key: string) => param(key).trim() === 'true';
	const setParam = (key: string, value: string, redraw = false) => {
		params[key] = value;
		options.onChange(next => next.params = { ...next.params, [key]: value }, redraw);
	};
	const resolve = (text: string) => resolveHttpAuthVariables(text, options.variables);

	const host = append(parent, $('.volt-http-auth-host'));
	const wrap = append(host, $('.volt-http-auth'));
	const side = append(wrap, $('.volt-http-auth-type'));
	append(side, $('.volt-http-section-title')).textContent = localize('voltHttp.authType', "Auth Type");
	const types = HTTP_AUTH_TYPE_ORDER.filter(type => type !== 'inherit' || options.inheritable || auth.type === 'inherit');
	if (auth.type === 'other') {
		types.push('other');
	}
	createHttpDropdown<HttpAuthType>(append(side, $('.volt-http-auth-pick')), options.contextViewService, {
		options: types.map(id => ({ id, label: httpAuthTypeLabel(id) })),
		value: auth.type,
		ariaLabel: localize('voltHttp.authMode', "Auth type"),
		width: 240,
		align: 'left',
		searchFrom: 100,
		onChange: value => options.onChange(next => {
			next.type = value;
			// A type's fields are its own: another type's (a JWT's algorithm) would mean something else.
			delete next.params;
			delete next.raw;
		}, true),
	}, store);
	append(side, $('.volt-http-auth-help')).textContent = httpAuthHelp(auth.type, options.inheritedHelp);

	const check = (into: HTMLElement, label: string, key: string, inverted = false, redraw = false) => {
		const line = append(into, $('.volt-http-auth-check'));
		const box = createHttpCheck(line, flag(key) !== inverted, label, checked => setParam(key, String(checked !== inverted), redraw));
		const text = append(line, $('span'));
		text.textContent = label;
		text.addEventListener('click', () => box.element.click());
	};
	const sideChoice = <T extends string>(label: string, choices: readonly IHttpAuthChoice<T>[], value: T, onChange: (value: T) => void) => {
		const box = append(side, $('.volt-http-auth-side-field'));
		append(box, $('.volt-http-auth-side-label')).textContent = label;
		createHttpDropdown<T>(append(box, $('.volt-http-auth-pick')), options.contextViewService, { options: choices, value, ariaLabel: label, width: 240, align: 'left', onChange }, store);
	};
	const addDataTo = localize('voltHttp.authAddDataTo', "Add authorization data to");
	const toHeaders = localize('voltHttp.authToHeaders', "Request Headers");
	const toUrl = localize('voltHttp.authToUrl', "Request URL");
	switch (auth.type) {
		case 'jwt':
			sideChoice(addDataTo, [{ id: 'header', label: localize('voltHttp.authToHeader', "Request Header") }, { id: 'queryParam', label: localize('voltHttp.authToQueryParam', "Query Param") }], param('addTokenTo') === 'queryParam' ? 'queryParam' : 'header', value => setParam('addTokenTo', value));
			break;
		case 'oauth1':
			sideChoice(addDataTo, [{ id: 'false', label: localize('voltHttp.authToBodyOrUrl', "Request Body / Request URL") }, { id: 'true', label: toHeaders }], flag('addParamsToHeader') ? 'true' : 'false', value => setParam('addParamsToHeader', value));
			break;
		case 'awsv4':
			sideChoice(addDataTo, [{ id: 'false', label: toHeaders }, { id: 'true', label: toUrl }], flag('addAuthDataToQuery') ? 'true' : 'false', value => setParam('addAuthDataToQuery', value));
			break;
		case 'digest': {
			const box = append(side, $('.volt-http-auth-side-field'));
			append(box, $('.volt-http-auth-side-label')).textContent = localize('voltHttp.authDigestRetryNote', "By default Volt reads the challenge from the server's 401 answer, adds it to the request and sends it again. Turn that off?");
			check(box, localize('voltHttp.authDigestRetry', "Yes, disable retrying the request"), 'disableRetryRequest');
			break;
		}
	}

	const fields = append(wrap, $('.volt-http-auth-fields'));
	const row = (into: HTMLElement, label: string, top = false): HTMLElement => {
		const element = append(into, $(top ? '.volt-http-field.top' : '.volt-http-field'));
		append(element, $('label')).textContent = label;
		return append(element, $('.volt-http-field-wrap'));
	};
	const help = (into: HTMLElement, text: string | undefined) => {
		if (text) {
			append(into, $('.volt-http-field-help')).textContent = text;
		}
	};
	const textField = (into: HTMLElement, label: string, value: string, onChange: (value: string) => void, extra?: { readonly password?: boolean; readonly placeholder?: string; readonly help?: string }): IHttpVariableField => {
		const wrapEl = row(into, label);
		const box = createHttpVariableField(wrapEl, { value, placeholder: extra?.placeholder ?? localize('voltHttp.varHint', "Value or {{variable}}"), ariaLabel: label, password: !!extra?.password, variables: options.variables, onChange }, store);
		box.element.classList.add('boxed');
		help(wrapEl, extra?.help);
		if (extra?.help) {
			// The help text makes the row taller: the label stays level with the input, not the middle.
			wrapEl.parentElement?.classList.add('top');
		}
		return box;
	};
	const input = (into: HTMLElement, label: string, key: string, extra?: { readonly password?: boolean; readonly placeholder?: string; readonly help?: string }) => textField(into, label, param(key), value => setParam(key, value), extra);
	const area = (into: HTMLElement, label: string, key: string, placeholder: string, rows = 5) => {
		const wrapEl = row(into, label, true);
		const box = append(wrapEl, $('textarea.volt-http-textarea.volt-http-auth-code')) as HTMLTextAreaElement;
		box.rows = rows;
		box.spellcheck = false;
		box.placeholder = placeholder;
		box.value = param(key);
		box.setAttribute('aria-label', label);
		box.addEventListener('input', () => setParam(key, box.value));
	};
	const choice = <T extends string>(into: HTMLElement, label: string, key: string, choices: readonly IHttpAuthChoice<T>[], redraw = false, shown?: T) => {
		const current = shown ?? param(key) as T;
		const known = choices.some(option => option.id === current);
		createHttpDropdown<T>(row(into, label), options.contextViewService, {
			// A value Volt has no name for (from a file) is shown as it is, not changed.
			options: known || !current ? choices : [...choices, { id: current, label: current }],
			value: known || current ? current : choices[0].id,
			ariaLabel: label,
			align: 'left',
			onChange: value => setParam(key, value, redraw),
		}, store);
	};
	const checkField = (into: HTMLElement, label: string, key: string, inverted = false) => check(row(into, ''), label, key, inverted);
	const group = (title?: string): HTMLElement => {
		const element = append(fields, $('.volt-http-auth-group'));
		if (title) {
			append(element, $('.volt-http-auth-group-title')).textContent = title;
		}
		return element;
	};
	const advanced = (): HTMLElement => {
		const type = auth.type;
		const toggle = append(fields, $('button.volt-http-auth-advanced')) as HTMLButtonElement;
		toggle.type = 'button';
		const chevron = append(toggle, $('span.volt-http-auth-chevron'));
		append(toggle, $('span')).textContent = localize('voltHttp.authAdvanced', "Advanced configuration");
		const note = append(fields, $('.volt-http-auth-advanced-note'));
		note.textContent = localize('voltHttp.authAdvancedNote', "Volt works out these values when they are left empty.");
		const body = append(fields, $('.volt-http-auth-group.advanced'));
		const show = (open: boolean) => {
			toggle.setAttribute('aria-expanded', String(open));
			clearNode(chevron);
			chevron.appendChild(renderIcon(open ? Codicon.chevronDown : Codicon.chevronRight));
			note.hidden = !open;
			body.hidden = !open;
		};
		show(httpAuthAdvancedOpen.has(type));
		toggle.addEventListener('click', () => {
			const open = !httpAuthAdvancedOpen.has(type);
			if (open) {
				httpAuthAdvancedOpen.add(type);
			} else {
				httpAuthAdvancedOpen.delete(type);
			}
			show(open);
		});
		return body;
	};

	const username = localize('voltHttp.user', "Username");
	const password = localize('voltHttp.password', "Password");
	const nonce = localize('voltHttp.authNonce', "Nonce");
	const timestamp = localize('voltHttp.authTimestamp', "Timestamp");
	const privateKey = localize('voltHttp.authPrivateKey', "Private Key");
	const pemHint = '-----BEGIN PRIVATE KEY-----';
	const made = localize('voltHttp.authMadeUp', "Made up for each request when empty");
	switch (auth.type) {
		case 'basic': {
			const main = group();
			textField(main, username, auth.username, value => options.onChange(next => next.username = value, false));
			textField(main, password, auth.password, value => options.onChange(next => next.password = value, false), { password: true });
			break;
		}
		case 'bearer':
			textField(group(), localize('voltHttp.token', "Token"), auth.token, value => options.onChange(next => next.token = value, false), { password: true });
			break;
		case 'apikey': {
			const main = group();
			textField(main, localize('voltHttp.keyName', "Key"), auth.keyName, value => options.onChange(next => next.keyName = value, false));
			textField(main, localize('voltHttp.keyValue', "Value"), auth.keyValue, value => options.onChange(next => next.keyValue = value, false), { password: true });
			createHttpDropdown<'header' | 'query'>(row(main, localize('voltHttp.addTo', "Add to")), options.contextViewService, {
				options: [{ id: 'header', label: localize('voltHttp.inHeader', "Header") }, { id: 'query', label: localize('voltHttp.inQuery', "Query Params") }],
				value: auth.keyIn,
				ariaLabel: localize('voltHttp.addTo', "Add to"),
				align: 'left',
				onChange: value => options.onChange(next => next.keyIn = value, false),
			}, store);
			break;
		}
		case 'jwt': {
			const main = group();
			choice(main, localize('voltHttp.authAlgorithm', "Algorithm"), 'algorithm', HTTP_JWT_ALGORITHMS.map(id => ({ id, label: id })), true);
			if (httpJwtUsesSecret(param('algorithm'))) {
				input(main, localize('voltHttp.authSecret', "Secret"), 'secret', { password: true });
				checkField(main, localize('voltHttp.authSecretBase64', "Secret Base64 encoded"), 'isSecretBase64Encoded');
			} else {
				area(main, privateKey, 'privateKey', pemHint);
			}
			area(main, localize('voltHttp.authPayload', "Payload"), 'payload', '{\n  "sub": "{{userId}}",\n  "iat": 1516239022\n}', 6);
			const more = advanced();
			input(more, localize('voltHttp.authHeaderPrefixJwt', "Request header prefix"), 'headerPrefix', { placeholder: 'Bearer' });
			input(more, localize('voltHttp.authQueryParamName', "Query param name"), 'queryParamKey', { placeholder: 'token' });
			area(more, localize('voltHttp.authJwtHeaders', "JWT headers"), 'header', '{\n  "kid": "key-1"\n}', 4);
			break;
		}
		case 'digest': {
			const main = group();
			input(main, username, 'username');
			input(main, password, 'password', { password: true });
			const more = advanced();
			input(more, localize('voltHttp.authRealm', "Realm"), 'realm', { placeholder: 'testrealm@example.com' });
			input(more, nonce, 'nonce');
			choice(more, localize('voltHttp.authAlgorithm', "Algorithm"), 'algorithm', ['MD5', 'MD5-sess', 'SHA-256', 'SHA-256-sess', 'SHA-512-256', 'SHA-512-256-sess'].map(id => ({ id, label: id })));
			input(more, 'qop', 'qop', { placeholder: 'auth, auth-int' });
			input(more, localize('voltHttp.authNonceCount', "Nonce Count"), 'nonceCount', { placeholder: '00000001' });
			input(more, localize('voltHttp.authClientNonce', "Client Nonce"), 'clientNonce', { placeholder: made });
			input(more, localize('voltHttp.authOpaque', "Opaque"), 'opaque');
			break;
		}
		case 'oauth1': {
			const main = group();
			const method = param('signatureMethod').trim().toUpperCase();
			choice(main, localize('voltHttp.authSignatureMethod', "Signature Method"), 'signatureMethod', ['HMAC-SHA1', 'HMAC-SHA256', 'HMAC-SHA512', 'RSA-SHA1', 'RSA-SHA256', 'RSA-SHA512', 'PLAINTEXT'].map(id => ({ id, label: id })), true);
			input(main, localize('voltHttp.authConsumerKey', "Consumer Key"), 'consumerKey');
			if (method.startsWith('RSA-')) {
				area(main, privateKey, 'privateKey', pemHint);
			} else {
				input(main, localize('voltHttp.authConsumerSecret', "Consumer Secret"), 'consumerSecret', { password: true });
			}
			input(main, localize('voltHttp.accessToken', "Access Token"), 'token', { password: true });
			if (!method.startsWith('RSA-')) {
				input(main, localize('voltHttp.authTokenSecret', "Token Secret"), 'tokenSecret', { password: true });
			}
			const more = advanced();
			input(more, localize('voltHttp.authCallbackUrl', "Callback URL"), 'callback');
			input(more, localize('voltHttp.authVerifier', "Verifier"), 'verifier');
			input(more, timestamp, 'timestamp', { placeholder: made });
			input(more, nonce, 'nonce', { placeholder: made });
			input(more, localize('voltHttp.authVersion', "Version"), 'version', { placeholder: '1.0' });
			input(more, localize('voltHttp.authRealm', "Realm"), 'realm');
			checkField(more, localize('voltHttp.authBodyHash', "Include body hash"), 'includeBodyHash');
			checkField(more, localize('voltHttp.authEmptyParams', "Add empty parameters to signature"), 'addEmptyParamsToSign');
			checkField(more, localize('voltHttp.authEncodeHeader', "Encode the parameters in the Authorization header"), 'disableHeaderEncoding', true);
			break;
		}
		case 'oauth2':
			renderOAuth2();
			break;
		case 'hawk': {
			const main = group();
			input(main, localize('voltHttp.authHawkId', "Hawk Auth ID"), 'authId');
			input(main, localize('voltHttp.authHawkKey', "Hawk Auth Key"), 'authKey', { password: true });
			choice(main, localize('voltHttp.authAlgorithm', "Algorithm"), 'algorithm', [{ id: 'sha256', label: 'SHA256' }, { id: 'sha1', label: 'SHA1' }]);
			const more = advanced();
			input(more, localize('voltHttp.authHawkUser', "User"), 'user');
			input(more, nonce, 'nonce', { placeholder: made });
			input(more, 'ext', 'extraData');
			input(more, 'app', 'app');
			input(more, 'dlg', 'delegation');
			input(more, timestamp, 'timestamp', { placeholder: made });
			checkField(more, localize('voltHttp.authPayloadHash', "Include payload hash"), 'includePayloadHash');
			break;
		}
		case 'awsv4': {
			const main = group();
			input(main, localize('voltHttp.authAccessKey', "AccessKey"), 'accessKey');
			input(main, localize('voltHttp.authSecretKey', "SecretKey"), 'secretKey', { password: true });
			const more = advanced();
			input(more, localize('voltHttp.authRegion', "AWS Region"), 'region', { placeholder: 'us-east-1' });
			input(more, localize('voltHttp.authService', "Service Name"), 'service', { placeholder: 'execute-api' });
			input(more, localize('voltHttp.authSessionToken', "Session Token"), 'sessionToken', { password: true });
			break;
		}
		case 'ntlm': {
			const main = group();
			input(main, username, 'username');
			input(main, password, 'password', { password: true });
			const more = advanced();
			input(more, localize('voltHttp.authDomain', "Domain"), 'domain');
			input(more, localize('voltHttp.authWorkstation', "Workstation"), 'workstation');
			break;
		}
		case 'edgegrid': {
			const main = group();
			input(main, localize('voltHttp.accessToken', "Access Token"), 'accessToken', { password: true });
			input(main, localize('voltHttp.authClientToken', "Client Token"), 'clientToken', { password: true });
			input(main, localize('voltHttp.authClientSecret', "Client Secret"), 'clientSecret', { password: true });
			const more = advanced();
			input(more, nonce, 'nonce', { placeholder: made });
			input(more, timestamp, 'timestamp', { placeholder: made });
			input(more, localize('voltHttp.authBaseUrl', "Base URL"), 'baseURL', { placeholder: 'https://akab-xxxx.luna.akamaiapis.net' });
			input(more, localize('voltHttp.authMaxBody', "Max Body Size"), 'maxBodySize', { placeholder: '131072' });
			input(more, localize('voltHttp.authHeadersToSign', "Headers to Sign"), 'headersToSign', { placeholder: 'X-Header-1, X-Header-2' });
			break;
		}
		case 'asap': {
			const main = group();
			choice(main, localize('voltHttp.authAlgorithm', "Algorithm"), 'alg', ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'].map(id => ({ id, label: id })));
			input(main, localize('voltHttp.authIssuer', "Issuer"), 'iss', { placeholder: 'micros/my-service' });
			input(main, localize('voltHttp.authAudience', "Audience"), 'aud');
			input(main, localize('voltHttp.authKeyId', "Key ID"), 'kid', { placeholder: 'micros/my-service/key-1' });
			area(main, privateKey, 'privateKey', pemHint);
			const more = advanced();
			input(more, localize('voltHttp.authSubject', "Subject"), 'sub', { placeholder: localize('voltHttp.authSubjectHint', "The issuer when empty") });
			area(more, localize('voltHttp.authClaims', "Additional claims"), 'claims', '{\n  "scope": "read"\n}', 4);
			input(more, localize('voltHttp.authExpiry', "Expiry"), 'exp', { placeholder: localize('voltHttp.authExpiryHint', "1h (seconds, or 30s, 10m, 1h, 1d)") });
			break;
		}
	}

	function renderOAuth2(): void {
		const current = group(localize('voltHttp.authCurrentToken', "Current Token"));
		const tokenField = textField(current, localize('voltHttp.accessToken', "Access Token"), token, value => {
			token = value;
			options.onChange(next => next.token = value, false);
		}, { password: true });
		input(current, localize('voltHttp.authHeaderPrefix', "Header Prefix"), 'headerPrefix', { placeholder: 'Bearer' });
		choice(current, addDataTo, 'addTokenTo', [{ id: 'header', label: toHeaders }, { id: 'queryParams', label: toUrl }]);

		const fresh = group(localize('voltHttp.authNewToken', "Configure New Token"));
		const grant = httpOAuth2GrantOf(param('grant_type'));
		const code = grant === 'authorization_code' || grant === 'authorization_code_with_pkce';
		const pkce = grant === 'authorization_code_with_pkce';
		input(fresh, localize('voltHttp.authTokenName', "Token Name"), 'tokenName');
		choice<HttpOAuth2Grant>(fresh, localize('voltHttp.authGrantType', "Grant Type"), 'grant_type', [
			{ id: 'authorization_code', label: localize('voltHttp.authGrantCode', "Authorization Code") },
			{ id: 'authorization_code_with_pkce', label: localize('voltHttp.authGrantPkce', "Authorization Code (With PKCE)") },
			{ id: 'client_credentials', label: localize('voltHttp.authGrantClient', "Client Credentials") },
			{ id: 'password_credentials', label: localize('voltHttp.authGrantPassword', "Password Credentials") },
			{ id: 'refresh_token', label: localize('voltHttp.authGrantRefresh', "Refresh Token") },
		], true, grant);
		// Postman's "Authorize using browser": off, the sign-in page opens in Volt's own window, which catches the callback.
		const inApp = code && !!options.signIn && !flag('useBrowser');
		if (code) {
			const callback = input(fresh, localize('voltHttp.authCallbackUrl', "Callback URL"), 'redirect_uri', {
				placeholder: 'https://localhost/callback',
				help: inApp
					? localize('voltHttp.authCallbackHelpInApp', "Any address registered with the app. Volt's sign-in window stops when the provider sends it there, so nothing needs to answer on it.")
					: localize('voltHttp.authCallbackHelp', "Any address registered with the app: Volt does not listen on it."),
			});
			const callbackWrap = callback.element.parentElement;
			if (options.signIn && callbackWrap) {
				check(callbackWrap, localize('voltHttp.authUseBrowser', "Authorize using browser"), 'useBrowser', false, true);
			}
			input(fresh, localize('voltHttp.authAuthUrl', "Auth URL"), 'authUrl', { placeholder: 'https://example.com/oauth/authorize' });
		}
		if (grant === 'refresh_token') {
			input(fresh, localize('voltHttp.authRefreshUrl', "Refresh Token URL"), 'refreshTokenUrl', { placeholder: localize('voltHttp.authRefreshUrlHint', "The Access Token URL when empty") });
		}
		input(fresh, localize('voltHttp.authAccessTokenUrl', "Access Token URL"), 'accessTokenUrl', { placeholder: 'https://example.com/oauth/token' });
		const refreshField = grant === 'refresh_token' ? input(fresh, localize('voltHttp.authRefreshToken', "Refresh Token"), 'refreshToken', { password: true }) : undefined;
		if (grant === 'password_credentials') {
			input(fresh, username, 'username');
			input(fresh, password, 'password', { password: true });
		}
		input(fresh, localize('voltHttp.authClientId', "Client ID"), 'clientId');
		input(fresh, localize('voltHttp.authClientSecret', "Client Secret"), 'clientSecret', { password: true, ...(pkce ? { placeholder: localize('voltHttp.authClientSecretOptional', "Optional for a public client") } : {}) });
		if (pkce) {
			choice(fresh, localize('voltHttp.authChallengeMethod', "Code Challenge Method"), 'challengeAlgorithm', [{ id: 'S256', label: 'SHA-256' }, { id: 'plain', label: localize('voltHttp.authPlain', "Plain") }]);
			input(fresh, localize('voltHttp.authCodeVerifier', "Code Verifier"), 'code_verifier', { placeholder: localize('voltHttp.authVerifierHint', "Made up for each sign-in when empty") });
		}
		input(fresh, localize('voltHttp.authScope', "Scope"), 'scope', { placeholder: 'read:user email' });
		if (code) {
			input(fresh, localize('voltHttp.authState', "State"), 'state', { placeholder: localize('voltHttp.authVerifierHint', "Made up for each sign-in when empty") });
		}
		choice(fresh, localize('voltHttp.authClientAuth', "Client Authentication"), 'client_authentication', [
			{ id: 'header', label: localize('voltHttp.authClientHeader', "Send as Basic Auth header") },
			{ id: 'body', label: localize('voltHttp.authClientBody', "Send client credentials in body") },
		]);
		const more = advanced();
		if (grant !== 'refresh_token') {
			input(more, localize('voltHttp.authRefreshUrl', "Refresh Token URL"), 'refreshTokenUrl', { placeholder: localize('voltHttp.authRefreshUrlHint', "The Access Token URL when empty") });
		}
		input(more, localize('voltHttp.authAudienceField', "Audience"), 'audience');
		input(more, localize('voltHttp.authResource', "Resource"), 'resource');

		let pasted = '';
		if (code && !inApp) {
			const pasteWrap = row(fresh, localize('voltHttp.authPasteLabel', "Redirected URL or Code"));
			const pasteBox = createHttpVariableField(pasteWrap, { value: '', placeholder: 'https://localhost/callback?code=...&state=...', ariaLabel: localize('voltHttp.authPasteLabel', "Redirected URL or Code"), onChange: value => pasted = value }, store);
			pasteBox.element.classList.add('boxed');
		}
		const actions = append(fresh, $('.volt-http-auth-actions'));
		const status = append(fresh, $('.volt-http-auth-status'));
		status.setAttribute('role', 'status');
		const show = (kind: 'busy' | 'ok' | 'error' | 'info', message: string) => {
			clearNode(status);
			status.dataset.kind = kind;
			if (kind === 'busy') {
				append(status, $('span.volt-http-spinner')).appendChild(renderIcon(Codicon.loading));
			} else if (kind !== 'info') {
				append(status, $('span.volt-http-auth-status-icon')).appendChild(renderIcon(kind === 'ok' ? Codicon.passFilled : Codicon.error));
			}
			append(status, $('span')).textContent = message;
		};
		const requestToken = options.requestToken;
		if (!requestToken) {
			show('info', localize('voltHttp.authNoTokenRequests', "A new token cannot be requested from here: paste one into Access Token."));
			return;
		}
		const buttons: { enabled: boolean }[] = [];
		let busy = false;
		const get = (key: string) => resolve(param(key));
		const fetchToken = async (extra?: { readonly code?: string; readonly codeVerifier?: string }): Promise<boolean> => {
			if (busy) {
				return false;
			}
			const request = httpOAuth2TokenRequest(get, grant, extra);
			if ('error' in request) {
				show('error', request.error);
				return false;
			}
			busy = true;
			buttons.forEach(button => button.enabled = false);
			show('busy', localize('voltHttp.authAsking', "Asking for a token"));
			try {
				const answer = await requestToken(request);
				if ('error' in answer) {
					show('error', answer.error);
					return false;
				}
				const got = parseHttpOAuth2Token(answer.status, answer.body);
				if ('error' in got) {
					show('error', got.error);
					return false;
				}
				token = got.accessToken;
				tokenField.value = got.accessToken;
				if (got.refreshToken) {
					params.refreshToken = got.refreshToken;
					if (refreshField) {
						refreshField.value = got.refreshToken;
					}
				}
				options.onChange(next => {
					next.token = got.accessToken;
					if (got.refreshToken) {
						next.params = { ...next.params, refreshToken: got.refreshToken };
					}
				}, false);
				const kind = got.tokenType || 'Bearer';
				show('ok', got.expiresIn !== undefined
					? localize('voltHttp.authGotExpiring', "New {0} token saved as the access token. Expires in {1}.", kind, httpAuthLifetime(got.expiresIn))
					: localize('voltHttp.authGot', "New {0} token saved as the access token.", kind));
				return true;
			} catch (err) {
				show('error', err instanceof Error ? err.message : String(err));
				return false;
			} finally {
				busy = false;
				buttons.forEach(button => button.enabled = true);
			}
		};
		if (!code) {
			const getButton = store.add(createVoltButton(actions, 'primary'));
			getButton.label = localize('voltHttp.authGetToken', "Get New Access Token");
			buttons.push(getButton);
			store.add(getButton.onDidClick(() => void fetchToken()));
			return;
		}
		const signInKey = () => `${get('authUrl').trim()}|${get('clientId').trim()}`;
		/** The sign-in page's address, with a state (and PKCE verifier) made for this sign-in. */
		const prepare = async (): Promise<{ readonly url: string; readonly state: string; readonly verifier?: string } | undefined> => {
			const state = get('state').trim() || httpRandomHex(12);
			const verifier = pkce ? get('code_verifier').trim() || httpPkceVerifier() : undefined;
			const method = param('challengeAlgorithm') === 'plain' ? 'plain' : 'S256';
			const url = httpOAuth2AuthorizeUrl(get, state, verifier ? { challenge: await httpPkceChallenge(verifier, method), method } : undefined);
			if (typeof url !== 'string') {
				show('error', url.error);
				return undefined;
			}
			return { url, state, ...(verifier ? { verifier } : {}) };
		};
		const openInBrowser = async () => {
			const prepared = await prepare();
			if (!prepared) {
				return;
			}
			if (!options.openExternal) {
				show('error', localize('voltHttp.authCannotOpen', "The sign-in page cannot be opened from here."));
				return;
			}
			httpAuthSignIns.set(signInKey(), { state: prepared.state, ...(prepared.verifier ? { verifier: prepared.verifier } : {}) });
			options.openExternal(prepared.url);
			show('info', localize('voltHttp.authSignInOpened', "The sign-in page is open in your browser. When it is done, copy the address it ends on (or only the code) into Redirected URL or Code, then Exchange Code."));
		};
		const signIn = options.signIn;
		if (inApp && signIn) {
			const getButton = store.add(createVoltButton(actions, 'primary'));
			getButton.label = localize('voltHttp.authGetToken', "Get New Access Token");
			buttons.push(getButton);
			store.add(getButton.onDidClick(async () => {
				if (busy) {
					return;
				}
				const prepared = await prepare();
				if (!prepared) {
					return;
				}
				busy = true;
				buttons.forEach(button => button.enabled = false);
				show('busy', localize('voltHttp.authSignInWindow', "Waiting for the sign-in window. Sign in there and allow access."));
				let result: VoltOAuthSignInResult;
				try {
					result = await signIn(prepared.url, get('redirect_uri').trim());
				} catch (err) {
					result = { error: err instanceof Error ? err.message : String(err) };
				} finally {
					busy = false;
					buttons.forEach(button => button.enabled = true);
				}
				if ('unsupported' in result) {
					await openInBrowser();
					return;
				}
				if ('cancelled' in result) {
					show('info', localize('voltHttp.authSignInClosed', "The sign-in window closed before the provider sent it to the Callback URL. No token was asked for."));
					return;
				}
				if ('error' in result) {
					show('error', result.error);
					return;
				}
				const back = httpOAuth2CodeFrom(result.url);
				if (back.error) {
					show('error', localize('voltHttp.authSignInFailed', "The sign-in answered: {0}", back.error));
					return;
				}
				if (back.state !== prepared.state) {
					show('error', localize('voltHttp.authStateMismatchInApp', "The provider came back with another state than the one Volt sent, so the code was not used. Try again."));
					return;
				}
				if (!back.code) {
					show('error', localize('voltHttp.authNoCode', "The provider came back to the Callback URL without a code."));
					return;
				}
				await fetchToken({ code: back.code, ...(prepared.verifier ? { codeVerifier: prepared.verifier } : {}) });
			}));
			return;
		}
		const open = store.add(createVoltButton(actions, 'secondary', { supportIcons: true }));
		open.label = `$(link-external) ${localize('voltHttp.authOpenSignIn', "Open Sign-In Page")}`;
		buttons.push(open);
		store.add(open.onDidClick(() => void openInBrowser()));
		const exchange = store.add(createVoltButton(actions, 'primary'));
		exchange.label = localize('voltHttp.authExchange', "Exchange Code");
		buttons.push(exchange);
		store.add(exchange.onDidClick(() => {
			const back = httpOAuth2CodeFrom(pasted);
			if (back.error) {
				show('error', localize('voltHttp.authSignInFailed', "The sign-in answered: {0}", back.error));
				return;
			}
			const key = signInKey();
			const pending = httpAuthSignIns.get(key);
			if (back.state !== undefined && pending && back.state !== pending.state) {
				show('error', localize('voltHttp.authStateMismatch', "That address carries another state than the sign-in Volt opened. Open the sign-in page again."));
				return;
			}
			const verifier = pkce ? pending?.verifier ?? (get('code_verifier').trim() || undefined) : undefined;
			if (pkce && back.code && !verifier) {
				show('error', localize('voltHttp.authNoVerifier', "Open the sign-in page first: the code is exchanged with the verifier made for that sign-in."));
				return;
			}
			void fetchToken({ code: back.code, ...(verifier ? { codeVerifier: verifier } : {}) }).then(done => {
				if (done) {
					httpAuthSignIns.delete(key);
				}
			});
		}));
	}
}

const RESULT_ROW_HEIGHT = 30;

/**
 * A collection's (or a folder's) own page: what it is, its variables, the authorization and
 * scripts its requests inherit, and the runner that sends them all in order with their tests.
 * Edits save to the file as they are made.
 */
export class HttpCollectionPage extends Disposable {

	readonly element: HTMLElement;
	private readonly head: HTMLElement;
	private readonly tabsEl: HTMLElement;
	private readonly body: HTMLElement;
	private readonly bodyStore = this._register(new DisposableStore());
	private readonly headStore = this._register(new DisposableStore());
	private readonly codeEditors = new Set<CodeEditorWidget>();
	private pending: ((target: IHttpCollection | IHttpFolder) => void)[] = [];
	private readonly saver = this._register(new RunOnceScheduler(() => void this.flush(), 350));
	private saving = 0;
	private resultList: WorkbenchList<IHttpRunResult> | undefined;
	private resultHost: HTMLElement | undefined;
	private summaryEl: HTMLElement | undefined;
	private width = 0;
	private height = 0;

	constructor(
		parent: HTMLElement,
		private readonly state: IHttpCollectionTabState,
		private readonly host: IHttpPageHost,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IVoltHttpCollections private readonly collections: IVoltHttpCollections,
		@IVoltHttpService private readonly http: IVoltHttpService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IVoltHttpOAuth private readonly oauth: IVoltHttpOAuth,
	) {
		super();
		this.element = append(parent, $('.volt-http-page'));
		this.head = append(this.element, $('.volt-http-head'));
		this.tabsEl = append(this.element, $('.volt-http-tabs'));
		this.body = append(this.element, $('.volt-http-page-body'));
		this._register(this.collections.onDidChange(uri => {
			// Its own saves change nothing it shows; anyone else's (another client, the file on disk) do.
			if (uri && uri.toString() === state.collection.toString() && !this.saving && !this.pending.length) {
				this.render();
			}
		}));
		this._register(toDisposable(() => {
			if (this.pending.length) {
				void this.flush();
			}
		}));
		this.render();
	}

	private get entry(): IHttpCollectionEntry | undefined {
		return this.collections.get(this.state.collection);
	}

	private get target(): IHttpCollection | IHttpFolder | undefined {
		const entry = this.entry;
		if (!entry || entry.error) {
			return undefined;
		}
		if (!this.state.folderId) {
			return entry.collection;
		}
		const item = findHttpItem(entry.collection, this.state.folderId)?.item;
		return item?.kind === 'folder' ? item : undefined;
	}

	private edit(mutate: (target: IHttpCollection | IHttpFolder) => void): void {
		this.pending.push(mutate);
		this.saver.schedule();
	}

	private async flush(): Promise<void> {
		const edits = this.pending;
		this.pending = [];
		if (!edits.length) {
			return;
		}
		this.saving++;
		try {
			const apply = (target: IHttpCollection | IHttpFolder) => edits.forEach(edit => edit(target));
			if (this.state.folderId) {
				await this.collections.updateItem(this.state.collection, this.state.folderId, item => item.kind === 'folder' && apply(item));
			} else {
				await this.collections.updateCollection(this.state.collection, apply);
			}
			this.host.tabChanged();
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		} finally {
			this.saving--;
		}
	}

	private render(): void {
		this.renderHead();
		this.renderTabs();
	}

	private renderHead(): void {
		this.headStore.clear();
		clearNode(this.head);
		const entry = this.entry;
		const target = this.target;
		const crumbs = append(this.head, $('.volt-http-crumbs'));
		if (!entry || !target) {
			append(crumbs, $('span.volt-http-gone')).textContent = entry?.error ? localize('voltHttp.collectionUnreadable', "{0} could not be read: {1}", basename(this.state.collection), entry.error) : localize('voltHttp.collectionGone', "This collection is no longer in the project.");
			return;
		}
		append(crumbs, $('span.volt-http-page-icon')).appendChild(renderIcon(this.state.folderId ? Codicon.folder : entry.collection.format === 'postman' ? Codicon.library : Codicon.file));
		const editable = !!this.state.folderId || entry.collection.format === 'postman';
		const name = append(crumbs, $('input.volt-http-name.title')) as HTMLInputElement;
		name.type = 'text';
		name.spellcheck = false;
		name.readOnly = !editable;
		name.setAttribute('aria-label', localize('voltHttp.collectionName', "Name"));
		name.value = editable ? target.name : basename(this.state.collection);
		name.addEventListener('input', () => {
			const value = name.value.trim();
			if (value) {
				this.edit(next => next.name = value);
			}
		});
		const actions = append(this.head, $('.volt-http-head-actions'));
		if (!this.state.folderId) {
			const exportButton = this.headStore.add(createVoltButton(actions, 'ghost', { supportIcons: true }));
			exportButton.label = `$(export) ${localize('voltHttp.export', "Export")}`;
			this.headStore.add(exportButton.onDidClick(() => this.host.exportCollection(this.state.collection)));
		}
		const run = this.headStore.add(createVoltButton(actions, 'primary', { supportIcons: true }));
		run.label = `$(play) ${localize('voltHttp.run', "Run")}`;
		this.headStore.add(run.onDidClick(() => {
			this.state.tab = 'runs';
			this.renderTabs();
			void this.run();
		}));
	}

	private renderTabs(): void {
		const target = this.target;
		if (!target) {
			clearNode(this.tabsEl);
			this.bodyStore.clear();
			clearNode(this.body);
			return;
		}
		const isCollection = !this.state.folderId;
		// The Runs tab has its own Run beside its settings: the head's steps aside there.
		this.element.dataset.tab = this.state.tab;
		if (this.state.tab === 'variables' && !isCollection) {
			this.state.tab = 'overview';
		}
		const summary = this.state.summary;
		renderHttpTabs<HttpCollectionPageTab>(this.tabsEl, [
			{ id: 'overview', label: localize('voltHttp.overview', "Overview") },
			...(isCollection ? [{ id: 'variables' as const, label: localize('voltHttp.variablesTab', "Variables"), count: (target as IHttpCollection).variables.length || undefined }] : []),
			{ id: 'auth', label: localize('voltHttp.authorization', "Authorization"), dot: target.auth.type !== 'none' && target.auth.type !== 'inherit' },
			{ id: 'scripts', label: localize('voltHttp.scripts', "Scripts"), dot: !!target.scripts.preRequest.trim() || !!target.scripts.test.trim() },
			{ id: 'runs', label: localize('voltHttp.runs', "Runs"), ...(summary ? { badge: { text: `${summary.passed}/${summary.passed + summary.failed}`, kind: summary.failed || summary.errors ? 'error' as const : 'ok' as const } } : {}) },
		], this.state.tab, id => {
			this.state.tab = id;
			this.renderTabs();
		});
		this.renderBody(target);
	}

	private renderBody(target: IHttpCollection | IHttpFolder): void {
		this.bodyStore.clear();
		this.resultList = undefined;
		clearNode(this.body);
		this.body.className = `volt-http-page-body ${this.state.tab}`;
		const entry = this.entry!;
		switch (this.state.tab) {
			case 'overview': {
				const requests = httpRequestsOf(target.items).length;
				const folders = target.items.filter(item => item.kind === 'folder').length;
				const facts = append(this.body, $('.volt-http-facts'));
				const fact = (label: string, value: string, open?: () => void) => {
					const row = append(facts, $('.volt-http-fact'));
					append(row, $('span.volt-http-fact-label')).textContent = label;
					if (open) {
						const link = append(row, $('button.volt-http-link')) as HTMLButtonElement;
						link.type = 'button';
						link.textContent = value;
						link.addEventListener('click', open);
					} else {
						append(row, $('span')).textContent = value;
					}
				};
				fact(localize('voltHttp.factRequests', "Requests"), String(requests));
				if (entry.collection.format === 'postman') {
					fact(localize('voltHttp.factFolders', "Folders"), String(folders));
				}
				fact(localize('voltHttp.factFormat', "Format"), entry.collection.format === 'postman' ? localize('voltHttp.formatPostman', "Postman collection v2.1") : localize('voltHttp.formatHttp', ".http file"));
				fact(localize('voltHttp.factFile', "File"), this.state.collection.fsPath, () => this.host.revealFile(this.state.collection));
				if (entry.collection.format === 'postman' || this.state.folderId) {
					append(this.body, $('.volt-http-sublabel')).textContent = localize('voltHttp.description', "Description");
					const area = append(this.body, $('textarea.volt-http-docs')) as HTMLTextAreaElement;
					area.placeholder = localize('voltHttp.collectionDocs', "What this is for. Saved in the file.");
					area.value = target.description;
					area.addEventListener('input', () => this.edit(next => next.description = area.value));
				}
				break;
			}
			case 'variables': {
				const collection = target as IHttpCollection;
				const note = append(this.body, $('.volt-http-note'));
				note.textContent = entry.collection.format === 'postman'
					? localize('voltHttp.variablesNote', "Available to every request in this collection as {{name}}. An environment's variable of the same name wins.")
					: localize('voltHttp.variablesNoteHttp', "Written at the top of the file as @name = value and available to its requests as {{name}}.");
				this.bodyStore.add(new HttpKeyValueTable(append(this.body, $('.volt-http-section')), {
					rows: collection.variables,
					keyLabel: localize('voltHttp.variable', "Variable"),
					description: entry.collection.format === 'postman',
					variables: this.host.variables,
					onChange: (rows: IHttpKeyValue[]) => this.edit(next => (next as IHttpCollection).variables = rows),
				}));
				break;
			}
			case 'auth':
				if (entry.collection.format === 'http') {
					append(this.body, $('.volt-http-empty.center')).textContent = localize('voltHttp.httpNoSharedAuth', "An .http file has no shared authorization: each request carries its own headers.");
					break;
				}
				renderHttpAuthEditor(this.body, {
					auth: target.auth,
					inheritable: !!this.state.folderId,
					openExternal: url => void this.openerService.open(url, { openExternal: true }),
					signIn: (url, callback) => this.oauth.signIn(url, callback),
					// Asked for like any request of this project, so it lands in History too.
					requestToken: async request => {
						const exchange = await this.http.send({ name: localize('voltHttp.tokenRequestName', "Token request"), method: 'POST', url: request.url, headers: request.headers, body: request.body, line: 0 }, { ...(this.host.root ? { root: this.host.root } : {}) });
						return exchange.response ? { status: exchange.response.status, body: exchange.response.body } : { error: exchange.error ?? localize('voltHttp.tokenRequestFailed', "The token request got no answer.") };
					},
					variables: this.host.variables,
					contextViewService: this.contextViewService,
					store: this.bodyStore,
					onChange: (mutate, redraw) => {
						if (redraw) {
							// The model is changed here too, so the redraw shows the new type's fields.
							mutate(target.auth);
						}
						this.edit(next => mutate(next.auth));
						if (redraw) {
							this.renderTabs();
						}
					},
				});
				break;
			case 'scripts': {
				if (entry.collection.format === 'http') {
					append(this.body, $('.volt-http-empty.center')).textContent = localize('voltHttp.httpNoSharedScripts', "An .http file has no shared scripts: each request has its own.");
					break;
				}
				const phase = this.state.scriptTab;
				const bar = append(this.body, $('.volt-http-script-bar'));
				renderHttpTabs<keyof IHttpScripts>(append(bar, $('.volt-http-subtabs')), [
					{ id: 'preRequest', label: localize('voltHttp.preRequest', "Pre-request"), dot: !!target.scripts.preRequest.trim() },
					{ id: 'test', label: localize('voltHttp.postResponse', "Post-response"), dot: !!target.scripts.test.trim() },
				], phase, id => {
					this.state.scriptTab = id;
					this.renderTabs();
				});
				append(bar, $('span.volt-http-note.end')).textContent = localize('voltHttp.sharedScriptNote', "Runs for every request inside, before the request's own.");
				const editor = this.bodyStore.add(this.instantiationService.createInstance(CodeEditorWidget, append(this.body, $('.volt-http-code')), {
					minimap: { enabled: false }, scrollBeyondLastLine: false, lineNumbersMinChars: 3, glyphMargin: false, wordWrap: 'on', renderLineHighlight: 'none', overviewRulerLanes: 0, fontSize: 12, padding: { top: 6, bottom: 6 }, automaticLayout: false, fixedOverflowWidgets: true,
					scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false },
				}, { isSimpleWidget: false }));
				editor.setModel(this.bodyStore.add(this.modelService.createModel(target.scripts[phase], this.languageService.createById(this.languageService.isRegisteredLanguageId('javascript') ? 'javascript' : 'plaintext'), undefined)));
				this.codeEditors.add(editor);
				this.bodyStore.add(toDisposable(() => this.codeEditors.delete(editor)));
				this.bodyStore.add(editor.onDidChangeModelContent(() => {
					const value = editor.getValue();
					this.edit(next => next.scripts[phase] = value);
				}));
				break;
			}
			case 'runs': this.renderRuns(); break;
		}
		this.layout(this.width, this.height);
	}

	// --- Runner ------------------------------------------------------------------------------------

	private renderRuns(): void {
		const state = this.state;
		const controls = append(this.body, $('.volt-http-run-controls'));
		const number = (label: string, value: number, min: number, max: number, set: (value: number) => void) => {
			const field = append(controls, $('label.volt-http-run-field'));
			append(field, $('span')).textContent = label;
			const input = append(field, $('input')) as HTMLInputElement;
			input.type = 'number';
			input.min = String(min);
			input.max = String(max);
			input.value = String(value);
			input.addEventListener('input', () => set(Math.max(min, Math.min(max, Number(input.value) || min))));
		};
		number(localize('voltHttp.iterations', "Iterations"), state.iterations, 1, 100, value => state.iterations = value);
		number(localize('voltHttp.delay', "Delay (ms)"), state.delayMs, 0, 10000, value => state.delayMs = value);
		const stop = append(controls, $('.volt-http-run-field.check'));
		createHttpCheck(stop, state.stopOnFailure, localize('voltHttp.stopOnFailure', "Stop on the first failure"), checked => state.stopOnFailure = checked);
		append(stop, $('span')).textContent = localize('voltHttp.stopOnFailure', "Stop on the first failure");
		append(controls, $('.volt-http-spacer'));
		const run = this.bodyStore.add(createVoltButton(controls, state.running ? 'secondary' : 'primary', { supportIcons: true }));
		run.label = state.running ? `$(debug-stop) ${localize('voltHttp.stopRun', "Stop")}` : `$(play) ${localize('voltHttp.runNow', "Run")}`;
		this.bodyStore.add(run.onDidClick(() => state.running ? state.running.cancel() : void this.run()));

		this.summaryEl = append(this.body, $('.volt-http-run-summary'));
		this.renderSummary();
		this.resultHost = append(this.body, $('.volt-http-run-list'));
		const renderer: IListRenderer<IHttpRunResult, { row: HTMLElement; status: HTMLElement; method: HTMLElement; name: HTMLElement; tests: HTMLElement; time: HTMLElement }> = {
			templateId: 'result',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-row.result'));
				return { row, status: append(row, $('span.volt-http-row-icon.status')), method: append(row, $('span.volt-http-row-method')), name: append(row, $('span.volt-http-row-label')), tests: append(row, $('span.volt-http-result-tests')), time: append(row, $('span.volt-http-row-detail')) };
			},
			renderElement: (result, _index, template) => {
				const exchange = result.exchange;
				const status = exchange.response?.status;
				clearNode(template.status);
				template.status.className = `volt-http-row-icon status ${httpStatusClass(status)}`;
				if (status) {
					template.status.textContent = String(status);
				} else {
					template.status.appendChild(renderIcon(Codicon.error));
				}
				template.method.textContent = exchange.method === 'DELETE' ? 'DEL' : exchange.method;
				template.method.dataset.method = exchange.method;
				template.name.textContent = result.path.join(' / ') || exchange.url;
				const tests = exchange.tests ?? [];
				const failed = tests.filter(test => !test.passed && !test.skipped);
				template.tests.textContent = exchange.error ? localize('voltHttp.resultError', "error") : exchange.scriptError ? localize('voltHttp.resultScriptError', "script error") : tests.length ? `${tests.length - failed.length}/${tests.length}` : '';
				template.tests.className = `volt-http-result-tests ${exchange.error || exchange.scriptError || failed.length ? 'fail' : 'pass'}`;
				template.time.textContent = exchange.response ? formatHttpDuration(exchange.response.durationMs) : '';
				setAgentTooltip(template.row, [`${exchange.method} ${exchange.url}`, exchange.error, exchange.scriptError, ...failed.map(test => `${test.name}: ${test.error ?? 'failed'}`)].filter(Boolean).join('\n'));
			},
			disposeTemplate: () => { },
		};
		const list = this.resultList = this.bodyStore.add(this.instantiationService.createInstance(WorkbenchList<IHttpRunResult>, 'VoltHttpRunResults', this.resultHost, { getHeight: () => RESULT_ROW_HEIGHT, getTemplateId: () => 'result' }, [renderer], {
			accessibilityProvider: { getAriaLabel: result => `${result.exchange.method} ${result.name} ${result.exchange.response?.status ?? result.exchange.error ?? ''}`, getWidgetAriaLabel: () => localize('voltHttp.runs', "Runs") },
			multipleSelectionSupport: false,
		}));
		this.bodyStore.add(list.onDidOpen(event => event.element && this.host.openRequest(this.state.collection, event.element.requestId, event.element.exchange)));
		this.layout(this.width, this.height);
		list.splice(0, 0, [...state.results]);
	}

	private renderSummary(): void {
		const el = this.summaryEl;
		if (!el) {
			return;
		}
		clearNode(el);
		const state = this.state;
		if (state.runError) {
			append(el, $('span.fail')).textContent = state.runError;
			return;
		}
		if (state.running) {
			append(el, $('span.volt-http-spinner')).appendChild(renderIcon(Codicon.loading));
			append(el, $('span')).textContent = localize('voltHttp.running', "Running, {0} sent", state.results.length);
			return;
		}
		const summary = state.summary;
		if (!summary) {
			el.textContent = localize('voltHttp.runHint', "Sends every request in order with the selected environment and runs their tests.");
			return;
		}
		const part = (text: string, kind?: string) => {
			const span = append(el, $('span'));
			span.textContent = text;
			if (kind) {
				span.classList.add(kind);
			}
		};
		part(localize('voltHttp.summaryRequests', "{0} requests", summary.requests));
		part(localize('voltHttp.summaryPassed', "{0} tests passed", summary.passed), summary.passed ? 'pass' : undefined);
		part(localize('voltHttp.summaryFailed', "{0} failed", summary.failed), summary.failed ? 'fail' : undefined);
		if (summary.errors) {
			part(localize('voltHttp.summaryErrors', "{0} errors", summary.errors), 'fail');
		}
		part(formatHttpDuration(summary.durationMs));
		if (summary.stopped) {
			part(localize('voltHttp.summaryStopped', "stopped early"), 'fail');
		}
	}

	async run(): Promise<void> {
		const state = this.state;
		if (state.running) {
			return;
		}
		await this.flush();
		const cancel = state.running = new CancellationTokenSource();
		state.results = [];
		state.summary = undefined;
		state.runError = undefined;
		this.renderTabs();
		try {
			state.summary = await this.collections.run(state.collection, {
				...(state.folderId ? { folderId: state.folderId } : {}),
				...(this.host.root ? { root: this.host.root } : {}),
				token: cancel.token,
				iterations: state.iterations,
				delayMs: state.delayMs,
				stopOnFailure: state.stopOnFailure,
				onProgress: result => {
					state.results.push(result);
					if (!this._store.isDisposed && this.state.tab === 'runs' && this.resultList) {
						this.resultList.splice(this.resultList.length, 0, [result]);
						this.renderSummary();
					}
				},
			});
		} catch (err) {
			state.runError = err instanceof Error ? err.message : String(err);
		} finally {
			state.running = undefined;
			cancel.dispose();
			if (!this._store.isDisposed) {
				this.renderTabs();
				this.host.tabChanged();
			}
		}
	}

	layout(width: number, height: number): void {
		this.width = width;
		this.height = height;
		if (!height) {
			return;
		}
		this.element.style.height = `${height}px`;
		for (const editor of this.codeEditors) {
			const host = editor.getContainerDomNode();
			editor.layout({ width: host.clientWidth, height: host.clientHeight });
		}
		if (this.resultList && this.resultHost) {
			const listHeight = Math.max(0, this.element.clientHeight - this.resultHost.offsetTop);
			this.resultHost.style.height = `${listHeight}px`;
			this.resultList.layout(listHeight, width);
		}
	}
}

/** An environment tab's state: which environment it shows. */
export interface IHttpEnvironmentTabState {
	entryId: string;
	name: string;
}

/** An environment's variables, saved to its file as they are edited. */
export class HttpEnvironmentPage extends Disposable {

	readonly element: HTMLElement;
	private readonly store = this._register(new DisposableStore());
	private entry: IHttpEnvironmentEntry | undefined;
	private name = '';
	private rows: IHttpKeyValue[] = [];
	private dirty = false;
	private saving = 0;
	private readonly saver = this._register(new RunOnceScheduler(() => void this.flush(), 350));

	constructor(
		parent: HTMLElement,
		private readonly state: IHttpEnvironmentTabState,
		private readonly host: IHttpPageHost,
		@IVoltHttpCollections private readonly collections: IVoltHttpCollections,
		@IVoltHttpService private readonly http: IVoltHttpService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this.element = append(parent, $('.volt-http-page'));
		this._register(this.collections.onDidChangeEnvironments(() => {
			if (!this.saving && !this.dirty) {
				void this.load();
			}
		}));
		this._register(this.http.onDidChangeEnvironment(() => this.entry && this.render()));
		this._register(toDisposable(() => {
			if (this.dirty) {
				void this.flush();
			}
		}));
		void this.load();
	}

	private async load(): Promise<void> {
		const entries = await this.collections.environments(this.host.root);
		if (this._store.isDisposed) {
			return;
		}
		this.entry = entries.find(entry => entry.id === this.state.entryId);
		if (this.entry) {
			this.name = this.entry.environment.name;
			this.rows = this.entry.environment.variables.map(row => ({ ...row }));
		}
		this.render();
	}

	private async flush(): Promise<void> {
		const entry = this.entry;
		if (!entry || !this.dirty) {
			return;
		}
		this.dirty = false;
		this.saving++;
		try {
			const wasActive = this.http.environmentOf(this.host.root) === entry.environment.name;
			await this.collections.saveEnvironment(entry, this.name, this.rows);
			const renamed = this.name.trim() && this.name.trim() !== entry.environment.name;
			// The tab follows its environment to the new name.
			this.entry = { ...entry, id: `${entry.uri.toString()}#${this.name.trim() || entry.environment.name}`, environment: { ...entry.environment, name: this.name.trim() || entry.environment.name, variables: this.rows.map(row => ({ ...row })) } };
			this.state.entryId = this.entry.id;
			this.state.name = this.entry.environment.name;
			if (renamed && wasActive) {
				this.http.setEnvironment(this.entry.environment.name, this.host.root);
			}
			this.host.tabChanged();
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		} finally {
			this.saving--;
		}
	}

	private render(): void {
		this.store.clear();
		clearNode(this.element);
		const entry = this.entry;
		const head = append(this.element, $('.volt-http-head'));
		const crumbs = append(head, $('.volt-http-crumbs'));
		if (!entry) {
			append(crumbs, $('span.volt-http-gone')).textContent = localize('voltHttp.environmentGone', "This environment is no longer in the project.");
			return;
		}
		append(crumbs, $('span.volt-http-page-icon')).appendChild(renderIcon(entry.globals ? Codicon.globe : Codicon.symbolVariable));
		const name = append(crumbs, $('input.volt-http-name.title')) as HTMLInputElement;
		name.type = 'text';
		name.spellcheck = false;
		name.readOnly = entry.shared;
		name.setAttribute('aria-label', localize('voltHttp.environmentName', "Environment name"));
		name.value = this.name;
		name.addEventListener('input', () => {
			this.name = name.value;
			this.dirty = true;
			this.saver.schedule();
		});
		const actions = append(head, $('.volt-http-head-actions'));
		if (!entry.globals && !entry.shared) {
			const active = this.http.environmentOf(this.host.root) === entry.environment.name;
			const use = this.store.add(createVoltButton(actions, active ? 'secondary' : 'primary', { supportIcons: true }));
			use.label = active ? `$(pass-filled) ${localize('voltHttp.envInUse', "In Use")}` : localize('voltHttp.envUse', "Use This Environment");
			this.store.add(use.onDidClick(() => this.http.setEnvironment(active ? undefined : entry.environment.name, this.host.root)));
		}
		const body = append(this.element, $('.volt-http-page-body.variables'));
		const note = append(body, $('.volt-http-note'));
		note.textContent = entry.globals
			? localize('voltHttp.globalsNote', "Globals apply to every request in this project, under collection and environment variables of the same name.")
			: entry.shared
				? localize('voltHttp.sharedNote', "$shared values apply under every environment of this file.")
				: localize('voltHttp.environmentNote', "Use a variable as {{name}} in URLs, headers and bodies. Saved in {0}.", basename(entry.uri));
		const fileLink = append(note, $('button.volt-http-link')) as HTMLButtonElement;
		fileLink.type = 'button';
		fileLink.textContent = localize('voltHttp.openFile', "Open File");
		fileLink.addEventListener('click', () => this.host.revealFile(entry.uri));
		this.store.add(new HttpKeyValueTable(append(body, $('.volt-http-section')), {
			rows: this.rows,
			keyLabel: localize('voltHttp.variable', "Variable"),
			secrets: entry.environment.format === 'postman',
			onChange: rows => {
				this.rows = rows;
				this.dirty = true;
				this.saver.schedule();
			},
		}));
	}

	layout(_width: number, height: number): void {
		if (height) {
			this.element.style.height = `${height}px`;
		}
	}
}
