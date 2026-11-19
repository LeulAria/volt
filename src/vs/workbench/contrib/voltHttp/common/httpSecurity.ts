/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Security scans of the user's own APIs: the `*.volt-security.json` file, the catalogue of
 * checks, the passive analyzers (they read the response a request already gets), the planning
 * and judging of active probes (extra requests, detection only: nothing destructive, nothing
 * time based, no payload that takes data out), findings with masked evidence, summaries and
 * the reports. Everything here is pure: who sends, how fast and to which hosts is the
 * service's business (`browser/voltHttpSecurity.ts`).
 */

import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';

// --- Types ------------------------------------------------------------------------------------------

export const HTTP_SECURITY_FILE_SUFFIX = '.volt-security.json';
export const HTTP_SECURITY_FILE_PATTERN = '**/*.volt-security.json';
/** The host probes point redirects and origins at: `.invalid` never resolves (RFC 2606). */
export const HTTP_SECURITY_SCAN_HOST = 'volt-security-scan.invalid';
export const HTTP_SECURITY_SCAN_ORIGIN = `https://${HTTP_SECURITY_SCAN_HOST}`;

export type HttpSecuritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type HttpSecurityConfidence = 'certain' | 'firm' | 'tentative';
export type HttpSecurityTriage = 'falsePositive' | 'accepted' | 'fixed';
export type HttpSecurityOwasp = 'API1' | 'API2' | 'API3' | 'API4' | 'API5' | 'API6' | 'API7' | 'API8' | 'API9' | 'API10';
export type HttpSecurityCategory = 'transport' | 'headers' | 'cors' | 'cookies' | 'disclosure' | 'data' | 'authentication' | 'authorization' | 'methods' | 'injection' | 'input' | 'limits';

export const HTTP_SECURITY_SEVERITIES: readonly HttpSecuritySeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export const HTTP_SECURITY_SEVERITY_LABELS: Readonly<Record<HttpSecuritySeverity, string>> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

/** OWASP API Security Top 10, 2023. */
export const HTTP_SECURITY_OWASP: Readonly<Record<HttpSecurityOwasp, string>> = {
	API1: 'Broken Object Level Authorization',
	API2: 'Broken Authentication',
	API3: 'Broken Object Property Level Authorization',
	API4: 'Unrestricted Resource Consumption',
	API5: 'Broken Function Level Authorization',
	API6: 'Unrestricted Access to Sensitive Business Flows',
	API7: 'Server Side Request Forgery',
	API8: 'Security Misconfiguration',
	API9: 'Improper Inventory Management',
	API10: 'Unsafe Consumption of APIs',
};

export const HTTP_SECURITY_OWASP_IDS = Object.keys(HTTP_SECURITY_OWASP) as HttpSecurityOwasp[];

export const HTTP_SECURITY_CATEGORIES: Readonly<Record<HttpSecurityCategory, string>> = {
	transport: 'Transport',
	headers: 'Security headers',
	cors: 'CORS',
	cookies: 'Cookies',
	disclosure: 'Information disclosure',
	data: 'Data exposure',
	authentication: 'Authentication',
	authorization: 'Authorization',
	methods: 'HTTP methods',
	injection: 'Injection',
	input: 'Input handling',
	limits: 'Rate limiting',
};

export interface IHttpSecurityCheck {
	readonly id: string;
	readonly title: string;
	readonly category: HttpSecurityCategory;
	readonly owasp: HttpSecurityOwasp;
	readonly cwe?: number;
	readonly severity: HttpSecuritySeverity;
	/** Sends extra requests. A passive check only reads the response the request gets anyway. */
	readonly active: boolean;
	/** `host`: one finding per host however many requests show it (a header, TLS). */
	readonly scope: 'host' | 'endpoint';
	/** What it looks for, in one line. */
	readonly description: string;
	/** Why a finding matters. */
	readonly risk: string;
	readonly remediation: string;
}

export interface IHttpSecurityRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly body?: string;
}

export interface IHttpSecurityResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

/** A request as it went out and what came back. */
export interface IHttpSecurityExchange {
	readonly request: IHttpSecurityRequest;
	readonly response?: IHttpSecurityResponse;
	readonly error?: string;
}

export interface IHttpSecurityEndpoint {
	readonly method: string;
	/** Without secrets in its query. */
	readonly url: string;
	/** The collection file, relative to the project when it is inside it. */
	readonly collection: string;
	/** The request's name path in the collection. */
	readonly path: readonly string[];
}

export interface IHttpSecurityEvidence {
	readonly request: { readonly method: string; readonly url: string; readonly headers: readonly (readonly [string, string])[]; readonly body?: string };
	/** `status` 0 when nothing came back (`error` says why). */
	readonly response: { readonly status: number; readonly headers: readonly (readonly [string, string])[]; readonly body: string; readonly error?: string };
	/** The text that gave it away, as it stands in the excerpt. */
	readonly match?: string;
}

export interface IHttpSecurityFinding {
	readonly id: string;
	/** Stable across scans: the check, the endpoint (the host for host-wide checks) and the parameter. */
	readonly fingerprint: string;
	readonly checkId: string;
	readonly title: string;
	readonly severity: HttpSecuritySeverity;
	readonly confidence: HttpSecurityConfidence;
	readonly owasp: HttpSecurityOwasp;
	readonly cwe?: number;
	readonly endpoint: IHttpSecurityEndpoint;
	readonly parameter?: string;
	readonly description: string;
	readonly evidence: IHttpSecurityEvidence;
	readonly remediation: string;
	/** How many requests showed the same host-wide finding. */
	readonly occurrences?: number;
}

export interface IHttpSecurityTarget {
	collection: string;
	/** A folder or request by its name path; the whole collection when absent. */
	path?: string[];
}

export interface IHttpSecurityOptions {
	active: boolean;
	includeUnsafeMethods: boolean;
	requestsPerSecond: number;
	maxProbesPerRequest: number;
	timeoutMs: number;
}

export interface IHttpSecurityAuthorizedHost {
	host: string;
	/** When the user gave it (ISO date). */
	at: string;
	note?: string;
}

export interface IHttpSecurityScanRecord {
	/** ISO date. */
	at: string;
	durationMs: number;
	/** Requests whose baseline was sent. */
	requests: number;
	/** Extra requests the active checks sent. */
	probes: number;
	active: boolean;
	stopped?: boolean;
	/** What the scan left out and why (a request with no answer, hosts without authorization). */
	notes?: string[];
	findings: IHttpSecurityFinding[];
}

export interface IHttpSecurityFile {
	volt: 'security';
	version: 1;
	name: string;
	description: string;
	targets: IHttpSecurityTarget[];
	checks: Record<string, boolean>;
	options: IHttpSecurityOptions;
	authorizedHosts: IHttpSecurityAuthorizedHost[];
	triage: Record<string, HttpSecurityTriage>;
	lastScan?: IHttpSecurityScanRecord;
}

// --- The catalogue ----------------------------------------------------------------------------------

type CheckRow = [id: string, title: string, category: HttpSecurityCategory, owasp: HttpSecurityOwasp, cwe: number | undefined, severity: HttpSecuritySeverity, scope: 'host' | 'endpoint', description: string, risk: string, remediation: string];

const PASSIVE: readonly CheckRow[] = [
	['transport.plainHttp', 'API served over plain HTTP', 'transport', 'API8', 319, 'medium', 'host', 'Requests to a host that is not local go over http://.', 'Anyone on the network path can read and change requests and responses, tokens included.', 'Serve the API over HTTPS only and redirect or refuse plain HTTP.'],
	['transport.secretInUrl', 'Credentials in the URL', 'transport', 'API2', 598, 'medium', 'endpoint', 'A token, key or password travels in the query string or the URL\'s user part.', 'URLs end up in server logs, proxies, browser history and Referer headers, and the secret with them.', 'Send credentials in the Authorization header (or a secure cookie), never in the URL.'],
	['headers.hsts', 'Strict-Transport-Security is missing', 'headers', 'API8', 319, 'low', 'host', 'An HTTPS response without a Strict-Transport-Security header.', 'A client that once reaches the host over HTTP can be kept there by an attacker on the network.', 'Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` on every HTTPS response.'],
	['headers.contentTypeOptions', 'X-Content-Type-Options is missing', 'headers', 'API8', 693, 'low', 'host', 'A response without `X-Content-Type-Options: nosniff`.', 'A browser may guess the content type and run an API response as script or HTML.', 'Send `X-Content-Type-Options: nosniff` on every response.'],
	['headers.cacheControl', 'Authenticated response may be cached', 'headers', 'API8', 525, 'low', 'endpoint', 'An authenticated request\'s response without `Cache-Control: no-store` (or private).', 'Shared caches and browsers can keep one user\'s data and serve it to another.', 'Send `Cache-Control: no-store` on responses that carry a user\'s data.'],
	['headers.htmlFraming', 'HTML response without CSP or framing protection', 'headers', 'API8', 1021, 'low', 'endpoint', 'An HTML answer without Content-Security-Policy or X-Frame-Options.', 'The page can be framed for clickjacking, and nothing limits what injected markup may load or run.', 'Send a Content-Security-Policy (with `frame-ancestors`) on HTML answers; APIs that return only JSON can send `default-src \'none\'`.'],
	['cors.wildcardCredentials', 'CORS allows any origin with credentials', 'cors', 'API8', 942, 'high', 'endpoint', '`Access-Control-Allow-Origin` is `*` or `null` together with `Access-Control-Allow-Credentials: true`.', 'The policy is meant to let any site call the API as the signed-in user; servers that send it usually reflect origins elsewhere too.', 'Allow a fixed list of origins, and send credentials only to them.'],
	['cors.wildcardAuthenticated', 'CORS wildcard on an authenticated endpoint', 'cors', 'API8', 942, 'medium', 'endpoint', 'An endpoint that takes credentials answers with `Access-Control-Allow-Origin: *`.', 'Any website can read this endpoint\'s responses from a browser that holds (or is given) a token.', 'Send the wildcard only on public, unauthenticated resources; list the allowed origins for the rest.'],
	['cookies.flags', 'Cookie without Secure, HttpOnly or SameSite', 'cookies', 'API8', 614, 'low', 'host', 'A Set-Cookie header that leaves out Secure, HttpOnly or SameSite.', 'The cookie can leak over HTTP, be read by injected script, or ride along on cross-site requests.', 'Set `Secure; HttpOnly; SameSite=Lax` (or Strict) on session cookies.'],
	['disclosure.serverVersion', 'Server software and version disclosed', 'disclosure', 'API8', 200, 'info', 'host', 'Server, X-Powered-By or X-AspNet-Version name the software and its version.', 'It tells an attacker which known vulnerabilities to try first.', 'Remove the headers or strip the versions at the server or proxy.'],
	['disclosure.stackTrace', 'Stack trace or framework error page', 'disclosure', 'API8', 209, 'medium', 'endpoint', 'The body holds a stack trace or a framework\'s debug error page.', 'File paths, library versions and code structure help an attacker aim, and debug pages often show settings and secrets.', 'Turn debug mode off in deployed environments and answer errors with a generic message and an id to look up in the logs.'],
	['disclosure.sqlError', 'Database error in the response', 'disclosure', 'API8', 209, 'medium', 'endpoint', 'The body holds a database driver\'s error message.', 'It shows the query and the database in use, and often means input reaches the query unescaped.', 'Catch database errors, log them, and answer with a generic error. Use parameterized queries.'],
	['disclosure.internalAddress', 'Internal address or file path disclosed', 'disclosure', 'API8', 200, 'low', 'endpoint', 'The response names a private IP address or a server file path.', 'It maps the internal network and file layout for later attacks (SSRF, path traversal).', 'Leave internal hosts and paths out of responses and headers.'],
	['disclosure.secrets', 'Secret in the response', 'disclosure', 'API3', 312, 'high', 'endpoint', 'The body holds something shaped like a key or token (cloud keys, private key blocks, API tokens, JWTs).', 'Whoever can call the endpoint, or read a cached or logged copy of the answer, gets the credential.', 'Remove the secret from the response, rotate it, and return only what the client needs.'],
	['disclosure.verboseError', 'Verbose error response', 'disclosure', 'API8', 209, 'low', 'endpoint', 'An error answer that carries exception names, traces or debug fields.', 'Internal detail in errors helps an attacker understand and probe the implementation.', 'Return a short message and a code; keep the detail in server logs.'],
	['data.sensitiveFields', 'Sensitive field in the response', 'data', 'API3', 213, 'medium', 'endpoint', 'JSON fields such as password, a password hash, ssn or a card number (checked with Luhn) come back in the body.', 'Clients, logs and caches receive data they should never hold; a password hash can be cracked offline.', 'Return an explicit list of fields per endpoint (a response DTO) instead of the stored object.'],
	['data.excessive', 'Large list without pagination', 'data', 'API3', 213, 'info', 'endpoint', 'A very large array comes back and nothing in the request or response pages it.', 'Whole tables can be pulled in one call, and the endpoint is cheap to use for exhausting the server.', 'Page lists with a limit the server enforces, and return only the fields the client asks for.'],
	['auth.jwt', 'Weak JSON Web Token', 'authentication', 'API2', 347, 'high', 'host', 'The request\'s own token is read offline: `alg: none`, no expiry, a very long expiry, or an HS256 signature made with a guessable secret.', 'A token that can be forged or never expires lets an attacker act as any user.', 'Sign with a long random secret or an asymmetric key, pin the accepted algorithms on the server, and set a short `exp`.'],
	['limits.rateLimitHeaders', 'No rate limit headers', 'limits', 'API4', 770, 'info', 'host', 'No RateLimit, X-RateLimit or Retry-After headers on the response.', 'It hints that requests are not limited, which makes guessing, scraping and exhaustion cheap.', 'Limit requests per client and say so with RateLimit headers.'],
];

