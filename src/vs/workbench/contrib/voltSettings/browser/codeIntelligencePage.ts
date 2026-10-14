/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/codeIntelligence.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/path.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IVoltCodeIndexService, IVoltCodeIndexStatus, IVoltFffStatus } from '../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { CODE_INDEX_ENABLED_SETTING, CODE_INDEX_HIERARCHICAL_IGNORE_SETTING, CODE_INDEX_IGNORE_SYMLINKS_SETTING, clampLspWorkspaces, FFF_MODE_SETTING, readFffSettings, RETRIEVAL_ENABLED_SETTING, LSP_ENABLED_SETTING, LSP_MAX_LOCAL_SETTING, LSP_MAX_REMOTE_SETTING, LSP_WORKTREES_SETTING, readCodeIndexOptions, RTK_ENABLED_SETTING } from '../../../services/voltRuntime/common/codeIntelligence.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';

/** The settings editor's building blocks, so this page looks like every other one. */
export interface ISettingsPageKit {
	readonly store: DisposableStore;
	pageHead(title: string, lead?: string): void;
	sectionLabel(label: string): void;
	settingsGroup(): HTMLElement;
	settingRow(parent: HTMLElement, title: string, desc: string | undefined, renderControl?: (host: HTMLElement) => void): HTMLElement;
	toggle(parent: HTMLElement, on: boolean, label: string, onClick: () => void): void;
	stepper(parent: HTMLElement, valueText: string, unit: string, onCommit: (next: number) => number, step: number): void;
	/** Re-renders the page (after a setting changed). */
	rerender(): void;
	isCurrent(): boolean;
}

const POLL_BUSY_MS = 1_000;
const POLL_IDLE_MS = 5_000;

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) {
		return localize('voltCodeIntel.kb', "{0} KB", Math.max(1, Math.round(bytes / 1024)));
	}
	if (bytes < 1024 * 1024 * 1024) {
		return localize('voltCodeIntel.mb', "{0} MB", (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0));
	}
	return localize('voltCodeIntel.gb', "{0} GB", (bytes / (1024 * 1024 * 1024)).toFixed(1));
}

function formatCount(value: number): string {
	if (value >= 1e9) {
		return `${(value / 1e9).toFixed(1)}B`;
	}
	if (value >= 1e6) {
		return `${(value / 1e6).toFixed(1)}M`;
	}
	if (value >= 1e3) {
		return `${(value / 1e3).toFixed(1)}K`;
	}
	return String(value);
}

function describe(status: IVoltCodeIndexStatus): string {
	switch (status.state) {
		case 'indexing':
			return status.progress?.total
				? localize('voltCodeIntel.indexing', "Indexing {0} of {1} files…", status.progress.done.toLocaleString(), status.progress.total.toLocaleString())
				: localize('voltCodeIntel.loading', "Loading and catching up with changes…");
		case 'error':
			return localize('voltCodeIntel.error', "Not available: {0}. Searches use ripgrep.", status.error ?? '');
		case 'none':
			return localize('voltCodeIntel.none', "Not indexed yet. It is built the first time an agent searches here.");
		case 'ready': {
			const parts = [
				localize('voltCodeIntel.files', "{0} files", status.files.toLocaleString()),
				localize('voltCodeIntel.text', "{0} of text", formatBytes(status.bytes)),
				localize('voltCodeIntel.disk', "{0} on disk", formatBytes(status.diskBytes)),
			];
			if (status.symbols) {
				parts.push(localize('voltCodeIntel.symbols', "{0} symbols", status.symbols.toLocaleString()));
			}
			if (status.pending) {
				parts.push(localize('voltCodeIntel.pending', "{0} changed files catching up", status.pending.toLocaleString()));
			}
			if (status.lastSearchMs !== undefined) {
				parts.push(localize('voltCodeIntel.lastSearch', "last search {0} ms", status.lastSearchMs));
			}
			return parts.join(' · ');
		}
	}
}

/**
 * Settings > Code Intelligence: the code index behind instant grep (on/off, what it covers, each
 * project's index with rebuild and delete) and the language servers agents may use.
 */
export class CodeIntelligencePage {

