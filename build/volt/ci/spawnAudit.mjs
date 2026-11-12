/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * The spawn audit (spec K.4, INV-03): every place in `src/` and `apps/` that can start a process or
 * run code outside the current realm (`child_process.*`, `utilityProcess.fork`, `new Worker`,
 * `vm.*`, node-pty's `spawn`) is listed in `build/volt/sandbox-spawn-allowlist.json` with an owner
 * and a reason:
 *
 * - `supervisor`: Volt's core starts it, as the monitor: the sandbox supervisor and its backends,
 *   the stdio service that runs chats' processes (through the sandbox when the chat has one), and
 *   the app's own host and helper processes. Nothing an agent wrote decides what runs.
 * - `user-action`: it runs for the user's own action: their terminals and tasks, installs and
 *   checks they click, their extensions, their debug sessions.
 * - `build-only`: build, release and development tooling that never ships in the app.
 *
 * A new site, or a file whose sites grew, fails until it is listed; a listed site that went away
 * fails too, so the list stays exact. Sites are counted per file and kind, not by line, so edits
 * around them do not churn the list. Tests (`test/` folders, `*.test.*`) are not audited.
 *
 *   node build/volt/ci/spawnAudit.mjs           check (CI)
 *   node build/volt/ci/spawnAudit.mjs --print   the sites found now, as allowlist entries without reasons
 */

import { readdirSync, readFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ALLOWLIST = join(ROOT, 'build', 'volt', 'sandbox-spawn-allowlist.json');
const SCANNED = ['src', 'apps'];
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'build', '.build', 'test', 'tests', '__tests__', 'fixtures', 'ios', 'android', 'Pods', '.expo']);
const EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
export const REASONS = ['supervisor', 'user-action', 'build-only'];
const CHILD_PROCESS_FUNCTIONS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

/** @returns {string[]} */
function sourceFiles(dir) {
	const out = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
				out.push(...sourceFiles(path));
			}
		} else if (EXTENSIONS.test(entry.name) && !/\.test\.|\.spec\.|\.d\.ts$/.test(entry.name)) {
			out.push(path);
		}
	}
	return out;
}

