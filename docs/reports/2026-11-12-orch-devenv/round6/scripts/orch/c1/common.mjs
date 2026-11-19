// Shared parts of the round-4 C1 rig (ADEMark method, unofficial): paths, the prompt with its handoff codes,
// the capture reader and ADEMark's rules for agents, the end of a run, tokens and fan-out.
// Everything that must survive a restart lives under C1_DIR (~/.volt-r6/orch/c1).
import { execSync } from 'child_process';
import { createHash, createHmac } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const here = dirname(fileURLToPath(import.meta.url));
export const C1_DIR = process.env.C1_DIR ?? join(homedir(), '.volt-r6/orch/c1');
export const ADEMARK = process.env.ADEMARK ?? join(homedir(), '.volt-r4/ademark');
export const ARENA = join(ADEMARK, 'arena');
export const ARENA_BASE = join(C1_DIR, 'arena-base');
export const RUNS = join(C1_DIR, 'runs');
export const DATA = join(here, '../../../data/orch/c1');
export const CFG = join(C1_DIR, 'cfg-clean');
export const PROXY_PORT = Number(process.env.C1_PROXY_PORT ?? 19972);
export const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
export const CAPTURE = join(C1_DIR, 'capture.jsonl');
export const CAP_MS = 45 * 60_000;
export const QUIET_MS = Number(process.env.C1_QUIET_MS ?? 5 * 60_000);
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- prompt and handoff codes (TASKS.md 1.6, bench/core/tasks.ts) ----------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes, length) {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
			if (out.length === length) {
				return out;
			}
		}
	}
	return out;
}

/** ADEMark's seed for a run id (tracks/c/shared.ts handoffSeedFor). */
export const seedFor = runId => `ademark-volt-r6-${runId}`;

export function codesFor(seed) {
	const code = w => `ADM-${w}-${base32(createHmac('sha256', seed).update(w).digest(), 6)}`;
	return { W1: code('W1'), W2: code('W2'), W3: code('W3'), W4: code('W4') };
}

/** The task's prompt.md with the run's codes filled in, byte for byte (no trim). */
export function taskPrompt(kind, seed) {
	let text = readFileSync(join(ADEMARK, 'tasks', kind === 'solo' ? 'C1-solo' : 'C1-orchestrated-build', 'prompt.md'), 'utf8');
	for (const [w, code] of Object.entries(codesFor(seed))) {
		text = text.split(`{{${w}_CODE}}`).join(code);
	}
	return text;
}

// ---------- capture ----------

export function readJsonl(file) {
	if (!existsSync(file)) {
		return [];
	}
	return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
}

export const isCompletion = row => typeof row.path === 'string' && /\/v1\/messages\/?$/.test(row.path.split('?')[0]);

export function bodyOf(row, capture = CAPTURE) {
	const file = `${capture}.bodies/${row.n}.json.gz`;
	if (!existsSync(file)) {
		return undefined;
	}
	try { return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')); } catch { return undefined; }
}

/** The capture rows of one run window [fromMs, toMs] (row end = t + ms, as ADEMark's t_ns is the row's write). */
export function rowsBetween(fromMs, toMs = Infinity, capture = CAPTURE) {
	return readJsonl(capture).filter(r => typeof r.t === 'number' && r.t >= fromMs && r.t + (r.ms ?? 0) <= toMs);
}

/**
 * ADEMark's agents (tracks/c/agents.ts): a request whose last user message answers a tool is an agent at work; a
 * session with an answer counts once, plus once for each further thread it started. The proxy stores `meta`.
 */
export function agentsSeen(rows) {
	const sessions = new Map();
	let toolAnswers = 0;
	let lastWorkMs = null;
	for (const row of rows) {
		if (!isCompletion(row) || (row.status ?? 0) >= 400 || !row.meta) {
			continue;
		}
		const key = row.meta.session ?? '-';
		const s = sessions.get(key) ?? { roots: new Set(), answers: 0 };
		sessions.set(key, s);
		if (row.meta.root) {
			s.roots.add(row.meta.root);
		}
		if (row.meta.answersTool) {
			s.answers++;
			toolAnswers++;
			const end = row.t + (row.ms ?? 0);
			lastWorkMs = lastWorkMs === null ? end : Math.max(lastWorkMs, end);
		}
	}
	const working = [...sessions.values()].filter(s => s.answers > 0);
	return { agents: working.reduce((n, s) => n + Math.max(1, s.roots.size), 0), sessions: working.length, toolAnswers, lastWorkMs };
}

/** tokens-total: input + cache write + cache read + output of every completion (side calls included). */
export function tokensOf(rows) {
	const u = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, calls: 0, noUsage: 0, refused: 0, byModel: {} };
	for (const row of rows) {
		if (!isCompletion(row)) {
			continue;
		}
		if ((row.status ?? 0) >= 400) {
			u.refused++;
			continue;
		}
		if (!row.usage) {
			u.noUsage++;
			continue;
		}
		u.calls++;
		const m = (u.byModel[row.model ?? 'unknown'] ??= { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, calls: 0 });
		for (const [k, src] of [['input', 'input'], ['cacheWrite', 'cache_write'], ['cacheRead', 'cache_read'], ['output', 'output']]) {
			u[k] += row.usage[src] ?? 0;
			m[k] += row.usage[src] ?? 0;
		}
		m.calls++;
	}
	return { total: u.input + u.cacheWrite + u.cacheRead + u.output, ...u };
}

