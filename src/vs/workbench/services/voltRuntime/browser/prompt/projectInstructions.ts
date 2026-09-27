/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

export const PROJECT_INSTRUCTION_FILES = [
	'AGENTS.md',
	'CLAUDE.md',
	'.volt/AGENTS.md',
	'.cursorrules',
	'.github/copilot-instructions.md',
] as const;

const DEFAULT_BUDGET = 32_000;

/**
 * Load project instructions the way the context pack expects them: a single trimmed
 * string, never invented. Missing files are skipped. Parent-directory walks stay out
 * of v1 - Volt is workspace-scoped.
 */
export async function loadProjectInstructions(
	fileService: IFileService,
	root: URI | undefined,
	budget = DEFAULT_BUDGET,
): Promise<string | undefined> {
	if (!root) {
		return undefined;
	}
	const chunks: string[] = [];
	for (const rel of PROJECT_INSTRUCTION_FILES) {
		const text = await readText(fileService, joinPath(root, rel));
		if (text) {
			chunks.push(`# ${rel}\n${text.trim()}`);
		}
	}
	// `.volt/rules` and `.cursor/rules` are loaded by `loadInstructions`, which honours their
	// `alwaysApply` / `globs` / `description` headers instead of pasting every rule every turn.
	if (!chunks.length) {
		return undefined;
	}
	const joined = chunks.join('\n\n');
	return joined.length > budget ? `${joined.slice(0, budget)}\n\n[project instructions truncated]` : joined;
}

async function readText(fileService: IFileService, uri: URI): Promise<string | undefined> {
	try {
		if (!await fileService.exists(uri)) {
			return undefined;
		}
		return (await fileService.readFile(uri)).value.toString();
	} catch {
		return undefined;
	}
}
