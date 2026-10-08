/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import { join } from '../../../base/common/path.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import {
	authorizationServerMetadata, baseUrlFor, checkClientMetadata, CONSENT_TTL_MS, describeRedirect, externalToolScope, formatScopes, isAllowedOrigin, isPkceChallenge,
	negotiateProtocolVersion, normalizePublicUrl, parseScopes, protectedResourceMetadata, redirectMatches, redirectWith, sameResource, wwwAuthenticate,
} from '../common/externalMcpOAuth.js';
import {
	DEFAULT_EXTERNAL_MCP_PORT, ExternalMcpScope, IExternalMcpCall, IExternalMcpConfig, IExternalMcpConsentDecision, IExternalMcpConsentRequest, IExternalMcpGrantView,
	IExternalMcpResult, IExternalMcpStatus, IExternalMcpToolInfo, IVoltExternalMcpService,
} from '../common/voltExternalMcp.js';
import { ExternalMcpAuthStore, IVerifiedAccess } from '../node/externalMcpAuthStore.js';

const MAX_BODY_BYTES = 1024 * 1024;
/** thread_wait and thread_send(wait) long-poll 45 s; nothing an outside agent calls takes longer. */
const CALL_TIMEOUT_MS = 5 * 60_000;
const MAX_PENDING_CONSENTS = 5;
const MAX_SESSIONS = 200;

interface IConsentState {
	readonly request: IExternalMcpConsentRequest;
	readonly state?: string;
	readonly challenge: string;
	readonly resource: string;
	readonly issuer: string;
	status: 'pending' | 'approved' | 'denied';
	/** Set once approved; handed out by the first poll of the waiting page, then cleared. */
	code?: string;
	delivered?: boolean;
}

interface IJsonRpc {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: unknown;
}

class HttpError extends Error {
	constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) {
		super(message);
	}
}

