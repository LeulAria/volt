/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { bareCapability, capabilityClass, capabilityIdCovers, capabilityTargetMatches, capabilityVersion, versionedCapability } from '../../voltPlugins/common/capabilityCatalog.js';
import { isFirstPartySubject, parseSubjectKey, SubjectKey } from './principals.js';

/**
 * Grants (spec G.1, G.4, G.9): what the user, an admin or a signed preset allowed a subject, and
 * the grant store's file format. Pure: the store that reads and writes `~/.volt/trust/grants.json`
 * is `node/grantStore.ts`; the Policy Authority reads grants through a snapshot (`authority.ts`).
 */

export type GrantKind = 'once' | 'session' | 'workspace' | 'persistent' | 'picker';
export type GrantSource = 'user' | 'ceiling' | 'preset' | 'admin' | 'developer';

const GRANT_KINDS: ReadonlySet<string> = new Set<GrantKind>(['once', 'session', 'workspace', 'persistent', 'picker']);
const GRANT_SOURCES: ReadonlySet<string> = new Set<GrantSource>(['user', 'ceiling', 'preset', 'admin', 'developer']);

export interface IGrantScope {
	/** Targets it is limited to (`*` globs: hosts, command ids, chat ids, paths). None: any target. */
	readonly targets?: readonly string[];
	/** A flow approval (`flow.send`): the destinations the user saw on the card; `*` for any host. */
	readonly hosts?: readonly string[];
}

export interface IGrant {
	readonly id: string;
	readonly subject: SubjectKey;
	/** `id@version`. */
	readonly capability: string;
	readonly scope: IGrantScope;
	readonly kind: GrantKind;
	/** `workspace` grants: the workspace root they hold in. */
	readonly workspace?: string;
	/** `session` grants: the chat or plugin host instance they hold for. */
	readonly sessionId?: string;
	readonly expiresAt?: number;
	readonly source: GrantSource;
	readonly grantedAt: number;
	readonly lastUsedAt: number;
	/** The store epoch that committed it: a snapshot at an earlier epoch doesn't see it. */
	readonly epoch: number;
	readonly revoked?: boolean;
	/** A critical capability is held only with the user's typed confirmation (G.8), never by prompt. */
	readonly confirmed?: boolean;
}

/** The user refused a capability: no more prompts for it (G.12). */
export interface IRefusal {
	readonly subject: SubjectKey;
	readonly capability: string;
	readonly at: number;
}

/**
 * G.6 flow approvals: a grant on the caller C ("this chat may send data to P"), target P's subject,
 * `scope.hosts` the destinations approved. Not a catalog capability: only the egress rule reads it.
 */
export const FLOW_CAPABILITY = 'flow.send@1';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Third-party persistent grants expire after 30 days unused (G.4). */
export const UNUSED_GRANT_TTL_MS = 30 * DAY_MS;
/** High-class persistent grants expire after 90 days regardless (G.4). */
export const HIGH_GRANT_TTL_MS = 90 * DAY_MS;

/** When `grant` stops holding, by its own expiry and G.4's; undefined: never by time. */
export function grantExpiry(grant: IGrant): number | undefined {
	let at = grant.expiresAt;
	const earlier = (value: number) => {
		at = at === undefined ? value : Math.min(at, value);
	};
	if (grant.kind === 'persistent' && !isFirstPartySubject(grant.subject) && grant.source !== 'admin' && grant.source !== 'ceiling') {
		earlier(grant.lastUsedAt + UNUSED_GRANT_TTL_MS);
		if (capabilityClass(grant.capability) === 'high') {
			earlier(grant.grantedAt + HIGH_GRANT_TTL_MS);
		}
	}
	return at;
}

/** What a grant is checked against: the snapshot's time and epoch, and where the request runs. */
export interface IGrantContext {
	readonly asOf: number;
	readonly epoch: number;
	readonly workspace?: string;
	/** Chat ids and plugin host instance ids `session` grants may name. */
	readonly sessionIds: readonly string[];
}

/** G.2 step 3: not revoked, not expired, committed at or before the epoch, and for this workspace or session. */
export function grantValid(grant: IGrant, context: IGrantContext): boolean {
	if (grant.revoked || grant.epoch > context.epoch) {
		return false;
	}
	const expiry = grantExpiry(grant);
	if (expiry !== undefined && expiry <= context.asOf) {
		return false;
	}
	if (grant.kind === 'workspace' && (!grant.workspace || grant.workspace !== context.workspace)) {
		return false;
	}
	if (grant.kind === 'session' && (!grant.sessionId || !context.sessionIds.includes(grant.sessionId))) {
		return false;
	}
	if (capabilityClass(grant.capability) === 'critical' && (!grant.confirmed || grant.source === 'preset')) {
		return false;
	}
	return true;
}

