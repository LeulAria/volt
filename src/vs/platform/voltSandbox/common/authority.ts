/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { StringSHA1 } from '../../../base/common/hash.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { bareCapability, capabilityClass, capabilityIdCovers, capabilityTargetMatches, VoltCapabilityClass, voltCapabilityClassRank, VOLT_CAPABILITY_CLASSES } from '../../voltPlugins/common/capabilityCatalog.js';
import { FIRST_PARTY_CEILINGS, IVoltCeilingEntry } from '../../voltPlugins/common/firstPartyCeilings.js';
import { canonicalJson, FLOW_CAPABILITY, GrantKind, grantCovers, grantExpiry, grantValid, hasRefusal, IGrant, IGrantContext, IRefusal, nextGrantExpiry } from './grants.js';
import { gestureValid, ICallContext, IPrincipal, isChatSubject, isFirstPartySubject, isPluginSubject, MAX_CALL_CHAIN, SubjectKey, subjectChatId, subjectExtensionId } from './principals.js';
import { classifyAddress } from './networkAddress.js';
import { isExfilHost, networkEntryWithin, networkRuleCovers, networkRulesCover, normalizeNetworkHost, parseNetworkRule, splitAuthority } from './networkRules.js';
import { agentApiDomains, domainAllowed, isPathInside, IVoltSandboxRequest, IVoltSandboxSettings, normalizeSandboxPath, SandboxStrategy, strategyAtLeast, VoltSandboxLevel } from './sandboxPolicy.js';
import { CREDENTIAL_HOME_PATHS } from './sandboxProfiles.js';
import { SandboxDimension, splitAllowEntry } from './sandboxSchema.js';

/**
 * The Policy Authority (spec C.5, F.2, Part G): the one function that decides every permission,
 * at launch, in a broker, in the host-tool gate and in the extension API.
 *
 * `evaluate(snapshot, request, context)` is pure over an immutable, versioned snapshot with an
 * explicit `asOf` time (it never reads the clock), so the same snapshot, request and context always
 * give the same decision (INV-32) and logged decisions replay (POL-DET-1). Layers, in order (G.2):
 *
 *   1 floor -> 2 manifest -> 3 grants (first party: ceiling) -> 4 workspace -> 5 admin
 *   -> 6 each caller in the on-behalf-of chain (attenuation) -> 7 egress compatibility on data-flow
 *   edges -> 8 platform (a dimension the backend can't enforce)
 *
 * Union happens only inside layer 3 (one subject's grants); across layers it is an intersection, so
 * adding a deny anywhere never turns a deny into an allow (AUTH-PROP-1).
 */

export type DeniedBy = 'floor' | 'manifest' | 'authority' | 'caller' | 'workspace' | 'admin' | 'egress-compat' | 'platform';

/** Which rule denied, finer than the layer (the extension API maps these onto its own `deniedBy`). */
export type DecisionCode =
	| 'catalog' | 'critical' | 'credential'
	| 'unknown-subject' | 'chain-too-long' | 'undeclared' | 'undeclared-target' | 'chat-sandbox'
	| 'ceiling' | 'consent' | 'refused'
	| 'untrusted-workspace' | 'workspace-policy'
	| 'admin-capability' | 'admin-host' | 'admin-class' | 'admin-unreadable'
	| 'caller' | 'egress' | 'covers' | 'unenforced'
	| 'metadata' | 'special-address' | 'exfil' | 'port';

/** A data-flow edge (G.6): data moves from the chain to the principal, and on to `target` when it is a subject. */
export type DataFlowEdge = 'tool' | 'send' | 'context' | 'hook';

export interface IAccessRequest {
	/** `id` or `id@version` from the catalog (G.8). */
	readonly capability: string;
	/** A host, command id, path, tool name, or a subject key (`chat:<id>`) for a send. */
	readonly target?: string;
	/** Set when the call moves data between principals (tool invoke, `chats.send`, context, hook). */
	readonly edge?: DataFlowEdge;
	/** The surface asking. The `volt` extension API never grants a critical capability (G.8). */
	readonly surface?: 'extension-api' | 'host-tool' | 'broker' | 'launch';
	/** B-34: the broker's or OS's record of the denial a prompt would answer. */
	readonly denialId?: string;
	/**
	 * `net.*` from the network broker (I.4): the destination port, `target` then being the host the
	 * broker normalised (lower-case ASCII, or an address in canonical text). Absent: a host-only
	 * check (the host-tool gate, the extension API), judged on the web ports.
	 */
	readonly port?: number;
}

/** What a denial may offer the user (G.3, G.6). */
export interface IPromptOffer {
	readonly capability: string;
	readonly target?: string;
	readonly class: VoltCapabilityClass;
	/** The grant kinds the prompt may record. */
	readonly choices: readonly GrantKind[];
	/** G.6: the card "Send this chat's content to … via …?". */
	readonly flow?: { readonly from: SubjectKey; readonly to: SubjectKey; readonly hosts: readonly string[] | 'all' };
}

export interface IDecision {
	readonly allow: boolean;
	readonly epoch: number;
	readonly deniedBy?: DeniedBy;
	readonly code?: DecisionCode;
	/** Only when `deniedBy` is `authority` (G.3) or `egress-compat` from a chat (G.6). */
	readonly promptable?: IPromptOffer;
	/** Volt-authored text. */
	readonly reason: string;
	/** For `caller` and `egress-compat`: the subject in the chain the rule stopped at. */
	readonly subject?: SubjectKey;
}

// --- snapshot inputs --------------------------------------------------------------------------

export interface IDeclaredCapability {
	readonly id: string;
	/** `*` globs. None: any target. */
	readonly targets?: readonly string[];
	/** `contributes.voltCapabilities.optional` rather than `required`. */
	readonly optional?: boolean;
}

/** A plugin's, extension's, MCP server's or helper's manifest as core recorded it (never from a payload). */
export interface IManifestView {
	readonly subject: SubjectKey;
	readonly declared: readonly IDeclaredCapability[];
	/**
	 * Its OS network: `host` (unsandboxed, or network host: egress is everything, G.6), `broker` (its
	 * egress is its `net.connect` grants), `none`.
	 */
	readonly network: 'host' | 'broker' | 'none';
}

/** A chat as core knows it: its sandbox settings are its built-in manifest and its grants. */
export interface IChatView {
	readonly subject: SubjectKey;
	readonly settings: IVoltSandboxSettings;
	/** Its agent's strategy; unknown: `wrap` when sandboxed. */
	readonly strategy?: SandboxStrategy;
	/** The folder its agent writes at `workspace-write`, as a real path. */
	readonly folder?: string;
	/**
	 * Every folder its agent writes at `workspace-write` (its checkout and a linked worktree's git
	 * dir), as real paths; when given, used instead of `folder`. Empty: it writes none beyond its
	 * allowed folders.
	 */
	readonly folders?: readonly string[];
	/** Its agent's own API hosts: reachable with the network off, whatever else the chat allows. */
	readonly apiHosts?: readonly string[];
}

/** Repo `.volt/sandbox.json` (trusted workspaces only) and Workspace Trust: restrict, never widen. */
export interface IWorkspaceRestriction {
	readonly root?: string;
	/** Undefined: unknown (no restriction from trust). */
	readonly trusted?: boolean;
	readonly denyCapabilities?: readonly string[];
}

/** Managed policy (MDM, `/etc/volt/policy.json`, `HKLM\Software\Policies\Volt`): restrict, never widen. */
export interface IAdminPolicy {
	readonly denyCapabilities?: readonly string[];
	/** `net.*` targets matching these are denied for everyone. */
	readonly denyHosts?: readonly string[];
	/** Third-party subjects get nothing above this class. */
	readonly maxThirdPartyClass?: VoltCapabilityClass;
	/** A policy is present but could not be read: third parties get only class `none` (fail closed). */
	readonly unreadable?: boolean;
}