	constructor(
		private readonly kit: ISettingsPageKit,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IVoltCodeIndexService private readonly codeIndex: IVoltCodeIndexService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
	) { }

	private setting(key: string): boolean {
		const defaults: Record<string, boolean> = { [CODE_INDEX_ENABLED_SETTING]: true, [LSP_ENABLED_SETTING]: true, [RTK_ENABLED_SETTING]: true, [RETRIEVAL_ENABLED_SETTING]: true };
		const value = this.configurationService.getValue<boolean>(key);
		return typeof value === 'boolean' ? value : defaults[key] ?? false;
	}

	private switchRow(parent: HTMLElement, key: string, title: string, desc: string): void {
		const on = this.setting(key);
		this.kit.settingRow(parent, title, desc, host => this.kit.toggle(host, on, title, () => {
			void this.configurationService.updateValue(key, !on).then(() => this.kit.rerender());
		}));
	}

	render(): void {
		const kit = this.kit;
		kit.pageHead(
			localize('voltCodeIntel.title', "Code Intelligence"),
			localize('voltCodeIntel.lead', "How agents search and understand your code: a local index that makes grep instant, and which projects run language servers."),
		);

		kit.sectionLabel(localize('voltCodeIntel.codebase', "Codebase"));
		const codebase = kit.settingsGroup();
		this.switchRow(codebase, CODE_INDEX_ENABLED_SETTING,
			localize('voltCodeIntel.indexTitle', "Index Repositories for Instant Grep"),
			localize('voltCodeIntel.indexDesc', "Automatically index projects so agents' searches answer in milliseconds, even in very large repos. All data is stored locally and kept fresh as files change."));
		if (this.setting(CODE_INDEX_ENABLED_SETTING)) {
			this.renderIndexes(kit.settingsGroup());
		}
		this.renderSearch();

		kit.sectionLabel(localize('voltCodeIntel.ignore', "Ignore Files"));
		const ignore = kit.settingsGroup();
		this.switchRow(ignore, CODE_INDEX_HIERARCHICAL_IGNORE_SETTING,
			localize('voltCodeIntel.hierarchical', "Hierarchical Volt Ignore"),
			localize('voltCodeIntel.hierarchicalDesc', "Apply .voltignore (and .cursorignore) files in every subfolder, not only at the project root. .gitignore is always honored. Changing this rebuilds the index."));
		this.switchRow(ignore, CODE_INDEX_IGNORE_SYMLINKS_SETTING,
			localize('voltCodeIntel.symlinks', "Ignore Symlinks"),
			localize('voltCodeIntel.symlinksDesc', "Use with caution. Do not follow symbolic links when listing a project's files, so linked folders are left out of the index. Changing this rebuilds the index."));

		this.renderRtk();

		kit.sectionLabel(localize('voltCodeIntel.lsp', "LSP"));
		const lsp = kit.settingsGroup();
		this.switchRow(lsp, LSP_ENABLED_SETTING,
			localize('voltCodeIntel.lspEnabled', "Enable LSPs"),
			localize('voltCodeIntel.lspEnabledDesc', "Let agents use language servers for diagnostics and code navigation. Off: they navigate with the code index, and projects in the background stop their language servers."));
		this.switchRow(lsp, LSP_WORKTREES_SETTING,
			localize('voltCodeIntel.lspWorktrees', "Enable LSPs for Worktrees"),
			localize('voltCodeIntel.lspWorktreesDesc', "Let agents use language servers in their worktree checkouts. Each checkout loads another copy of the project into the language server; off, agents there use the code index."));
		const limitRow = (key: string, title: string, desc: string) => kit.settingRow(lsp, title, desc, host => kit.stepper(host, String(clampLspWorkspaces(this.configurationService.getValue(key))), '', next => {
			const value = clampLspWorkspaces(next);
			void this.configurationService.updateValue(key, value);
			return value;
		}, 1));
		limitRow(LSP_MAX_LOCAL_SETTING,
			localize('voltCodeIntel.maxLocal', "Maximum Local LSP Workspaces"),
			localize('voltCodeIntel.maxLocalDesc', "How many local projects keep language servers running at once. The project on screen and ones with an agent at work come first; the rest pause them until you switch back."));
		limitRow(LSP_MAX_REMOTE_SETTING,
			localize('voltCodeIntel.maxRemote', "Maximum Remote LSP Workspaces"),
			localize('voltCodeIntel.maxRemoteDesc', "How many remote projects (SSH, containers) keep language servers running at once."));
	}

