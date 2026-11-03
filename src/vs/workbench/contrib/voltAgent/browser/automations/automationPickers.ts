/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IVoltPullRequestService } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { AutomationToolKind, formatTimeOfDay, gmtOffsetLabel, IAutomationRepository, weekdayName } from '../../../../services/voltRuntime/common/automations/automations.js';
import { describeCron } from '../../../../services/voltRuntime/common/automations/automationCron.js';
import { COMMON_TIME_ZONES, isLocalTimeZone, localTimeZone, timeZoneCity, timeZoneList } from '../../../../services/voltRuntime/common/automations/automationTime.js';
import { AUTOMATION_EVENTS, AUTOMATION_PROVIDERS, AutomationProvider, IAutomationEventNode, providerLabel } from '../../../../services/voltRuntime/common/automations/automationTriggers.js';
import { IVoltMcpServerStatus } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltMenuHandle, IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { mcpIcon, memoriesIcon, providerIcon } from './automationIcons.js';

//#region Triggers

export interface ITriggerPick {
	readonly provider: AutomationProvider;
	/** Empty on rows that only open a flyout. */
	readonly event: string;
}

function eventItem(provider: AutomationProvider, node: IAutomationEventNode): IVoltMenuItem<ITriggerPick> {
	return node.children
		? { id: `${provider}:${node.label}`, label: node.label, submenu: { sections: eventSections(provider, node.children), width: 200 }, data: { provider, event: '' } }
		: { id: `${provider}:${node.event}`, label: node.label, data: { provider, event: node.event! } };
}

/** A provider's events; a node with `section` starts a titled group ("GitHub Only"). */
function eventSections(provider: AutomationProvider, nodes: readonly IAutomationEventNode[]): IVoltMenuSection<ITriggerPick>[] {
	const sections: { id: string; title?: string; items: IVoltMenuItem<ITriggerPick>[] }[] = [{ id: `${provider}-main`, items: [] }];
	for (const node of nodes) {
		if (node.section) {
			sections.push({ id: `${provider}-${node.section}`, title: node.section, items: [] });
		}
		sections[sections.length - 1].items.push(eventItem(provider, node));
	}
	return sections.filter(section => section.items.length);
}

function flatLabels(nodes: readonly IAutomationEventNode[]): string {
	return nodes.map(node => node.children ? `${node.label} ${flatLabels(node.children)}` : node.label).join(' ');
}

/** Add Trigger: search, then a flyout per service (Scheduled > Daily; GitHub > Pull request… > Merged). */
export function showTriggerMenu(contextView: IContextViewService, anchor: HTMLElement, onPick: (pick: ITriggerPick) => void): IVoltMenuHandle {
	const items = AUTOMATION_PROVIDERS.map((provider): IVoltMenuItem<ITriggerPick> => {
		const nodes = AUTOMATION_EVENTS[provider];
		return {
			id: provider,
			label: providerLabel(provider),
			icon: () => providerIcon(provider),
			keywords: flatLabels(nodes),
			...(nodes.length ? { submenu: { sections: eventSections(provider, nodes), width: 200 } } : {}),
			data: { provider, event: nodes.length ? '' : 'any' },
		};
	});
	return showVoltMenu<ITriggerPick>(contextView, {
		anchor,
		gap: 6,
		width: 280,
		className: 'volt-auto-menu',
		ariaLabel: localize('voltAutomations.addTrigger', "Add Trigger"),
		search: { placeholder: localize('voltAutomations.searchTriggers', "Search Triggers..."), icon: true },
		sections: [{ id: 'providers', items }],
		onPick: item => {
			if (item.data.event) {
				onPick(item.data);
			}
		},
	});
}