/** The backend report: mandatory dimensions it can't enforce here. */
export interface IPlatformReport {
	readonly unenforced: readonly SandboxDimension[];
}

export interface IPolicySnapshotInput {
	/** The grant store epoch; bumps on every grant or policy change. */
	readonly epoch: number;
	/** The time grants are judged at (G.2 time-explicit). */
	readonly asOf: number;
	readonly grants?: readonly IGrant[];
	readonly refusals?: readonly IRefusal[];
	readonly manifests?: readonly IManifestView[];
	readonly chats?: readonly IChatView[];
	/** Default: the compiled table (G.10). */
	readonly ceilings?: Readonly<Record<string, readonly IVoltCeilingEntry[]>>;
	readonly workspace?: IWorkspaceRestriction;
	readonly admin?: IAdminPolicy;
	readonly platform?: IPlatformReport;
	/** Subjects whose prompt budget is spent (G.12). */
	readonly promptBudgetExhausted?: readonly SubjectKey[];
	/** The user's home, for the credential floor. */
	readonly home?: string;
}

/** An immutable, versioned view of everything `evaluate` reads (G.11). */
export class PolicySnapshot {

	private readonly grantsBySubject = new Map<SubjectKey, IGrant[]>();
	private readonly manifests = new Map<SubjectKey, IManifestView>();
	private readonly chats = new Map<SubjectKey, IChatView>();
	private _digest: string | undefined;
	readonly input: IPolicySnapshotInput;

	static build(input: IPolicySnapshotInput): PolicySnapshot {
		return new PolicySnapshot(input);
	}

	/** A snapshot from a logged one (`toJSON`): the same digest and the same decisions. */
	static fromJSON(value: IPolicySnapshotInput): PolicySnapshot {
		return new PolicySnapshot(value);
	}

	private constructor(input: IPolicySnapshotInput) {
		this.input = deepFreeze({ ...input, ceilings: input.ceilings ?? FIRST_PARTY_CEILINGS });
		for (const grant of this.input.grants ?? []) {
			let list = this.grantsBySubject.get(grant.subject);
			if (!list) {
				list = [];
				this.grantsBySubject.set(grant.subject, list);
			}
			list.push(grant);
		}
		for (const manifest of this.input.manifests ?? []) {
			this.manifests.set(manifest.subject, manifest);
		}
		for (const chat of this.input.chats ?? []) {
			this.chats.set(chat.subject, chat);
		}
	}

	get epoch(): number { return this.input.epoch; }
	get asOf(): number { return this.input.asOf; }

	/** SHA-1 of the canonical JSON: names the snapshot in the decision log. */
	get digest(): string {
		if (this._digest === undefined) {
			const sha = new StringSHA1();
			sha.update(canonicalJson(this.input));
			this._digest = sha.digest();
		}
		return this._digest;
	}

	/** When the snapshot must be rebuilt because a grant expires; undefined: never by time. */
	get rebuildAt(): number | undefined {
		return nextGrantExpiry(this.input.grants ?? [], this.input.asOf);
	}

	grants(subject: SubjectKey): readonly IGrant[] {
		return this.grantsBySubject.get(subject) ?? [];
	}

	manifest(subject: SubjectKey): IManifestView | undefined {
		return this.manifests.get(subject);
	}

	chat(subject: SubjectKey): IChatView | undefined {
		return this.chats.get(subject);
	}

	ceiling(subject: SubjectKey): readonly IVoltCeilingEntry[] | undefined {
		const id = subjectExtensionId(subject);
		const table = this.input.ceilings!;
		return id !== undefined && Object.prototype.hasOwnProperty.call(table, id) ? table[id] : undefined;
	}

	toJSON(): IPolicySnapshotInput {
		return this.input;
	}
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value as Record<string, unknown>)) {
			deepFreeze(item);
		}
	}
	return value;
}

// --- the evaluation function -----------------------------------------------------------------

const ALLOW_REASON = 'allowed';

function allow(epoch: number): IDecision {
	return { allow: true, epoch, reason: ALLOW_REASON };
}

function deny(epoch: number, deniedBy: DeniedBy, code: DecisionCode, reason: string, extra?: { readonly promptable?: IPromptOffer; readonly subject?: SubjectKey }): IDecision {
	return { allow: false, epoch, deniedBy, code, reason, ...extra?.promptable ? { promptable: extra.promptable } : {}, ...extra?.subject ? { subject: extra.subject } : {} };
}

/** G.2. Pure: reads only `snapshot`, `request` and `context`. */
export function evaluate(snapshot: PolicySnapshot, request: IAccessRequest, context: ICallContext): IDecision {
	const epoch = snapshot.epoch;
	const chain = [...context.onBehalfOf, context.principal];
	if (chain.length > MAX_CALL_CHAIN) {
		return deny(epoch, 'caller', 'chain-too-long', `the call passed through more than ${MAX_CALL_CHAIN} principals`);
	}
	// 1-5 for the principal itself.
	const own = evaluateSubject(snapshot, request, context.principal, context, true);
	if (!own.allow) {
		return own;
	}
	// 6: attenuation. What P does for C is never more than C may do, on C's own platform too.
	for (const caller of context.onBehalfOf) {
		let theirs = evaluateSubject(snapshot, request, caller, context, false);
		if (theirs.allow) {
			theirs = platformDecision(snapshot, request, caller.subject) ?? theirs;
		}
		if (!theirs.allow) {
			return deny(epoch, 'caller', 'caller', `${describeSubject(caller.subject)}, on whose behalf this runs, may not: ${theirs.reason}`, { subject: caller.subject });
		}
	}
	// 7: egress compatibility on every data-flow edge of the chain, and on to a target subject.
	if (request.edge) {
		const nodes: SubjectKey[] = chain.map(principal => principal.subject);
		const target = request.target && isChatSubject(request.target as SubjectKey) ? request.target as SubjectKey : undefined;
		if (target && target !== nodes[nodes.length - 1]) {
			nodes.push(target);
		}
		for (let i = 0; i + 1 < nodes.length; i++) {
			const edge = flowDecision(snapshot, nodes[i], nodes[i + 1], context);
			if (edge) {
				return edge;
			}
		}
	}
	// 8: a launch dimension the backend can't enforce here.
	return platformDecision(snapshot, request, context.principal.subject) ?? allow(epoch);
}

/** G.2 step 8 for one subject: undefined when its platform enforces what the capability needs. */
function platformDecision(snapshot: PolicySnapshot, request: IAccessRequest, subject: SubjectKey): IDecision | undefined {
	const dimension = capabilityDimension(request.capability);
	if (dimension && snapshot.input.platform?.unenforced.includes(dimension) && isConfined(snapshot, subject)) {
		return deny(snapshot.epoch, 'platform', 'unenforced', `this system's sandbox can't enforce ${dimension}, which ${request.capability} needs`);
	}
	return undefined;
}

