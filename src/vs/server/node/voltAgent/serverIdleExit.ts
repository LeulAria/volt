/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import type { AgentServerClientKind } from '../../../platform/voltAgentServer/common/protocol.js';
import { IAgentOrchestratorService, IOrchState } from '../../../workbench/services/voltRuntime/common/orchestration/orchestrator.js';
import { OrchThreadStatusKind, threadStatus } from '../../../workbench/services/voltRuntime/common/orchestration/orchestratorViews.js';

/** With no client and nothing to do for this long, the server stops; the next Volt window starts it. */
export const IDLE_EXIT_MS = 15 * 60_000;
/**
 * When the last clients to leave were Volt's own windows (the app quit), the server stops this soon
 * once it has nothing to do: a quit app leaves nothing running behind it. A window that reloads, or
 * an app restarted at once (an update, Cmd+Q and reopen), comes back within it and finds the server up.
 */
export const DESKTOP_QUIT_EXIT_MS = 20_000;
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
	/** The kinds of the clients connected now, one entry per connection. */
	readonly clients: () => readonly AgentServerClientKind[];
	/** Fires when a client connects or leaves. */
	readonly onDidChangeClients?: Event<void>;
	/** No run is going (the runtime's view). */
	readonly runsIdle: () => boolean;
	readonly orchestrator: IAgentOrchestratorService;
	/** Phones may connect at any time while the server listens on the network. */
	readonly network: boolean;
	/** Other work that keeps the server up, by name (a running terminal, a scheduled automation). */
	readonly busy?: () => string | undefined;
	readonly stop: () => void;
	readonly logService: ILogService;
}

/**
 * Stops a server nobody uses: no window, phone or browser connected, no run going and every chat at
 * rest. After Volt's own windows were the last to leave (the app quit) that is {@link DESKTOP_QUIT_EXIT_MS};
 * after a browser or phone left, or when nobody ever connected, {@link IDLE_EXIT_MS}. Work that is
 * still going (a run, a queue, a terminal, a scheduled automation, a tunnel) keeps it up until it is
 * done. Volt starts it again when a window opens. Set `VOLT_AGENT_SERVER_IDLE_EXIT=0` to keep it running.
 */
export function stopWhenIdle(options: IIdleExitOptions): IDisposable {
	if (options.network || process.env['VOLT_AGENT_SERVER_IDLE_EXIT'] === '0') {
		return toDisposable(() => { });
	}
	let lonelySince: number | undefined = Date.now();
	let lonelyFor = IDLE_EXIT_MS;
	let lastKinds = options.clients();
	let stopped = false;
	let quick: ReturnType<typeof setTimeout> | undefined;

	const check = () => {
		if (stopped) {
			return;
		}
		if (options.clients().length > 0) {
			lonelySince = undefined;
			return;
		}
		lonelySince ??= Date.now();
		if (Date.now() - lonelySince < lonelyFor || !options.runsIdle()) {
			return;
		}
		if (busyThread(options.orchestrator.getState()) || options.busy?.()) {
			return;
		}
		stopped = true;
		clearInterval(timer);
		clearTimeout(quick);
		options.logService.info(lonelyFor === DESKTOP_QUIT_EXIT_MS
			? `[volt agent server] Volt quit and no work is left; stopping until Volt opens again`
			: `[volt agent server] no client for ${IDLE_EXIT_MS / 60_000} minutes and no work left; stopping until Volt opens again`);
		options.stop();
	};

	const onClients = () => {
		const kinds = options.clients();
		if (kinds.length > 0) {
			lonelySince = undefined;
			clearTimeout(quick);
			quick = undefined;
		} else if (lastKinds.length > 0) {
			// Everyone left just now: who left decides how long the server waits.
			lonelySince = Date.now();
			lonelyFor = lastKinds.every(kind => kind === 'desktop') ? DESKTOP_QUIT_EXIT_MS : IDLE_EXIT_MS;
			clearTimeout(quick);
			// Work still going is looked at again by the minute check, which stops the server once it is done.
			quick = lonelyFor < CHECK_MS ? setTimeout(check, lonelyFor) : undefined;
		}
		lastKinds = kinds;
	};

	const timer = setInterval(check, CHECK_MS);
	const listener = options.onDidChangeClients?.(onClients);
	return toDisposable(() => {
		stopped = true;
		clearInterval(timer);
		clearTimeout(quick);
		listener?.dispose();
	});
}
