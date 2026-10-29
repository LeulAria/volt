/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentResourcesEditor.css';
import { $, append } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { AgentResourceScopeKind, agentResourceScopeKind } from '../../common/agentResources.js';
import { AgentHarnessSection } from './agentHarnessSection.js';
import { agentResourceName, agentResourcePath } from './agentResourceList.js';
import { AgentResourcesSectionId, IAgentResourcesSectionContext } from './agentResourcesPage.js';
import { AgentResourcesSections } from './agentResourcesSections.js';
import { IAgentResource, IAgentResourcesService } from './agentResourcesService.js';

/** What a page that shows Agent Resources sections (Customize) does for them. */
export interface IAgentResourcesEmbedHost {
	openResource(resource: URI): void;
	openDiff(original: URI, modified: URI, label: string): void;
	/** A section's link to another section ("Discover" goes to the marketplace). */
	navigate(section: AgentResourcesSectionId): void;
	/** The scans changed: the host draws its page again, calling {@link AgentResourcesEmbed.render}. */
	changed(): void;
}

/**
 * The Agent Resources page's sections, drawn inside another page: every agent file of the
 * window's project and of this machine, by scope (Workspace, Global, External, Managed), with
 * the Overview, load order, MCP status and Harness. The page and Customize show the same thing.
 */
export class AgentResourcesEmbed extends Disposable {

	private readonly renderStore = this._register(new DisposableStore());
	/** What the harness section read from other harnesses' files, until the files change. */
	private readonly harnessSummaries = new Map<string, Promise<string | undefined>>();
	private loading = false;

	constructor(
		private readonly host: IAgentResourcesEmbedHost,
		@IAgentResourcesService private readonly resources: IAgentResourcesService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super();
		this._register(this.resources.onDidChange(folder => {
			if (this.folder()?.toString() === folder.toString()) {
				this.harnessSummaries.clear();
				this.host.changed();
			}
		}));
		this._register(this.resources.onDidChangeGlobal(() => {
			this.harnessSummaries.clear();
			this.host.changed();
		}));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this.loading = false;
			this.host.changed();
		}));
	}

	/** The project the sections are about: the window's first folder. */
	folder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	/** Every discovered file, workspace and global, listed once. */
	allItems(): IAgentResource[] {
		const folder = this.folder();
		const workspace = folder ? this.resources.get(folder) ?? [] : [];
		const global = this.resources.getGlobal() ?? [];
		// With the home folder (or ~/.claude) open, the workspace scan finds the global files again: list them once, as Global.
		const globalKeys = new Set(global.map(item => this.uriIdentityService.extUri.getComparisonKey(item.resource)));
		return [...workspace.filter(item => !globalKeys.has(this.uriIdentityService.extUri.getComparisonKey(item.resource))), ...global];
	}

	/** Draws `section` into `parent`, filtered to `scope` and `query`. */
	render(parent: HTMLElement, section: Exclude<AgentResourcesSectionId, 'marketplace'>, scope: 'all' | AgentResourceScopeKind, query: string): void {
		this.renderStore.clear();
		this.load();
		const folder = this.folder();
		// The Agent Resources page's root and content: its tokens, and its narrow-width rules.
		const root = append(parent, $('.volt-ares.volt-ares-embedded'));
		const sectionEl = append(append(root, $('.volt-ares-content')), $('.volt-ares-section'));
		const all = this.allItems();
		if (!all.length && (this.resources.getGlobal() === undefined || (folder && this.resources.get(folder) === undefined))) {
			append(sectionEl, $('.volt-customize-message')).textContent = localize('agentResources.embed.loading', "Looking for agent files in this project and on this computer…");
			return;
		}
		const q = query.trim().toLowerCase();
		const items = all.filter(item => {
			if (scope !== 'all' && agentResourceScopeKind(item.scope) !== scope) {
				return false;
			}
			if (!q) {
				return true;
			}
			const haystack = [agentResourceName(item), agentResourcePath(item, this.resources.home), item.name, item.description, item.kind, item.source].filter(Boolean).join(' ').toLowerCase();
			return haystack.includes(q);
		});
		const ctx: IAgentResourcesSectionContext = {
			store: this.renderStore,
			folder,
			home: this.resources.home,
			items,
			allItems: all,
			openResource: resource => this.host.openResource(resource),
			openDiff: (original, modified, label) => this.host.openDiff(original, modified, label),
			navigate: id => this.host.navigate(id),
			rerender: () => this.host.changed(),
			harnessSummaries: this.harnessSummaries,
		};
		if (section === 'harness') {
			this.renderStore.add(this.instantiationService.createInstance(AgentHarnessSection, sectionEl, ctx)).render();
		} else {
			this.instantiationService.createInstance(AgentResourcesSections, ctx).render(section, sectionEl);
		}
	}

	/** Starts the scans once; each one that lands fires a change, and the host draws again. */
	private load(): void {
		if (this.loading) {
			return;
		}
		this.loading = true;
		const folder = this.folder();
		if (folder) {
			void this.resources.load(folder);
		}
		void this.resources.loadGlobal();
	}
}