	/**
	 * The search-to-context pipeline (relevant code before the agent's first step) and FFF, the
	 * optional engine for fuzzy file search, with its install state.
	 */
	private renderSearch(): void {
		const kit = this.kit;
		kit.sectionLabel(localize('voltCodeIntel.search', "Search and Context"));
		const group = kit.settingsGroup();
		this.switchRow(group, RETRIEVAL_ENABLED_SETTING,
			localize('voltCodeIntel.retrieval', "Find Relevant Code Before the Agent Starts"),
			localize('voltCodeIntel.retrievalDesc', "Search the project for the files, symbols and errors your message names and give the agent the best matches with their code (about 1,500 tokens at most; Claude Code and Codex get a short file list). Runs while the turn starts; skipped when a message names nothing."));

		const fff = readFffSettings(this.configurationService);
		const title = localize('voltCodeIntel.fffTitle', "Fuzzy File Search with FFF");
		const row = kit.settingRow(group, title, localize('voltCodeIntel.fffChecking', "Checking for FFF\u2026"), host => kit.toggle(host, fff.mode !== 'off', title, () => {
			void this.configurationService.updateValue(FFF_MODE_SETTING, fff.mode === 'off' ? 'auto' : 'off').then(() => kit.rerender());
		}));
		const desc = row.querySelector('.desc') as HTMLElement | null;
		const control = append(row, $('.volt-settings-row-control'));
		const describe = (status: IVoltFffStatus) => {
			if (!desc || !this.kit.isCurrent()) {
				return;
			}
			switch (status.state) {
				case 'ready':
					desc.textContent = localize('voltCodeIntel.fffReady', "FFF {0}{1}: the agent's find_files is typo-tolerant and ranks files you changed and used first. Volt runs it as its own process, one per project, stopped when idle.", status.version ?? '', status.managed ? '' : ` (${status.path})`);
					break;
				case 'missing':
					desc.textContent = localize('voltCodeIntel.fffMissing', "Optional. Volt's index already answers find_files; FFF ranks better (typos, recent and changed files). Installing downloads FFF {0} (about 8 MB, MIT license) from its GitHub release and checks its SHA-256.", status.bundledVersion);
					break;
				case 'error':
					desc.textContent = localize('voltCodeIntel.fffError', "FFF is installed but does not run ({0}). Volt's index answers find_files instead.", status.error ?? '');
					break;
				default:
					desc.textContent = localize('voltCodeIntel.fffUnsupported', "FFF has no release for this platform. Volt's index answers find_files.");
			}
		};
		void this.codeIndex.fffStatus(fff.path).then(status => {
			describe(status);
			if (status.state !== 'missing' && !(status.state === 'error' && status.managed) || !this.kit.isCurrent()) {
				return;
			}
			const button = this.kit.store.add(createVoltButton(control, 'secondary'));
			button.label = localize('voltCodeIntel.fffInstall', "Install FFF");
			this.kit.store.add(button.onDidClick(() => {
				button.enabled = false;
				button.label = localize('voltCodeIntel.fffInstalling', "Installing\u2026");
				void this.codeIndex.installFff().then(result => {
					describe(result);
					button.label = result.state === 'ready' ? localize('voltCodeIntel.fffInstalled', "Installed") : localize('voltCodeIntel.fffInstallFailed', "Failed");
				}, () => {
					button.label = localize('voltCodeIntel.fffInstallFailed', "Failed");
				});
			}));
		}, () => describe({ state: 'unsupported', bundledVersion: '', running: 0 }));
	}

	private async run(command: string, timeoutMs = 15_000): Promise<{ ok: boolean; out: string }> {
		try {
			const result = await this.stdio.exec({ id: `rtk-${generateUuid().slice(0, 8)}`, command, timeoutMs, inlineChars: 20_000 });
			return { ok: result.exitCode === 0, out: result.stdout.trim() };
		} catch {
			return { ok: false, out: '' };
		}
	}

