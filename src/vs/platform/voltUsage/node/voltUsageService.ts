/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from '../../../base/common/path.js';
import { ILogService } from '../../log/common/log.js';
import {
	IVoltUsageActivity, IVoltUsageBucket, IVoltUsageLimitGroup, IVoltUsageMachineReport, IVoltUsageMachineStatus, IVoltUsageModelPrice, IVoltUsageNote, IVoltUsageService,
	IVoltUsageSnapshot, VOLT_USAGE_HISTORY_DAYS, VoltResetCreditOutcome, VoltUsageProvider
} from '../common/voltUsage.js';
import {
	claudeCachePath, claudeHomes, ClaudeLimitsReader, codexHomes, cursorRateModel, ICursorUsage, readCodexLimits, readCursorAccountId, readCursorLimits, readCursorUsage,
	redeemClaudeResetCredit, redeemCodexResetCredit, ResetCreditError
} from './usageAccounts.js';
import { accountKey, fetchMachineReport, IMachineAnswer, IStoredMachine, LimitHolder, localMachineId, localMachineName, MachineStore, mergeLimits, mergeUsage, parsePairingUrl, redeemOnMachine } from './usageMachines.js';
import { applyModelPrices, UsagePricing, validModelPrice } from './usagePricing.js';
import { readGrokLimits, readOpenCodeGoLimits } from './usageSubscriptions.js';
import { billOncePerResponse, ICodexRateLimitSample, IParsedTranscript, ITranscriptFile, IUsageRecord, listTranscripts, parseTranscript } from './usageTranscripts.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A snapshot this fresh is returned as is unless the caller forces a rescan. */
const SNAPSHOT_TTL_MS = 20_000;
const LIMITS_TTL_MS = 60_000;
const CURSOR_TTL_MS = 2 * 60_000;
/** Another machine is asked at most this often unless the user refreshes. */
const MACHINE_TTL_MS = 60_000;

/** Extra logins to read besides each agent's default, from `volt.usage.accountDirectories`. */
export interface IVoltUsageAccountDirs {
	readonly claude: readonly string[];
	readonly codex: readonly string[];
}

/** Reads the setting's value, ignoring anything that isn't a list of paths. */
export function usageAccountDirs(value: unknown): IVoltUsageAccountDirs {
	const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const list = (key: string) => Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter((dir): dir is string => typeof dir === 'string' && !!dir.trim()) : [];
	return { claude: list('claude'), codex: list('codex') };
}

/** Where this machine reads a login from, to redeem its reset credits. */
type LocalLogin =
	| { readonly provider: 'claude'; readonly reader: ClaudeLimitsReader }
	| { readonly provider: 'codex'; readonly codexHome: string };

interface ICachedTranscript extends IParsedTranscript {
	readonly provider: 'claude' | 'codex';
	readonly mtimeMs: number;
	readonly size: number;
}

interface IMutableBucket {
	provider: VoltUsageProvider;
	model: string;
	hour: number;
	uncached: number;
	cached: number;
	cacheWrite: number;
	output: number;
	costUsd: number;
	savingsUsd: number;
	unpriced: boolean;
	inputCostUsd: number;
	cacheReadCostUsd: number;
	cacheWriteCostUsd: number;
	outputCostUsd: number;
	fastCostUsd: number;
	ultrafastCostUsd: number;
	speedPremiumUsd: number;
}

