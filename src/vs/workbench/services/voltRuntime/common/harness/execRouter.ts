/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Execution router. Decides *which runtime* owns the loop, not which model sits inside it.
 *
 *   native  Volt's own observe → reason → decide → act loop. Used when the user picked a model.
 *   acp     An Agent Client Protocol session (Cursor, Gemini CLI in ACP mode, …).
 *   cli     A long-lived CLI harness that is not ACP (Claude Code SDK, Codex app-server, …).
 *
 * The three are mutually exclusive for a single run. Sub-agents spawned later may pick a
 * different backend; that is the orchestrator's decision, not this one.
 */

export type ExecutionBackend = 'native' | 'acp' | 'cli';

export interface IExecutionTarget {
	readonly kind: 'model' | 'agent';
	readonly providerId: string;
	/** True when the agent provider speaks ACP rather than a proprietary CLI protocol. */
	readonly acp?: boolean;
}

export interface IExecutionRoute {
	readonly backend: ExecutionBackend;
	readonly reason: string;
}

const ACP_PROVIDERS = new Set([
	'cursor-acp',
	'gemini-cli',
	'gemini-acp',
	'antigravity',
	'agy',
	'kimi',
	'muse',
	'acp',
]);

const CLI_PROVIDERS = new Set([
	'claude-code',
	'claude',
	'codex',
	'opencode',
	'cline',
	'roo',
]);

export function routeExecution(target: IExecutionTarget | undefined): IExecutionRoute {
	if (!target) {
		return { backend: 'native', reason: 'No provider selected; the native loop will run once one is.' };
	}
	if (target.kind === 'model') {
		return { backend: 'native', reason: 'A model was selected; Volt owns the agent loop.' };
	}
	if (target.acp || ACP_PROVIDERS.has(target.providerId)) {
		return { backend: 'acp', reason: `${target.providerId} speaks ACP; Volt projects its events.` };
	}
	if (CLI_PROVIDERS.has(target.providerId)) {
		return { backend: 'cli', reason: `${target.providerId} is a CLI harness; Volt does not inject tools.` };
	}
	// Unknown agent providers are treated as ACP: that is the protocol we already speak, and
	// guessing a proprietary CLI adapter would silently drop the run.
	return { backend: 'acp', reason: `${target.providerId} is an agent; defaulting to ACP.` };
}

export function ownsNativeLoop(route: IExecutionRoute): boolean {
	return route.backend === 'native';
}