	/**
	 * RTK (github.com/rtk-ai/rtk): compact output for git, test runners, linters and package
	 * managers. Volt's own agent uses it through the shell tool; Claude Code and Codex through
	 * RTK's own hook, which this sets up on request.
	 */
	private renderRtk(): void {
		const kit = this.kit;
		kit.sectionLabel(localize('voltCodeIntel.rtk', "Token Efficiency"));
		const group = kit.settingsGroup();
		const on = this.setting(RTK_ENABLED_SETTING);
		const title = localize('voltCodeIntel.rtkTitle', "Compress Command Output with RTK");
		const row = kit.settingRow(group, title, localize('voltCodeIntel.rtkChecking', "Checking for RTK\u2026"), host => kit.toggle(host, on, title, () => {
			void this.configurationService.updateValue(RTK_ENABLED_SETTING, !on).then(() => kit.rerender());
		}));
		const desc = row.querySelector('.desc') as HTMLElement | null;
		const hooks = kit.settingRow(group, localize('voltCodeIntel.rtkAgents', "Claude Code and Codex"), localize('voltCodeIntel.rtkAgentsChecking', "Checking their RTK hooks\u2026"));
		const hooksDesc = hooks.querySelector('.desc') as HTMLElement | null;
		const hooksControl = append(hooks, $('.volt-settings-row-control'));
		void (async () => {
			const version = await this.run('rtk --version', 5_000);
			if (!this.kit.isCurrent()) {
				return;
			}
			if (!version.ok) {
				if (desc) {
					desc.textContent = localize('voltCodeIntel.rtkMissing', "RTK is not installed. It cuts the tokens of git, test, lint and build output (72% in Volt's own measurements). Install it (macOS/Linux: brew install rtk; Windows: winget, see github.com/rtk-ai/rtk; or cargo install --git https://github.com/rtk-ai/rtk), then reopen this page.");
				}
				hooks.remove();
				return;
			}
			const gain = await this.run('rtk gain --format json', 10_000);
			let saved = '';
			try {
				const summary = (JSON.parse(gain.out) as { summary?: { total_saved?: number; avg_savings_pct?: number; total_commands?: number } }).summary;
				if (summary?.total_saved) {
					saved = localize('voltCodeIntel.rtkSaved', " \u00b7 {0} tokens saved over {1} commands ({2}% on average)", formatCount(summary.total_saved), (summary.total_commands ?? 0).toLocaleString(), Math.round(summary.avg_savings_pct ?? 0));
				}
			} catch {
				// no stats yet
			}
			if (desc && this.kit.isCurrent()) {
				desc.textContent = localize('voltCodeIntel.rtkReady', "{0}: Volt's agent runs git, test runners, linters and package managers through RTK and reads compact output. Commands RTK does not know run as written.", version.out.split('\n')[0]) + saved;
			}
			const show = await this.run('rtk init --show', 10_000);
			if (!this.kit.isCurrent()) {
				return;
			}
			const claudeHook = /\[ok\]\s*Hook:/i.test(show.out) && /\[ok\]\s*settings\.json/i.test(show.out);
			if (hooksDesc) {
				hooksDesc.textContent = claudeHook
					? localize('voltCodeIntel.rtkClaudeOn', "Claude Code already runs its shell commands through RTK (its hook is installed). Set up Codex to have it use RTK too.")
					: localize('voltCodeIntel.rtkClaudeOff', "They run their own shell, so Volt's setting does not reach them. RTK's hook makes them use it: this edits ~/.claude/settings.json and ~/.codex/AGENTS.md.");
			}
			const setup = (label: string, command: string) => {
				const button = this.kit.store.add(createVoltButton(hooksControl, 'secondary'));
				button.label = label;
				this.kit.store.add(button.onDidClick(() => {
					button.enabled = false;
					void this.run(command, 30_000).then(result => {
						button.label = result.ok ? localize('voltCodeIntel.rtkDone', "Done") : localize('voltCodeIntel.rtkFailed', "Failed");
					});
				}));
			};
			if (!claudeHook) {
				setup(localize('voltCodeIntel.rtkClaude', "Set Up Claude Code"), 'rtk init -g --auto-patch');
			}
			setup(localize('voltCodeIntel.rtkCodex', "Set Up Codex"), 'rtk init -g --codex');
		})();
	}

