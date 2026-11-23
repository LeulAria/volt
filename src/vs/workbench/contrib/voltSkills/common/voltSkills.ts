/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';

/**
 * The Skills & Plugins feature's contract: what the rest of Volt may use of it. Its page (the
 * Customize tab: skills, subagents, MCP servers, hooks, plugins, memories and the skills.sh and
 * plugin marketplaces) is a module of the `volt.skills-and-plugins` built-in extension
 * (`browser/voltSkills.module.ts`), loaded the first time one of these commands runs, a restored
 * tab shows or Volt Settings opens its page, and unloaded when the extension is disabled. What
 * agents load (`IAgentCustomizeService`), the installer (`IAgentMarketplaceService`) and the
 * marketplace view Agent Resources shares stay core.
 */

export const SKILLS_FEATURE_ID = 'skills';

/** `()`: the Skills & Plugins tab (beside the chats in the agent window). Same id as `OPEN_AGENT_CUSTOMIZE_COMMAND_ID`. */
export const OPEN_SKILLS_COMMAND_ID = 'workbench.action.voltAgent.customize';

/** `()`: the Skills & Plugins tab on its marketplace. */
export const OPEN_SKILLS_MARKETPLACE_COMMAND_ID = 'workbench.action.voltAgent.customize.marketplace';

export const SKILLS_EDITOR_ID = 'workbench.editor.voltCustomize';
export const SKILLS_EDITOR_INPUT_TYPE_ID = 'workbench.input.voltCustomize';

/** Where a Skills & Plugins tab is past its first page, for the window's title bar: Marketplace, then the open skill or plugin. */
export interface ISkillsTrail {
	readonly crumbs: readonly { readonly label: string; readonly run?: () => void }[];
}

/** The trail of a Skills & Plugins tab (undefined for any other editor, or a tab whose module isn't loaded yet). */
export function skillsTrail(editor: { readonly typeId: string } | undefined): ISkillsTrail | undefined {
	return editor?.typeId === SKILLS_EDITOR_INPUT_TYPE_ID && 'crumbs' in editor ? editor as { readonly typeId: string } & ISkillsTrail : undefined;
}

/**
 * Where the skills list was when a skill opened from it: Back to Skills in the Skill Editor puts the
 * list back like this. The host only carries it back to the page.
 */
export interface ISkillsListState {
	readonly search: string;
	readonly kind: string;
	readonly resourceScope: string;
	readonly excluded: readonly string[];
	readonly expanded: readonly string[];
	readonly scrollTop: number;
}

/** What hosts the embedded page (Volt Settings), for the page's way back from a skill it opened. */
export interface ISkillsEmbeddedHost {
	/** The host was closed to show a skill: open it again on Skills & Plugins with the list as `state` had it. */
	returnToSkillList(state: ISkillsListState): Promise<void>;
}

/** The Skills & Plugins page hosted inside another editor (Volt Settings > Skills & Plugins). */
export interface ISkillsEmbeddedPage extends IDisposable {
	setVisible(visible: boolean): void;
	layout(width: number, height: number): void;
	/** Shows the skills list as it was when a skill opened from it. */
	restoreSkillList(state: ISkillsListState): void;
}

/** What the loaded module gives core (`IVoltFeatureModuleService.activate('skills')`). */
export interface IVoltSkillsModule {
	/**
	 * The Skills & Plugins page in `parent`. Disposed with the module if it unloads first. With a
	 * `host`, a skill opens in the Skill Editor where the user can reach it (the IDE group, or the
	 * current chat's tools in the agent layout) instead of beside the page.
	 */
	createEmbeddedPage(parent: HTMLElement, group: IEditorGroup, host?: ISkillsEmbeddedHost): ISkillsEmbeddedPage;
}