/** Comments out, so a call named in a comment is not a site. Strings stay (module names are read from them). */
function stripComments(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const count = (text, pattern) => (text.match(pattern) ?? []).length;

/**
 * The sites in one file's text, by kind.
 * @returns {Record<string, number>}
 */
export function sitesIn(source) {
	const text = stripComments(source);
	const sites = {};
	const add = (kind, n) => {
		if (n > 0) {
			sites[kind] = (sites[kind] ?? 0) + n;
		}
	};

	// child_process: through the names a file binds to it.
	const module = `['"](?:node:)?child_process['"]`;
	if (new RegExp(module).test(text)) {
		let n = 0;
		const named = new RegExp(`import\\s+(?!type\\b)\\{([^}]*)\\}\\s+from\\s+${module}|(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*(?:require\\(\\s*${module}\\s*\\)|await\\s+import\\(\\s*${module}\\s*\\))`, 'g');
		for (const match of text.matchAll(named)) {
			for (const part of (match[1] ?? match[2]).split(',')) {
				const [imported, local] = part.replace(/\btype\s+/, '').trim().split(/\s+as\s+|\s*:\s*/).map(value => value?.trim());
				const name = local || imported;
				if (imported && CHILD_PROCESS_FUNCTIONS.includes(imported) && name) {
					n += count(text, new RegExp(`(?<![\\w.$])${escape(name)}\\s*\\(`, 'g'));
					// promisify(execFile) is the site; its calls go through the promisified name.
					n += count(text, new RegExp(`promisify\\(\\s*${escape(name)}\\s*\\)`, 'g'));
				}
			}
		}
		const namespace = new RegExp(`import\\s+(?:\\*\\s+as\\s+)?(\\w+)\\s+from\\s+${module}|(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:require\\(\\s*${module}\\s*\\)|await\\s+import\\(\\s*${module}\\s*\\))`, 'g');
		for (const match of text.matchAll(namespace)) {
			const name = match[1] ?? match[2];
			n += count(text, new RegExp(`(?<![\\w.$])${escape(name)}\\.(?:${CHILD_PROCESS_FUNCTIONS.join('|')})\\s*\\(`, 'g'));
		}
		// `(await import('child_process')).spawn(...)` and the like.
		n += count(text, new RegExp(`import\\(\\s*${module}\\s*\\)\\)\\.(?:${CHILD_PROCESS_FUNCTIONS.join('|')})\\s*\\(`, 'g'));
		add('child_process', n);
	}

	add('utilityProcess.fork', count(text, /\butilityProcess\.fork\s*\(/g));
	add('new Worker', count(text, /\bnew\s+(?:\w+\.)?Worker\s*\(/g));

	const vmModule = `['"](?:node:)?vm['"]`;
	if (new RegExp(vmModule).test(text)) {
		let n = 0;
		for (const match of text.matchAll(new RegExp(`import\\s+(?:\\*\\s+as\\s+)?(\\w+)\\s+from\\s+${vmModule}|(?:const|let|var)\\s+(\\w+)\\s*=\\s*require\\(\\s*${vmModule}\\s*\\)`, 'g'))) {
			n += count(text, new RegExp(`(?<![\\w.$])${escape(match[1] ?? match[2])}\\.\\w+\\s*\\(`, 'g'));
		}
		for (const match of text.matchAll(new RegExp(`import\\s+(?!type\\b)\\{([^}]*)\\}\\s+from\\s+${vmModule}`, 'g'))) {
			for (const part of match[1].split(',')) {
				const name = part.trim().split(/\s+as\s+/).pop()?.trim();
				if (name) {
					n += count(text, new RegExp(`(?<![\\w.$])(?:new\\s+)?${escape(name)}\\s*\\(`, 'g'));
				}
			}
		}
		add('vm', n);
	}

	if (/['"]node-pty['"]/.test(text)) {
		let n = count(text, /\.spawn\s*\(/g);
		for (const match of text.matchAll(/import\s+(?!type\b)\{([^}]*)\}\s+from\s+['"]node-pty['"]/g)) {
			for (const part of match[1].split(',')) {
				const [imported, local] = part.trim().split(/\s+as\s+/).map(value => value.trim());
				if (imported === 'spawn') {
					n += count(text, new RegExp(`(?<![\\w.$])${escape(local || imported)}\\s*\\(`, 'g'));
				}
			}
		}
		add('pty.spawn', n);
	}
	return sites;
}

/** Every site now: `{ file, kind, count }`, sorted. */
export function scan(root = ROOT) {
	const out = [];
	for (const top of SCANNED) {
		for (const path of sourceFiles(join(root, top))) {
			const sites = sitesIn(readFileSync(path, 'utf8'));
			for (const [kind, n] of Object.entries(sites)) {
				out.push({ file: relative(root, path).split('\\').join('/'), kind, count: n });
			}
		}
	}
	return out.sort((a, b) => a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind));
}

/**
 * What is wrong with the allowlist for these sites: new or grown sites, listed sites that are
 * gone, entries without an owner or with a reason that is not one of {@link REASONS}.
 * @returns {string[]}
 */
export function audit(found, allowlist) {
	const problems = [];
	const key = entry => `${entry.file}\0${entry.kind}`;
	const listed = new Map();
	for (const entry of allowlist.sites ?? []) {
		if (listed.has(key(entry))) {
			problems.push(`${entry.file} (${entry.kind}): listed twice`);
		}
		listed.set(key(entry), entry);
		if (!REASONS.includes(entry.reason)) {
			problems.push(`${entry.file} (${entry.kind}): reason must be one of ${REASONS.join(', ')}, not ${JSON.stringify(entry.reason)}`);
		}
		for (const field of ['owner', 'why']) {
			if (typeof entry[field] !== 'string' || !entry[field].trim() || /\bTODO\b|\bTBD\b|\bFIXME\b/i.test(entry[field])) {
				problems.push(`${entry.file} (${entry.kind}): needs a real ${field}`);
			}
		}
	}
	const seen = new Set();
	for (const site of found) {
		seen.add(key(site));
		const entry = listed.get(key(site));
		if (!entry) {
			problems.push(`${site.file}: ${site.count} new ${site.kind} site(s). List them in build/volt/sandbox-spawn-allowlist.json with an owner, a reason (${REASONS.join(', ')}) and why; a process for a chat goes through the stdio service with the chat's ExecContext.`);
		} else if (site.count > entry.count) {
			problems.push(`${site.file}: ${site.count - entry.count} more ${site.kind} site(s) than listed (${entry.count}). Classify the new one(s) and raise the count.`);
		} else if (site.count < entry.count) {
			problems.push(`${site.file}: ${entry.count - site.count} fewer ${site.kind} site(s) than listed (${entry.count}). Lower the count.`);
		}
	}
	for (const entry of listed.values()) {
		if (!seen.has(key(entry))) {
			problems.push(`${entry.file} (${entry.kind}): listed, but no such site any more. Remove the entry.`);
		}
	}
	return problems;
}

function main() {
	const found = scan();
	if (process.argv.includes('--print')) {
		console.log(JSON.stringify(found, null, '\t'));
		return;
	}
	const allowlist = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
	const problems = audit(found, allowlist);
	if (problems.length) {
		console.error(`Spawn audit failed (${problems.length}):\n${problems.map(problem => `  - ${problem}`).join('\n')}`);
		process.exit(1);
	}
	console.log(`Spawn audit: ${found.reduce((sum, site) => sum + site.count, 0)} sites in ${new Set(found.map(site => site.file)).size} files, all listed.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
