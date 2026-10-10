/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWebhookContext, resolveWebhookPath, truncateLines, WebhookSignatureKind } from './automationWebhooks.js';

/**
 * What can start an automation: the clock, or an event from a service that posts webhooks. Each
 * event trigger has its own secret URL (and signing secret), so a delivery already names its
 * trigger; the matcher here only decides whether the event is the one the trigger listens for
 * (a pull request that was merged, not just closed). Everything is pure.
 */

export type AutomationProvider = 'schedule' | 'github' | 'slack' | 'teams' | 'sentry' | 'linear' | 'webhook' | 'pagerduty';

/** The trigger menu order (Add Trigger). */
export const AUTOMATION_PROVIDERS: readonly AutomationProvider[] = ['schedule', 'github', 'slack', 'teams', 'sentry', 'linear', 'webhook', 'pagerduty'];

/** Run history groups GitHub and GitLab as "Git". The filter menu order. */
export type AutomationTriggerGroup = 'git' | 'slack' | 'teams' | 'linear' | 'schedule' | 'pagerduty' | 'sentry' | 'webhook' | 'manual';
export const AUTOMATION_TRIGGER_GROUPS: readonly Exclude<AutomationTriggerGroup, 'manual'>[] = ['git', 'slack', 'teams', 'linear', 'schedule', 'pagerduty', 'sentry', 'webhook'];

export function triggerGroupOf(provider: AutomationProvider | 'manual'): AutomationTriggerGroup {
	return provider === 'github' ? 'git' : provider;
}

export function providerLabel(provider: AutomationProvider): string {
	switch (provider) {
		case 'schedule': return 'Scheduled';
		case 'github': return 'GitHub';
		case 'slack': return 'Slack';
		case 'teams': return 'Microsoft Teams';
		case 'sentry': return 'Sentry';
		case 'linear': return 'Linear';
		case 'webhook': return 'Webhook Triggered';
		case 'pagerduty': return 'PagerDuty';
	}
}

export function triggerGroupLabel(group: AutomationTriggerGroup): string {
	switch (group) {
		case 'git': return 'Git';
		case 'schedule': return 'Scheduled';
		case 'webhook': return 'Webhook';
		case 'manual': return 'Manual';
		default: return providerLabel(group);
	}
}

/** The signing scheme a provider uses, preset on its trigger. */
export function providerSignature(provider: AutomationProvider): WebhookSignatureKind {
	switch (provider) {
		case 'github': return 'github';
		case 'slack': return 'slack';
		case 'sentry': return 'sentry';
		case 'linear': return 'linear';
		case 'pagerduty': return 'pagerduty';
		case 'teams': return 'teams';
		default: return 'none';
	}
}

//#region Event catalog

/** A row of the trigger menu: an event, or a group that opens a flyout ("Pull request…"). */
export interface IAutomationEventNode {
	readonly label: string;
	/** Set on leaves. */
	readonly event?: string;
	readonly children?: readonly IAutomationEventNode[];
	/** A muted section header above this row and the ones after it ("GitHub Only"). */
	readonly section?: string;
	/** Text the trigger takes to narrow it: a branch, a channel, a label. */
	readonly option?: { readonly placeholder: string; readonly label: string };
}

const BRANCH = { label: 'Branch', placeholder: 'main (empty: any branch)' };
const CHANNEL = { label: 'Channel', placeholder: '#alerts or C0123 (empty: any channel)' };

export const SCHEDULE_EVENTS = ['hourly', 'daily', 'weekly', 'cron'] as const;
export type AutomationScheduleKind = typeof SCHEDULE_EVENTS[number];