/** 00:00 … 23:00 (and the current value when it is off the hour). */
export function showTimeMenu(contextView: IContextViewService, anchor: HTMLElement, current: number, onPick: (minutes: number) => void): IVoltMenuHandle {
	const values = new Set<number>(Array.from({ length: 24 }, (_, hour) => hour * 60));
	values.add(current);
	return showVoltMenu<number>(contextView, {
		anchor,
		gap: 4,
		width: 120,
		className: 'volt-auto-menu volt-auto-time-menu',
		ariaLabel: localize('voltAutomations.time', "Time"),
		sections: [{ id: 'times', items: [...values].sort((a, b) => a - b).map(minutes => ({ id: String(minutes), label: formatTimeOfDay(minutes), checked: minutes === current, data: minutes })) }],
		onPick: item => onPick(item.data),
	});
}

export function showMinuteMenu(contextView: IContextViewService, anchor: HTMLElement, current: number, onPick: (minute: number) => void): IVoltMenuHandle {
	const values = new Set<number>(Array.from({ length: 12 }, (_, index) => index * 5));
	values.add(current);
	return showVoltMenu<number>(contextView, {
		anchor,
		gap: 4,
		width: 100,
		className: 'volt-auto-menu volt-auto-time-menu',
		ariaLabel: localize('voltAutomations.minute', "Minute"),
		sections: [{ id: 'minutes', items: [...values].sort((a, b) => a - b).map(minute => ({ id: String(minute), label: `:${String(minute).padStart(2, '0')}`, checked: minute === current, data: minute })) }],
		onPick: item => onPick(item.data),
	});
}

const INTERVAL_MINUTES = [1, 2, 3, 5, 10, 15, 20, 30, 45];
const INTERVAL_HOURS = [1, 2, 3, 6, 12];

/** "7", "7m", "90 min", "2h", "1.5 hours" → ms; undefined when it is not a whole number of minutes from 1 minute to 7 days. */
export function parseIntervalInput(text: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?)?$/i.exec(text.trim());
	if (!match) {
		return undefined;
	}
	const minutes = Number(match[1]) * (match[2] && /^h/i.test(match[2]) ? 60 : 1);
	return Number.isInteger(minutes) && minutes >= 1 && minutes <= 7 * 1440 ? minutes * 60_000 : undefined;
}

/** Every 1-45 minutes or 1-12 hours, and Custom for any whole number of minutes. */
export function showIntervalMenu(contextView: IContextViewService, anchor: HTMLElement, current: number, onPick: (everyMs: number) => void): IVoltMenuHandle {
	const item = (minutes: number, label: string): IVoltMenuItem<number> => ({ id: String(minutes), label, checked: minutes * 60_000 === current, keywords: `${minutes}`, data: minutes * 60_000 });
	const listed = [...INTERVAL_MINUTES, ...INTERVAL_HOURS.map(hours => hours * 60)].includes(current / 60_000);
	return showVoltMenu<number>(contextView, {
		anchor,
		gap: 4,
		width: 200,
		className: 'volt-auto-menu volt-auto-time-menu',
		ariaLabel: localize('voltAutomations.interval', "Repeat every"),
		search: { placeholder: localize('voltAutomations.intervalSearch', "Minutes or hours...") },
		sections: [
			{ id: 'minutes', title: localize('voltAutomations.minutesTitle', "Minutes"), items: INTERVAL_MINUTES.map(minutes => item(minutes, minutes === 1 ? localize('voltAutomations.oneMinute', "1 minute") : localize('voltAutomations.nMinutes', "{0} minutes", minutes))) },
			{ id: 'hours', title: localize('voltAutomations.hoursTitle', "Hours"), items: INTERVAL_HOURS.map(hours => item(hours * 60, hours === 1 ? localize('voltAutomations.oneHour', "1 hour") : localize('voltAutomations.nHours', "{0} hours", hours))) },
			{
				id: 'custom', items: [{
					id: 'custom', label: listed ? localize('voltAutomations.customInterval', "Custom") : localize('voltAutomations.customIntervalNow', "Custom ({0} minutes)", Math.round(current / 60_000)),
					checked: !listed, alwaysShow: true, icon: Codicon.edit, data: current,
					prompt: {
						placeholder: localize('voltAutomations.customPlaceholder', "Every how long? 7, 90 min, 2h"),
						hint: localize('voltAutomations.customHint', "Minutes by default. From 1 minute to 7 days. Enter to set."),
						validate: value => parseIntervalInput(value) === undefined ? localize('voltAutomations.customInvalid', "A whole number of minutes (1 to 10080), or hours like 2h.") : undefined,
						onSubmit: async value => onPick(parseIntervalInput(value)!),
					},
				}],
			},
		],
		onPick: picked => onPick(picked.data),
	});
}