/** Steps 1-5 for one subject (the principal or a caller in its chain). */
function evaluateSubject(snapshot: PolicySnapshot, request: IAccessRequest, principal: IPrincipal, context: ICallContext, primary: boolean): IDecision {
	const epoch = snapshot.epoch;
	const subject = principal.subject;
	const capability = request.capability;
	const cls = capabilityClass(capability);
	// 1. Floor: deny-only, compiled in.
	if (!cls) {
		return deny(epoch, 'floor', 'catalog', `${capability} is not in Volt's capability catalog`);
	}
	if (cls === 'critical' && request.surface === 'extension-api') {
		return deny(epoch, 'floor', 'critical', `${capability} is critical: Volt never grants it through the extension API`);
	}
	if (credentialTarget(capability, request.target, snapshot.input.home)) {
		return deny(epoch, 'floor', 'credential', `${request.target} holds credentials, which no permission opens`);
	}
	const addressFloor = networkAddressFloor(epoch, capability, request.target);
	if (addressFloor) {
		return addressFloor;
	}
	if (subject === 'user') {
		// The user's own action through core: only the floor applies.
		return allow(epoch);
	}
	// 2 + 3. Manifest and grants.
	const granted = isChatSubject(subject)
		? chatGrants(snapshot, request, principal, context, cls)
		: pluginGrants(snapshot, request, principal, context, cls, primary);
	if (!granted.allow) {
		return granted;
	}
	// 4. Workspace: Workspace Trust and the repo's restrictions.
	const unconfinedChat = isChatSubject(subject) && snapshot.chat(subject)?.settings.level === 'off';
	const workspace = snapshot.input.workspace;
	if (workspace && cls !== 'none' && !unconfinedChat) {
		if (workspace.trusted === false && !isChatSubject(subject) && !isFirstPartySubject(subject) && TRUST_GATED.some(id => capabilityIdCovers(id, capability))) {
			return deny(epoch, 'workspace', 'untrusted-workspace', `${capability} needs a trusted workspace`);
		}
		if (workspace.denyCapabilities?.some(id => deniedById(id, capability))) {
			return deny(epoch, 'workspace', 'workspace-policy', `this project's policy denies ${capability}`);
		}
	}
	// 5. Admin.
	const admin = snapshot.input.admin;
	return (admin && adminDecision(epoch, admin, isPluginSubject(subject) || subject.startsWith('mcp'), capability, cls, request.target)) || allow(epoch);
}

/** Step 5: the managed policy's refusal of `capability` (on `target`), or undefined. */
function adminDecision(epoch: number, admin: IAdminPolicy, thirdParty: boolean, capability: string, cls: VoltCapabilityClass, target: string | undefined): IDecision | undefined {
	if (admin.unreadable && thirdParty && cls !== 'none') {
		return deny(epoch, 'admin', 'admin-unreadable', 'a managed policy is installed but could not be read, so third parties get no permissions');
	}
	if (admin.denyCapabilities?.some(id => deniedById(id, capability))) {
		return deny(epoch, 'admin', 'admin-capability', `your organization's policy denies ${capability}`);
	}
	const host = target && bareCapability(capability).startsWith('net.') ? hostOf(target) : undefined;
	// A request that could reach a denied host is refused: `*` or `*.example.com` reach `api.example.com`.
	if (host && admin.denyHosts?.some(pattern => hostCovered(host, pattern) || hostCovered(pattern, host))) {
		return deny(epoch, 'admin', 'admin-host', `your organization's policy denies ${host}`);
	}
	// An exfil-capable host is high for a third party, whatever the catalog says of `net.connect` (G.8).
	const effective = host && bareCapability(capability) === 'net.connect' && isExfilHost(host) && voltCapabilityClassRank(cls) < voltCapabilityClassRank('high') ? 'high' : cls;
	if (admin.maxThirdPartyClass && thirdParty && voltCapabilityClassRank(effective) > voltCapabilityClassRank(admin.maxThirdPartyClass)) {
		return deny(epoch, 'admin', 'admin-class', `your organization's policy allows third parties nothing above ${admin.maxThirdPartyClass}`);
	}
	return undefined;
}

/**
 * Why the managed policy refuses what the user's own sandbox settings ask for (a widening in
 * `~/.volt/sandbox.json`), or undefined. The user's settings are no third party's, so the managed
 * policy's capability and host denies are what apply; they always win over the user's file.
 */
export function managedPolicyRefusal(admin: IAdminPolicy, capability: string, target?: string): string | undefined {
	const cls = capabilityClass(capability);
	if (!cls) {
		return `${capability} is not in Volt's capability catalog`;
	}
	return adminDecision(0, admin, false, capability, cls, target)?.reason;
}

/** Capabilities that need a trusted workspace (G.8). */
const TRUST_GATED = ['files.read:workspace', 'files.write', 'terminals.run', 'terminals.read', 'git.read', 'git.write', 'git.push'];

/**
 * A sandboxed chat's built-in manifest: what Volt's host tools may do for it at all (G.8, the host
 * tool classes of `hostToolSandbox.ts`). Never: persisting into later chats (`agents.context`),
 * reading other chats (`agents.read:other`, INV-26), starting chats outside its sandbox
 * (`agents.create`), or anything that runs outside it (`spawn.unsandboxed` and every critical one).
 */
const SANDBOXED_CHAT_MANIFEST: readonly string[] = [
	'ui.contribute', 'storage.own', 'config.own', 'commands.own', 'files.read:picked',
	'tools.register', 'usage.report', 'agents.read:current', 'agents.send',
	'files.read:workspace', 'files.write', 'browser.read', 'browser.drive', 'terminals.read', 'terminals.run',
	'net.connect', 'net.local.connect', 'net.listen:*', 'net.loopback.connect:*',
];

function chatGrants(snapshot: PolicySnapshot, request: IAccessRequest, principal: IPrincipal, context: ICallContext, cls: VoltCapabilityClass): IDecision {
	const epoch = snapshot.epoch;
	const subject = principal.subject;
	const view = snapshot.chat(subject);
	if (!view) {
		return deny(epoch, 'manifest', 'unknown-subject', `Volt has no record of ${describeSubject(subject)}`);
	}
	const settings = view.settings;
	if (settings.level === 'off') {
		// The user turned the sandbox off for this chat: the agent runs unconfined, and so do its tools.
		return allow(epoch);
	}
	const capability = request.capability;
	if (!SANDBOXED_CHAT_MANIFEST.some(id => capabilityIdCovers(id, capability))) {
		return deny(epoch, 'manifest', 'chat-sandbox', `${capability} (${cls}) is beyond what a ${settings.level === 'read-only' ? 'read-only ' : ''}sandboxed chat may do`);
	}
	const bare = bareCapability(capability);
	// Folders the user allowed from a denial stay writable at every level (`extraWritableRoots`).
	if (bare === 'files.write' && settings.level === 'read-only' && !(request.target && (settings.extraWritableRoots ?? []).some(root => isPathInside(request.target!, root)))) {
		return deny(epoch, 'authority', 'chat-sandbox', 'this chat\'s sandbox is read-only');
	}
	if (bare === 'net.connect' && !settings.network) {
		if (request.port !== undefined) {
			// The broker's request: port-aware rules, exfil hosts by exact name only, and this chat's live grants (I.4).
			return chatConnect(snapshot, request, principal, context, view);
		}
		const host = request.target ? hostOf(request.target) : undefined;
		if (!(host && domainAllowed(host, [...view.apiHosts ?? [], ...settings.allowedDomains ?? []]))) {
			return deny(epoch, 'authority', 'chat-sandbox', `this chat's network is off${host ? ` and ${host} is not one of its allowed hosts` : ''}`);
		}
	}
	if (bare === 'net.local.connect' && !settings.network) {
		// A LAN address: only a grant naming that address or CIDR, and the port (I.4 "Local network").
		const target = request.target ? normalizeNetworkHost(request.target) : undefined;
		const port = request.port;
		const context3 = grantContext(snapshot, principal, context);
		const granted = typeof target === 'object' && !!target.ip && port !== undefined && snapshot.grants(subject).some(grant => grantValid(grant, context3)
			&& capabilityIdCovers(grant.capability, 'net.local.connect') && networkRulesCover(grant.scope.targets ?? [], target, port));
		if (!granted) {
			return deny(epoch, 'authority', 'chat-sandbox', `${request.target ?? 'the address'}${port !== undefined ? ` port ${port}` : ''} is on the local network, which this chat was not granted`);
		}
	}
	if (bare.startsWith('net.listen:') || bare.startsWith('net.loopback.connect:')) {
		const port = Number(bare.slice(bare.indexOf(':') + 1));
		if (!(settings.listenPorts ?? []).includes(port)) {
			return deny(epoch, 'authority', 'chat-sandbox', `port ${bare.slice(bare.indexOf(':') + 1)} was not granted to this chat`);
		}
	}
	return allow(epoch);
}

