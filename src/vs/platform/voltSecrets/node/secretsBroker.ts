/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from '../../../base/common/path.js';
import { BrokerError, brokerEvaluate, ByteBudget, contextChain, IBroker, IBrokerAudit, IBrokerAuthority, IBrokerCallers } from '../../voltSandbox/common/broker.js';
import { ICallContext, isFirstPartySubject, parseSubjectKey, SubjectKey } from '../../voltSandbox/common/principals.js';
import { ISecretRecord, ISecretsStore, SECRETS_BROKER_LIMITS, secretHeader, secretHostAllowed, SecretScheme, SecretsInputError, validateInjectHosts, validateSecretHeader, validateSecretService } from '../common/secretsBroker.js';

/**
 * The secrets broker (spec I.3, INV-24, INV-37): secrets by reference.
 *
 * - `ref {service}` (`secrets.use:<service>`) returns an opaque reference bound to the caller's
 *   subject: an HMAC over `(subject, service)` with a per-install key. It survives a restart (the
 *   key is kept) and is useless to any other subject, including the same extension under another
 *   signer (CRED-7).
 * - The value goes out only at the point of use: {@link SecretsBroker.authorize} gives the network
 *   broker the header for a request to a host the secret's own `injectHosts` lists. It is not a
 *   method a principal can call.
 * - `read {ref}` returns the raw value only to a first-party subject whose ceiling holds
 *   `secrets.read` (critical); a third party never gets it, whatever its grants (CRED-6).
 * - `set`, `delete`, `list` work in the caller's own namespace; the user (through core) may set a
 *   secret into any subject's namespace ({@link SecretsBroker.storeForSubject}).
 *
 * No value ever goes into an audit record, an error message, an environment or an argv (INV-24).
 */

const REF_VERSION = 'vsr1';

export interface ISecretsBrokerOptions {
	readonly authority: IBrokerAuthority;
	readonly callers: IBrokerCallers;
	readonly audit: IBrokerAudit;
	readonly store: ISecretsStore;
	/** The per-install key references are signed with (32 bytes or more). */
	readonly refKey: Buffer;
	readonly now?: () => number;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new BrokerError('invalid', 'the arguments must be an object');
	}
	return value as Record<string, unknown>;
}

function checked<T>(fn: () => T): T {
	try {
		return fn();
	} catch (err) {
		throw err instanceof SecretsInputError ? new BrokerError('invalid', err.message) : err;
	}
}

export class SecretsBroker implements IBroker {

	readonly id = 'secrets';
	private readonly calls: ByteBudget;
	private readonly now: () => number;

	constructor(private readonly options: ISecretsBrokerOptions) {
		if (options.refKey.length < 32) {
			throw new Error('the secrets broker needs a reference key of 32 bytes or more');
		}
		this.now = options.now ?? Date.now;
		this.calls = new ByteBudget(SECRETS_BROKER_LIMITS.callsPerMinute, 60_000, this.now);
	}

	async handle(context: ICallContext, method: string, args: unknown): Promise<unknown> {
		switch (method) {
			case 'ref': return this.ref(context, args);
			case 'read': return this.read(context, args);
			case 'set': return this.set(context, args);
			case 'delete': return this.delete(context, args);
			case 'list': return this.list(context);
		}
		throw new BrokerError('invalid', `the secrets broker has no method ${String(method)}`);
	}

	/** A reference to the caller's own `service` secret. */
	ref(context: ICallContext, args: unknown): Promise<{ readonly ref: string }> {
		return this.audited(context, 'ref', args, async () => {
			const service = checked(() => validateSecretService(record(args).service));
			brokerEvaluate(this.options.authority, { capability: `secrets.use:${service}`, target: service }, context);
			return { ref: this.mint(context.principal.subject, service) };
		});
	}

	/** The raw value: only for a first-party subject the Authority gives `secrets.read` (its ceiling). */
	read(context: ICallContext, args: unknown): Promise<{ readonly value: string }> {
		return this.audited(context, 'read', args, async () => {
			const service = this.resolve(context, record(args).ref);
			const subject = context.principal.subject;
			if (!isFirstPartySubject(subject) || context.onBehalfOf.some(caller => !isFirstPartySubject(caller.subject))) {
				throw new BrokerError('denied', 'secret values are never returned to a third party or on its behalf: use the reference in a request');
			}
			brokerEvaluate(this.options.authority, { capability: 'secrets.read', target: service }, context);
			const secret = await this.options.store.get(subject, service);
			if (!secret) {
				throw new BrokerError('io', `no ${service} secret is stored`);
			}
			return { value: secret.value };
		});
	}

	/** Stores a secret in the caller's own namespace (`secrets.use:<service>`); the value is never readable back by it. */
	set(context: ICallContext, args: unknown): Promise<void> {
		return this.audited(context, 'set', args, async () => {
			const input = record(args);
			const service = checked(() => validateSecretService(input.service));
			brokerEvaluate(this.options.authority, { capability: `secrets.use:${service}`, target: service }, context);
			const subject = context.principal.subject;
			const names = await this.options.store.list(subject);
			if (!names.includes(service) && names.length >= SECRETS_BROKER_LIMITS.perNamespace) {
				throw new BrokerError('limit', `a subject keeps at most ${SECRETS_BROKER_LIMITS.perNamespace} secrets`);
			}
			await this.options.store.set(subject, service, this.secretRecord(input));
		});
	}

