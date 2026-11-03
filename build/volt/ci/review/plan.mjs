/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which files the AI review reads, in which batches, and where each comment the model wrote can go:
// GitHub rejects a whole review when one comment points at a line outside the diff, so every
// comment is checked against the diff first and moved to the summary when it does not fit.

import { commentableLines, hunkOfNewLine, parsePatch } from '../diff.mjs';
import { annotatePatch } from './prompt.mjs';

/**
 * @typedef {import('./prompt.mjs').PullFile} PullFile
 * @typedef {{ path: string, line: number, start_line?: number, side?: 'RIGHT' | 'LEFT', severity: 'critical' | 'major' | 'minor' | 'nit', category: string, title: string, body: string, suggestion?: string }} ModelComment
 * @typedef {{ filename: string, reason: string }} Skipped
 */

/** @type {[RegExp, string][]} */
const ignored = [
	[/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Podfile\.lock)$/, 'lockfile'],
	[/\.(snap|map)$/, 'generated'],
	[/\.min\.(js|css)$/, 'minified'],
	[/(^|\/)vendor\//, 'vendored'],
	[/(^|\/)(out|dist|out-build|\.build)\//, 'build output'],
	[/^(ThirdPartyNotices\.txt|cglicenses\.json|cgmanifest\.json)$/, 'license manifest'],
	[/^extensions\/[^/]+\/syntaxes\//, 'generated grammar'],
	[/\.(png|jpe?g|gif|webp|ico|icns|svg|ttf|woff2?|otf|mp4|mov|webm|wav|mp3|zip|tgz|gz|pdf|glb|gltf|bin|node|exe|dll|so|dylib)$/i, 'binary or media'],
];

/** Earlier tiers are reviewed first when a PR is over the run's budget. */
const tiers = [
	/^(src|cli\/src|apps\/[^/]+\/(src|app|server|bin))\//,
	/^(extensions\/[^/]+\/src|build|scripts|remote|\.github)\//,
	/\.(ts|tsx|js|mjs|cjs|rs|swift|kt|java|py|sh|ps1|css)$/,
];

/** @param {string} filename */
function tierOf(filename) {
	const isTest = /(^|\/)test\/|\.test\.|\.spec\./.test(filename);
	const index = tiers.findIndex(re => re.test(filename));
	return (index === -1 ? tiers.length : index) * 2 + (isTest ? 1 : 0);
}

/**
 * @param {PullFile[]} files every file of the review range
 * @param {{ batchChars: number, maxBatches: number }} limits
 * @returns {{ batches: PullFile[][], patches: Map<string, string>, skipped: Skipped[] }}
 */
export function planBatches(files, limits) {
	/** @type {Skipped[]} */
	const skipped = [];
	/** @type {PullFile[]} */
	const reviewable = [];
	const names = new Set(files.map(f => f.filename));
	for (const file of files) {
		const reason = ignored.find(([re]) => re.test(file.filename))?.[1];
		if (file.status === 'removed') {
			skipped.push({ filename: file.filename, reason: 'deleted' });
		} else if (reason) {
			skipped.push({ filename: file.filename, reason });
		} else if (/^build\/.*\.js$/.test(file.filename) && names.has(file.filename.replace(/\.js$/, '.ts'))) {
			skipped.push({ filename: file.filename, reason: 'compiled from the .ts next to it' });
		} else if (!file.patch) {
			skipped.push({ filename: file.filename, reason: file.status === 'renamed' && !file.additions && !file.deletions ? 'renamed only' : 'GitHub shows no diff (binary or too large)' });
		} else {
			reviewable.push(file);
		}
	}
	reviewable.sort((a, b) => tierOf(a.filename) - tierOf(b.filename) || a.filename.localeCompare(b.filename));

	/** @type {Map<string, string>} */
	const patches = new Map();
	/** @type {PullFile[][]} */
	const batches = [];
	let current = /** @type {PullFile[]} */ ([]);
	let size = 0;
	for (const file of reviewable) {
		let annotated = annotatePatch(/** @type {string} */(file.patch));
		if (annotated.length > limits.batchChars) {
			annotated = `${annotated.slice(0, limits.batchChars)}\n... (the rest of this file's diff is over the review's size limit)`;
		}
		if (current.length && size + annotated.length > limits.batchChars) {
			batches.push(current);
			current = [];
			size = 0;
		}
		if (batches.length >= limits.maxBatches) {
			skipped.push({ filename: file.filename, reason: 'over this run\'s review budget' });
			continue;
		}
		patches.set(file.filename, annotated);
		current.push(file);
		size += annotated.length;
	}
	if (current.length && batches.length < limits.maxBatches) {
		batches.push(current);
	}
	return { batches, patches, skipped };
}

/**
 * Checks each comment against the PR's diff: the path must be in it and the line shown in it.
 * A line a few lines off an added line snaps to it (models miscount); anything else goes to the
 * summary instead of failing the review.
 * @param {ModelComment[]} comments
 * @param {Map<string, string>} prPatches filename -> raw patch of the whole PR (base...head)
 * @returns {{ inline: ModelComment[], outside: ModelComment[] }}
 */
export function placeComments(comments, prPatches) {
	/** @type {ModelComment[]} */
	const inline = [];
	/** @type {ModelComment[]} */
	const outside = [];
	/** @type {Map<string, { right: Set<number>, left: Set<number>, hunkOf: Map<number, number> }>} */
	const cache = new Map();
	for (const raw of comments) {
		const comment = normalizeComment(raw);
		if (!comment) {
			continue;
		}
		const patch = prPatches.get(comment.path);
		if (!patch) {
			outside.push(comment);
			continue;
		}
		let lines = cache.get(comment.path);
		if (!lines) {
			const hunks = parsePatch(patch);
			lines = { ...commentableLines(hunks), hunkOf: hunkOfNewLine(hunks) };
			cache.set(comment.path, lines);
		}
		const valid = comment.side === 'LEFT' ? lines.left : lines.right;
		if (!valid.has(comment.line)) {
			const near = [1, -1, 2, -2, 3, -3].map(d => comment.line + d).find(n => valid.has(n));
			if (near === undefined) {
				outside.push(comment);
				continue;
			}
			comment.line = near;
			delete comment.start_line;
			delete comment.suggestion;
		}
		if (comment.start_line !== undefined) {
			const sameHunk = comment.side !== 'LEFT' && lines.hunkOf.get(comment.start_line) === lines.hunkOf.get(comment.line);
			let contiguous = sameHunk && comment.start_line < comment.line;
			for (let n = comment.start_line; contiguous && n <= comment.line; n++) {
				contiguous = valid.has(n);
			}
			if (!contiguous) {
				delete comment.start_line;
				delete comment.suggestion;
			}
		}
		inline.push(comment);
	}
	return { inline, outside };
}

const severities = ['critical', 'major', 'minor', 'nit'];

/**
 * @param {any} raw
 * @returns {ModelComment | undefined}
 */
function normalizeComment(raw) {
	if (!raw || typeof raw.path !== 'string' || !Number.isInteger(raw.line) || raw.line < 1 || typeof raw.title !== 'string' || typeof raw.body !== 'string') {
		return undefined;
	}
	/** @type {ModelComment} */
	const comment = {
		path: raw.path.replace(/^\.?\//, ''),
		line: raw.line,
		side: raw.side === 'LEFT' ? 'LEFT' : 'RIGHT',
		severity: severities.includes(raw.severity) ? raw.severity : 'minor',
		category: typeof raw.category === 'string' ? raw.category : 'bug',
		title: raw.title.trim().slice(0, 200),
		body: raw.body.trim().slice(0, 4000),
	};
	if (Number.isInteger(raw.start_line) && raw.start_line >= 1 && raw.start_line < raw.line) {
		comment.start_line = raw.start_line;
	}
	if (typeof raw.suggestion === 'string' && raw.suggestion.trim() && comment.side === 'RIGHT') {
		comment.suggestion = raw.suggestion.replace(/\s+$/, '').slice(0, 6000);
	}
	return comment.title && comment.body ? comment : undefined;
}

/** @param {string} title */
export function titleKey(title) {
	return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Drops comments already posted on the same spot (an earlier run, or twice in this one), then
 * orders by severity and keeps the most important ones inline; nitpicks always go to the summary.
 * @param {ModelComment[]} comments
 * @param {{ path: string, line: number | null, title: string }[]} existing earlier review comments
 * @param {number} maxInline
 * @returns {{ inline: ModelComment[], nits: ModelComment[], overflow: ModelComment[] }}
 */
export function selectComments(comments, existing, maxInline) {
	/** @type {{ path: string, line: number, key: string }[]} */
	const seen = existing.filter(e => e.line !== null).map(e => ({ path: e.path, line: /** @type {number} */ (e.line), key: titleKey(e.title) }));
	/** @type {ModelComment[]} */
	const unique = [];
	for (const comment of comments) {
		const key = titleKey(comment.title);
		if (seen.some(s => s.path === comment.path && Math.abs(s.line - comment.line) <= 2 && (s.key === key || sharedWords(s.key, key) >= 0.6))) {
			continue;
		}
		seen.push({ path: comment.path, line: comment.line, key });
		unique.push(comment);
	}
	unique.sort((a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity) || a.path.localeCompare(b.path) || a.line - b.line);
	const nits = unique.filter(c => c.severity === 'nit');
	const important = unique.filter(c => c.severity !== 'nit');
	return { inline: important.slice(0, maxInline), nits, overflow: important.slice(maxInline) };
}

/**
 * The share of words two titles have in common.
 * @param {string} a
 * @param {string} b
 */
function sharedWords(a, b) {
	const wa = new Set(a.split(' ').filter(w => w.length > 2));
	const wb = new Set(b.split(' ').filter(w => w.length > 2));
	if (!wa.size || !wb.size) {
		return 0;
	}
	let common = 0;
	for (const w of wa) {
		if (wb.has(w)) {
			common++;
		}
	}
	return common / Math.max(wa.size, wb.size);
}
