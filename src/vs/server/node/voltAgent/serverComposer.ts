/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../platform/instantiation/common/serviceCollection.js';
import { AgentServerProtocol } from '../../../platform/voltAgentServer/common/protocolServer.js';
import {
	ISingleFolderWorkspaceIdentifier, IWorkspace, IWorkspaceContextService, IWorkspaceFolder, IWorkspaceFoldersChangeEvent, IWorkspaceFoldersWillChangeEvent,
	IWorkspaceIdentifier, toWorkspaceFolder, WorkbenchState
} from '../../../platform/workspace/common/workspace.js';
import { isEqualOrParent } from '../../../base/common/resources.js';
import { AgentCustomizeService, IAgentSlashItem } from '../../../workbench/contrib/voltAgent/browser/customize/agentCustomizeService.js';

/** One entry of the composer's `/` menu, as a paired client lists it. */
export interface IServerSlashCommand {
	readonly name: string;
	/** `builtin-command` acts in the app (model, new chat, usage...); the rest send instructions. */
	readonly type: IAgentSlashItem['type'];
	readonly title: string;
	readonly summary: string;
	readonly description: string;
	readonly builtin: boolean;
	/** Where it was found ("~/.claude/skills", "repo/.volt"); absent for built-ins. */
	readonly location?: string;
	readonly sourceLabel?: string;
	readonly canUseAsMode: boolean;
}

/** How many projects keep a scanned `/` menu (each watches its config folders). */
const MAX_CACHED_ROOTS = 6;

/** A workspace of one folder: what the desktop's customize service scans in a window on that project. */
class ProjectWorkspace implements IWorkspaceContextService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeWorkbenchState: Event<WorkbenchState> = Event.None;
	readonly onDidChangeWorkspaceName: Event<void> = Event.None;
	readonly onWillChangeWorkspaceFolders: Event<IWorkspaceFoldersWillChangeEvent> = Event.None;
	readonly onDidChangeWorkspaceFolders: Event<IWorkspaceFoldersChangeEvent> = Event.None;
	private readonly workspace: IWorkspace;

	constructor(private readonly root: URI) {
		this.workspace = { id: `volt-agent-server:${root.toString()}`, folders: [toWorkspaceFolder(root)] };
	}

	async getCompleteWorkspace(): Promise<IWorkspace> { return this.workspace; }
	getWorkspace(): IWorkspace { return this.workspace; }
	getWorkbenchState(): WorkbenchState { return WorkbenchState.FOLDER; }
	getWorkspaceFolder(resource: URI): IWorkspaceFolder | null { return isEqualOrParent(resource, this.root) ? this.workspace.folders[0] : null; }
	isCurrentWorkspace(_workspaceIdOrFolder: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | URI): boolean { return false; }
	isInsideWorkspace(resource: URI): boolean { return isEqualOrParent(resource, this.root); }
}

/** `[/review skill]`: how a `/` entry reads in the text the agent gets (never a bare `/name`, which CLI agents take for their own commands). */
function slashTag(item: Pick<IAgentSlashItem, 'name' | 'type'>): string {
	return `[/${item.name} ${item.type === 'builtin-command' ? 'command' : item.type}]`;
}

/**
 * The composer's `/` menu for paired clients: the same entries a desktop window on the project
 * lists (built-in commands and skills, and the skills, commands, subagents and rules on disk), and
 * the text a prompt using them sends, written the way the desktop composer writes it.
 */
export class ServerComposer extends Disposable {

	private readonly services = new Map<string, { readonly service: AgentCustomizeService; readonly store: DisposableStore }>();

	constructor(
		protocol: AgentServerProtocol,
		private readonly allowed: (path: string) => Promise<string>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(protocol.registerMethods('composer', {
			slashCommands: (_ctx, root) => this.slashCommands(String(root ?? '')),
			expandSlash: (_ctx, root, text) => this.expandSlash(String(root ?? ''), String(text ?? '')),
		}));
		this._register({ dispose: () => this.services.forEach(entry => entry.store.dispose()) });
	}

	private async customize(root: string): Promise<AgentCustomizeService> {
		const folder = await this.allowed(root);
		let entry = this.services.get(folder);
		if (entry) {
			// Most recently used last: the first one is dropped when the cache is full.
			this.services.delete(folder);
		} else {
			const store = new DisposableStore();
			const child = this.instantiationService.createChild(new ServiceCollection([IWorkspaceContextService, new ProjectWorkspace(URI.file(folder))]), store);
			entry = { service: store.add(child.createInstance(AgentCustomizeService)), store };
		}
		this.services.set(folder, entry);
		for (const [key, old] of this.services) {
			if (this.services.size <= MAX_CACHED_ROOTS) {
				break;
			}
			this.services.delete(key);
			old.store.dispose();
		}
		return entry.service;
	}

	private async slashCommands(root: string): Promise<IServerSlashCommand[]> {
		const items = await (await this.customize(root)).getSlashItems();
		return items.map(item => ({
			name: item.name,
			type: item.type,
			title: item.title,
			summary: item.summary,
			description: item.description,
			builtin: item.builtin,
			...(item.location ? { location: item.location } : {}),
			...(item.sourceLabel ? { sourceLabel: item.sourceLabel } : {}),
			canUseAsMode: item.canUseAsMode,
		}));
	}

	/**
	 * The prompt text for a message that names `/` entries: each `/name` (at the start, or after a
	 * space and followed by one) of a known skill, command, subagent or rule becomes its tag, and the
	 * entries' instructions follow the message, as the desktop composer sends them. Built-in commands
	 * (`/model`, `/new-chat`...) act in the app and are left as typed.
	 */
	private async expandSlash(root: string, text: string): Promise<{ readonly text: string; readonly used: readonly string[] }> {
		const customize = await this.customize(root);
		const items = await customize.getSlashItems();
		const byName = new Map(items.filter(item => item.type !== 'builtin-command').map(item => [item.name.toLowerCase(), item]));
		const used: IAgentSlashItem[] = [];
		const pattern = /(^|\s)\/([\w.:-]+)(?=\s|$)/g;
		const tagged = text.replace(pattern, (whole, lead: string, name: string) => {
			const item = byName.get(name.toLowerCase());
			if (!item) {
				return whole;
			}
			if (!used.includes(item)) {
				used.push(item);
			}
			return `${lead}${slashTag(item)}`;
		});
		if (!used.length) {
			return { text, used: [] };
		}
		// What a command's `$ARGUMENTS` stands for: the message without its `/` tokens.
		const args = text.replace(pattern, (whole, lead: string, name: string) => byName.has(name.toLowerCase()) ? lead : whole).replace(/\s+/g, ' ').trim();
		const blocks = (await Promise.all(used.map(item => customize.resolveSlashPrompt(item, args || undefined)))).filter((block): block is string => !!block);
		return { text: [tagged.trim(), ...blocks].filter(Boolean).join('\n\n'), used: used.map(item => item.name) };
	}
}
