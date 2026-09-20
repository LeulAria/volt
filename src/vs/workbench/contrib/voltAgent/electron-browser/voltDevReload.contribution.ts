/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { FileChangeType, IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { IHostService } from '../../../services/host/browser/host.js';

class VoltDevReloadContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltDevReload';

	constructor(
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
		@IFileService fileService: IFileService,
		@IHostService hostService: IHostService,
		@ILogService logService: ILogService,
	) {
		super();
		if (environmentService.isBuilt) {
			return;
		}

		const outDir = URI.file(join(environmentService.appRoot, 'out'));
		const readyAt = Date.now() + 8_000;
		const reload = this._register(new RunOnceScheduler(() => {
			logService.info('[volt] source changed, reloading window');
			void hostService.reload();
		}, 400));

		this._register(fileService.watch(outDir, { recursive: true, excludes: ['**/*.map', '**/*.tsbuildinfo'] }));
		this._register(fileService.onDidFilesChange(e => {
			if (Date.now() < readyAt) {
				return;
			}
			if (e.affects(outDir, FileChangeType.UPDATED) || e.affects(outDir, FileChangeType.ADDED)) {
				reload.schedule();
			}
		}));
		logService.info('[volt] hot reload watching', outDir.fsPath);
	}
}

registerWorkbenchContribution2(VoltDevReloadContribution.ID, VoltDevReloadContribution, WorkbenchPhase.AfterRestored);
