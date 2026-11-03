/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IFileChange } from '../../../../platform/files/common/files.js';
import { AbstractUniversalWatcherClient, ILogMessage, IRecursiveWatcher } from '../../../../platform/files/common/watcher.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';

export class UniversalWatcherClient extends AbstractUniversalWatcherClient {

	constructor(
		onFileChanges: (changes: IFileChange[]) => void,
		onLogMessage: (msg: ILogMessage) => void,
		verboseLogging: boolean,
		private readonly sharedProcessService: ISharedProcessService
	) {
		super(onFileChanges, onLogMessage, verboseLogging);

		this.init();
	}

	protected override createWatcher(disposables: DisposableStore): IRecursiveWatcher {

		// The universal watcher lives in the shared process (one watcher per
		// window, see `PerWindowWatcherChannel`) rather than in a utility
		// process of its own, which saved a whole Node process per window.
		// The shared process stops this window's watcher when it disconnects.
		return ProxyChannel.toService<IRecursiveWatcher>(this.sharedProcessService.getChannel('watcher'));
	}
}