const ACTIVE: readonly CheckRow[] = [
	['auth.missing', 'Endpoint answers without credentials', 'authentication', 'API2', 306, 'high', 'endpoint', 'The request is sent again without its Authorization header, cookies or API key.', 'If the same data comes back, anyone can call the endpoint.', 'Require authentication on the route (deny by default) and answer 401 without valid credentials. If the endpoint is meant to be public, mark this as an accepted risk.'],
	['auth.malformedToken', 'Endpoint accepts an invalid token', 'authentication', 'API2', 287, 'high', 'endpoint', 'The request is sent again with a token that cannot be valid.', 'Credentials are not actually verified: any value signs a caller in.', 'Verify the token\'s signature, issuer, audience and expiry on every request and answer 401 when any fails.'],
	['access.bola', 'Another object\'s id answers (review)', 'authorization', 'API1', 639, 'medium', 'endpoint', 'A numeric or UUID id in the path or query is changed to a neighbour.', 'If the neighbour belongs to another user, any signed-in caller can read other users\' objects.', 'Check on the server that the caller owns (or may see) the object for every id it receives. Review the response: if the neighbour is this user\'s own or public, mark it as a false positive.'],
	['methods.trace', 'TRACE is enabled', 'methods', 'API8', 693, 'medium', 'endpoint', 'A TRACE request with a marker header is sent to see whether it is echoed back.', 'TRACE echoes request headers, credentials included, to whoever can make a browser send it.', 'Disable TRACE at the server or proxy.'],
	['methods.options', 'Permissive Allow header', 'methods', 'API5', 650, 'info', 'endpoint', 'An OPTIONS request is sent and the methods it advertises are compared with the ones the collection uses.', 'Methods nobody documented (PUT, DELETE, TRACE) are often less protected than the ones in use.', 'Allow only the methods each route implements and answer 405 for the rest.'],
	['methods.unexpectedVerb', 'Undocumented method accepted', 'methods', 'API5', 650, 'low', 'endpoint', 'A method the collection does not use on this path is sent (only with data-changing tests on).', 'A route that accepts methods nobody meant it to may skip the authorization the documented ones have.', 'Register handlers only for the methods you mean to serve and answer 405 for the rest.'],
	['methods.override', 'Method override header is honoured', 'methods', 'API5', 650, 'low', 'endpoint', 'A GET is sent with X-HTTP-Method-Override: HEAD to see whether the server switches method.', 'Access rules written per method at a proxy or gateway can be walked around by overriding the method.', 'Turn method override support off, or apply access rules after the override is resolved.'],
	['cors.reflectedOrigin', 'CORS reflects any origin', 'cors', 'API8', 942, 'high', 'endpoint', `The request is sent with \`Origin: ${HTTP_SECURITY_SCAN_ORIGIN}\`.`, 'When an unknown origin is echoed back with credentials allowed, any website can call the API as the signed-in user and read the answers.', 'Compare the Origin with a fixed list and echo it only on a match.'],
	['injection.sql', 'SQL injection signs', 'injection', 'API8', 89, 'high', 'endpoint', 'Each parameter gets a single quote, then a true/false boolean pair, looking for database errors or a change in behaviour.', 'Input that reaches a query unescaped lets an attacker read or change the database.', 'Use parameterized queries (or the ORM\'s bindings) for every value; never build SQL from input.'],
	['injection.nosql', 'NoSQL injection signs', 'injection', 'API8', 943, 'high', 'endpoint', 'Each parameter is replaced by an operator object such as {"$gt":""}.', 'Query operators taken from input can match every document or skip a password check.', 'Validate types before querying (a string must be a string) and strip keys that start with `$`.'],
	['injection.template', 'Template injection', 'injection', 'API8', 1336, 'high', 'endpoint', 'Each parameter gets template expressions such as ${7*7} and {{7*7}}, looking for 49 in the answer.', 'Input evaluated by a template engine usually leads to code running on the server.', 'Never build templates from input; pass input as data to a fixed template.'],
	['injection.xss', 'Input reflected unescaped in HTML', 'injection', 'API8', 79, 'medium', 'endpoint', 'Each parameter gets the harmless tag <volt-xss-probe>, looking for it unescaped in an HTML answer.', 'Markup from input runs as script in the victim\'s browser, in the API\'s origin.', 'Escape output for its context and answer API calls as JSON with the right content type.'],
	['injection.pathTraversal', 'Path traversal', 'injection', 'API8', 22, 'high', 'endpoint', 'File-like parameters are pointed at ../../../../etc/passwd and its Windows twin, looking for those files\' signatures.', 'Files outside the intended folder can be read: configuration, keys, source.', 'Resolve the path, check that it stays inside the allowed folder, and prefer ids over file names from input.'],
	['injection.command', 'Command injection', 'injection', 'API8', 78, 'critical', 'endpoint', 'Each parameter gets `;echo` with a small sum, looking for the sum worked out in the answer.', 'Input that reaches a shell runs commands as the server.', 'Do not pass input to a shell. Call programs with an argument list and validate the values.'],
	['redirect.open', 'Open redirect', 'injection', 'API8', 601, 'medium', 'endpoint', `URL-like parameters are pointed at ${HTTP_SECURITY_SCAN_ORIGIN}, looking for a redirect to it.`, 'Links to your domain can send users to an attacker\'s page, which helps phishing and token theft in OAuth flows.', 'Redirect only to paths or to a fixed list of hosts.'],
	['access.massAssignment', 'Mass assignment signs', 'authorization', 'API3', 915, 'high', 'endpoint', 'JSON bodies of POST, PUT and PATCH get an extra `"isAdmin": true` / `"role": "admin"` (only with data-changing tests on).', 'Fields the client should not set (roles, owners, prices) are taken from the body.', 'Bind request bodies to an explicit list of fields the caller may set.'],
	['input.contentType', 'Content type is not enforced', 'input', 'API8', 436, 'low', 'endpoint', 'A JSON body is sent as text/plain, and an XML body is offered (only with data-changing tests on).', 'JSON accepted as text/plain can be posted cross-site without a preflight; an XML parser nobody meant to expose widens the attack surface.', 'Answer 415 unless the Content-Type is one the endpoint supports.'],
	['input.oversized', 'Oversized input breaks the endpoint', 'input', 'API4', 400, 'low', 'endpoint', 'One field gets a 100 KB string.', 'A server error on long input points at missing size limits, which makes exhausting the server cheap.', 'Limit request and field sizes and answer 400 or 413 beyond them.'],
	['transport.downgrade', 'HTTPS API also answers over HTTP', 'transport', 'API8', 319, 'medium', 'host', 'The https URL is requested over http, without credentials.', 'Clients that use the http URL by mistake send their requests and tokens in the clear.', 'Close port 80 or redirect it to HTTPS, and send Strict-Transport-Security.'],
	['limits.burst', 'No rate limiting seen', 'limits', 'API4', 770, 'low', 'host', 'A short burst of at most 15 identical safe requests is sent, looking for 429 or rate limit headers.', 'Unlimited requests make password guessing, scraping and resource exhaustion cheap.', 'Limit requests per client and per credential, and answer 429 with Retry-After.'],
];

const toCheck = (active: boolean) => ([id, title, category, owasp, cwe, severity, scope, description, risk, remediation]: CheckRow): IHttpSecurityCheck => ({ id, title, category, owasp, ...(cwe !== undefined ? { cwe } : {}), severity, active, scope, description, risk, remediation });

export const HTTP_SECURITY_CHECKS: readonly IHttpSecurityCheck[] = [...PASSIVE.map(toCheck(false)), ...ACTIVE.map(toCheck(true))];

const CHECKS_BY_ID = new Map(HTTP_SECURITY_CHECKS.map(check => [check.id, check]));

export function httpSecurityCheck(id: string): IHttpSecurityCheck | undefined {
	return CHECKS_BY_ID.get(id);
}

// --- The file ---------------------------------------------------------------------------------------

export const HTTP_SECURITY_DEFAULT_RATE = 5;
export const HTTP_SECURITY_MAX_RATE = 20;
export const HTTP_SECURITY_DEFAULT_PROBES = 60;
export const HTTP_SECURITY_MAX_PROBES = 200;
export const HTTP_SECURITY_BURST = 15;

export function defaultHttpSecurityOptions(): IHttpSecurityOptions {
	return { active: false, includeUnsafeMethods: false, requestsPerSecond: HTTP_SECURITY_DEFAULT_RATE, maxProbesPerRequest: HTTP_SECURITY_DEFAULT_PROBES, timeoutMs: 15_000 };
}