/**
 * A network-off chat's `net.connect` from the broker: its allowed hosts (agent API hosts, the
 * user's "Allow host" choices) and its valid `net.connect` grants, by I.4's rules: port-aware,
 * descendants-only wildcards, and an exfil-capable host only by its exact name.
 */
function chatConnect(snapshot: PolicySnapshot, request: IAccessRequest, principal: IPrincipal, context: ICallContext, view: IChatView): IDecision {
	const epoch = snapshot.epoch;
	const port = request.port!;
	const target = request.target ? normalizeNetworkHost(request.target) : 'no host';
	if (typeof target === 'string') {
		return deny(epoch, 'authority', 'chat-sandbox', `the destination is refused: ${target}`);
	}
	const context3 = grantContext(snapshot, principal, context);
	const granted = snapshot.grants(principal.subject).filter(grant => grantValid(grant, context3) && capabilityIdCovers(grant.capability, 'net.connect')).flatMap(grant => grant.scope.targets ?? ['*']);
	const entries = [...view.apiHosts ?? [], ...view.settings.allowedDomains ?? [], ...granted];
	if (networkRulesCover(entries, target, port)) {
		return allow(epoch);
	}
	const elsewhere = [443, 80].find(other => other !== port && networkRulesCover(entries, target, other));
	if (!target.ip && isExfilHost(target.host)) {
		return deny(epoch, 'authority', 'exfil', `${target.host} takes data from anyone (paste, webhook, tunnel or storage service): only a rule naming it exactly opens it, not a wildcard`);
	}
	if (elsewhere !== undefined) {
		return deny(epoch, 'authority', 'port', `${target.host} is allowed on port ${elsewhere}, not ${port}`);
	}
	return deny(epoch, 'authority', 'chat-sandbox', `this chat's network is off and ${target.host}:${port} is not one of its allowed hosts`);
}

/** The host part of a `net.*` target, unbracketed; a bare IPv6 address has colons that are not a port. */
function addressHostOf(target: string): string {
	const raw = target.trim();
	return (!raw.includes('://') && raw.split(':').length > 2 && !raw.startsWith('[') ? raw : hostOf(raw)).replace(/^\[|\]$/g, '');
}

/**
 * The floor for `net.*` targets that are addresses (I.4 "Special ranges"): cloud metadata and the
 * reserved ranges are never reachable, and `net.connect` never reaches a local or loopback address
 * (that is `net.local.connect` or `net.loopback.connect:<port>`).
 */
function networkAddressFloor(epoch: number, capability: string, target: string | undefined): IDecision | undefined {
	const bare = bareCapability(capability);
	if (!target || !bare.startsWith('net.')) {
		return undefined;
	}
	const host = addressHostOf(target);
	const address = classifyAddress(host);
	if (!address) {
		return undefined;
	}
	if (address.class === 'metadata') {
		return deny(epoch, 'floor', 'metadata', `${host} is a cloud metadata address, which no permission opens`);
	}
	if (address.class === 'special') {
		return deny(epoch, 'floor', 'special-address', `${host} is a reserved address, which no permission opens`);
	}
	if (bare === 'net.connect' && address.class !== 'public') {
		return deny(epoch, 'floor', 'special-address', `${host} is a ${address.class === 'local' ? 'local-network' : 'loopback'} address: it needs its own permission, not a host rule`);
	}
	if (bare === 'net.local.connect' && address.class !== 'local') {
		return deny(epoch, 'floor', 'special-address', `${host} is not a local-network address`);
	}
	return undefined;
}

/** The manifest entry that declares `capability` on `target`, if any. */
function declaration(manifest: IManifestView, capability: string, target: string | undefined, port?: number, hostRules = false): IDeclaredCapability | undefined {
	return manifest.declared.find(entry => capabilityIdCovers(entry.id, capability)
		&& (!entry.targets?.length || (target !== undefined && entry.targets.some(pattern => hostRules ? targetMatches(capability, pattern, target, port) : capabilityTargetMatches(pattern, target)))));
}

/**
 * A third party's declared or granted target pattern against a request's target. `net.connect` is
 * matched as the broker matches host rules (I.4): no other `*` than a leading `*.` over a base that
 * is not a public suffix, descendants only, the port (none: 443), exfil hosts by exact name, and
 * never `*` (no plugin gets the whole web, H.7). Everything else by `capabilityTargetMatches`. Volt's
 * own built-ins keep their globs: their compiled ceilings bound them (G.10).
 */
function targetMatches(capability: string, pattern: string, target: string, port: number | undefined): boolean {
	if (bareCapability(capability) !== 'net.connect') {
		return capabilityTargetMatches(pattern, target);
	}
	const rule = parseNetworkRule(pattern);
	if (!rule || rule.kind === 'any') {
		return false;
	}
	const { host, port: given } = netTarget(target);
	const normalized = normalizeNetworkHost(host);
	return typeof normalized !== 'string' && networkRuleCovers(rule, normalized, port ?? given ?? 443);
}

/** The host and port a `net.*` target names: `host`, `host:port`, `[v6]:port`, a bare IPv6 address or a URL (its scheme's port). */
function netTarget(target: string): { readonly host: string; readonly port: number | undefined } {
	const raw = target.trim();
	const url = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
	if (url) {
		try {
			const parsed = new URL(raw);
			return { host: parsed.hostname, port: parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443 };
		} catch {
			return { host: raw, port: undefined };
		}
	}
	if (!raw.startsWith('[') && raw.split(':').length > 2) {
		return { host: raw, port: undefined };
	}
	const { host, port } = splitAuthority(raw, -1);
	return { host, port: port === -1 || Number.isNaN(port) ? undefined : port };
}

/** A deny list's id against a request: the id itself, its versions, and its family (`net.listen` denies `net.listen:3000`). */
function deniedById(id: string, capability: string): boolean {
	const denied = bareCapability(id);
	const wanted = bareCapability(capability);
	return capabilityIdCovers(id, capability) || denied === wanted || wanted.startsWith(`${denied}:`);
}

/**
 * What `principal`'s grants are judged against. `session` grants hold for its own instance and for
 * the chats it runs in: those at or before it in the chain (its own context, so a caller is judged
 * the same inside the chain as on its own).
 */
function grantContext(snapshot: PolicySnapshot, principal: IPrincipal, context: ICallContext): IGrantContext {
	const chain = [...context.onBehalfOf, context.principal];
	const at = chain.indexOf(principal);
	const own = at < 0 ? [principal] : chain.slice(0, at + 1);
	const sessionIds = [principal.id, ...own.map(p => subjectChatId(p.subject)).filter((id): id is string => !!id)];
	return { asOf: snapshot.asOf, epoch: snapshot.epoch, workspace: snapshot.input.workspace?.root, sessionIds };
}

