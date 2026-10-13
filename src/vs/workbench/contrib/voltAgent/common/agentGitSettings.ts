/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/** Where pull request links open: Volt's pull request view, or the default browser. */
export const AGENT_PR_LINK_DESTINATION_SETTING = 'volt.pullRequests.linkDestination';
export type AgentPrLinkDestination = 'volt' | 'browser';

/** Commits Volt writes end with a `Made-with: Volt` trailer. */
export const AGENT_COMMIT_ATTRIBUTION_SETTING = 'volt.git.commitAttribution';
/** Pull requests Volt opens end with a "Made with Volt" line. */
export const AGENT_PR_ATTRIBUTION_SETTING = 'volt.git.pullRequestAttribution';
/** What branches Volt names for agents' work start with. */
export const AGENT_BRANCH_PREFIX_SETTING = 'volt.git.branchPrefix';
export const DEFAULT_BRANCH_PREFIX = 'volt/';

const COMMIT_TRAILER = 'Made-with: Volt';
const PR_FOOTER = 'Made with [Volt](https://volt.leularia.com)';

export function readLinkDestination(value: unknown): AgentPrLinkDestination {
	return value === 'browser' ? 'browser' : 'volt';
}

/**
 * The branch prefix as git takes it: no spaces or characters refs refuse, no empty or dot-led
 * parts, no leading slash or dash, and a `/` after a bare word (`leul` → `leul/`). Empty means
 * branches get no prefix.
 */
export function readBranchPrefix(value: unknown): string {
	if (typeof value !== 'string') {
		return DEFAULT_BRANCH_PREFIX;
	}
	const prefix = value.trim()
		.replace(/[\s~^:?*[\\]+|@\{/g, '-')
		.replace(/\.{2,}/g, '.')
		.replace(/\/{2,}/g, '/')
		.split('/').map(part => part.replace(/^\.+/, '').replace(/\.lock$/i, '-lock')).join('/')
		.replace(/^[-/]+/, '')
		.slice(0, 40);
	return /[a-z0-9]$/i.test(prefix) ? `${prefix}/` : prefix;
}

/** The message with Volt's trailer: in the trailer block when the message ends with one. */
export function withCommitAttribution(message: string): string {
	const text = message.replace(/\s+$/, '');
	if (text.split('\n').some(line => line.trim().toLowerCase() === COMMIT_TRAILER.toLowerCase())) {
		return text;
	}
	const paragraphs = text.split(/\n[ \t]*\n/);
	const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1] : undefined;
	const trailers = !!last && last.split('\n').every(line => /^[A-Za-z0-9-]+: \S/.test(line));
	return `${text}${trailers ? '\n' : '\n\n'}${COMMIT_TRAILER}`;
}

/** The description with a "Made with Volt" line under a rule. */
export function withPullRequestAttribution(body: string): string {
	const text = body.replace(/\s+$/, '');
	if (text.includes(PR_FOOTER)) {
		return text;
	}
	return text ? `${text}\n\n---\n${PR_FOOTER}` : PR_FOOTER;
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.git',
	title: localize('voltGit.configTitle', "Git & Pull Requests"),
	type: 'object',
	properties: {
		[AGENT_PR_LINK_DESTINATION_SETTING]: {
			type: 'string',
			enum: ['volt', 'browser'],
			enumDescriptions: [
				localize('voltGit.linkDestination.volt', "Open pull request links in Volt's pull request view."),
				localize('voltGit.linkDestination.browser', "Open pull request links in the default browser."),
			],
			default: 'volt',
			description: localize('voltGit.linkDestination', "Where pull request links (in chats, terminals and editors) open."),
		},
		[AGENT_COMMIT_ATTRIBUTION_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltGit.commitAttribution', "Ends the commits Volt writes (Commit, Commit & Push, Create PR) with a 'Made-with: Volt' trailer."),
		},
		[AGENT_PR_ATTRIBUTION_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltGit.prAttribution', "Ends the description of pull requests Volt opens with a 'Made with Volt' line."),
		},
		[AGENT_BRANCH_PREFIX_SETTING]: {
			type: 'string',
			default: DEFAULT_BRANCH_PREFIX,
			description: localize('voltGit.branchPrefix', "What the branches Volt names for agents' work start with: feature branches from Commit and Create PR, delegated tasks' worktrees and stacked branches. Empty for none."),
		},
	},
});