export function emptyHttpSecurityFile(name: string): IHttpSecurityFile {
	return { volt: 'security', version: 1, name, description: '', targets: [], checks: {}, options: defaultHttpSecurityOptions(), authorizedHosts: [], triage: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function text(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

/** The options as the scan uses them: every number inside its bounds, whatever the file says. */
export function normalizeHttpSecurityOptions(raw: unknown): IHttpSecurityOptions {
	const defaults = defaultHttpSecurityOptions();
	const from = isRecord(raw) ? raw : {};
	return {
		active: from.active === true,
		includeUnsafeMethods: from.includeUnsafeMethods === true,
		requestsPerSecond: clamp(from.requestsPerSecond, 1, HTTP_SECURITY_MAX_RATE, defaults.requestsPerSecond),
		maxProbesPerRequest: clamp(from.maxProbesPerRequest, 0, HTTP_SECURITY_MAX_PROBES, defaults.maxProbesPerRequest),
		timeoutMs: clamp(from.timeoutMs, 1000, 120_000, defaults.timeoutMs),
	};
}

export function parseHttpSecurityTargets(raw: unknown): IHttpSecurityTarget[] {
	const out: IHttpSecurityTarget[] = [];
	for (const item of Array.isArray(raw) ? raw : []) {
		if (typeof item === 'string' && item.trim()) {
			out.push({ collection: item.trim() });
		} else if (isRecord(item) && typeof item.collection === 'string' && item.collection.trim()) {
			const path = Array.isArray(item.path) ? item.path.filter((part): part is string => typeof part === 'string' && part !== '') : typeof item.path === 'string' ? item.path.split('/').map(part => part.trim()).filter(part => part) : [];
			out.push({ collection: item.collection.trim(), ...(path.length ? { path } : {}) });
		}
	}
	return out;
}

function parseFinding(raw: unknown): IHttpSecurityFinding | undefined {
	if (!isRecord(raw) || typeof raw.checkId !== 'string' || typeof raw.fingerprint !== 'string') {
		return undefined;
	}
	const check = httpSecurityCheck(raw.checkId);
	const endpoint = isRecord(raw.endpoint) ? raw.endpoint : {};
	const evidence = isRecord(raw.evidence) ? raw.evidence : {};
	const request = isRecord(evidence.request) ? evidence.request : {};
	const response = isRecord(evidence.response) ? evidence.response : {};
	const pairs = (value: unknown): [string, string][] => (Array.isArray(value) ? value : []).filter((pair): pair is [string, string] => Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string').map(pair => [pair[0], pair[1]]);
	const severity = HTTP_SECURITY_SEVERITIES.find(item => item === raw.severity) ?? check?.severity ?? 'info';
	const confidence: HttpSecurityConfidence = raw.confidence === 'certain' || raw.confidence === 'firm' ? raw.confidence : 'tentative';
	const owasp = HTTP_SECURITY_OWASP_IDS.find(item => item === raw.owasp) ?? check?.owasp ?? 'API8';
	const cwe = typeof raw.cwe === 'number' ? raw.cwe : check?.cwe;
	return {
		id: text(raw.id, raw.fingerprint),
		fingerprint: raw.fingerprint,
		checkId: raw.checkId,
		title: text(raw.title, check?.title ?? raw.checkId),
		severity,
		confidence,
		owasp,
		...(cwe !== undefined ? { cwe } : {}),
		endpoint: { method: text(endpoint.method, 'GET'), url: text(endpoint.url), collection: text(endpoint.collection), path: Array.isArray(endpoint.path) ? endpoint.path.filter((part): part is string => typeof part === 'string') : [] },
		...(typeof raw.parameter === 'string' ? { parameter: raw.parameter } : {}),
		description: text(raw.description, check?.description ?? ''),
		evidence: {
			request: { method: text(request.method, 'GET'), url: text(request.url), headers: pairs(request.headers), ...(typeof request.body === 'string' ? { body: request.body } : {}) },
			response: { status: typeof response.status === 'number' ? response.status : 0, headers: pairs(response.headers), body: text(response.body), ...(typeof response.error === 'string' ? { error: response.error } : {}) },
			...(typeof evidence.match === 'string' ? { match: evidence.match } : {}),
		},
		remediation: text(raw.remediation, check?.remediation ?? ''),
		...(typeof raw.occurrences === 'number' ? { occurrences: raw.occurrences } : {}),
	};
}

/**
 * Reads a `*.volt-security.json` file. Tolerant: what is missing or of the wrong type takes its
 * default, unknown checks and triage values are dropped. Throws only when the text is not JSON or
 * is some other kind of file.
 */
export function parseHttpSecurityFile(content: string, fallbackName: string): IHttpSecurityFile {
	const json: unknown = JSON.parse(content);
	if (!isRecord(json) || (json.volt !== undefined && json.volt !== 'security')) {
		throw new Error('Not a Volt security scan file.');
	}
	const checks: Record<string, boolean> = {};
	if (isRecord(json.checks)) {
		for (const check of HTTP_SECURITY_CHECKS) {
			const value = json.checks[check.id];
			if (typeof value === 'boolean') {
				checks[check.id] = value;
			}
		}
	}
	const authorizedHosts: IHttpSecurityAuthorizedHost[] = [];
	for (const item of Array.isArray(json.authorizedHosts) ? json.authorizedHosts : []) {
		if (isRecord(item) && typeof item.host === 'string' && item.host.trim() && !authorizedHosts.some(known => known.host === item.host)) {
			authorizedHosts.push({ host: item.host.trim().toLowerCase(), at: text(item.at), ...(typeof item.note === 'string' && item.note ? { note: item.note } : {}) });
		}
	}
	const triage: Record<string, HttpSecurityTriage> = {};
	if (isRecord(json.triage)) {
		for (const [fingerprint, value] of Object.entries(json.triage)) {
			if (value === 'falsePositive' || value === 'accepted' || value === 'fixed') {
				triage[fingerprint] = value;
			}
		}
	}
	let lastScan: IHttpSecurityScanRecord | undefined;
	if (isRecord(json.lastScan)) {
		const scan = json.lastScan;
		const notes = Array.isArray(scan.notes) ? scan.notes.filter((note): note is string => typeof note === 'string') : [];
		lastScan = {
			at: text(scan.at),
			durationMs: clamp(scan.durationMs, 0, Number.MAX_SAFE_INTEGER, 0),
			requests: clamp(scan.requests, 0, Number.MAX_SAFE_INTEGER, 0),
			probes: clamp(scan.probes, 0, Number.MAX_SAFE_INTEGER, 0),
			active: scan.active === true,
			...(scan.stopped === true ? { stopped: true } : {}),
			...(notes.length ? { notes } : {}),
			findings: (Array.isArray(scan.findings) ? scan.findings : []).map(parseFinding).filter((finding): finding is IHttpSecurityFinding => !!finding),
		};
	}
	return {
		volt: 'security',
		version: 1,
		name: text(json.name).trim() || fallbackName,
		description: text(json.description),
		targets: parseHttpSecurityTargets(json.targets),
		checks,
		options: normalizeHttpSecurityOptions(json.options),
		authorizedHosts,
		triage,
		...(lastScan ? { lastScan } : {}),
	};
}

/** The file's text: keys in one order, checks in the catalogue's, triage by fingerprint, so a save changes only what changed. */
export function serializeHttpSecurityFile(file: IHttpSecurityFile): string {
	const checks: Record<string, boolean> = {};
	for (const check of HTTP_SECURITY_CHECKS) {
		if (typeof file.checks[check.id] === 'boolean') {
			checks[check.id] = file.checks[check.id];
		}
	}
	const triage: Record<string, HttpSecurityTriage> = {};
	for (const fingerprint of Object.keys(file.triage).sort()) {
		triage[fingerprint] = file.triage[fingerprint];
	}
	const options = normalizeHttpSecurityOptions(file.options);
	const ordered = {
		volt: 'security',
		version: 1,
		name: file.name,
		description: file.description,
		targets: file.targets.map(target => ({ collection: target.collection, ...(target.path?.length ? { path: [...target.path] } : {}) })),
		checks,
		options: { active: options.active, includeUnsafeMethods: options.includeUnsafeMethods, requestsPerSecond: options.requestsPerSecond, maxProbesPerRequest: options.maxProbesPerRequest, timeoutMs: options.timeoutMs },
		authorizedHosts: file.authorizedHosts.map(item => ({ host: item.host, at: item.at, ...(item.note ? { note: item.note } : {}) })),
		triage,
		...(file.lastScan ? { lastScan: file.lastScan } : {}),
	};
	return `${JSON.stringify(ordered, null, '\t')}\n`;
}

/** Passive and active checks alike are on until the file turns one off; active ones also need `options.active`. */
export function isHttpSecurityCheckEnabled(file: Pick<IHttpSecurityFile, 'checks'>, id: string): boolean {
	return file.checks[id] !== false;
}

// --- URLs, headers, bodies --------------------------------------------------------------------------

export function httpSecurityUrl(raw: string): URL | undefined {
	try {
		return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
	} catch {
		return undefined;
	}
}

/** The host a request goes to, with its port when it has one: what an authorization is given for. */
export function httpSecurityHostOf(url: string): string | undefined {
	return httpSecurityUrl(url)?.host.toLowerCase() || undefined;
}

export function isHttpSecurityHostAuthorized(file: Pick<IHttpSecurityFile, 'authorizedHosts'>, host: string | undefined): boolean {
	return !!host && file.authorizedHosts.some(item => item.host.toLowerCase() === host.toLowerCase());
}

function isLocalHost(hostname: string): boolean {
	const name = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	return name === 'localhost' || name === '::1' || name === '0.0.0.0' || /\.(?:localhost|local|test|internal)$/.test(name) || /^127\./.test(name) || isPrivateIp(name);
}

function isPrivateIp(value: string): boolean {
	return /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(value);
}

function responseHeader(response: IHttpSecurityResponse | undefined, name: string): string | undefined {
	if (!response) {
		return undefined;
	}
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(response.headers)) {
		if (key.toLowerCase() === wanted) {
			return value;
		}
	}
	return undefined;
}

function requestHeader(request: IHttpSecurityRequest, name: string): string | undefined {
	const wanted = name.toLowerCase();
	return request.headers.find(([key]) => key.toLowerCase() === wanted)?.[1];
}

function withHeaders(request: IHttpSecurityRequest, set: Readonly<Record<string, string | undefined>>): IHttpSecurityRequest {
	const names = new Set(Object.keys(set).map(name => name.toLowerCase()));
	const headers: [string, string][] = request.headers.filter(([key]) => !names.has(key.toLowerCase())).map(([key, value]) => [key, value]);
	for (const [name, value] of Object.entries(set)) {
		if (value !== undefined) {
			headers.push([name, value]);
		}
	}
	return { ...request, headers };
}

const AUTH_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key', 'apikey', 'x-auth-token', 'x-access-token'];
const SECRET_PARAM = /^(?:access[_-]?token|id[_-]?token|refresh[_-]?token|token|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|auth|authorization|session(?:[_-]?id)?|sid|jwt|sig(?:nature)?)$/i;
const SECRET_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie)$|token|secret|session|passw|api-?key|credential/i;
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/;

/** The request carries credentials: an auth header, cookies or a key in the query. */
export function isHttpSecurityRequestAuthenticated(request: IHttpSecurityRequest): boolean {
	if (request.headers.some(([key, value]) => AUTH_HEADERS.includes(key.toLowerCase()) && value.trim() !== '')) {
		return true;
	}
	const url = httpSecurityUrl(request.url);
	return !!url && [...url.searchParams.keys()].some(key => SECRET_PARAM.test(key));
}

function withoutCredentials(request: IHttpSecurityRequest): IHttpSecurityRequest {
	const headers = request.headers.filter(([key]) => !AUTH_HEADERS.includes(key.toLowerCase()));
	const url = httpSecurityUrl(request.url);
	if (url) {
		for (const key of [...url.searchParams.keys()]) {
			if (SECRET_PARAM.test(key)) {
				url.searchParams.delete(key);
			}
		}
		url.username = '';
		url.password = '';
	}
	return { ...request, url: url ? url.toString() : request.url, headers };
}

function isHtml(response: IHttpSecurityResponse): boolean {
	return /text\/html|application\/xhtml/i.test(responseHeader(response, 'content-type') ?? '');
}

function jsonOf(body: string | undefined): unknown {
	if (!body || !/^\s*[[{"]/.test(body)) {
		return undefined;
	}
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

const is2xx = (response: IHttpSecurityResponse | undefined): response is IHttpSecurityResponse => !!response && response.status >= 200 && response.status < 300;

/** The structure of a JSON value without its values: two answers of the same kind have the same shape. */
function shapeOf(value: unknown, depth = 0): string {
	if (Array.isArray(value)) {
		return depth > 3 || !value.length ? '[]' : `[${shapeOf(value[0], depth + 1)}]`;
	}
	if (isRecord(value)) {
		return depth > 3 ? '{}' : `{${Object.keys(value).sort().map(key => `${key}:${shapeOf(value[key], depth + 1)}`).join(',')}}`;
	}
	return value === null ? 'null' : typeof value;
}

/** Both answers are the same kind of thing: the same JSON structure, or (for other bodies) about the same size. */
function sameShape(a: IHttpSecurityResponse, b: IHttpSecurityResponse): boolean {
	const left = jsonOf(a.body);
	const right = jsonOf(b.body);
	if (left !== undefined || right !== undefined) {
		return left !== undefined && right !== undefined && shapeOf(left) === shapeOf(right);
	}
	if (!a.body.trim() || !b.body.trim()) {
		return a.body.trim() === b.body.trim();
	}
	return Math.abs(a.body.length - b.body.length) <= Math.max(a.body.length, b.body.length) * 0.1;
}

/** The length of the list an answer is: the array itself, or the one array among an object's values. */
function listLength(body: string): number | undefined {
	const json = jsonOf(body);
	if (Array.isArray(json)) {
		return json.length;
	}
	if (isRecord(json)) {
		const arrays = Object.values(json).filter(Array.isArray);
		return arrays.length === 1 ? arrays[0].length : undefined;
	}
	return undefined;
}

function similar(a: IHttpSecurityResponse, b: IHttpSecurityResponse): boolean {
	return a.status === b.status && sameShape(a, b) && listLength(a.body) === listLength(b.body) && Math.abs(a.body.length - b.body.length) <= Math.max(40, Math.max(a.body.length, b.body.length) * 0.1);
}

// --- Masking ----------------------------------------------------------------------------------------

/** A secret as evidence shows it: how it starts and how long it is. */
export function maskHttpSecurityValue(value: string): string {
	return value.length <= 4 ? '***' : `${value.slice(0, 4)}***(${value.length})`;
}

function maskCookiePairs(value: string, separator: RegExp, joiner: string): string {
	return value.split(separator).map(part => {
		const at = part.indexOf('=');
		return at < 0 ? part : `${part.slice(0, at + 1)}${maskHttpSecurityValue(part.slice(at + 1).trim())}`;
	}).join(joiner);
}

/** Set-Cookie header values one cookie each (several arrive joined by a comma or a line break). */
function splitSetCookie(value: string): string[] {
	return value.split(/\r?\n|,(?=\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=)/).map(part => part.trim()).filter(part => part);
}

export function maskHttpSecurityHeaders(headers: readonly (readonly [string, string])[], secrets: readonly string[] = []): [string, string][] {
	return headers.map(([key, value]) => {
		const name = key.toLowerCase();
		if (name === 'authorization' || name === 'proxy-authorization') {
			const scheme = /^(\S+)\s+(.+)$/.exec(value);
			return [key, scheme ? `${scheme[1]} ${maskHttpSecurityValue(scheme[2])}` : maskHttpSecurityValue(value)];
		}
		if (name === 'cookie') {
			return [key, maskCookiePairs(value, /;\s*/, '; ')];
		}
		if (name === 'set-cookie') {
			return [key, splitSetCookie(value).map(cookie => {
				const [pair, ...attributes] = cookie.split(/;\s*/);
				return [maskCookiePairs(pair, /;\s*/, '; '), ...attributes].join('; ');
			}).join(', ')];
		}
		return [key, SECRET_HEADER.test(name) ? maskHttpSecurityValue(value) : maskHttpSecurityText(value, secrets)];
	});
}

export function maskHttpSecurityUrl(raw: string): string {
	const url = httpSecurityUrl(raw);
	if (!url) {
		return raw;
	}
	let out = raw;
	for (const [key, value] of url.searchParams) {
		if (value && (SECRET_PARAM.test(key) || JWT.test(value))) {
			for (const form of new Set([value, encodeURIComponent(value)])) {
				out = out.split(`${key}=${form}`).join(`${key}=${maskHttpSecurityValue(value)}`);
			}
		}
	}
	if (url.password) {
		out = out.replace(/\/\/([^/@:]*):[^/@]*@/, (_whole, user: string) => `//${user}:***@`);
	}
	return out;
}

const SECRET_PATTERNS: readonly RegExp[] = [
	/eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
	/\bsk_live_[0-9A-Za-z]{16,}/g,
	/\bAIza[0-9A-Za-z_-]{35}\b/g,
];

/** `text` with everything that looks like a secret, and every secret named, cut to its first characters. */
export function maskHttpSecurityText(value: string, secrets: readonly string[] = []): string {
	// Key blocks first: a named secret may be the block's BEGIN line, and masking that would hide where the block starts.
	let out = value.replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, (_whole, begin: string, end: string) => `${begin}***${end}`);
	for (const secret of secrets) {
		if (secret.length >= 6 && !/^-----BEGIN [A-Z ]*PRIVATE KEY-----$/.test(secret)) {
			out = out.split(secret).join(maskHttpSecurityValue(secret));
		}
	}
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, found => found.includes('***(') ? found : maskHttpSecurityValue(found));
	}
	out = out.replace(/\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{12,})/g, (_whole, scheme: string, token: string) => `${scheme} ${maskHttpSecurityValue(token)}`);
	out = out.replace(/("(?:password|passwd|pwd|secret|client_?secret|api_?key|private_?key|access_?token|refresh_?token|id_?token)"\s*:\s*")((?:[^"\\]|\\.)+)(")/gi, (_whole, before: string, secret: string, after: string) => `${before}${secret.includes('***') ? secret : maskHttpSecurityValue(secret)}${after}`);
	return out;
}

/** What a request sends as its credentials, to mask wherever an answer echoes it. */
function secretsOf(request: IHttpSecurityRequest): string[] {
	const out: string[] = [];
	for (const [key, value] of request.headers) {
		const name = key.toLowerCase();
		if (name === 'cookie') {
			out.push(...value.split(/;\s*/).map(part => part.slice(part.indexOf('=') + 1)));
		} else if (AUTH_HEADERS.includes(name)) {
			out.push(value.replace(/^\S+\s+/, ''), value);
		}
	}
	const url = httpSecurityUrl(request.url);
	for (const [key, value] of url?.searchParams ?? []) {
		if (SECRET_PARAM.test(key)) {
			out.push(value);
		}
	}
	return out.filter(secret => secret.length >= 6);
}

// --- Findings ---------------------------------------------------------------------------------------

/** FNV-1a, twice with different seeds: 16 hex characters, the same in every run. */
function stableHash(value: string): string {
	const run = (seed: number) => {
		let hash = seed;
		for (let index = 0; index < value.length; index++) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193);
		}
		return (hash >>> 0).toString(16).padStart(8, '0');
	};
	return `${run(0x811c9dc5)}${run(0x9747b28c)}`;
}

/** The same for the same weakness in every scan: the check, where (the host for host-wide checks), and the parameter. */
export function httpSecurityFingerprint(checkId: string, method: string, url: string, parameter?: string): string {
	const parsed = httpSecurityUrl(url);
	const origin = parsed ? `${parsed.protocol}//${parsed.host.toLowerCase()}` : url;
	const where = httpSecurityCheck(checkId)?.scope === 'host' ? origin : `${method.toUpperCase()} ${origin}${parsed ? parsed.pathname : ''}`;
	return stableHash(`${checkId}|${where}|${parameter ?? ''}`);
}

const EVIDENCE_HEADERS = /^(?:content-type|content-length|server|x-powered-by|x-aspnet-version|x-aspnetmvc-version|set-cookie|location|allow|www-authenticate|strict-transport-security|cache-control|x-content-type-options|content-security-policy|x-frame-options|retry-after|access-control-.*|(?:x-)?rate-?limit.*)$/i;
const EXCERPT = 600;

function excerpt(body: string, match: string | undefined, max = EXCERPT): string {
	if (body.length <= max) {
		return body;
	}
	const at = match ? body.indexOf(match) : -1;
	if (at < 0) {
		return `${body.slice(0, max)}\n[${body.length - max} more characters]`;
	}
	const start = Math.max(0, at - Math.floor((max - Math.min(match!.length, max)) / 2));
	const end = Math.min(body.length, start + max);
	return `${start > 0 ? '[...] ' : ''}${body.slice(start, end)}${end < body.length ? ' [...]' : ''}`;
}

interface IFindingDraft {
	readonly checkId: string;
	readonly confidence: HttpSecurityConfidence;
	readonly severity?: HttpSecuritySeverity;
	readonly title?: string;
	readonly parameter?: string;
	/** What was seen, in a sentence: goes in front of the check's own description. */
	readonly detail: string;
	readonly match?: string;
	/** Found secrets, masked in the evidence. */
	readonly secrets?: readonly string[];
}

function buildFinding(draft: IFindingDraft, endpoint: IHttpSecurityEndpoint, exchange: IHttpSecurityExchange): IHttpSecurityFinding {
	const check = httpSecurityCheck(draft.checkId)!;
	const secrets = [...secretsOf(exchange.request), ...(draft.secrets ?? [])];
	const mask = (value: string) => maskHttpSecurityText(value, secrets);
	const response = exchange.response;
	const match = draft.match !== undefined ? mask(draft.match) : undefined;
	const fingerprint = httpSecurityFingerprint(draft.checkId, endpoint.method, endpoint.url, draft.parameter);
	const body = exchange.request.body;
	return {
		id: fingerprint,
		fingerprint,
		checkId: check.id,
		title: draft.title ?? check.title,
		severity: draft.severity ?? check.severity,
		confidence: draft.confidence,
		owasp: check.owasp,
		...(check.cwe !== undefined ? { cwe: check.cwe } : {}),
		// A caller may pass the URL as sent: its query never carries a secret into the finding.
		endpoint: { ...endpoint, url: maskHttpSecurityUrl(endpoint.url) },
		...(draft.parameter ? { parameter: draft.parameter } : {}),
		description: `${draft.detail} ${check.risk}`,
		evidence: {
			request: {
				method: exchange.request.method,
				url: excerpt(mask(maskHttpSecurityUrl(exchange.request.url)), undefined, 1000),
				headers: maskHttpSecurityHeaders(exchange.request.headers, secrets),
				...(body ? { body: excerpt(mask(body), undefined, 1000) } : {}),
			},
			response: {
				status: response?.status ?? 0,
				headers: response ? maskHttpSecurityHeaders(Object.entries(response.headers).filter(([key]) => EVIDENCE_HEADERS.test(key)).slice(0, 16), secrets) : [],
				body: response ? mask(excerpt(response.body, draft.match)) : '',
				...(exchange.error ? { error: exchange.error } : {}),
			},
			...(match ? { match } : {}),
		},
		remediation: check.remediation,
	};
}

/** One finding per fingerprint: a header missing on forty requests of a host is one finding seen forty times. */
export function dedupeHttpSecurityFindings(findings: readonly IHttpSecurityFinding[]): IHttpSecurityFinding[] {
	const out = new Map<string, IHttpSecurityFinding>();
	for (const finding of findings) {
		const known = out.get(finding.fingerprint);
		out.set(finding.fingerprint, known ? { ...known, occurrences: (known.occurrences ?? 1) + (finding.occurrences ?? 1) } : finding);
	}
	return [...out.values()];
}

/** A finding as the file keeps it: the evidence cut short. */
export function trimHttpSecurityFinding(finding: IHttpSecurityFinding, max = 400): IHttpSecurityFinding {
	const cut = (value: string) => value.length > max ? excerpt(value, finding.evidence.match, max) : value;
	const { request, response } = finding.evidence;
	return {
		...finding,
		evidence: {
			...finding.evidence,
			request: { ...request, headers: request.headers.slice(0, 20), ...(request.body !== undefined ? { body: cut(request.body) } : {}) },
			response: { ...response, headers: response.headers.slice(0, 12), body: cut(response.body) },
		},
	};
}

