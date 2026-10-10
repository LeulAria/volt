/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltExecRequest, IVoltStdioSpawnOptions } from '../common/voltStdio.js';
import { VoltStdioService } from '../node/voltStdioService.js';

/** {@link VoltStdioService} for windows: a window's agent processes stop when it reloads or closes. */
export class VoltStdioMainService extends VoltStdioService {

	constructor(
		@ILogService logService: ILogService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
	) {
		super(logService, configurationService, environmentMainService.userDataPath);
		this._register(lifecycleMainService.onWillLoadWindow(e => this.killOwnedBy(windowOwner(e.window.id))));
		this._register(lifecycleMainService.onBeforeCloseWindow(window => this.killOwnedBy(windowOwner(window.id))));
		this._register(lifecycleMainService.onWillShutdown(() => this.killAll()));
	}
}

/** Events of processes no window owns still go to every window, as before. */
function isFor(owner: string | undefined, ctx: string): boolean {
	return owner === undefined || owner === ctx;
}

function windowOwner(windowId: number): string {
	return `window:${windowId}`;
}

/**
 * The renderer-facing channel. Same as a proxied service, except `spawn` and `exec` record which
 * window asked (the IPC context), so that window's agents and commands stop with it, and process
 * output and exits go only to that window.
 */
export function createVoltStdioChannel(service: VoltStdioMainService, disposables: DisposableStore): IServerChannel<string> {
	const proxied = ProxyChannel.fromService(service, disposables);
	return {
		call<T>(ctx: string, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
			if (command === 'spawn') {
				return service.spawnFor(ctx, (arg as [IVoltStdioSpawnOptions])[0]) as Promise<unknown> as Promise<T>;
			}
			if (command === 'exec') {
				return service.execFor(ctx, (arg as [IVoltExecRequest])[0]) as Promise<unknown> as Promise<T>;
			}
			return proxied.call<T>(ctx, command, arg, cancellationToken);
		},
		listen<T>(ctx: string, event: string, arg?: unknown): Event<T> {
			// A process's output and exit go only to the window that started it, not to every window.
			if (event === 'onData') {
				return Event.filter(service.onData, e => isFor(service.ownerOf(e.id), ctx)) as Event<unknown> as Event<T>;
			}
			if (event === 'onExit') {
				return Event.filter(service.onExit, e => isFor(service.ownerOf(e.id), ctx)) as Event<unknown> as Event<T>;
			}
			return proxied.listen<T>(ctx, event, arg);
		},
	};
}
