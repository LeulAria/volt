/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import { pickString } from '../../common/tools/args.js';
import { IVoltTool } from '../../common/tools/tool.js';
import { ICodeIntelHost, IDiagnostic } from './codeTools.js';
import { displayPath, resolveWorkspaceUri } from './workspacePath.js';

/** The host waits up to 3 s for fresh markers; past this the edit answers without them. */
const DIAGNOSTICS_WAIT_MS = 3_500;
/** Errors listed per edit; the rest are counted. */
const MAX_LISTED = 6;

/**
 * `edit_file` and `write_file` that answer with the file's errors right after the write, from the
 * language servers on the user's buffers: a type error shows in the edit's own result instead of
 * a turn later, and a clean file says so, so no separate `diagnostics` call is needed.
 */
export function withEditDiagnostics(tool: IVoltTool, host: ICodeIntelHost, root: () => URI | undefined): IVoltTool {
	return {
		...tool,
		description: `${tool.description} The result ends with the errors the language server reports in the file after the write.`,
		execute: async (args, ctx) => {
			const result = await tool.execute(args, ctx);
			const base = root();
			const uri = resolveWorkspaceUri(base, pickString(args, 'path', 'file', 'file_path'));
			if (result.isError || !uri || ctx.signal.aborted || !host.lspAllowed(uri)) {
				return result;
			}
			const found = await raceTimeout(host.diagnostics([uri], 'error').catch(() => undefined), DIAGNOSTICS_WAIT_MS);
			return found ? { ...result, text: `${result.text}\n${formatEditDiagnostics(found, displayPath(base, uri))}` } : result;
		},
	};
}

/** "No errors in a.ts." or the errors, line by line, capped. */
export function formatEditDiagnostics(found: readonly IDiagnostic[], shown: string): string {
	const errors = found.filter(diagnostic => diagnostic.severity === 'error');
	if (!errors.length) {
		return `No errors in ${shown}.`;
	}
	const lines = errors.slice(0, MAX_LISTED).map(diagnostic => `  ${diagnostic.line}:${diagnostic.column} ${diagnostic.message.split('\n')[0]}${diagnostic.source ? ` [${diagnostic.source}${diagnostic.code ? ` ${diagnostic.code}` : ''}]` : ''}`);
	const more = errors.length - lines.length;
	return [`${errors.length} error${errors.length === 1 ? '' : 's'} in ${shown} now (some may predate this edit):`, ...lines, ...(more > 0 ? [`  ...and ${more} more (diagnostics lists them)`] : [])].join('\n');
}

/** A hook's answer that adds nothing (Claude Code reads hook output as JSON). */
export const NO_HOOK_OUTPUT = '{}';

/**
 * The errors an edit added, as context for the model right after the edit's own result, so it fixes
 * them in its next step instead of finding them at the end of the turn. Undefined when it added none.
 * `late`: the check finished after the edit's hook had answered (a language server that was still
 * starting), so the text goes out with a later hook answer and names the edit as an earlier one.
 */
export function editCheckContext(added: readonly IDiagnostic[], shown: string, late?: boolean): string | undefined {
	const errors = added.filter(diagnostic => diagnostic.severity === 'error');
	if (!errors.length) {
		return undefined;
	}
	const lines = errors.slice(0, MAX_LISTED).map(diagnostic => `  ${diagnostic.line}:${diagnostic.column} ${diagnostic.message.split('\n')[0]}${diagnostic.source ? ` [${diagnostic.source}${diagnostic.code ? ` ${diagnostic.code}` : ''}]` : ''}`);
	const more = errors.length - lines.length;
	return [`[Volt] ${late ? 'An earlier edit' : 'This edit'} added ${errors.length} error${errors.length === 1 ? '' : 's'} in ${shown} (language server${late ? ', which was still starting when the edit was made' : ''}):`, ...lines, ...(more > 0 ? [`  ...and ${more} more`] : [])].join('\n');
}

/** The answer to Claude Code's PostToolUse hook: `contexts` for the model, or nothing. */
export function postToolUseHookOutput(contexts: readonly string[]): string {
	return contexts.length ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: contexts.join('\n') } }) : NO_HOOK_OUTPUT;
}

/** The answer to Claude Code's PostToolUse hook after an edit: the errors it added, or nothing. */
export function editCheckHookOutput(added: readonly IDiagnostic[], shown: string): string {
	const context = editCheckContext(added, shown);
	return postToolUseHookOutput(context ? [context] : []);
}
