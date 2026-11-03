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

export type AutomationTemplateCategory = 'popular' | 'review' | 'security' | 'incidents' | 'research' | 'environment' | 'docs' | 'team' | 'monitoring';

export const AUTOMATION_TEMPLATE_CATEGORIES: readonly { readonly id: AutomationTemplateCategory; readonly label: string }[] = [
	{ id: 'popular', label: 'Popular' },
	{ id: 'review', label: 'Code Review' },
	{ id: 'security', label: 'Security' },
	{ id: 'incidents', label: 'Incidents & Triage' },
	{ id: 'research', label: 'Data & Research' },
	{ id: 'environment', label: 'Environment' },
	{ id: 'docs', label: 'Docs & Release' },
	{ id: 'team', label: 'Team Updates' },
	{ id: 'monitoring', label: 'Monitoring' },
];

export type AutomationTemplateIcon = 'bug' | 'search' | 'book' | 'check' | 'review' | 'shield' | 'key' | 'pulse' | 'flame' | 'graph' | 'chat' | 'package' | 'broom' | 'beaker' | 'rocket' | 'git'
	| 'calendar' | 'megaphone' | 'heart' | 'chart' | 'tag' | 'draft' | 'note' | 'bell' | 'eye' | 'layers' | 'database' | 'merge' | 'law' | 'lock'
	| 'verified' | 'credit' | 'dashboard' | 'api' | 'globe' | 'compass' | 'map' | 'clock' | 'milestone' | 'question' | 'tasklist' | 'trash';

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
const WEEKLY_FRI: IAutomationTemplateTrigger = { provider: 'schedule', event: 'weekly', schedule: { type: 'weekly', weekdays: [5], time: '15:00' } };
const WEEKDAYS_9: IAutomationTemplateTrigger = { provider: 'schedule', event: 'weekly', schedule: { type: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '09:00' } };
const HOURLY: IAutomationTemplateTrigger = { provider: 'schedule', event: 'hourly', schedule: { type: 'hourly', minute: 0 } };
const EVERY_15_MIN: IAutomationTemplateTrigger = { provider: 'schedule', event: 'minutes', schedule: { type: 'interval', everyMs: 15 * 60_000 } };
const PR_OPENED: IAutomationTemplateTrigger = { provider: 'github', event: 'pr.opened' };
const PR_PUSHED: IAutomationTemplateTrigger = { provider: 'github', event: 'pr.pushed' };
const PR_MERGED: IAutomationTemplateTrigger = { provider: 'github', event: 'pr.merged' };

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
		categories: ['popular', 'environment', 'docs'],
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
		categories: ['incidents', 'popular', 'monitoring'],
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
		categories: ['incidents', 'environment', 'popular'],
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
		categories: ['research', 'team'],
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
		categories: ['research', 'team'],
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
		categories: ['research', 'monitoring'],
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
		id: 'daily-standup',
		categories: ['popular', 'team'],
		title: 'Daily standup summary',
		description: 'Post what merged, what is in review and what is blocked to Slack every workday morning',
		icon: 'calendar',
		triggers: [WEEKDAYS_9],
		tools: ['slack_send'],
		instructions: `Write the team's async standup from the repository's activity since the previous workday (on Monday, since Friday morning).

- Shipped: PRs merged into the default branch, grouped by author, one line each with the PR link.
- In review: PRs opened or pushed to, with their state (waiting for review, changes requested, approved).
- Blocked: open PRs with failing checks or merge conflicts, PRs waiting on review for more than a day, reverts.
- Heads-up: migrations, dependency majors, config or infrastructure changes that merged.

Use git log and the GitHub CLI; do not guess from branch names. Skip bot PRs (Dependabot, Renovate) unless they are blocked.

Send it to Slack in under 200 words. If nothing happened, send nothing and finish with "Quiet day."`,
	},
	{
		id: 'release-notes',
		categories: ['popular', 'docs'],
		title: 'Draft release notes',
		description: 'Turn the merged pull requests since the last release into a changelog entry, opened as a PR',
		icon: 'megaphone',
		triggers: [WEEKLY_FRI],
		tools: [],
		instructions: `You write the changelog for the people who use this project, not for the people who built it.

${MEMORY_RULES}

## Goal

Collect the PRs merged since the latest release tag (git describe --tags), or since the newest CHANGELOG.md entry if there are no tags, and draft the next entry.

## Rules

- Group into Breaking changes, Features and Fixes. Leave out internal changes users would not notice.
- One line per change in plain language: what changed for the user, then the PR link. No commit hashes.
- Every breaking change gets a short "How to migrate" note with the before and after.
- Follow the existing CHANGELOG.md format; create the file in Keep a Changelog style if there is none.
- Suggest the next version (semver) from the changes, but never tag, publish or bump versions.

## Output

Update only the changelog and open a PR titled "docs: release notes for vX.Y.Z". If nothing user-facing merged, finish with "Nothing to release." ${MEMORY_CLOSE}`,
	},
	{
		id: 'uptime-check',
		categories: ['monitoring'],
		title: 'Check service health',
		description: 'Ping your health endpoints every 15 minutes and alert Slack when one goes down or recovers',
		icon: 'heart',
		triggers: [EVERY_15_MIN],
		tools: ['slack_send'],
		instructions: `Check that the services below are up. Replace the example URLs with your own before enabling.

## Endpoints

- https://example.com/healthz
- https://api.example.com/health

## How

- Request each URL (curl, 10 second timeout). It is down when the status is not 2xx, the body reports a failing dependency, or it takes longer than 3 seconds.
- Retry a failing URL once after 30 seconds before calling it down, so one slow response does not alert anyone.
- Keep each endpoint's last state, its latency and the time the state changed in MEMORIES.md.

## Output

Send a Slack message only when an endpoint changes state: down (status, latency, the first lines of the response) or recovered (how long it was down). While it stays down, remind once an hour, not every run. Otherwise finish with "All endpoints healthy." Never restart, deploy or change anything.`,
	},
	{
		id: 'error-spike',
		categories: ['monitoring', 'incidents'],
		title: 'Watch for error spikes',
		description: 'Compare each hour of production errors with the usual rate and explain sudden spikes',
		icon: 'chart',
		triggers: [HOURLY],
		tools: ['slack_send'],
		instructions: `Look at the last hour of production errors and decide whether something broke.

## Source

Read the errors with the command or API this project uses (edit this line): for example the Sentry or Datadog CLI, gcloud logging read, kubectl logs, vercel logs, or a log file path.

## How

1. Group the errors by signature (the message without ids and numbers, plus the top stack frame) and count them.
2. Compare with the baseline in MEMORIES.md for the same hour of the day. A spike is more than 3x the baseline and at least 20 errors, or a new signature with 10 or more.
3. For each spike, find the code in the stack trace and the deploys or merges just before it started (git log).
4. Update the baseline in MEMORIES.md: a 7-day hourly average for the 30 most frequent signatures.

## Output

Send a Slack message only for spikes: the signature, the count against the baseline, when it started, the likely commit and a suggested mitigation (rollback, flag, config). Otherwise finish with "Error rate normal."`,
	},
	{
		id: 'a11y-review',
		categories: ['review'],
		title: 'Review accessibility of UI changes',
		description: 'Check pull requests that change the UI for keyboard, screen reader and contrast problems',
		icon: 'eye',
		triggers: [PR_OPENED],
		tools: [],
		instructions: `If the pull request in the event above changes user interface code (components, templates, styles), review its accessibility; otherwise finish with "No UI changes."

Check the changed UI for:
- Clickable elements that are not buttons or links, or cannot be reached and used with the keyboard; focus that is lost, trapped or invisible.
- Missing accessible names: icon-only buttons, inputs without labels, images without alt text (decorative images need an empty alt).
- Wrong or missing roles and states (aria-expanded, aria-selected, aria-live for content that updates on its own).
- Text and icon contrast below WCAG AA, and meaning carried by color alone.
- Animation without a prefers-reduced-motion fallback.

Run the project's accessibility tests or lint rules if it has them. Post one PR comment (pr_comment) with each problem, its file:line, who it affects and the fix. If the changes look good, say so in one line.`,
	},
	{
		id: 'bundle-size',
		categories: ['review', 'monitoring'],
		title: 'Catch bundle size regressions',
		description: 'Build each pull request against its base and flag growth in bundle size or build time',
		icon: 'layers',
		triggers: [PR_OPENED, PR_PUSHED],
		tools: [],
		instructions: `Compare the build output of the pull request in the event above with its base branch.

1. Build the merge base and the PR head with the project's production build, and time each build.
2. Compare every output bundle (raw and gzip) and the total; note new and removed chunks.
3. For any bundle that grew more than 5% or 20 KB gzip, find the cause: a new dependency, an import that defeats tree shaking, a package bundled twice, inlined assets.

Comment on the PR (pr_comment) only when a bundle crossed that threshold or the build got more than 20% slower: a table of the changed bundles, the cause, and how to shrink it (a dynamic import, a lighter package, a narrower import). After a push to a PR you already commented on, comment again only if the numbers changed. Otherwise finish with "No size regressions."`,
	},
	{
		id: 'migration-review',
		categories: ['review'],
		title: 'Review database migrations',
		description: 'Check pull requests that add migrations for table locks, data loss and deploy-order risks',
		icon: 'database',
		triggers: [PR_OPENED],
		tools: [],
		instructions: `If the pull request in the event above adds or changes database migrations (migrations/, db/migrate, prisma/migrations, alembic/versions, .sql files) or ORM schema files, review them; otherwise finish with "No migrations."

Look for:
- Locks on large tables: changing a column type, adding a column with a volatile default, creating an index without CONCURRENTLY (or the engine's online option), adding a foreign key or NOT NULL without validating it separately.
- Data loss: dropped or renamed columns and tables, narrowed types, backfills that overwrite values.
- Deploy order: new code that uses a column before its migration runs, or old code, still running during the deploy, that breaks once it has run.
- Long backfills inside the migration transaction, without batches.
- A missing or wrong down migration, where the project uses them.

Post one PR comment (pr_comment) with a risk level (safe / needs care / dangerous), each problem with file:line, and a safer sequence (expand, migrate, contract) where it helps.`,
	},
	{
		id: 'gitlab-mr-review',
		categories: ['review'],
		title: 'Review GitLab merge requests',
		description: 'Review each new GitLab merge request for bugs and risky changes, and comment with findings',
		icon: 'merge',
		triggers: [{ provider: 'gitlab', event: 'pr.opened' }],
		tools: [],
		instructions: `Review the GitLab merge request in the event above.

## How

- Fetch the source branch and read the full diff against the target branch with its context. Run the tests that cover the changed code.
- Look for correctness bugs, missing error handling, security problems, breaking API changes, risky migrations and missing tests.
- Ignore formatting and personal style.

## Output

Post one note on the merge request with the glab CLI (glab mr note <iid> --message …), or with the GitLab API and the token in the environment: a two-line summary, then findings ordered by severity, each with file:line and a concrete fix. If the merge request looks good, say so in one line. If you cannot post, end with the review so it shows in the run.`,
	},
	{
		id: 'license-check',
		categories: ['security'],
		title: 'Check licenses of new dependencies',
		description: 'Flag pull requests that add dependencies with incompatible or unknown licenses',
		icon: 'law',
		triggers: [PR_OPENED],
		tools: [],
		instructions: `If the pull request in the event above adds or upgrades dependencies, check their licenses; otherwise finish with "No dependency changes."

- List every new direct and transitive package in the lock file diff with its license (from the package metadata, then its LICENSE file).
- Compare with the project's policy if it has one (an allow list, the license checker config, a NOTICE file). Without one, accept MIT, BSD, ISC, Apache-2.0 and similar; flag GPL and AGPL, LGPL in bundled or statically linked code, SSPL, BUSL, Commons Clause, custom and missing licenses.
- Note any package whose license changed between the old and the new version.

Post a PR comment (pr_comment): a table of the flagged packages with their license, why it matters for this project, and an alternative package where one exists. If everything is fine, say so in one line. Add that this is not legal advice whenever you flag something.`,
	},
	{
		id: 'audit-fix',
		categories: ['security', 'environment'],
		title: 'Fix vulnerable dependencies',
		description: 'Run the package audit every day and open pull requests that patch known advisories',
		icon: 'lock',
		triggers: [DAILY_9],
		tools: ['slack_send'],
		instructions: `You patch dependencies with known vulnerabilities.

${MEMORY_RULES}

## Goal

Run the audit tool of each ecosystem in the repository (npm audit or pnpm audit, pip-audit, cargo audit, govulncheck, bundle audit) and collect the high and critical advisories.

## Rules

- Prefer the smallest upgrade that contains the fix. Use an override or resolution for a transitive package only when its parent has no fixed release.
- Check whether the vulnerable code path is reachable from this code and say so; patch it either way.
- Group advisories fixed by the same upgrade. Run the full test suite and open a PR only when it passes.
- If an advisory has no fix yet, record it in MEMORIES.md with its id and check again on the next run.

## Output

Send a Slack message with the advisories, the PRs opened and the ones still waiting for a fix. If the audit is clean, finish with "No known vulnerabilities." ${MEMORY_CLOSE}`,
	},
	{
		id: 'security-digest',
		categories: ['security', 'monitoring'],
		title: 'Weekly security digest',
		description: 'Check new advisories for your dependencies, open alerts and the security headers of your sites',
		icon: 'verified',
		triggers: [WEEKLY_MON],
		tools: ['slack_send'],
		instructions: `Write the weekly security digest. Replace the example URL with your own sites before enabling.

${MEMORY_RULES}

## Sites

- https://example.com

## Check

- Dependencies: advisories published in the last 7 days that affect a version in the lock files (osv-scanner, npm audit, pip-audit), whether a fix exists, and whether the vulnerable function is used here.
- Headers of each site: Content-Security-Policy, Strict-Transport-Security, X-Content-Type-Options, Referrer-Policy, frame-ancestors or X-Frame-Options, and cookies without Secure, HttpOnly or SameSite.
- TLS certificates that expire within 21 days.
- Open Dependabot, secret scanning and code scanning alerts (GitHub CLI).

## Output

Send a Slack digest: new this week first, then findings still open from earlier weeks with how long they have been open. Record every finding in MEMORIES.md. If everything is clean, send one line: "All clear."`,
	},
	{
		id: 'issue-triage',
		categories: ['incidents'],
		title: 'Label and dedupe new issues',
		description: 'Every hour, label new GitHub issues, link duplicates and ask reporters for missing details',
		icon: 'tag',
		triggers: [HOURLY],
		tools: [],
		instructions: `Triage the GitHub issues opened since the last run (its time is in MEMORIES.md; on the first run, the last 24 hours).

For each new issue (gh issue list, gh issue view):
- Apply labels that already exist in the repository: its type (bug, feature, question, docs) and the area it touches, found from the code it mentions. Never create labels.
- Search open and recently closed issues for a duplicate. When you are confident, comment with a link to the original and add the "duplicate" label; do not close it.
- If a bug report has no version, steps to reproduce or expected behavior, comment once asking for exactly what is missing.
- If it is a question the docs already answer, reply with the link.

Be brief and friendly; you speak for the maintainers. Skip issues a maintainer already answered. Record the time of this run in MEMORIES.md before finishing.`,
	},
	{
		id: 'jira-to-pr',
		categories: ['incidents'],
		title: 'Turn Jira tickets into draft PRs',
		description: 'When a ticket moves to Ready for Dev, implement it and open a draft pull request',
		icon: 'draft',
		triggers: [{ provider: 'jira', event: 'issue.status_changed' }],
		tools: [],
		instructions: `A Jira issue changed status (see the event above). Act only when its new status is "Ready for Dev" (edit this to match your board) and it is a bug or a small task; otherwise finish with "Not ready for an agent."

${MEMORY_RULES}

1. Restate the ticket as acceptance criteria. If it is too vague to implement without guessing, stop and list the questions to ask instead.
2. Find the code involved and make the smallest change that meets the criteria, following the project's conventions. Add or update tests.
3. Run the tests and linters that cover the change.
4. Push a branch named after the issue key and open a PR as a draft, with the issue key in the title, the criteria as a checklist and what you tested.

Keep to the ticket's scope; list anything else you noticed as follow-ups in the PR description. ${MEMORY_CLOSE}`,
	},
	{
		id: 'postmortem-draft',
		categories: ['incidents', 'docs'],
		title: 'Draft incident postmortems',
		description: 'When a PagerDuty incident resolves, write a blameless postmortem draft with a timeline',
		icon: 'note',
		triggers: [{ provider: 'pagerduty', event: 'incident.resolved' }],
		tools: ['slack_read', 'slack_send'],
		instructions: `A PagerDuty incident was resolved (see the event above). Draft its postmortem while the details are fresh.

- Timeline: from the first sign of trouble to the resolution, built from the incident channel (slack_read) and the deploys, merges and reverts around that window (git log, GitHub releases). Times in UTC.
- Impact: what users saw, for how long and how many were affected, as far as the evidence shows.
- Root cause and trigger, with the code or config involved; say plainly what is still unknown.
- What went well, what went poorly, and where we got lucky.
- Action items: specific, each with a suggested owner and whether it prevents, detects or mitigates.

Keep it blameless: describe systems and decisions, not people. If the repository has a postmortems folder, add the draft there and open a PR; otherwise send it to Slack as a draft for the incident owner.`,
	},
	{
		id: 'oncall-handoff',
		categories: ['incidents', 'team'],
		title: 'On-call handoff',
		description: 'Brief the next on-call engineer on open incidents, noisy alerts and risky changes',
		icon: 'bell',
		triggers: [WEEKLY_MON],
		tools: ['slack_read', 'slack_send'],
		instructions: `Write the handoff note for the engineer who starts on-call this week.

Read the last 7 days of the incident and alert channels (slack_read) and the repository's history for the same week.

- Open incidents, and anything mitigated but not fixed, with links.
- The alerts that fired most, and which of them were noise worth tuning or silencing.
- Risky changes that merged or are about to: migrations, infrastructure, dependency majors, feature flags turned on.
- Workarounds in use and the runbooks that were needed this week.

Most urgent first, under 250 words, sent to Slack. Do not acknowledge, resolve or change anything.`,
	},
	{
		id: 'ci-cost-report',
		categories: ['monitoring', 'research'],
		title: 'Report CI minutes and cost',
		description: 'Find the workflows and jobs that burn the most CI time each week, and how to cut it',
		icon: 'credit',
		triggers: [WEEKLY_MON],
		tools: ['slack_send'],
		instructions: `Report where the repository's CI time went in the last 7 days.

- With the GitHub CLI (gh run list, gh api for jobs and their timing), total the minutes by workflow and by job, split by runner (macOS, Windows and larger runners cost more per minute).
- Compare with last week's totals in MEMORIES.md and call out changes beyond 15%.
- Find the waste: jobs that are re-run often, caches that miss, steps that run on every push but matter only for some paths, matrix entries nobody needs, superseded runs that were never cancelled.
- Suggest the three changes that would save the most, each with an estimate in minutes per week.

Record this week's totals in MEMORIES.md (keep 8 weeks) and send the report to Slack in under 250 words. If a fix is small and safe (a cache key, a path filter, concurrency with cancel-in-progress), you may open a PR for it.`,
	},
	{
		id: 'lighthouse-audit',
		categories: ['monitoring', 'research'],
		title: 'Audit web performance',
		description: 'Run Lighthouse on your key pages every day and explain any drop in Core Web Vitals',
		icon: 'dashboard',
		triggers: [DAILY_9],
		tools: ['slack_send'],
		instructions: `Audit the performance of the pages below. Replace the example URLs with your own before enabling.

## Pages

- https://example.com/
- https://example.com/pricing

## How

- Run Lighthouse on each page three times (npx lighthouse, performance category, mobile) and take the median performance score, LCP, CLS, TBT and total transfer size.
- Compare with the last 14 days in MEMORIES.md, then record today's numbers.
- For a drop of more than 10 points, or a metric that crossed a Core Web Vitals threshold, find the cause: commits since the last good run, new third-party scripts, larger images or bundles, render-blocking resources.

## Output

Send a Slack message only when something regressed: the page, before and after, the likely cause and the fix. If the fix is small and certain, make it and open a PR. Otherwise finish with "No regressions."`,
	},
	{
		id: 'api-docs-sync',
		categories: ['docs'],
		title: 'Keep API docs in sync',
		description: 'When a merged pull request changes routes or API types, update the reference docs',
		icon: 'api',
		triggers: [PR_MERGED],
		tools: [],
		instructions: `If the pull request merged in the event above changes the public API (HTTP routes, request or response types, status codes, a GraphQL schema, RPC definitions, SDK signatures), update the docs that describe it; otherwise finish with "No API changes."

- Update the OpenAPI or GraphQL schema if the project keeps it by hand, or regenerate it with the project's script.
- Update the reference pages, examples and SDK snippets that show the changed endpoints, and check every example against the new types.
- For removed or renamed endpoints, document the deprecation and the replacement, if the project documents deprecations.

Document only what the code does now. Make the changes on a branch and open a PR titled "docs(api): …" that links the merged PR.`,
	},
	{
		id: 'i18n-sweep',
		categories: ['docs'],
		title: 'Find missing translations',
		description: 'Sweep locale files for missing keys and hard-coded strings, and open a PR with fixes',
		icon: 'globe',
		triggers: [WEEKLY_MON],
		tools: [],
		instructions: `You keep the app's translations complete.

${MEMORY_RULES}

## Find

- The project's locale files and its source locale. List the keys missing from each other locale, keys no code uses anymore, and keys whose placeholders ({name}, %s) differ from the source.
- Hard-coded user-facing strings in UI code changed since the last run that should go through the translation function.

## Rules

- Move hard-coded strings into the source locale, with keys that follow the existing naming.
- Fill other locales only if the project already accepts machine translations; otherwise let the keys fall back and list them in the PR for translators.
- Never change the meaning of an existing translation; fix only its placeholders.
- Remove unused keys only when no code builds key names dynamically.

Run the build and the tests, then open a PR titled "i18n: …" with a table of locales and their missing counts. ${MEMORY_CLOSE}`,
	},
	{
		id: 'onboarding-check',
		categories: ['docs', 'environment'],
		title: 'Test the setup instructions',
		description: 'Follow the README from a clean clone every week and fix the steps that no longer work',
		icon: 'compass',
		triggers: [WEEKLY_MON],
		tools: ['slack_send'],
		instructions: `Act like a new developer on their first day.

${MEMORY_RULES}

## Goal

In a fresh clone in a temporary directory (not your working copy), follow the README and CONTRIBUTING setup steps exactly as written: install, configure, build, run the tests, start the app.

## Rules

- Note every step that fails, is missing, or needs knowledge the docs do not give (a tool version, an environment variable, a service to start). Check .env.example and the CI config for the real values.
- Fix the docs to match what actually works, and add to .env.example any variables the code reads that it is missing. Do not change the build itself.
- Time the whole setup and record it in MEMORIES.md to spot drift.

## Output

If you fixed something, open a PR titled "docs: fix setup instructions" that lists each broken step. Send a short Slack note with the result either way. ${MEMORY_CLOSE}`,
	},
	{
		id: 'architecture-notes',
		categories: ['docs', 'research'],
		title: 'Refresh architecture notes',
		description: 'Keep ARCHITECTURE.md and the agent instructions true to how the code is built today',
		icon: 'map',
		triggers: [WEEKLY_MON],
		tools: [],
		instructions: `You keep the map of the codebase accurate, for new engineers and for coding agents.

${MEMORY_RULES}

## Goal

Compare ARCHITECTURE.md (create it if missing) and the agent instructions file (AGENTS.md or CLAUDE.md, if there is one) with the code as it is now, starting from what changed since the last run (git log).

## What the notes cover

- The main modules and what each owns, the entry points, and how a request or job flows through them.
- Where state lives (databases, caches, queues) and the boundaries code must not cross.
- The commands to build, test, lint and run, as CI actually runs them.
- Conventions a newcomer would get wrong: naming, error handling, where tests go.

## Rules

- Keep it short and link to the code instead of copying it. Remove sections that no longer match. A small Mermaid diagram is welcome when it replaces paragraphs.
- If the notes are still accurate, finish with "Architecture notes are current." Otherwise open a PR titled "docs: refresh architecture notes". ${MEMORY_CLOSE}`,
	},
	{
		id: 'stale-pr-nudge',
		categories: ['team'],
		title: 'Nudge stale pull requests',
		description: 'Remind reviewers and authors in Slack about pull requests stuck waiting on them',
		icon: 'clock',
		triggers: [WEEKDAYS_9],
		tools: ['slack_send'],
		instructions: `Find open pull requests that are stuck and name the person each one waits on.

- Review requested, not a draft, and no review activity for 2 working days: waiting on the reviewers.
- Changes requested and no new commits or replies for 3 working days: waiting on the author.
- Approved with passing checks but not merged for 2 working days: waiting on the author to merge.
- Merge conflicts or failing checks for more than a day: waiting on the author.

Group the list by person, oldest first, with the PR link, its age and one line on what is needed. Use the GitHub-to-Slack name mapping in MEMORIES.md when there is one.

Nudge the same PR at most once every 2 working days: record each nudge (PR URL and date) in MEMORIES.md and drop PRs that merged or closed. Send the list to Slack; if nothing is stuck, send nothing and finish with "No stale PRs."`,
	},
	{
		id: 'linear-cycle-report',
		categories: ['team'],
		title: 'Write the cycle report',
		description: 'When a Linear cycle ends, summarize what shipped, what slipped and why',
		icon: 'milestone',
		triggers: [{ provider: 'linear', event: 'cycle.ended' }],
		tools: ['slack_send'],
		instructions: `A Linear cycle just ended (see the event above). Write its report for the team.

Read the cycle's issues with the Linear API (LINEAR_API_KEY in the environment); without a key, work from the event and the merged PRs that mention issue identifiers.

- Shipped: completed issues grouped by project, one line each, with the PR that closed it (search merged PRs for the identifier).
- Slipped: issues carried over, how many cycles each has slipped, and the likely reason (blocked, grew in scope, never started).
- Scope: issues planned at the start against issues added during the cycle.
- Code: PRs merged during the cycle, the median time from open to merge, and the areas of the codebase that changed most.
- One or two observations the team could act on next cycle. Facts, not blame.

Send it to Slack in under 300 words.`,
	},
	{
		id: 'slack-help-answerer',
		categories: ['team'],
		title: 'Answer questions in a help channel',
		description: 'Answer questions about the codebase posted in a Slack channel, with links to the code',
		icon: 'question',
		triggers: [{ provider: 'slack', event: 'message' }],
		tools: ['slack_read', 'slack_send'],
		instructions: `A message was posted in the Slack channel this trigger watches (see the event above; set the channel on the trigger, for example #help).

If it is not a question about this codebase, its setup or its behavior, send nothing and finish with "Not a question for me." Read the channel's recent messages (slack_read); if the message already has replies, send nothing.

Otherwise:
- Search the code, the docs and recent PRs for the answer. Cite the file:line or doc link, with a short snippet when it helps.
- Lead with the answer, then the evidence, in under 150 words. Quote the first words of the question so people know what you are answering.
- If you are not sure, say what you found and who most likely knows (the recent authors of that code, from git log). Never guess.
- Never share secrets, internal hostnames from config or customer data, even when they are in the repository.

Start the reply with "(automated answer)" so people know who wrote it.`,
	},
	{
		id: 'todo-tracker',
		categories: ['environment'],
		title: 'Track TODOs and FIXMEs',
		description: 'File an issue for each new TODO, FIXME and HACK comment so none of them get lost',
		icon: 'tasklist',
		triggers: [WEEKLY_MON],
		tools: ['slack_send'],
		instructions: `You turn forgotten TODO comments into tracked work.

${MEMORY_RULES}

## Goal

Find TODO, FIXME, HACK and XXX comments added since the last run (git log -p; on the first run, the whole repository) that are not tracked yet.

## Rules

- Skip comments that already reference an issue (#123, a URL, a ticket key) and anything in vendored or generated code.
- Merge comments that describe the same problem into one issue.
- File each as a GitHub issue (gh issue create) with the file:line, the surrounding code, who added it (git blame) and what it would take to resolve. Add a "tech-debt" label if the repository has one.
- File at most 10 issues per run, worst first: FIXME and HACK before TODO, hot code paths before tests.

## Output

Send a Slack summary of the issues filed. Record each comment's location and its issue URL in MEMORIES.md so it is never filed twice.`,
	},
	{
		id: 'dead-code',
		categories: ['environment'],
		title: 'Remove dead code',
		description: 'Find unused exports, files and dependencies, and open a PR that removes a safe batch',
		icon: 'trash',
		triggers: [WEEKLY_MON],
		tools: [],
		instructions: `You remove code nobody uses, carefully.

${MEMORY_RULES}

## Find

- Exports nothing imports, files nothing reaches, dependencies the code never loads. Use the project's tools where they exist (knip, ts-prune, vulture, deadcode, cargo-udeps); otherwise search for references yourself.
- Feature flags that have been fully on or fully off for months, and the code paths they guard.

## Rules

- Treat as used anything reached indirectly: entry points, public package APIs, plugins, reflection, lookups by string, framework conventions (routes, migrations, config files).
- Remove one coherent batch per run, about 300 deleted lines at most, so the PR is easy to review.
- Build and run the full test suite afterwards; put back anything that breaks.
- Then open a PR titled "chore: remove dead code in …" that lists each removal and why it is unused.

${MEMORY_CLOSE}`,
	},
];

export function templatesIn(category: AutomationTemplateCategory): readonly IAutomationTemplate[] {
	return AUTOMATION_TEMPLATES.filter(template => template.categories.includes(category));
}

export function automationTemplate(id: string | undefined): IAutomationTemplate | undefined {
	return id ? AUTOMATION_TEMPLATES.find(template => template.id === id) : undefined;
}
