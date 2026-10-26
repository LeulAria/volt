/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IAgentOrchestratorService, IOrchState } from '../../../workbench/services/voltRuntime/common/orchestration/orchestrator.js';
import { OrchThreadStatusKind, threadStatus } from '../../../workbench/services/voltRuntime/common/orchestration/orchestratorViews.js';

/** With no client and nothing to do for this long, the server stops; the next Volt window starts it. */
export const IDLE_EXIT_MS = 15 * 60_000;
const CHECK_MS = 60_000;

/**
 * Chat states that start nothing on their own. A failed or interrupted chat rests once Volt gave up
 * restarting it (no `rescue`); counting it as work would keep the server up forever.
 */
const RESTING: ReadonlySet<OrchThreadStatusKind> = new Set(['idle', 'paused', 'failed', 'interrupted', 'blocked']);

/** The first chat with work still scheduled: a turn, a queue, a limit wait, a restart, a move. */
export function busyThread(state: IOrchState): string | undefined {
	for (const [id, thread] of Object.entries(state.threads)) {
		if (thread.rescue || thread.limit || thread.pendingMove) {
			return id;
		}
		const status = threadStatus(state, id);
		if (status.busy || !RESTING.has(status.kind)) {
			return id;
		}
	}
	return undefined;
}

export interface IIdleExitOptions {
	readonly clients: () => number;
	/** No run is going (the runtime's view). */
	readonly runsIdle: () => boolean;
	readonly orchestrator: IAgentOrchestratorService;
	/** Phones may connect at any time while the server listens on the network. */
	readonly network: boolean;
	readonly stop: () => void;
	readonly logService: ILogService;
}

/**
 * Stops a server nobody uses: no window, phone or browser connected for {@link IDLE_EXIT_MS}, no run
 * going and every chat at rest. Volt starts it again when a window opens. Set
 * `VOLT_AGENT_SERVER_IDLE_EXIT=0` to keep it running.
 */
export function stopWhenIdle(options: IIdleExitOptions): IDisposable {
	if (options.network || process.env['VOLT_AGENT_SERVER_IDLE_EXIT'] === '0') {
		return toDisposable(() => { });
	}
	let lonelySince: number | undefined = Date.now();
	const timer = setInterval(() => {
		if (options.clients() > 0) {
			lonelySince = undefined;
			return;
		}
		lonelySince ??= Date.now();
		if (Date.now() - lonelySince < IDLE_EXIT_MS || !options.runsIdle()) {
			return;
		}
		if (busyThread(options.orchestrator.getState())) {
			return;
		}
		clearInterval(timer);
		options.logService.info(`[volt agent server] no client for ${IDLE_EXIT_MS / 60_000} minutes and no work left; stopping until Volt opens again`);
		options.stop();
	}, CHECK_MS);
	return toDisposable(() => clearInterval(timer));
}