const SEVERITY_RANK: Readonly<Record<HttpSecuritySeverity, number>> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const CONFIDENCE_RANK: Readonly<Record<HttpSecurityConfidence, number>> = { certain: 0, firm: 1, tentative: 2 };

/** Worst first, then the surest, then by endpoint. */
export function sortHttpSecurityFindings(findings: readonly IHttpSecurityFinding[]): IHttpSecurityFinding[] {
	return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] || a.endpoint.url.localeCompare(b.endpoint.url) || a.title.localeCompare(b.title));
}

// --- SHA-256, for checking a token's HS256 signature offline --------------------------------------

const SHA_K = (() => {
	const out = new Uint32Array(64);
	let count = 0;
	for (let candidate = 2; count < 64; candidate++) {
		let prime = true;
		for (let divisor = 2; divisor * divisor <= candidate; divisor++) {
			if (candidate % divisor === 0) {
				prime = false;
				break;
			}
		}
		if (prime) {
			const root = Math.cbrt(candidate);
			out[count++] = Math.floor((root - Math.floor(root)) * 0x100000000);
		}
	}
	return out;
})();

function sha256(data: Uint8Array): Uint8Array {
	const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	const length = data.length;
	const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
	padded.set(data);
	padded[length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
	view.setUint32(padded.length - 4, (length << 3) >>> 0);
	const words = new Uint32Array(64);
	const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
	for (let offset = 0; offset < padded.length; offset += 64) {
		for (let index = 0; index < 16; index++) {
			words[index] = view.getUint32(offset + index * 4);
		}
		for (let index = 16; index < 64; index++) {
			const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
			const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
			words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = hash;
		for (let index = 0; index < 64; index++) {
			const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
			const t1 = (h + s1 + ((e & f) ^ (~e & g)) + SHA_K[index] + words[index]) >>> 0;
			const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
			const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
			h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
		}
		hash[0] += a; hash[1] += b; hash[2] += c; hash[3] += d; hash[4] += e; hash[5] += f; hash[6] += g; hash[7] += h;
	}
	const out = new Uint8Array(32);
	const outView = new DataView(out.buffer);
	hash.forEach((word, index) => outView.setUint32(index * 4, word));
	return out;
}

function utf8(value: string): Uint8Array {
	return VSBuffer.fromString(value).buffer;
}

/** HMAC-SHA256 as base64url without padding: a JWT's HS256 signature. */
export function httpSecurityHs256(secret: string, data: string): string {
	let key = utf8(secret);
	if (key.length > 64) {
		key = sha256(key);
	}
	const inner = new Uint8Array(64).fill(0x36);
	const outer = new Uint8Array(64).fill(0x5c);
	key.forEach((byte, index) => { inner[index] ^= byte; outer[index] ^= byte; });
	const message = utf8(data);
	const first = new Uint8Array(64 + message.length);
	first.set(inner);
	first.set(message, 64);
	const second = new Uint8Array(96);
	second.set(outer);
	second.set(sha256(first), 64);
	return encodeBase64(VSBuffer.wrap(sha256(second)), false, true);
}

/** A tiny list: the secrets tutorials and templates ship with. Checked offline, never sent anywhere. */
export const HTTP_SECURITY_WEAK_JWT_SECRETS: readonly string[] = ['secret', 'changeme', 'password', '123456', 'your-256-bit-secret', 'jwtsecret', 'jwt_secret', 'secretkey', 'mysecret', 'supersecret', 'test', 'key', 'admin', 'default'];

// --- Passive analyzers ------------------------------------------------------------------------------

interface IPassiveContext {
	readonly exchange: IHttpSecurityExchange;
	readonly request: IHttpSecurityRequest;
	readonly response: IHttpSecurityResponse;
	readonly url: URL | undefined;
	readonly local: boolean;
	readonly authenticated: boolean;
	readonly html: boolean;
	/** The body, as far as the patterns read it. */
	readonly body: string;
	readonly json: unknown;
	readonly now: number;
	header(name: string): string | undefined;
}

type PassiveAnalyzer = (context: IPassiveContext) => IFindingDraft[];

const MAX_SCANNED_BODY = 256 * 1024;

const STACK_TRACE: readonly RegExp[] = [
	/\bat [\w.$<>]+\([\w$]+\.(?:java|kt|scala):\d+\)/,
	/Exception in thread "[^"]*"/,
	/Traceback \(most recent call last\)/,
	/File "[^"\n]+", line \d+, in /,
	/\bat (?:async )?[\w.$<> [\]]+ \((?:\/|[A-Za-z]:\\|node:|file:)[^)\n]*:\d+:\d+\)/,
	/\b(?:Fatal error|Warning|Notice): .{1,200} in .{1,200} on line \d+/,
	/Stack trace:\s*\\?n?\s*#0 /,
	/\bat [\w.<>`]+\([^)\n]*\) in [^\n]*:line \d+/,
	/\bSystem\.[\w.]+Exception\b/,
	/\.rb:\d+:in [`']/,
	/goroutine \d+ \[running\]/,
	/Whitelabel Error Page/,
	/You're seeing this error because you have <code>DEBUG = True<\/code>|DEBUG = True/,
	/Werkzeug Debugger|werkzeug\.exceptions/,
	/Whoops, looks like something went wrong|Symfony\\Component\\|Illuminate\\/,
	/Rails\.root:|ActionController::\w+|ActiveRecord::\w+/,
];