const yieldToLoop = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * Reads token usage from the agents' own records: Claude Code and Codex transcripts on disk
 * (Volt's runs of those agents land there too) and Cursor's account usage API. Prices come
 * from LiteLLM's public list, unless the user set one. Transcripts are parsed once and re-read
 * only when they change. Limits are read per login, for every account the user added, and other
 * machines' usage and limits come from their Volt agent servers.
 */
export class VoltUsageService implements IVoltUsageService {

	declare readonly _serviceBrand: undefined;

	private readonly transcripts = new Map<string, ICachedTranscript>();
	private readonly pricing: UsagePricing;
	private readonly claudeReaders = new Map<string, ClaudeLimitsReader>();
	private readonly machineStore: MachineStore;
	private readonly machineAnswers = new Map<string, { at: number; answer: Promise<IMachineAnswer> }>();
	private readonly pricesPath: string;
	private prices: Record<string, IVoltUsageModelPrice> | undefined;
	private snapshot: IVoltUsageSnapshot | undefined;
	private building: Promise<IVoltUsageSnapshot> | undefined;
	private limits: { at: number; value: readonly IVoltUsageLimitGroup[] } | undefined;
	private limitsReading: Promise<readonly IVoltUsageLimitGroup[]> | undefined;
	private cursor: { at: number; value: ICursorUsage | undefined } | undefined;
	private codexSample: ICodexRateLimitSample | undefined;
	/** This machine's logins by account, from the last limits read. */
	private localLogins = new Map<string, LocalLogin>();
	/** Who can redeem for each account, from the last pooled read. */
	private holders = new Map<string, LimitHolder[]>();
	/** One redemption per account at a time, each with a key that survives a retry. */
	private readonly redeeming = new Map<string, Promise<unknown>>();
	private readonly pendingRedeemKeys = new Map<string, string>();

	constructor(
		private readonly resolveEnv: () => Promise<NodeJS.ProcessEnv>,
		private readonly logService: ILogService,
		private readonly cacheDir: string,
		private readonly accountDirs: () => IVoltUsageAccountDirs = () => ({ claude: [], codex: [] }),
		private readonly home = homedir(),
	) {
		this.pricing = new UsagePricing(join(cacheDir, 'litellm-prices.json'));
		this.machineStore = new MachineStore(join(cacheDir, 'machines.json'));
		this.pricesPath = join(cacheDir, 'model-prices.json');
	}

	//#region Pooled: this machine and the others

	async getUsage(force?: boolean): Promise<IVoltUsageSnapshot> {
		const [local, answers, prices, cursorAccount] = await Promise.all([this.getLocalUsage(force), this.askMachines(!!force), this.getModelPrices(), readCursorAccountId(this.home).catch(() => undefined)]);
		// A machine that turns out to be this computer (a second Volt profile here) would count everything twice.
		const included = answers.filter(answer => answer.report?.machineId !== localMachineId());
		const remotes = included.flatMap(answer => answer.report ? [{ machineName: answer.status.name, usage: answer.report.usage, cursorAccount: answer.report.cursorAccount }] : []);
		const merged = mergeUsage({ machineName: localMachineName(), usage: local, cursorAccount }, remotes, included.map(answer => answer.status));
		return { ...merged, buckets: applyModelPrices(merged.buckets, prices) };
	}

	async getLimits(force?: boolean): Promise<readonly IVoltUsageLimitGroup[]> {
		const [local, answers] = await Promise.all([this.getLocalLimits(force), this.askMachines(!!force)]);
		const sources = [{ holder: 'local' as LimitHolder, machineName: localMachineName(), groups: local }];
		for (const answer of answers) {
			if (answer.report) {
				sources.push({ holder: answer.status.id, machineName: answer.status.name, groups: answer.report.limits });
			}
		}
		const merged = mergeLimits(sources);
		this.holders = merged.holders;
		return merged.groups;
	}

	async redeemResetCredit(provider: VoltUsageProvider, accountId: string): Promise<VoltResetCreditOutcome> {
		const key = accountKey(provider, accountId);
		if (!this.holders.has(key)) {
			await this.getLimits();
		}
		const holders = this.holders.get(key) ?? [];
		try {
			if (holders.includes('local')) {
				return await this.redeemLocal(provider, accountId);
			}
			const machine = (await this.machineStore.list()).find(m => holders.includes(m.id));
			if (!machine) {
				throw new ResetCreditError('No machine is signed in to this account any more. Refresh and try again.', true);
			}
			const outcome = await redeemOnMachine(machine, provider, accountId);
			this.machineAnswers.delete(machine.id);
			return outcome;
		} finally {
			this.limits = undefined;
		}
	}

	//#endregion

	//#region Machines

	async getMachines(): Promise<readonly IVoltUsageMachineStatus[]> {
		return (await this.askMachines(false)).map(answer => answer.status);
	}

	async addMachine(pairingUrl: string, name?: string): Promise<IVoltUsageMachineStatus> {
		const parsed = parsePairingUrl(pairingUrl);
		if (!parsed) {
			throw new Error('That is not a Volt agent server address. Copy the whole address with its token, like http://192.168.1.20:7791/#token=…');
		}
		const probe: IStoredMachine = { id: '', name: name?.trim() || parsed.url, url: parsed.url, token: parsed.token };
		const answer = await fetchMachineReport(probe, false);
		if (answer.status.state === 'unauthorized') {
			throw new Error('That machine refused the token. Copy its address again; the token changes when its server is reset.');
		}
		if (answer.report?.machineId === localMachineId()) {
			throw new Error('That address is this computer. Paste the address from your other computer.');
		}
		if (answer.status.state !== 'ok' || !answer.report) {
			throw new Error(answer.status.state === 'offline'
				? `Volt could not reach ${parsed.url}. Check the other machine is awake, on the same network, and shares its usage.`
				: `${parsed.url} answered, but not with Volt usage. Update Volt on that machine.`);
		}
		const stored = await this.machineStore.put({ name: name?.trim() || answer.report.machineName, url: parsed.url, token: parsed.token });
		this.machineAnswers.set(stored.id, { at: Date.now(), answer: Promise.resolve({ status: { ...answer.status, id: stored.id, name: stored.name }, report: answer.report }) });
		return { id: stored.id, name: stored.name, url: stored.url, state: 'ok', checkedAt: Date.now() };
	}

	async removeMachine(id: string): Promise<void> {
		await this.machineStore.remove(id);
		this.machineAnswers.delete(id);
	}

	private async askMachines(force: boolean): Promise<IMachineAnswer[]> {
		const machines = await this.machineStore.list();
		return Promise.all(machines.map(machine => {
			const cached = this.machineAnswers.get(machine.id);
			if (cached && !force && Date.now() - cached.at < MACHINE_TTL_MS) {
				return cached.answer;
			}
			const answer = fetchMachineReport(machine, force);
			this.machineAnswers.set(machine.id, { at: Date.now(), answer });
			return answer;
		}));
	}

	//#endregion

	//#region Model prices

	async getModelPrices(): Promise<Record<string, IVoltUsageModelPrice>> {
		if (!this.prices) {
			const prices: Record<string, IVoltUsageModelPrice> = {};
			try {
				const parsed = JSON.parse(await fs.readFile(this.pricesPath, 'utf8'));
				for (const [model, value] of Object.entries(parsed && typeof parsed === 'object' ? parsed : {})) {
					const price = validModelPrice(value);
					if (price && model.trim()) {
						prices[model.trim()] = price;
					}
				}
			} catch {
				// None set yet.
			}
			this.prices = prices;
		}
		return this.prices;
	}

	async setModelPrice(model: string, price: IVoltUsageModelPrice | undefined): Promise<void> {
		const id = model.trim();
		if (!id) {
			throw new Error('Enter a model id.');
		}
		const next = { ...await this.getModelPrices() };
		if (price === undefined) {
			delete next[id];
		} else {
			const valid = validModelPrice(price);
			if (!valid) {
				throw new Error('Enter input and output prices of 0 or more.');
			}
			next[id] = valid;
		}
		await fs.mkdir(dirname(this.pricesPath), { recursive: true });
		await fs.writeFile(this.pricesPath, JSON.stringify(next, undefined, '\t'));
		this.prices = next;
	}

	//#endregion

	//#region This machine

	/** This machine's own usage and limits, for another machine's Usage page (`GET /api/usage`). */
	async getMachineReport(force?: boolean): Promise<IVoltUsageMachineReport> {
		const [usage, limits, prices, cursorAccount] = await Promise.all([this.getLocalUsage(force), this.getLocalLimits(force), this.getModelPrices(), readCursorAccountId(this.home).catch(() => undefined)]);
		return {
			machineName: localMachineName(),
			machineId: localMachineId(),
			usage: { ...usage, buckets: applyModelPrices(usage.buckets, prices) },
			limits,
			...(cursorAccount ? { cursorAccount } : {}),
		};
	}

	private async getLocalUsage(force?: boolean): Promise<IVoltUsageSnapshot> {
		if (!force && this.snapshot && Date.now() - this.snapshot.generatedAt < SNAPSHOT_TTL_MS) {
			return this.snapshot;
		}
		this.building ??= this.build(!!force).finally(() => this.building = undefined);
		return this.building;
	}

	private async getLocalLimits(force?: boolean): Promise<readonly IVoltUsageLimitGroup[]> {
		if (!force && this.limits && Date.now() - this.limits.at < LIMITS_TTL_MS) {
			return this.limits.value;
		}
		this.limitsReading ??= this.readLimits().finally(() => this.limitsReading = undefined);
		return this.limitsReading;
	}

	/**
	 * Spends a reset credit for a login on this machine (`POST /api/usage/redeem` lands here too).
	 * Serialized per account; the idempotency key is kept until the provider answers, so a retry
	 * after a timeout is the same attempt and never spends a second credit.
	 */
	async redeemLocal(provider: VoltUsageProvider, accountId: string): Promise<VoltResetCreditOutcome> {
		const key = accountKey(provider, accountId);
		const previous = this.redeeming.get(key) ?? Promise.resolve();
		const run = previous.catch(() => undefined).then(async () => {
			if (!this.localLogins.has(key)) {
				await this.getLocalLimits(true);
			}
			const login = this.localLogins.get(key);
			if (!login || (provider !== 'claude' && provider !== 'codex')) {
				throw new ResetCreditError('This account is not signed in on this machine any more.', true);
			}
			const env = await this.resolveEnv();
			const idempotencyKey = this.pendingRedeemKeys.get(key) ?? randomUUID();
			this.pendingRedeemKeys.set(key, idempotencyKey);
			try {
				let outcome: VoltResetCreditOutcome;
				if (login.provider === 'claude') {
					let grantId = login.reader.nextGrantId;
					if (!grantId) {
						login.reader.invalidate();
						await login.reader.read(env);
						grantId = login.reader.nextGrantId;
					}
					if (!grantId) {
						throw new ResetCreditError('This Claude account has no banked resets left.', true);
					}
					outcome = await redeemClaudeResetCredit(this.home, login.reader.claudeHome, env, grantId, idempotencyKey);
					login.reader.invalidate();
				} else {
					outcome = await redeemCodexResetCredit(this.home, login.codexHome, env, idempotencyKey);
				}
				this.pendingRedeemKeys.delete(key);
				this.logService.info(`[volt-usage] redeemed a ${provider} reset credit: ${outcome}`);
				return outcome;
			} catch (error) {
				if (!(error instanceof ResetCreditError) || error.settled) {
					this.pendingRedeemKeys.delete(key);
				}
				throw error;
			} finally {
				this.limits = undefined;
			}
		});
		this.redeeming.set(key, run);
		return run;
	}

	private claudeReader(claudeHome: { configDir: string; isDefault: boolean }): ClaudeLimitsReader {
		let reader = this.claudeReaders.get(claudeHome.configDir);
		if (!reader) {
			reader = new ClaudeLimitsReader(this.home, claudeHome, claudeCachePath(this.cacheDir, claudeHome));
			this.claudeReaders.set(claudeHome.configDir, reader);
		}
		return reader;
	}

	private extraClaudeDirs(env: NodeJS.ProcessEnv): string[] {
		return [...(env.CLAUDE_CONFIG_DIR ?? '').split(','), ...this.accountDirs().claude].map(value => value.trim()).filter(Boolean);
	}

	private async readLimits(): Promise<readonly IVoltUsageLimitGroup[]> {
		const env = await this.resolveEnv();
		const dirs = this.accountDirs();
		// The rollout scan finds the newest Codex sample, the fallback when app-server is missing.
		const codexFallback = async () => {
			if (!this.codexSample) {
				await this.getLocalUsage().catch(() => undefined);
			}
			return this.codexSample;
		};
		const readers = claudeHomes(this.home, this.extraClaudeDirs(env)).map(claudeHome => this.claudeReader(claudeHome));
		const codex = codexHomes(this.home, env, dirs.codex);
		const reads: Promise<{ group: IVoltUsageLimitGroup | undefined; login?: LocalLogin }>[] = [
			...codex.map((codexHome, index) => readCodexLimits(this.home, codexHome, env, index === 0 ? codexFallback : undefined)
				.then(group => ({ group, login: { provider: 'codex' as const, codexHome } }))),
			...readers.map(reader => reader.read(env).then(group => ({ group, login: { provider: 'claude' as const, reader } }))),
			readCursorLimits(this.home).then(group => ({ group })),
			readOpenCodeGoLimits(this.home, env).then(group => ({ group })),
			readGrokLimits(this.home, env).then(group => ({ group })),
		];
		const settled = await Promise.allSettled(reads);
		const value: IVoltUsageLimitGroup[] = [];
		const logins = new Map<string, LocalLogin>();
		const seen = new Set<string>();
		for (const result of settled) {
			if (result.status === 'rejected') {
				this.logService.warn('[volt-usage] limit read failed', result.reason);
				continue;
			}
			const { group, login } = result.value;
			if (!group) {
				continue;
			}
			// Two directories signed in to one account read the same numbers; show it once.
			const key = group.account ? accountKey(group.provider, group.account.id) : undefined;
			if (key && seen.has(key)) {
				continue;
			}
			if (key) {
				seen.add(key);
				if (login) {
					logins.set(key, login);
				}
			}
			value.push(group);
		}
		this.localLogins = logins;
		this.limits = { at: Date.now(), value };
		return value;
	}

	private transcriptRoots(env: NodeJS.ProcessEnv): { root: string; provider: 'claude' | 'codex' }[] {
		const claudeDirs = new Set([join(this.home, '.claude'), join(this.home, '.config', 'claude')]);
		for (const claudeHome of claudeHomes(this.home, this.extraClaudeDirs(env))) {
			claudeDirs.add(claudeHome.configDir);
		}
		return [
			...[...claudeDirs].map(dir => ({ root: join(dir, 'projects'), provider: 'claude' as const })),
			...codexHomes(this.home, env, this.accountDirs().codex).flatMap(codexHome => [
				{ root: join(codexHome, 'sessions'), provider: 'codex' as const },
				{ root: join(codexHome, 'archived_sessions'), provider: 'codex' as const },
			]),
		];
	}

	private async build(force: boolean): Promise<IVoltUsageSnapshot> {
		const started = Date.now();
		const now = Date.now();
		// One extra day so the oldest local day of the longest range is complete.
		const sinceMs = now - (VOLT_USAGE_HISTORY_DAYS + 1) * DAY_MS;
		const env = await this.resolveEnv();
		const cursorPromise = this.readCursor(sinceMs, force);
		await this.pricing.ensureLoaded();

		const files: ITranscriptFile[] = [];
		for (const { root, provider } of this.transcriptRoots(env)) {
			await listTranscripts(root, provider, sinceMs, files);
		}
		const live = new Set(files.map(file => file.path));
		for (const path of this.transcripts.keys()) {
			if (!live.has(path)) {
				this.transcripts.delete(path);
			}
		}
		let parsedFiles = 0;
		for (const file of files) {
			const cached = this.transcripts.get(file.path);
			if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
				continue;
			}
			try {
				const parsed = await parseTranscript(file);
				this.transcripts.set(file.path, { ...parsed, provider: file.provider, mtimeMs: file.mtimeMs, size: file.size });
				parsedFiles++;
			} catch (error) {
				this.logService.trace('[volt-usage] could not read transcript', file.path, error);
			}
			await yieldToLoop();
		}

		const buckets = new Map<string, IMutableBucket>();
		const activity = new Map<string, { provider: VoltUsageProvider; hour: number; sessions: Set<number> }>();
		const sessionIds = new Map<string, number>();
		const inWindow = (ms: number) => ms >= sinceMs && ms <= now + HOUR_MS;
		const markActive = (provider: VoltUsageProvider, sessionId: string, hour: number) => {
			if (!sessionId || !inWindow(hour + HOUR_MS - 1)) {
				return;
			}
			const sessionKey = `${provider}:${sessionId}`;
			let index = sessionIds.get(sessionKey);
			if (index === undefined) {
				index = sessionIds.size;
				sessionIds.set(sessionKey, index);
			}
			const key = `${provider}\u0000${hour}`;
			let entry = activity.get(key);
			if (!entry) {
				entry = { provider, hour, sessions: new Set() };
				activity.set(key, entry);
			}
			entry.sessions.add(index);
		};
		const add = (item: IUsageRecord) => {
			if (!inWindow(item.timestampMs)) {
				return;
			}
			const hour = Math.floor(item.timestampMs / HOUR_MS) * HOUR_MS;
			const key = `${item.provider}\u0000${item.model}\u0000${hour}`;
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = {
					provider: item.provider, model: item.model, hour,
					uncached: 0, cached: 0, cacheWrite: 0, output: 0,
					costUsd: 0, savingsUsd: 0, unpriced: false,
					inputCostUsd: 0, cacheReadCostUsd: 0, cacheWriteCostUsd: 0, outputCostUsd: 0,
					fastCostUsd: 0, ultrafastCostUsd: 0, speedPremiumUsd: 0,
				};
				buckets.set(key, bucket);
			}
			const price = this.pricing.price(item, item.provider === 'cursor' ? cursorRateModel(item.model) : item.model);
			bucket.uncached += item.uncached;
			bucket.cached += item.cached;
			bucket.cacheWrite += item.cacheWrite;
			bucket.output += item.output;
			bucket.costUsd += price.cost;
			bucket.savingsUsd += price.savings;
			bucket.unpriced ||= price.unpriced;
			if (price.categories) {
				bucket.inputCostUsd += price.categories.input;
				bucket.cacheReadCostUsd += price.categories.cacheRead;
				bucket.cacheWriteCostUsd += price.categories.cacheWrite;
				bucket.outputCostUsd += price.categories.output;
			}
			if (item.speed === 'fast') {
				bucket.fastCostUsd += price.cost;
			} else if (item.speed === 'ultrafast') {
				bucket.ultrafastCostUsd += price.cost;
			}
			bucket.speedPremiumUsd += price.premium;
			markActive(item.provider, item.sessionId, hour);
		};

		let codexSample: ICodexRateLimitSample | undefined;
		// Oldest files first, so the original of a record copied into a resumed session wins.
		const ordered = [...this.transcripts.values()].sort((a, b) => a.mtimeMs - b.mtimeMs);
		const keyed: IUsageRecord[] = [];
		for (const transcript of ordered) {
			for (const item of transcript.records) {
				if (item.dedupeKey) {
					keyed.push(item);
				} else {
					add(item);
				}
			}
			if (transcript.activity) {
				for (const sessionId of transcript.activity.sessionIds) {
					for (const hour of transcript.activity.hours) {
						markActive(transcript.provider, sessionId, hour);
					}
				}
			}
			if (transcript.rateLimits && (!codexSample || codexSample.timestampMs < transcript.rateLimits.timestampMs)) {
				codexSample = transcript.rateLimits;
			}
		}
		for (const item of billOncePerResponse(keyed)) {
			add(item);
		}
		this.codexSample = codexSample;

		const notes: IVoltUsageNote[] = [];
		const cursor = await cursorPromise;
		for (const item of cursor?.records ?? []) {
			add(item);
		}
		if (cursor?.error) {
			notes.push({ provider: 'cursor', message: cursor.error });
		}

		const out: IVoltUsageBucket[] = [...buckets.values()].sort((a, b) => a.hour - b.hour);
		const activityOut: IVoltUsageActivity[] = [...activity.values()]
			.map(entry => ({ provider: entry.provider, hour: entry.hour, sessions: [...entry.sessions] }))
			.sort((a, b) => a.hour - b.hour);
		this.snapshot = {
			generatedAt: Date.now(),
			sinceMs,
			buckets: out,
			activity: activityOut,
			sessionCount: sessionIds.size,
			notes,
			pricingSource: this.pricing.description,
		};
		this.logService.info(`[volt-usage] ${files.length} transcripts (${parsedFiles} parsed), ${out.length} buckets in ${Date.now() - started}ms`);
		return this.snapshot;
	}

	private async readCursor(sinceMs: number, force: boolean): Promise<ICursorUsage | undefined> {
		if (!force && this.cursor && Date.now() - this.cursor.at < CURSOR_TTL_MS) {
			return this.cursor.value;
		}
		try {
			const value = await readCursorUsage(this.home, sinceMs);
			this.cursor = { at: Date.now(), value };
			return value;
		} catch (error) {
			this.logService.warn('[volt-usage] cursor usage failed', error);
			return this.cursor?.value;
		}
	}

	//#endregion
}