/** Local first, then the zones most teams use, then every zone (folded until searched). */
export function showTimeZoneMenu(contextView: IContextViewService, anchor: HTMLElement, current: string | undefined, now: number, onPick: (zone: string | undefined) => void): IVoltMenuHandle {
	const local = localTimeZone();
	const isCurrent = (zone: string) => !isLocalTimeZone(current) && current === zone;
	const zoneItem = (zone: string, withOffset: boolean): IVoltMenuItem<string | undefined> => ({
		id: zone,
		label: timeZoneCity(zone),
		description: zone,
		...(withOffset ? { detail: gmtOffsetLabel(now, zone) } : {}),
		keywords: zone.replace(/[/_]/g, ' '),
		checked: isCurrent(zone),
		data: zone,
	});
	const common = COMMON_TIME_ZONES.filter(zone => zone !== local);
	return showVoltMenu<string | undefined>(contextView, {
		anchor,
		gap: 4,
		width: 320,
		className: 'volt-auto-menu',
		ariaLabel: localize('voltAutomations.timeZone', "Time zone"),
		search: { placeholder: localize('voltAutomations.searchZones', "Search time zones..."), icon: true },
		sections: [
			{ id: 'local', items: [{ id: 'local', label: localize('voltAutomations.localZone', "Local ({0})", gmtOffsetLabel(now)), description: timeZoneCity(local), keywords: `local ${local.replace(/[/_]/g, ' ')}`, checked: isLocalTimeZone(current), data: undefined }] },
			{ id: 'common', title: localize('voltAutomations.commonZones', "Common"), items: common.map(zone => zoneItem(zone, true)) },
			{ id: 'all', title: localize('voltAutomations.allZones', "All Time Zones"), collapsed: true, items: timeZoneList().filter(zone => zone !== local && !common.includes(zone)).map(zone => zoneItem(zone, false)) },
		],
		onPick: picked => onPick(picked.data),
	});
}

const CRON_PRESETS: readonly string[] = ['* * * * *', '*/5 * * * *', '*/15 * * * *', '*/30 * * * *', '0 * * * *', '0 */2 * * *', '0 9 * * *', '0 9 * * 1-5', '*/15 9-17 * * 1-5', '0 9 * * 1', '0 18 * * 5', '0 9 1 * *'];

/** Common cron expressions, each with its plain description. */
export function showCronPresetMenu(contextView: IContextViewService, anchor: HTMLElement, current: string, onPick: (expression: string) => void): IVoltMenuHandle {
	return showVoltMenu<string>(contextView, {
		anchor,
		gap: 4,
		width: 320,
		className: 'volt-auto-menu volt-auto-cron-menu',
		ariaLabel: localize('voltAutomations.cronPresets', "Cron presets"),
		sections: [{ id: 'presets', items: CRON_PRESETS.map(expression => ({ id: expression, label: describeCron(expression), detail: expression, checked: expression === current.trim(), data: expression })) }],
		onPick: picked => onPick(picked.data),
	});
}

