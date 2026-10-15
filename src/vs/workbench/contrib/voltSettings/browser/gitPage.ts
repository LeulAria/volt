/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/gitPage.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IVoltStdioService } from '../../../../platform/voltStdio/common/voltStdio.js';
import { hostProductLabel, VOLT_PR_PROVIDERS, VoltPrSupportedProvider } from '../../../../platform/voltPullRequests/common/voltPrHosts.js';
import { IVoltPrAccount, VoltPrAuthSource } from '../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { AGENT_BRANCH_PREFIX_SETTING, AGENT_COMMIT_ATTRIBUTION_SETTING, AGENT_PR_ATTRIBUTION_SETTING, AGENT_PR_LINK_DESTINATION_SETTING, DEFAULT_BRANCH_PREFIX, readBranchPrefix, readLinkDestination } from '../../voltAgent/common/agentGitSettings.js';
import { AUTO_REVIEW_MODES, AutoReviewMode } from '../../voltAgent/common/agentPrReview.js';
import { SIGN_IN_HOST_COMMAND_ID } from '../../voltAgent/browser/pullRequests/agentPullRequestCommands.js';
import { AGENT_PR_AUTO_REVIEW_SETTING, AGENT_PR_POST_REVIEW_COMMENTS_SETTING } from '../../voltAgent/browser/pullRequests/agentPullRequestReviewService.js';
import { IAgentPullRequestService } from '../../voltAgent/browser/pullRequests/agentPullRequestService.js';
import { signInWithGh } from '../../voltAgent/browser/pullRequests/agentPullRequestUi.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { ISettingsPageKit } from './codeIntelligencePage.js';

/** The settings editor's blocks, plus the dropdown, text field and hint this page uses. */
export interface IGitPageKit extends ISettingsPageKit {
	select(parent: HTMLElement, options: readonly string[], selected: number, label: string, onSelect: (index: number) => void): void;
	/** `onCommit` runs when the field loses focus or Enter is pressed. */
	input(parent: HTMLElement, value: string, placeholder: string, label: string, onCommit: (value: string) => void): void;
	sectionHint(text: string): void;
}

const HOST_ICONS: Record<VoltPrSupportedProvider, ThemeIcon> = {
	github: Codicon.github,
	gitlab: Codicon.gitMerge,
	bitbucket: Codicon.repo,
	gitea: Codicon.server,
	azure: Codicon.azureDevops,
};

/** An account as the Integrations list shows it: one from a CLI or the environment, or a token Volt keeps. */
interface IHostAccount {
	readonly host: string;
	readonly login?: string;
	readonly source?: VoltPrAuthSource;
	readonly ok: boolean;
}

function sourceLabel(source: VoltPrAuthSource | undefined, provider: VoltPrSupportedProvider): string {
	switch (source) {
		case 'volt': return localize('voltGitPage.viaToken', "access token in Volt");
		case 'cli': return localize('voltGitPage.viaCli', "{0} CLI", hostProductLabel(provider));
		case 'env': return localize('voltGitPage.viaEnv', "environment variable");
		default: return localize('voltGitPage.viaGh', "GitHub CLI");
	}
}

/**
 * Settings > Git & PRs: where pull request links open, automatic reviews, the marks Volt leaves
 * on its commits and pull requests, what its branches are called, and the code hosts it signs in to.
 */
export class GitPage {

	constructor(
		private readonly kit: IGitPageKit,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentPullRequestService private readonly pullRequests: IAgentPullRequestService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
	) { }

	private update(key: string, value: unknown): void {
		void this.configurationService.updateValue(key, value).then(() => this.kit.rerender());
	}

	private switchRow(parent: HTMLElement, key: string, title: string, desc: string): void {
		const on = !!this.configurationService.getValue<boolean>(key);
		this.kit.settingRow(parent, title, desc, host => this.kit.toggle(host, on, title, () => this.update(key, !on)));
	}

