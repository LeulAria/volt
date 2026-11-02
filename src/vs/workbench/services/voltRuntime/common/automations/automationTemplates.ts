/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AutomationSchedule, AutomationToolKind } from './automations.js';
import { AutomationProvider } from './automationTriggers.js';

/**
 * Starting points on the Automations page. Each opens as an unsaved automation with its triggers,
 * tools and instructions filled in. The instructions keep a MEMORIES.md across runs, so a daily
 * job does not report the same finding every day.
 */

export type AutomationTemplateCategory = 'popular' | 'review' | 'security' | 'incidents' | 'monitoring' | 'release' | 'research' | 'environment';

export const AUTOMATION_TEMPLATE_CATEGORIES: readonly { readonly id: AutomationTemplateCategory; readonly label: string }[] = [
	{ id: 'popular', label: 'Popular' },
	{ id: 'review', label: 'Code Review' },
	{ id: 'security', label: 'Security' },
	{ id: 'incidents', label: 'Incidents & Triage' },
	{ id: 'monitoring', label: 'Monitoring' },
	{ id: 'release', label: 'Releases' },
	{ id: 'research', label: 'Data & Research' },
	{ id: 'environment', label: 'Environment' },
];

export type AutomationTemplateIcon = 'bug' | 'search' | 'book' | 'check' | 'review' | 'shield' | 'key' | 'pulse' | 'flame' | 'graph' | 'chat' | 'package' | 'broom' | 'beaker' | 'rocket' | 'git';

export interface IAutomationTemplateTrigger {
	readonly provider: AutomationProvider;
	readonly event: string;
	readonly schedule?: AutomationSchedule;
}

export interface IAutomationTemplate {
	readonly id: string;
	readonly categories: readonly AutomationTemplateCategory[];
	readonly title: string;
	readonly description: string;
	readonly icon: AutomationTemplateIcon;
	readonly triggers: readonly IAutomationTemplateTrigger[];
	/** Besides Memories, which every template has. */
	readonly tools: readonly AutomationToolKind[];
	readonly instructions: string;
}

const DAILY_15: IAutomationTemplateTrigger = { provider: 'schedule', event: 'daily', schedule: { type: 'daily', time: '15:00' } };
const DAILY_9: IAutomationTemplateTrigger = { provider: 'schedule', event: 'daily', schedule: { type: 'daily', time: '09:00' } };
const WEEKLY_MON: IAutomationTemplateTrigger = { provider: 'schedule', event: 'weekly', schedule: { type: 'weekly', weekdays: [1], time: '09:00' } };
const WEEKDAYS_9: IAutomationTemplateTrigger = { provider: 'schedule', event: 'weekly', schedule: { type: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '09:00' } };
const EVERY_5_MIN: IAutomationTemplateTrigger = { provider: 'schedule', event: 'minutes', schedule: { type: 'interval', everyMs: 5 * 60_000 } };
const PR_OPENED: IAutomationTemplateTrigger = { provider: 'github', event: 'pr.opened' };

const MEMORY_RULES = `Before doing anything else, read MEMORIES.md from your persistent memory. It tracks what you have already reported across runs, one line each with the location, the PR or issue URL, a status, and the date. Do not investigate or re-report anything that already has an open PR. Drop entries whose PR merged or closed more than 30 days ago.`;

const MEMORY_CLOSE = `If you opened a PR, record it in MEMORIES.md (one line: location and root cause, the PR URL, its status, today's date) before finishing. Apply any pending MEMORIES.md cleanup in the same update.`;