/** Whether `grant` holds `capability` on `target` (ignoring validity). */
export function grantCovers(grant: IGrant, capability: string, target: string | undefined): boolean {
	if (!capabilityIdCovers(grant.capability, capability)) {
		return false;
	}
	const targets = grant.scope.targets;
	return !targets?.length || (target !== undefined && targets.some(pattern => capabilityTargetMatches(pattern, target)));
}

/** The earliest time after `asOf` at which one of `grants` stops holding: when the snapshot must be rebuilt (G.2 time-explicit). */
export function nextGrantExpiry(grants: readonly IGrant[], asOf: number): number | undefined {
	let next: number | undefined;
	for (const grant of grants) {
		const at = grantExpiry(grant);
		if (at !== undefined && at > asOf && (next === undefined || at < next)) {
			next = at;
		}
	}
	return next;
}

// --- canonical JSON (digests, the store file) ---------------------------------------------------

/** JSON with object keys sorted, `undefined` members left out: the same value always gives the same text. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value) ?? 'null';
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
	return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

// --- the store file (G.9) ----------------------------------------------------------------------

/** Grant-store schema written by this build. */
export const GRANT_STORE_SCHEMA = 1;

export interface IGrantStoreData {
	readonly schemaVersion: number;
	readonly epoch: number;
	readonly grants: readonly IGrant[];
	readonly refusals: readonly IRefusal[];
}

/**
 * `missing`: no file. `torn`: unreadable, loaded empty (F.11: third party empty, first party is its
 * compiled ceiling; never "allow all"). `newer`: written by a newer Volt, read-only with every
 * third-party grant absent. `migrated`: an older schema or capability ids, migrated in memory.
 */
export type GrantStoreStatus = 'ok' | 'missing' | 'torn' | 'newer' | 'migrated';

export interface IGrantStoreLoad {
	readonly data: IGrantStoreData;
	readonly status: GrantStoreStatus;
	/** A newer Volt's file: never written back. */
	readonly readOnly: boolean;
	/** What was dropped or changed, one line each. */
	readonly notes: readonly string[];
}

