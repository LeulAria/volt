/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isFullscreen } from '../../../../base/browser/browser.js';
import { runWhenWindowIdle, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { mark } from '../../../../base/common/performance.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { getThemeTypeSelector, IThemeService } from '../../../../platform/theme/common/themeService.js';
import { isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, IWorkspaceContextService, toWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { captureWindowSnapshot } from '../../../../platform/voltWindowSnapshot/browser/windowSnapshotCapture.js';
import { isWindowSnapshotShown, removeWindowSnapshot } from '../../../../platform/voltWindowSnapshot/browser/windowSnapshotPaint.js';
import { voltWindowSnapshotKey } from '../../../../platform/voltWindowSnapshot/common/windowSnapshot.js';
import { IVoltWindowSnapshotService, VOLT_WINDOW_SNAPSHOT_CHANNEL_NAME } from '../../../../platform/voltWindowSnapshot/common/windowSnapshotService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { AgentEditor } from '../browser/editor/agentEditor.js';
import { AgentEditorInput } from '../browser/editor/agentEditorInput.js';

/** The workbench takes over from a snapshot at the latest this long after it restored (a chat that never loads). */
const TAKE_OVER_DEADLINE_MS = 10_000;
/** Saves on losing focus are at least this far apart. */
const MIN_SAVE_INTERVAL_MS = 15_000;

/**
 * The window's snapshot (IVoltWindowSnapshot): taken when the window loses focus and when it
 * closes, painted by the next start in its first frame. The agent editor takes over from it when
 * it has drawn the restored chat; this makes sure a window that restores no chat takes over too.
 */
class AgentWindowSnapshotContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentWindowSnapshot';

	private readonly service: IVoltWindowSnapshotService;
	private readonly idleSave = this._register(new MutableDisposable());
	private lastSave = 0;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@INativeWorkbenchEnvironmentService private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IEditorService private readonly editorService: IEditorService,
		@IThemeService private readonly themeService: IThemeService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IHostService hostService: IHostService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.service = ProxyChannel.toService<IVoltWindowSnapshotService>(mainProcessService.getChannel(VOLT_WINDOW_SNAPSHOT_CHANNEL_NAME));

		if (isWindowSnapshotShown(mainWindow.document)) {
			void lifecycleService.when(LifecyclePhase.Restored).then(() => this.takeOverUnlessAChatWill());
		}
		this._register(lifecycleService.onWillShutdown(e => e.join(this.save(), { id: 'volt.windowSnapshot', label: 'Saving the window snapshot' })));
		this._register(hostService.onDidChangeFocus(focused => {
			if (!focused && Date.now() - this.lastSave > MIN_SAVE_INTERVAL_MS) {
				this.idleSave.value = runWhenWindowIdle(mainWindow, () => void this.save(), 1000);
			}
		}));
	}

	/** After restore: an agent chat that is loading takes over itself (a deadline covers one that never loads); anything else takes over now. */
	private takeOverUnlessAChatWill(): void {
		const takeOver = (why: string) => {
			if (removeWindowSnapshot(mainWindow.document)) {
				mark('code/voltDidHandOffWindowSnapshot');
				this.logService.info(`[volt window snapshot] the workbench took over: ${why}`);
			}
		};
		if (!(this.editorService.activeEditor instanceof AgentEditorInput)) {
			scheduleAtNextAnimationFrame(mainWindow, () => takeOver('no chat restored'));
			return;
		}
		const timer = setTimeout(() => takeOver('the restored chat did not load in time'), TAKE_OVER_DEADLINE_MS);
		this._register({ dispose: () => clearTimeout(timer) });
	}

	/** The key the main process uses for this window's configuration (see voltWindowSnapshotKey). */
	private get key(): string {
		const workspace = toWorkspaceIdentifier(this.contextService.getWorkspace());
		return voltWindowSnapshotKey({
			voltWindowScope: this.environmentService.window.voltScope,
			workspace: isWorkspaceIdentifier(workspace) || isSingleFolderWorkspaceIdentifier(workspace) ? workspace : undefined,
			backupPath: this.environmentService.backupPath,
		});
	}

	private async save(): Promise<void> {
		if (isWindowSnapshotShown(mainWindow.document)) {
			return; // the workbench has not taken over yet: the stored snapshot stays as it is
		}
		this.lastSave = Date.now();
		try {
			const data = this.capture();
			await this.service.save(this.key, data);
		} catch (err) {
			this.logService.warn('[volt window snapshot] could not take the window snapshot', err);
		}
	}

	/** The snapshot as JSON, or undefined when this window should start without one (not the agent layout, full screen). */
	private capture(): string | undefined {
		const container = this.layoutService.mainContainer;
		if (!container.classList.contains('volt-layout-agent') || isFullscreen(mainWindow)) {
			return undefined;
		}
		const pane = this.editorService.activeEditorPane;
		const agent = pane instanceof AgentEditor ? pane : undefined;
		const input = this.editorService.activeEditor;
		const started = performance.now();
		const snapshot = captureWindowSnapshot(mainWindow, container, {
			key: this.key,
			baseTheme: getThemeTypeSelector(this.themeService.getColorTheme().type),
			sessionId: input instanceof AgentEditorInput ? input.sessionId : undefined,
			composer: agent?.windowSnapshotComposer(),
		});
		const json = JSON.stringify(snapshot);
		this.logService.trace(`[volt window snapshot] ${Math.round(json.length / 1024)} KB in ${Math.round(performance.now() - started)} ms`);
		return json;
	}
}

registerWorkbenchContribution2(AgentWindowSnapshotContribution.ID, AgentWindowSnapshotContribution, WorkbenchPhase.BlockRestore);