export class VoltExternalMcpMainService extends Disposable implements IVoltExternalMcpService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidCall = this._register(new Emitter<IExternalMcpCall>());
	readonly onDidCall: Event<IExternalMcpCall> = this._onDidCall.event;
	private readonly _onDidCancel = this._register(new Emitter<{ id: string; windowId: string }>());
	readonly onDidCancel = this._onDidCancel.event;
	private readonly _onDidRequestConsent = this._register(new Emitter<IExternalMcpConsentRequest>());
	readonly onDidRequestConsent = this._onDidRequestConsent.event;
	private readonly _onDidEndConsent = this._register(new Emitter<{ id: string }>());
	readonly onDidEndConsent = this._onDidEndConsent.event;
	private readonly _onDidChangeGrants = this._register(new Emitter<void>());
	readonly onDidChangeGrants = this._onDidChangeGrants.event;
	private readonly _onDidChangeStatus = this._register(new Emitter<IExternalMcpStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private readonly store: ExternalMcpAuthStore;
	private readonly file: string | undefined;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;

	private server: http.Server | undefined;
	private config: IExternalMcpConfig = { enabled: false, port: DEFAULT_EXTERNAL_MCP_PORT, publicUrl: '' };
	private listening = false;
	private error: string | undefined;
	private configuring: Promise<unknown> = Promise.resolve();

	/** Windows that answer, most recently focused last. */
	private readonly windows = new Map<string, readonly IExternalMcpToolInfo[]>();
	private readonly consents = new Map<string, IConsentState>();
	private readonly pending = new Map<string, { resolve: (result: IExternalMcpResult) => void; windowId: string }>();
	/** Mcp-Session-Id → grant, so one agent cannot ride another's session. */
	private readonly sessions = new Map<string, string>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEnvironmentMainService environmentService: IEnvironmentMainService | undefined,
		options?: { readonly file?: string | null; readonly now?: () => number },
	) {
		super();
		this.file = options?.file === null ? undefined : options?.file ?? (environmentService ? join(environmentService.userDataPath, 'volt-external-mcp.json') : undefined);
		this.store = new ExternalMcpAuthStore(() => this.scheduleSave(), options?.now);
		this.load();
		this._register(toDisposable(() => {
			this.server?.close();
			this.server = undefined;
			if (this.saveTimer) {
				clearTimeout(this.saveTimer);
				this.saveNow();
			}
			for (const consent of this.consents.values()) {
				consent.status = 'denied';
			}
		}));
	}

	//#region Persistence

	private load(): void {
		if (!this.file) {
			return;
		}
		try {
			this.store.load(JSON.parse(fs.readFileSync(this.file, 'utf8')));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				this.logService.warn('[volt] external MCP: could not read its grants', err);
			}
		}
	}

	private scheduleSave(): void {
		this._onDidChangeGrants.fire();
		if (!this.file || this.saveTimer) {
			return;
		}
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.saveNow();
		}, 300);
	}

	private saveNow(): void {
		if (!this.file) {
			return;
		}
		try {
			const temp = `${this.file}.${process.pid}.tmp`;
			fs.writeFileSync(temp, JSON.stringify(this.store.toJSON()), { mode: 0o600 });
			fs.renameSync(temp, this.file);
		} catch (err) {
			this.logService.warn('[volt] external MCP: could not save its grants', err);
		}
	}

	//#endregion

	//#region Service API

	configure(config: IExternalMcpConfig): Promise<IExternalMcpStatus> {
		const next: IExternalMcpConfig = {
			enabled: !!config.enabled,
			port: Number.isInteger(config.port) && config.port > 0 && config.port < 65536 ? config.port : DEFAULT_EXTERNAL_MCP_PORT,
			publicUrl: normalizePublicUrl(config.publicUrl),
		};
		this.configuring = this.configuring.then(() => this.apply(next)).catch(() => undefined);
		return this.configuring.then(() => this.status());
	}

	private async apply(next: IExternalMcpConfig): Promise<void> {
		const previous = this.config;
		this.config = next;
		const restart = !next.enabled || next.port !== previous.port || !this.listening;
		if (!restart && this.server) {
			this._onDidChangeStatus.fire(this.status());
			return;
		}
		if (this.server) {
			const server = this.server;
			this.server = undefined;
			this.listening = false;
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
		this.error = undefined;
		if (next.enabled) {
			const server = http.createServer((req, res) => void this.handle(req, res));
			server.requestTimeout = 0;
			try {
				await new Promise<void>((resolve, reject) => {
					server.once('error', reject);
					// Loopback only. A tunnel (cloudflared, ngrok, Tailscale Serve) forwards to this address.
					server.listen(next.port, '127.0.0.1', () => resolve());
				});
				this.server = server;
				this.listening = true;
				this.logService.info(`[volt] external MCP listening on http://127.0.0.1:${next.port}/mcp`);
			} catch (err) {
				this.error = (err as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${next.port} is in use by another program.` : String(err);
				this.logService.warn('[volt] external MCP could not start', this.error);
			}
		}
		this._onDidChangeStatus.fire(this.status());
	}

	private status(): IExternalMcpStatus {
		return {
			enabled: this.config.enabled,
			listening: this.listening,
			port: this.config.port,
			url: `http://127.0.0.1:${this.config.port}/mcp`,
			...(this.config.publicUrl ? { publicMcpUrl: `${this.config.publicUrl}/mcp` } : {}),
			...(this.error ? { error: this.error } : {}),
		};
	}

	async getStatus(): Promise<IExternalMcpStatus> {
		return this.status();
	}

	async attach(windowId: string, tools: readonly IExternalMcpToolInfo[]): Promise<void> {
		const known = this.windows.has(windowId);
		this.windows.set(windowId, tools.filter(tool => externalToolScope(tool.name) === tool.scope));
		if (!known) {
			// Newest window last, so it answers until another is focused.
			this.focusOrder(windowId);
		}
	}

	async detach(windowId: string): Promise<void> {
		this.windows.delete(windowId);
		for (const [id, pending] of this.pending) {
			if (pending.windowId === windowId) {
				this.pending.delete(id);
				pending.resolve({ content: [{ type: 'text', text: 'The Volt window serving this call closed.' }], isError: true });
			}
		}
	}

	async focus(windowId: string): Promise<void> {
		if (this.windows.has(windowId)) {
			this.focusOrder(windowId);
		}
	}

	private focusOrder(windowId: string): void {
		const tools = this.windows.get(windowId);
		if (tools) {
			this.windows.delete(windowId);
			this.windows.set(windowId, tools);
		}
	}

	private activeWindow(): { id: string; tools: readonly IExternalMcpToolInfo[] } | undefined {
		const entries = [...this.windows];
		const last = entries.at(-1);
		return last ? { id: last[0], tools: last[1] } : undefined;
	}

	async respond(id: string, result: IExternalMcpResult): Promise<void> {
		const pending = this.pending.get(id);
		if (pending) {
			this.pending.delete(id);
			pending.resolve(result);
		}
	}

	async pendingConsents(): Promise<readonly IExternalMcpConsentRequest[]> {
		this.expireConsents();
		const window = this.activeWindow()?.id;
		return [...this.consents.values()].filter(consent => consent.status === 'pending').map(consent => window ? { ...consent.request, windowId: window } : consent.request);
	}

	async answerConsent(id: string, decision: IExternalMcpConsentDecision): Promise<void> {
		const consent = this.consents.get(id);
		if (!consent || consent.status !== 'pending' || consent.request.expiresAt <= Date.now()) {
			return;
		}
		const scopes = decision.scopes ? consent.request.scopes.filter(scope => decision.scopes!.includes(scope)) : [...consent.request.scopes];
		if (!decision.approve || !scopes.length) {
			consent.status = 'denied';
			this.logService.info(`[volt] external MCP: the user denied ${consent.request.clientName}`);
		} else {
			consent.status = 'approved';
			consent.code = this.store.issueCode({
				clientId: consent.request.clientId,
				redirectUri: consent.request.redirectUri,
				scopes,
				challenge: consent.challenge,
				resource: consent.resource,
			});
			this.logService.info(`[volt] external MCP: the user allowed ${consent.request.clientName} (${formatScopes(scopes)})`);
		}
		this._onDidEndConsent.fire({ id });
	}

	async listGrants(): Promise<readonly IExternalMcpGrantView[]> {
		return this.store.listGrants();
	}

	async revoke(grantId: string): Promise<void> {
		if (this.store.revokeGrant(grantId)) {
			this.logService.info('[volt] external MCP: a connection was revoked');
			for (const [session, grant] of this.sessions) {
				if (grant === grantId) {
					this.sessions.delete(session);
				}
			}
		}
	}

	//#endregion

	//#region HTTP

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			const base = baseUrlFor(req.headers.host, { port: this.config.port, publicUrl: this.config.publicUrl });
			if (!base) {
				throw new HttpError(403, 'Host not allowed');
			}
			const url = new URL(req.url ?? '/', base);
			const path = url.pathname.replace(/\/+$/, '') || '/';
			if (path.startsWith('/.well-known/')) {
				return this.wellKnown(req, res, path, base);
			}
			switch (path) {
				case '/oauth/register': return await this.register(req, res);
				case '/oauth/authorize': return this.authorize(req, res, url, base);
				case '/oauth/authorize/wait': return this.authorizeWait(res, url);
				case '/oauth/token': return await this.token(req, res);
				case '/oauth/revoke': return await this.revokeEndpoint(req, res);
				case '/mcp': return await this.mcp(req, res, base);
				case '/': return this.page(res, 200, 'Volt MCP server', `<p>This is Volt's MCP server for outside agents. Point your agent at <code>${escapeHtml(base)}/mcp</code>.</p>`);
			}
			throw new HttpError(404, 'Not found');
		} catch (err) {
			if (res.headersSent || res.destroyed) {
				return;
			}
			const status = err instanceof HttpError ? err.status : 500;
			req.resume();
			res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...(err instanceof HttpError ? err.headers : {}) });
			res.end(err instanceof Error ? err.message : String(err));
			if (!(err instanceof HttpError)) {
				this.logService.warn('[volt] external MCP request failed', err);
			}
		}
	}

	/** Public, read-only endpoints: browser-based clients (MCP Inspector) read them cross-origin. */
	private cors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
		if (req.headers.origin) {
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
			res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		}
		if (req.method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return true;
		}
		return false;
	}

	private wellKnown(req: http.IncomingMessage, res: http.ServerResponse, path: string, base: string): void {
		if (this.cors(req, res)) {
			return;
		}
		if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
			return this.json(res, 200, protectedResourceMetadata(base));
		}
		// Path-inserted forms too (RFC 8414 section 3.1); some clients try OpenID discovery first.
		if (/^\/\.well-known\/(oauth-authorization-server|openid-configuration)(\/mcp)?$/.test(path)) {
			return this.json(res, 200, authorizationServerMetadata(base));
		}
		throw new HttpError(404, 'Not found');
	}

	private async register(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (this.cors(req, res)) {
			return;
		}
		if (req.method !== 'POST') {
			throw new HttpError(405, 'POST only', { Allow: 'POST' });
		}
		const body = await readParams(req);
		const checked = checkClientMetadata(body);
		if ('error' in checked) {
			return this.json(res, 400, { error: checked.error, error_description: checked.description });
		}
		const client = this.store.registerClient(checked);
		this.logService.info(`[volt] external MCP: registered client "${client.name}"`);
		return this.json(res, 201, {
			client_id: client.clientId,
			client_id_issued_at: Math.floor(client.createdAt / 1000),
			client_name: client.name,
			redirect_uris: client.redirectUris,
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			scope: formatScopes(parseScopes(typeof body.scope === 'string' ? body.scope : undefined).scopes),
			...(client.clientUri ? { client_uri: client.clientUri } : {}),
		});
	}

	private authorize(req: http.IncomingMessage, res: http.ServerResponse, url: URL, base: string): void {
		if (req.method !== 'GET' && req.method !== 'POST') {
			throw new HttpError(405, 'GET only');
		}
		const q = url.searchParams;
		const client = this.store.getClient(q.get('client_id') ?? undefined);
		const redirectUri = q.get('redirect_uri') ?? (client?.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
		// Until client and redirect are known good, errors stay on this page (never an open redirect).
		if (!client) {
			return this.page(res, 400, 'Unknown app', '<p>This app is not registered with Volt. Start the connection again from the agent.</p>');
		}
		if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
			return this.page(res, 400, 'Wrong redirect', '<p>The redirect address does not match the one this app registered.</p>');
		}
		const state = q.get('state') ?? undefined;
		const fail = (error: string, description: string) => this.redirect(res, redirectWith(redirectUri, { error, error_description: description, state, iss: base }));
		if (q.get('response_type') !== 'code') {
			return fail('unsupported_response_type', 'Only response_type=code is supported.');
		}
		if (q.get('code_challenge_method') !== 'S256' || !isPkceChallenge(q.get('code_challenge'))) {
			return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
		}
		const resource = q.get('resource') ?? `${base}/mcp`;
		if (!sameResource(resource, `${base}/mcp`)) {
			return fail('invalid_target', `resource must be ${base}/mcp.`);
		}
		const parsed = parseScopes(q.get('scope'));
		if (!parsed.scopes.length) {
			return fail('invalid_scope', `Volt's scopes are: read send launch admin.`);
		}
		this.expireConsents();
		// One open request per app; a retry replaces the earlier one.
		for (const [id, consent] of this.consents) {
			if (consent.status === 'pending' && consent.request.clientId === client.clientId) {
				consent.status = 'denied';
				this._onDidEndConsent.fire({ id });
			}
		}
		if ([...this.consents.values()].filter(consent => consent.status === 'pending').length >= MAX_PENDING_CONSENTS) {
			return fail('temporarily_unavailable', 'Too many connection requests are waiting in Volt.');
		}
		const now = Date.now();
		const window = this.activeWindow();
		const request: IExternalMcpConsentRequest = {
			id: randomBytes(18).toString('base64url'),
			windowId: window?.id ?? '',
			clientId: client.clientId,
			clientName: client.name,
			...(client.clientUri ? { clientUri: client.clientUri } : {}),
			redirectUri,
			scopes: parsed.scopes,
			newClient: !this.store.hasGrantFor(client.clientId) && now - client.createdAt < 10 * 60_000,
			createdAt: now,
			expiresAt: now + CONSENT_TTL_MS,
		};
		this.consents.set(request.id, { request, state, challenge: q.get('code_challenge')!, resource, issuer: base, status: 'pending' });
		this.logService.info(`[volt] external MCP: "${client.name}" asks to connect (${formatScopes(parsed.scopes)})`);
		this._onDidRequestConsent.fire(request);
		this.redirect(res, `${base}/oauth/authorize/wait?request=${encodeURIComponent(request.id)}`);
	}

	/**
	 * The browser tab the agent opened waits here (it reloads itself) until the user answers in
	 * Volt, then goes on to the agent's redirect with the code. No script, no buttons: approving
	 * happens only inside Volt, so a web page cannot click it for the user.
	 */
	private authorizeWait(res: http.ServerResponse, url: URL): void {
		this.expireConsents();
		const consent = this.consents.get(url.searchParams.get('request') ?? '');
		if (!consent) {
			return this.page(res, 404, 'Request expired', '<p>This connection request is no longer open. Start it again from the agent.</p>');
		}
		const { request } = consent;
		if (consent.status === 'approved' && consent.code && !consent.delivered) {
			consent.delivered = true;
			const code = consent.code;
			consent.code = undefined;
			return this.redirect(res, redirectWith(request.redirectUri, { code, state: consent.state, iss: consent.issuer }));
		}
		if (consent.status === 'denied' || consent.delivered) {
			this.consents.delete(request.id);
			return this.redirect(res, redirectWith(request.redirectUri, { error: 'access_denied', error_description: 'The user did not allow this app in Volt.', state: consent.state, iss: consent.issuer }));
		}
		const where = describeRedirect(request.redirectUri);
		const windowOpen = this.windows.size > 0;
		res.setHeader('Refresh', '1');
		this.page(res, 200, `Connect ${request.clientName} to Volt`, [
			`<p class="lead">Switch to <b>Volt</b> to allow or deny <b>${escapeHtml(request.clientName)}</b>.</p>`,
			`<p>It asks for: <b>${escapeHtml(formatScopes(request.scopes))}</b>. Volt then sends it back to ${escapeHtml(where.label)}.</p>`,
			windowOpen ? '<p class="muted">This page moves on by itself once you answer.</p>' : '<p class="warn">No Volt window is open. Open Volt to answer.</p>',
		].join(''));
	}

	private async token(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (this.cors(req, res)) {
			return;
		}
		if (req.method !== 'POST') {
			throw new HttpError(405, 'POST only', { Allow: 'POST' });
		}
		const body = await readParams(req);
		const text = (key: string) => typeof body[key] === 'string' ? body[key] as string : undefined;
		const clientId = text('client_id') ?? basicClientId(req.headers.authorization);
		let result;
		switch (text('grant_type')) {
			case 'authorization_code':
				result = this.store.exchangeCode({ code: text('code'), clientId, redirectUri: text('redirect_uri'), verifier: text('code_verifier'), resource: text('resource') });
				break;
			case 'refresh_token':
				result = this.store.refresh({ refreshToken: text('refresh_token'), clientId, scope: text('scope'), resource: text('resource') });
				break;
			default:
				result = { error: 'unsupported_grant_type' as const, error_description: 'grant_type is authorization_code or refresh_token.' };
		}
		if ('error' in result) {
			return this.json(res, result.error === 'invalid_client' ? 401 : 400, result);
		}
		return this.json(res, 200, result);
	}

	private async revokeEndpoint(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (this.cors(req, res)) {
			return;
		}
		if (req.method !== 'POST') {
			throw new HttpError(405, 'POST only', { Allow: 'POST' });
		}
		const body = await readParams(req);
		this.store.revokeToken(typeof body.token === 'string' ? body.token : undefined);
		// RFC 7009 section 2.2: 200 whether or not the token was known.
		res.writeHead(200, { 'Cache-Control': 'no-store' });
		res.end();
	}

	private authenticate(req: http.IncomingMessage, base: string): IVerifiedAccess {
		const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
		const access = this.store.verifyAccess(match?.[1], `${base}/mcp`);
		if (!access) {
			throw new HttpError(401, match ? 'The access token is invalid, expired or revoked.' : 'Authorization required.', {
				'WWW-Authenticate': wwwAuthenticate(base, match ? { error: 'invalid_token', description: 'The access token is invalid, expired or revoked' } : { scope: parseScopes(undefined).scopes }),
			});
		}
		return access;
	}

	private async mcp(req: http.IncomingMessage, res: http.ServerResponse, base: string): Promise<void> {
		if (!isAllowedOrigin(req.headers.origin, base)) {
			throw new HttpError(403, 'Origin not allowed');
		}
		const access = this.authenticate(req, base);
		const sessionHeader = req.headers['mcp-session-id'];
		const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
		if (sessionId && this.sessions.has(sessionId) && this.sessions.get(sessionId) !== access.grantId) {
			throw new HttpError(404, 'Unknown session');
		}
		if (req.method === 'DELETE') {
			if (sessionId) {
				this.sessions.delete(sessionId);
			}
			res.writeHead(200);
			res.end();
			return;
		}
		if (req.method !== 'POST') {
			// No server-initiated stream: every answer comes back on its POST.
			req.resume();
			res.writeHead(405, { Allow: 'POST, DELETE' });
			res.end();
			return;
		}
		let message: IJsonRpc | IJsonRpc[];
		try {
			const body = await readBody(req, MAX_BODY_BYTES);
			message = body ? JSON.parse(body) : {};
		} catch (err) {
			return this.json(res, err instanceof HttpError ? err.status : 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
		}
		const batch = Array.isArray(message) ? message : [message];
		const headers: Record<string, string> = {};
		const results: unknown[] = [];
		for (const item of batch) {
			const result = await this.dispatch(item, access, res, headers);
			if (result !== undefined) {
				results.push(result);
			}
		}
		if (!results.length) {
			res.writeHead(202, headers);
			res.end();
			return;
		}
		if (res.writableEnded || res.destroyed) {
			return;
		}
		this.json(res, 200, Array.isArray(message) ? results : results[0], headers);
	}

	private toolsFor(access: IVerifiedAccess): readonly IExternalMcpToolInfo[] {
		return (this.activeWindow()?.tools ?? []).filter(tool => access.scopes.includes(tool.scope));
	}

	private async dispatch(message: IJsonRpc, access: IVerifiedAccess, res: http.ServerResponse, headers: Record<string, string>): Promise<unknown> {
		if (message.id === undefined || message.method?.startsWith('notifications/')) {
			return undefined;
		}
		const id = message.id;
		switch (message.method) {
			case 'initialize': {
				const session = randomBytes(16).toString('hex');
				this.sessions.set(session, access.grantId);
				if (this.sessions.size > MAX_SESSIONS) {
					this.sessions.delete(this.sessions.keys().next().value!);
				}
				headers['Mcp-Session-Id'] = session;
				this.store.touch(access.grantId, undefined);
				this.scheduleSave();
				return ok(id, {
					protocolVersion: negotiateProtocolVersion((message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion),
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'volt', title: 'Volt', version: '0.1.0' },
					instructions: EXTERNAL_INSTRUCTIONS(access.clientName, access.scopes),
				});
			}
			case 'ping':
				return ok(id, {});
			case 'tools/list':
				return ok(id, { tools: this.toolsFor(access).map(({ scope: _scope, ...tool }) => tool) });
			case 'tools/call': {
				const params = (message.params ?? {}) as { name?: string; arguments?: unknown };
				const name = params.name ?? '';
				const window = this.activeWindow();
				const tool = window?.tools.find(candidate => candidate.name === name);
				const scope = externalToolScope(name);
				if (!scope) {
					return ok(id, { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true });
				}
				if (!access.scopes.includes(scope)) {
					// Step-up: the agent may ask the user for the missing scope (MCP authorization section scope challenge).
					throw new HttpError(403, `${name} needs the "${scope}" scope.`, {
						'WWW-Authenticate': wwwAuthenticate(this.baseOf(res), { error: 'insufficient_scope', scope: [...access.scopes, scope], description: `${name} needs the ${scope} scope` }),
					});
				}
				if (!window || !tool) {
					return ok(id, { content: [{ type: 'text', text: 'No Volt window is open to serve this. Ask the user to open Volt.' }], isError: true });
				}
				this.store.touch(access.grantId, name);
				this.scheduleSave();
				return ok(id, await this.call(window.id, access, name, params.arguments ?? {}, res));
			}
		}
		return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${message.method ?? ''}` } };
	}

	private baseOf(res: http.ServerResponse): string {
		return baseUrlFor(res.req?.headers.host, { port: this.config.port, publicUrl: this.config.publicUrl }) ?? `http://127.0.0.1:${this.config.port}`;
	}

	private call(windowId: string, access: IVerifiedAccess, name: string, args: unknown, res: http.ServerResponse): Promise<IExternalMcpResult> {
		const id = generateUuid();
		return new Promise<IExternalMcpResult>(resolve => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					this._onDidCancel.fire({ id, windowId });
					resolve({ content: [{ type: 'text', text: 'Volt did not answer in time.' }], isError: true });
				}
			}, CALL_TIMEOUT_MS);
			this.pending.set(id, {
				windowId,
				resolve: result => {
					clearTimeout(timer);
					resolve(result);
				},
			});
			res.on('close', () => {
				if (!res.writableEnded && this.pending.delete(id)) {
					clearTimeout(timer);
					this._onDidCancel.fire({ id, windowId });
					resolve({ content: [], isError: true });
				}
			});
			this._onDidCall.fire({ id, windowId, grantId: access.grantId, clientId: access.clientId, clientName: access.clientName, scopes: access.scopes, name, args });
		});
	}

	private expireConsents(): void {
		const now = Date.now();
		for (const [id, consent] of this.consents) {
			// Answered requests stay a minute so the waiting tab can pick up the answer.
			if (consent.request.expiresAt + (consent.status === 'pending' ? 0 : 60_000) <= now) {
				this.consents.delete(id);
				if (consent.status === 'pending') {
					this._onDidEndConsent.fire({ id });
				}
			}
		}
	}

	private json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
		res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache', ...headers });
		res.end(JSON.stringify(body));
	}

	private redirect(res: http.ServerResponse, location: string): void {
		res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
		res.end();
	}

	private page(res: http.ServerResponse, status: number, title: string, body: string): void {
		res.writeHead(status, {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'`,
			'X-Frame-Options': 'DENY',
			'Referrer-Policy': 'no-referrer',
		});
		res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f7;color:#1d1d1f}
@media(prefers-color-scheme:dark){body{background:#161617;color:#ececec}.card{background:#212123!important;border-color:#333!important}}
.card{max-width:440px;margin:24px;padding:28px 30px;background:#fff;border:1px solid #e3e3e6;border-radius:14px}
h1{font-size:18px;margin:0 0 10px}.muted{opacity:.6}.warn{color:#c2410c}.lead{font-size:16px}code{font:13px ui-monospace,monospace}
</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1>${body}</div></body></html>`);
	}

	//#endregion
}

function EXTERNAL_INSTRUCTIONS(clientName: string, scopes: readonly ExternalMcpScope[]): string {
	return [
		`You are connected to the user's Volt app as an outside agent ("${clientName}", scopes: ${formatScopes(scopes)}). Volt runs coding agents in chats; these tools let you run them the way the user does.`,
		'You are not a Volt chat, so tools never default to "this chat": pass thread_id from thread_list / thread_search.',
		'orchestrator_capabilities lists the models you can pass to thread_launch. thread_launch starts a chat in the project the user has open (or `project`); thread_send messages a chat (wait=true returns its reply); thread_wait and thread_read follow chats. The user sees every chat and message you start, marked as coming from you.',
		'Launched chats run on the user\'s models and spend their usage: launch only what the task needs.',
	].join('\n');
}

function ok(id: string | number | null, result: unknown): unknown {
	return { jsonrpc: '2.0', id, result };
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[char]!);
}

/** Public clients authenticate with `none`, but some send `Basic base64(client_id:)` anyway. */
function basicClientId(header: string | undefined): string | undefined {
	const match = /^Basic\s+(\S+)$/i.exec(header ?? '');
	if (!match) {
		return undefined;
	}
	const decoded = Buffer.from(match[1], 'base64').toString('utf8');
	const id = decodeURIComponent(decoded.split(':')[0] ?? '');
	return id || undefined;
}

async function readParams(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	const body = await readBody(req, 64 * 1024);
	const type = (req.headers['content-type'] ?? '').toLowerCase();
	if (type.includes('application/json')) {
		try {
			const parsed = JSON.parse(body || '{}');
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
		} catch {
			throw new HttpError(400, 'Body is not JSON');
		}
	}
	return Object.fromEntries(new URLSearchParams(body));
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let failed = false;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				if (!failed) {
					failed = true;
					reject(new HttpError(413, 'Request too large'));
				}
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (!failed) {
				resolve(Buffer.concat(chunks).toString('utf8'));
			}
		});
		req.on('error', reject);
	});
}