/** USD from ADEMark's price file (prices/2026-10.json), per row's model. */
export function usdOf(rows) {
	let prices;
	try {
		const dir = join(ADEMARK, 'prices');
		const file = readdirSync(dir).filter(f => f.endsWith('.json')).sort().at(-1);
		prices = JSON.parse(readFileSync(join(dir, file), 'utf8'));
	} catch {
		return null;
	}
	// bench/capture/tokens.ts priceUsd: the row's exact model, the long-context rates above their threshold.
	let usd = 0;
	const unpriced = new Set();
	for (const row of rows) {
		if (!isCompletion(row) || !row.usage) {
			continue;
		}
		const base = prices.models[String(row.model).replace(/\[1m\]$/, '')];
		const u = row.usage;
		const prompt = u.input + u.cache_write + u.cache_read;
		const p = base?.long_context !== undefined && prompt > base.long_context.above ? base.long_context : base;
		if (!p || [p.input, p.output, p.cache_read, p.cache_write_5m, p.cache_write_1h].some(v => typeof v !== 'number')) {
			unpriced.add(row.model);
			continue;
		}
		const w1h = u.cache_write_1h ?? 0;
		usd += (u.input * p.input + u.output * p.output + u.cache_read * p.cache_read + (u.cache_write - w1h) * p.cache_write_5m + w1h * p.cache_write_1h) / 1e6;
	}
	return { usd: unpriced.size ? null : +usd.toFixed(4), unpriced: [...unpriced] };
}

// ---------- fan-out (Claude Code session logs, distinct cwd, overlapping time) ----------

/** Every Claude Code session log in the config dir that ran in `repo` or one of its worktrees since `sinceMs`. */
export function sessionIntervals(cfg, sinceMs, cwdTest) {
	const root = join(cfg, 'projects');
	if (!existsSync(root)) {
		return [];
	}
	const out = [];
	for (const dir of readdirSync(root)) {
		for (const name of readdirSync(join(root, dir)).filter(n => n.endsWith('.jsonl'))) {
			const lines = readJsonl(join(root, dir, name));
			const stamped = lines.filter(l => l.timestamp && l.cwd);
			if (!stamped.length) {
				continue;
			}
			const cwd = stamped[0].cwd;
			const times = stamped.map(l => Date.parse(l.timestamp)).filter(Number.isFinite);
			const start = Math.min(...times);
			const end = Math.max(...times);
			if (end < sinceMs || !cwdTest(cwd)) {
				continue;
			}
			const sidechain = stamped.every(l => l.isSidechain);
			out.push({ file: join(dir, name), cwd, start, end, sidechain, session: stamped[0].sessionId });
		}
	}
	return out;
}

export function fanOut(intervals) {
	const max = Math.max(0, ...intervals.map(s => intervals.filter(o => o.start <= s.start && o.end > s.start).length));
	return { max, total: intervals.length };
}

export function sha16(text) {
	return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** `uptime`'s three load averages, as text ("1.23 4.56 7.89"). */
export function loadAvg() {
	return execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();
}
