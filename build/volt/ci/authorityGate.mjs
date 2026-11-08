/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Policy Authority gate (sandbox spec C2 "Done", INV-01): permission decisions are made by one
// function, `evaluate` in src/vs/platform/voltSandbox/common/authority.ts. This finds calls to the
// allow-list primitives a decision is built from (ceiling checks, grant and refusal matching,
// capability and target matching, chat coverage, the pre-Authority rules kept for shadow mode)
// anywhere else in src/ and apps/, and fails unless the site is in authority-allowlist.json with a
// reason. Callers already moved onto the Authority (the host-tool gate, the extension API) may not
// grow a decision of their own again.
//
// What still decides outside the Authority is listed under `remaining` in the allowlist file (the
// files and network brokers' path, page and host rules); it is documentation, not checked here.
// Tests and fixtures are not scanned.
//
// Usage: node build/volt/ci/authorityGate.mjs [--root <dir>] [--warn]
//   --warn   report, but exit 0

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The Authority's own modules: where the primitives are defined and used. */
export const AUTHORITY_FILES = new Set([
	'src/vs/platform/voltSandbox/common/authority.ts',
	'src/vs/platform/voltSandbox/common/grants.ts',
	'src/vs/platform/voltPlugins/common/capabilityCatalog.ts',
	'src/vs/platform/voltPlugins/common/firstPartyCeilings.ts',
	// The network broker's host rules (C3): only the Authority matches them.
	'src/vs/platform/voltSandbox/common/networkRules.ts',
]);
const ALLOWLIST = 'build/volt/ci/authority-allowlist.json';
const SCANNED = ['src', 'apps'];
const EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'out', 'dist', 'build', '.build', 'test', 'tests', '__tests__', 'fixtures', '.expo', 'ios', 'android']);
const SKIPPED_FILES = /\.(test|spec|d)\.[cm]?[jt]sx?$/;

/** The primitives an allow-list decision is made of. A call outside the Authority is a second decision function. */
export const PRIMITIVES = [
	'ceilingCovers', 'declarationsOutsideCeiling', 'chatCovers', 'grantCovers', 'grantValid', 'hasRefusal',
	'capabilityIdCovers', 'capabilityTargetMatches', 'manifestDenial', 'egressWithin',
	'legacySandboxCovers', 'legacyHostToolRefusal', 'legacyExtensionDenial',
	'networkRulesCover', 'networkRuleCovers',
];
const CALL = new RegExp(`(?<![\\w$])(${PRIMITIVES.join('|')})\\s*\\(`);
const DEFINITION = new RegExp(`\\bfunction\\s+(${PRIMITIVES.join('|')})\\b`);

/** @typedef {{ file: string, line: number, kind: string, text: string }} Finding */
/** @typedef {{ file: string, text: string, reason: string }} AllowEntry */

/**
 * The primitive calls in one file's text.
 * @param {string} file repository-relative, `/`-separated
 * @param {string} text
 * @returns {Finding[]}
 */
export function findDecisions(file, text) {
	if (AUTHORITY_FILES.has(file)) {
		return [];
	}
	const findings = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || /^import\b/.test(trimmed) || /^export\s*\{/.test(trimmed)) {
			continue;
		}
		const match = CALL.exec(trimmed);
		// A method call (`this.authority.x(`) is an object's API, not the primitive.
		if (match && !DEFINITION.test(trimmed) && trimmed[match.index - 1] !== '.') {
			findings.push({ file, line: i + 1, kind: match[1], text: trimmed });
		}
	}
	return findings;
}

/**
 * Findings no allowlist entry covers, and entries that no longer match anything (stale).
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
	return { unallowed, stale: allowlist.filter((_entry, index) => !used.has(index)) };
}

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
			if (CALL.test(text)) {
				findings.push(...findDecisions(file, text));
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
		console.warn(`authority gate: stale allowlist entry (nothing matches it any more): ${entry.file}: ${entry.text}`);
	}
	for (const entry of missingReason) {
		console.error(`authority gate: allowlist entry without a reason: ${entry.file}: ${entry.text}`);
	}
	for (const finding of unallowed) {
		console.error(`${finding.file}:${finding.line}: ${finding.kind}() outside the Policy Authority. Ask \`evaluate\` (src/vs/platform/voltSandbox/common/authority.ts) instead, or add a reviewed entry with a reason to ${ALLOWLIST}.\n    ${finding.text}`);
	}
	const failed = unallowed.length > 0 || missingReason.length > 0;
	if (failed && !warn) {
		process.exitCode = 1;
	} else if (!failed) {
		console.log(`authority gate: no permission decision outside the Policy Authority beyond the ${allowlist.length - stale.length} reviewed sites.`);
	}
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('authorityGate.mjs')) {
	main();
}