/** Days for a weekly trigger; picks toggle and keep the menu open. */
export function showWeekdayMenu(contextView: IContextViewService, anchor: HTMLElement, days: () => readonly number[], onToggle: (day: number) => void, onHide?: () => void): IVoltMenuHandle {
	const handle: IVoltMenuHandle = showVoltMenu<number>(contextView, {
		anchor,
		gap: 4,
		width: 170,
		className: 'volt-auto-menu',
		ariaLabel: localize('voltAutomations.days', "Days"),
		sections: () => [{ id: 'days', items: [1, 2, 3, 4, 5, 6, 0].map(day => ({ id: String(day), label: weekdayName(day), checked: days().includes(day), keepOpen: true, data: day })) }],
		onPick: item => {
			onToggle(item.data);
			handle.refresh();
		},
		...(onHide ? { onHide } : {}),
	});
	return handle;
}

//#endregion

//#region Repositories

export interface IRepositoryCandidate {
	/** Stored URI string of the folder. */
	readonly root: string;
	readonly folderName: string;
}

interface IRemoteName {
	readonly owner?: string;
	readonly name?: string;
}

/** Folder → its remote's owner and name; asked once per window (it runs git). */
const remoteNames = new Map<string, Promise<IRemoteName>>();

export function forgetRemoteNames(): void {
	remoteNames.clear();
}

function remoteName(pullRequests: IVoltPullRequestService, fsPath: string): Promise<IRemoteName> {
	let pending = remoteNames.get(fsPath);
	if (!pending) {
		pending = pullRequests.resolveRepo(fsPath).then(repo => repo ? { owner: repo.owner, name: repo.name } : {}, () => ({}));
		remoteNames.set(fsPath, pending);
	}
	return pending;
}

export interface IRepositoryMenuOptions {
	readonly candidates: () => readonly IRepositoryCandidate[];
	readonly toFsPath: (root: string) => string;
	readonly selected: () => readonly IAutomationRepository[];
	readonly recents: readonly IAutomationRepository[];
	readonly onPick: (repositories: readonly IAutomationRepository[]) => void;
	readonly onAdd: () => void;
	readonly onRefresh: () => void;
}

type RepoPick = { readonly kind: 'none' } | { readonly kind: 'multi' } | { readonly kind: 'repo'; readonly repository: IAutomationRepository } | { readonly kind: 'add' } | { readonly kind: 'refresh' };

/**
 * Search repositories, Recents (No Repository first), Select Multiple, every folder with its
 * remote's owner, then Add Repositories and Refresh. Owners are read in the background, a few at
 * a time, and the rows update as they arrive.
 */