	/** This project's folders first, then every other index on disk; refreshed while the page is open. */
	private renderIndexes(group: HTMLElement): void {
		const store = this.kit.store;
		const open = this.workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file).map(folder => folder.uri.fsPath);
		const list = append(group, $('.volt-code-index-list'));
		let timer: ReturnType<typeof setTimeout> | undefined;
		let disposed = false;
		store.add(toDisposable(() => {
			disposed = true;
			clearTimeout(timer);
		}));
		const refresh = async () => {
			const [mine, all] = await Promise.all([this.codeIndex.status(open), this.codeIndex.status()]).catch(() => [[], []] as const);
			if (disposed || !this.kit.isCurrent()) {
				return;
			}
			const seen = new Set(mine.map(status => status.root));
			const statuses = [...mine, ...all.filter(status => !seen.has(status.root))];
			this.paint(list, statuses, new Set(open), () => void refresh());
			const busy = statuses.some(status => status.state === 'indexing' || status.pending > 0);
			timer = setTimeout(() => void refresh(), busy ? POLL_BUSY_MS : POLL_IDLE_MS);
		};
		void refresh();
	}

	private paint(list: HTMLElement, statuses: readonly IVoltCodeIndexStatus[], open: ReadonlySet<string>, refresh: () => void): void {
		clearNode(list);
		const store = this.kit.store;
		if (!statuses.length) {
			append(list, $('.volt-code-index-empty')).textContent = localize('voltCodeIntel.noIndexes', "No projects indexed yet. A project is indexed when it opens or when an agent first searches it.");
			return;
		}
		for (const status of statuses.slice(0, 12)) {
			const row = append(list, $('.volt-code-index-row'));
			const copy = append(row, $('.volt-code-index-copy'));
			const title = append(copy, $('.volt-code-index-name'));
			append(title, $(`span.volt-code-index-dot.${status.state}`));
			append(title, $('span')).textContent = basename(status.root) || status.root;
			if (open.has(status.root)) {
				append(title, $('span.volt-code-index-tag')).textContent = localize('voltCodeIntel.thisProject', "This project");
			}
			const path = append(copy, $('.volt-code-index-path'));
			path.textContent = status.root;
			path.title = status.root;
			append(copy, $('.volt-code-index-desc')).textContent = describe(status);
			if (status.state === 'indexing' && status.progress?.total) {
				const bar = append(copy, $('.volt-code-index-bar'));
				append(bar, $('span')).style.width = `${Math.round(100 * status.progress.done / status.progress.total)}%`;
			}
			const actions = append(row, $('.volt-code-index-actions'));
			const rebuild = store.add(createVoltButton(actions, 'secondary'));
			rebuild.label = localize('voltCodeIntel.rebuild', "Rebuild");
			rebuild.enabled = status.state !== 'indexing';
			store.add(rebuild.onDidClick(() => {
				rebuild.enabled = false;
				void this.codeIndex.rebuild(status.root, readCodeIndexOptions(this.configurationService)).finally(refresh);
			}));
			if (status.state !== 'none') {
				const remove = store.add(createVoltButton(actions, 'secondary'));
				remove.label = localize('voltCodeIntel.delete', "Delete");
				store.add(remove.onDidClick(() => {
					remove.enabled = false;
					void this.codeIndex.remove(status.root).finally(refresh);
				}));
			}
		}
		if (statuses.length > 1) {
			const footer = append(list, $('.volt-code-index-footer'));
			const total = statuses.reduce((sum, status) => sum + status.diskBytes, 0);
			append(footer, $('span')).textContent = localize('voltCodeIntel.total', "{0} indexes · {1} on disk", statuses.length, formatBytes(total));
			const clear = store.add(createVoltButton(footer, 'secondary'));
			clear.label = localize('voltCodeIntel.deleteAll', "Delete All");
			store.add(clear.onDidClick(() => {
				clear.enabled = false;
				void this.codeIndex.remove().finally(refresh);
			}));
		}
	}
}