function pluginGrants(snapshot: PolicySnapshot, request: IAccessRequest, principal: IPrincipal, context: ICallContext, cls: VoltCapabilityClass, primary: boolean): IDecision {
	const epoch = snapshot.epoch;
	const subject = principal.subject;
	const manifest = snapshot.manifest(subject);
	if (!manifest) {
		return deny(epoch, 'manifest', 'unknown-subject', `Volt has no manifest for ${describeSubject(subject)}`);
	}
	if (cls === 'none') {
		// Own storage, own settings, own commands, UI: automatic (G.8).
		return allow(epoch);
	}
	const capability = request.capability;
	let target = request.target;
	let exfilHost: string | undefined;
	if (bareCapability(capability) === 'net.connect' && target) {
		// I.4: no glob widens a port (`*.x.com` never covers `a.x.com:6379`) or opens an exfil-capable host.
		const host = hostOf(target);
		const declaresExactly = (text: string) => manifest.declared.some(entry => bareCapability(entry.id) === 'net.connect' && !!entry.targets?.some(pattern => pattern.toLowerCase() === text));
		if (request.port !== undefined && request.port !== 443 && request.port !== 80) {
			if (!declaresExactly(`${host}:${request.port}`)) {
				return deny(epoch, 'manifest', 'port', `${host}:${request.port} is not declared: a port other than 80 and 443 is declared with the host`);
			}
			target = `${host}:${request.port}`;
		}
		if (isExfilHost(host)) {
			if (!declaresExactly(host) && !declaresExactly(target)) {
				return deny(epoch, 'manifest', 'exfil', `${host} takes data from anyone: it must be declared by its exact name`);
			}
			exfilHost = host;
			// Exfil-capable hosts are high (G.8): no install-time grant.
			cls = 'high';
		}
	}
	const declared = declaration(manifest, capability, target, request.port, !isFirstPartySubject(subject));
	if (!declared) {
		const scoped = manifest.declared.some(entry => bareCapability(entry.id) === bareCapability(capability));
		return deny(epoch, 'manifest', scoped ? 'undeclared-target' : 'undeclared', scoped
			? `${capability} is declared for other targets than ${request.target ?? '(none)'}`
			: `${capability} (${cls}) is not declared in contributes.voltCapabilities`);
	}
	if (isFirstPartySubject(subject)) {
		// Grants(P) = Ceiling(P): what is both declared and in the ceiling, no prompt (G.10).
		const ceiling = snapshot.ceiling(subject);
		const within = !!ceiling?.some(entry => capabilityIdCovers(entry.id, capability)
			&& (exfilHost
				? !!entry.targets?.some(pattern => pattern.toLowerCase() === exfilHost || pattern.toLowerCase() === target)
				: !entry.targets?.length || (target !== undefined && entry.targets.some(pattern => capabilityTargetMatches(pattern, target!)))));
		return within ? allow(epoch) : deny(epoch, 'authority', 'ceiling', `${capability} is beyond ${subjectExtensionId(subject)}'s first-party ceiling`);
	}
	if (cls === 'low' && isPluginSubject(subject)) {
		// Install-time grant: a declared low capability holds while the extension is enabled (G.4).
		return allow(epoch);
	}
	const context3 = grantContext(snapshot, principal, context);
	const grantMatches = (grant: IGrant) => bareCapability(capability) === 'net.connect'
		? capabilityIdCovers(grant.capability, capability) && (!grant.scope.targets?.length || (target !== undefined && grant.scope.targets.some(pattern => targetMatches(capability, pattern, target!, request.port))))
		: grantCovers(grant, capability, target);
	if (snapshot.grants(subject).some(grant => grant.capability !== FLOW_CAPABILITY && grantValid(grant, context3) && grantMatches(grant)
		&& (!exfilHost || !!grant.scope.targets?.some(pattern => pattern.toLowerCase() === exfilHost || pattern.toLowerCase() === target)))) {
		return allow(epoch);
	}
	const refused = hasRefusal(snapshot.input.refusals ?? [], subject, capability);
	const reason = refused
		? `the user did not allow ${subjectExtensionId(subject) ?? subject} to use ${capability} (change it on the extension's page)`
		: `${capability} (${cls}) needs the user's consent`;
	const offer = primary && !refused ? promptOffer(snapshot, request, principal, context, cls) : undefined;
	return deny(epoch, 'authority', refused ? 'refused' : 'consent', reason, offer ? { promptable: offer } : undefined);
}

/**
 * G.3: a denial by the authority layer may prompt only for a low, medium or high capability the
 * manifest declares, with a valid gesture (or the plugin's own UI in front), within budget.
 */
function promptOffer(snapshot: PolicySnapshot, request: IAccessRequest, principal: IPrincipal, context: ICallContext, cls: VoltCapabilityClass): IPromptOffer | undefined {
	if (cls !== 'low' && cls !== 'medium' && cls !== 'high') {
		return undefined;
	}
	if (!gestureValid(context.gesture, principal.id, snapshot.asOf) && !context.foreground) {
		return undefined;
	}
	if (snapshot.input.promptBudgetExhausted?.includes(principal.subject)) {
		return undefined;
	}
	const choices: GrantKind[] = cls === 'high' ? ['once', 'session', 'persistent'] : ['persistent', 'session', 'once'];
	return { capability: request.capability, ...(request.target !== undefined ? { target: request.target } : {}), class: cls, choices };
}

// --- egress (G.6) -----------------------------------------------------------------------------

/** Every host, for a side whose network is unrestricted. */
const ALL = 'all';
export type Egress = readonly string[] | typeof ALL;

/**
 * egress(X) (G.6): the network destinations X can reach (broker grants; OS host mode is everything),
 * plus where its own flow approvals let it pass data on.
 */
export function egressOf(snapshot: PolicySnapshot, subject: SubjectKey, context: ICallContext): Egress {
	const declared = networkEgress(snapshot, subject);
	if (declared === ALL) {
		return ALL;
	}
	// A plugin or extension behind the broker also reaches what the user let it reach ("Allow host":
	// its `net.connect` grants, the ones the broker adds). Counted while not revoked or expired,
	// whatever their session: more egress only makes a flow to it stricter.
	const hostGrants = isChatSubject(subject) ? [] : snapshot.grants(subject)
		.filter(grant => !grant.revoked && capabilityIdCovers(grant.capability, 'net.connect') && (grantExpiry(grant) ?? Infinity) > snapshot.asOf)
		.flatMap(grant => grant.scope.targets ?? ['*']);
	if (hostGrants.includes('*')) {
		return ALL;
	}
	const network = hostGrants.length ? unionEgress(declared, hostGrants.map(host => host.toLowerCase())) : declared;
	// The subjects it may pass data to are part of its egress (G.6), as subject keys: a host pattern never matches one.
	const grantCtx = approvalContext(snapshot, subject, context);
	const subjects = snapshot.grants(subject).filter(grant => grant.capability === FLOW_CAPABILITY && grantValid(grant, grantCtx)).flatMap(grant => grant.scope.targets ?? []);
	return subjects.length ? unionEgress(network, subjects) : network;
}

function approvalContext(snapshot: PolicySnapshot, from: SubjectKey, context: ICallContext): IGrantContext {
	const principal = [context.principal, ...context.onBehalfOf].find(p => p.subject === from);
	// A subject outside the chain (a chat a call prompts) has no instance here: only its chat's own session counts.
	return principal ? grantContext(snapshot, principal, context) : { asOf: snapshot.asOf, epoch: snapshot.epoch, workspace: snapshot.input.workspace?.root, sessionIds: [subjectChatId(from)].filter((id): id is string => !!id) };
}