export function showRepositoryMenu(contextView: IContextViewService, pullRequests: IVoltPullRequestService, anchor: HTMLElement, options: IRepositoryMenuOptions): IVoltMenuHandle {
	let multi = options.selected().length > 1;
	let chosen = [...options.selected()];
	const resolved = new Map<string, IRemoteName>();
	let disposed = false;
	const refresh = new RunOnceScheduler(() => {
		if (!disposed) {
			handle.refresh();
		}
	}, 120);
	const repositoryOf = (candidate: IRepositoryCandidate): IAutomationRepository => {
		const remote = resolved.get(candidate.root);
		return { root: candidate.root, name: remote?.name ?? candidate.folderName, ...(remote?.owner ? { owner: remote.owner } : {}) };
	};
	const isChosen = (root: string) => chosen.some(repository => repository.root === root);
	const sections = (): IVoltMenuSection<RepoPick>[] => {
		const recents = options.recents.filter(recent => !options.candidates().some(candidate => candidate.root === recent.root)).slice(0, 3);
		return [
			{
				id: 'recents',
				title: localize('voltAutomations.recents', "Recents"),
				items: [
					{ id: 'none', label: localize('voltAutomations.noRepository', "No Repository"), icon: Codicon.home, checked: !multi && !chosen.length && options.selected().length === 0, data: { kind: 'none' } },
					...recents.map(repository => ({ id: `recent:${repository.root}`, label: repository.name, description: repository.owner, icon: Codicon.folder, checked: isChosen(repository.root), data: { kind: 'repo' as const, repository } })),
				],
			},
			{
				id: 'multi',
				items: [{ id: 'multi', label: multi ? localize('voltAutomations.done', "Done") : localize('voltAutomations.selectMultiple', "Select Multiple"), keepOpen: true, alwaysShow: true, className: 'volt-auto-link-row', data: { kind: 'multi' } }],
			},
			{
				id: 'repos',
				emptyMessage: localize('voltAutomations.noRepos', "No folders yet. Add one below."),
				items: options.candidates().map(candidate => {
					const repository = repositoryOf(candidate);
					return {
						id: candidate.root,
						label: repository.name,
						...(repository.owner ? { description: repository.owner } : {}),
						icon: Codicon.folder,
						checked: isChosen(candidate.root),
						keepOpen: multi,
						keywords: `${candidate.folderName} ${repository.owner ?? ''}`,
						tooltip: [repository.owner, repository.name].filter(Boolean).join('\n'),
						data: { kind: 'repo' as const, repository },
					};
				}),
			},
		];
	};
	const handle: IVoltMenuHandle = showVoltMenu<RepoPick>(contextView, {
		anchor,
		gap: 6,
		width: 320,
		className: 'volt-auto-menu volt-auto-repo-menu',
		ariaLabel: localize('voltAutomations.repository', "Repository"),
		search: { placeholder: localize('voltAutomations.searchRepos', "Search repositories, environments...") },
		sections: () => sections(),
		footer: [
			{ id: 'add', label: localize('voltAutomations.addRepos', "Add Repositories"), icon: Codicon.add, data: { kind: 'add' } },
			{ id: 'refresh', label: localize('voltAutomations.refresh', "Refresh"), icon: Codicon.refresh, keepOpen: true, className: 'volt-auto-footer-end', data: { kind: 'refresh' } },
		],
		onPick: item => {
			const data = item.data;
			switch (data.kind) {
				case 'none':
					chosen = [];
					options.onPick([]);
					return;
				case 'multi':
					if (multi) {
						options.onPick(chosen);
					}
					multi = !multi;
					handle.refresh();
					return;
				case 'repo':
					if (multi) {
						chosen = isChosen(data.repository.root) ? chosen.filter(repository => repository.root !== data.repository.root) : [...chosen, data.repository];
						options.onPick(chosen);
						handle.refresh();
					} else {
						chosen = [data.repository];
						options.onPick(chosen);
					}
					return;
				case 'add':
					options.onAdd();
					return;
				case 'refresh':
					remoteNames.clear();
					resolved.clear();
					options.onRefresh();
					void resolveAll();
					return;
			}
		},
		onHide: () => {
			disposed = true;
			refresh.dispose();
		},
	});
	const resolveAll = async () => {
		const queue = options.candidates().slice(0, 80);
		const worker = async () => {
			for (let candidate = queue.shift(); candidate && !disposed; candidate = queue.shift()) {
				const remote = await remoteName(pullRequests, options.toFsPath(candidate.root));
				if (remote.owner || remote.name) {
					resolved.set(candidate.root, remote);
					refresh.schedule();
				}
			}
		};
		await Promise.all([worker(), worker(), worker(), worker()]);
	};
	void resolveAll();
	return handle;
}

//#endregion

//#region Tools

export type ToolPick = { readonly kind: AutomationToolKind; readonly server?: string } | { readonly kind: 'new-mcp' };

export interface IToolMenuOptions {
	readonly hasMemories: boolean;
	readonly added: readonly string[];
	readonly servers: () => Promise<readonly IVoltMcpServerStatus[]>;
}