	delete(context: ICallContext, args: unknown): Promise<{ readonly deleted: boolean }> {
		return this.audited(context, 'delete', args, async () => {
			const service = checked(() => validateSecretService(record(args).service));
			brokerEvaluate(this.options.authority, { capability: `secrets.use:${service}`, target: service }, context);
			return { deleted: await this.options.store.delete(context.principal.subject, service) };
		});
	}

	/** The names of the caller's own secrets (never their values). */
	list(context: ICallContext): Promise<{ readonly services: readonly string[] }> {
		return this.audited(context, 'list', undefined, async () => ({ services: [...await this.options.store.list(context.principal.subject)] }));
	}

	/**
	 * For the network broker (I.4) only, never reachable through {@link handle}: the header that
	 * authenticates `url` with `ref`, after checking that the reference is the caller's, that the
	 * Authority still gives it `secrets.use:<service>` (a revoke stops the next request), that the
	 * request is https, and that its host is one the secret lists.
	 */
	authorize(context: ICallContext, ref: unknown, url: string): Promise<{ readonly name: string; readonly value: string }> {
		return this.audited(context, 'inject', { ref, url }, async () => {
			const service = this.resolve(context, ref);
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				throw new BrokerError('invalid', 'the request URL is not absolute');
			}
			if (parsed.protocol !== 'https:') {
				throw new BrokerError('denied', 'a secret is sent over https only');
			}
			if (parsed.username || parsed.password) {
				throw new BrokerError('invalid', 'the request URL carries credentials of its own');
			}
			brokerEvaluate(this.options.authority, { capability: `secrets.use:${service}`, target: service }, context);
			const secret = await this.options.store.get(context.principal.subject, service);
			if (!secret) {
				throw new BrokerError('io', `no ${service} secret is stored`);
			}
			if (!secretHostAllowed(parsed.hostname, secret.injectHosts)) {
				throw new BrokerError('denied', `the ${service} secret is not sent to ${parsed.hostname}: it goes only to ${secret.injectHosts.join(', ')}`);
			}
			return checked(() => secretHeader(secret));
		});
	}

	/** The user's own action through core: a secret for `namespace` (an extension's, a feature's). */
	async storeForSubject(namespace: string, service: string, input: { readonly value: string; readonly injectHosts: readonly string[]; readonly header?: string; readonly scheme?: SecretScheme }): Promise<void> {
		const subject = parseSubjectKey(namespace);
		if (!subject || subject === 'user') {
			throw new BrokerError('invalid', `${namespace} is not a subject`);
		}
		const name = checked(() => validateSecretService(service));
		await this.options.store.set(subject, name, this.secretRecord({ ...input }));
	}

	// --- references ------------------------------------------------------------------------------

	private signature(subject: SubjectKey, service: string): Buffer {
		return createHmac('sha256', this.options.refKey).update(`${REF_VERSION}\0${subject}\0${service}`).digest();
	}

	private mint(subject: SubjectKey, service: string): string {
		return `${REF_VERSION}.${Buffer.from(service, 'utf8').toString('base64url')}.${this.signature(subject, service).toString('base64url')}`;
	}

	/** The service `ref` names, if it is the caller's; another subject's (or a forged) reference is refused alike. */
	private resolve(context: ICallContext, ref: unknown): string {
		const parts = typeof ref === 'string' && ref.length <= 256 ? ref.split('.') : [];
		if (parts.length !== 3 || parts[0] !== REF_VERSION) {
			throw new BrokerError('handle', 'not a secret reference of this caller');
		}
		let service: string;
		try {
			service = validateSecretService(Buffer.from(parts[1], 'base64url').toString('utf8'));
		} catch {
			throw new BrokerError('handle', 'not a secret reference of this caller');
		}
		const given = Buffer.from(parts[2], 'base64url');
		const expected = this.signature(context.principal.subject, service);
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
			throw new BrokerError('handle', 'not a secret reference of this caller');
		}
		return service;
	}

	private secretRecord(input: Record<string, unknown>): ISecretRecord {
		return checked(() => {
			const value = input.value;
			if (typeof value !== 'string' || !value) {
				throw new SecretsInputError('value must be a non-empty string');
			}
			if (Buffer.byteLength(value) > SECRETS_BROKER_LIMITS.valueBytes) {
				throw new SecretsInputError(`a secret is at most ${SECRETS_BROKER_LIMITS.valueBytes} bytes`);
			}
			const scheme = input.scheme;
			if (scheme !== undefined && scheme !== 'bearer' && scheme !== 'basic' && scheme !== 'raw') {
				throw new SecretsInputError('scheme must be bearer, basic or raw');
			}
			const header = validateSecretHeader(input.header);
			const secret: ISecretRecord = { value, injectHosts: validateInjectHosts(input.injectHosts), ...(header ? { header } : {}), ...(scheme ? { scheme } : {}), updatedAt: this.now() };
			// A value that can't go out as a header is refused when stored, not when used.
			secretHeader(secret);
			return secret;
		});
	}

	// --- the contract ---------------------------------------------------------------------------

	private async audited<T>(context: ICallContext, method: string, args: unknown, run: () => Promise<T>): Promise<T> {
		const target = this.auditTarget(args);
		const base = { ts: this.now(), broker: this.id, method, principal: context.principal.id, subject: context.principal.subject, chain: contextChain(context), epoch: this.options.authority.epoch, ...(target ? { target } : {}) };
		try {
			if (!this.options.callers.verify(context)) {
				throw new BrokerError('unauthenticated', 'the call does not come from a principal this host knows');
			}
			if (!this.calls.take(context.principal.id, 1)) {
				throw new BrokerError('limit', `more than ${SECRETS_BROKER_LIMITS.callsPerMinute} secrets calls in the last minute`);
			}
			const result = await run();
			this.options.audit.record({ ...base, decision: 'allow' });
			return result;
		} catch (err) {
			// Never the store's own message: it might quote what it was given.
			const error = err instanceof BrokerError ? err : new BrokerError('io', 'the secret store failed');
			this.options.audit.record({ ...base, decision: 'deny', code: error.code, ...(error.decision?.deniedBy ? { deniedBy: error.decision.deniedBy } : {}) });
			throw error;
		}
	}

	/** The service (and host, for an injection) a call is about; never a value. */
	private auditTarget(args: unknown): string | undefined {
		if (!args || typeof args !== 'object') {
			return undefined;
		}
		const input = args as Record<string, unknown>;
		if (typeof input.service === 'string') {
			return input.service;
		}
		if (typeof input.ref === 'string') {
			const service = input.ref.split('.')[1];
			let host = '';
			try {
				host = typeof input.url === 'string' ? ` ${new URL(input.url).hostname}` : '';
			} catch {
				// not a URL
			}
			return service ? `${Buffer.from(service, 'base64url').toString('utf8').slice(0, 64)}${host}` : undefined;
		}
		return undefined;
	}
}