export const AUTOMATION_EVENTS: Readonly<Record<AutomationProvider, readonly IAutomationEventNode[]>> = {
	schedule: [
		{ label: 'Hourly', event: 'hourly' },
		{ label: 'Daily', event: 'daily' },
		{ label: 'Weekly', event: 'weekly' },
		{ label: 'Custom (cron)', event: 'cron' },
	],
	github: [
		{ label: 'Draft opened', event: 'draft_opened' },
		{
			label: 'Pull request…', children: [
				{ label: 'Opened', event: 'pr.opened' },
				{ label: 'Pushed', event: 'pr.pushed' },
				{ label: 'Merged', event: 'pr.merged' },
			],
		},
		{ label: 'Comment added', event: 'comment_added' },
		{ label: 'New push to branch', event: 'push', option: BRANCH },
		{ label: 'Label change', event: 'label_changed', section: 'GitHub Only', option: { label: 'Label', placeholder: 'bug (empty: any label)' } },
		{ label: 'Checks completed', event: 'checks_completed' },
		{ label: 'Issue comment', event: 'issue_comment' },
		{ label: 'PR review comment', event: 'pr_review_comment' },
		{
			label: 'PR review submitted…', children: [
				{ label: 'Approved', event: 'review.approved' },
				{ label: 'Changes requested', event: 'review.changes_requested' },
				{ label: 'Commented', event: 'review.commented' },
			],
		},
		{
			label: 'Review thread…', children: [
				{ label: 'Resolved', event: 'thread.resolved' },
				{ label: 'Unresolved', event: 'thread.unresolved' },
			],
		},
		{
			label: 'Workflow run completed…', children: [
				{ label: 'Succeeded', event: 'workflow.success' },
				{ label: 'Failed', event: 'workflow.failure' },
				{ label: 'Any conclusion', event: 'workflow.any' },
			],
		},
	],
	slack: [
		{ label: 'New message in channel', event: 'message', option: CHANNEL },
		{ label: 'Reaction added to message', event: 'reaction', option: { label: 'Emoji', placeholder: 'eyes (empty: any reaction)' } },
		{ label: 'Channel created', event: 'channel_created' },
	],
	teams: [
		{ label: 'New message in channel', event: 'message', option: CHANNEL },
		{ label: 'Bot mentioned', event: 'mention' },
		{ label: 'Channel created', event: 'channel_created' },
	],
	sentry: [
		{
			label: 'Issue…', children: [
				{ label: 'Created', event: 'issue.created' },
				{ label: 'Resolved', event: 'issue.resolved' },
				{ label: 'Assigned', event: 'issue.assigned' },
				{ label: 'Archived', event: 'issue.archived' },
				{ label: 'Unresolved', event: 'issue.unresolved' },
			],
		},
		{ label: 'Any issue event', event: 'issue.any' },
	],
	linear: [
		{
			label: 'Issue…', children: [
				{ label: 'Created', event: 'issue.created' },
				{ label: 'Status changed', event: 'issue.status_changed' },
			],
		},
		{ label: 'End of cycle', event: 'cycle.ended' },
	],
	webhook: [],
	pagerduty: [
		{
			label: 'Incident…', children: [
				{ label: 'Triggered', event: 'incident.triggered' },
				{ label: 'Acknowledged', event: 'incident.acknowledged' },
				{ label: 'Resolved', event: 'incident.resolved' },
				{ label: 'Escalated', event: 'incident.escalated' },
				{ label: 'Reassigned', event: 'incident.reassigned' },
			],
		},
		{ label: 'Any incident event', event: 'incident.any' },
	],
};

function findNode(nodes: readonly IAutomationEventNode[], event: string, parent?: IAutomationEventNode): { node: IAutomationEventNode; parent?: IAutomationEventNode } | undefined {
	for (const node of nodes) {
		if (node.event === event) {
			return { node, parent };
		}
		const inner = node.children ? findNode(node.children, event, node) : undefined;
		if (inner) {
			return inner;
		}
	}
	return undefined;
}

export function eventOption(provider: AutomationProvider, event: string): IAutomationEventNode['option'] {
	return findNode(AUTOMATION_EVENTS[provider], event)?.node.option;
}