export const HTTP_SECURITY_SQL_ERROR = /You have an error in your SQL syntax|SQLSTATE\[\w+\]|\bORA-\d{5}\b|PG::\w*Error|PSQLException|syntax error at or near "|unterminated quoted string|SQLite3?::\w*Exception|sqlite3\.OperationalError|SQLITE_ERROR|Microsoft OLE DB Provider|ODBC SQL Server Driver|Unclosed quotation mark after the character string|Incorrect syntax near '|mysql_fetch_\w+\(|MySqlException|com\.mysql\.jdbc|SequelizeDatabaseError|QueryFailedError|org\.hibernate\.exception|near "[^"\n]{0,40}": syntax error/;

const NOSQL_ERROR = /MongoServerError|MongoError|BSONTypeError|CastError: Cast to|unknown operator: \$|\$gt.{0,40}not allowed|E11000 duplicate key/;

const INTERNAL_PATH = /(?:\/home\/[\w.-]+\/|\/var\/www\/|\/usr\/local\/[\w.-]+\/|\/opt\/[\w.-]+\/|\/srv\/[\w.-]+\/|[A-Za-z]:\\\\?(?:Users|inetpub|Program Files|Windows)\\\\?)[\w./\\-]*/;
const PRIVATE_IP = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;

const BODY_SECRETS: readonly { readonly name: string; readonly pattern: RegExp; readonly severity: HttpSecuritySeverity; readonly confidence: HttpSecurityConfidence }[] = [
	{ name: 'A private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, severity: 'critical', confidence: 'certain' },
	{ name: 'An AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, severity: 'high', confidence: 'firm' },
	{ name: 'A GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, severity: 'high', confidence: 'firm' },
	{ name: 'A Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, severity: 'high', confidence: 'firm' },
	{ name: 'A Stripe live key', pattern: /\bsk_live_[0-9A-Za-z]{16,}/, severity: 'high', confidence: 'firm' },
	{ name: 'A Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: 'medium', confidence: 'firm' },
];

const TOKEN_ENDPOINT = /log-?in|sign-?in|token|auth|oauth|session|refresh|register|sign-?up/i;

/** The Luhn check card numbers pass. */
export function httpLuhnValid(digits: string): boolean {
	if (!/^\d{13,19}$/.test(digits)) {
		return false;
	}
	let sum = 0;
	for (let index = 0; index < digits.length; index++) {
		let digit = digits.charCodeAt(digits.length - 1 - index) - 48;
		if (index % 2 === 1) {
			digit *= 2;
			if (digit > 9) {
				digit -= 9;
			}
		}
		sum += digit;
	}
	return sum % 10 === 0;
}

function walkJson(value: unknown, visit: (key: string, value: unknown, path: string) => void, path = '', depth = 0, budget = { left: 4000 }): void {
	if (depth > 8 || budget.left <= 0) {
		return;
	}
	if (Array.isArray(value)) {
		// The first few items say what the rest hold.
		value.slice(0, 5).forEach(item => walkJson(item, visit, `${path}[]`, depth + 1, budget));
	} else if (isRecord(value)) {
		for (const [key, child] of Object.entries(value)) {
			budget.left--;
			const childPath = path ? `${path}.${key}` : key;
			visit(key, child, childPath);
			walkJson(child, visit, childPath, depth + 1, budget);
		}
	}
}

interface IJwt {
	readonly token: string;
	readonly header: Record<string, unknown>;
	readonly payload: Record<string, unknown>;
}

function decodeJwt(token: string): IJwt | undefined {
	const parts = token.split('.');
	if (parts.length !== 3) {
		return undefined;
	}
	try {
		const header: unknown = JSON.parse(decodeBase64(parts[0]).toString());
		const payload: unknown = JSON.parse(decodeBase64(parts[1]).toString());
		return isRecord(header) && isRecord(payload) ? { token, header, payload } : undefined;
	} catch {
		return undefined;
	}
}

/** The JWT a request authenticates with: the bearer token, else one in a cookie or the query. */
function requestJwt(request: IHttpSecurityRequest): IJwt | undefined {
	const candidates: string[] = [];
	const bearer = /^Bearer\s+(\S+)/i.exec(requestHeader(request, 'authorization') ?? '');
	if (bearer) {
		candidates.push(bearer[1]);
	}
	for (const part of (requestHeader(request, 'cookie') ?? '').split(/;\s*/)) {
		candidates.push(part.slice(part.indexOf('=') + 1));
	}
	for (const [, value] of httpSecurityUrl(request.url)?.searchParams ?? []) {
		candidates.push(value);
	}
	for (const candidate of candidates) {
		const jwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(candidate) ? decodeJwt(candidate) : undefined;
		if (jwt) {
			return jwt;
		}
	}
	return undefined;
}

const RATE_LIMIT_HEADER = /^(?:x-)?rate-?limit|^retry-after$/i;

function hasRateLimitHeaders(response: IHttpSecurityResponse): boolean {
	return Object.keys(response.headers).some(key => RATE_LIMIT_HEADER.test(key));
}

const PASSIVE_ANALYZERS: Readonly<Record<string, PassiveAnalyzer>> = {
	'transport.plainHttp': ({ url, local }) => url && url.protocol === 'http:' && !local
		? [{ checkId: 'transport.plainHttp', confidence: 'certain', detail: `${url.host} is called over plain HTTP.` }] : [],

	'transport.secretInUrl': ({ url }) => {
		if (!url) {
			return [];
		}
		const out: IFindingDraft[] = [];
		if (url.password) {
			out.push({ checkId: 'transport.secretInUrl', confidence: 'certain', parameter: 'userinfo', detail: 'The URL carries a user name and password (user:password@host).', secrets: [url.password] });
		}
		for (const [key, value] of url.searchParams) {
			if (value && (SECRET_PARAM.test(key) || JWT.test(value))) {
				out.push({ checkId: 'transport.secretInUrl', confidence: /passw|pwd|secret/i.test(key) || JWT.test(value) ? 'certain' : 'firm', parameter: key, detail: `The query parameter "${key}" carries a credential.`, match: `${key}=${value}`, secrets: [value] });
			}
		}
		return out;
	},

	'headers.hsts': ({ url, local, header }) => url && url.protocol === 'https:' && !local && !header('strict-transport-security')
		? [{ checkId: 'headers.hsts', confidence: 'certain', detail: `${url.host} answers over HTTPS without Strict-Transport-Security.` }] : [],

	'headers.contentTypeOptions': ({ response, header }) => response.body && !/nosniff/i.test(header('x-content-type-options') ?? '')
		? [{ checkId: 'headers.contentTypeOptions', confidence: 'certain', detail: 'The response has no X-Content-Type-Options: nosniff header.' }] : [],

	'headers.cacheControl': ({ request, response, authenticated, header }) => {
		const cache = header('cache-control') ?? '';
		if (!authenticated || !is2xx(response) || !response.body.trim() || !/^(?:GET|HEAD)$/i.test(request.method) || /no-store|private|no-cache/i.test(cache)) {
			return [];
		}
		return [{ checkId: 'headers.cacheControl', confidence: 'firm', detail: cache ? `The authenticated response is sent with Cache-Control: ${cache}.` : 'The authenticated response has no Cache-Control header.', ...(cache ? { match: cache } : {}) }];
	},

	'headers.htmlFraming': ({ html, response, header }) => {
		if (!html || !response.body.trim()) {
			return [];
		}
		const csp = header('content-security-policy');
		const framed = !!header('x-frame-options') || /frame-ancestors/i.test(csp ?? '');
		if (csp && framed) {
			return [];
		}
		return [{ checkId: 'headers.htmlFraming', confidence: 'firm', detail: !csp && !framed ? 'The HTML answer has neither a Content-Security-Policy nor X-Frame-Options.' : !csp ? 'The HTML answer has no Content-Security-Policy.' : 'The HTML answer can be framed: no X-Frame-Options and no frame-ancestors in its Content-Security-Policy.' }];
	},

	'cors.wildcardCredentials': ({ header }) => {
		const origin = (header('access-control-allow-origin') ?? '').trim();
		return (origin === '*' || origin === 'null') && /^true$/i.test((header('access-control-allow-credentials') ?? '').trim())
			? [{ checkId: 'cors.wildcardCredentials', confidence: 'certain', detail: `The response sends Access-Control-Allow-Origin: ${origin} with Access-Control-Allow-Credentials: true.`, match: origin }] : [];
	},

	'cors.wildcardAuthenticated': ({ header, authenticated, response }) => authenticated && is2xx(response) && (header('access-control-allow-origin') ?? '').trim() === '*' && !/^true$/i.test((header('access-control-allow-credentials') ?? '').trim())
		? [{ checkId: 'cors.wildcardAuthenticated', confidence: 'firm', detail: 'The request carries credentials and the answer allows every origin (Access-Control-Allow-Origin: *).', match: '*' }] : [],

	'cookies.flags': ({ header, url, local }) => {
		const out: IFindingDraft[] = [];
		for (const cookie of splitSetCookie(header('set-cookie') ?? '')) {
			const [pair, ...attributes] = cookie.split(/;\s*/);
			const name = pair.slice(0, Math.max(0, pair.indexOf('='))).trim();
			if (!name) {
				continue;
			}
			const has = (attribute: string) => attributes.some(item => item.toLowerCase().startsWith(attribute));
			const session = /sess|sid|auth|token|jwt|login/i.test(name);
			const missing = [
				...(!has('secure') && !(local && url?.protocol === 'http:') ? ['Secure'] : []),
				// A CSRF token cookie is meant to be read by the page's script.
				...(!has('httponly') && !/xsrf|csrf/i.test(name) ? ['HttpOnly'] : []),
				...(!has('samesite') ? ['SameSite'] : []),
			];
			if (missing.length) {
				out.push({ checkId: 'cookies.flags', confidence: 'certain', severity: session && missing.some(flag => flag !== 'SameSite') ? 'medium' : 'low', parameter: name, title: `Cookie "${name}" without ${missing.join(', ')}`, detail: `The cookie "${name}" is set without ${missing.join(', ')}.`, match: `${name}=` });
			}
		}
		return out;
	},

	'disclosure.serverVersion': ({ header }) => {
		const found: string[] = [];
		const server = header('server');
		if (server && /\d+\.\d+/.test(server)) {
			found.push(`Server: ${server}`);
		}
		for (const name of ['x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version']) {
			const value = header(name);
			if (value) {
				found.push(`${name}: ${value}`);
			}
		}
		return found.length ? [{ checkId: 'disclosure.serverVersion', confidence: 'certain', detail: `The response names its software: ${found.join('; ')}.`, match: found[0].slice(found[0].indexOf(':') + 2) }] : [];
	},

	'disclosure.stackTrace': ({ body }) => {
		for (const pattern of STACK_TRACE) {
			const match = pattern.exec(body);
			if (match) {
				return [{ checkId: 'disclosure.stackTrace', confidence: 'firm', detail: 'The body holds a stack trace or a framework debug page.', match: match[0] }];
			}
		}
		return [];
	},

	'disclosure.sqlError': ({ body }) => {
		const match = HTTP_SECURITY_SQL_ERROR.exec(body);
		return match ? [{ checkId: 'disclosure.sqlError', confidence: 'firm', detail: 'The body holds a database error message.', match: match[0] }] : [];
	},

	'disclosure.internalAddress': ({ body, response, url }) => {
		const headers = Object.entries(response.headers).filter(([key]) => !/^(?:date|content-length|etag)$/i.test(key)).map(([key, value]) => `${key}: ${value}`).join('\n');
		for (const source of [headers, body]) {
			const ip = PRIVATE_IP.exec(source);
			if (ip && ip[0] !== url?.hostname) {
				return [{ checkId: 'disclosure.internalAddress', confidence: 'firm', detail: `The response names the private address ${ip[0]}.`, match: ip[0] }];
			}
		}
		const path = INTERNAL_PATH.exec(body);
		return path ? [{ checkId: 'disclosure.internalAddress', confidence: 'tentative', detail: 'The response names a file path on the server.', match: path[0] }] : [];
	},

	'disclosure.secrets': ({ body, url, response }) => {
		const out: IFindingDraft[] = [];
		for (const secret of BODY_SECRETS) {
			const match = secret.pattern.exec(body);
			if (match) {
				out.push({ checkId: 'disclosure.secrets', confidence: secret.confidence, severity: secret.severity, parameter: secret.name, title: `${secret.name} in the response`, detail: `${secret.name} is in the response body.`, match: match[0], secrets: [match[0]] });
			}
		}
		// A sign-in answers with a token: that is its job.
		const jwt = JWT.exec(body);
		if (jwt && is2xx(response) && !TOKEN_ENDPOINT.test(url?.pathname ?? '')) {
			out.push({ checkId: 'disclosure.secrets', confidence: 'tentative', severity: 'low', parameter: 'A JSON Web Token', title: 'A JSON Web Token in the response', detail: 'A JSON Web Token is in the body of an endpoint that does not look like a sign-in.', match: jwt[0], secrets: [jwt[0]] });
		}
		return out;
	},

	'disclosure.verboseError': ({ response, body, json }) => {
		if (response.status < 400 || STACK_TRACE.some(pattern => pattern.test(body))) {
			return [];
		}
		let field: string | undefined;
		walkJson(json, (key, value) => {
			if (!field && /^(?:stack|stack_?trace|trace|traceback|exception|debug|inner_?exception|sql|query)$/i.test(key) && value !== null && value !== '' && value !== false) {
				field = key;
			}
		});
		if (field) {
			return [{ checkId: 'disclosure.verboseError', confidence: 'firm', parameter: field, detail: `The error answer carries a "${field}" field.`, match: `"${field}"` }];
		}
		const named = /\b[A-Z][A-Za-z]+(?:Exception|Error): [^\n"]{4,}/.exec(body);
		return named && response.status >= 500 ? [{ checkId: 'disclosure.verboseError', confidence: 'tentative', detail: 'The error answer names the exception that was thrown.', match: named[0] }] : [];
	},

	'data.sensitiveFields': ({ json, response }) => {
		if (json === undefined || !is2xx(response)) {
			return [];
		}
		const out = new Map<string, IFindingDraft>();
		walkJson(json, (key, value, path) => {
			if (out.size >= 6 || value === null || value === '' || typeof value === 'boolean' || isRecord(value) || Array.isArray(value)) {
				return;
			}
			const name = key.replace(/[_-]/g, '').toLowerCase();
			const asText = String(value);
			if (/^\*+$|^x+$|^\[?(?:redacted|hidden|masked)\]?$/i.test(asText)) {
				return;
			}
			const digits = asText.replace(/[ -]/g, '');
			const cardKey = /card|pan$|ccnum|creditcard|cardnumber/.test(name);
			if (httpLuhnValid(digits) && (cardKey || (typeof value === 'string' && /^\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,3})?$/.test(asText)))) {
				out.set(`card:${name}`, { checkId: 'data.sensitiveFields', confidence: cardKey ? 'firm' : 'tentative', severity: 'high', parameter: path, title: 'Card number in the response', detail: `The field "${path}" holds a number that passes the card number (Luhn) check.`, match: asText, secrets: [asText] });
			} else if (/^(?:password|passwd|pwd|userpassword|passwordhash|hashedpassword|pwhash|pwdhash|passhash|salt|passwordsalt|ssn|socialsecuritynumber|socialsecurity|cvv|cvc|cvv2|pin|secretanswer|mfasecret|otpsecret|totpsecret)$/.test(name)
				|| (name === 'hash' && /^\$(?:2[aby]|argon2|scrypt|pbkdf2)|^pbkdf2[_:$]/.test(asText))) {
				out.set(name, { checkId: 'data.sensitiveFields', confidence: 'firm', parameter: path, title: `Sensitive field "${key}" in the response`, detail: `The response returns the field "${path}".`, match: `"${key}"`, secrets: [asText] });
			}
		});
		return [...out.values()];
	},

	'data.excessive': ({ json, request, response, header, url }) => {
		if (!is2xx(response) || json === undefined) {
			return [];
		}
		const wrapper = isRecord(json) ? json : undefined;
		const list = Array.isArray(json) ? json : wrapper ? Object.values(wrapper).filter(Array.isArray).sort((a, b) => b.length - a.length)[0] : undefined;
		if (!list || list.length < 100) {
			return [];
		}
		const paging = /^(?:page|per_?page|page_?size|limit|offset|cursor|after|before|skip|take|top|size|count|start|next_?token|page_?token)$/i;
		const paged = !!header('link') || !!header('x-total-count') || !!header('x-next-page')
			|| [...(url?.searchParams.keys() ?? [])].some(key => paging.test(key.replace(/^\$/, '')))
			|| (wrapper ? Object.keys(wrapper).some(key => /^(?:next|next_?(?:page|cursor|token|url)|cursor|total|total_?(?:count|pages)|page|pagination|paging|meta|links|has_?more|offset|limit)$/i.test(key)) : false)
			|| /"(?:limit|first|after|offset)"/.test(request.body ?? '');
		return paged ? [] : [{ checkId: 'data.excessive', confidence: 'tentative', detail: `The answer is a list of ${list.length} items and nothing in the request or response pages it.` }];
	},

	'auth.jwt': ({ request, now }) => {
		const jwt = requestJwt(request);
		if (!jwt) {
			return [];
		}
		const out: IFindingDraft[] = [];
		const alg = text(jwt.header.alg);
		const secrets = [jwt.token];
		if (/^none$/i.test(alg)) {
			out.push({ checkId: 'auth.jwt', confidence: 'certain', severity: 'critical', parameter: 'alg', title: 'Token is not signed (alg: none)', detail: 'The request\'s token says "alg": "none": it carries no signature, so anyone can write one.', match: `"alg":"${alg}"`, secrets });
		}
		const exp = typeof jwt.payload.exp === 'number' ? jwt.payload.exp : undefined;
		const iat = typeof jwt.payload.iat === 'number' ? jwt.payload.iat : undefined;
		if (exp === undefined) {
			out.push({ checkId: 'auth.jwt', confidence: 'certain', severity: 'medium', parameter: 'exp', title: 'Token never expires', detail: 'The request\'s token has no "exp" claim, so a stolen copy works forever.', secrets });
		} else {
			const days = (exp - (iat ?? now / 1000)) / 86_400;
			if (days > 30) {
				out.push({ checkId: 'auth.jwt', confidence: 'firm', severity: 'low', parameter: 'exp', title: 'Token lives very long', detail: `The request's token is valid for about ${Math.round(days)} days.`, secrets });
			}
		}
		if (alg === 'HS256') {
			const signed = jwt.token.slice(0, jwt.token.lastIndexOf('.'));
			const signature = jwt.token.slice(jwt.token.lastIndexOf('.') + 1).replace(/=+$/, '');
			const weak = signature ? HTTP_SECURITY_WEAK_JWT_SECRETS.find(secret => httpSecurityHs256(secret, signed) === signature) : undefined;
			if (weak !== undefined) {
				out.push({ checkId: 'auth.jwt', confidence: 'certain', severity: 'critical', parameter: 'secret', title: 'Token is signed with a guessable secret', detail: `The request's HS256 token verifies with the secret "${weak}", so anyone can forge tokens.`, secrets });
			}
		}
		return out;
	},

	'limits.rateLimitHeaders': ({ response }) => is2xx(response) && !hasRateLimitHeaders(response)
		? [{ checkId: 'limits.rateLimitHeaders', confidence: 'tentative', detail: 'The response has no RateLimit, X-RateLimit or Retry-After header.' }] : [],
};

export interface IHttpSecurityAnalyzeOptions {
	/** Which checks run; every passive check when absent. */
	readonly enabled?: (checkId: string) => boolean;
	/** The time token lifetimes are measured from (ms); now when absent. */
	readonly now?: number;
}

/** The passive checks on one exchange: what the response the request gets anyway already shows. */
export function analyzeHttpSecurityExchange(exchange: IHttpSecurityExchange, endpoint: IHttpSecurityEndpoint, options: IHttpSecurityAnalyzeOptions = {}): IHttpSecurityFinding[] {
	const response = exchange.response;
	if (!response) {
		return [];
	}
	const url = httpSecurityUrl(exchange.request.url);
	const body = response.body.length > MAX_SCANNED_BODY ? response.body.slice(0, MAX_SCANNED_BODY) : response.body;
	const context: IPassiveContext = {
		exchange,
		request: exchange.request,
		response,
		url,
		local: !!url && isLocalHost(url.hostname),
		authenticated: isHttpSecurityRequestAuthenticated(exchange.request),
		html: isHtml(response),
		body,
		json: jsonOf(response.body),
		now: options.now ?? Date.now(),
		header: name => responseHeader(response, name),
	};
	const out: IHttpSecurityFinding[] = [];
	for (const check of HTTP_SECURITY_CHECKS) {
		const analyzer = PASSIVE_ANALYZERS[check.id];
		if (!analyzer || (options.enabled && !options.enabled(check.id))) {
			continue;
		}
		for (const draft of analyzer(context)) {
			out.push(buildFinding(draft, endpoint, exchange));
		}
	}
	return dedupeHttpSecurityFindings(out);
}

// --- Active probes ----------------------------------------------------------------------------------

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS', 'TRACE'];
const UNSAFE_METHODS = ['POST', 'PUT', 'PATCH'];

/**
 * Whether a probe may go out with `method`: safe methods always, POST, PUT and PATCH only when
 * the user turned data-changing tests on, DELETE (and anything else) never.
 */
export function isHttpSecurityMethodAllowed(method: string, includeUnsafeMethods: boolean): boolean {
	const upper = method.toUpperCase();
	return SAFE_METHODS.includes(upper) || (includeUnsafeMethods && UNSAFE_METHODS.includes(upper));
}

export interface IHttpSecurityProbe {
	readonly id: string;
	readonly checkId: string;
	/** What is sent, for the progress line and the finding. */
	readonly label: string;
	readonly parameter?: string;
	/** One request, a pair to compare, or a burst. */
	readonly requests: readonly IHttpSecurityRequest[];
	/** Sent without the pause between requests (the rate limit check: at most `HTTP_SECURITY_BURST`). */
	readonly burst?: boolean;
	/** A request holds literal `{{ }}`: it must go out as it is, not through a sender that fills in variables. */
	readonly literal?: boolean;
	/** Judges the answers (one per request, in order) against the baseline: a finding, or nothing. */
	evaluate(answers: readonly IHttpSecurityExchange[]): IHttpSecurityFinding | undefined;
}

export interface IHttpSecurityPlanOptions {
	readonly enabled?: (checkId: string) => boolean;
	readonly includeUnsafeMethods: boolean;
	/** The most requests the probes of one endpoint may add up to. */
	readonly maxProbesPerRequest: number;
	/** The methods the collection uses on this path. */
	readonly knownMethods?: readonly string[];
	/** Leave out the host-wide probes (downgrade, burst): another request of the host has them. */
	readonly skipHostWide?: boolean;
}

interface IParameter {
	readonly kind: 'query' | 'json' | 'form';
	readonly name: string;
	readonly value: string;
	/** A JSON field's path. */
	readonly path?: readonly (string | number)[];
}

const MAX_PARAMETERS = 8;

function isForm(request: IHttpSecurityRequest): boolean {
	return /application\/x-www-form-urlencoded/i.test(requestHeader(request, 'content-type') ?? '');
}

function parametersOf(request: IHttpSecurityRequest): IParameter[] {
	const out: IParameter[] = [];
	const url = httpSecurityUrl(request.url);
	for (const [name, value] of url?.searchParams ?? []) {
		if (!SECRET_PARAM.test(name) && !out.some(known => known.name === name)) {
			out.push({ kind: 'query', name, value });
		}
	}
	const body = request.body;
	if (body && isForm(request)) {
		for (const [name, value] of new URLSearchParams(body)) {
			out.push({ kind: 'form', name, value });
		}
	} else if (body) {
		const json = jsonOf(body);
		const walk = (value: unknown, path: readonly (string | number)[], depth: number) => {
			if (depth > 4 || out.length >= MAX_PARAMETERS * 2) {
				return;
			}
			if (typeof value === 'string' && path.length) {
				out.push({ kind: 'json', name: path.join('.'), value, path });
			} else if (Array.isArray(value)) {
				if (value.length) {
					walk(value[0], [...path, 0], depth + 1);
				}
			} else if (isRecord(value)) {
				for (const [key, child] of Object.entries(value)) {
					walk(child, [...path, key], depth + 1);
				}
			}
		};
		walk(json, [], 0);
	}
	return out.slice(0, MAX_PARAMETERS);
}

/** The request with one parameter set to `value` (a JSON field may become an object). `rename` changes a query or form key. */
function withParameter(request: IHttpSecurityRequest, parameter: IParameter, value: unknown, rename?: string): IHttpSecurityRequest {
	const asText = typeof value === 'string' ? value : JSON.stringify(value);
	const setIn = (params: URLSearchParams) => {
		if (rename) {
			params.delete(parameter.name);
			params.append(rename, asText);
		} else {
			params.set(parameter.name, asText);
		}
	};
	if (parameter.kind === 'query') {
		const url = httpSecurityUrl(request.url);
		if (!url) {
			return request;
		}
		setIn(url.searchParams);
		return { ...request, url: url.toString() };
	}
	if (parameter.kind === 'form') {
		const params = new URLSearchParams(request.body ?? '');
		setIn(params);
		return { ...request, body: params.toString() };
	}
	const json: unknown = JSON.parse(request.body ?? 'null');
	let at: unknown = json;
	const path = parameter.path ?? [];
	for (let index = 0; index < path.length - 1; index++) {
		at = Array.isArray(at) ? at[Number(path[index])] : isRecord(at) ? at[path[index]] : undefined;
	}
	const last = path[path.length - 1];
	if (Array.isArray(at) && typeof last === 'number') {
		at[last] = value;
	} else if (isRecord(at)) {
		at[String(last)] = value;
	}
	return { ...request, body: JSON.stringify(json) };
}

const kindLabel = (parameter: IParameter) => parameter.kind === 'query' ? 'query parameter' : parameter.kind === 'form' ? 'form field' : 'JSON field';

/** The first id in the URL's path (the last numeric or UUID segment) and in its query. */
function idsOf(url: URL): { readonly where: 'path' | 'query'; readonly name: string; readonly value: string; readonly next: string; readonly index?: number }[] {
	const out: { where: 'path' | 'query'; name: string; value: string; next: string; index?: number }[] = [];
	const neighbour = (value: string): string | undefined => {
		if (/^\d{1,15}$/.test(value)) {
			const number = Number(value);
			return String(number > 1 ? number - 1 : number + 1);
		}
		if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
			const last = parseInt(value.slice(-1), 16);
			return `${value.slice(0, -1)}${((last + 1) % 16).toString(16)}`;
		}
		return undefined;
	};
	const segments = url.pathname.split('/');
	for (let index = segments.length - 1; index > 0; index--) {
		const next = neighbour(segments[index]);
		// `/2/` first or after `/api/` is a version, not an id (`/v1/` is not numeric anyway); `/users/7` is an id.
		const version = /^\d$/.test(segments[index]) && (index === 1 || /^(?:api|apis|rest|version)$/i.test(segments[index - 1]));
		if (next && !version) {
			out.push({ where: 'path', name: segments[index - 1] || 'id', value: segments[index], next, index });
			break;
		}
	}
	for (const [name, value] of url.searchParams) {
		const next = /(?:^|_|-)id$|Id$|^uuid$|^guid$/.test(name) ? neighbour(value) : undefined;
		if (next) {
			out.push({ where: 'query', name, value, next });
			break;
		}
	}
	return out;
}

const TEMPLATE_PAYLOAD = 'volt${7*7}a#{7*7}b<%= 7*7 %>c';
const TEMPLATE_HIT = /volt49a|a49b|b49c|volt49d/;
const XSS_PAYLOAD = '<volt-xss-probe>';
const COMMAND_PAYLOAD = ';echo volt$((6*7))cmd';
const TRAVERSAL: readonly { readonly payload: string; readonly signature: RegExp }[] = [
	{ payload: '../../../../etc/passwd', signature: /root:[x*]?:0:0:/ },
	{ payload: '..\\..\\..\\..\\windows\\win.ini', signature: /\[(?:fonts|extensions|mci extensions|files)\]/i },
];
const FILE_PARAMETER = /file|path|doc|template|page|dir|folder|download|include|load|name|src|resource|attachment/i;
const URL_PARAMETER = /url|uri|redirect|return|next|callback|continue|dest|target|goto|link|forward|back|location/i;

/**
 * The active probes for one endpoint, from its baseline (the request as it went out and its
 * answer): a bounded list of changed requests, each with the judge of its answers. Nothing here
 * is destructive or time based; unsafe methods are planned only with `includeUnsafeMethods` and
 * DELETE never is.
 */
export function planHttpSecurityProbes(baseline: IHttpSecurityExchange, endpoint: IHttpSecurityEndpoint, options: IHttpSecurityPlanOptions): IHttpSecurityProbe[] {
	const base = baseline.request;
	const answer = baseline.response;
	const url = httpSecurityUrl(base.url);
	if (!answer || !url) {
		return [];
	}
	const method = base.method.toUpperCase();
	const on = (id: string) => options.enabled?.(id) ?? true;
	const replay = isHttpSecurityMethodAllowed(method, options.includeUnsafeMethods);
	const safe = method === 'GET' || method === 'HEAD';
	const authenticated = isHttpSecurityRequestAuthenticated(base);
	const local = isLocalHost(url.hostname);
	const out: IHttpSecurityProbe[] = [];

	type Judge = (answers: readonly IHttpSecurityExchange[]) => (Omit<IFindingDraft, 'checkId'> & { readonly answer?: number }) | undefined;
	const add = (checkId: string, label: string, requests: readonly IHttpSecurityRequest[], judge: Judge, extra: { parameter?: string; burst?: boolean; literal?: boolean } = {}) => {
		if (!on(checkId) || !requests.length) {
			return;
		}
		out.push({
			id: `${checkId}#${out.length}`,
			checkId,
			label,
			requests,
			...(extra.parameter ? { parameter: extra.parameter } : {}),
			...(extra.burst ? { burst: true } : {}),
			...(extra.literal ? { literal: true } : {}),
			evaluate: answers => {
				if (answers.length < requests.length) {
					return undefined;
				}
				const draft = judge(answers);
				if (!draft) {
					return undefined;
				}
				const { answer: index, ...rest } = draft;
				return buildFinding({ checkId, ...(extra.parameter ? { parameter: extra.parameter } : {}), ...rest }, endpoint, answers[index ?? 0]);
			},
		});
	};
	/** The pattern's match in the probe's answer, when the baseline's answer does not have it too. */
	const fresh = (pattern: RegExp, probe: IHttpSecurityExchange): string | undefined => {
		const found = probe.response ? pattern.exec(probe.response.body) : null;
		return found && !pattern.test(answer.body) ? found[0] : undefined;
	};

	// Authentication: the same call without credentials, then with a token that cannot be valid.
	if (authenticated && replay && is2xx(answer)) {
		const stillAnswers = (probe: IHttpSecurityExchange) => is2xx(probe.response) && sameShape(probe.response, answer) && (answer.body.trim() !== '' || probe.response.status === answer.status);
		add('auth.missing', 'Without credentials', [withoutCredentials(base)], ([probe]) => stillAnswers(probe)
			? { confidence: answer.body.trim() && probe.response?.body === answer.body ? 'certain' : 'firm', detail: `Without its credentials the request still answers ${probe.response!.status} with the same kind of body.` } : undefined);
		const authorization = requestHeader(base, 'authorization');
		if (authorization) {
			const scheme = /^(\S+)\s/.exec(authorization)?.[1] ?? 'Bearer';
			const invalid = /^basic$/i.test(scheme) ? 'Basic dm9sdC1wcm9iZTppbnZhbGlk' : `${scheme} volt-invalid-token`;
			add('auth.malformedToken', 'With an invalid token', [withHeaders(base, { Authorization: invalid })], ([probe]) => stillAnswers(probe)
				? { confidence: 'firm', detail: `With the token replaced by "volt-invalid-token" the request still answers ${probe.response!.status} with the same kind of body.`, match: 'volt-invalid-token' } : undefined);
		}
	}

	// Authorization: a neighbouring object. Only a hint: whose object the neighbour is, the scan cannot know.
	if (authenticated && safe && is2xx(answer)) {
		for (const id of idsOf(url)) {
			const changed = new URL(url.toString());
			if (id.where === 'path') {
				const segments = changed.pathname.split('/');
				segments[id.index!] = id.next;
				changed.pathname = segments.join('/');
			} else {
				changed.searchParams.set(id.name, id.next);
			}
			add('access.bola', `Id ${id.value} changed to ${id.next}`, [{ ...base, url: changed.toString() }], ([probe]) => is2xx(probe.response) && probe.response.body.trim() !== '' && probe.response.body !== answer.body && sameShape(probe.response, answer)
				? { confidence: 'tentative', detail: `With the id ${id.value} changed to ${id.next} the same credentials get a different object back. Review whether this caller may see it.`, match: id.next } : undefined, { parameter: id.where === 'path' ? `path: ${id.name}` : id.name });
		}
	}

	// Methods.
	const marker = 'volt-trace-probe';
	add('methods.trace', 'TRACE', [{ method: 'TRACE', url: base.url, headers: [...withoutCredentials(base).headers.filter(([key]) => !/^content-/i.test(key)), ['X-Volt-Probe', marker]] }], ([probe]) => is2xx(probe.response) && probe.response.body.includes(marker)
		? { confidence: 'certain', detail: 'The server answers TRACE and echoes the request\'s headers back.', match: marker } : undefined);
	const known = new Set((options.knownMethods ?? [method]).map(item => item.toUpperCase()));
	add('methods.options', 'OPTIONS', [{ method: 'OPTIONS', url: base.url, headers: base.headers.filter(([key]) => !/^content-/i.test(key)) }], ([probe]) => {
		const allow = responseHeader(probe.response, 'allow') ?? responseHeader(probe.response, 'access-control-allow-methods');
		if (!allow) {
			return undefined;
		}
		const extra = allow.split(',').map(item => item.trim().toUpperCase()).filter(item => item === '*' || item === 'TRACE' || item === 'CONNECT' || (['PUT', 'PATCH', 'DELETE'].includes(item) && !known.has(item)));
		return extra.length ? { confidence: 'tentative', severity: extra.includes('TRACE') || extra.includes('*') ? 'low' : 'info', detail: `OPTIONS advertises ${extra.join(', ')}, which the collection does not use on this path.`, match: allow } : undefined;
	});
	if (options.includeUnsafeMethods) {
		const unused = UNSAFE_METHODS.slice().reverse().find(item => !known.has(item));
		if (unused && safe) {
			add('methods.unexpectedVerb', `${unused} with no body`, [{ method: unused, url: base.url, headers: base.headers.filter(([key]) => !/^content-/i.test(key)) }], ([probe]) => is2xx(probe.response)
				? { confidence: 'tentative', detail: `${unused}, which the collection does not use on this path, answers ${probe.response.status}.` } : undefined);
		}
	}
	if (method === 'GET' && is2xx(answer) && answer.body.trim()) {
		add('methods.override', 'GET with X-HTTP-Method-Override: HEAD', [withHeaders(base, { 'X-HTTP-Method-Override': 'HEAD', 'X-HTTP-Method': 'HEAD', 'X-Method-Override': 'HEAD' })], ([probe]) => is2xx(probe.response) && probe.response.body === ''
			? { confidence: 'firm', detail: 'A GET with X-HTTP-Method-Override: HEAD comes back with an empty body: the server switched method on the header.', match: 'X-HTTP-Method-Override' } : undefined);
	}

	// CORS: an origin nobody listed.
	const corsRequest: IHttpSecurityRequest = safe
		? withHeaders(base, { Origin: HTTP_SECURITY_SCAN_ORIGIN })
		: { method: 'OPTIONS', url: base.url, headers: [['Origin', HTTP_SECURITY_SCAN_ORIGIN], ['Access-Control-Request-Method', method], ['Access-Control-Request-Headers', 'authorization, content-type']] };
	add('cors.reflectedOrigin', `Origin: ${HTTP_SECURITY_SCAN_ORIGIN}`, [corsRequest], ([probe]) => {
		if ((responseHeader(probe.response, 'access-control-allow-origin') ?? '').trim() !== HTTP_SECURITY_SCAN_ORIGIN) {
			return undefined;
		}
		const credentials = /^true$/i.test((responseHeader(probe.response, 'access-control-allow-credentials') ?? '').trim());
		return credentials
			? { confidence: 'certain', detail: 'An unknown origin is echoed back in Access-Control-Allow-Origin with Access-Control-Allow-Credentials: true.', match: HTTP_SECURITY_SCAN_ORIGIN }
			: { confidence: 'firm', severity: authenticated ? 'medium' : 'low', title: 'CORS reflects any origin (without credentials)', detail: 'An unknown origin is echoed back in Access-Control-Allow-Origin.', match: HTTP_SECURITY_SCAN_ORIGIN };
	});

	// Each parameter, one at a time.
	const parameters = replay ? parametersOf(base) : [];
	const fileLike = parameters.filter(parameter => FILE_PARAMETER.test(parameter.name) || /\.\w{2,4}$|\//.test(parameter.value));
	const urlLike = parameters.filter(parameter => URL_PARAMETER.test(parameter.name) || /^(?:https?:)?\/\//i.test(parameter.value) || parameter.value.startsWith('/'));
	for (const parameter of parameters) {
		const what = `${kindLabel(parameter)} "${parameter.name}"`;
		const extra = { parameter: parameter.name };

		add('injection.sql', `${what} with a single quote`, [withParameter(base, parameter, `${parameter.value}'`)], ([probe]) => {
			const error = fresh(HTTP_SECURITY_SQL_ERROR, probe);
			if (error) {
				return { confidence: 'firm', detail: `A single quote in the ${what} brings back a database error.`, match: error };
			}
			return probe.response && probe.response.status >= 500 && answer.status < 500
				? { confidence: 'tentative', severity: 'medium', title: 'Server error on a single quote', detail: `A single quote in the ${what} turns the answer into a ${probe.response.status}. It may reach a query unescaped.` } : undefined;
		}, extra);
		if (is2xx(answer)) {
			add('injection.sql', `${what} with a true and a false condition`, [withParameter(base, parameter, `${parameter.value}' OR '1'='1`), withParameter(base, parameter, `${parameter.value}' AND '1'='2`)], ([truthy, falsy]) => {
				if (!truthy.response || !falsy.response || !is2xx(truthy.response)) {
					return undefined;
				}
				const more = (listLength(truthy.response.body) ?? 0) > (listLength(answer.body) ?? 0);
				// The true condition changes nothing (or matches more), the false one does: the text was read as SQL.
				return (similar(truthy.response, answer) || more) && !similar(falsy.response, answer) && !similar(falsy.response, truthy.response)
					? { confidence: 'tentative', detail: `The ${what} answers like the original with ' OR '1'='1 added and differently with ' AND '1'='2: the condition seems to be evaluated.`, match: `' OR '1'='1` } : undefined;
			}, extra);
		}

		if (is2xx(answer)) {
			const control = 'volt-nosql-control';
			const operator = parameter.kind === 'json' ? withParameter(base, parameter, { $gt: '' }) : withParameter(base, parameter, '', `${parameter.name}[$gt]`);
			add('injection.nosql', `${what} as {"$gt":""}`, [withParameter(base, parameter, control), operator], ([plain, probe]) => {
				const error = fresh(NOSQL_ERROR, probe);
				if (error) {
					return { confidence: 'firm', answer: 1, detail: `An operator object in the ${what} brings back a database error.`, match: error };
				}
				// The value matters (a made-up one changes the answer) and the operator matches like a real one.
				return plain.response && is2xx(probe.response) && !similar(plain.response, answer) && !similar(probe.response, plain.response) && (similar(probe.response, answer) || (listLength(probe.response.body) ?? 0) > (listLength(answer.body) ?? 0))
					? { confidence: 'tentative', answer: 1, detail: `With the ${what} replaced by {"$gt":""} the answer matches like a real value, while a made-up value does not.`, match: '$gt' } : undefined;
			}, extra);
		}

		add('injection.template', `${what} with template expressions`, [withParameter(base, parameter, TEMPLATE_PAYLOAD)], ([probe]) => {
			const hit = fresh(TEMPLATE_HIT, probe);
			return hit ? { confidence: 'certain', detail: `A template expression in the ${what} comes back worked out (7*7 as 49).`, match: hit } : undefined;
		}, extra);
		add('injection.template', `${what} with {{7*7}}`, [withParameter(base, parameter, 'volt{{7*7}}d')], ([probe]) => {
			const hit = fresh(TEMPLATE_HIT, probe);
			return hit ? { confidence: 'certain', detail: `The template expression {{7*7}} in the ${what} comes back worked out as 49.`, match: hit } : undefined;
		}, { ...extra, literal: true });

		add('injection.xss', `${what} with ${XSS_PAYLOAD}`, [withParameter(base, parameter, XSS_PAYLOAD)], ([probe]) => probe.response && isHtml(probe.response) && probe.response.body.includes(XSS_PAYLOAD) && !answer.body.includes(XSS_PAYLOAD)
			? { confidence: 'firm', detail: `The ${what} is written into an HTML answer unescaped.`, match: XSS_PAYLOAD } : undefined, extra);

		add('injection.command', `${what} with ;echo`, [withParameter(base, parameter, `${parameter.value}${COMMAND_PAYLOAD}`)], ([probe]) => {
			const hit = fresh(/volt42cmd/, probe);
			return hit ? { confidence: 'certain', detail: `A shell command added to the ${what} ran: its sum comes back worked out.`, match: hit } : undefined;
		}, extra);
	}
	for (const parameter of fileLike.length ? fileLike : parameters.slice(0, 1)) {
		const what = `${kindLabel(parameter)} "${parameter.name}"`;
		for (const { payload, signature } of TRAVERSAL) {
			add('injection.pathTraversal', `${what} as ${payload}`, [withParameter(base, parameter, payload)], ([probe]) => {
				const hit = fresh(signature, probe);
				return hit ? { confidence: 'certain', detail: `The ${what} set to ${payload} brings back that file's content.`, match: hit } : undefined;
			}, { parameter: parameter.name });
		}
	}
	for (const parameter of urlLike) {
		const what = `${kindLabel(parameter)} "${parameter.name}"`;
		const target = `${HTTP_SECURITY_SCAN_ORIGIN}/`;
		add('redirect.open', `${what} as ${target}`, [withParameter(base, parameter, target)], ([probe]) => {
			const location = responseHeader(probe.response, 'location') ?? '';
			if (probe.response && probe.response.status >= 300 && probe.response.status < 400 && /^(?:https?:)?\/\/volt-security-scan\.invalid/i.test(location.trim())) {
				return { confidence: 'certain', detail: `The ${what} set to another site's URL makes the server redirect there.`, match: location.trim() };
			}
			// A sender that follows redirects ends at the host that does not exist.
			return !probe.response && probe.error?.includes(HTTP_SECURITY_SCAN_HOST)
				? { confidence: 'firm', detail: `The ${what} set to another site's URL sent the request on to ${HTTP_SECURITY_SCAN_HOST}.`, match: HTTP_SECURITY_SCAN_HOST } : undefined;
		}, { parameter: parameter.name });
	}

	// Bodies of requests that change data: only when the user turned those on.
	const jsonBody = jsonOf(base.body);
	if (replay && UNSAFE_METHODS.includes(method) && isRecord(jsonBody)) {
		const before = jsonOf(answer.body);
		const extraFields = { ...(('isAdmin' in jsonBody) ? {} : { isAdmin: true }), ...(('role' in jsonBody) ? {} : { role: 'admin' }), voltProbeField: 'volt-mass-assignment' };
		add('access.massAssignment', 'Body with "isAdmin": true and "role": "admin" added', [{ ...base, body: JSON.stringify({ ...jsonBody, ...extraFields }) }], ([probe]) => {
			const after = jsonOf(probe.response?.body);
			if (!is2xx(probe.response) || !isRecord(after)) {
				return undefined;
			}
			const had = isRecord(before) ? before : {};
			const flat = (value: Record<string, unknown>): Record<string, unknown> => ({ ...value, ...(isRecord(value.data) ? value.data : {}), ...(isRecord(value.user) ? value.user : {}) });
			const now = flat(after);
			const was = flat(had);
			if (('isAdmin' in extraFields && now.isAdmin === true && was.isAdmin !== true) || ('role' in extraFields && now.role === 'admin' && was.role !== 'admin')) {
				return { confidence: 'firm', detail: 'A privilege field the client added to the body comes back set in the answer.', match: now.isAdmin === true ? '"isAdmin"' : '"role"' };
			}
			return probe.response.body.includes('volt-mass-assignment')
				? { confidence: 'tentative', severity: 'low', title: 'Unknown body fields are echoed back', detail: 'A field the API does not define was accepted and came back in the answer; fields the client should not set may be bound the same way.', match: 'volt-mass-assignment' } : undefined;
		});
		if (is2xx(answer) && /json/i.test(requestHeader(base, 'content-type') ?? '')) {
			add('input.contentType', 'JSON body sent as text/plain', [withHeaders(base, { 'Content-Type': 'text/plain' })], ([probe]) => is2xx(probe.response) && sameShape(probe.response, answer)
				? { confidence: 'firm', detail: 'The JSON body is accepted when it is sent as text/plain.' } : undefined);
			add('input.contentType', 'XML body', [{ ...withHeaders(base, { 'Content-Type': 'application/xml' }), body: '<?xml version="1.0"?><volt-probe>1</volt-probe>' }], ([probe]) => is2xx(probe.response)
				? { confidence: 'tentative', title: 'XML is accepted on a JSON endpoint', detail: 'An XML body sent to this JSON endpoint is answered with success: an XML parser may be reachable.' } : undefined);
		}
	}
	if (parameters.length) {
		const parameter = parameters[0];
		add('input.oversized', `${kindLabel(parameter)} "${parameter.name}" with 100 KB`, [withParameter(base, parameter, 'A'.repeat(100 * 1024))], ([probe]) => probe.response && probe.response.status >= 500 && answer.status < 500
			? { confidence: 'firm', detail: `A 100 KB value in the ${kindLabel(parameter)} "${parameter.name}" brings back a ${probe.response.status}.` } : undefined, { parameter: parameter.name });
	}

	// Host-wide: once per host.
	if (!options.skipHostWide) {
		if (url.protocol === 'https:' && !url.port && !local && safe) {
			const plain = new URL(url.toString());
			plain.protocol = 'http:';
			add('transport.downgrade', 'The same request over http://', [{ ...withoutCredentials(base), url: withoutCredentials({ ...base, url: plain.toString() }).url }], ([probe]) => {
				const status = probe.response?.status ?? 0;
				return (status >= 200 && status < 300) || status === 401 || status === 403
					? { confidence: 'firm', detail: `${url.hostname} answers ${status} over plain HTTP instead of redirecting to HTTPS.` } : undefined;
			});
		}
		if (safe && is2xx(answer) && !hasRateLimitHeaders(answer)) {
			add('limits.burst', `${HTTP_SECURITY_BURST} requests in a row`, Array.from({ length: HTTP_SECURITY_BURST }, () => base), answers => answers.every(item => is2xx(item.response) && !hasRateLimitHeaders(item.response))
				? { confidence: 'tentative', answer: answers.length - 1, detail: `${HTTP_SECURITY_BURST} requests in a row were all answered, with no 429 and no rate limit headers.` } : undefined, { burst: true });
		}
	}

	// The rules no plan may break, whatever was planned above, then the bound.
	const bounded: IHttpSecurityProbe[] = [];
	let total = 0;
	const max = Math.min(HTTP_SECURITY_MAX_PROBES, Math.max(0, options.maxProbesPerRequest));
	for (const probe of out) {
		if (!probe.requests.every(request => isHttpSecurityMethodAllowed(request.method, options.includeUnsafeMethods))) {
			continue;
		}
		if (total + probe.requests.length > max) {
			continue;
		}
		total += probe.requests.length;
		bounded.push(probe);
	}
	return bounded;
}

// --- Summaries --------------------------------------------------------------------------------------

export interface IHttpSecuritySummary {
	/** Findings that count: not triaged away. */
	readonly open: number;
	readonly triaged: number;
	readonly bySeverity: Readonly<Record<HttpSecuritySeverity, number>>;
	/** All ten categories, in order, with the open findings of each. */
	readonly byOwasp: readonly { readonly id: HttpSecurityOwasp; readonly title: string; readonly count: number; readonly worst?: HttpSecuritySeverity }[];
	/** Endpoints with open findings, the most first. */
	readonly byEndpoint: readonly { readonly endpoint: string; readonly count: number; readonly worst: HttpSecuritySeverity }[];
	readonly score: number;
	readonly grade: 'A' | 'B' | 'C' | 'D' | 'F';
	/** How the score came about, in a sentence or two. */
	readonly explanation: string;
}

const PENALTY: Readonly<Record<HttpSecuritySeverity, number>> = { critical: 25, high: 15, medium: 7, low: 3, info: 0 };
const WEIGHT: Readonly<Record<HttpSecurityConfidence, number>> = { certain: 1, firm: 0.8, tentative: 0.4 };

export function httpSecurityEndpointLabel(endpoint: IHttpSecurityEndpoint): string {
	const url = httpSecurityUrl(endpoint.url);
	return `${endpoint.method.toUpperCase()} ${url ? url.pathname : endpoint.url}`;
}

export function isHttpSecurityFindingOpen(finding: IHttpSecurityFinding, triage: Readonly<Record<string, HttpSecurityTriage>>): boolean {
	return !triage[finding.fingerprint];
}

/** Counts, and a 0-100 score with a letter: 100 less a penalty per open finding by severity, scaled by how sure the finding is. */
export function summarizeHttpSecurity(findings: readonly IHttpSecurityFinding[], triage: Readonly<Record<string, HttpSecurityTriage>> = {}): IHttpSecuritySummary {
	const open = findings.filter(finding => isHttpSecurityFindingOpen(finding, triage));
	const bySeverity: Record<HttpSecuritySeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
	const owasp = new Map<HttpSecurityOwasp, { count: number; worst?: HttpSecuritySeverity }>();
	const endpoints = new Map<string, { count: number; worst: HttpSecuritySeverity }>();
	let penalty = 0;
	const worse = (a: HttpSecuritySeverity | undefined, b: HttpSecuritySeverity) => a && SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
	for (const finding of open) {
		bySeverity[finding.severity]++;
		penalty += PENALTY[finding.severity] * WEIGHT[finding.confidence];
		const category = owasp.get(finding.owasp) ?? { count: 0 };
		owasp.set(finding.owasp, { count: category.count + 1, worst: worse(category.worst, finding.severity) });
		const label = httpSecurityEndpointLabel(finding.endpoint);
		const endpoint = endpoints.get(label);
		endpoints.set(label, { count: (endpoint?.count ?? 0) + 1, worst: worse(endpoint?.worst, finding.severity) });
	}
	let score = Math.max(0, Math.round(100 - penalty));
	// Something certain and critical is never a pass, however little else there is.
	const certainCritical = open.some(finding => finding.severity === 'critical' && finding.confidence !== 'tentative');
	if (certainCritical) {
		score = Math.min(score, 49);
	}
	const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F';
	const counted = HTTP_SECURITY_SEVERITIES.filter(severity => severity !== 'info' && bySeverity[severity]).map(severity => `${bySeverity[severity]} ${severity}`);
	const explanation = [
		counted.length ? `${score} of 100 (${grade}): 100 less ${counted.join(', ')} (25 per critical, 15 per high, 7 per medium, 3 per low; a firm finding counts 80%, a tentative one 40%).` : `${score} of 100 (${grade}): no open finding above informational.`,
		...(certainCritical ? ['A critical finding the scan is sure of caps the score at 49.'] : []),
		...(findings.length - open.length ? [`${findings.length - open.length} triaged finding${findings.length - open.length === 1 ? '' : 's'} left out.`] : []),
		'A = 90 and up, B = 80, C = 65, D = 50, F below. The score covers only what the enabled checks can see.',
	].join(' ');
	return {
		open: open.length,
		triaged: findings.length - open.length,
		bySeverity,
		byOwasp: HTTP_SECURITY_OWASP_IDS.map(id => {
			const found = owasp.get(id);
			return { id, title: HTTP_SECURITY_OWASP[id], count: found?.count ?? 0, ...(found?.worst ? { worst: found.worst } : {}) };
		}),
		byEndpoint: [...endpoints].map(([endpoint, value]) => ({ endpoint, ...value })).sort((a, b) => SEVERITY_RANK[a.worst] - SEVERITY_RANK[b.worst] || b.count - a.count || a.endpoint.localeCompare(b.endpoint)),
		score,
		grade,
		explanation,
	};
}

// --- Reports ----------------------------------------------------------------------------------------

const TRIAGE_LABELS: Readonly<Record<HttpSecurityTriage, string>> = { falsePositive: 'False positive', accepted: 'Accepted risk', fixed: 'Fixed' };

export function httpSecurityTriageLabel(triage: HttpSecurityTriage): string {
	return TRIAGE_LABELS[triage];
}

function referencesOf(finding: IHttpSecurityFinding): string {
	return `OWASP ${finding.owasp}:2023 ${HTTP_SECURITY_OWASP[finding.owasp]}${finding.cwe !== undefined ? `, CWE-${finding.cwe}` : ''}`;
}

function evidenceText(evidence: IHttpSecurityEvidence): { readonly request: string; readonly response: string } {
	const request = [`${evidence.request.method} ${evidence.request.url}`, ...evidence.request.headers.map(([key, value]) => `${key}: ${value}`), ...(evidence.request.body ? ['', evidence.request.body] : [])].join('\n');
	const response = evidence.response.status
		? [`HTTP ${evidence.response.status}`, ...evidence.response.headers.map(([key, value]) => `${key}: ${value}`), ...(evidence.response.body ? ['', evidence.response.body] : [])].join('\n')
		: `No response${evidence.response.error ? `: ${evidence.response.error}` : '.'}`;
	return { request, response };
}

/** One finding as text: for the clipboard, a chat and the reports. */
export function httpSecurityFindingText(finding: IHttpSecurityFinding, triage?: HttpSecurityTriage): string {
	const evidence = evidenceText(finding.evidence);
	const fence = (value: string) => `\`\`\`\n${value.replace(/```/g, '` ` `')}\n\`\`\``;
	return [
		`### ${finding.title}`,
		'',
		`- Severity: ${HTTP_SECURITY_SEVERITY_LABELS[finding.severity]} (confidence: ${finding.confidence})${triage ? ` - triaged: ${TRIAGE_LABELS[triage]}` : ''}`,
		`- Endpoint: ${finding.endpoint.method} ${finding.endpoint.url}`,
		...(finding.endpoint.path.length ? [`- Request: ${finding.endpoint.collection} > ${finding.endpoint.path.join(' / ')}`] : []),
		...(finding.parameter ? [`- Parameter: ${finding.parameter}`] : []),
		`- Reference: ${referencesOf(finding)}`,
		...(finding.occurrences && finding.occurrences > 1 ? [`- Seen on ${finding.occurrences} requests of this host`] : []),
		`- Check: ${finding.checkId} (${finding.fingerprint})`,
		'',
		finding.description,
		'',
		...(finding.evidence.match ? [`Matched: \`${finding.evidence.match.replace(/`/g, '\'')}\``, ''] : []),
		'Request sent:',
		fence(evidence.request),
		'Response:',
		fence(evidence.response),
		'',
		`Fix: ${finding.remediation}`,
	].join('\n');
}

function scanLine(scan: IHttpSecurityScanRecord): string {
	return `${scan.requests} request${scan.requests === 1 ? '' : 's'} scanned, ${scan.probes} probe${scan.probes === 1 ? '' : 's'} sent (${scan.active ? 'passive and active checks' : 'passive checks only'})${scan.stopped ? ', stopped before the end' : ''}`;
}

export function httpSecurityMarkdownReport(file: IHttpSecurityFile, scan: IHttpSecurityScanRecord | undefined = file.lastScan): string {
	if (!scan) {
		return `# ${file.name}\n\nNo scan has run yet.\n`;
	}
	const summary = summarizeHttpSecurity(scan.findings, file.triage);
	const sorted = sortHttpSecurityFindings(scan.findings);
	const open = sorted.filter(finding => isHttpSecurityFindingOpen(finding, file.triage));
	const triaged = sorted.filter(finding => !isHttpSecurityFindingOpen(finding, file.triage));
	const cell = (value: string) => value.replace(/\|/g, '\\|');
	return [
		`# Security scan: ${file.name}`,
		'',
		...(file.description ? [file.description, ''] : []),
		`- Scanned: ${scan.at}`,
		`- Scope: ${scanLine(scan)}`,
		`- Score: ${summary.score}/100, grade ${summary.grade}`,
		`- Open findings: ${summary.open}${summary.triaged ? ` (${summary.triaged} triaged)` : ''}`,
		...(file.authorizedHosts.length ? [`- Hosts authorized for active checks: ${file.authorizedHosts.map(item => `${item.host} (${item.at.slice(0, 10)})`).join(', ')}`] : []),
		'',
		summary.explanation,
		...(scan.notes?.length ? ['', '## Notes', '', ...scan.notes.map(note => `- ${note}`)] : []),
		'',
		'## By severity',
		'',
		'| Severity | Open findings |',
		'| --- | ---: |',
		...HTTP_SECURITY_SEVERITIES.map(severity => `| ${HTTP_SECURITY_SEVERITY_LABELS[severity]} | ${summary.bySeverity[severity]} |`),
		'',
		'## By OWASP API Security Top 10 (2023)',
		'',
		'| Category | Open findings |',
		'| --- | ---: |',
		...summary.byOwasp.map(item => `| ${item.id} ${item.title} | ${item.count} |`),
		...(summary.byEndpoint.length ? ['', '## By endpoint', '', '| Endpoint | Open findings | Worst |', '| --- | ---: | --- |', ...summary.byEndpoint.map(item => `| ${cell(item.endpoint)} | ${item.count} | ${HTTP_SECURITY_SEVERITY_LABELS[item.worst]} |`)] : []),
		'',
		'## Findings',
		'',
		...(open.length ? open.flatMap(finding => [httpSecurityFindingText(finding), '']) : ['No open findings.', '']),
		...(triaged.length ? ['## Triaged', '', ...triaged.map(finding => `- ${TRIAGE_LABELS[file.triage[finding.fingerprint]]}: ${finding.title} (${httpSecurityEndpointLabel(finding.endpoint)})`), ''] : []),
		'---',
		'',
		'Made by the Volt Client security scan. Detection only: the checks send no destructive payloads, and active checks run only against hosts the user authorized.',
		'',
	].join('\n');
}

export function httpSecurityJsonReport(file: IHttpSecurityFile, scan: IHttpSecurityScanRecord | undefined = file.lastScan): string {
	const findings = scan ? sortHttpSecurityFindings(scan.findings) : [];
	return `${JSON.stringify({
		name: file.name,
		description: file.description,
		scan: scan ? { at: scan.at, durationMs: scan.durationMs, requests: scan.requests, probes: scan.probes, active: scan.active, stopped: scan.stopped === true, notes: scan.notes ?? [] } : null,
		summary: summarizeHttpSecurity(findings, file.triage),
		findings: findings.map(finding => ({ ...finding, ...(file.triage[finding.fingerprint] ? { triage: file.triage[finding.fingerprint] } : {}) })),
	}, null, '\t')}\n`;
}

const SARIF_LEVEL: Readonly<Record<HttpSecuritySeverity, 'error' | 'warning' | 'note'>> = { critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'note' };
const SARIF_SCORE: Readonly<Record<HttpSecuritySeverity, string>> = { critical: '9.5', high: '8.0', medium: '5.5', low: '3.0', info: '0.0' };

/** SARIF 2.1.0: one rule per check that found something, one result per finding; triaged findings are suppressed, not dropped. */
export function httpSecuritySarifReport(file: IHttpSecurityFile, scan: IHttpSecurityScanRecord | undefined = file.lastScan): string {
	const findings = scan ? sortHttpSecurityFindings(scan.findings) : [];
	const ruleIds = [...new Set(findings.map(finding => finding.checkId))];
	const rules = ruleIds.map(id => {
		const check = httpSecurityCheck(id);
		return {
			id,
			name: id.replace(/(?:^|\.)(\w)/g, (_whole, letter: string) => letter.toUpperCase()),
			shortDescription: { text: check?.title ?? id },
			fullDescription: { text: check ? `${check.description} ${check.risk}` : id },
			help: { text: check?.remediation ?? '' },
			defaultConfiguration: { level: SARIF_LEVEL[check?.severity ?? 'info'] },
			properties: { tags: ['security', ...(check ? [`owasp-api-2023-${check.owasp.toLowerCase()}`, ...(check.cwe !== undefined ? [`external/cwe/cwe-${check.cwe}`] : [])] : [])], 'security-severity': SARIF_SCORE[check?.severity ?? 'info'] },
		};
	});
	const sarif = {
		$schema: 'https://json.schemastore.org/sarif-2.1.0.json',
		version: '2.1.0',
		runs: [{
			tool: { driver: { name: 'Volt Client Security Scan', informationUri: 'https://owasp.org/API-Security/editions/2023/en/0x11-t10/', rules } },
			...(scan?.at ? { invocations: [{ executionSuccessful: true, endTimeUtc: scan.at }] } : {}),
			results: findings.map(finding => ({
				ruleId: finding.checkId,
				ruleIndex: ruleIds.indexOf(finding.checkId),
				level: SARIF_LEVEL[finding.severity],
				message: { text: `${finding.title}: ${finding.description} Fix: ${finding.remediation}` },
				locations: [{
					physicalLocation: { artifactLocation: { uri: finding.endpoint.url } },
					logicalLocations: [{ name: httpSecurityEndpointLabel(finding.endpoint), kind: 'resource', ...(finding.endpoint.path.length ? { fullyQualifiedName: `${finding.endpoint.collection}/${finding.endpoint.path.join('/')}` } : {}) }],
				}],
				partialFingerprints: { 'voltSecurity/v1': finding.fingerprint },
				...(file.triage[finding.fingerprint] ? { suppressions: [{ kind: 'external', justification: TRIAGE_LABELS[file.triage[finding.fingerprint]] }] } : {}),
				properties: { severity: finding.severity, confidence: finding.confidence, owasp: finding.owasp, ...(finding.cwe !== undefined ? { cwe: `CWE-${finding.cwe}` } : {}), ...(finding.parameter ? { parameter: finding.parameter } : {}), 'security-severity': SARIF_SCORE[finding.severity] },
			})),
		}],
	};
	return `${JSON.stringify(sarif, null, '\t')}\n`;
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * A report in one HTML file, charts drawn as inline SVG. It is text to save to a file and open
 * in a browser: Volt never puts it in its own DOM. Every value from a scan goes through
 * `escapeHtml`.
 */
export function httpSecurityHtmlReport(file: IHttpSecurityFile, scan: IHttpSecurityScanRecord | undefined = file.lastScan): string {
	const findings = scan ? sortHttpSecurityFindings(scan.findings) : [];
	const summary = summarizeHttpSecurity(findings, file.triage);
	const e = escapeHtml;
	const counted = HTTP_SECURITY_SEVERITIES.filter(severity => summary.bySeverity[severity] > 0);
	const total = counted.reduce((sum, severity) => sum + summary.bySeverity[severity], 0);

	// Severity: one stacked bar, a 2px gap between the segments, the counts in the legend under it.
	const WIDTH = 640;
	const gaps = Math.max(0, counted.length - 1) * 2;
	let x = 0;
	const segments = counted.map(severity => {
		const width = Math.max(4, (summary.bySeverity[severity] / total) * (WIDTH - gaps));
		const rect = `<rect class="sev-${severity}" x="${x.toFixed(1)}" y="0" width="${width.toFixed(1)}" height="14" rx="3"><title>${e(HTTP_SECURITY_SEVERITY_LABELS[severity])}: ${summary.bySeverity[severity]}</title></rect>`;
		x += width + 2;
		return rect;
	}).join('');
	const severityChart = total
		? `<svg viewBox="0 0 ${WIDTH} 14" width="100%" height="14" preserveAspectRatio="none" role="img" aria-label="Open findings by severity">${segments}</svg>`
		: '';
	const legend = HTTP_SECURITY_SEVERITIES.map(severity => `<span class="key"><i class="dot sev-${severity}"></i>${e(HTTP_SECURITY_SEVERITY_LABELS[severity])} <b>${summary.bySeverity[severity]}</b></span>`).join('');

	// OWASP: one row per category, the bar's length the count.
	const most = Math.max(1, ...summary.byOwasp.map(item => item.count));
	const ROW = 26;
	const LABEL = 330;
	const owaspRows = summary.byOwasp.map((item, index) => {
		const y = index * ROW;
		const width = item.count ? Math.max(4, (item.count / most) * (WIDTH - LABEL - 40)) : 0;
		return `<text class="label${item.count ? '' : ' none'}" x="0" y="${y + 17}"><tspan class="id">${item.id}</tspan> ${e(item.title)}</text>`
			+ (item.count ? `<rect class="bar" x="${LABEL}" y="${y + 6}" width="${width.toFixed(1)}" height="14" rx="3"><title>${item.id}: ${item.count}</title></rect>` : `<rect class="track" x="${LABEL}" y="${y + 12}" width="${WIDTH - LABEL - 40}" height="1"></rect>`)
			+ `<text class="count${item.count ? '' : ' none'}" x="${LABEL + width + 8}" y="${y + 17}">${item.count}</text>`;
	}).join('');
	const owaspChart = `<svg viewBox="0 0 ${WIDTH} ${summary.byOwasp.length * ROW}" width="100%" role="img" aria-label="Open findings by OWASP API Security Top 10 category">${owaspRows}</svg>`;

	const findingHtml = (finding: IHttpSecurityFinding) => {
		const triage = file.triage[finding.fingerprint];
		const evidence = evidenceText(finding.evidence);
		return `<section class="finding${triage ? ' triaged' : ''}">
<h3><span class="badge sev-${finding.severity}">${e(HTTP_SECURITY_SEVERITY_LABELS[finding.severity])}</span> ${e(finding.title)}</h3>
<p class="meta"><code>${e(finding.endpoint.method)} ${e(finding.endpoint.url)}</code>${finding.parameter ? ` &middot; parameter <code>${e(finding.parameter)}</code>` : ''} &middot; confidence ${e(finding.confidence)}${triage ? ` &middot; ${e(TRIAGE_LABELS[triage])}` : ''}${finding.occurrences && finding.occurrences > 1 ? ` &middot; seen on ${finding.occurrences} requests` : ''}</p>
<p>${e(finding.description)}</p>
<p class="meta">${e(referencesOf(finding))}</p>
${finding.evidence.match ? `<p class="meta">Matched: <code>${e(finding.evidence.match)}</code></p>` : ''}
<details><summary>Evidence</summary><h4>Request sent</h4><pre>${e(evidence.request)}</pre><h4>Response</h4><pre>${e(evidence.response)}</pre></details>
<p><b>Fix.</b> ${e(finding.remediation)}</p>
</section>`;
	};

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(`Security scan: ${file.name}`)}</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --surface: #f6f8fa; --critical: #a4161a; --high: #e5484d; --medium: #b7791f; --low: #2f6fed; --info: #8b949e; --bar: #2f6fed; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --line: #30363d; --surface: #161b22; --critical: #ff7b72; --high: #f85149; --medium: #d29922; --low: #58a6ff; --info: #6e7681; --bar: #58a6ff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { margin: 0 0 4px; font-size: 22px; }
h2 { margin: 32px 0 12px; font-size: 15px; }
h3 { margin: 0 0 6px; font-size: 14px; }
h4 { margin: 10px 0 4px; font-size: 12px; color: var(--muted); }
p { margin: 6px 0; }
.meta, .note { color: var(--muted); font-size: 12.5px; }
.tiles { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0; }
.tile { flex: 1 1 140px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 3px; }
.tile b { display: block; font-size: 24px; line-height: 1.2; }
.tile span { color: var(--muted); font-size: 12px; }
.legend { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 8px; font-size: 12.5px; color: var(--muted); }
.key b { color: var(--fg); }
.dot { display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; }
.dot.sev-critical, .badge.sev-critical { background: var(--critical); }
.dot.sev-high, .badge.sev-high { background: var(--high); }
.dot.sev-medium, .badge.sev-medium { background: var(--medium); }
.dot.sev-low, .badge.sev-low { background: var(--low); }
.dot.sev-info, .badge.sev-info { background: var(--info); }
rect.sev-critical { fill: var(--critical); } rect.sev-high { fill: var(--high); } rect.sev-medium { fill: var(--medium); } rect.sev-low { fill: var(--low); } rect.sev-info { fill: var(--info); }
svg text { font: 12.5px system-ui, -apple-system, "Segoe UI", sans-serif; fill: var(--fg); }
svg text.none { fill: var(--muted); }
svg .id { font-weight: 600; }
svg .bar { fill: var(--bar); }
svg .track { fill: var(--line); }
.badge { display: inline-block; padding: 0 7px; border-radius: 3px; color: #fff; font-size: 11px; font-weight: 600; line-height: 18px; vertical-align: 1px; }
.finding { padding: 14px 0; border-top: 1px solid var(--line); }
.finding.triaged { opacity: 0.6; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
pre { margin: 0; padding: 10px 12px; border-radius: 3px; background: var(--surface); overflow: auto; white-space: pre-wrap; word-break: break-word; }
details summary { cursor: pointer; color: var(--muted); font-size: 12.5px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
td, th { padding: 5px 8px; border-bottom: 1px solid var(--line); text-align: left; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<main>
<h1>${e(`Security scan: ${file.name}`)}</h1>
<p class="meta">${scan ? `${e(scan.at)} &middot; ${e(scanLine(scan))}` : 'No scan has run yet.'}</p>
${file.description ? `<p>${e(file.description)}</p>` : ''}
<div class="tiles">
<div class="tile"><b>${summary.grade}</b><span>Grade (${summary.score} of 100)</span></div>
<div class="tile"><b>${summary.open}</b><span>Open findings</span></div>
<div class="tile"><b>${scan?.requests ?? 0}</b><span>Requests scanned</span></div>
<div class="tile"><b>${scan?.probes ?? 0}</b><span>Probes sent</span></div>
</div>
<p class="note">${e(summary.explanation)}</p>
${scan?.notes?.length ? `<ul class="note">${scan.notes.map(note => `<li>${e(note)}</li>`).join('')}</ul>` : ''}
<h2>Open findings by severity</h2>
${severityChart}
<div class="legend">${legend}</div>
<h2>Open findings by OWASP API Security Top 10 (2023)</h2>
${owaspChart}
${summary.byEndpoint.length ? `<h2>By endpoint</h2>
<table><thead><tr><th>Endpoint</th><th class="n">Open findings</th><th>Worst</th></tr></thead><tbody>
${summary.byEndpoint.map(item => `<tr><td><code>${e(item.endpoint)}</code></td><td class="n">${item.count}</td><td>${e(HTTP_SECURITY_SEVERITY_LABELS[item.worst])}</td></tr>`).join('\n')}
</tbody></table>` : ''}
<h2>Findings</h2>
${findings.length ? findings.map(findingHtml).join('\n') : '<p class="note">No findings.</p>'}
<p class="note">Made by the Volt Client security scan. Detection only: the checks send no destructive payloads, and active checks run only against hosts the user authorized.</p>
</main>
</body>
</html>
`;
}
