/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'os';
import { join } from '../../../base/common/path.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltTokenRates, IVoltUsageActivity, IVoltUsageBucket, IVoltUsageLimitGroup, IVoltUsageNote, IVoltUsageService, IVoltUsageSnapshot, VOLT_USAGE_HISTORY_DAYS, VoltUsageProvider } from '../common/voltUsage.js';
import { ClaudeLimitsReader, cursorRateModel, ICursorUsage, readCodexLimits, readCursorLimits, readCursorUsage } from './usageAccounts.js';
import { UsagePricing } from './usagePricing.js';
import { billOncePerResponse, ICodexRateLimitSample, IParsedTranscript, ITranscriptFile, IUsageRecord, listTranscripts, parseTranscript } from './usageTranscripts.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A snapshot this fresh is returned as is unless the caller forces a rescan. */
const SNAPSHOT_TTL_MS = 20_000;
const LIMITS_TTL_MS = 60_000;
const CURSOR_TTL_MS = 2 * 60_000;

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
 * from LiteLLM's public list. Transcripts are parsed once and re-read only when they change.
 */
export class VoltUsageService implements IVoltUsageService {

	declare readonly _serviceBrand: undefined;

	private readonly transcripts = new Map<string, ICachedTranscript>();
	private readonly pricing: UsagePricing;
	private readonly claudeLimits: ClaudeLimitsReader;
	private snapshot: IVoltUsageSnapshot | undefined;
	private building: Promise<IVoltUsageSnapshot> | undefined;
	private limits: { at: number; value: readonly IVoltUsageLimitGroup[] } | undefined;
	private limitsReading: Promise<readonly IVoltUsageLimitGroup[]> | undefined;
	private cursor: { at: number; value: ICursorUsage | undefined } | undefined;
	private codexSample: ICodexRateLimitSample | undefined;

	constructor(
		private readonly resolveEnv: () => Promise<NodeJS.ProcessEnv>,
		private readonly logService: ILogService,
		cacheDir: string,
		private readonly home = homedir(),
	) {
		this.pricing = new UsagePricing(join(cacheDir, 'litellm-prices.json'));
		this.claudeLimits = new ClaudeLimitsReader(this.home, join(cacheDir, 'claude-limits.json'));
	}

	async getUsage(force?: boolean): Promise<IVoltUsageSnapshot> {
		if (!force && this.snapshot && Date.now() - this.snapshot.generatedAt < SNAPSHOT_TTL_MS) {
			return this.snapshot;
		}
		this.building ??= this.build(!!force).finally(() => this.building = undefined);
		return this.building;
	}

	async getLimits(force?: boolean): Promise<readonly IVoltUsageLimitGroup[]> {
		if (!force && this.limits && Date.now() - this.limits.at < LIMITS_TTL_MS) {
			return this.limits.value;
		}
		this.limitsReading ??= this.readLimits().finally(() => this.limitsReading = undefined);
		return this.limitsReading;
	}

	async getModelRates(models: readonly string[]): Promise<Record<string, IVoltTokenRates | null>> {
		await this.pricing.ensureLoaded();
		const rates: Record<string, IVoltTokenRates | null> = {};
		for (const model of models) {
			const rate = this.pricing.rate(model);
			rates[model] = rate ? { input: rate.input, output: rate.output, cacheRead: rate.cacheRead, cacheWrite: rate.cacheWrite } : null;
		}
		return rates;
	}

	private async readLimits(): Promise<readonly IVoltUsageLimitGroup[]> {
		const env = await this.resolveEnv();
		// The rollout scan finds the newest Codex sample, the fallback when app-server is missing.
		const codexFallback = async () => {
			if (!this.codexSample) {
				await this.getUsage().catch(() => undefined);
			}
			return this.codexSample;
		};
		const settled = await Promise.allSettled([
			readCodexLimits(this.home, env, codexFallback),
			this.claudeLimits.read(),
			readCursorLimits(this.home),
		]);
		const value: IVoltUsageLimitGroup[] = [];
		for (const result of settled) {
			if (result.status === 'fulfilled' && result.value) {
				value.push(result.value);
			} else if (result.status === 'rejected') {
				this.logService.warn('[volt-usage] limit read failed', result.reason);
			}
		}
		this.limits = { at: Date.now(), value };
		return value;
	}

	private transcriptRoots(env: NodeJS.ProcessEnv): { root: string; provider: 'claude' | 'codex' }[] {
		const claudeHomes = new Set([join(this.home, '.claude'), join(this.home, '.config', 'claude')]);
		for (const dir of (env.CLAUDE_CONFIG_DIR ?? '').split(',').map(value => value.trim()).filter(Boolean)) {
			claudeHomes.add(dir);
		}
		const codexHome = env.CODEX_HOME?.trim() || join(this.home, '.codex');
		return [
			...[...claudeHomes].map(dir => ({ root: join(dir, 'projects'), provider: 'claude' as const })),
			{ root: join(codexHome, 'sessions'), provider: 'codex' },
			{ root: join(codexHome, 'archived_sessions'), provider: 'codex' },
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
}