export const AUTOMATION_TEMPLATES: readonly IAutomationTemplate[] = [
	{
		id: 'find-critical-bugs',
		categories: ['popular', 'review'],
		title: 'Find critical bugs',
		description: 'Analyze recent commits for high-severity correctness bugs and submit safe fixes',
		icon: 'bug',
		triggers: [DAILY_15],
		tools: ['slack_send'],
		instructions: `You are a deep bug-finding automation focused on high-severity issues.

${MEMORY_RULES}

## Goal

Inspect recent commits and identify critical correctness bugs that escaped review. Only surface issues that would cause data loss, crashes, security holes, or significant user-facing breakage.

## Investigation strategy

- Focus on behavioral changes with meaningful blast radius.
- Look for: data corruption, race conditions that lose writes, null dereferences in critical paths, auth/permission bypasses, infinite loops or unbounded resource use, broken error handling that hides failures.
- Read the surrounding code and the tests before deciding; confirm the bug with a failing test or a precise trace.

## Rules

- Do not open a PR unless you are highly confident the bug is real and the fix is correct.
- If no critical bug is found, post a short "no critical bugs found" summary. This is the expected outcome most days.

## Output

If fixed, include:
- Bug and impact
- Root cause
- Fix and validation performed

${MEMORY_CLOSE}`,
	},
	{
		id: 'scan-vulnerabilities',
		categories: ['popular', 'security'],
		title: 'Scan codebase for vulnerabilities',
		description: 'Review the full repository on a schedule and alert on validated high-impact security issues',
		icon: 'search',
		triggers: [DAILY_15],
		tools: ['slack_send'],
		instructions: `You are a security review automation. Find exploitable, high-impact vulnerabilities and nothing else.

${MEMORY_RULES}

## Scope

Rotate through the repository across runs (record which areas you covered in MEMORIES.md) so the whole codebase is reviewed over a week.

## Look for

- Injection (SQL, command, template, path traversal), SSRF, unsafe deserialization.
- Broken authentication or authorization: missing ownership checks (IDOR), privilege escalation, tokens that never expire.
- Secrets in code or config, weak crypto, missing signature verification on webhooks.
- Sensitive data written to logs or returned to clients.

## Rules

- Validate each finding: show the vulnerable path from input to sink. No theoretical issues, no style notes.
- Rate each finding (critical / high) with a one-line exploit scenario.
- Fix only when the fix is small and certain; otherwise report it.

## Output

Send a Slack summary only when there is a validated finding; otherwise end with "No validated vulnerabilities." ${MEMORY_CLOSE}`,
	},
	{
		id: 'generate-docs',
		categories: ['popular', 'environment'],
		title: 'Generate docs',
		description: 'Create and update developer documentation for recently changed or under-documented code',
		icon: 'book',
		triggers: [DAILY_15],
		tools: ['slack_send'],
		instructions: `You keep the developer documentation accurate and useful.

${MEMORY_RULES}

## Goal

Find code that changed since the last run (git log) or that has no documentation, and update the docs that describe it: READMEs, module docs, public API comments, setup guides.

## Rules

- Document behavior that exists; never describe planned features.
- Match the style and tone of the existing docs. Prefer short examples over prose.
- Keep one PR per run, titled "docs: …", with a summary of what changed and why.
- Skip trivial changes; if nothing needs documenting, say so and stop.

${MEMORY_CLOSE}`,
	},
	{
		id: 'add-test-coverage',
		categories: ['popular', 'review'],
		title: 'Add test coverage',
		description: 'Review recent changes and add tests for high-risk logic that lacks adequate coverage',
		icon: 'check',
		triggers: [DAILY_15],
		tools: ['slack_send'],
		instructions: `You add tests where missing coverage is most dangerous.

${MEMORY_RULES}

## Goal

Look at code changed recently (git log since the last run) and find high-risk logic with weak or no tests: money and data handling, permissions, parsing, state machines, error paths.

## Rules

- Write focused tests that would fail if the logic broke. Follow the project's existing test style and helpers.
- Run the tests you add and make sure they pass. Never change production code just to make a test pass; if a test exposes a bug, report it instead.
- One PR per run, titled "test: …", explaining which risks the tests now cover.

${MEMORY_CLOSE}`,
	},
	{
		id: 'review-prs',
		categories: ['review'],
		title: 'Review every pull request',
		description: 'Review each new pull request for bugs and risky changes, and comment with findings',
		icon: 'review',
		triggers: [PR_OPENED],
		tools: [],
		instructions: `Review the pull request in the event above.

## How

- Fetch the branch and read the full diff with its context. Run the tests that cover the changed code.
- Look for correctness bugs, missing error handling, security problems, breaking API changes and missing tests.
- Ignore formatting and personal style.

## Output

Post one PR comment with the automation tool (pr_comment): a two-line summary, then findings ordered by severity, each with file:line and a concrete fix. If the PR looks good, say so in one line.`,
	},
	{
		id: 'summarize-prs',
		categories: ['review'],
		title: 'Explain pull requests',
		description: 'Write a reviewer-friendly walkthrough of each pull request when it is opened',
		icon: 'git',
		triggers: [PR_OPENED],
		tools: [],
		instructions: `Write a walkthrough of the pull request in the event above for its reviewers.

- What changed and why, in three sentences.
- The files to read first, in order, with one line each.
- Risky spots a reviewer should look at closely.

Post it as a PR comment (pr_comment). Keep it under 250 words.`,
	},
	{
		id: 'review-dependencies',
		categories: ['review', 'security'],
		title: 'Review dependency updates',
		description: 'Check dependency bump pull requests for breaking changes and known advisories',
		icon: 'package',
		triggers: [PR_OPENED],
		tools: [],
		instructions: `If the pull request in the event above only changes dependencies (lock files, package manifests), review it; otherwise finish with "Not a dependency update."

- Read the changelogs between the old and new versions for breaking changes.
- Check for known advisories affecting the new versions.
- Search the codebase for APIs the update changes or removes.

Post a PR comment (pr_comment) with: safe to merge yes/no, breaking changes that affect this code, and what to test.`,
	},
	{
		id: 'secret-leaks',
		categories: ['security'],
		title: 'Detect leaked secrets',
		description: 'Scan every push for credentials, tokens and private keys before they spread',
		icon: 'key',
		triggers: [{ provider: 'github', event: 'push' }],
		tools: ['slack_send'],
		instructions: `Scan the commits of the push in the event above for secrets: API keys, tokens, private keys, passwords, connection strings.

- Check added lines only. Ignore test fixtures that are obviously fake.
- For each real secret: file, line, commit, the kind of credential, and how to rotate it.

If you find one, send it to Slack at once (without the secret's value) and end with the rotation steps. Otherwise finish with "No secrets found."`,
	},
	{
		id: 'auth-changes',
		categories: ['security'],
		title: 'Audit auth changes',
		description: 'Flag pull requests that touch authentication, permissions or session handling',
		icon: 'shield',
		triggers: [PR_OPENED],
		tools: [],
		instructions: `If the pull request in the event above touches authentication, authorization, sessions, tokens or permission checks, audit it; otherwise finish with "No auth changes."

Look for: missing ownership checks, widened scopes, tokens without expiry, checks moved after the action, error paths that grant access. Comment on the PR (pr_comment) with each risk, its exploit scenario and the fix.`,
	},
	{
		id: 'triage-sentry',
		categories: ['incidents', 'popular'],
		title: 'Triage new Sentry issues',
		description: 'Investigate each new Sentry issue, find the root cause and propose a fix',
		icon: 'flame',
		triggers: [{ provider: 'sentry', event: 'issue.created' }],
		tools: ['slack_send'],
		instructions: `A new Sentry issue arrived (see the event above).

${MEMORY_RULES}

1. Find the code in the stack trace and the change that most likely introduced it (git log, blame).
2. Decide severity from the event count, the users affected and the code path.
3. If the cause is clear and the fix is small and safe, fix it with a regression test and open a PR.
4. Otherwise write down the root cause hypothesis and what to check next.

Send a Slack message with: the issue, severity, root cause, and the PR or next step. ${MEMORY_CLOSE}`,
	},
	{
		id: 'pagerduty-incident',
		categories: ['incidents'],
		title: 'Investigate incidents',
		description: 'When PagerDuty triggers, gather context from recent changes and post a first analysis',
		icon: 'pulse',
		triggers: [{ provider: 'pagerduty', event: 'incident.triggered' }],
		tools: ['slack_send'],
		instructions: `A PagerDuty incident was triggered (see the event above). Give the on-call engineer a head start.

- List the deploys and merges of the last 24 hours that touch the affected service.
- Look for errors, config changes and dependency updates that match the symptoms.
- Rank the three most likely causes with evidence, and the fastest safe mitigation (rollback, flag, config).

Send it to Slack within the first minutes. Do not change production or merge anything.`,
	},
	{
		id: 'fix-ci',
		categories: ['incidents', 'environment'],
		title: 'Fix failing CI',
		description: 'When a workflow run fails, find the cause and open a fix',
		icon: 'rocket',
		triggers: [{ provider: 'github', event: 'workflow.failure' }],
		tools: [],
		instructions: `A GitHub Actions workflow failed (see the event above).

1. Read the failing job's logs and reproduce the failure locally where you can.
2. Decide whether it is a real bug, a flaky test or an infrastructure problem.
3. Real bug or flaky test: fix it on a branch and open a PR that explains the cause.
4. Infrastructure: report what failed and who should look at it.

Never disable or skip a test to make CI pass.`,
	},
	{
		id: 'triage-linear',
		categories: ['incidents'],
		title: 'Triage new Linear issues',
		description: 'Add context, likely code locations and a size estimate to each new Linear issue',
		icon: 'chat',
		triggers: [{ provider: 'linear', event: 'issue.created' }],
		tools: [],
		instructions: `A Linear issue was created (see the event above). Prepare it for whoever picks it up:

- Restate the problem in one sentence and list missing information.
- Find the code areas involved (files and functions) and related past changes.
- Estimate the size (S/M/L) and note risks.

End with that triage note so it can be posted on the issue.`,
	},
	{
		id: 'weekly-digest',
		categories: ['research'],
		title: 'Weekly engineering digest',
		description: 'Summarize the week\'s merged work, open risks and stale pull requests',
		icon: 'graph',
		triggers: [WEEKLY_MON],
		tools: ['slack_send'],
		instructions: `Write the weekly engineering digest for the repository.

- Merged this week: grouped by area, one line each with the PR link.
- Still open and older than 7 days: who is waiting on whom.
- Risks: large changes without tests, reverted work, recurring CI failures.

Send it to Slack. Keep it under 300 words.`,
	},
	{
		id: 'slack-summary',
		categories: ['research'],
		title: 'Summarize a Slack channel',
		description: 'Read a channel every morning and post the decisions, questions and action items',
		icon: 'chat',
		triggers: [DAILY_9],
		tools: ['slack_read', 'slack_send'],
		instructions: `Read the last 24 hours of the Slack channel (slack_read) and post a summary (slack_send):

- Decisions made
- Open questions, with who asked
- Action items, with owners

Skip small talk. If nothing happened, post nothing and finish with "Quiet day."`,
	},
	{
		id: 'perf-regressions',
		categories: ['research'],
		title: 'Track performance regressions',
		description: 'Run the benchmarks daily and report changes beyond the noise',
		icon: 'beaker',
		triggers: [DAILY_9],
		tools: ['slack_send'],
		instructions: `Run the project's benchmarks (find them in the repository) and compare with the results recorded in MEMORIES.md.

- Report any change beyond 5% with the commits in between that most likely caused it.
- Record today's numbers in MEMORIES.md (keep the last 14 days).

Send a Slack message only when something regressed.`,
	},
	{
		id: 'update-dependencies',
		categories: ['environment'],
		title: 'Keep dependencies up to date',
		description: 'Upgrade outdated dependencies weekly, run the tests and open a pull request',
		icon: 'package',
		triggers: [WEEKLY_MON],
		tools: [],
		instructions: `Upgrade outdated dependencies in small, safe steps.

- Patch and minor versions together; each major version in its own PR.
- Read changelogs for breaking changes and update the code that needs it.
- Run the full test suite; open a PR only when it passes, listing every upgrade.

${MEMORY_CLOSE}`,
	},
	{
		id: 'stale-branches',
		categories: ['environment'],
		title: 'Clean up stale branches',
		description: 'Find merged and abandoned branches and pull requests, and report what can go',
		icon: 'broom',
		triggers: [WEEKLY_MON],
		tools: ['slack_send'],
		instructions: `List branches and pull requests that look abandoned:

- Branches already merged into the default branch.
- Branches with no commits in 30 days and no open PR.
- Draft PRs untouched for 30 days.

Do not delete anything. Send the list to Slack with the last author of each.`,
	},
	{
		id: 'flaky-tests',
		categories: ['environment'],
		title: 'Fix flaky tests',
		description: 'Find tests that fail intermittently in CI and make them deterministic',
		icon: 'beaker',
		triggers: [DAILY_9],
		tools: [],
		instructions: `Find flaky tests: tests that failed and then passed on a re-run in recent CI runs.

- Pick the most frequent one not already in MEMORIES.md.
- Find why it is non-deterministic (timing, order, shared state, network) and fix the cause, not the symptom.
- Open a PR that explains the cause. ${MEMORY_CLOSE}`,
	},
	{
		id: 'uptime-check',
		categories: ['popular', 'monitoring'],
		title: 'Check uptime every 5 minutes',
		description: 'Ping your health endpoints and alert only when one goes down or comes back',
		icon: 'pulse',
		triggers: [EVERY_5_MIN],
		tools: ['slack_send'],
		instructions: `You watch the service's health endpoints. Be fast: this runs every 5 minutes.

1. Read MEMORIES.md. It lists the URLs to check (one per line, "URL expected-status") and each one's last state. If it has no URLs yet, look for health or status routes in the repository, write the ones you find to MEMORIES.md, and stop.
2. Request each URL with curl (10 second timeout). Note the status code and the response time.
3. Compare with the last state:
	- Up → down (wrong status, timeout, or slower than 5 seconds twice in a row): send a Slack alert with the URL, what failed and since when.
	- Down → up: send one "recovered" message with how long it was down.
	- No change: send nothing.
4. Write each URL's state and the time to MEMORIES.md.

Finish with one line per URL. Never change code from this automation.`,
	},
	{
		id: 'main-ci-watch',
		categories: ['monitoring', 'environment'],
		title: 'Watch CI on main during work hours',
		description: 'Every 15 minutes on weekdays, check the default branch and flag a red build at once',
		icon: 'rocket',
		triggers: [{ provider: 'schedule', event: 'cron', schedule: { type: 'cron', expr: '*/15 9-17 * * 1-5' } }],
		tools: ['slack_send'],
		instructions: `Check the latest CI runs on the default branch (gh run list --branch <default> --limit 5).

- If the newest finished run failed and MEMORIES.md does not already record that run id, find the failing job and the commit that broke it (gh run view --log-failed), and send a Slack message: the workflow, the commit and its author, the first error line, and the run URL.
- Record the run id in MEMORIES.md so the same failure is reported once.
- When main turns green again after a failure, send a one-line "main is green again".

Stay silent otherwise. Do not push fixes from this automation.`,
	},
	{
		id: 'nightly-build-health',
		categories: ['monitoring'],
		title: 'Nightly build health',
		description: 'Build and test the whole project every night and report what broke since yesterday',
		icon: 'check',
		triggers: [{ provider: 'schedule', event: 'cron', schedule: { type: 'cron', expr: '0 2 * * *' } }],
		tools: ['slack_send'],
		instructions: `Run the project's full build and test suite from a clean checkout of the default branch.

${MEMORY_RULES}

- Compare with last night's result in MEMORIES.md: list new failures, fixed tests, and a build time change beyond 20%.
- For each new failure, name the most likely commit since yesterday (git log, blame on the failing code).
- Record tonight's result (passed/failed counts, build time, failing test names) in MEMORIES.md, keeping 14 nights.

Send a Slack summary only when something changed; otherwise finish with "Nightly build unchanged."`,
	},
	{
		id: 'standup-digest',
		categories: ['popular', 'research'],
		title: 'Daily standup digest',
		description: 'Every weekday morning, summarize yesterday\'s merges, reviews waiting and red builds',
		icon: 'chat',
		triggers: [WEEKDAYS_9],
		tools: ['slack_send'],
		instructions: `Write the team's standup digest for the repository, covering the last working day.

- Shipped: pull requests merged, one line each with the author and link.
- Waiting: open pull requests with no review for more than a day, and who is requested.
- Broken: failing CI on the default branch, and flaky tests seen in more than one run.
- Today: issues or pull requests labeled urgent or blocking.

Send it to Slack in under 200 words. Skip empty sections.`,
	},
	{
		id: 'stale-pr-nudge',
		categories: ['review'],
		title: 'Nudge stale pull requests',
		description: 'Find pull requests waiting on review or on their author, and ask the right person',
		icon: 'review',
		triggers: [{ provider: 'schedule', event: 'weekly', schedule: { type: 'weekly', weekdays: [2, 4], time: '10:00' } }],
		tools: ['slack_send'],
		instructions: `List open pull requests with no activity for 3 days or more (gh pr list).

${MEMORY_RULES}

For each one, decide who it is waiting on:
- No review yet, or changes were pushed after the last review: the requested reviewers.
- Changes requested and not addressed: the author.
- Approved but not merged: the author (or say what blocks the merge: checks, conflicts).

Post one comment per pull request (gh pr comment) that names that person and what is needed, unless MEMORIES.md shows you already nudged it this week. Send a Slack summary of the list. Record each nudge in MEMORIES.md with the date.`,
	},
	{
		id: 'release-notes',
		categories: ['release', 'popular'],
		title: 'Write release notes on a new tag',
		description: 'When a version tag is pushed, draft release notes from the merged pull requests',
		icon: 'rocket',
		triggers: [{ provider: 'github', event: 'push' }],
		tools: ['slack_send'],
		instructions: `If the push in the event above is not a tag (its ref does not start with refs/tags/), finish with "Not a release tag."

Otherwise, write the release notes for that tag:
1. Find the previous tag (git describe --tags --abbrev=0 <tag>^) and list the pull requests merged between the two.
2. Group them: Features, Fixes, Performance, Breaking changes (with migration steps), Internal (one line in total).
3. Write each entry for users, not for the team: what changed for them, with the PR link.
4. Create or update the GitHub release for the tag with these notes (gh release edit, or gh release create --draft when there is none).

Send a Slack message with the highlights and the release link.`,
	},
	{
		id: 'changelog-on-merge',
		categories: ['release'],
		title: 'Keep the changelog current',
		description: 'Add an entry to CHANGELOG.md for each merged pull request that users would notice',
		icon: 'book',
		triggers: [{ provider: 'github', event: 'pr.merged' }],
		tools: [],
		instructions: `A pull request was merged (see the event above).

- If it changes nothing users would notice (tests, refactors, CI, docs typos), finish with "No changelog entry needed."
- Otherwise add one line under "Unreleased" in CHANGELOG.md, in the section that fits (Added, Changed, Fixed, Removed), in the file's existing style, with the PR number.
- Open a small pull request titled "changelog: #<number>" (or push to an open changelog PR if there is one).`,
	},
	{
		id: 'security-audit-weekly',
		categories: ['security'],
		title: 'Weekly security audit',
		description: 'Every Friday, audit dependencies, secrets, CI permissions and exposed endpoints',
		icon: 'shield',
		triggers: [{ provider: 'schedule', event: 'weekly', schedule: { type: 'weekly', weekdays: [5], time: '16:00' } }],
		tools: ['slack_send'],
		instructions: `Run a weekly security audit of the repository.

${MEMORY_RULES}

Check:
- Dependencies: run the ecosystem's audit (npm audit, pip-audit, cargo audit, govulncheck…) and keep high and critical advisories that reach code we use.
- Secrets: committed keys or tokens in this week's commits (git log --since="1 week ago" -p).
- CI: workflows with write-all permissions, pull_request_target on untrusted code, unpinned third-party actions.
- Endpoints: new routes this week without authentication or input validation.

Fix only what is small and certain, in one PR. Send a Slack report ranked by severity, or "No new security findings this week." ${MEMORY_CLOSE}`,
	},
	{
		id: 'license-check',
		categories: ['security', 'review'],
		title: 'Check licenses of new dependencies',
		description: 'Flag pull requests that add dependencies with incompatible or unknown licenses',
		icon: 'package',
		triggers: [PR_OPENED],
		tools: [],
		instructions: `If the pull request in the event above adds no dependency (manifests and lock files unchanged), finish with "No new dependencies."

For each added dependency (direct and new transitive ones), find its license. Flag copyleft licenses (GPL, AGPL, LGPL for static linking), missing or unknown licenses, and licenses the repository's LICENSE or policy files forbid.

Comment on the PR (pr_comment) with a table: package, version, license, OK or why not. Keep it short when everything is fine.`,
	},
	{
		id: 'docs-drift',
		categories: ['environment', 'research'],
		title: 'Catch docs that drifted from the code',
		description: 'Find commands, options and APIs in the docs that no longer match the code',
		icon: 'book',
		triggers: [{ provider: 'schedule', event: 'weekly', schedule: { type: 'weekly', weekdays: [3], time: '11:00' } }],
		tools: [],
		instructions: `Find documentation that no longer matches the code.

${MEMORY_RULES}

- Collect what the docs promise: CLI commands and flags, config keys, environment variables, API routes and function signatures in README files, docs/ and code comments on public APIs.
- Check each one against the code. A renamed flag, a removed option, a changed default or a wrong example is drift.
- Fix the docs (never the code) in one PR titled "docs: fix drift", listing each mismatch and where the truth lives in the code.

If everything matches, finish with "Docs match the code." ${MEMORY_CLOSE}`,
	},
	{
		id: 'incident-postmortem',
		categories: ['incidents'],
		title: 'Draft a postmortem when an incident resolves',
		description: 'Collect the timeline, the cause and the fix into a postmortem draft',
		icon: 'flame',
		triggers: [{ provider: 'pagerduty', event: 'incident.resolved' }],
		tools: ['slack_send'],
		instructions: `A PagerDuty incident was resolved (see the event above). Draft its postmortem.

- Timeline: when it triggered, was acknowledged, escalated and resolved (from the event), plus the deploys and merges around that time (git log, gh run list).
- Impact: the service, the urgency, and how long it lasted.
- Cause: the most likely change or condition, with evidence. Say clearly when it is a hypothesis.
- Follow-ups: concrete actions (a test, an alert, a rollback switch), each with a suggested owner from the code's history.

Write it to docs/postmortems/<date>-<incident>.md on a branch, open a draft PR, and send the link to Slack. Blameless tone throughout.`,
	},
];

export function templatesIn(category: AutomationTemplateCategory): readonly IAutomationTemplate[] {
	return AUTOMATION_TEMPLATES.filter(template => template.categories.includes(category));
}

export function automationTemplate(id: string | undefined): IAutomationTemplate | undefined {
	return id ? AUTOMATION_TEMPLATES.find(template => template.id === id) : undefined;
}