/** A schema migration: the raw file object of version N to version N + 1. Pure. */
export type GrantStoreSchemaMigration = (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>;

/**
 * Schema migrations by the version they migrate from. Version 1 is the first schema, so there is
 * none yet; a new schema adds `[1]: v1 => v2` here, with a test.
 */
export const GRANT_STORE_SCHEMA_MIGRATIONS: Readonly<Record<number, GrantStoreSchemaMigration>> = Object.freeze({});

/**
 * Capability id migrations (G.9): `from@v → to@v'`. Narrowing ones apply; widening ones drop the
 * grant, so the plugin asks again.
 */
export interface ICapabilityMigration {
	readonly to: string;
	readonly narrowing: boolean;
}

export const CAPABILITY_MIGRATIONS: Readonly<Record<string, ICapabilityMigration>> = Object.freeze({});

/** A grant's capability id after the migration table: undefined when a widening migration drops it. */
export function migrateCapability(id: string, table: Readonly<Record<string, ICapabilityMigration>> = CAPABILITY_MIGRATIONS): string | undefined {
	let current = id === FLOW_CAPABILITY ? id : versionedCapability(id);
	const seen = new Set<string>();
	while (Object.prototype.hasOwnProperty.call(table, current) && !seen.has(current)) {
		seen.add(current);
		const step = table[current];
		if (!step.narrowing) {
			return undefined;
		}
		current = versionedCapability(step.to);
	}
	return current;
}

export function emptyGrantStore(epoch = 0): IGrantStoreData {
	return { schemaVersion: GRANT_STORE_SCHEMA, epoch, grants: [], refusals: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function stringList(value: unknown, max = 256): readonly string[] | undefined {
	return Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && item.length <= 1024) ? value as string[] : undefined;
}

/** Whether `id` names a capability Volt knows (or a flow approval). */
function knownCapability(id: string): boolean {
	return id === FLOW_CAPABILITY || capabilityClass(id) !== undefined;
}

/** One grant from the file, checked field by field; undefined (with a note) when it is not valid. */
function parseGrant(raw: unknown, notes: string[], table: Readonly<Record<string, ICapabilityMigration>>): IGrant | undefined {
	if (!isRecord(raw)) {
		notes.push('a grant that is not an object was dropped');
		return undefined;
	}
	const subject = typeof raw.subject === 'string' ? parseSubjectKey(raw.subject) : undefined;
	const id = typeof raw.id === 'string' && raw.id.length <= 128 ? raw.id : undefined;
	if (!subject || !id || subject === 'user' || typeof raw.capability !== 'string' || typeof raw.kind !== 'string' || !GRANT_KINDS.has(raw.kind)
		|| typeof raw.source !== 'string' || !GRANT_SOURCES.has(raw.source) || !finiteNumber(raw.grantedAt) || !finiteNumber(raw.epoch)) {
		notes.push(`grant ${String(raw.id)} is malformed and was dropped`);
		return undefined;
	}
	if (!knownCapability(raw.capability)) {
		notes.push(`grant ${id}: ${raw.capability} is not a Volt capability; dropped`);
		return undefined;
	}
	const capability = migrateCapability(raw.capability, table);
	if (!capability) {
		notes.push(`grant ${id}: ${raw.capability} was widened in a newer capability version; dropped so it is asked again`);
		return undefined;
	}
	if (capability !== raw.capability && capability !== versionedCapability(raw.capability)) {
		notes.push(`grant ${id}: ${raw.capability} migrated to ${capability}`);
	}
	const scope = isRecord(raw.scope) ? raw.scope : {};
	const targets = scope.targets === undefined ? undefined : stringList(scope.targets);
	const hosts = scope.hosts === undefined ? undefined : stringList(scope.hosts);
	if ((scope.targets !== undefined && !targets) || (scope.hosts !== undefined && !hosts)) {
		notes.push(`grant ${id}: its scope is malformed; dropped`);
		return undefined;
	}
	const kind = raw.kind as GrantKind;
	if ((kind === 'workspace' && typeof raw.workspace !== 'string') || (kind === 'session' && typeof raw.sessionId !== 'string')) {
		notes.push(`grant ${id}: a ${kind} grant without its ${kind}; dropped`);
		return undefined;
	}
	if (capabilityClass(capability) === 'critical' && raw.confirmed !== true) {
		notes.push(`grant ${id}: critical ${capability} without a typed confirmation; dropped`);
		return undefined;
	}
	return {
		id,
		subject,
		capability,
		scope: { ...(targets ? { targets } : {}), ...(hosts ? { hosts } : {}) },
		kind,
		...(typeof raw.workspace === 'string' ? { workspace: raw.workspace } : {}),
		...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
		...(finiteNumber(raw.expiresAt) ? { expiresAt: raw.expiresAt } : {}),
		source: raw.source as GrantSource,
		grantedAt: raw.grantedAt,
		lastUsedAt: finiteNumber(raw.lastUsedAt) ? raw.lastUsedAt : raw.grantedAt,
		epoch: raw.epoch,
		...(raw.revoked === true ? { revoked: true } : {}),
		...(raw.confirmed === true ? { confirmed: true } : {}),
	};
}

function parseRefusal(raw: unknown): IRefusal | undefined {
	if (!isRecord(raw) || typeof raw.subject !== 'string' || typeof raw.capability !== 'string' || !finiteNumber(raw.at)) {
		return undefined;
	}
	const subject = parseSubjectKey(raw.subject);
	return subject && subject !== 'user' && knownCapability(raw.capability) ? { subject, capability: versionedCapability(raw.capability), at: raw.at } : undefined;
}

export interface IGrantStoreLoadOptions {
	readonly schemaMigrations?: Readonly<Record<number, GrantStoreSchemaMigration>>;
	readonly capabilityMigrations?: Readonly<Record<string, ICapabilityMigration>>;
}

/** Reads the store file's text (undefined: no file). Pure: never throws, never "allow all". */
export function loadGrantStore(text: string | undefined, options: IGrantStoreLoadOptions = {}): IGrantStoreLoad {
	if (text === undefined) {
		return { data: emptyGrantStore(), status: 'missing', readOnly: false, notes: [] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { data: emptyGrantStore(), status: 'torn', readOnly: false, notes: ['the grant store is not valid JSON; permissions were reset'] };
	}
	// An older schema's shape is its migration's to judge; this one's must have its grants list.
	if (!isRecord(raw) || !Number.isInteger(raw.schemaVersion) || (raw.schemaVersion as number) < 0 || !finiteNumber(raw.epoch) || raw.epoch < 0
		|| ((raw.schemaVersion as number) >= GRANT_STORE_SCHEMA && !Array.isArray(raw.grants))) {
		return { data: emptyGrantStore(), status: 'torn', readOnly: false, notes: ['the grant store is not a grant store; permissions were reset'] };
	}
	const notes: string[] = [];
	const schemaMigrations = options.schemaMigrations ?? GRANT_STORE_SCHEMA_MIGRATIONS;
	const capabilityTable = options.capabilityMigrations ?? CAPABILITY_MIGRATIONS;
	let version = raw.schemaVersion as number;
	let current: Readonly<Record<string, unknown>> = raw;
	let migrated = false;
	if (version > GRANT_STORE_SCHEMA) {
		// A newer Volt's file: what this build can read, without any third-party grant, and never written back.
		const grants = (current.grants as unknown[]).map(grant => parseGrant(grant, notes, capabilityTable)).filter((grant): grant is IGrant => !!grant && !grant.subject.startsWith('plugin:'));
		notes.push(`the grant store was written by a newer Volt (schema ${version}); it is read-only and third-party grants are treated as absent`);
		return { data: { schemaVersion: version, epoch: raw.epoch, grants, refusals: [] }, status: 'newer', readOnly: true, notes };
	}
	while (version < GRANT_STORE_SCHEMA) {
		const step = Object.prototype.hasOwnProperty.call(schemaMigrations, version) ? schemaMigrations[version] : undefined;
		if (!step) {
			return { data: emptyGrantStore(raw.epoch), status: 'torn', readOnly: false, notes: [`no migration from grant store schema ${version}; permissions were reset`] };
		}
		current = step(current);
		version++;
		migrated = true;
		if (!isRecord(current) || !Array.isArray(current.grants)) {
			return { data: emptyGrantStore(raw.epoch), status: 'torn', readOnly: false, notes: [`the migration from schema ${version - 1} failed; permissions were reset`] };
		}
	}
	const grants: IGrant[] = [];
	const ids = new Set<string>();
	for (const entry of current.grants as unknown[]) {
		const grant = parseGrant(entry, notes, capabilityTable);
		if (grant && !ids.has(grant.id)) {
			ids.add(grant.id);
			grants.push(grant);
			if (grant.capability !== (entry as Record<string, unknown>).capability) {
				migrated = true;
			}
		}
	}
	const refusals = Array.isArray(current.refusals) ? (current.refusals as unknown[]).map(parseRefusal).filter((refusal): refusal is IRefusal => !!refusal) : [];
	const epoch = Math.max(raw.epoch, ...grants.map(grant => grant.epoch));
	return { data: { schemaVersion: GRANT_STORE_SCHEMA, epoch, grants, refusals }, status: migrated ? 'migrated' : 'ok', readOnly: false, notes };
}

/** The file text for `data`: canonical JSON, so the same store always writes the same bytes. */
export function serializeGrantStore(data: IGrantStoreData): string {
	return canonicalJson({ schemaVersion: data.schemaVersion, epoch: data.epoch, grants: data.grants, refusals: data.refusals });
}

// --- consents become grants ---------------------------------------------------------------------

/** One answer on an extension's page (VS Code's extension features store), by capability without version. */
export interface IConsentRecord {
	readonly capability: string;
	readonly granted: boolean;
}

/**
 * The extension pages' consents as grants and refusals: a granted consent is a persistent user
 * grant for the capability (any target), a refused one a refusal. The features store keeps no
 * use or grant time, so `at` stands for both.
 */
export function consentsToGrants(subject: SubjectKey, consents: readonly IConsentRecord[], at: number, epoch: number): { readonly grants: readonly IGrant[]; readonly refusals: readonly IRefusal[] } {
	const grants: IGrant[] = [];
	const refusals: IRefusal[] = [];
	for (const consent of consents) {
		const capability = migrateCapability(bareCapability(consent.capability));
		if (!capability || !knownCapability(capability)) {
			continue;
		}
		if (consent.granted) {
			grants.push({ id: `consent:${subject}:${capability}`, subject, capability, scope: {}, kind: 'persistent', source: 'user', grantedAt: at, lastUsedAt: at, epoch });
		} else {
			refusals.push({ subject, capability, at });
		}
	}
	return { grants, refusals };
}

/** Whether `refusals` holds a refusal of `capability` (any version) by `subject`. */
export function hasRefusal(refusals: readonly IRefusal[], subject: SubjectKey, capability: string): boolean {
	return refusals.some(refusal => refusal.subject === subject && bareCapability(refusal.capability) === bareCapability(capability) && capabilityVersion(refusal.capability) <= capabilityVersion(versionedCapability(capability)));
}