function networkEgress(snapshot: PolicySnapshot, subject: SubjectKey): Egress {
	if (isChatSubject(subject)) {
		const view = snapshot.chat(subject);
		const settings = view?.settings;
		if (!settings) {
			return [];
		}
		return settings.level === 'off' || settings.network ? ALL : [...new Set([...view.apiHosts ?? [], ...settings.allowedDomains ?? []])];
	}
	const manifest = snapshot.manifest(subject);
	if (!manifest) {
		return [];
	}
	if (manifest.network === 'host') {
		return ALL;
	}
	if (manifest.network === 'none') {
		return [];
	}
	const hosts = new Set<string>();
	const add = (targets: readonly string[] | undefined): boolean => {
		if (!targets?.length) {
			return true; // every host
		}
		for (const target of targets) {
			hosts.add(target.toLowerCase());
		}
		return false;
	};
	if (isFirstPartySubject(subject)) {
		for (const entry of snapshot.ceiling(subject) ?? []) {
			if (bareCapability(entry.id) === 'net.connect' && manifest.declared.some(declared => bareCapability(declared.id) === 'net.connect') && add(entry.targets)) {
				return ALL;
			}
		}
		return [...hosts];
	}
	for (const declared of manifest.declared) {
		if (bareCapability(declared.id) === 'net.connect' && add(declared.targets)) {
			return ALL;
		}
	}
	return [...hosts];
}

/** `host` is matched by `pattern` (`*` everything, `*.example.com` its subdomains and itself). */
function hostCovered(host: string, pattern: string): boolean {
	const h = host.trim().toLowerCase();
	const p = pattern.trim().toLowerCase();
	if (p === '*' || p === h) {
		return true;
	}
	if (!p.startsWith('*.')) {
		return false;
	}
	const base = p.slice(2);
	const name = h.startsWith('*.') ? h.slice(2) : h;
	return name === base || name.endsWith(`.${base}`);
}

/** Whether every destination in `a` is in `b`. */
export function egressWithin(a: Egress, b: Egress): boolean {
	if (b === ALL) {
		return true;
	}
	if (a === ALL) {
		return false;
	}
	// A subject key matches only itself; a host by the broker's rules (a parent's `*` never covers
	// `evil.com:22` or a paste site); a loopback name is this machine, never egress.
	return a.every(entry => b.includes(entry) || domainAllowed(entry, []) || networkEntryWithin(entry, b));
}

export function unionEgress(a: Egress, b: Egress): Egress {
	return a === ALL || b === ALL ? ALL : [...new Set([...a, ...b])];
}

/** FlowApprovals(from -> to): the hosts the user approved sending `from`'s data to through `to`. */
export function flowApprovals(snapshot: PolicySnapshot, from: SubjectKey, to: SubjectKey, context: ICallContext): Egress {
	const grants = snapshot.grants(from);
	if (!grants.length) {
		return [];
	}
	const grantCtx = approvalContext(snapshot, from, context);
	let out: Egress = [];
	for (const grant of grants) {
		if (grant.capability === FLOW_CAPABILITY && grantValid(grant, grantCtx) && grantCovers(grant, FLOW_CAPABILITY, to)) {
			const hosts = grant.scope.hosts ?? [];
			out = unionEgress(out, hosts.includes('*') ? ALL : hosts);
		}
	}
	return out;
}

/** G.6 for one edge: undefined when `to` can't send `from`'s data anywhere `from` couldn't. */
function flowDecision(snapshot: PolicySnapshot, from: SubjectKey, to: SubjectKey, context: ICallContext): IDecision | undefined {
	const epoch = snapshot.epoch;
	if (from === to || from === 'user') {
		return undefined;
	}
	if (isChatSubject(from) && isChatSubject(to)) {
		// A chat acting on another's message: the whole of its confinement must be covered (INV-11).
		const caller = snapshot.chat(from);
		if (!caller || caller.settings.level === 'off') {
			return undefined;
		}
		// Its flow approvals count too: a chat that may pass data on to a plugin's hosts is not a way out.
		return chatCovers(snapshot.chat(to), caller) && egressWithin(egressOf(snapshot, to, context), egressOf(snapshot, from, context))
			? undefined
			: deny(epoch, 'egress-compat', 'covers', `the other chat runs with a weaker sandbox than ${describeSubject(from)} (its level, agent, network, hosts, ports, folders or approved data flows)`, { subject: to });
	}
	const theirs = egressOf(snapshot, to, context);
	const ours = unionEgress(egressOf(snapshot, from, context), flowApprovals(snapshot, from, to, context));
	if (egressWithin(theirs, ours)) {
		return undefined;
	}
	const hosts: readonly string[] | 'all' = theirs === ALL ? ALL : theirs.filter(host => !egressWithin([host], ours));
	const offer: IPromptOffer | undefined = isChatSubject(from)
		? { capability: FLOW_CAPABILITY, target: to, class: 'high', choices: ['once', 'session'], flow: { from, to, hosts } }
		: undefined;
	const where = hosts === ALL ? 'any host' : hosts.join(', ');
	return deny(epoch, 'egress-compat', 'egress', `${describeSubject(to)} can send what it is given to ${where}, which ${describeSubject(from)} can't reach`, { subject: to, ...offer ? { promptable: offer } : {} });
}

// --- chat confinement (INV-11) ----------------------------------------------------------------

const LEVEL_RANK: Readonly<Record<VoltSandboxLevel, number>> = { 'off': 0, 'workspace-write': 1, 'read-only': 2 };

/**
 * Whether a chat confined by `target` is confined at least as much as `caller` (INV-11): its level
 * as strict, its agent's sandbox no weaker (`native` < `wrap`, B-10), its network no wider, its
 * extra folders, hosts and listen ports within the caller's, and (when it writes its workspace) its
 * folder one the caller may write too (B-11). Folders must be real paths.
 */
export function chatCovers(target: IChatView | undefined, caller: IChatView): boolean {
	const c = caller.settings;
	if (c.level === 'off') {
		return true;
	}
	const t = target?.settings;
	if (!target || !t || LEVEL_RANK[t.level] < LEVEL_RANK[c.level]) {
		return false;
	}
	if (!strategyAtLeast(target.strategy ?? (t.level !== 'off' ? 'wrap' : 'none'), caller.strategy ?? 'wrap')) {
		return false;
	}
	if (!c.network && t.network) {
		return false;
	}
	if ((t.listenPorts ?? []).some(port => !(c.listenPorts ?? []).includes(port))) {
		return false;
	}
	const callerRoots = [...(c.extraWritableRoots ?? []), ...(c.level === 'workspace-write' ? chatFolders(caller) ?? [] : [])];
	// `/ws/../Users/me` is not inside `/ws`: a folder with `..` is never covered.
	const within = (folder: string) => !normalizeSandboxPath(folder).split('/').includes('..') && callerRoots.some(allowed => isPathInside(folder, allowed));
	if ((t.extraWritableRoots ?? []).some(root => !within(root))) {
		return false;
	}
	if (!c.network && (t.allowedDomains ?? []).some(host => !domainAllowed(host, []) && !networkEntryWithin(host, c.allowedDomains ?? []))) {
		return false;
	}
	if (t.level === 'workspace-write') {
		// A target whose folder is unknown may write anywhere: not covered (B-11).
		const folders = chatFolders(target);
		if (!folders || folders.some(folder => !within(folder))) {
			return false;
		}
	}
	return true;
}

function chatFolders(view: IChatView): readonly string[] | undefined {
	return view.folders ?? (view.folder ? [view.folder] : undefined);
}

// --- path and host coverage (moved from sandboxComposition.ts) --------------------------------

/** True when path entry `child` is provably `parent` or below it. Different tokens are never provable. */
export function entryInside(child: string, parent: string): boolean {
	if (parent === '/') {
		return !child.startsWith('**/');
	}
	return child === parent || child.startsWith(`${parent}/`);
}

