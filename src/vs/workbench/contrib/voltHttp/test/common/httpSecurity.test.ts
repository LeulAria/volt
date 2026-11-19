/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { analyzeHttpSecurityExchange, dedupeHttpSecurityFindings, HTTP_SECURITY_BURST, HTTP_SECURITY_CHECKS, HTTP_SECURITY_MAX_PROBES, HTTP_SECURITY_SCAN_ORIGIN, HttpSecurityConfidence, httpLuhnValid, httpSecurityFingerprint, httpSecurityHostOf, httpSecurityHs256, httpSecurityHtmlReport, httpSecurityJsonReport, httpSecurityMarkdownReport, httpSecuritySarifReport, HttpSecuritySeverity, IHttpSecurityEndpoint, IHttpSecurityExchange, IHttpSecurityFile, IHttpSecurityFinding, IHttpSecurityProbe, IHttpSecurityRequest, IHttpSecurityResponse, IHttpSecurityScanRecord, isHttpSecurityCheckEnabled, isHttpSecurityMethodAllowed, maskHttpSecurityHeaders, maskHttpSecurityText, maskHttpSecurityUrl, maskHttpSecurityValue, parseHttpSecurityFile, planHttpSecurityProbes, serializeHttpSecurityFile, summarizeHttpSecurity, trimHttpSecurityFinding } from '../../common/httpSecurity.js';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const TOKEN = 'opaque-token-0123456789abcdef';
const URL_ = 'https://api.example.com/users/7';
const CLEAN_BODY = '{"id":7,"name":"Ada"}';
const CLEAN_HEADERS: Record<string, string> = {
	'content-type': 'application/json',
	'strict-transport-security': 'max-age=31536000',
	'x-content-type-options': 'nosniff',
	'cache-control': 'no-store',
	'ratelimit-limit': '100',
};

function endpoint(method = 'GET', url = URL_): IHttpSecurityEndpoint {
	return { method, url, collection: 'http/shop.postman_collection.json', path: ['Users', 'Get user'] };
}

interface IResponseChange {
	readonly status?: number;
	readonly headers?: Record<string, string>;
	readonly without?: readonly string[];
	readonly body?: string;
}

function response(change: IResponseChange = {}): IHttpSecurityResponse {
	const headers: Record<string, string> = { ...CLEAN_HEADERS, ...change.headers };
	for (const name of change.without ?? []) {
		delete headers[name];
	}
	return { status: change.status ?? 200, headers, body: change.body ?? CLEAN_BODY };
}

function request(change: Partial<IHttpSecurityRequest> = {}): IHttpSecurityRequest {
	return { method: 'GET', url: URL_, headers: [['Authorization', `Bearer ${TOKEN}`]], ...change };
}

function exchange(requestChange: Partial<IHttpSecurityRequest> = {}, responseChange: IResponseChange = {}): IHttpSecurityExchange {
	return { request: request(requestChange), response: response(responseChange) };
}

function analyze(value: IHttpSecurityExchange, checkId?: string): IHttpSecurityFinding[] {
	return analyzeHttpSecurityExchange(value, endpoint(value.request.method, value.request.url), { now: NOW, ...(checkId ? { enabled: id => id === checkId } : {}) });
}

function found(value: IHttpSecurityExchange, checkId: string): IHttpSecurityFinding[] {
	return analyze(value, checkId).filter(finding => finding.checkId === checkId);
}

const b64 = (value: unknown) => encodeBase64(VSBuffer.fromString(JSON.stringify(value)), false, true);

function jwt(header: Record<string, unknown>, payload: Record<string, unknown>, secret?: string): string {
	const input = `${b64(header)}.${b64(payload)}`;
	return `${input}.${secret === undefined ? '' : httpSecurityHs256(secret, input)}`;
}

function made(checkId: string, severity: HttpSecuritySeverity, confidence: HttpSecurityConfidence, path = '/a', title = checkId): IHttpSecurityFinding {
	const url = `https://api.example.com${path}`;
	const check = HTTP_SECURITY_CHECKS.find(item => item.id === checkId)!;
	const fingerprint = httpSecurityFingerprint(checkId, 'GET', url);
	return {
		id: fingerprint, fingerprint, checkId, title, severity, confidence, owasp: check.owasp, ...(check.cwe ? { cwe: check.cwe } : {}),
		endpoint: endpoint('GET', url), description: check.description,
		evidence: { request: { method: 'GET', url, headers: [] }, response: { status: 200, headers: [], body: '' } },
		remediation: check.remediation,
	};
}

function answers(probe: IHttpSecurityProbe, ...responses: IHttpSecurityResponse[]): IHttpSecurityExchange[] {
	return probe.requests.map((sent, index) => ({ request: sent, response: responses[index] ?? responses[responses.length - 1] }));
}

