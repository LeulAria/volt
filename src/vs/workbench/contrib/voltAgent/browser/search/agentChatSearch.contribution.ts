/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Toggle } from '../../../../../base/browser/ui/toggle/toggle.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { IMatch } from '../../../../../base/common/filters.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/path.js';
import { basename as uriBasename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputButton, IQuickInputService, IQuickPick, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { defaultToggleStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { IChatContentHit, IChatTitleCandidate, IChatTitleHit, searchChatTitles } from '../../common/agentChatSearch.js';
import { OPEN_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';
import { sessionFolders } from '../home/agentHomeFilter.js';
import { folderPath } from '../home/agentHomeModel.js';
import { IAgentChatSearchService, SEARCH_AGENT_CHATS_COMMAND_ID } from './agentChatSearchService.js';
import { IAgentTurnReveal, requestAgentTurnReveal } from './agentTurnReveal.js';

const GROUP_BY_PROJECT_KEY = 'voltAgent.chatSearch.groupByProject';
const TITLE_LIMIT = 40;
const CONTENT_LIMIT = 60;
const RECENT_LIMIT = 40;
/** Message search runs at most this often while typing; titles answer every keystroke. */
const CONTENT_DELAY_MS = 40;
/** Hits near the top whose replies are read for a snippet. */
const SNIPPET_LOADS = 24;
/**
 * A separator with `buttons` (even none) renders as its own sticky header row; without, the quick pick
 * squeezes its label onto the right edge of the first item, which collides with two-line rows.
 */
const SECTION_ROW: readonly IQuickInputButton[] = [];

interface IChatPick extends IQuickPickItem {
	readonly sessionId: string;
	readonly reveal?: IAgentTurnReveal;
}

interface IChatRow {
	readonly meta: IAgentSessionMeta;
	readonly kind: 'recent' | 'title' | 'content';
	readonly title?: IChatTitleHit;
	readonly content?: IChatContentHit;
}

function chatLabel(meta: IAgentSessionMeta): string {
	return meta.title || meta.preview || localize('voltAgent.chatSearch.untitled', "Untitled chat");
}

/**
 * Search Chats: every keystroke fuzzy-matches chat titles at once, and a moment later what was said
 * in every chat (prompts and replies, ranked) joins below them, with the matching line. Results list
 * as Titles, then In Conversations, or under their projects with the toggle.
 */
class AgentChatSearchPicker extends Disposable {

	private readonly picker: IQuickPick<IChatPick, { useSeparators: true }>;
	private readonly groupToggle: Toggle;
	private readonly contentSearch = this._register(new RunOnceScheduler(() => this.runContentSearch(), CONTENT_DELAY_MS));
	private readonly historyChanged = this._register(new RunOnceScheduler(() => this.onHistoryChanged(), 200));
	private sessions = new Map<string, IAgentSessionMeta>();
	private candidates: IChatTitleCandidate[] = [];
	private readonly projectNames = new Map<string, string>();
	private titleHits: IChatTitleHit[] = [];
	private contentHits: IChatContentHit[] = [];
	/** Chats asked for snippet text under the current query. */
	private readonly requested = new Set<string>();

	constructor(
		@IQuickInputService quickInputService: IQuickInputService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentChatSearchService private readonly searchService: IAgentChatSearchService,
		@IVoltSessionContextService sessionContext: IVoltSessionContextService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		for (const project of sessionContext.projects) {
			this.projectNames.set(folderPath(project.root), project.displayName || uriBasename(project.root));
		}

		const picker = this.picker = this._register(quickInputService.createQuickPick<IChatPick>({ useSeparators: true }));
		picker.placeholder = localize('voltAgent.chatSearch.placeholder', "Search chats by title and everything said in them");
		picker.ariaLabel = localize('voltAgent.chatSearch.aria', "Search chats");
		picker.matchOnLabel = false;
		picker.matchOnDescription = false;
		picker.matchOnDetail = false;
		picker.sortByLabel = false;

		this.groupToggle = this._register(new Toggle({
			title: localize('voltAgent.chatSearch.groupByProject', "Group by Project"),
			icon: Codicon.listTree,
			isChecked: storageService.getBoolean(GROUP_BY_PROJECT_KEY, StorageScope.PROFILE, false),
			...defaultToggleStyles,
		}));
		picker.toggles = [this.groupToggle];
		this._register(this.groupToggle.onChange(() => {
			this.storageService.store(GROUP_BY_PROJECT_KEY, this.groupToggle.checked, StorageScope.PROFILE, StorageTarget.USER);
			this.render(true);
		}));

		this._register(picker.onDidChangeValue(() => this.onQuery()));
		this._register(picker.onDidAccept(() => this.accept()));
		this._register(picker.onDidHide(() => this.dispose()));
		this._register(searchService.onDidChange(() => this.runContentSearch()));
		this._register(history.onDidChange(() => this.historyChanged.schedule()));
		// Indexing starts as the picker opens, before the first word is typed.
		this._register(searchService.watch());
	}

	show(): void {
		this.refreshSessions();
		this.render(true);
		this.picker.show();
	}

	private refreshSessions(): void {
		const metas = this.history.list({ includeArchived: true, inWindow: true }).filter(meta => !meta.subagent);
		this.sessions = new Map(metas.map(meta => [meta.id, meta]));
		this.candidates = metas.map(meta => ({
			id: meta.id,
			title: chatLabel(meta),
			updatedAt: meta.updatedAt,
			context: [this.projectName(meta), meta.worktreeBranch].filter(Boolean).join(' '),
		}));
	}

	private onHistoryChanged(): void {
		this.refreshSessions();
		const query = this.query();
		this.titleHits = query ? searchChatTitles(this.candidates, query, TITLE_LIMIT) : [];
		this.render(false);
	}

	private query(): string {
		return this.picker.value.trim();
	}

	private onQuery(): void {
		const query = this.query();
		this.requested.clear();
		this.titleHits = query ? searchChatTitles(this.candidates, query, TITLE_LIMIT) : [];
		if (!query) {
			this.contentSearch.cancel();
			this.contentHits = [];
		} else if (!this.contentSearch.isScheduled()) {
			// Not rescheduled on every key: a fast typist still sees message hits as they go.
			this.contentSearch.schedule();
		}
		this.render(true);
	}

	private runContentSearch(): void {
		const query = this.query();
		this.contentHits = query ? this.searchService.search(query, CONTENT_LIMIT) : [];
		const missing = this.contentHits.slice(0, SNIPPET_LOADS)
			.filter(hit => !hit.snippet && !this.requested.has(hit.id))
			.map(hit => hit.id);
		for (const id of missing) {
			this.requested.add(id);
		}
		if (missing.length) {
			this.searchService.loadTexts(missing);
		}
		this.render(false);
	}

	private rows(query: string): IChatRow[] {
		if (!query) {
			return [...this.sessions.values()]
				.filter(meta => !meta.archived)
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, RECENT_LIMIT)
				.map(meta => ({ meta, kind: 'recent' }));
		}
		const content = new Map(this.contentHits.map(hit => [hit.id, hit]));
		const rows: IChatRow[] = [];
		for (const hit of this.titleHits) {
			const meta = this.sessions.get(hit.id);
			if (meta) {
				rows.push({ meta, kind: 'title', title: hit, content: content.get(hit.id) });
			}
		}
		const titled = new Set(this.titleHits.map(hit => hit.id));
		for (const hit of this.contentHits) {
			const meta = this.sessions.get(hit.id);
			if (meta && !titled.has(hit.id)) {
				rows.push({ meta, kind: 'content', content: hit });
			}
		}
		return rows;
	}

	/** `reset`: the query or layout changed, so the list starts at the top; otherwise the selection stays put. */
	private render(reset: boolean): void {
		const query = this.query();
		const rows = this.rows(query);
		const progress = this.searchService.progress;
		const searching = !!query && (progress.building || this.contentSearch.isScheduled() || this.searchService.loadingTexts);
		const items: (IChatPick | IQuickPickSeparator)[] = [];

		if (this.groupToggle.checked) {
			const groups = new Map<string, { name: string; rows: IChatRow[] }>();
			for (const row of rows) {
				const key = sessionFolders(row.meta)[0] ?? row.meta.workspaceId;
				let group = groups.get(key);
				if (!group) {
					group = { name: this.projectName(row.meta), rows: [] };
					groups.set(key, group);
				}
				group.rows.push(row);
			}
			for (const group of groups.values()) {
				items.push({ type: 'separator', label: group.name, description: `${group.rows.length}`, buttons: SECTION_ROW });
				items.push(...group.rows.map(row => this.item(row, false)));
			}
		} else if (!query) {
			if (rows.length) {
				items.push({ type: 'separator', label: localize('voltAgent.chatSearch.recent', "Recent"), buttons: SECTION_ROW });
				items.push(...rows.map(row => this.item(row, true)));
			}
		} else {
			const titles = rows.filter(row => row.kind === 'title');
			const content = rows.filter(row => row.kind === 'content');
			if (titles.length) {
				items.push({ type: 'separator', label: localize('voltAgent.chatSearch.titles', "Titles"), buttons: SECTION_ROW });
				items.push(...titles.map(row => this.item(row, true)));
			}
			if (content.length) {
				items.push({
					type: 'separator',
					label: localize('voltAgent.chatSearch.inConversations', "In Conversations"),
					buttons: SECTION_ROW,
					description: progress.building
						? localize('voltAgent.chatSearch.progress', "searched {0} of {1} chats", progress.indexed, progress.total)
						: undefined,
				});
				items.push(...content.map(row => this.item(row, true)));
			}
		}
		if (query && !rows.length && !searching) {
			items.push({ sessionId: '', label: localize('voltAgent.chatSearch.none', "No chats mention \"{0}\"", query), alwaysShow: true });
		}

		const picker = this.picker;
		const active = reset ? undefined : picker.activeItems[0]?.id;
		picker.busy = searching;
		picker.keepScrollPosition = !reset;
		picker.items = items;
		if (active) {
			const again = items.find((item): item is IChatPick => item.type !== 'separator' && item.id === active);
			if (again) {
				picker.activeItems = [again];
			}
		}
	}

	private item(row: IChatRow, withProject: boolean): IChatPick {
		const { meta, content } = row;
		const description = [
			withProject ? this.projectName(meta) : undefined,
			fromNow(meta.updatedAt, true),
			meta.archived ? localize('voltAgent.chatSearch.archived', "Archived") : undefined,
		].filter(Boolean).join(' · ');
		const snippet = content?.snippet;
		let detail: string | undefined;
		let detailHighlights: IMatch[] | undefined;
		if (snippet) {
			const speaker = snippet.role === 'user'
				? localize('voltAgent.chatSearch.you', "You: ")
				: localize('voltAgent.chatSearch.agent', "Agent: ");
			detail = `${speaker}${snippet.text}`;
			detailHighlights = snippet.highlights.map(match => ({ start: match.start + speaker.length, end: match.end + speaker.length }));
		} else if (row.kind === 'content') {
			detail = localize('voltAgent.chatSearch.inReply', "Found in a reply…");
		}
		const icon = meta.status === 'running'
			? ThemeIcon.modify(Codicon.loading, 'spin')
			: meta.archived ? Codicon.archive : row.kind === 'content' ? Codicon.quote : Codicon.commentDiscussion;
		return {
			id: meta.id,
			sessionId: meta.id,
			label: chatLabel(meta),
			description,
			detail,
			// iconClass, not iconClasses: iconClasses lands on the label itself and turns the whole row into a codicon glyph.
			iconClass: ThemeIcon.asClassName(icon),
			highlights: {
				label: row.title ? [...row.title.highlights] : undefined,
				detail: detailHighlights,
			},
			// A title hit opens the chat as usual; a message hit lands on the message.
			reveal: row.kind === 'content' && content ? { turnId: content.turnId, find: snippet?.find ?? '' } : undefined,
		};
	}

	private projectName(meta: IAgentSessionMeta): string {
		const folder = sessionFolders(meta)[0];
		return (folder && this.projectNames.get(folder))
			|| meta.workspaceLabel
			|| (folder ? basename(folder) : localize('voltAgent.chatSearch.noProject', "No Project"));
	}

	private accept(): void {
		const pick = this.picker.selectedItems[0] ?? this.picker.activeItems[0];
		if (!pick?.sessionId) {
			return;
		}
		this.picker.hide();
		if (pick.reveal) {
			requestAgentTurnReveal(pick.sessionId, pick.reveal);
		}
		void this.commandService.executeCommand(OPEN_AGENT_COMMAND_ID, pick.sessionId);
	}
}

registerAction2(class SearchAgentChatsAction extends Action2 {
	constructor() {
		super({
			id: SEARCH_AGENT_CHATS_COMMAND_ID,
			title: localize2('voltAgent.searchChats', "Search Chats"),
			category: Categories.View,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IInstantiationService).createInstance(AgentChatSearchPicker).show();
	}
});