	render(): void {
		const kit = this.kit;
		kit.pageHead(
			localize('voltGitPage.title', "Git & PRs"),
			localize('voltGitPage.lead', "Where pull requests open, how Volt marks the commits and pull requests it makes, what its branches are called, and the code hosts it works with."),
		);

		kit.sectionLabel(localize('voltGitPage.pullRequests', "Pull Requests"));
		const prs = kit.settingsGroup();
		const destinations = [
			{ id: 'volt', text: localize('voltGitPage.insideVolt', "Inside Volt") },
			{ id: 'browser', text: localize('voltGitPage.defaultBrowser', "Default Browser") },
		];
		const destination = readLinkDestination(this.configurationService.getValue(AGENT_PR_LINK_DESTINATION_SETTING));
		const destinationTitle = localize('voltGitPage.linkDestination', "PR Link Destination");
		kit.settingRow(prs, destinationTitle,
			localize('voltGitPage.linkDestinationDesc', "Open pull request links in Volt's pull request view or in the default browser"),
			host => kit.select(host, destinations.map(option => option.text), destinations.findIndex(option => option.id === destination), destinationTitle,
				index => this.update(AGENT_PR_LINK_DESTINATION_SETTING, destinations[index].id)));

		const reviewLabels: Record<AutoReviewMode, string> = {
			off: localize('voltGitPage.reviewOff', "Off"),
			mine: localize('voltGitPage.reviewMine', "My Pull Requests"),
			all: localize('voltGitPage.reviewAll', "All Linked"),
		};
		const review = this.configurationService.getValue<AutoReviewMode>(AGENT_PR_AUTO_REVIEW_SETTING);
		const reviewTitle = localize('voltGitPage.autoReview', "Automatic Review");
		kit.settingRow(prs, reviewTitle,
			localize('voltGitPage.autoReviewDesc', "Review pull requests in their own worktree when their head changes, and list the findings in the pull request's Review section"),
			host => kit.select(host, AUTO_REVIEW_MODES.map(mode => reviewLabels[mode]), Math.max(0, AUTO_REVIEW_MODES.indexOf(review)), reviewTitle,
				index => this.update(AGENT_PR_AUTO_REVIEW_SETTING, AUTO_REVIEW_MODES[index])));
		this.switchRow(prs, AGENT_PR_POST_REVIEW_COMMENTS_SETTING,
			localize('voltGitPage.postComments', "Post Review Comments"),
			localize('voltGitPage.postCommentsDesc', "Offer to post a review's open findings to the pull request as one review with a comment on each line"));

		kit.sectionLabel(localize('voltGitPage.attribution', "Attribution"));
		const attribution = kit.settingsGroup();
		this.switchRow(attribution, AGENT_COMMIT_ATTRIBUTION_SETTING,
			localize('voltGitPage.commitAttribution', "Commit Attribution"),
			localize('voltGitPage.commitAttributionDesc', "Mark commits Volt writes with a 'Made-with: Volt' trailer"));
		this.switchRow(attribution, AGENT_PR_ATTRIBUTION_SETTING,
			localize('voltGitPage.prAttribution', "PR Attribution"),
			localize('voltGitPage.prAttributionDesc', "Mark pull requests Volt opens as made with Volt"));

		kit.sectionLabel(localize('voltGitPage.branches', "Branches"));
		const branches = kit.settingsGroup();
		const prefixTitle = localize('voltGitPage.branchPrefix', "Branch Prefix");
		const prefix = this.configurationService.getValue(AGENT_BRANCH_PREFIX_SETTING);
		kit.settingRow(branches, prefixTitle,
			localize('voltGitPage.branchPrefixDesc', "Prefix for new branches Volt names for agents (e.g., volt/, username/). Empty for none."),
			host => kit.input(host, typeof prefix === 'string' ? prefix : DEFAULT_BRANCH_PREFIX, DEFAULT_BRANCH_PREFIX, prefixTitle, value => {
				const next = readBranchPrefix(value);
				if (next !== prefix) {
					this.update(AGENT_BRANCH_PREFIX_SETTING, next);
				}
			}));

		kit.sectionLabel(localize('voltGitPage.integrations', "Integrations"));
		kit.sectionHint(localize('voltGitPage.integrationsHint', "Code hosts Volt reads, reviews and opens pull requests on. GitHub signs in through the GitHub CLI; the others with an access token Volt keeps in the system keychain. Self-hosted servers are recognized by their address, or named in the volt.sourceControl.hosts setting."));
		this.renderHosts(append(kit.settingsGroup(), $('.volt-git-hosts')));
	}

	/** Every supported host with the accounts Volt can use there; painted again when they change. */
	private renderHosts(list: HTMLElement): void {
		const store = this.kit.store;
		let disposed = false;
		let generation = 0;
		store.add(toDisposable(() => disposed = true));
		const paint = async () => {
			const mine = ++generation;
			const [accounts, gh] = await Promise.all([
				this.pullRequests.api.accounts().catch(() => [] as IVoltPrAccount[]),
				this.stdio.which('gh').catch(() => undefined),
			]);
			if (disposed || mine !== generation || !this.kit.isCurrent()) {
				return;
			}
			clearNode(list);
			for (const provider of VOLT_PR_PROVIDERS) {
				this.paintHost(list, provider, this.accountsFor(provider, accounts), !!gh, () => void paint());
			}
		};
		store.add(this.pullRequests.api.onDidChangeAccounts(() => void paint()));
		void paint();
	}