/** Add Tool or MCP: Built-in, MCP (servers in a flyout), Slack, Microsoft Teams. */
export function showToolMenu(contextView: IContextViewService, anchor: HTMLElement, options: IToolMenuOptions & { readonly onPick: (pick: ToolPick) => void }): IVoltMenuHandle {
	return showVoltMenu<ToolPick>(contextView, {
		anchor,
		gap: 6,
		width: 316,
		className: 'volt-auto-menu',
		ariaLabel: localize('voltAutomations.addTool', "Add Tool or MCP"),
		sections: toolMenuSections(options, pick => pick),
		onPick: item => options.onPick(item.data),
	});
}

/** The tool menu's sections, its picks wrapped for a menu of another kind (the instructions' + menu). */
export function toolMenuSections<T>(options: IToolMenuOptions, wrap: (pick: ToolPick) => T): IVoltMenuSection<T>[] {
	const added = (kind: string) => options.added.includes(kind);
	const addedLabel = localize('voltAutomations.added', "Added");
	return [
		{
			id: 'builtin', title: localize('voltAutomations.builtin', "Built-in"),
			items: [{ id: 'memories', label: localize('voltAutomations.memories', "Memories"), icon: () => memoriesIcon(), disabled: options.hasMemories, ...(options.hasMemories ? { detail: addedLabel } : {}), data: wrap({ kind: 'memories' }) }],
		},
		{
			id: 'mcp', title: localize('voltAutomations.mcp', "MCP"),
			items: [{
				id: 'mcp-server', label: localize('voltAutomations.mcpServer', "MCP Server"), icon: () => mcpIcon(), data: wrap({ kind: 'new-mcp' }),
				submenu: {
					width: 220,
					emptyMessage: localize('voltAutomations.noMcp', "No MCP servers configured."),
					sections: async () => {
						const servers = await options.servers().catch(() => []);
						const item = (server: IVoltMcpServerStatus): IVoltMenuItem<T> => ({
							id: `mcp:${server.name}`, label: server.name, disabled: added(`mcp:${server.name}`), ...(added(`mcp:${server.name}`) ? { detail: addedLabel } : {}), data: wrap({ kind: 'mcp', server: server.name }),
						});
						return [
							{ id: 'new', items: [{ id: 'new', label: localize('voltAutomations.newConnection', "New Connection"), icon: Codicon.add, data: wrap({ kind: 'new-mcp' }) }] },
							{ id: 'user', title: localize('voltAutomations.mcpUser', "User"), items: servers.filter(server => server.scope === 'user').map(item) },
							{ id: 'project', title: localize('voltAutomations.mcpProject', "Project"), items: servers.filter(server => server.scope === 'project').map(item) },
						];
					},
				},
			}],
		},
		{
			id: 'slack', title: localize('voltAutomations.slack', "Slack"),
			items: [
				{ id: 'slack_send', label: localize('voltAutomations.sendSlack', "Send to Slack"), icon: () => providerIcon('slack'), disabled: added('slack_send'), ...(added('slack_send') ? { detail: addedLabel } : {}), data: wrap({ kind: 'slack_send' }) },
				{ id: 'slack_read', label: localize('voltAutomations.readSlack', "Read Public Slack Channels"), icon: () => providerIcon('slack'), disabled: added('slack_read'), ...(added('slack_read') ? { detail: addedLabel } : {}), data: wrap({ kind: 'slack_read' }) },
			],
		},
		{
			id: 'teams', title: localize('voltAutomations.teams', "Microsoft Teams"),
			items: [
				{ id: 'teams_send', label: localize('voltAutomations.sendTeams', "Send to Microsoft Teams"), icon: () => providerIcon('teams'), disabled: added('teams_send'), ...(added('teams_send') ? { detail: addedLabel } : {}), data: wrap({ kind: 'teams_send' }) },
				{ id: 'teams_read', label: localize('voltAutomations.readTeams', "Read Microsoft Teams Channels"), icon: () => providerIcon('teams'), disabled: added('teams_read'), ...(added('teams_read') ? { detail: addedLabel } : {}), data: wrap({ kind: 'teams_read' }) },
			],
		},
	];
}

//#endregion