export const DEFAULT_SECRETS_DIR = join(homedir(), '.volt', 'trust', 'secrets');

/**
 * The fallback store (I.3): one 0600 file per namespace in `~/.volt/trust/secrets` (0700), which
 * every sandbox is denied. The OS keychain backends implement the same interface.
 */
export class FileSecretsStore implements ISecretsStore {

	private queue: Promise<unknown> = Promise.resolve();

	constructor(readonly dir = DEFAULT_SECRETS_DIR) { }

	/** The per-install reference key (created once, 0600). */
	async refKey(): Promise<Buffer> {
		const file = join(this.dir, 'ref.key');
		const existing = await fs.readFile(file).catch(() => undefined);
		if (existing && existing.length >= 32) {
			return existing;
		}
		await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
		const key = randomBytes(32);
		try {
			await fs.writeFile(file, key, { mode: 0o600, flag: 'wx' });
			return key;
		} catch {
			// Another process created it first: use that one.
			return fs.readFile(file);
		}
	}

	async get(namespace: SubjectKey, service: string): Promise<ISecretRecord | undefined> {
		const all = await this.load(namespace);
		return Object.prototype.hasOwnProperty.call(all, service) ? all[service] : undefined;
	}

	set(namespace: SubjectKey, service: string, secret: ISecretRecord): Promise<void> {
		return this.serial(async () => {
			const all = await this.load(namespace);
			await this.save(namespace, { ...all, [service]: secret });
		});
	}

	delete(namespace: SubjectKey, service: string): Promise<boolean> {
		return this.serial(async () => {
			const all = await this.load(namespace);
			if (!Object.prototype.hasOwnProperty.call(all, service)) {
				return false;
			}
			const { [service]: _gone, ...rest } = all;
			await this.save(namespace, rest);
			return true;
		});
	}

	async list(namespace: SubjectKey): Promise<readonly string[]> {
		return Object.keys(await this.load(namespace)).sort();
	}

	private file(namespace: SubjectKey): string {
		return join(this.dir, `${createHash('sha256').update(namespace).digest('hex').slice(0, 40)}.json`);
	}

	private async load(namespace: SubjectKey): Promise<Record<string, ISecretRecord>> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.file(namespace), 'utf8')) as { namespace?: unknown; secrets?: unknown };
			return parsed?.namespace === namespace && parsed.secrets && typeof parsed.secrets === 'object' ? parsed.secrets as Record<string, ISecretRecord> : {};
		} catch {
			return {};
		}
	}

	private async save(namespace: SubjectKey, secrets: Record<string, ISecretRecord>): Promise<void> {
		await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
		const file = this.file(namespace);
		const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
		await fs.writeFile(temp, JSON.stringify({ namespace, secrets }), { mode: 0o600 });
		await fs.rename(temp, file);
	}

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn);
		this.queue = run.catch(() => undefined);
		return run;
	}
}
