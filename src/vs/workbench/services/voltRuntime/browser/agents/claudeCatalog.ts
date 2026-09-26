/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { parseClaudeCatalog } from '../../common/models/harnessCatalog.js';
import { IModelInfo } from '../../common/providers.js';
import { probeClaudeAuth, runCli } from './cliAgents.js';

/** The catalog Claude Code itself downloads. Not a Volt-authored model list. */
const CLAUDE_CATALOG_URL = 'https://downloads.claude.ai/model-catalog/v1/catalog.json';

let inflight: Promise<IModelInfo[]> | undefined;

/**
 * Claude Code models for a signed-in install. The current CLI has no `acp` model handshake,
 * so this reads the same catalog the CLI uses, once, and then serves it from memory.
 */
export async function listClaudeModels(stdio: IVoltStdioService): Promise<IModelInfo[]> {
	const auth = await probeClaudeAuth(stdio).catch(() => undefined);
	if (!auth) {
		inflight = undefined;
		return [];
	}
	if (!inflight) {
		inflight = loadClaudeModels(stdio).then(models => {
			if (!models.length) {
				inflight = undefined;
			}
			return models;
		}, err => {
			inflight = undefined;
			throw err;
		});
	}
	return inflight;
}

async function loadClaudeModels(stdio: IVoltStdioService): Promise<IModelInfo[]> {
	const auth = await probeClaudeAuth(stdio).catch(() => undefined);
	if (!auth) {
		return [];
	}
	const raw = await runCli(stdio, 'curl', ['-fsSL', '--max-time', '15', CLAUDE_CATALOG_URL], 20_000);
	if (!raw) {
		return [];
	}
	try {
		return parseClaudeCatalog(JSON.parse(raw) as unknown);
	} catch {
		return [];
	}
}