/** Ports an allow entry without one stands for. */
const DEFAULT_PORTS: readonly number[] = [80, 443];

/** Whether port `child` (undefined: 80 and 443) is within port `parent` (undefined: 80 and 443). */
function portCovered(parent: number | undefined, child: number | undefined): boolean {
	if (parent === undefined) {
		return child === undefined || DEFAULT_PORTS.includes(child);
	}
	return child === parent;
}

/**
 * Whether allow entry `parent` covers `child`. An entry without a port means ports 80 and 443, and
 * so does `*` (every public host on the web ports): `*` never covers `evil.com:6379` (B-32).
 */
export function allowCovers(parent: string, child: string): boolean {
	if (child === '*') {
		return parent === '*';
	}
	const c = splitAllowEntry(child);
	if (parent === '*') {
		return portCovered(undefined, c.port);
	}
	const p = splitAllowEntry(parent);
	if (!portCovered(p.port, c.port)) {
		return false;
	}
	if (p.host === c.host) {
		return true;
	}
	if (p.host.startsWith('*.')) {
		const base = p.host.slice(2);
		const host = c.host.startsWith('*.') ? c.host.slice(2) : c.host;
		return host === base || host.endsWith(`.${base}`);
	}
	return false;
}

// --- launches (C2 step 4) ---------------------------------------------------------------------

/** Who decides at launch and in the host-tool gate: the Authority (`enforce`), or the earlier rules with the Authority compared (`shadow`, for one release). */
export type PolicyAuthorityMode = 'enforce' | 'shadow';

export const POLICY_AUTHORITY_MODE_SETTING = 'volt.sandbox.policyAuthority.mode';

export function readPolicyAuthorityMode(value: unknown): PolicyAuthorityMode {
	return value === 'shadow' ? 'shadow' : 'enforce';
}

/**
 * A chat agent launch's view (F.2 `launchView`): the chat's settings as its spawn request carries
 * them, the folders it writes, its agent's API hosts, and the `wrap` strategy the launcher always
 * uses (D-16).
 */
export function chatLaunchView(subject: SubjectKey, request: IVoltSandboxRequest): IChatView {
	return {
		subject,
		settings: {
			level: request.level,
			network: request.network,
			...(request.extraWritableRoots?.length ? { extraWritableRoots: request.extraWritableRoots } : {}),
			...(request.allowedDomains?.length ? { allowedDomains: request.allowedDomains } : {}),
			...(request.listenPorts?.length ? { listenPorts: request.listenPorts } : {}),
		},
		strategy: 'wrap',
		folders: request.workspaceRoots,
		apiHosts: agentApiDomains(request.providerId),
	};
}

/** A launch decision: the first dimension the Authority refused, or allow with every request it judged. */
export interface ILaunchDecision extends IDecision {
	/** Every request the launch was judged by, in order. */
	readonly requests: readonly IAccessRequest[];
	/** The one that denied. */
	readonly denied?: IAccessRequest;
}

/**
 * The requests a chat agent's launch makes of the Authority (F.2, F.5): reading its workspace,
 * writing it at `workspace-write`, writing each allowed folder, the network (`*` when on, else its
 * agent's API and each allowed host) and listening on each granted port. Volt's own loopback
 * endpoints (the host MCP server) are core's, authenticated per request (INV-07), not the chat's.
 */
export function launchAccessRequests(view: IChatView, workspaceRoots: readonly string[]): IAccessRequest[] {
	const settings = view.settings;
	const out: IAccessRequest[] = [];
	const add = (capability: string, target: string) => out.push({ capability, target, surface: 'launch' });
	for (const root of workspaceRoots) {
		add('files.read:workspace', root);
		if (settings.level === 'workspace-write') {
			add('files.write', root);
		}
	}
	for (const root of settings.extraWritableRoots ?? []) {
		add('files.write', root);
	}
	if (settings.network) {
		add('net.connect', '*');
	} else {
		for (const host of new Set([...view.apiHosts ?? [], ...settings.allowedDomains ?? []])) {
			// A non-public address in the chat's list is the broker's to refuse per connection (the
			// address floor); at launch it would refuse the whole chat.
			const address = classifyAddress(addressHostOf(host));
			if (address && address.class !== 'public') {
				continue;
			}
			add('net.connect', host);
		}
	}
	for (const port of settings.listenPorts ?? []) {
		out.push({ capability: `net.listen:${port}`, surface: 'launch' });
	}
	return out;
}

/**
 * Whether the chat on `context.principal` may be launched with the OS policy its own view asks
 * for (G.2 over every launch dimension). Floor, workspace and admin layers can refuse a launch the
 * chat's settings allow; a refused launch never reaches the compiler or a backend (LAUNCH-AUTH-1).
 * Step 8 (a dimension this backend can't enforce) is the supervisor's at launch, which knows the
 * policy's best-effort list (INV-04).
 */
export function evaluateLaunch(snapshot: PolicySnapshot, context: ICallContext, workspaceRoots: readonly string[]): ILaunchDecision {
	const epoch = snapshot.epoch;
	const subject = context.principal.subject;
	const view = isChatSubject(subject) ? snapshot.chat(subject) : undefined;
	if (!view) {
		return { ...deny(epoch, 'manifest', 'unknown-subject', `Volt has no record of ${describeSubject(subject)} to launch`), requests: [] };
	}
	if (view.settings.level === 'off') {
		return { ...deny(epoch, 'manifest', 'chat-sandbox', 'a chat with the sandbox off is not launched through the sandbox'), requests: [] };
	}
	const requests = launchAccessRequests(view, workspaceRoots);
	for (const request of requests) {
		const decision = evaluate(snapshot, request, context);
		if (!decision.allow) {
			return { ...decision, requests, denied: request };
		}
	}
	return { ...allow(epoch), requests };
}

// --- floor and platform helpers ---------------------------------------------------------------

/** A `files.*` request whose target is inside a credential folder (POL-PROP-7). */
function credentialTarget(capability: string, target: string | undefined, home: string | undefined): boolean {
	if (!target || !bareCapability(capability).startsWith('files.')) {
		return false;
	}
	let path = target.trim();
	if (path.startsWith('~/')) {
		if (!home) {
			return CREDENTIAL_HOME_PATHS.some(dir => isPathInside(normalizeSandboxPath(`/~/${path.slice(2)}`), `/~/${dir}`));
		}
		path = `${home}/${path.slice(2)}`;
	}
	if (!home || !path.startsWith('/')) {
		return false;
	}
	const segments = path.split('/').filter(segment => segment !== '' && segment !== '.');
	if (segments.includes('..')) {
		return true; // not a path the floor can place: refused
	}
	// Any case: macOS and Windows folders are case-insensitive (`~/.SSH` is `~/.ssh`); deny-only, so never wider.
	const normalized = `/${segments.join('/')}`.toLowerCase();
	const base = normalizeSandboxPath(home).toLowerCase();
	return CREDENTIAL_HOME_PATHS.some(dir => isPathInside(normalized, `${base}/${dir.toLowerCase()}`));
}

/** The launch dimension a capability needs from the OS sandbox (G.2 step 8). */
function capabilityDimension(capability: string): SandboxDimension | undefined {
	const bare = bareCapability(capability);
	if (bare.startsWith('net.listen:')) {
		return 'network.listen';
	}
	if (bare.startsWith('net.loopback.connect:')) {
		return 'network.loopbackPorts';
	}
	if (bare === 'net.connect') {
		return 'network.proxy';
	}
	if (bare === 'files.write') {
		return 'filesystem.write';
	}
	if (bare.startsWith('files.read:')) {
		return 'filesystem.read';
	}
	return undefined;
}

