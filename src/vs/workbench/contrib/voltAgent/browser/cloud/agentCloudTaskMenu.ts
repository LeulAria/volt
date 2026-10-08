/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IUntitledTextEditorService } from '../../../../services/untitled/common/untitledTextEditorService.js';
import { IAgentCloudTasksService } from '../../../../services/voltRuntime/browser/cloud/agentCloudTasksService.js';
import { cloudTaskHasResult, cloudTaskStatusText, ICloudTask, isCloudTaskActive } from '../../../../services/voltRuntime/common/cloud/cloudTasks.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';

type CloudTaskAction = 'diff' | 'apply' | 'cancel' | 'remove';

/**
 * The menu of a cloud task in the sidebar: its status, then what it can do. Open diff shows the
 * runner's patch in an editor; Apply locally fetches its branch into a new worktree of the project.
 */
export class AgentCloudTaskMenu {

	constructor(
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IAgentCloudTasksService private readonly cloud: IAgentCloudTasksService,
		@IEditorService private readonly editorService: IEditorService,
		@IUntitledTextEditorService private readonly untitled: IUntitledTextEditorService,
		@INotificationService private readonly notifications: INotificationService,
	) { }

	show(task: ICloudTask, anchor: HTMLElement): void {
		const active = isCloudTaskActive(task);
		const hasResult = cloudTaskHasResult(task);
		const status: IVoltMenuItem<CloudTaskAction | undefined>[] = [{
			id: 'status',
			label: cloudTaskStatusText(task),
			subtitle: task.prompt.split('\n')[0] || undefined,
			icon: Codicon.cloud,
			disabled: true,
			data: undefined,
		}];
		const actions: IVoltMenuItem<CloudTaskAction | undefined>[] = [];
		if (task.result?.patchBlob || hasResult) {
			actions.push({ id: 'diff', label: localize('voltAgent.cloud.openDiff', "Open Diff"), icon: Codicon.diff, data: 'diff' });
		}
		if (hasResult) {
			actions.push({
				id: 'apply',
				label: localize('voltAgent.cloud.applyLocally', "Apply Locally"),
				icon: Codicon.newFolder,
				detail: localize('voltAgent.cloud.applyDetail', "A new worktree on {0}", task.result?.branch ?? ''),
				data: 'apply',
			});
		}
		if (active) {
			actions.push({ id: 'cancel', label: localize('voltAgent.cloud.cancel', "Cancel"), icon: Codicon.debugStop, data: 'cancel' });
		} else {
			actions.push({ id: 'remove', label: localize('voltAgent.cloud.remove', "Remove from List"), icon: Codicon.trash, data: 'remove' });
		}
		showVoltMenu<CloudTaskAction | undefined>(this.contextViewService, {
			anchor,
			align: 'right',
			width: 280,
			ariaLabel: task.title,
			sections: [{ id: 'status', items: status }, { id: 'actions', items: actions }],
			onPick: item => item.data ? this.run(task, item.data) : undefined,
		});
	}

	private async run(task: ICloudTask, action: CloudTaskAction): Promise<void> {
		try {
			switch (action) {
				case 'diff':
					return await this.openDiff(task);
				case 'apply':
					return await this.apply(task);
				case 'cancel':
					await this.cloud.cancel(task.id);
					return;
				case 'remove':
					await this.cloud.remove(task.id);
					return;
			}
		} catch (err) {
			this.notifications.notify({ severity: Severity.Error, message: err instanceof Error ? err.message : String(err) });
		}
	}

	private async openDiff(task: ICloudTask): Promise<void> {
		const patch = task.result?.patchBlob ? await this.cloud.readPatch(task) : '';
		const model = this.untitled.create({
			languageId: 'diff',
			initialValue: patch || task.result?.summary || localize('voltAgent.cloud.noPatch', "The task made no changes."),
		});
		await this.editorService.openEditor({ resource: model.resource, options: { pinned: true } });
	}

	private async apply(task: ICloudTask): Promise<void> {
		const repoRoot = task.origin.repoRoot;
		if (!repoRoot) {
			throw new Error(localize('voltAgent.cloud.noRepo', "The task has no project folder to apply to."));
		}
		const applied = await this.cloud.applyLocally(task, repoRoot);
		this.notifications.info(localize('voltAgent.cloud.applied', "Applied {0} in {1}", applied.branch, applied.path));
	}
}