/** "Pull request opened", "Sentry issue created", "New message in channel". */
export function eventLabel(provider: AutomationProvider, event: string): string {
	if (provider === 'webhook') {
		return 'Any request';
	}
	const found = findNode(AUTOMATION_EVENTS[provider], event);
	if (!found) {
		return event;
	}
	if (!found.parent) {
		return found.node.label;
	}
	const group = found.parent.label.replace(/\u2026$/, '');
	return `${group} ${found.node.label.toLowerCase()}`;
}

//#endregion

//#region Matching

export interface IEventMatch {
	readonly match: boolean;
	/** Why not, for the deliveries list ("pull_request closed without merge"). */
	readonly reason?: string;
	/** A delivery the sender only uses to test the URL (GitHub ping, Slack url_verification). */
	readonly ping?: boolean;
}

const YES: IEventMatch = { match: true };

function get(context: IWebhookContext, path: string): unknown {
	return resolveWebhookPath(context, path);
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
}

function no(reason: string): IEventMatch {
	return { match: false, reason };
}

function optionMatches(want: string | undefined, ...values: (string | undefined)[]): boolean {
	const wanted = (want ?? '').trim().replace(/^#/, '').toLowerCase();
	if (!wanted) {
		return true;
	}
	return values.some(value => !!value && value.replace(/^refs\/heads\//, '').replace(/^#/, '').toLowerCase() === wanted);
}

/**
 * Whether a delivery is the event the trigger waits for. `option` narrows it (branch, channel,
 * label, emoji). Unknown shapes from a generic sender pass only the `webhook` provider.
 */
export function matchAutomationEvent(provider: AutomationProvider, event: string, option: string | undefined, context: IWebhookContext): IEventMatch {
	switch (provider) {
		case 'schedule': return no('A scheduled trigger has no webhook.');
		case 'webhook': return YES;
		case 'github': return matchGit(event, option, context);
		case 'slack': return matchSlack(event, option, context);
		case 'teams': return matchTeams(event, option, context);
		case 'sentry': return matchSentry(event, context);
		case 'linear': return matchLinear(event, context);
		case 'pagerduty': return matchPagerDuty(event, context);
	}
}

function matchGit(event: string, option: string | undefined, context: IWebhookContext): IEventMatch {
	const gh = context.headers['x-github-event'];
	const gl = context.headers['x-gitlab-event'];
	if (gh === 'ping') {
		return { match: false, ping: true, reason: 'GitHub ping (the URL works).' };
	}
	const action = str(get(context, 'payload.action'));
	const what = gh ? `${gh}${action ? ` ${action}` : ''}` : gl ?? 'an unknown event';
	const draft = get(context, 'payload.pull_request.draft') === true;
	const merged = get(context, 'payload.pull_request.merged') === true;
	const glAction = str(get(context, 'payload.object_attributes.action'));
	const glDraft = get(context, 'payload.object_attributes.draft') === true || get(context, 'payload.object_attributes.work_in_progress') === true;
	const isMr = gl === 'Merge Request Hook';
	const ok = (condition: boolean) => condition ? YES : no(`${what} is not this trigger's event.`);
	switch (event) {
		case 'draft_opened':
			return ok((gh === 'pull_request' && action === 'opened' && draft) || (isMr && glAction === 'open' && glDraft));
		case 'pr.opened':
			return ok((gh === 'pull_request' && ((action === 'opened' && !draft) || action === 'reopened' || action === 'ready_for_review')) || (isMr && (glAction === 'open' || glAction === 'reopen') && !glDraft));
		case 'pr.pushed':
			return ok((gh === 'pull_request' && action === 'synchronize') || (isMr && glAction === 'update' && get(context, 'payload.object_attributes.oldrev') !== undefined));
		case 'pr.merged':
			return ok((gh === 'pull_request' && action === 'closed' && merged) || (isMr && glAction === 'merge'));
		case 'comment_added':
			return ok((gh === 'issue_comment' && action === 'created' && get(context, 'payload.issue.pull_request') !== undefined)
				|| (gh === 'pull_request_review_comment' && action === 'created')
				|| (gl === 'Note Hook' && get(context, 'payload.merge_request') !== undefined));
		case 'push': {
			if (gh !== 'push' && gl !== 'Push Hook') {
				return no(`${what} is not a push.`);
			}
			const ref = str(get(context, 'payload.ref'));
			return optionMatches(option, ref) ? YES : no(`Push to ${ref?.replace(/^refs\/heads\//, '') ?? 'a ref'}, not ${option}.`);
		}
		case 'label_changed': {
			if (!((gh === 'pull_request' || gh === 'issues') && (action === 'labeled' || action === 'unlabeled'))) {
				return no(`${what} is not a label change.`);
			}
			const label = str(get(context, 'payload.label.name'));
			return optionMatches(option, label) ? YES : no(`Label ${label ?? '?'}, not ${option}.`);
		}
		case 'checks_completed':
			return ok(gh === 'check_suite' && action === 'completed');
		case 'issue_comment':
			return ok(gh === 'issue_comment' && action === 'created' && get(context, 'payload.issue.pull_request') === undefined);
		case 'pr_review_comment':
			return ok(gh === 'pull_request_review_comment' && action === 'created');
		case 'review.approved':
		case 'review.changes_requested':
		case 'review.commented':
			return ok(gh === 'pull_request_review' && action === 'submitted' && str(get(context, 'payload.review.state'))?.toLowerCase() === event.slice('review.'.length));
		case 'thread.resolved':
		case 'thread.unresolved':
			return ok(gh === 'pull_request_review_thread' && action === event.slice('thread.'.length));
		case 'workflow.success':
		case 'workflow.failure':
		case 'workflow.any': {
			if (!(gh === 'workflow_run' && action === 'completed')) {
				return no(`${what} is not a finished workflow run.`);
			}
			const conclusion = str(get(context, 'payload.workflow_run.conclusion'));
			return event === 'workflow.any' || conclusion === event.slice('workflow.'.length) ? YES : no(`Workflow concluded ${conclusion ?? '?'}.`);
		}
	}
	return no(`Unknown GitHub trigger ${event}.`);
}

function matchSlack(event: string, option: string | undefined, context: IWebhookContext): IEventMatch {
	const type = str(get(context, 'payload.type'));
	if (type === 'url_verification') {
		return { match: false, ping: true, reason: 'Slack URL verification.' };
	}
	const inner = str(get(context, 'payload.event.type'));
	// Messages from bots (this automation's own Send to Slack among them) never start a run: no loops.
	if (get(context, 'payload.event.bot_id') !== undefined || str(get(context, 'payload.event.subtype')) === 'bot_message') {
		return no('Message from a bot.');
	}
	switch (event) {
		case 'message': {
			if (inner !== 'message' && inner !== 'app_mention') {
				return no(`Slack ${inner ?? type ?? 'event'} is not a message.`);
			}
			const subtype = str(get(context, 'payload.event.subtype'));
			if (subtype && subtype !== 'thread_broadcast' && subtype !== 'file_share') {
				return no(`Message ${subtype}.`);
			}
			const channel = str(get(context, 'payload.event.channel'));
			return optionMatches(option, channel, str(get(context, 'payload.event.channel_name'))) ? YES : no(`Channel ${channel ?? '?'}, not ${option}.`);
		}
		case 'reaction': {
			if (inner !== 'reaction_added') {
				return no(`Slack ${inner ?? 'event'} is not a reaction.`);
			}
			const emoji = str(get(context, 'payload.event.reaction'));
			return optionMatches(option?.replace(/:/g, ''), emoji) ? YES : no(`Reaction :${emoji ?? '?'}:, not ${option}.`);
		}
		case 'channel_created':
			return inner === 'channel_created' ? YES : no(`Slack ${inner ?? 'event'} is not a new channel.`);
	}
	return no(`Unknown Slack trigger ${event}.`);
}

function matchTeams(event: string, option: string | undefined, context: IWebhookContext): IEventMatch {
	const validation = context.query['validationToken'];
	if (validation) {
		return { match: false, ping: true, reason: 'Microsoft Graph validation.' };
	}
	// An outgoing webhook posts the message that @mentioned it; Graph posts change notifications.
	const outgoing = str(get(context, 'payload.type')) === 'message';
	const notifications = get(context, 'payload.value');
	const changes = Array.isArray(notifications) ? notifications as readonly Record<string, unknown>[] : [];
	const resource = changes.map(change => str(change.resource) ?? '').join(' ');
	const created = changes.some(change => change.changeType === 'created');
	switch (event) {
		case 'message': {
			if (!outgoing && !(created && /\/messages/i.test(resource))) {
				return no('Not a new channel message.');
			}
			const channel = str(get(context, 'payload.channelData.channel.id')) ?? str(get(context, 'payload.conversation.id'));
			return optionMatches(option, channel, str(get(context, 'payload.channelData.channel.name'))) ? YES : no(`Channel ${channel ?? '?'}, not ${option}.`);
		}
		case 'mention':
			return outgoing ? YES : no('Not a message that mentions the bot.');
		case 'channel_created':
			return created && /\/channels(?!.*\/messages)/i.test(resource) ? YES : no('Not a new channel.');
	}
	return no(`Unknown Teams trigger ${event}.`);
}

function matchSentry(event: string, context: IWebhookContext): IEventMatch {
	const resource = context.headers['sentry-hook-resource'];
	if (resource === 'installation') {
		return { match: false, ping: true, reason: 'Sentry installation event.' };
	}
	const action = str(get(context, 'payload.action'));
	if (resource && resource !== 'issue') {
		return no(`Sentry ${resource} event.`);
	}
	if (event === 'issue.any') {
		return get(context, 'payload.data.issue') !== undefined || resource === 'issue' ? YES : no('Not a Sentry issue event.');
	}
	return action === event.slice('issue.'.length) ? YES : no(`Sentry issue ${action ?? '?'}.`);
}

function matchLinear(event: string, context: IWebhookContext): IEventMatch {
	const type = str(get(context, 'payload.type'));
	const action = str(get(context, 'payload.action'));
	switch (event) {
		case 'issue.created':
			return type === 'Issue' && action === 'create' ? YES : no(`Linear ${type ?? '?'} ${action ?? ''}.`.trim());
		case 'issue.status_changed':
			return type === 'Issue' && action === 'update' && get(context, 'payload.updatedFrom.stateId') !== undefined ? YES : no('The issue status did not change.');
		case 'cycle.ended': {
			const completed = get(context, 'payload.data.completedAt');
			const before = get(context, 'payload.updatedFrom');
			return type === 'Cycle' && action === 'update' && !!completed && !!before && typeof before === 'object' && 'completedAt' in before ? YES : no('No cycle ended.');
		}
	}
	return no(`Unknown Linear trigger ${event}.`);
}

function matchPagerDuty(event: string, context: IWebhookContext): IEventMatch {
	const type = str(get(context, 'payload.event.event_type')) ?? str(get(context, 'payload.messages[0].event'));
	if (type === 'pagey.ping') {
		return { match: false, ping: true, reason: 'PagerDuty ping.' };
	}
	if (event === 'incident.any') {
		return type?.startsWith('incident.') ? YES : no(`PagerDuty ${type ?? 'event'}.`);
	}
	return type === event ? YES : no(`PagerDuty ${type ?? 'event'}.`);
}

//#endregion

//#region Summaries

/**
 * The few facts of an event an agent needs, one per line ("PR #12 Fix login (feature → main)").
 * Sent instead of the raw payload when the instructions name no fields: a GitHub pull request
 * delivery is ~25 KB of JSON (avatars, URLs of every sub-resource); this is ~300 bytes.
 */
export function summarizeAutomationEvent(provider: AutomationProvider, context: IWebhookContext): readonly string[] {
	const lines: string[] = [];
	const add = (label: string, value: unknown, max = 300) => {
		const text = str(value)?.trim();
		if (text) {
			lines.push(`${label}: ${text.length > max ? `${text.slice(0, max - 1)}…` : text}`);
		}
	};
	switch (provider) {
		case 'github': {
			add('Event', [context.headers['x-github-event'] ?? context.headers['x-gitlab-event'], str(get(context, 'payload.action'))].filter(Boolean).join(' '));
			add('Repository', get(context, 'payload.repository.full_name') ?? get(context, 'payload.project.path_with_namespace'));
			const pr = get(context, 'payload.pull_request') ?? get(context, 'payload.object_attributes');
			if (pr && typeof pr === 'object') {
				add('Pull request', `#${str(get(context, 'payload.pull_request.number') ?? get(context, 'payload.object_attributes.iid')) ?? '?'} ${str(get(context, 'payload.pull_request.title') ?? get(context, 'payload.object_attributes.title')) ?? ''}`);
				add('Branches', [str(get(context, 'payload.pull_request.head.ref') ?? get(context, 'payload.object_attributes.source_branch')), str(get(context, 'payload.pull_request.base.ref') ?? get(context, 'payload.object_attributes.target_branch'))].filter(Boolean).join(' → '));
				add('URL', get(context, 'payload.pull_request.html_url') ?? get(context, 'payload.object_attributes.url'));
				add('Author', get(context, 'payload.pull_request.user.login') ?? get(context, 'payload.user.username'));
			}
			add('Issue', get(context, 'payload.issue.number') !== undefined ? `#${str(get(context, 'payload.issue.number'))} ${str(get(context, 'payload.issue.title')) ?? ''}` : undefined);
			add('Comment', get(context, 'payload.comment.body') ?? get(context, 'payload.object_attributes.note'), 1200);
			add('Comment URL', get(context, 'payload.comment.html_url'));
			add('Review', get(context, 'payload.review.state'));
			add('Review body', get(context, 'payload.review.body'), 1200);
			add('Label', get(context, 'payload.label.name'));
			add('Ref', get(context, 'payload.ref'));
			add('Head commit', get(context, 'payload.head_commit.message') ?? get(context, 'payload.after'), 300);
			add('Compare', get(context, 'payload.compare'));
			add('Workflow', get(context, 'payload.workflow_run.name'));
			add('Conclusion', get(context, 'payload.workflow_run.conclusion') ?? get(context, 'payload.check_suite.conclusion'));
			add('Run URL', get(context, 'payload.workflow_run.html_url'));
			add('Head SHA', get(context, 'payload.workflow_run.head_sha') ?? get(context, 'payload.check_suite.head_sha'));
			add('By', get(context, 'payload.sender.login'));
			break;
		}
		case 'slack':
			add('Event', get(context, 'payload.event.type'));
			add('Channel', get(context, 'payload.event.channel') ?? get(context, 'payload.event.channel.name'));
			add('User', get(context, 'payload.event.user'));
			add('Text', get(context, 'payload.event.text'), 2000);
			add('Reaction', get(context, 'payload.event.reaction'));
			add('Message ts', get(context, 'payload.event.ts') ?? get(context, 'payload.event.item.ts'));
			add('Thread ts', get(context, 'payload.event.thread_ts'));
			break;
		case 'teams':
			add('From', get(context, 'payload.from.name'));
			add('Channel', get(context, 'payload.channelData.channel.name') ?? get(context, 'payload.channelData.channel.id'));
			add('Text', (str(get(context, 'payload.text')) ?? '').replace(/<[^>]+>/g, ''), 2000);
			add('Resource', get(context, 'payload.value[0].resource'));
			break;
		case 'sentry':
			add('Action', get(context, 'payload.action'));
			add('Issue', get(context, 'payload.data.issue.title'));
			add('Culprit', get(context, 'payload.data.issue.culprit'));
			add('Level', get(context, 'payload.data.issue.level'));
			add('Project', get(context, 'payload.data.issue.project.slug'));
			add('Events', get(context, 'payload.data.issue.count'));
			add('First seen', get(context, 'payload.data.issue.firstSeen'));
			add('URL', get(context, 'payload.data.issue.web_url') ?? get(context, 'payload.data.issue.permalink'));
			break;
		case 'linear':
			add('Event', [str(get(context, 'payload.type')), str(get(context, 'payload.action'))].filter(Boolean).join(' '));
			add('Issue', [str(get(context, 'payload.data.identifier')), str(get(context, 'payload.data.title'))].filter(Boolean).join(' '));
			add('State', get(context, 'payload.data.state.name'));
			add('Priority', get(context, 'payload.data.priorityLabel'));
			add('Team', get(context, 'payload.data.team.key'));
			add('Assignee', get(context, 'payload.data.assignee.name'));
			add('Cycle', get(context, 'payload.data.name') ?? get(context, 'payload.data.number'));
			add('Description', get(context, 'payload.data.description'), 1500);
			add('URL', get(context, 'payload.url') ?? get(context, 'payload.data.url'));
			break;
		case 'pagerduty':
			add('Event', get(context, 'payload.event.event_type'));
			add('Incident', get(context, 'payload.event.data.title'));
			add('Number', get(context, 'payload.event.data.number'));
			add('Urgency', get(context, 'payload.event.data.urgency'));
			add('Priority', get(context, 'payload.event.data.priority.summary'));
			add('Service', get(context, 'payload.event.data.service.summary'));
			add('Status', get(context, 'payload.event.data.status'));
			add('URL', get(context, 'payload.event.data.html_url'));
			break;
		case 'webhook':
		case 'schedule':
			break;
	}
	return lines;
}

/** Keys that are never worth an agent's tokens: links to every sub-resource, avatars, node ids. */
const NOISE = /(^|_)(url|urls)$|^_links$|avatar|gravatar|node_id|^id_str$|^etag$|^permissions$/i;
const KEEP_URL = /^(html_url|web_url|permalink|url|compare|diff_url)$/;

/**
 * The payload as compact JSON: noise keys dropped, long strings cut, deep nesting summarized, at
 * most `max` characters. For generic webhooks, whose fields Volt cannot know.
 */
export function compactPayload(payload: unknown, max = 6000): string {
	if (typeof payload === 'string') {
		return payload.length > max ? `${payload.slice(0, max)}\n… (${payload.length - max} more characters)` : payload;
	}
	const prune = (value: unknown, depth: number): unknown => {
		if (Array.isArray(value)) {
			if (depth > 4) {
				return `[${value.length} items]`;
			}
			const kept = value.slice(0, 10).map(item => prune(item, depth + 1));
			return value.length > 10 ? [...kept, `… ${value.length - 10} more`] : kept;
		}
		if (value && typeof value === 'object') {
			if (depth > 4) {
				return '{…}';
			}
			const out: Record<string, unknown> = {};
			for (const [key, inner] of Object.entries(value)) {
				if (inner === null || inner === undefined || (NOISE.test(key) && !KEEP_URL.test(key))) {
					continue;
				}
				out[key] = prune(inner, depth + 1);
			}
			return out;
		}
		if (typeof value === 'string' && value.length > 600) {
			return `${value.slice(0, 600)}…`;
		}
		return value;
	};
	return truncateLines(JSON.stringify(prune(payload, 0), null, 1), max);
}

//#endregion