/** A principal Volt's sandbox confines (so a platform gap matters to it). */
function isConfined(snapshot: PolicySnapshot, subject: SubjectKey): boolean {
	if (isChatSubject(subject)) {
		const level = snapshot.chat(subject)?.settings.level;
		return level !== undefined && level !== 'off';
	}
	const manifest = snapshot.manifest(subject);
	return !!manifest && manifest.network !== 'host';
}

function hostOf(target: string): string {
	const value = target.trim().toLowerCase();
	let host: string;
	try {
		host = /^[a-z][a-z0-9+.-]*:\/\//.test(value) ? new URL(value).hostname : value.replace(/:\d+$/, '');
	} catch {
		host = value;
	}
	// `evil.com.` is `evil.com` to every resolver (and to the broker, which strips the dot).
	return host.replace(/\.+$/, '');
}

export function describeSubject(subject: SubjectKey): string {
	if (isChatSubject(subject)) {
		return 'this chat';
	}
	const extension = subjectExtensionId(subject);
	return extension ?? subject;
}

// --- admin policy (pure parse; node/adminPolicy.ts reads the managed locations) ----------------

/** The managed policy's JSON as an admin layer; anything malformed makes it `unreadable` (fail closed for third parties). */
export function parseAdminPolicy(raw: unknown): IAdminPolicy {
	if (raw === undefined) {
		return {};
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { unreadable: true };
	}
	const value = raw as Record<string, unknown>;
	const list = (field: unknown): readonly string[] | undefined | null => field === undefined ? undefined : Array.isArray(field) && field.every(item => typeof item === 'string') ? field as string[] : null;
	const denyCapabilities = list(value.denyCapabilities);
	const denyHosts = list(value.denyHosts);
	const max = value.maxThirdPartyClass;
	if (denyCapabilities === null || denyHosts === null || (max !== undefined && !(VOLT_CAPABILITY_CLASSES as readonly unknown[]).includes(max))) {
		return { unreadable: true };
	}
	// A deny that names no capability (a typo) would deny nothing: the policy is not what its author meant.
	if (denyCapabilities?.some(id => !capabilityClass(id) && !capabilityClass(`${bareCapability(id)}:x`))) {
		return { unreadable: true };
	}
	return {
		...(denyCapabilities ? { denyCapabilities } : {}),
		...(denyHosts ? { denyHosts } : {}),
		...(max !== undefined ? { maxThirdPartyClass: max as VoltCapabilityClass } : {}),
	};
}

// --- decision log and replay (G.11, POL-DET-1) ------------------------------------------------

/** The decision record version this build writes: 2 adds the request's digest. */
export const DECISION_RECORD_VERSION = 2;

/**
 * One logged decision. Version 2 (`v: 2`) carries `reqDigest`, so a replay proves the request too;
 * a version 1 record (no `v`) still replays, without that proof ({@link replayProvesRequest}).
 */
export interface IDecisionLogRecord {
	readonly v?: number;
	readonly epoch: number;
	readonly snapshotDigest: string;
	readonly request: IAccessRequest;
	readonly reqDigest?: string;
	readonly context: ICallContext;
	readonly ctxDigest: string;
	readonly decision: IDecision;
}

function sha1(text: string): string {
	const sha = new StringSHA1();
	sha.update(text);
	return sha.digest();
}

export function decisionRecord(snapshot: PolicySnapshot, request: IAccessRequest, context: ICallContext, decision: IDecision): IDecisionLogRecord {
	return { v: DECISION_RECORD_VERSION, epoch: snapshot.epoch, snapshotDigest: snapshot.digest, request, reqDigest: sha1(canonicalJson(request)), context, ctxDigest: sha1(canonicalJson(context)), decision };
}

/** Whether replaying `record` proves its request (version 2 and later); version 1 records don't carry the digest. */
export function replayProvesRequest(record: IDecisionLogRecord): boolean {
	return (record.v ?? 1) >= 2;
}

/** Re-runs a logged decision against its snapshot: equal to `record.decision` when `evaluate` is deterministic. */
export function replayDecision(snapshot: PolicySnapshot, record: IDecisionLogRecord): IDecision {
	if (snapshot.digest !== record.snapshotDigest) {
		throw new Error(`snapshot ${snapshot.digest} is not the logged ${record.snapshotDigest}`);
	}
	if (sha1(canonicalJson(record.context)) !== record.ctxDigest) {
		throw new Error('the logged call context does not match its digest');
	}
	const version = record.v ?? 1;
	if (!Number.isInteger(version) || version < 1 || version > DECISION_RECORD_VERSION) {
		throw new Error(`decision record version ${String(record.v)} is not one this Volt reads`);
	}
	if (version >= 2 && (typeof record.reqDigest !== 'string' || sha1(canonicalJson(record.request)) !== record.reqDigest)) {
		throw new Error('the logged request does not match its digest');
	}
	return evaluate(snapshot, record.request, record.context);
}

// --- the service view (F.2) -------------------------------------------------------------------

/** What the compiler needs about a principal (F.2). */
export interface ILaunchView {
	readonly subject: SubjectKey;
	readonly chat?: IChatView;
	readonly manifest?: IManifestView;
	readonly epoch: number;
}

export interface IPolicyAuthorityChange {
	readonly epoch: number;
	readonly subjects: readonly SubjectKey[];
	readonly narrowed: boolean;
}

export interface IPolicyAuthority {
	readonly epoch: number;
	evaluate(request: IAccessRequest, context: ICallContext): IDecision;
	launchView(principal: IPrincipal): ILaunchView;
	readonly onDidChange: Event<IPolicyAuthorityChange>;
}

/** Holds the current snapshot; `evaluate` is the pure function over it, with every decision offered to `log`. */
export class PolicyAuthority extends Disposable implements IPolicyAuthority {

	private _snapshot: PolicySnapshot;
	private readonly _onDidChange = this._register(new Emitter<IPolicyAuthorityChange>());
	readonly onDidChange = this._onDidChange.event;

	constructor(input: IPolicySnapshotInput, private readonly log?: (record: () => IDecisionLogRecord, decision: IDecision) => void) {
		super();
		this._snapshot = PolicySnapshot.build(input);
	}

	get epoch(): number {
		return this._snapshot.epoch;
	}

	get snapshot(): PolicySnapshot {
		return this._snapshot;
	}

	/** Replaces the snapshot. Epochs only grow: a stale input is refused, so a decision is never made on an older state. */
	update(input: IPolicySnapshotInput, change: { readonly subjects: readonly SubjectKey[]; readonly narrowed: boolean } = { subjects: [], narrowed: true }): void {
		if (input.epoch < this._snapshot.epoch) {
			throw new Error(`policy epoch ${input.epoch} is older than ${this._snapshot.epoch}`);
		}
		this._snapshot = PolicySnapshot.build(input);
		this._onDidChange.fire({ epoch: input.epoch, subjects: change.subjects, narrowed: change.narrowed });
	}

	evaluate(request: IAccessRequest, context: ICallContext): IDecision {
		const snapshot = this._snapshot;
		const decision = evaluate(snapshot, request, context);
		this.log?.(() => decisionRecord(snapshot, request, context, decision), decision);
		return decision;
	}

	launchView(principal: IPrincipal): ILaunchView {
		const snapshot = this._snapshot;
		const chat = snapshot.chat(principal.subject);
		const manifest = snapshot.manifest(principal.subject);
		return { subject: principal.subject, epoch: snapshot.epoch, ...chat ? { chat } : {}, ...manifest ? { manifest } : {} };
	}
}
