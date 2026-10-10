/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltSetup.css';
import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { safeIntl } from '../../../../base/common/date.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { language } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { AgentRunOn } from '../../../services/voltRuntime/common/git/agentWorktree.js';
import { IVoltProjectRecord } from '../../../services/voltRuntime/common/sessionContext.js';
import { AgentModelPicker } from '../../voltAgent/browser/picker/agentModelPicker.js';
import { IAgentProjectUsageService } from '../../voltAgent/browser/usage/agentProjectUsage.js';
import { formatCost, formatDuration, formatTokens } from '../../voltAgent/browser/usage/agentUsageFormat.js';
import { showVoltModal } from '../../voltProjects/browser/ui/voltModal.js';
import { CURSOR_WORKTREES_FILE, formatEnvText, parseEnvText, stepsFromText, VOLT_WORKTREES_FILE } from '../common/projectSettings.js';
import { IVoltProjectSettingsService } from './projectSettingsService.js';
import { VoltStorageView } from './storageView.js';

let openFor: string | undefined;

const sinceFormat = safeIntl.DateTimeFormat(language, { month: 'short', day: 'numeric', year: 'numeric' });

/** `38s` and `2m 38s` for short totals, then hours and days like the Usage page. */
function formatAgentTime(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) {
		return `${Math.max(1, seconds)}s`;
	}
	if (seconds < 3600) {
		const minutes = Math.floor(seconds / 60);
		return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
	}
	return formatDuration(ms);
}