	private accountsFor(provider: VoltPrSupportedProvider, accounts: readonly IVoltPrAccount[]): IHostAccount[] {
		// GitHub CLI accounts carry no provider.
		const found: IHostAccount[] = accounts.filter(account => (account.provider ?? 'github') === provider);
		if (provider !== 'github') {
			for (const credential of this.pullRequests.signedInHosts()) {
				if (credential.provider === provider && !found.some(account => account.host === credential.host)) {
					found.push({ host: credential.host, login: credential.login, source: 'volt', ok: true });
				}
			}
		}
		return found;
	}

	private paintHost(list: HTMLElement, provider: VoltPrSupportedProvider, accounts: readonly IHostAccount[], ghInstalled: boolean, refresh: () => void): void {
		const store = this.kit.store;
		const row = append(list, $('.volt-git-host'));
		append(row, $('.volt-git-host-icon')).appendChild(renderIcon(HOST_ICONS[provider]));
		const copy = append(row, $('.volt-git-host-copy'));
		const name = append(copy, $('.volt-git-host-name'));
		append(name, $('span')).textContent = provider === 'gitea' ? localize('voltGitPage.giteaForgejo', "Gitea & Forgejo") : hostProductLabel(provider);
		const connected = accounts.some(account => account.ok);
		append(name, $(`span.volt-git-host-status${connected ? '.on' : ''}`)).textContent = connected
			? localize('voltGitPage.connected', "Connected")
			: localize('voltGitPage.notConnected', "Not connected");
		const actions = append(row, $('.volt-git-host-actions'));
		const button = (label: string, kind: 'primary' | 'secondary', onClick: (b: Button) => void) => {
			const b = store.add(createVoltButton(actions, kind));
			b.label = label;
			store.add(b.onDidClick(() => onClick(b)));
		};

		if (!accounts.length) {
			append(copy, $('.volt-git-host-desc')).textContent = provider === 'github'
				? ghInstalled
					? localize('voltGitPage.githubSignedOut', "Sign in with the GitHub CLI to see, review and open pull requests on GitHub and GitHub Enterprise.")
					: localize('voltGitPage.githubNoCli', "Volt works with GitHub through the GitHub CLI (gh). Install it, then sign in.")
				: localize('voltGitPage.tokenSignedOut', "Connect with an access token to work with pull requests on {0}.", hostProductLabel(provider));
		}
		for (const account of accounts) {
			const line = append(copy, $('.volt-git-host-account'));
			const who = account.login ? localize('voltGitPage.accountOn', "{0} on {1}", account.login, account.host) : account.host;
			append(line, $('span')).textContent = `${who} · ${sourceLabel(account.source, provider)}`;
			if (!account.ok) {
				append(line, $('span.volt-git-host-warn')).textContent = localize('voltGitPage.signInAgain', "sign in again");
			}
			if (account.source === 'volt') {
				const remove = append(line, $('a.volt-git-host-link')) as HTMLAnchorElement;
				remove.textContent = localize('voltGitPage.disconnect', "Disconnect");
				remove.tabIndex = 0;
				remove.role = 'button';
				const disconnect = () => void this.pullRequests.signOutHost(account.host).finally(refresh);
				remove.addEventListener('click', disconnect);
				remove.addEventListener('keydown', e => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						disconnect();
					}
				});
			}
		}

		if (provider === 'github') {
			if (!ghInstalled) {
				button(localize('voltGitPage.installGh', "Get the GitHub CLI"), 'secondary', () => void this.openerService.open('https://cli.github.com/', { openExternal: true }));
			} else if (!connected) {
				// gh signs in in a terminal; nothing tells Volt when it is done, so the button asks again.
				let started = false;
				button(localize('voltGitPage.signIn', "Sign In"), 'secondary', b => {
					if (started) {
						b.enabled = false;
						void this.pullRequests.api.refreshAccounts().finally(refresh);
						return;
					}
					started = true;
					void this.instantiationService.invokeFunction(accessor => signInWithGh(accessor, 'github.com'));
					b.label = localize('voltGitPage.checkAgain', "Check Again");
				});
			}
			return;
		}
		button(accounts.length ? localize('voltGitPage.addServer', "Add Server") : localize('voltGitPage.connect', "Connect"), 'secondary', b => {
			b.enabled = false;
			void this.commandService.executeCommand<boolean>(SIGN_IN_HOST_COMMAND_ID, provider).finally(() => {
				b.enabled = true;
				refresh();
			});
		});
	}
}
