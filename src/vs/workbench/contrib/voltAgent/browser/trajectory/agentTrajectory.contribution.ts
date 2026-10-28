/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewExtensions } from '../../../../common/views.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import '../../../../services/voltRuntime/browser/trajectoryService.js';
import { AgentTrajectoryViewPane } from './agentTrajectoryView.js';

const CONTAINER_ID = 'workbench.panel.voltTrajectory';
export const SHOW_TRAJECTORY_COMMAND_ID = 'volt.trajectory.show';

const trajectoryIcon = registerIcon('volt-trajectory-view', Codicon.pulse, localize('voltTrajectory.viewIcon', "Trajectory view icon."));

const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: CONTAINER_ID,
	title: localize2('voltTrajectory.containerTitle', "Trajectory"),
	icon: trajectoryIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: CONTAINER_ID,
	hideIfEmpty: false,
	order: 10,
}, ViewContainerLocation.Panel);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: AgentTrajectoryViewPane.ID,
	name: localize2('voltTrajectory.viewTitle', "Trajectory"),
	containerIcon: trajectoryIcon,
	ctorDescriptor: new SyncDescriptor(AgentTrajectoryViewPane),
	canToggleVisibility: false,
	canMoveView: true,
}], container);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SHOW_TRAJECTORY_COMMAND_ID,
			title: localize2('voltTrajectory.show', "Show Trajectory"),
			category: localize2('voltTrajectory.category', "Volt"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(AgentTrajectoryViewPane.ID, true);
	}
});
