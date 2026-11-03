/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The AI review's comments: one summary comment on the PR, edited in place on every run, and one
// review with inline comments per run. Hidden markers let the next run find its own comments and
// pick up where the last one stopped.

/**
 * @typedef {import('./plan.mjs').ModelComment} ModelComment
 * @typedef {import('./plan.mjs').Skipped} Skipped
 * @typedef {{ sha: string, files: Record<string, string>, summary: string, v: number }} ReviewState
 */

export const summaryMarker = '<!-- volt-ai-review:summary -->';
export const commentMarker = '<!-- volt-ai-review:comment -->';
const statePrefix = '<!-- volt-ai-review:state ';

const icons = { critical: ':red_circle:', major: ':orange_circle:', minor: ':yellow_circle:', nit: ':white_circle:' };
const labels = { critical: 'Critical', major: 'Major', minor: 'Minor', nit: 'Nitpick' };
const categories = /** @type {Record<string, string>} */ ({ bug: 'Bug', security: 'Security', performance: 'Performance', reliability: 'Reliability', api: 'Breaking change', maintainability: 'Maintainability', test: 'Tests' });

/**
 * Model output is untrusted text: no mentions (no pings), no HTML comments (no fake markers),
 * no raw HTML tags beyond what markdown needs.
 * @param {string} text
 */
export function sanitize(text) {
	return text
		.replace(/<!--[\s\S]*?(-->|$)/g, '')
		.replace(/<\/?(script|style|iframe|img|details|summary|sub|sup|table|form|input)\b[^>]*>/gi, '')
		.replace(/@(?=[A-Za-z0-9-]+)/g, '&#64;')
		.trim();
}

/**
 * A fenced block that the content cannot close early.
 * @param {string} info
 * @param {string} content
 */
function fence(info, content) {
	const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map(m => m[0].length));
	const ticks = '`'.repeat(longest + 1);
	return `${ticks}${info}\n${content}\n${ticks}`;
}

/** @param {string} path */
function code(path) {
	return `\`${path.replace(/`/g, '')}\``;
}

/**
 * The body of one inline comment.
 * @param {ModelComment} comment
 * @param {string} model
 */
export function inlineBody(comment, model) {
	const parts = [`${icons[comment.severity]} **${labels[comment.severity]}** · ${categories[comment.category] ?? 'Issue'} · **${sanitize(comment.title)}**`, '', sanitize(comment.body)];
	if (comment.suggestion !== undefined) {
		parts.push('', fence('suggestion', comment.suggestion));
	}
	parts.push('', `<sub>Volt AI Review · ${code(model)}</sub>`, commentMarker);
	return parts.join('\n');
}

/**
 * One line for a finding listed in the summary rather than on the diff.
 * @param {ModelComment} comment
 */
function listItem(comment) {
	const where = comment.line ? `${comment.path}:${comment.line}` : comment.path;
	return `- ${icons[comment.severity]} ${code(where)} **${sanitize(comment.title)}**: ${sanitize(comment.body).replace(/\s*\n+\s*/g, ' ')}`;
}

/** @param {ReviewState} state */
export function encodeState(state) {
	// JSON inside an HTML comment: `--` is the only sequence that could end the comment early.
	return `${statePrefix}${JSON.stringify(state).replace(/--/g, '-\\u002d')} -->`;
}

/**
 * @param {string} body
 * @returns {ReviewState | undefined}
 */
export function decodeState(body) {
	const start = body.indexOf(statePrefix);
	if (start < 0) {
		return undefined;
	}
	const end = body.indexOf(' -->', start);
	try {
		const state = JSON.parse(body.slice(start + statePrefix.length, end));
		return typeof state?.sha === 'string' ? { sha: state.sha, files: state.files ?? {}, summary: state.summary ?? '', v: state.v ?? 1 } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * @param {{
 *   summary: string, latest?: string, files: Record<string, string>, range: string, model: string,
 *   counts: Record<'critical' | 'major' | 'minor' | 'nit', number>, inlineCount: number,
 *   nits: ModelComment[], outside: ModelComment[], overflow: ModelComment[], skipped: Skipped[],
 *   errors: string[], state: ReviewState,
 * }} input
 */
export function summaryBody(input) {
	const lines = [summaryMarker, '## Volt AI Review', ''];
	lines.push(sanitize(input.summary) || 'No summary.');
	if (input.latest) {
		lines.push('', `**Latest push:** ${sanitize(input.latest)}`);
	}
	const total = input.counts.critical + input.counts.major + input.counts.minor;
	/** @type {['critical' | 'major' | 'minor' | 'nit', string, string][]} */
	const words = [['critical', 'critical', 'critical'], ['major', 'major', 'major'], ['minor', 'minor', 'minor'], ['nit', 'nitpick', 'nitpicks']];
	const findings = total || input.counts.nit
		? words.filter(([key]) => input.counts[key]).map(([key, one, many]) => `${icons[key]} ${input.counts[key]} ${input.counts[key] === 1 ? one : many}`).join(' · ')
		: 'No issues found in this pass.';
	lines.push('', `**Reviewed:** ${input.range} · model ${code(input.model)}`, `**Findings:** ${findings}${input.inlineCount ? ` (${input.inlineCount} on the diff)` : ''}`);

	const files = Object.entries(input.files).sort(([a], [b]) => a.localeCompare(b));
	if (files.length) {
		lines.push('', `<details><summary>Walkthrough (${files.length} file${files.length === 1 ? '' : 's'})</summary>`, '', '| File | Change |', '| --- | --- |');
		for (const [path, change] of files) {
			lines.push(`| ${code(path)} | ${sanitize(change).replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ')} |`);
		}
		lines.push('', '</details>');
	}
	const section = (/** @type {string} */ title, /** @type {string[]} */ items) => {
		if (items.length) {
			const shown = items.slice(0, 40);
			const more = items.length > shown.length ? [`- ... and ${items.length - shown.length} more`] : [];
			lines.push('', `<details><summary>${title} (${items.length})</summary>`, '', ...shown, ...more, '', '</details>');
		}
	};
	section('More findings', input.overflow.map(listItem));
	section('Findings outside the diff', input.outside.map(listItem));
	section('Nitpicks', input.nits.map(listItem));
	section('Not reviewed', input.skipped.map(s => `- ${code(s.filename)}: ${s.reason}`));
	if (input.errors.length) {
		lines.push('', `> [!WARNING]\n> Part of this pass did not finish: ${sanitize(input.errors.join('; ')).slice(0, 500)}`);
	}
	lines.push('', '<sub>An AI review is advisory and can be wrong. Comment <code>/review</code> to review new commits, or <code>/review full</code> for the whole pull request. The <code>skip-ai-review</code> label turns it off.</sub>');
	lines.push(encodeState(input.state));
	let body = lines.join('\n');
	if (body.length > 60_000) {
		// GitHub's limit is 65,536 characters; the walkthrough goes first.
		body = summaryBody({ ...input, files: {}, state: { ...input.state, files: {} } });
	}
	return body;
}
