/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The listener lint (spec K.4, INV-07): every network listener Volt opens goes through the listener
// library in src/vs/platform/voltListeners/, which authenticates every request with a secret and
// never lets loopback, Host or Origin vouch for a caller. This finds `http.createServer`,
// `net.createServer` (and their https/tls/http2 kin), `WebSocketServer` and `<server>.listen(`
// anywhere else in src/ and apps/ and fails unless the site is in listener-allowlist.json with a
// reason (a reviewed site: upstream VS Code code, a port probe, a socket only the sandbox sees).
// Tests and fixtures are not scanned.
//
// Usage: node build/volt/ci/listenerLint.mjs [--root <dir>] [--warn]
//   --warn   report, but exit 0

import * as fs from 'node:fs';
import * as path from 'node:path';

const LIBRARY = 'src/vs/platform/voltListeners/';
const ALLOWLIST = 'build/volt/ci/listener-allowlist.json';
const SCANNED = ['src', 'apps'];
const EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'out', 'dist', 'build', '.build', 'test', 'tests', '__tests__', 'fixtures', '.expo', 'ios', 'android']);
const SKIPPED_FILES = /\.(test|spec|d)\.[cm]?[jt]sx?$/;

/** @typedef {{ file: string, line: number, kind: string, text: string }} Finding */
/** @typedef {{ file: string, text: string, reason: string }} AllowEntry */

const RULES = [
	{ kind: 'createServer', pattern: /\b(?:http|https|http2|net|tls)\.create(?:Secure)?Server\s*\(/ },
	{ kind: 'WebSocketServer', pattern: /\bWebSocketServer\b\s*\(|\bnew\s+(?:\w+\.)?WebSocketServer\b/ },
	// `server.listen(`, `this._server.listen(`, `proxy.listen(`: a listener, not an event (`channel.listen('x')`).
	{ kind: 'listen', pattern: /\b[\w$.]*(?:[sS]erver|[pP]roxy)\s*\.listen\s*\(/ },
];

/** `import { createServer } from 'http'` (or net, https, tls, http2): bare `createServer(` calls count too. */
const BARE_IMPORT = /\bcreate(?:Secure)?Server\b[^;\n]*\bfrom\s*['"](?:node:)?(?:http|https|http2|net|tls)['"]|\{\s*[^}]*\bcreate(?:Secure)?Server\b[^}]*\}\s*=\s*(?:await\s+)?(?:import|require)\(\s*['"](?:node:)?(?:http|https|http2|net|tls)['"]\s*\)/;
const BARE_CALL = /(?<![\w$.])create(?:Secure)?Server\s*\(/;

/**
 * The listener sites in one file's text.
 * @param {string} file repository-relative, `/`-separated
 * @param {string} text
 * @returns {Finding[]}
 */
export function findListeners(file, text) {
	if (file.startsWith(LIBRARY)) {
		return [];
	}
	const bare = BARE_IMPORT.test(text);
	const findings = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
			continue;
		}
		for (const rule of RULES) {
			if (rule.pattern.test(line)) {
				findings.push({ file, line: i + 1, kind: rule.kind, text: trimmed });
			}
		}
		if (bare && BARE_CALL.test(line) && !/\bfunction\s+create(?:Secure)?Server\b/.test(line) && !RULES[0].pattern.test(line)) {
			findings.push({ file, line: i + 1, kind: 'createServer', text: trimmed });
		}
	}
	return findings;
}

/**
 * Findings no allowlist entry covers, and entries that no longer match anything (stale).
 * An entry covers every finding in its file whose trimmed line text equals its `text`.
 * @param {Finding[]} findings
 * @param {AllowEntry[]} allowlist
 */
export function checkFindings(findings, allowlist) {
	const used = new Set();
	const unallowed = [];
	for (const finding of findings) {
		const index = allowlist.findIndex(entry => entry.file === finding.file && entry.text === finding.text);
		if (index === -1) {
			unallowed.push(finding);
		} else {
			used.add(index);
		}
	}
	const stale = allowlist.filter((_entry, index) => !used.has(index));
	return { unallowed, stale };
}

/** @param {string} root */
function* walk(root, dir) {
	let entries;
	try {
		entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const relative = dir ? `${dir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
				yield* walk(root, relative);
			}
		} else if (entry.isFile() && EXTENSIONS.test(entry.name) && !SKIPPED_FILES.test(entry.name)) {
			yield relative;
		}
	}
}

/** @param {string} root */
export function scan(root) {
	const findings = [];
	for (const top of SCANNED) {
		for (const file of walk(root, top)) {
			const text = fs.readFileSync(path.join(root, file), 'utf8');
			if (/createServer|WebSocketServer|\.listen\s*\(/.test(text)) {
				findings.push(...findListeners(file, text));
			}
		}
	}
	return findings;
}

function main() {
	const args = process.argv.slice(2);
	const rootIndex = args.indexOf('--root');
	const root = rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : process.cwd();
	const warn = args.includes('--warn');
	/** @type {AllowEntry[]} */
	const allowlist = JSON.parse(fs.readFileSync(path.join(root, ALLOWLIST), 'utf8')).sites;
	const missingReason = allowlist.filter(entry => typeof entry.reason !== 'string' || entry.reason.trim().length < 10);
	const { unallowed, stale } = checkFindings(scan(root), allowlist);
	for (const entry of stale) {
		console.warn(`listener lint: stale allowlist entry (nothing matches it any more): ${entry.file}: ${entry.text}`);
	}
	for (const entry of missingReason) {
		console.error(`listener lint: allowlist entry without a reason: ${entry.file}: ${entry.text}`);
	}
	for (const finding of unallowed) {
		console.error(`${finding.file}:${finding.line}: ${finding.kind} outside the listener library (${LIBRARY}). Use createAuthenticatedServer / createListenerServer from listenerAuth.ts, or add a reviewed entry with a reason to ${ALLOWLIST}.\n    ${finding.text}`);
	}
	const failed = unallowed.length > 0 || missingReason.length > 0;
	if (failed && !warn) {
		process.exitCode = 1;
	} else if (!failed) {
		console.log(`listener lint: no listener outside ${LIBRARY} beyond the ${allowlist.length - stale.length} reviewed sites.`);
	}
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('listenerLint.mjs')) {
	main();
}