/** Project Settings: what the project's chats have spent, what new chats start with, its worktree setup, its agents' environment, and its storage. */
export class ProjectSettingsDialog {

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVoltProjectSettingsService private readonly settings: IVoltProjectSettingsService,
		@ILabelService private readonly labelService: ILabelService,
		@INotificationService private readonly notificationService: INotificationService,
		@IAgentProjectUsageService private readonly usage: IAgentProjectUsageService,
	) { }

	show(project: IVoltProjectRecord): void {
		if (openFor === project.id) {
			return;
		}
		openFor = project.id;
		showVoltModal(this.layoutService, {
			title: localize('voltProjectSettings.title', "Project Settings"),
			subtitle: `${project.displayName} · ${this.labelService.getUriLabel(project.root, { relative: false })}`,
			width: 720,
			height: 640,
			className: 'volt-setup volt-project-settings',
			render: (body, close) => this.render(body, close, project),
			onDidClose: () => openFor = undefined,
		});
	}

	private render(body: HTMLElement, close: () => void, project: IVoltProjectRecord): IDisposable {
		const store = new DisposableStore();
		const saved = this.settings.get(project.id);
		let defaultModel = saved.defaultModel;
		let runOn: AgentRunOn = this.settings.getRunOn(project.id);
		const content = append(body, $('.volt-setup-content.volt-project-settings-content'));

		this.renderUsage(content, project, store);

		// New chats
		this.section(content, localize('voltProjectSettings.newChats', "New chats"));
		const group = append(content, $('.volt-project-settings-group'));
		this.row(group, localize('voltProjectSettings.model', "Model"), localize('voltProjectSettings.modelDesc', "Agent and model a new chat in this project starts on. You can still switch in the chat."), host => {
			const button = append(host, $('button.volt-agent-model.volt-settings-model')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('aria-haspopup', 'dialog');
			const picker = store.add(this.instantiationService.createInstance(AgentModelPicker, {
				binding: {
					get: () => defaultModel,
					set: ref => { defaultModel = ref; },
					autoLabel: localize('voltProjectSettings.lastUsed', "Last used"),
					autoDescription: localize('voltProjectSettings.lastUsedDesc', "Start on the model you picked last"),
				},
				position: AnchorPosition.BELOW,
				alignment: AnchorAlignment.RIGHT,
				onDidChange: () => paint(),
			}));
			const paint = () => {
				button.replaceChildren();
				picker.renderTrigger(button);
				button.appendChild(renderIcon(Codicon.chevronDown));
			};
			paint();
			store.add(addDisposableListener(button, 'click', () => picker.show(button, () => paint())));
		});
		this.row(group, localize('voltProjectSettings.runOn', "Run on"), localize('voltProjectSettings.runOnDesc', "Where new chats make their changes. Same as the Run on menu under the composer."), host => {
			const segmented = append(host, $('.volt-setup-segmented'));
			segmented.setAttribute('role', 'radiogroup');
			const options: [AgentRunOn, string][] = [
				['same-branch', localize('voltProjectSettings.sameBranch', "This checkout")],
				['worktree', localize('voltProjectSettings.worktree', "New worktree")],
			];
			const buttons: HTMLButtonElement[] = [];
			for (const [value, label] of options) {
				const button = append(segmented, $('button')) as HTMLButtonElement;
				button.type = 'button';
				button.setAttribute('role', 'radio');
				button.textContent = label;
				buttons.push(button);
				const sync = () => buttons.forEach((candidate, index) => {
					candidate.classList.toggle('active', options[index][0] === runOn);
					candidate.setAttribute('aria-checked', String(options[index][0] === runOn));
				});
				store.add(addDisposableListener(button, 'click', () => { runOn = value; sync(); }));
				sync();
			}
		});

		// Worktree setup
		this.section(content, localize('voltProjectSettings.setup', "Worktree setup"));
		const setupHint = append(content, $('.volt-project-settings-hint'));
		setupHint.textContent = localize('voltProjectSettings.setupHint', "Commands that run in each new worktree of a multi-model run before the agents start, one per line. They share one shell in the worktree; $ROOT_WORKTREE_PATH is this checkout. Saved to {0} in the project, the format Cursor's {1} uses.", VOLT_WORKTREES_FILE, CURSOR_WORKTREES_FILE);
		const setup = append(content, $('textarea.volt-project-settings-text')) as HTMLTextAreaElement;
		setup.rows = 4;
		setup.spellcheck = false;
		setup.placeholder = 'npm ci\ncp $ROOT_WORKTREE_PATH/.env .env';
		setup.disabled = true;
		const setupSource = append(content, $('.volt-project-settings-source'));
		let originalSetup = '';
		void this.settings.readWorktreeSetup(project.root).then(read => {
			originalSetup = read.steps.join('\n');
			setup.value = originalSetup;
			setup.disabled = false;
			if (read.error) {
				setupSource.textContent = localize('voltProjectSettings.setupError', "{0} could not be read ({1}). Saving replaces its setup.", read.source ?? VOLT_WORKTREES_FILE, read.error);
				setupSource.classList.add('warn');
			} else if (read.source === CURSOR_WORKTREES_FILE) {
				setupSource.textContent = localize('voltProjectSettings.fromCursor', "From {0}. Saving writes {1}, which Volt reads first.", CURSOR_WORKTREES_FILE, VOLT_WORKTREES_FILE);
			} else if (read.script) {
				setupSource.textContent = localize('voltProjectSettings.script', "A script path, run with the worktree as its argument.");
			}
		});

		// Environment
		this.section(content, localize('voltProjectSettings.env', "Environment"));
		append(content, $('.volt-project-settings-hint')).textContent = localize('voltProjectSettings.envHint', "NAME=value per line. Added to the agent processes Volt starts in this project and its worktrees. Kept on this machine, not in the repository; the agent can read these values.");
		const env = append(content, $('textarea.volt-project-settings-text')) as HTMLTextAreaElement;
		env.rows = 4;
		env.spellcheck = false;
		env.placeholder = 'DATABASE_URL=postgres://localhost/dev\nNODE_OPTIONS=--max-old-space-size=8192';
		env.value = formatEnvText(saved.env);
		const envError = append(content, $('.volt-project-settings-source.warn'));
		const checkEnv = () => {
			const { invalidLines } = parseEnvText(env.value);
			envError.textContent = invalidLines.length ? localize('voltProjectSettings.envInvalid', "Line {0} is not NAME=value and will be skipped.", invalidLines.join(', ')) : '';
		};
		store.add(addDisposableListener(env, 'input', checkEnv));
		checkEnv();

		// Storage
		this.section(content, localize('voltProjectSettings.storage', "Storage"));
		store.add(this.instantiationService.createInstance(VoltStorageView, content, project));

		const footer = append(body, $('.volt-add-footer.volt-setup-footer'));
		append(footer, $('span.volt-add-footer-hint')).textContent = localize('voltProjectSettings.footer', "Applies to new chats.");
		const cancel = store.add(new Button(footer, { ...defaultButtonStyles, secondary: true }));
		cancel.label = localize('voltProjectSettings.cancel', "Cancel");
		store.add(cancel.onDidClick(() => close()));
		const save = store.add(new Button(footer, defaultButtonStyles));
		save.label = localize('voltProjectSettings.save', "Save");
		store.add(save.onDidClick(async () => {
			this.settings.set(project.id, { defaultModel, env: parseEnvText(env.value).env });
			this.settings.setRunOn(project.id, runOn);
			if (!setup.disabled && setup.value.trim() !== originalSetup.trim()) {
				try {
					await this.settings.writeWorktreeSetup(project.root, stepsFromText(setup.value));
				} catch (err) {
					this.notificationService.error(localize('voltProjectSettings.setupWriteFailed', "Could not save {0}: {1}", VOLT_WORKTREES_FILE, toErrorMessage(err)));
					return;
				}
			}
			close();
		}));
		return store;
	}

	/** Every chat in the project, deleted ones included: they were spent. */
	private renderUsage(parent: HTMLElement, project: IVoltProjectRecord, store: DisposableStore): void {
		const head = append(parent, $('.volt-project-settings-usage-head'));
		append(head, $('.volt-setup-section')).textContent = localize('voltProjectSettings.usage', "Usage");
		const since = append(head, $('span.since'));
		const grid = append(parent, $('.volt-project-settings-group.volt-project-settings-usage'));
		const stat = (label: string) => {
			const cell = append(grid, $('.stat'));
			append(cell, $('.label')).textContent = label;
			return { value: append(cell, $('.value')), note: append(cell, $('.note')) };
		};
		const chats = stat(localize('voltProjectSettings.usageChats', "Chats"));
		const tokens = stat(localize('voltProjectSettings.usageTokens', "Tokens"));
		const cost = stat(localize('voltProjectSettings.usageCost', "Cost"));
		const time = stat(localize('voltProjectSettings.usageTime', "Agent time"));
		append(parent, $('.volt-project-settings-hint')).textContent = localize('voltProjectSettings.usageHint', "Every chat started in this project, deleted ones included. Agent time is how long agents spent on replies.");
		const paint = () => {
			const totals = this.usage.totals(project.root);
			since.textContent = totals.since !== undefined ? localize('voltProjectSettings.usageSince', "Since {0}", sinceFormat.value.format(totals.since)) : '';
			chats.value.textContent = String(totals.chats);
			chats.note.textContent = totals.deletedChats
				? localize('voltProjectSettings.usageTurnsDeleted', "{0} turns · {1} deleted", totals.turns, totals.deletedChats)
				: localize('voltProjectSettings.usageTurns', "{0} turns", totals.turns);
			// Chats from before Volt recorded tokens have none to count.
			tokens.value.textContent = totals.tokens > 0 ? formatTokens(totals.tokens) : '\u2014';
			tokens.note.textContent = totals.tokens > 0 ? localize('voltProjectSettings.usageTokensNote', "input, output and cache") : '';
			const priced = totals.costUsd > 0 || (totals.tokens > 0 && totals.unpricedTurns === 0);
			cost.value.textContent = priced ? formatCost(totals.costUsd) : '\u2014';
			cost.note.textContent = totals.unpricedTurns > 0
				? localize('voltProjectSettings.usageUnpriced', "{0} turns without a price", totals.unpricedTurns)
				: '';
			time.value.textContent = totals.activeMs > 0 ? formatAgentTime(totals.activeMs) : '\u2014';
			time.note.textContent = '';
		};
		paint();
		store.add(this.usage.onDidChange(paint));
		// Chats that ran since they were last counted.
		void this.usage.refresh();
	}

	private section(parent: HTMLElement, label: string): void {
		append(parent, $('.volt-setup-section')).textContent = label;
	}

	private row(parent: HTMLElement, title: string, desc: string, control: (host: HTMLElement) => void): void {
		const row = append(parent, $('.volt-project-settings-row'));
		const copy = append(row, $('.copy'));
		append(copy, $('.title')).textContent = title;
		append(copy, $('.desc')).textContent = desc;
		control(append(row, $('.control')));
	}
}