suite('Volt Client: security scan (pure)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('passive analyzers', () => {

		test('a well configured answer gives no finding at all', () => {
			assert.deepStrictEqual(analyze(exchange()).map(finding => finding.checkId), []);
		});

		test('transport: plain HTTP to a remote host, never to a local one', () => {
			assert.strictEqual(found(exchange({ url: 'http://api.example.com/users/7' }), 'transport.plainHttp').length, 1);
			assert.strictEqual(found(exchange({ url: 'http://localhost:3000/users/7' }), 'transport.plainHttp').length, 0);
			assert.strictEqual(found(exchange({ url: 'http://192.168.1.4/users/7' }), 'transport.plainHttp').length, 0);
		});

		test('transport: a credential in the query, masked in the evidence', () => {
			const [finding] = found(exchange({ url: `${URL_}?api_key=sk123456789abc` }), 'transport.secretInUrl');
			assert.strictEqual(finding.parameter, 'api_key');
			assert.ok(!JSON.stringify(finding).includes('sk123456789abc'), 'the key never shows in full');
			assert.strictEqual(found(exchange({ url: `${URL_}?page=2` }), 'transport.secretInUrl').length, 0);
		});

		test('headers: Strict-Transport-Security on remote HTTPS only', () => {
			assert.strictEqual(found(exchange({}, { without: ['strict-transport-security'] }), 'headers.hsts').length, 1);
			assert.strictEqual(found(exchange(), 'headers.hsts').length, 0);
			assert.strictEqual(found(exchange({ url: 'https://localhost:8443/x' }, { without: ['strict-transport-security'] }), 'headers.hsts').length, 0);
		});

		test('headers: X-Content-Type-Options', () => {
			assert.strictEqual(found(exchange({}, { without: ['x-content-type-options'] }), 'headers.contentTypeOptions').length, 1);
			assert.strictEqual(found(exchange({}, { without: ['x-content-type-options'], body: '' }), 'headers.contentTypeOptions').length, 0, 'an empty answer has nothing to sniff');
		});

		test('headers: Cache-Control on authenticated answers only', () => {
			assert.strictEqual(found(exchange({}, { without: ['cache-control'] }), 'headers.cacheControl').length, 1);
			assert.strictEqual(found(exchange({}, { headers: { 'cache-control': 'private, max-age=60' } }), 'headers.cacheControl').length, 0);
			assert.strictEqual(found(exchange({ headers: [] }, { without: ['cache-control'] }), 'headers.cacheControl').length, 0);
		});

		test('headers: CSP and framing on HTML answers', () => {
			const html = { 'content-type': 'text/html; charset=utf-8' };
			assert.strictEqual(found(exchange({}, { headers: html, body: '<html><body>hi</body></html>' }), 'headers.htmlFraming').length, 1);
			assert.strictEqual(found(exchange({}, { headers: { ...html, 'content-security-policy': 'default-src \'self\'; frame-ancestors \'none\'' }, body: '<html></html>' }), 'headers.htmlFraming').length, 0);
			assert.strictEqual(found(exchange(), 'headers.htmlFraming').length, 0, 'JSON answers are not framed');
		});

		test('CORS: a wildcard with credentials, and a wildcard on an authenticated endpoint', () => {
			const both = exchange({}, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' } });
			assert.strictEqual(found(both, 'cors.wildcardCredentials')[0].confidence, 'certain');
			assert.strictEqual(found(exchange({}, { headers: { 'access-control-allow-origin': 'https://app.example.com', 'access-control-allow-credentials': 'true' } }), 'cors.wildcardCredentials').length, 0);
			const wildcard = { headers: { 'access-control-allow-origin': '*' } };
			assert.strictEqual(found(exchange({}, wildcard), 'cors.wildcardAuthenticated').length, 1);
			assert.strictEqual(found(exchange({ headers: [] }, wildcard), 'cors.wildcardAuthenticated').length, 0, 'a public endpoint may allow every origin');
		});

		test('cookies: missing Secure, HttpOnly, SameSite; the value masked', () => {
			const [finding] = found(exchange({}, { headers: { 'set-cookie': 'sid=abc123xyz; Path=/' } }), 'cookies.flags');
			assert.strictEqual(finding.parameter, 'sid');
			assert.strictEqual(finding.severity, 'medium', 'a session cookie without Secure / HttpOnly');
			assert.ok(!JSON.stringify(finding.evidence).includes('abc123xyz'));
			assert.strictEqual(found(exchange({}, { headers: { 'set-cookie': 'sid=abc123xyz; Path=/; Secure; HttpOnly; SameSite=Lax' } }), 'cookies.flags').length, 0);
		});

		test('disclosure: server software with a version', () => {
			assert.strictEqual(found(exchange({}, { headers: { server: 'nginx/1.25.3' } }), 'disclosure.serverVersion').length, 1);
			assert.strictEqual(found(exchange({}, { headers: { 'x-powered-by': 'Express' } }), 'disclosure.serverVersion').length, 1);
			assert.strictEqual(found(exchange({}, { headers: { server: 'nginx' } }), 'disclosure.serverVersion').length, 0);
		});

		test('disclosure: stack traces and SQL errors', () => {
			const trace = 'Error: boom\n    at handler (/srv/app/routes/users.js:42:13)';
			assert.strictEqual(found(exchange({}, { status: 500, body: trace }), 'disclosure.stackTrace')[0].evidence.match, 'at handler (/srv/app/routes/users.js:42:13)');
			assert.strictEqual(found(exchange({}, { body: '{"message":"meet me at home"}' }), 'disclosure.stackTrace').length, 0);
			assert.strictEqual(found(exchange({}, { status: 500, body: '{"error":"You have an error in your SQL syntax near \'x\'"}' }), 'disclosure.sqlError').length, 1);
			assert.strictEqual(found(exchange({}, { body: '{"topic":"how to learn sql"}' }), 'disclosure.sqlError').length, 0);
		});

		test('disclosure: internal addresses', () => {
			assert.strictEqual(found(exchange({}, { body: '{"upstream":"10.0.3.4:8080"}' }), 'disclosure.internalAddress')[0].evidence.match, '10.0.3.4');
			assert.strictEqual(found(exchange({}, { body: '{"version":"10.2"}' }), 'disclosure.internalAddress').length, 0);
		});

		test('disclosure: secrets in the body, masked; a sign-in answering with a token is not one', () => {
			const [aws] = found(exchange({}, { body: '{"key":"AKIAIOSFODNN7EXAMPLE"}' }), 'disclosure.secrets');
			assert.strictEqual(aws.severity, 'high');
			assert.ok(!JSON.stringify(aws).includes('AKIAIOSFODNN7EXAMPLE'));
			const [key] = found(exchange({}, { body: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----' }), 'disclosure.secrets');
			assert.strictEqual(key.severity, 'critical');
			assert.ok(!key.evidence.response.body.includes('MIIEow'));
			const token = jwt({ alg: 'HS256' }, { sub: '1', exp: 2_000_000_000 }, 'x');
			assert.strictEqual(found(exchange({ url: 'https://api.example.com/auth/login' }, { body: `{"token":"${token}"}` }), 'disclosure.secrets').length, 0);
			assert.strictEqual(found(exchange({}, { body: `{"token":"${token}"}` }), 'disclosure.secrets')[0].confidence, 'tentative');
		});

		test('disclosure: verbose errors only on error answers', () => {
			assert.strictEqual(found(exchange({}, { status: 500, body: '{"message":"failed","exception":"NullReferenceException"}' }), 'disclosure.verboseError')[0].parameter, 'exception');
			assert.strictEqual(found(exchange({}, { status: 400, body: '{"message":"name is required"}' }), 'disclosure.verboseError').length, 0);
			assert.strictEqual(found(exchange({}, { body: '{"exception":"none"}' }), 'disclosure.verboseError').length, 0);
		});

		test('data: password hashes and card numbers (Luhn), not masked placeholders', () => {
			assert.strictEqual(found(exchange({}, { body: '{"id":7,"password_hash":"$2b$10$abcdefghijklmnopqrstuv"}' }), 'data.sensitiveFields').length, 1);
			const [card] = found(exchange({}, { body: '{"cardNumber":"4111 1111 1111 1111"}' }), 'data.sensitiveFields');
			assert.strictEqual(card.severity, 'high');
			assert.ok(!JSON.stringify(card).includes('4111 1111 1111 1111'));
			assert.strictEqual(found(exchange({}, { body: '{"password":"********","cardNumber":"4111111111111112"}' }), 'data.sensitiveFields').length, 0);
			assert.strictEqual(httpLuhnValid('4111111111111111'), true);
			assert.strictEqual(httpLuhnValid('4111111111111112'), false);
		});

		test('data: very large lists without paging', () => {
			const big = JSON.stringify(Array.from({ length: 150 }, (_, id) => ({ id })));
			assert.strictEqual(found(exchange({}, { body: big }), 'data.excessive').length, 1);
			assert.strictEqual(found(exchange({ url: `${URL_}?limit=150` }, { body: big }), 'data.excessive').length, 0);
			assert.strictEqual(found(exchange({}, { body: JSON.stringify(Array.from({ length: 20 }, (_, id) => ({ id }))) }), 'data.excessive').length, 0);
		});

		test('HS256 matches a published HMAC-SHA256 vector (RFC 4231, case 2)', () => {
			assert.strictEqual(httpSecurityHs256('Jefe', 'what do ya want for nothing?'), 'W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM');
		});

		test('JWT: alg none, no expiry, a very long one, a guessable HS256 secret; a sound token passes; the token never shows', () => {
			const iat = NOW / 1000;
			const of = (token: string) => found(exchange({ headers: [['Authorization', `Bearer ${token}`]] }), 'auth.jwt');
			const none = jwt({ alg: 'none' }, { sub: '1', iat, exp: iat + 600 });
			assert.deepStrictEqual(of(none).map(finding => [finding.parameter, finding.severity]), [['alg', 'critical']]);
			assert.deepStrictEqual(of(jwt({ alg: 'HS256' }, { sub: '1' }, 'a-long-random-secret-9f8e7d6c')).map(finding => finding.parameter), ['exp']);
			assert.deepStrictEqual(of(jwt({ alg: 'HS256' }, { sub: '1', iat, exp: iat + 365 * 86_400 }, 'a-long-random-secret-9f8e7d6c')).map(finding => [finding.parameter, finding.severity]), [['exp', 'low']]);
			const weak = jwt({ alg: 'HS256', typ: 'JWT' }, { sub: '1', iat, exp: iat + 600 }, 'secret');
			const [forged] = of(weak);
			assert.strictEqual(forged.parameter, 'secret');
			assert.strictEqual(forged.severity, 'critical');
			assert.ok(!JSON.stringify(forged).includes(weak), 'the token is masked in the evidence');
			assert.deepStrictEqual(of(jwt({ alg: 'HS256' }, { sub: '1', iat, exp: iat + 3600 }, 'a-long-random-secret-9f8e7d6c')), []);
		});

		test('rate limit headers (informational)', () => {
			assert.strictEqual(found(exchange({}, { without: ['ratelimit-limit'] }), 'limits.rateLimitHeaders')[0].severity, 'info');
			assert.strictEqual(found(exchange({}, { without: ['ratelimit-limit'], headers: { 'x-ratelimit-remaining': '9' } }), 'limits.rateLimitHeaders').length, 0);
		});

		test('a check turned off does not run', () => {
			const value = exchange({ url: 'http://api.example.com/x' }, { without: ['x-content-type-options'] });
			const file = { checks: { 'headers.contentTypeOptions': false } };
			const ids = analyzeHttpSecurityExchange(value, endpoint(), { now: NOW, enabled: id => isHttpSecurityCheckEnabled(file, id) }).map(finding => finding.checkId);
			assert.ok(ids.includes('transport.plainHttp'));
			assert.ok(!ids.includes('headers.contentTypeOptions'));
		});
	});

	suite('fingerprints, de-duplication, masking', () => {

		test('fingerprints are stable and name the check, where, and the parameter', () => {
			const a = httpSecurityFingerprint('disclosure.stackTrace', 'GET', 'https://api.example.com/a?x=1');
			assert.match(a, /^[0-9a-f]{16}$/);
			assert.strictEqual(a, httpSecurityFingerprint('disclosure.stackTrace', 'get', 'https://API.example.com/a?x=2'), 'the query and case do not matter');
			assert.notStrictEqual(a, httpSecurityFingerprint('disclosure.stackTrace', 'GET', 'https://api.example.com/b'));
			assert.notStrictEqual(a, httpSecurityFingerprint('disclosure.stackTrace', 'POST', 'https://api.example.com/a'));
			assert.notStrictEqual(a, httpSecurityFingerprint('disclosure.stackTrace', 'GET', 'https://api.example.com/a', 'q'));
			assert.strictEqual(httpSecurityFingerprint('headers.hsts', 'GET', 'https://api.example.com/a'), httpSecurityFingerprint('headers.hsts', 'POST', 'https://api.example.com/b'), 'host-wide checks: one per host');
		});

		test('a host-wide finding seen on several requests is one finding with a count', () => {
			const first = found(exchange({}, { without: ['strict-transport-security'] }), 'headers.hsts');
			const second = found(exchange({ url: 'https://api.example.com/orders/1' }, { without: ['strict-transport-security'] }), 'headers.hsts');
			const merged = dedupeHttpSecurityFindings([...first, ...second]);
			assert.strictEqual(merged.length, 1);
			assert.strictEqual(merged[0].occurrences, 2);
		});

		test('masking values, headers, URLs and text', () => {
			assert.strictEqual(maskHttpSecurityValue('abcdefghij'), 'abcd***(10)');
			assert.strictEqual(maskHttpSecurityValue('abc'), '***');
			assert.deepStrictEqual(maskHttpSecurityHeaders([['Authorization', 'Bearer abcdefghijkl'], ['Cookie', 'sid=abcdefgh; theme=dark'], ['X-Trace', 'ok']]), [
				['Authorization', 'Bearer abcd***(12)'],
				['Cookie', 'sid=abcd***(8); theme=***'],
				['X-Trace', 'ok'],
			]);
			const url = maskHttpSecurityUrl('https://u:pw@api.example.com/x?token=abcdef123456&page=2');
			assert.ok(url.includes('token=abcd***(12)') && url.includes('page=2') && url.includes('//u:***@'), url);
			const text = maskHttpSecurityText('{"password":"hunter2hunter","note":"-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----"}');
			assert.ok(!text.includes('hunter2hunter') && !text.includes('AAAA'), text);
		});

		test('evidence never holds the request\'s credentials, and the file keeps it short', () => {
			const [finding] = found(exchange({}, { status: 500, body: `${'x'.repeat(2000)} SQLSTATE[42000] ${TOKEN} ${'y'.repeat(2000)}` }), 'disclosure.sqlError');
			assert.ok(!JSON.stringify(finding).includes(TOKEN), 'echoed credentials are masked too');
			assert.ok(finding.evidence.response.body.includes('SQLSTATE[42000]'), 'the excerpt is around the match');
			const trimmed = trimHttpSecurityFinding(finding, 200);
			assert.ok(trimmed.evidence.response.body.length < 260);
			assert.ok(trimmed.evidence.response.body.includes('SQLSTATE[42000]'));
		});
	});

	suite('probe planning', () => {

		const BASE_URL = 'https://api.example.com/users/7?q=shoes&file=report.pdf&next=/home';
		const baseline = (change: Partial<IHttpSecurityRequest> = {}, answer: IResponseChange = {}) => exchange({ url: BASE_URL, ...change }, answer);
		const plan = (value: IHttpSecurityExchange = baseline(), options: Partial<Parameters<typeof planHttpSecurityProbes>[2]> = {}) => planHttpSecurityProbes(value, endpoint(value.request.method, value.request.url), { includeUnsafeMethods: false, maxProbesPerRequest: HTTP_SECURITY_MAX_PROBES, ...options });
		const total = (probes: readonly IHttpSecurityProbe[]) => probes.reduce((sum, probe) => sum + probe.requests.length, 0);
		const methods = (probes: readonly IHttpSecurityProbe[]) => new Set(probes.flatMap(probe => probe.requests.map(item => item.method.toUpperCase())));
		const probe = (probes: readonly IHttpSecurityProbe[], checkId: string, label?: string) => {
			const hit = probes.find(item => item.checkId === checkId && (!label || item.label.includes(label)));
			assert.ok(hit, `a ${checkId} probe${label ? ` "${label}"` : ''} is planned`);
			return hit;
		};

		test('which methods a probe may use: safe ones, unsafe only when asked, DELETE never', () => {
			for (const method of ['GET', 'HEAD', 'OPTIONS', 'TRACE']) {
				assert.strictEqual(isHttpSecurityMethodAllowed(method, false), true, method);
			}
			for (const method of ['POST', 'PUT', 'PATCH']) {
				assert.strictEqual(isHttpSecurityMethodAllowed(method, false), false, method);
				assert.strictEqual(isHttpSecurityMethodAllowed(method, true), true, method);
			}
			for (const method of ['DELETE', 'delete', 'CONNECT', 'PURGE']) {
				assert.strictEqual(isHttpSecurityMethodAllowed(method, true), false, method);
			}
		});

		test('the plan stays inside the per-request bound', () => {
			assert.ok(total(plan()) > 20, 'a full plan for a request with parameters');
			for (const max of [0, 1, 7, 30, 60]) {
				assert.ok(total(plan(baseline(), { maxProbesPerRequest: max })) <= max, String(max));
			}
			assert.deepStrictEqual(plan(baseline(), { maxProbesPerRequest: 0 }), []);
			assert.ok(total(plan(baseline(), { maxProbesPerRequest: 100_000 })) <= HTTP_SECURITY_MAX_PROBES);
		});

		test('without data-changing tests only safe methods go out; with them still never DELETE', () => {
			assert.deepStrictEqual([...methods(plan())].filter(method => !['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(method)), []);
			const post = baseline({ method: 'POST', url: 'https://api.example.com/users?q=a', headers: [['Authorization', `Bearer ${TOKEN}`], ['Content-Type', 'application/json']], body: '{"name":"Ada","bio":"hi"}' }, { status: 201 });
			const passive = plan(post);
			assert.ok(!methods(passive).has('POST'), 'a POST is not replayed');
			assert.ok(!passive.some(item => item.checkId.startsWith('injection.') || item.checkId === 'access.massAssignment'));
			assert.strictEqual(probe(passive, 'cors.reflectedOrigin').requests[0].method, 'OPTIONS', 'CORS asks with a preflight');
			const opted = plan(post, { includeUnsafeMethods: true });
			assert.ok(methods(opted).has('POST'));
			assert.ok(opted.some(item => item.checkId === 'access.massAssignment'));
			const withVerb = plan(baseline(), { includeUnsafeMethods: true, knownMethods: ['GET'] });
			assert.strictEqual(probe(withVerb, 'methods.unexpectedVerb').requests[0].method, 'PATCH');
			for (const probes of [plan(), passive, opted, withVerb, plan(baseline(), { includeUnsafeMethods: true, knownMethods: ['GET', 'POST', 'PUT', 'PATCH'] })]) {
				assert.ok(!methods(probes).has('DELETE'));
			}
		});

		test('probes go only to the request\'s own host, and send nothing destructive or time based', () => {
			const probes = plan(baseline({}, { without: ['ratelimit-limit'] }));
			for (const item of probes) {
				for (const sent of item.requests) {
					assert.strictEqual(httpSecurityHostOf(sent.url), 'api.example.com', `${item.label}: ${sent.url}`);
					const text = `${sent.url}\n${sent.headers.map(pair => pair.join(': ')).join('\n')}\n${sent.body ?? ''}`;
					assert.doesNotMatch(text, /sleep|waitfor|benchmark\(|pg_sleep|drop\s+table|delete\s+from|truncate|rm\s+-rf|shutdown|curl\s|wget\s/i, item.label);
				}
			}
		});

		test('the burst is at most fifteen requests, once per host, and can be turned off', () => {
			const plain = baseline({}, { without: ['ratelimit-limit'] });
			const burst = probe(plan(plain), 'limits.burst');
			assert.strictEqual(burst.burst, true);
			assert.ok(burst.requests.length <= HTTP_SECURITY_BURST && HTTP_SECURITY_BURST <= 15);
			assert.ok(burst.requests.every(item => item.method === 'GET'));
			assert.ok(!plan(plain, { skipHostWide: true }).some(item => item.checkId === 'limits.burst' || item.checkId === 'transport.downgrade'));
			assert.ok(!plan(plain, { enabled: id => id !== 'limits.burst' }).some(item => item.checkId === 'limits.burst'));
			assert.ok(!plan().some(item => item.checkId === 'limits.burst'), 'an answer with rate limit headers needs no burst');
		});

		test('credentials are taken away where the probe is about them, and parameters change one at a time', () => {
			const probes = plan();
			assert.ok(!probe(probes, 'auth.missing').requests[0].headers.some(([key]) => key.toLowerCase() === 'authorization'));
			assert.ok(!probe(probes, 'transport.downgrade').requests[0].headers.some(([key]) => key.toLowerCase() === 'authorization'));
			assert.ok(probe(probes, 'transport.downgrade').requests[0].url.startsWith('http://api.example.com/'));
			for (const item of probes.filter(entry => entry.checkId.startsWith('injection.') && entry.parameter === 'q')) {
				const url = new URL(item.requests[0].url);
				assert.strictEqual(url.searchParams.get('file'), 'report.pdf', item.label);
				assert.strictEqual(url.searchParams.get('next'), '/home', item.label);
			}
		});

		suite('evaluators', () => {

			const probes = plan();
			const json = (status: number, body: string, headers: Record<string, string> = {}): IHttpSecurityResponse => ({ status, headers: { 'content-type': 'application/json', ...headers }, body });

			test('authentication', () => {
				const missing = probe(probes, 'auth.missing');
				assert.strictEqual(missing.evaluate(answers(missing, json(200, CLEAN_BODY)))?.confidence, 'certain');
				assert.strictEqual(missing.evaluate(answers(missing, json(401, '{"error":"unauthorized"}'))), undefined);
				const malformed = probe(probes, 'auth.malformedToken');
				assert.strictEqual(malformed.evaluate(answers(malformed, json(200, '{"id":7,"name":"Bob"}')))?.confidence, 'firm');
				assert.strictEqual(malformed.evaluate(answers(malformed, json(200, '{"error":"bad token","code":1}'))), undefined, 'a different shape is an error page');
				const finding = missing.evaluate(answers(missing, json(200, CLEAN_BODY)))!;
				assert.ok(!JSON.stringify(finding).includes(TOKEN));
			});

			test('object level authorization is a hint for review', () => {
				const bola = probe(probes, 'access.bola', 'Id 7 changed to 6');
				assert.strictEqual(bola.requests[0].url.startsWith('https://api.example.com/users/6'), true);
				assert.strictEqual(bola.evaluate(answers(bola, json(200, '{"id":6,"name":"Eve"}')))?.confidence, 'tentative');
				assert.strictEqual(bola.evaluate(answers(bola, json(200, CLEAN_BODY))), undefined, 'the same object back is no evidence');
				assert.strictEqual(bola.evaluate(answers(bola, json(404, '{"error":"not found"}'))), undefined);
				assert.ok(!plan(baseline({ url: 'https://api.example.com/api/2/orders' })).some(item => item.checkId === 'access.bola'), 'an API version is not an id');
			});

			test('methods: TRACE echo, permissive Allow, method override', () => {
				const trace = probe(probes, 'methods.trace');
				assert.ok(!trace.requests[0].headers.some(([key]) => key.toLowerCase() === 'authorization'), 'TRACE carries no credentials');
				assert.ok(trace.evaluate(answers(trace, { status: 200, headers: {}, body: 'TRACE / HTTP/1.1\nX-Volt-Probe: volt-trace-probe' })));
				assert.strictEqual(trace.evaluate(answers(trace, { status: 405, headers: {}, body: '' })), undefined);
				const options = probe(probes, 'methods.options');
				assert.strictEqual(options.evaluate(answers(options, { status: 204, headers: { allow: 'GET, HEAD, DELETE, TRACE' }, body: '' }))?.severity, 'low');
				assert.strictEqual(options.evaluate(answers(options, { status: 204, headers: { allow: 'GET, HEAD' }, body: '' })), undefined);
				const override = probe(probes, 'methods.override');
				assert.ok(override.evaluate(answers(override, json(200, ''))));
				assert.strictEqual(override.evaluate(answers(override, json(200, CLEAN_BODY))), undefined);
			});

			test('CORS reflection', () => {
				const cors = probe(probes, 'cors.reflectedOrigin');
				assert.strictEqual(cors.evaluate(answers(cors, json(200, CLEAN_BODY, { 'access-control-allow-origin': HTTP_SECURITY_SCAN_ORIGIN, 'access-control-allow-credentials': 'true' })))?.severity, 'high');
				assert.strictEqual(cors.evaluate(answers(cors, json(200, CLEAN_BODY, { 'access-control-allow-origin': HTTP_SECURITY_SCAN_ORIGIN })))?.severity, 'medium');
				assert.strictEqual(cors.evaluate(answers(cors, json(200, CLEAN_BODY, { 'access-control-allow-origin': 'https://app.example.com' }))), undefined);
			});

			test('SQL: an error the quote brings, a boolean pair that changes behaviour; an error already in the baseline is not one', () => {
				const quote = probe(probes, 'injection.sql', '"q" with a single quote');
				assert.ok(quote.requests[0].url.includes('q=shoes%27'));
				assert.strictEqual(quote.evaluate(answers(quote, json(500, '{"error":"You have an error in your SQL syntax"}')))?.confidence, 'firm');
				assert.strictEqual(quote.evaluate(answers(quote, json(200, CLEAN_BODY))), undefined);
				const noisy = plan(baseline({}, { body: '{"id":7,"log":"SQLSTATE[42000] earlier"}' }));
				const noisyQuote = probe(noisy, 'injection.sql', '"q" with a single quote');
				assert.strictEqual(noisyQuote.evaluate(answers(noisyQuote, json(200, '{"id":7,"log":"SQLSTATE[42000] earlier"}'))), undefined);
				const pair = probe(probes, 'injection.sql', '"q" with a true and a false');
				assert.strictEqual(pair.requests.length, 2);
				assert.strictEqual(pair.evaluate(answers(pair, json(200, CLEAN_BODY), json(200, '{"items":[],"total":0}')))?.confidence, 'tentative');
				assert.strictEqual(pair.evaluate(answers(pair, json(200, CLEAN_BODY), json(200, CLEAN_BODY))), undefined);
			});

			test('NoSQL operators', () => {
				const nosql = probe(probes, 'injection.nosql', '"q"');
				assert.ok(nosql.requests[1].url.includes(encodeURIComponent('q[$gt]')) || nosql.requests[1].url.includes('q[$gt]') || nosql.requests[1].url.includes('q%5B%24gt%5D'));
				assert.strictEqual(nosql.evaluate(answers(nosql, json(200, CLEAN_BODY), json(500, 'MongoServerError: unknown operator: $gt')))?.confidence, 'firm');
				assert.strictEqual(nosql.evaluate(answers(nosql, json(200, CLEAN_BODY), json(200, CLEAN_BODY))), undefined);
			});

			test('templates: worked out is a finding, echoed is not', () => {
				const template = probe(probes, 'injection.template', '"q" with template expressions');
				assert.strictEqual(template.evaluate(answers(template, json(200, '{"q":"volt49a#{7*7}b"}')))?.confidence, 'certain');
				assert.strictEqual(template.evaluate(answers(template, json(200, '{"q":"volt${7*7}a#{7*7}b<%= 7*7 %>c"}'))), undefined);
				const braces = probe(probes, 'injection.template', '"q" with {{7*7}}');
				assert.strictEqual(braces.literal, true, 'sent as written, never through variable filling');
				assert.ok(braces.evaluate(answers(braces, json(200, '{"q":"volt49d"}'))));
			});

			test('XSS: unescaped in HTML only', () => {
				const xss = probe(probes, 'injection.xss', '"q"');
				assert.ok(xss.evaluate(answers(xss, { status: 200, headers: { 'content-type': 'text/html' }, body: '<p>Results for <volt-xss-probe></p>' })));
				assert.strictEqual(xss.evaluate(answers(xss, json(200, '{"q":"<volt-xss-probe>"}'))), undefined);
				assert.strictEqual(xss.evaluate(answers(xss, { status: 200, headers: { 'content-type': 'text/html' }, body: '<p>&lt;volt-xss-probe&gt;</p>' })), undefined);
			});

			test('path traversal on file-like parameters, Unix and Windows', () => {
				const unix = probe(probes, 'injection.pathTraversal', '"file" as ../../../../etc/passwd');
				assert.ok(unix.evaluate(answers(unix, { status: 200, headers: {}, body: 'root:x:0:0:root:/root:/bin/bash' })));
				assert.strictEqual(unix.evaluate(answers(unix, json(404, '{"error":"no such report"}'))), undefined);
				const windows = probe(probes, 'injection.pathTraversal', 'win.ini');
				assert.ok(windows.evaluate(answers(windows, { status: 200, headers: {}, body: '; for 16-bit app support\n[fonts]\n' })));
			});

			test('command echo: the worked-out sum, not the echoed payload', () => {
				const command = probe(probes, 'injection.command', '"q"');
				assert.ok(command.evaluate(answers(command, json(200, '{"q":"shoes volt42cmd"}'))));
				assert.strictEqual(command.evaluate(answers(command, json(200, '{"q":"shoes;echo volt$((6*7))cmd"}'))), undefined);
			});

			test('open redirect to the scan host only', () => {
				const redirect = probe(probes, 'redirect.open', '"next"');
				assert.strictEqual(redirect.evaluate(answers(redirect, { status: 302, headers: { location: 'https://volt-security-scan.invalid/' }, body: '' }))?.confidence, 'certain');
				assert.strictEqual(redirect.evaluate(answers(redirect, { status: 302, headers: { location: '/home' }, body: '' })), undefined);
			});

			test('oversized input and HTTP downgrade', () => {
				const big = probe(probes, 'input.oversized');
				assert.ok(big.requests[0].url.length > 100_000);
				assert.ok(big.evaluate(answers(big, json(500, 'Internal Server Error'))));
				assert.strictEqual(big.evaluate(answers(big, json(413, 'Payload Too Large'))), undefined);
				const downgrade = probe(probes, 'transport.downgrade');
				assert.ok(downgrade.evaluate(answers(downgrade, json(200, CLEAN_BODY))));
				assert.strictEqual(downgrade.evaluate(answers(downgrade, { status: 301, headers: { location: URL_ }, body: '' })), undefined);
			});

			test('rate limiting: all answered is a finding, one 429 is not, a stopped burst says nothing', () => {
				const burst = probe(plan(baseline({}, { without: ['ratelimit-limit'] })), 'limits.burst');
				assert.strictEqual(burst.evaluate(answers(burst, json(200, CLEAN_BODY)))?.severity, 'low');
				const limited = burst.requests.map((sent, index) => ({ request: sent, response: json(index === 10 ? 429 : 200, CLEAN_BODY) }));
				assert.strictEqual(burst.evaluate(limited), undefined);
				assert.strictEqual(burst.evaluate(answers(burst, json(200, CLEAN_BODY)).slice(0, 4)), undefined);
			});

			test('mass assignment and content type, with data-changing tests on', () => {
				const post = baseline({ method: 'POST', url: 'https://api.example.com/users', headers: [['Authorization', `Bearer ${TOKEN}`], ['Content-Type', 'application/json']], body: '{"name":"Ada"}' }, { status: 201, body: '{"id":9,"name":"Ada"}' });
				const opted = plan(post, { includeUnsafeMethods: true });
				const mass = probe(opted, 'access.massAssignment');
				const sent = JSON.parse(mass.requests[0].body!);
				assert.strictEqual(sent.isAdmin, true);
				assert.strictEqual(sent.role, 'admin');
				assert.strictEqual(mass.evaluate(answers(mass, json(201, '{"id":10,"name":"Ada","isAdmin":true}')))?.confidence, 'firm');
				assert.strictEqual(mass.evaluate(answers(mass, json(201, '{"id":10,"name":"Ada"}'))), undefined);
				const plain = probe(opted, 'input.contentType', 'text/plain');
				assert.ok(plain.evaluate(answers(plain, json(201, '{"id":11,"name":"Ada"}'))));
				assert.strictEqual(plain.evaluate(answers(plain, json(415, '{"error":"unsupported"}'))), undefined);
			});
		});
	});

	suite('summaries, reports, the file', () => {

		test('score and grade, explained; triaged findings do not count; a sure critical caps the score', () => {
			const findings = [made('cors.reflectedOrigin', 'high', 'certain', '/a'), made('disclosure.stackTrace', 'medium', 'firm', '/b'), made('headers.cacheControl', 'low', 'tentative', '/c'), made('limits.rateLimitHeaders', 'info', 'tentative', '/d')];
			const summary = summarizeHttpSecurity(findings);
			assert.strictEqual(summary.score, 78);
			assert.strictEqual(summary.grade, 'C');
			assert.deepStrictEqual(summary.bySeverity, { critical: 0, high: 1, medium: 1, low: 1, info: 1 });
			assert.strictEqual(summary.byOwasp.length, 10);
			assert.deepStrictEqual(summary.byOwasp.filter(item => item.count).map(item => [item.id, item.count]), [['API4', 1], ['API8', 3]]);
			assert.strictEqual(summary.byEndpoint[0].endpoint, 'GET /a');
			assert.ok(summary.explanation.includes('78 of 100 (C)'));
			const triaged = summarizeHttpSecurity(findings, { [findings[0].fingerprint]: 'falsePositive' });
			assert.strictEqual(triaged.open, 3);
			assert.strictEqual(triaged.triaged, 1);
			assert.strictEqual(triaged.score, 93);
			assert.strictEqual(triaged.grade, 'A');
			const critical = summarizeHttpSecurity([made('auth.jwt', 'critical', 'certain')]);
			assert.strictEqual(critical.score, 49);
			assert.strictEqual(critical.grade, 'F');
			assert.strictEqual(summarizeHttpSecurity([]).grade, 'A');
		});

		const file = (findings: IHttpSecurityFinding[], triage: IHttpSecurityFile['triage'] = {}): IHttpSecurityFile => {
			const lastScan: IHttpSecurityScanRecord = { at: '2026-11-18T12:00:00.000Z', durationMs: 1200, requests: 4, probes: 0, active: false, findings };
			return { ...parseHttpSecurityFile('{}', 'Shop API'), triage, lastScan };
		};

		test('SARIF 2.1.0: rules, results, levels, fingerprints, suppressed triage', () => {
			const findings = [made('cors.reflectedOrigin', 'high', 'certain', '/a'), made('disclosure.stackTrace', 'medium', 'firm', '/b'), made('headers.cacheControl', 'low', 'firm', '/c')];
			const sarif = JSON.parse(httpSecuritySarifReport(file(findings, { [findings[2].fingerprint]: 'accepted' })));
			assert.strictEqual(sarif.version, '2.1.0');
			assert.ok(String(sarif.$schema).includes('sarif-2.1.0'));
			const run = sarif.runs[0];
			assert.strictEqual(run.tool.driver.name, 'Volt Client Security Scan');
			assert.deepStrictEqual(run.tool.driver.rules.map((rule: { id: string }) => rule.id), ['cors.reflectedOrigin', 'disclosure.stackTrace', 'headers.cacheControl']);
			assert.deepStrictEqual(run.results.map((result: { level: string; ruleIndex: number }) => [result.level, result.ruleIndex]), [['error', 0], ['warning', 1], ['note', 2]]);
			assert.strictEqual(run.results[0].partialFingerprints['voltSecurity/v1'], findings[0].fingerprint);
			assert.strictEqual(run.results[0].locations[0].physicalLocation.artifactLocation.uri, 'https://api.example.com/a');
			assert.strictEqual(run.results[2].suppressions[0].kind, 'external');
			assert.strictEqual(run.results[0].suppressions, undefined);
		});

		test('HTML is self-contained and escapes every value; Markdown and JSON carry the same findings', () => {
			const evil = made('disclosure.stackTrace', 'medium', 'firm', '/b', '<script>alert(1)</script>');
			const html = httpSecurityHtmlReport(file([evil, made('cors.reflectedOrigin', 'high', 'certain')]));
			assert.ok(html.startsWith('<!DOCTYPE html>'));
			assert.ok(html.includes('<svg') && html.includes('API8'));
			assert.ok(!html.includes('<script>alert'), 'no markup from a scan gets through');
			assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
			assert.ok(!/<script\b|<link\b|src="http/i.test(html), 'nothing loaded from elsewhere');
			const markdown = httpSecurityMarkdownReport(file([evil], { [evil.fingerprint]: 'fixed' }));
			assert.ok(markdown.startsWith('# Security scan: Shop API'));
			assert.ok(markdown.includes('## By OWASP API Security Top 10 (2023)'));
			assert.ok(markdown.includes('## Triaged') && markdown.includes('- Fixed: <script>'));
			assert.strictEqual(httpSecurityMarkdownReport(parseHttpSecurityFile('{}', 'Empty')), '# Empty\n\nNo scan has run yet.\n');
			const json = JSON.parse(httpSecurityJsonReport(file([evil], { [evil.fingerprint]: 'fixed' })));
			assert.strictEqual(json.findings.length, 1);
			assert.strictEqual(json.findings[0].triage, 'fixed');
			assert.strictEqual(json.summary.open, 0);
		});

		test('the file: defaults, bounds, unknown values dropped, round trip', () => {
			const parsed = parseHttpSecurityFile(JSON.stringify({
				volt: 'security', name: 'Shop', targets: ['http/shop.json', { collection: 'http/b.json', path: 'Users / Get' }, { nope: 1 }],
				checks: { 'headers.hsts': false, 'made.up': false }, options: { active: 'yes', requestsPerSecond: 1000, maxProbesPerRequest: -3 },
				authorizedHosts: [{ host: 'API.Example.com', at: '2026-11-18' }, { host: 'api.example.com' }], triage: { abc: 'fixed', def: 'bogus' },
			}), 'fallback');
			assert.deepStrictEqual(parsed.targets, [{ collection: 'http/shop.json' }, { collection: 'http/b.json', path: ['Users', 'Get'] }]);
			assert.deepStrictEqual(parsed.checks, { 'headers.hsts': false });
			assert.deepStrictEqual(parsed.options, { active: false, includeUnsafeMethods: false, requestsPerSecond: 20, maxProbesPerRequest: 0, timeoutMs: 15_000 });
			assert.deepStrictEqual(parsed.triage, { abc: 'fixed' });
			assert.deepStrictEqual(parsed.authorizedHosts.map(item => item.host), ['api.example.com']);
			assert.strictEqual(isHttpSecurityCheckEnabled(parsed, 'headers.hsts'), false);
			assert.strictEqual(isHttpSecurityCheckEnabled(parsed, 'auth.missing'), true);
			assert.deepStrictEqual(parseHttpSecurityFile(serializeHttpSecurityFile(parsed), 'x'), parsed);
			assert.strictEqual(parseHttpSecurityFile('{}', 'Fresh').options.requestsPerSecond, 5, 'five a second by default');
			assert.strictEqual(parseHttpSecurityFile('{}', 'Fresh').options.active, false, 'active checks are off by default');
			assert.throws(() => parseHttpSecurityFile('{"volt":"automation"}', 'x'));
		});

		test('every check has its catalogue entry', () => {
			const ids = new Set<string>();
			for (const check of HTTP_SECURITY_CHECKS) {
				assert.ok(!ids.has(check.id), check.id);
				ids.add(check.id);
				assert.match(check.owasp, /^API(?:[1-9]|10)$/);
				assert.ok(check.title && check.description && check.risk && check.remediation, check.id);
			}
			assert.ok(HTTP_SECURITY_CHECKS.filter(check => check.active).length >= 15);
		});
	});
});
