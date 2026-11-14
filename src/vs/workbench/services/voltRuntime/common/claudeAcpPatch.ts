/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';

/**
 * Claude Code's ACP adapter (`@agentclientprotocol/claude-agent-acp`) starts work on a prompt's path
 * that the turn does not need there. Between `session/prompt` and the model request it:
 * - reads the session's skill files with `getContextUsage()` on the first `system`/init, because Volt
 *   declares the JetBrains AIR extension (for session failures, native subagents and async tasks).
 *   The Claude Code CLI answers it with about 37 `count_tokens` requests, 19 of them, and the work
 *   of building them, before the turn's own request. Volt reads only the command names, never the
 *   skill paths this read refines.
 *
 * Volt cannot switch this off with a flag or an environment variable, so it starts the adapter
 * with a module hook (`node --import <preload>`) that edits the adapter's `v1/acp-agent.js` as it
 * loads: the work runs once the turn's result is in. Every edit names text that must occur exactly
 * once; when any does not (another adapter version), the file loads untouched.
 */
export interface IAcpSourcePatch {
	readonly id: string;
	/** The text to replace. Runs of whitespace match any whitespace (the indentation may change). */
	readonly from: string;
	readonly to: string;
}

/** The adapter file the patches edit, as the end of its module URL. */
export const CLAUDE_ACP_AGENT_MODULE = '/@agentclientprotocol/claude-agent-acp/dist/v1/acp-agent.js';

/** The npm package the patches are written against (any version: a patch that does not match leaves the file alone). */
export const CLAUDE_ACP_PACKAGE = '@agentclientprotocol/claude-agent-acp';

export const CLAUDE_ACP_PATCHES: readonly IAcpSourcePatch[] = [
	{
		// The first init's skill-file read (`getContextUsage`): queued until the turn's result.
		id: 'skill-files-after-turn',
		from: 'session.skillFilesRequested = true; void this.refreshSkillFiles(params.sessionId);',
		to: 'session.skillFilesRequested = true; voltAfterTurn(session, () => void this.refreshSkillFiles(params.sessionId));',
	},
	{
		// The turn's result runs what was queued for it.
		id: 'turn-end',
		from: 'case "result": { session.modelRequestSinceResult = false;',
		to: 'case "result": { voltTurnEnded(session); session.modelRequestSinceResult = false;',
	},
];

/**
 * Appended to the patched file (function declarations are hoisted). Queued work runs once, after
 * the result has been handled (`setTimeout`), or after `fallbackMs` when a turn never ends.
 */
const HELPERS = `
function voltAfterTurn(session, run, fallbackMs) {
	let done = false;
	const once = () => { if (!done) { done = true; try { run(); } catch { } } };
	(session.voltAfterTurn ??= []).push(once);
	if (fallbackMs) { setTimeout(once, fallbackMs).unref?.(); }
}
function voltTurnEnded(session) {
	const queued = session.voltAfterTurn;
	if (queued?.length) { session.voltAfterTurn = []; setTimeout(() => { for (const run of queued) { run(); } }, 0); }
}
`;

/**
 * JavaScript source of `(text) => { text?, failed? }`: all patches applied with the helpers appended,
 * or `failed` naming the first patch that does not match exactly once (then nothing is applied).
 */
export function claudeAcpTransformSource(patches: readonly IAcpSourcePatch[] = CLAUDE_ACP_PATCHES): string {
	return `((patches, helpers) => (source) => {
	const escape = s => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
	let text = source;
	for (const patch of patches) {
		const pattern = new RegExp(patch.from.trim().split(/\\s+/).map(escape).join('\\\\s+'), 'g');
		const hits = text.match(pattern);
		if (!hits || hits.length !== 1) { return { failed: patch.id }; }
		text = text.replace(pattern, () => patch.to);
	}
	return { text: text + helpers };
})(${JSON.stringify(patches)}, ${JSON.stringify(HELPERS)})`;
}

/** The hook body both module-hook APIs share: `patched(url, loadResult)`. */
function hookCore(patches: readonly IAcpSourcePatch[]): string {
	return `const target = ${JSON.stringify(CLAUDE_ACP_AGENT_MODULE)};
const transform = ${claudeAcpTransformSource(patches)};
const patched = (url, result) => {
	if (!url.endsWith(target) || result?.source == null) { return result; }
	const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
	const out = transform(source);
	if (out.text === undefined) {
		process.stderr.write('[volt] claude-agent-acp loads unpatched: ' + out.failed + ' does not match\\n');
		return result;
	}
	return { ...result, source: out.text };
};
`;
}

/**
 * The `--import` module for the adapter's node: registers the load hook in-thread
 * (`module.registerHooks`, Node 22.15+), else off-thread (`module.register`), else does nothing.
 */
export function claudeAcpPreloadSource(patches: readonly IAcpSourcePatch[] = CLAUDE_ACP_PATCHES): string {
	const core = hookCore(patches);
	const asyncHooks = `${core}export async function load(url, context, nextLoad) { return patched(url, await nextLoad(url, context)); }\n`;
	return `import * as nodeModule from 'node:module';
${core}if (typeof nodeModule.registerHooks === 'function') {
	nodeModule.registerHooks({ load: (url, context, nextLoad) => patched(url, nextLoad(url, context)) });
} else if (typeof nodeModule.register === 'function') {
	nodeModule.register('data:text/javascript;base64,${encodeBase64(VSBuffer.fromString(asyncHooks))}');
}
`;
}

let preload: string | undefined;

/** `node --import` value for the adapter of `pkg` (a pinned `name@version`), or undefined when no patch is for it. */
export function acpAdapterPreload(pkg: string): string | undefined {
	const at = pkg.lastIndexOf('@');
	const name = at > 0 ? pkg.slice(0, at) : pkg;
	if (name !== CLAUDE_ACP_PACKAGE) {
		return undefined;
	}
	return preload ??= `data:text/javascript;base64,${encodeBase64(VSBuffer.fromString(claudeAcpPreloadSource()))}`;
}
