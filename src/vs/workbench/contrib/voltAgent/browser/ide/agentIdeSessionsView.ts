/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentIdeCard.css';
import { $, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer } from '../../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainerLocation } from '../../../../common/views.js';
import { formatDuration } from '../../../../services/voltRuntime/common/terminals/watchedTasks.js';
import { IAgentIdeActivity, IAgentIdeService } from './agentIdeService.js';

const CONTAINER_ID = 'workbench.view.voltAgentSessions';
const VIEW_ID = 'workbench.view.voltAgentSessions.list';

interface ISessionTemplate {
	readonly icon: HTMLElement;
	readonly title: HTMLElement;
	readonly state: HTMLElement;
	readonly detail: HTMLElement;
}

function kindIcon(activity: IAgentIdeActivity): ThemeIcon {
	if (activity.state === 'running') {
		return ThemeIcon.modify(Codicon.loading, 'spin');
	}
	if (activity.state === 'paused') {
		return Codicon.debugPause;
	}
	if (activity.state === 'failed') {
		return Codicon.error;
	}
	if (activity.state === 'passed') {
		return Codicon.passFilled;
	}
	return activity.kind === 'tests' ? Codicon.beaker : activity.kind === 'debug' ? Codicon.debugAlt : Codicon.tools;
}

/**
 * Everything agents are running in the IDE, across chats: test runs, debug sessions and tasks with
 * their live state. Opening one shows it where the IDE shows it (Test Results, Run and Debug, the
 * task's terminal). The persistent-session view of the agent harness.
 */
class AgentSessionsView extends ViewPane {

	private list: WorkbenchList<IAgentIdeActivity> | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IAgentIdeService private readonly ide: IAgentIdeService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(ide.onDidChange(() => this.refresh()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('volt-agent-sessions');
		const renderer: IListRenderer<IAgentIdeActivity, ISessionTemplate> = {
			templateId: 'session',
			renderTemplate: parent => {
				const row = append(parent, $('.volt-agent-session-row'));
				return { icon: append(row, $('span.icon')), title: append(row, $('span.title')), state: append(row, $('span.state')), detail: append(row, $('span.detail')) };
			},
			renderElement: (activity, _index, template) => {
				template.icon.replaceChildren(renderIcon(kindIcon(activity)));
				template.icon.dataset.state = activity.state;
				template.title.textContent = activity.title;
				template.state.textContent = activity.kind === 'tests' ? localize('voltSessions.tests', "Tests") : activity.kind === 'debug' ? localize('voltSessions.debug', "Debug") : localize('voltSessions.task', "Task");
				template.detail.textContent = [activity.detail, formatDuration((activity.endedAt ?? Date.now()) - activity.startedAt)].filter(Boolean).join(' · ');
			},
			disposeTemplate: () => { },
		};
		this.list = this._register(this.instantiationService.createInstance(WorkbenchList<IAgentIdeActivity>, 'VoltAgentSessions', append(container, $('.volt-agent-sessions-list')), { getHeight: () => 26, getTemplateId: () => 'session' }, [renderer], {
			accessibilityProvider: {
				getAriaLabel: activity => `${activity.title}: ${activity.state}${activity.detail ? `, ${activity.detail}` : ''}`,
				getWidgetAriaLabel: () => localize('voltSessions.aria', "Agent sessions"),
			},
		}));
		this._register(this.list.onDidOpen(event => event.element && this.ide.reveal(event.element.id)));
		this.refresh();
	}

	private refresh(): void {
		this.list?.splice(0, this.list.length, [...this.ide.listAll()]);
	}

	override shouldShowWelcome(): boolean {
		return !this.ide.listAll().length;
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.list?.layout(height, width);
	}
}

const sessionsIcon = registerIcon('volt-agent-sessions-icon', Codicon.pulse, localize('voltSessions.icon', "Agent Sessions view icon."));
const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: CONTAINER_ID,
	title: localize2('voltSessions.container', "Agent Sessions"),
	icon: sessionsIcon,
	order: 21,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: CONTAINER_ID,
	hideIfEmpty: false,
}, ViewContainerLocation.Sidebar);
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([
	{ id: VIEW_ID, name: localize2('voltSessions.view', "Agent Sessions"), ctorDescriptor: new SyncDescriptor(AgentSessionsView), canToggleVisibility: false, canMoveView: true },
], container);
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(VIEW_ID, {
	content: localize('voltSessions.empty', "Test runs, debug sessions and tasks agents start show here while they run."),
});
