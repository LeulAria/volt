/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWorkflowNodeType } from './workflowNodes.js';
import { parseWorkflowYaml } from './workflowSchema.js';
import { IWorkflowDefinition, IWorkflowIssue, IWorkflowTemplateEntry, IWorkflowTemplateIndex, IWorkflowTemplateSource, WORKFLOW_ID_PATTERN, WorkflowPermission, WorkflowRecord, WorkflowValue } from './workflowTypes.js';
import { parseYaml } from './workflowYaml.js';

/**
 * Templates: Volt's built-in workflows (bundled YAML, also published in this repository's
 * `workflow-templates/templates/`), the index format of template repositories (the official one
 * and any the user adds), where to fetch a source from, and the checks a template must pass to
 * be published. Templates are data: installing one never runs it, and community ones stay
 * untrusted until the user reviews them.
 */

export interface IBuiltInWorkflowTemplate extends IWorkflowTemplateEntry {
	readonly yaml: string;
}

/** The `version` of index.json files this Volt reads. */
export const WORKFLOW_TEMPLATE_INDEX_VERSION = 1;

/** Permissions in the order the gallery lists them. */
const PERMISSIONS: readonly WorkflowPermission[] = ['agent', 'shell', 'network', 'git', 'filesystem', 'messaging'];

/**
 * Template YAML below is written with one tab per indentation level (this repository indents
 * with tabs); the files use two spaces. `\$` and `\`` escape what a template literal would eat.
 */
function yaml(strings: TemplateStringsArray): string {
	return strings.raw[0]
		.replace(/^\n/, '')
		.replace(/^\t+/gm, tabs => '  '.repeat(tabs.length))
		.replace(/\\([`$])/g, '$1');
}

const IMPLEMENT_TEST_REVIEW = yaml`
# Implement a task, test it, fix failures (up to 3 passes), review it, then open a pull request.
version: 1
id: implement-test-review
name: Implement, test and review loop
description: >-
	An agent implements the task on a new branch and the tests run. Failures go back to a
	fixing agent with the test output, at most three times. A reviewer agent then approves
	the change or asks for changes (which go round the loop again). Approved work is
	committed, pushed and opened as a pull request.
tags: [coding, tests, review, pull-request]
trigger:
	type: manual
inputs:
	- name: task
		type: string
		description: What to build or fix
		required: true
	- name: testCommand
		type: string
		description: The command that runs the tests
		default: npm test
nodes:
	- id: start
		type: start
		position: [0, 0]
	- id: branch
		type: git_branch
		name: New branch
		position: [352, 0]
		config:
			name: 'volt/{{ run.id }}'
	- id: implement
		type: agent
		name: Implement
		position: [688, 0]
		config:
			prompt: |
				{{ inputs.task }}

				Make the change in this repository. Keep it focused, follow the existing
				style, and add or update tests that cover it.
			mode: Agent
	- id: test
		type: shell
		name: Run tests
		position: [1024, 0]
		config:
			command: '{{ inputs.testCommand }}'
			timeout: 15m
	- id: review
		type: agent
		name: Review
		position: [1360, -65]
		config:
			prompt: |
				Review the uncommitted changes in this repository. They are meant to do this:
				{{ inputs.task }}

				Look for bugs, missing tests and risky changes. Do not edit files. End with one
				verdict: approve when it is ready to merge, or changes when something must be
				fixed first (say exactly what).
			mode: Ask
			verdicts: [approve, changes]
	- id: commit
		type: git_commit
		name: Commit
		position: [1696, -107]
		config:
			message: '{{ inputs.task }}'
	- id: push
		type: git_push
		name: Push
		position: [2032, -107]
	- id: pr
		type: github_pr
		name: Open pull request
		position: [2368, -107]
		config:
			title: '{{ inputs.task }}'
			body: |
				{{ nodes.implement.summary }}

				Review: {{ nodes.review.summary }}
	- id: done
		type: end
		position: [2704, -67]
		config:
			status: success
			output: '{{ nodes.pr.url }}'
	- id: retry
		type: loop
		name: Up to 3 fixes
		position: [1696, 89]
		config:
			max: 3
	- id: fix
		type: agent
		name: Fix
		position: [2032, 45]
		config:
			prompt: |
				The change for "{{ inputs.task }}" is not finished.

				Test output (exit code {{ nodes.test.exitCode }}):
				{{ nodes.test.stdout }}
				{{ nodes.test.stderr }}

				Review notes, if any: {{ nodes.review.summary }}

				Fix what failed. Do not disable or skip tests.
			mode: Agent
	- id: gave_up
		type: end
		name: Gave up
		position: [2032, 197]
		config:
			status: failure
			output: 'Still failing after {{ nodes.retry.iteration }} fixes: {{ nodes.test.stderr }}'
edges:
	- { from: start.next, to: branch }
	- { from: branch.created, to: implement }
	- { from: implement.done, to: test }
	- { from: test.passed, to: review }
	- { from: test.failed, to: retry, label: tests failed }
	- { from: review.approve, to: commit }
	- { from: review.done, to: commit }
	- { from: review.changes, to: retry, label: changes requested }
	- { from: retry.repeat, to: fix }
	- { from: retry.exhausted, to: gave_up }
	- { from: fix.done, to: test }
	- { from: commit.committed, to: push }
	- { from: push.pushed, to: pr }
	- { from: pr.opened, to: done }
`;

const FIX_FAILING_CI = yaml`
# When a GitHub Actions run fails: check out its branch, fix it, test it, and push the fix.
version: 1
id: fix-failing-ci
name: Fix failing CI
description: >-
	Starts when a GitHub Actions workflow run fails. Volt checks out the failing branch, an
	agent finds the cause and fixes it, and the tests run locally (two more tries when they
	still fail). The fix is committed and pushed to the same branch, and the pull request
	gets a comment saying what changed.
tags: [ci, github, fix]
trigger:
	type: event
	provider: github
	event: workflow.failure
	samplePayload:
		workflow_run:
			name: CI
			head_branch: feature/login
			html_url: https://github.com/acme/app/actions/runs/123
			conclusion: failure
variables:
	testCommand: npm test
nodes:
	- id: start
		type: start
		position: [0, 0]
	- id: checkout
		type: shell
		name: Check out the branch
		position: [352, 0]
		config:
			command: git fetch origin "$BRANCH" && git checkout "$BRANCH" && git pull --ff-only origin "$BRANCH"
			env:
				BRANCH: '{{ trigger.payload.workflow_run.head_branch }}'
	- id: fix
		type: agent
		name: Find and fix
		position: [688, 0]
		config:
			prompt: |
				The GitHub Actions workflow "{{ trigger.payload.workflow_run.name }}" failed on
				branch {{ trigger.payload.workflow_run.head_branch }}:
				{{ trigger.payload.workflow_run.html_url }}

				Read the failing job's log (gh run view --log-failed), reproduce the failure
				locally, find the root cause and fix it. Do not disable, skip or loosen tests.

				Output of the last local test run, if any:
				{{ nodes.test.stderr }}
			mode: Agent
	- id: test
		type: shell
		name: Run tests
		position: [1024, 0]
		config:
			command: '{{ vars.testCommand }}'
			timeout: 20m
	- id: commit
		type: git_commit
		name: Commit
		position: [1360, -97]
		config:
			message: 'fix: make {{ trigger.payload.workflow_run.name }} pass again'
	- id: push
		type: git_push
		name: Push
		position: [1696, -141]
	- id: comment
		type: github_pr_comment
		name: Comment on the PR
		position: [2032, -141]
		config:
			body: |
				Volt pushed {{ nodes.commit.sha }} to fix the failing "{{ trigger.payload.workflow_run.name }}" run.

				{{ nodes.fix.summary }}
	- id: done
		type: end
		position: [2368, -89]
		config:
			status: success
			output: '{{ nodes.commit.sha }}'
	- id: nothing
		type: end
		name: Nothing to change
		position: [1696, 11]
		config:
			status: success
			output: The agent found nothing to change
	- id: retry
		type: loop
		name: Two more tries
		position: [1360, 121]
		config:
			max: 2
	- id: alert
		type: notify
		name: Tell me
		position: [1696, 145]
		config:
			title: CI is still failing
			message: '{{ trigger.payload.workflow_run.name }} on {{ trigger.payload.workflow_run.head_branch }} still fails after Volt''s fixes.'
			severity: error
	- id: gave_up
		type: end
		name: Gave up
		position: [2032, 185]
		config:
			status: failure
			output: '{{ nodes.test.stderr }}'
edges:
	- { from: start.next, to: checkout }
	- { from: checkout.passed, to: fix }
	- { from: fix.done, to: test }
	- { from: test.passed, to: commit }
	- { from: test.failed, to: retry, label: tests failed }
	- { from: retry.repeat, to: fix }
	- { from: retry.exhausted, to: alert }
	- { from: alert.next, to: gave_up }
	- { from: commit.committed, to: push }
	- { from: commit.nothing, to: nothing }
	- { from: push.pushed, to: comment }
	- { from: comment.done, to: done }
	- { from: comment.failed, to: done }
`;

const REVIEW_PULL_REQUEST = yaml`
# Review every new pull request: a read-only agent reads the diff and posts its review.
version: 1
id: review-pull-request
name: Review a pull request
description: >-
	Starts when a pull request is opened on GitHub. A read-only agent reviews the diff for
	bugs, missing tests and risky changes, and posts the review as a comment. Approved pull
	requests also get the volt-approved label.
tags: [review, github, pull-request]
trigger:
	type: event
	provider: github
	event: pr.opened
	samplePayload:
		pull_request:
			number: 42
			title: Add rate limiting to the login endpoint
			html_url: https://github.com/acme/app/pull/42
			base:
				ref: main
			head:
				ref: feature/rate-limit
nodes:
	- id: start
		type: start
		position: [0, 0]
	- id: review
		type: agent
		name: Review the diff
		position: [352, 0]
		config:
			prompt: |
				Review pull request #{{ trigger.payload.pull_request.number }}: {{ trigger.payload.pull_request.title }}
				{{ trigger.payload.pull_request.html_url }}

				Read the diff (gh pr diff {{ trigger.payload.pull_request.number }}) and the code
				around it. Look for bugs, missing tests, security problems and confusing names.
				Do not change any files. Write the review as a short list of findings with file
				and line, most important first, then end with one verdict: approve when it can
				be merged as it is, or changes when something must be fixed.
			mode: Ask
			verdicts: [approve, changes]
	- id: approval
		type: github_pr_comment
		name: Post the approval
		position: [688, -77]
		config:
			body: |
				**Volt review: looks good.**

				{{ nodes.review.summary }}
	- id: label
		type: github_update_pr
		name: Label it approved
		position: [1024, -49]
		config:
			labels: [volt-approved]
	- id: done
		type: end
		position: [1360, 39]
		config:
			status: success
			output: '{{ nodes.review.verdict }}'
	- id: feedback
		type: github_pr_comment
		name: Post the review
		position: [688, 75]
		config:
			body: |
				**Volt review**

				{{ nodes.review.summary }}
edges:
	- { from: start.next, to: review }
	- { from: review.approve, to: approval }
	- { from: review.changes, to: feedback }
	- { from: review.done, to: feedback }
	- { from: approval.done, to: label }
	- { from: label.done, to: done }
	- { from: feedback.done, to: done }
`;

const NIGHTLY_DEPENDENCY_UPDATE = yaml`
# Every night: update dependencies on a branch, run the tests, and open a draft pull request.
version: 1
id: nightly-dependency-update
name: Nightly dependency update
description: >-
	Runs every night at 03:00. On a new branch an agent upgrades dependencies to the newest
	versions that keep the project working (patch and minor releases; major ones only when
	the upgrade needs no code changes), the test script runs, and passing updates become a
	draft pull request. When the tests fail you get a notification instead.
tags: [dependencies, maintenance, schedule]
trigger:
	type: schedule
	cron: '0 3 * * *'
nodes:
	- id: start
		type: start
		position: [0, 0]
	- id: branch
		type: git_branch
		name: New branch
		position: [352, 0]
		config:
			name: 'deps/nightly-{{ run.id }}'
	- id: update
		type: agent
		name: Update dependencies
		position: [688, 0]
		config:
			prompt: |
				Update this project's dependencies with its package manager. Take patch and minor
				releases; take a major release only when the upgrade needs no code changes.
				Update the lockfile, keep the existing version range style, and do not touch
				unrelated files. Finish with a list of what changed (name: old -> new).
			mode: Agent
	- id: test
		type: package_script
		name: Run tests
		position: [1024, 0]
		config:
			script: test
	- id: commit
		type: git_commit
		name: Commit
		position: [1360, -89]
		config:
			message: 'chore(deps): nightly dependency update'
	- id: push
		type: git_push
		name: Push
		position: [1696, -133]
	- id: pr
		type: github_pr
		name: Draft pull request
		position: [2032, -133]
		config:
			title: 'chore(deps): nightly dependency update'
			body: |
				Automated dependency update by Volt. The test script passed.

				{{ nodes.update.summary }}
			draft: true
	- id: done
		type: end
		position: [2368, -93]
		config:
			status: success
			output: '{{ nodes.pr.url }}'
	- id: current
		type: end
		name: Already current
		position: [1696, 19]
		config:
			status: success
			output: Every dependency is already up to date
	- id: broken
		type: notify
		name: Tests failed
		position: [1360, 113]
		config:
			title: The nightly dependency update breaks the tests
			message: '{{ nodes.test.stderr }}'
			severity: warning
	- id: failed
		type: end
		name: Not updated
		position: [1696, 153]
		config:
			status: failure
			output: The updated dependencies fail the tests
edges:
	- { from: start.next, to: branch }
	- { from: branch.created, to: update }
	- { from: update.done, to: test }
	- { from: test.passed, to: commit }
	- { from: test.failed, to: broken }
	- { from: broken.next, to: failed }
	- { from: commit.committed, to: push }
	- { from: commit.nothing, to: current }
	- { from: push.pushed, to: pr }
	- { from: pr.opened, to: done }
`;

const TRIAGE_SENTRY_ISSUE = yaml`
# Triage new Sentry issues: sort them, find the cause of real regressions, and tell Slack.
version: 1
id: triage-sentry-issue
name: Triage Sentry issue
description: >-
	Starts when Sentry reports a new issue. A model sorts it into regression, flaky or
	noise. Regressions get a read-only agent that looks for the cause in this repository
	and proposes a fix, and the finding goes to Slack. Flaky and noisy issues are logged.
	Set the slackWebhook variable to your Slack incoming webhook URL.
tags: [sentry, triage, slack, incidents]
trigger:
	type: event
	provider: sentry
	event: issue.created
	samplePayload:
		data:
			issue:
				title: 'TypeError: Cannot read properties of undefined (reading ''id'')'
				culprit: src/auth/session.ts in refreshSession
				permalink: https://acme.sentry.io/issues/4711/
				count: 12
variables:
	slackWebhook: https://hooks.slack.com/services/T000/B000/XXXX
nodes:
	- id: start
		type: start
		position: [0, 0]
	- id: classify
		type: classify
		name: Sort the issue
		position: [352, 0]
		config:
			text: |
				{{ trigger.payload.data.issue.title }}
				Culprit: {{ trigger.payload.data.issue.culprit }}
				Events so far: {{ trigger.payload.data.issue.count }}
			categories: [regression, flaky, noise]
			instructions: |
				regression: a real bug in our code, likely from a recent change.
				flaky: timing, network or test-only failures that come and go.
				noise: browser extensions, bots, third-party scripts, expected errors.
	- id: investigate
		type: agent
		name: Find the cause
		position: [688, -40]
		config:
			prompt: |
				Sentry reported a new issue: {{ trigger.payload.data.issue.title }}
				Where: {{ trigger.payload.data.issue.culprit }}
				{{ trigger.payload.data.issue.permalink }}

				Find the code involved and the most likely cause (check recent commits with
				git log). Do not change files. Reply with the cause, the commit that most likely
				introduced it, and a proposed fix in a few lines.
			mode: Ask
	- id: alert
		type: slack_message
		name: Post to Slack
		position: [1024, -6]
		config:
			webhookUrl: '{{ vars.slackWebhook }}'
			text: |
				*New regression:* {{ trigger.payload.data.issue.title }}
				{{ trigger.payload.data.issue.permalink }}

				{{ nodes.investigate.summary }}
	- id: done
		type: end
		position: [1360, 82]
		config:
			status: success
			output: '{{ nodes.classify.category }}'
	- id: note
		type: log
		name: Log it
		position: [688, 112]
		config:
			message: 'Sorted as {{ nodes.classify.category }}: {{ trigger.payload.data.issue.title }} ({{ nodes.classify.reason }})'
edges:
	- { from: start.next, to: classify }
	- { from: classify.regression, to: investigate }
	- { from: classify.other, to: investigate }
	- { from: classify.flaky, to: note }
	- { from: classify.noise, to: note }
	- { from: investigate.done, to: alert }
	- { from: investigate.failed, to: alert }
	- { from: alert.sent, to: done }
	- { from: note.next, to: done }
`;

const RELEASE_NOTES_ON_TAG = yaml`
# When a version tag is pushed: write release notes from the commits and publish a GitHub release.
version: 1
id: release-notes-on-tag
name: Release notes on tag
description: >-
	Starts when a tag starting with v is pushed to GitHub. The commits since the previous
	tag are summarized into release notes (features, fixes, other), saved to
	.volt/release-notes.md and published as a GitHub release with the gh CLI. Slack gets a
	short announcement (set the slackWebhook variable).
tags: [release, changelog, github]
trigger:
	type: event
	provider: github
	event: push
	filters: ['payload.ref matches ^refs/tags/v']
	samplePayload:
		ref: refs/tags/v1.4.0
		repository:
			full_name: acme/app
variables:
	slackWebhook: https://hooks.slack.com/services/T000/B000/XXXX
nodes:
	- id: start
		type: start
		position: [0, 0]
	- id: commits
		type: shell
		name: Commits since the last tag
		position: [352, 0]
		config:
			command: |
				tag="\${TAG#refs/tags/}"
				git fetch --tags --quiet origin
				previous=$(git describe --tags --abbrev=0 "$tag^" 2>/dev/null || git rev-list --max-parents=0 "$tag")
				git log --no-merges --pretty=format:'- %s (%h)' "$previous..$tag"
			env:
				TAG: '{{ trigger.payload.ref }}'
	- id: notes
		type: summarize
		name: Write release notes
		position: [688, 0]
		config:
			text: '{{ nodes.commits.stdout }}'
			instructions: |
				Turn these commits into release notes in Markdown with the sections Features,
				Fixes and Other (leave out empty sections). One line per change, written for
				users, without commit hashes. Merge commits that belong together.
	- id: save
		type: write_file
		name: Save the notes
		position: [1024, 0]
		config:
			path: .volt/release-notes.md
			content: '{{ nodes.notes.summary }}'
			mode: overwrite
	- id: publish
		type: shell
		name: Publish the release
		position: [1360, 0]
		config:
			command: |
				tag="\${TAG#refs/tags/}"
				gh release create "$tag" --title "$tag" --notes-file .volt/release-notes.md --verify-tag
			env:
				TAG: '{{ trigger.payload.ref }}'
	- id: announce
		type: slack_message
		name: Announce it
		position: [1696, 0]
		config:
			webhookUrl: '{{ vars.slackWebhook }}'
			text: |
				*{{ trigger.payload.repository.full_name }} {{ replace(trigger.payload.ref, 'refs/tags/', '') }} is out*

				{{ nodes.notes.summary }}
	- id: done
		type: end
		position: [2032, 52]
		config:
			status: success
			output: '{{ nodes.notes.summary }}'
edges:
	- { from: start.next, to: commits }
	- { from: commits.passed, to: notes }
	- { from: notes.done, to: save }
	- { from: save.written, to: publish }
	- { from: publish.passed, to: announce }
	- { from: announce.sent, to: done }
	- { from: announce.failed, to: done }
`;

const UPTIME_CHECK = yaml`
# Every 5 minutes: request a URL, and tell Slack when it is down or slow.
version: 1
id: uptime-check
name: Uptime check every 5 minutes
description: >-
	Requests the url variable every five minutes. When the request fails or answers with an
	error status, Slack hears that the site is down; when the answer takes longer than
	slowMs, Slack hears that it is slow. Set url, slowMs and slackWebhook in the variables.
tags: [monitoring, uptime, slack, schedule]
trigger:
	type: schedule
	everyMinutes: 5
variables:
	url: https://example.com/health
	slowMs: 2000
	slackWebhook: https://hooks.slack.com/services/T000/B000/XXXX
nodes:
	- id: start
		type: start
		position: [0, 0]
	- id: ping
		type: http
		name: Request the URL
		position: [352, 0]
		config:
			method: GET
			url: '{{ vars.url }}'
			timeout: 10s
	- id: slow
		type: if
		name: Too slow?
		position: [688, -71]
		config:
			condition: nodes.ping.durationMs > vars.slowMs
	- id: slow_alert
		type: slack_message
		name: Slow alert
		position: [1024, -107]
		config:
			webhookUrl: '{{ vars.slackWebhook }}'
			text: ':warning: {{ vars.url }} answered in {{ nodes.ping.durationMs }} ms (limit {{ vars.slowMs }} ms)'
	- id: up
		type: end
		name: Up
		position: [1360, -13]
		config:
			status: success
			output: '{{ nodes.ping.status }} in {{ nodes.ping.durationMs }} ms'
	- id: down_alert
		type: slack_message
		name: Down alert
		position: [688, 95]
		config:
			webhookUrl: '{{ vars.slackWebhook }}'
			text: ':red_circle: {{ vars.url }} is down (status {{ nodes.ping.status }})'
	- id: down
		type: end
		name: Down
		position: [1024, 147]
		config:
			status: failure
			output: '{{ vars.url }} is down'
edges:
	- { from: start.next, to: ping }
	- { from: ping.success, to: slow }
	- { from: ping.fail, to: down_alert }
	- { from: slow.true, to: slow_alert }
	- { from: slow.false, to: up }
	- { from: slow_alert.sent, to: up }
	- { from: slow_alert.failed, to: up }
	- { from: down_alert.sent, to: down }
	- { from: down_alert.failed, to: down }
`;

const ISSUE_TO_DRAFT_PR = yaml`
# Label a GitHub issue "volt" and get a draft pull request that implements it.
version: 1
id: issue-to-draft-pr
name: Issue to draft PR
description: >-
	Starts when an issue gets the volt label. On a new branch an agent implements the
	issue and the tests run (two more tries when they fail). The work is pushed as a draft
	pull request that closes the issue, and the issue gets a comment with the link.
tags: [github, issues, coding, pull-request]
trigger:
	type: event
	provider: github
	event: label_changed
	option: volt
	samplePayload:
		action: labeled
		label:
			name: volt
		issue:
			number: 7
			title: Show the last sign-in time on the profile page
			body: The profile page should show when the user last signed in, in their own time zone.
nodes:
	- id: start
		type: start
		position: [0, 0]
	- id: branch
		type: git_branch
		name: New branch
		position: [352, 0]
		config:
			name: 'volt/issue-{{ trigger.payload.issue.number }}'
	- id: implement
		type: agent
		name: Implement the issue
		position: [688, 0]
		config:
			prompt: |
				Resolve GitHub issue #{{ trigger.payload.issue.number }}: {{ trigger.payload.issue.title }}

				{{ trigger.payload.issue.body }}

				Implement it in this repository with tests, and keep the change focused.
				Output of the last test run, if there was one:
				{{ nodes.test.stderr }}
			mode: Agent
	- id: test
		type: package_script
		name: Run tests
		position: [1024, 0]
		config:
			script: test
	- id: commit
		type: git_commit
		name: Commit
		position: [1360, -76]
		config:
			message: 'feat: {{ trigger.payload.issue.title }} (#{{ trigger.payload.issue.number }})'
	- id: push
		type: git_push
		name: Push
		position: [1696, -76]
	- id: pr
		type: github_pr
		name: Draft pull request
		position: [2032, -76]
		config:
			title: '{{ trigger.payload.issue.title }}'
			body: |
				Closes #{{ trigger.payload.issue.number }}

				{{ nodes.implement.summary }}
			draft: true
	- id: link
		type: github_issue_comment
		name: Link the PR
		position: [2368, -76]
		config:
			issue: '{{ trigger.payload.issue.number }}'
			body: 'Volt opened a draft pull request for this issue: {{ nodes.pr.url }}'
	- id: done
		type: end
		position: [2704, -24]
		config:
			status: success
			output: '{{ nodes.pr.url }}'
	- id: retry
		type: loop
		name: Two more tries
		position: [1360, 100]
		config:
			max: 2
	- id: stuck
		type: github_issue_comment
		name: Say it is stuck
		position: [1696, 124]
		config:
			issue: '{{ trigger.payload.issue.number }}'
			body: |
				Volt could not get the tests passing for this issue. Last test output:

				{{ nodes.test.stderr }}
	- id: failed
		type: end
		name: Not done
		position: [2032, 176]
		config:
			status: failure
			output: The tests still fail
edges:
	- { from: start.next, to: branch }
	- { from: branch.created, to: implement }
	- { from: implement.done, to: test }
	- { from: test.passed, to: commit }
	- { from: test.failed, to: retry, label: tests failed }
	- { from: retry.repeat, to: implement }
	- { from: retry.exhausted, to: stuck }
	- { from: stuck.done, to: failed }
	- { from: stuck.failed, to: failed }
	- { from: commit.committed, to: push }
	- { from: push.pushed, to: pr }
	- { from: pr.opened, to: link }
	- { from: link.done, to: done }
	- { from: link.failed, to: done }
`;

const DAILY_SLACK_DIGEST = yaml`
# Every weekday morning: summarize the last day's commits and post the digest to Slack.
version: 1
id: daily-slack-digest
name: Daily Slack digest
description: >-
	Runs at 09:00 on weekdays. Collects the last day's commits on every branch and, when
	there are any, a model writes a short digest (highlights first) that goes to Slack.
	Set the slackWebhook variable to your Slack incoming webhook URL.
tags: [slack, digest, schedule, team]
trigger:
	type: schedule
	cron: '0 9 * * 1-5'
variables:
	slackWebhook: https://hooks.slack.com/services/T000/B000/XXXX
nodes:
	- id: start
		type: start
		position: [0, 0]
	- id: activity
		type: shell
		name: The last day's commits
		position: [352, 0]
		config:
			command: |
				git fetch --all --quiet
				git log --all --no-merges --since='1 day ago' --pretty=format:'- %s (%an, %h)'
	- id: any
		type: if
		name: Anything new?
		position: [688, 0]
		config:
			condition: len(trim(nodes.activity.stdout)) > 0
	- id: digest
		type: summarize
		name: Write the digest
		position: [1024, -44]
		config:
			text: '{{ nodes.activity.stdout }}'
			instructions: |
				Write a Slack digest of these commits for the team: two or three highlights
				first, then short bullets grouped by area. At most 15 lines, plain words, no
				commit hashes.
	- id: post
		type: slack_message
		name: Post to Slack
		position: [1360, -44]
		config:
			webhookUrl: '{{ vars.slackWebhook }}'
			text: |
				*The last day in the repository*

				{{ nodes.digest.summary }}
	- id: done
		type: end
		position: [1696, -4]
		config:
			status: success
			output: '{{ nodes.digest.summary }}'
	- id: quiet
		type: end
		name: Quiet day
		position: [1024, 108]
		config:
			status: success
			output: No commits in the last day
edges:
	- { from: start.next, to: activity }
	- { from: activity.passed, to: any }
	- { from: any.true, to: digest }
	- { from: any.false, to: quiet }
	- { from: digest.done, to: post }
	- { from: post.sent, to: done }
`;

const PARALLEL_RESEARCH = yaml`
# Research a question from three angles at once, then merge the findings into one report.
version: 1
id: parallel-research
name: Parallel research with fork/join
description: >-
	Three read-only agents work at the same time: one studies how this codebase handles it
	today, one compares approaches and libraries, one looks for risks. A join waits for all
	three, a model merges their findings, and the report is saved under research/.
tags: [research, parallel, agents]
trigger:
	type: manual
inputs:
	- name: question
		type: string
		description: What to research
		required: true
nodes:
	- id: start
		type: start
		position: [0, 0]
	- id: fork
		type: fork
		name: Three angles
		position: [352, 0]
		config:
			branches: 3
	- id: codebase
		type: agent
		name: The codebase today
		position: [688, -128]
		config:
			prompt: |
				Research this question in the current codebase: {{ inputs.question }}

				How is it handled today? Which files and modules are involved, and what
				constraints do they set? Do not change files. Answer with findings and paths.
			mode: Ask
	- id: options
		type: agent
		name: Approaches
		position: [688, 24]
		config:
			prompt: |
				Research this question: {{ inputs.question }}

				Compare two to four ways to solve it (approaches or libraries) with their
				trade-offs for a project like this one. Do not change files.
			mode: Ask
	- id: risks
		type: agent
		name: Risks
		position: [688, 176]
		config:
			prompt: |
				Research the risks of this question: {{ inputs.question }}

				What could go wrong (security, performance, migration, maintenance)? How would
				we notice, and how would we limit the damage? Do not change files.
			mode: Ask
	- id: join
		type: join
		name: All three
		position: [1024, 36]
		config:
			mode: all
	- id: report
		type: summarize
		name: Merge the findings
		position: [1360, 36]
		config:
			text: |
				Question: {{ inputs.question }}

				Codebase:
				{{ nodes.codebase.summary }}

				Approaches:
				{{ nodes.options.summary }}

				Risks:
				{{ nodes.risks.summary }}
			instructions: |
				Merge these findings into one research report in Markdown: a two-sentence
				answer first, then the sections Current state, Options (with a recommendation)
				and Risks.
	- id: save
		type: write_file
		name: Save the report
		position: [1696, 36]
		config:
			path: 'research/{{ run.id }}.md'
			content: |
				# {{ inputs.question }}

				{{ nodes.report.summary }}
	- id: done
		type: end
		position: [2032, 76]
		config:
			status: success
			output: '{{ nodes.save.path }}'
edges:
	- { from: start.next, to: fork }
	- { from: fork.branch1, to: codebase }
	- { from: fork.branch2, to: options }
	- { from: fork.branch3, to: risks }
	- { from: codebase.done, to: join }
	- { from: codebase.failed, to: join }
	- { from: options.done, to: join }
	- { from: options.failed, to: join }
	- { from: risks.done, to: join }
	- { from: risks.failed, to: join }
	- { from: join.next, to: report }
	- { from: report.done, to: save }
	- { from: save.written, to: done }
`;

function builtIn(entry: Omit<IBuiltInWorkflowTemplate, 'path' | 'author'>): IBuiltInWorkflowTemplate {
	return { ...entry, path: `templates/${entry.id}.yaml`, author: 'Volt' };
}

/** Volt's own templates, in gallery order. Each is also `workflow-templates/templates/<id>.yaml` (the validator keeps them equal). */
export const BUILT_IN_WORKFLOW_TEMPLATES: readonly IBuiltInWorkflowTemplate[] = [
	builtIn({
		id: 'implement-test-review', name: 'Implement, test and review loop', icon: 'checklist', yaml: IMPLEMENT_TEST_REVIEW,
		description: 'An agent implements the task, failing tests go back for fixes (up to 3), a reviewer approves, and a pull request opens.',
		tags: ['coding', 'tests', 'review', 'pull-request'],
		nodeTypes: ['start', 'git_branch', 'agent', 'shell', 'git_commit', 'git_push', 'github_pr', 'end', 'loop'],
		permissions: ['agent', 'shell', 'network', 'git'],
	}),
	builtIn({
		id: 'fix-failing-ci', name: 'Fix failing CI', icon: 'tools', yaml: FIX_FAILING_CI,
		description: 'When a GitHub Actions run fails, an agent fixes it on the same branch, tests it locally and pushes the fix.',
		tags: ['ci', 'github', 'fix'],
		nodeTypes: ['start', 'shell', 'agent', 'git_commit', 'git_push', 'github_pr_comment', 'end', 'loop', 'notify'],
		permissions: ['agent', 'shell', 'network', 'git'],
	}),
	builtIn({
		id: 'review-pull-request', name: 'Review a pull request', icon: 'git-pull-request', yaml: REVIEW_PULL_REQUEST,
		description: 'Every new pull request gets a review comment from a read-only agent; approved ones get a label.',
		tags: ['review', 'github', 'pull-request'],
		nodeTypes: ['start', 'agent', 'github_pr_comment', 'github_update_pr', 'end'],
		permissions: ['agent', 'network', 'git'],
	}),
	builtIn({
		id: 'nightly-dependency-update', name: 'Nightly dependency update', icon: 'package', yaml: NIGHTLY_DEPENDENCY_UPDATE,
		description: 'Every night, dependencies are upgraded on a branch, tested, and opened as a draft pull request.',
		tags: ['dependencies', 'maintenance', 'schedule'],
		nodeTypes: ['start', 'git_branch', 'agent', 'package_script', 'git_commit', 'git_push', 'github_pr', 'end', 'notify'],
		permissions: ['agent', 'shell', 'network', 'git'],
	}),
	builtIn({
		id: 'triage-sentry-issue', name: 'Triage Sentry issue', icon: 'bug', yaml: TRIAGE_SENTRY_ISSUE,
		description: 'New Sentry issues are sorted; regressions get a root-cause analysis posted to Slack.',
		tags: ['sentry', 'triage', 'slack', 'incidents'],
		nodeTypes: ['start', 'classify', 'agent', 'slack_message', 'end', 'log'],
		permissions: ['agent', 'network', 'messaging'],
	}),
	builtIn({
		id: 'release-notes-on-tag', name: 'Release notes on tag', icon: 'tag', yaml: RELEASE_NOTES_ON_TAG,
		description: 'A pushed version tag gets release notes written from its commits and published as a GitHub release.',
		tags: ['release', 'changelog', 'github'],
		nodeTypes: ['start', 'shell', 'summarize', 'write_file', 'slack_message', 'end'],
		permissions: ['agent', 'shell', 'network', 'filesystem', 'messaging'],
	}),
	builtIn({
		id: 'uptime-check', name: 'Uptime check every 5 minutes', icon: 'pulse', yaml: UPTIME_CHECK,
		description: 'Requests a URL every five minutes and tells Slack when it is down or slow.',
		tags: ['monitoring', 'uptime', 'slack', 'schedule'],
		nodeTypes: ['start', 'http', 'if', 'slack_message', 'end'],
		permissions: ['network', 'messaging'],
	}),
	builtIn({
		id: 'issue-to-draft-pr', name: 'Issue to draft PR', icon: 'issues', yaml: ISSUE_TO_DRAFT_PR,
		description: 'Label an issue "volt" and an agent implements it, tests it and opens a draft pull request.',
		tags: ['github', 'issues', 'coding', 'pull-request'],
		nodeTypes: ['start', 'git_branch', 'agent', 'package_script', 'git_commit', 'git_push', 'github_pr', 'github_issue_comment', 'end', 'loop'],
		permissions: ['agent', 'shell', 'network', 'git'],
	}),
	builtIn({
		id: 'daily-slack-digest', name: 'Daily Slack digest', icon: 'comment-discussion', yaml: DAILY_SLACK_DIGEST,
		description: 'Every weekday morning, the last day\'s commits are summarized and posted to Slack.',
		tags: ['slack', 'digest', 'schedule', 'team'],
		nodeTypes: ['start', 'shell', 'if', 'summarize', 'slack_message', 'end'],
		permissions: ['agent', 'shell', 'network', 'messaging'],
	}),
	builtIn({
		id: 'parallel-research', name: 'Parallel research with fork/join', icon: 'repo-forked', yaml: PARALLEL_RESEARCH,
		description: 'Three agents research a question from different angles at once; a join merges their findings into a report.',
		tags: ['research', 'parallel', 'agents'],
		nodeTypes: ['start', 'fork', 'agent', 'join', 'summarize', 'write_file', 'end'],
		permissions: ['agent', 'filesystem'],
	}),
];

/** Volt's official templates repository (this repo's `workflow-templates/`). */
export const OFFICIAL_TEMPLATE_SOURCE: IWorkflowTemplateSource = {
	id: 'volt-official',
	label: 'Volt',
	url: 'https://github.com/LeulAria/volt/tree/main/workflow-templates',
	official: true,
};

//#region Template facts

/** The node types a workflow uses (in file order) and the permissions they need (gallery chips, index entries). */
export function describeTemplate(definition: Pick<IWorkflowDefinition, 'nodes'>): { readonly nodeTypes: readonly string[]; readonly permissions: readonly WorkflowPermission[] } {
	const nodeTypes: string[] = [];
	const needed = new Set<WorkflowPermission>();
	for (const node of definition.nodes) {
		if (!nodeTypes.includes(node.type)) {
			nodeTypes.push(node.type);
		}
		for (const permission of getWorkflowNodeType(node.type)?.permissions ?? []) {
			needed.add(permission);
		}
	}
	return { nodeTypes, permissions: PERMISSIONS.filter(permission => needed.has(permission)) };
}

/**
 * The checks a template must pass to be published (no errors): the workflow checks, plus what a
 * shared file must not carry (machine paths, provenance) and what the gallery needs (an id, a
 * version, a layout). Unknown node types are errors here: a template has to run in Volt.
 */
export function validateTemplateYaml(text: string): readonly IWorkflowIssue[] {
	const result = parseWorkflowYaml(text);
	const issues: IWorkflowIssue[] = result.issues.map(issue => issue.code === 'unknown-node-type' || issue.code === 'missing-version'
		? { ...issue, severity: 'error', message: issue.code === 'missing-version' ? 'Templates must declare "version: 1"' : `${issue.message}; templates can only use Volt's node types` }
		: issue);
	const definition = result.definition;
	if (!definition) {
		return issues;
	}
	const parsed = parseYaml(text);
	const doc = parsed.value as WorkflowRecord;
	const at = (path: (string | number)[]) => {
		for (let length = path.length; length >= 0; length--) {
			const location = parsed.locate(path.slice(0, length));
			if (location) {
				return { line: location.line, column: location.column };
			}
		}
		return {};
	};
	if (doc.id === undefined) {
		issues.push({ severity: 'error', code: 'template-missing-id', message: 'Templates need an explicit "id" (the file name without .yaml)', ...at([]) });
	}
	if (!definition.description?.trim()) {
		issues.push({ severity: 'warning', code: 'template-missing-description', message: 'Add a "description": the gallery shows it', ...at([]) });
	}
	if (doc.source !== undefined) {
		issues.push({ severity: 'error', code: 'template-source', message: 'Templates cannot set "source": Volt records where a workflow came from when it is installed', path: 'source', ...at(['source']) });
	}
	if (doc.revision !== undefined) {
		issues.push({ severity: 'warning', code: 'template-revision', message: '"revision" is bumped by Volt on save; leave it out of templates', path: 'revision', ...at(['revision']) });
	}
	if (definition.settings?.repository !== undefined) {
		issues.push({ severity: 'error', code: 'template-repository', message: 'Templates cannot set settings.repository: it is a folder on one machine', path: 'settings.repository', ...at(['settings', 'repository']) });
	}
	const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
	nodes.forEach((node, index) => {
		const record = node as WorkflowValue;
		if (record && typeof record === 'object' && !Array.isArray(record) && (record as WorkflowRecord).position === undefined) {
			const id = (record as WorkflowRecord).id;
			issues.push({ severity: 'warning', code: 'template-layout', message: `Give "${typeof id === 'string' ? id : index + 1}" a position so the template opens laid out`, path: `nodes[${index}]`, ...(typeof id === 'string' ? { nodeId: id } : {}), ...at(['nodes', index]) });
		}
	});
	return issues;
}

//#endregion

//#region Template index

const INDEX_ENTRY_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^\\:]+\.yaml$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** A path inside a templates repository: relative, no `..`, no backslashes or schemes, a `.yaml` file. */
export function isSafeTemplatePath(path: string): boolean {
	return INDEX_ENTRY_PATH.test(path) && !path.includes('//');
}

/** Parses and checks an index.json; problems as messages. Valid entries are kept even when others have problems. */
export function parseTemplateIndex(raw: unknown): { readonly index?: IWorkflowTemplateIndex; readonly errors: readonly string[] } {
	let value = raw;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch (error) {
			return { errors: [`index.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
		}
	}
	if (!isPlainObject(value)) {
		return { errors: ['index.json must be an object: { "version": 1, "templates": [ … ] }'] };
	}
	const errors: string[] = [];
	const version = value.version;
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
		errors.push('"version" must be a whole number (1)');
	} else if (version > WORKFLOW_TEMPLATE_INDEX_VERSION) {
		return { errors: [`This template index is for a newer Volt (index version ${version}); update Volt to use it`] };
	}
	if (!Array.isArray(value.templates)) {
		errors.push('"templates" must be a list of { id, name, description, path }');
		return { errors };
	}
	const templates: IWorkflowTemplateEntry[] = [];
	const ids = new Set<string>();
	const paths = new Set<string>();
	value.templates.forEach((entry: unknown, index: number) => {
		const where = `templates[${index}]${isPlainObject(entry) && typeof entry.id === 'string' ? ` (${entry.id})` : ''}`;
		if (!isPlainObject(entry)) {
			errors.push(`${where}: must be an object`);
			return;
		}
		const problems: string[] = [];
		const { id, name, description, path, author, icon, tags, nodeTypes, permissions } = entry;
		if (typeof id !== 'string' || !WORKFLOW_ID_PATTERN.test(id)) {
			problems.push('"id" must be a slug: lower-case letters, digits, "-" and "_", starting with a letter');
		} else if (ids.has(id)) {
			problems.push(`another template already has the id "${id}"`);
		}
		if (typeof name !== 'string' || !name.trim()) {
			problems.push('"name" must be non-empty text');
		}
		if (typeof description !== 'string' || !description.trim()) {
			problems.push('"description" must be non-empty text');
		}
		if (typeof path !== 'string' || !isSafeTemplatePath(path)) {
			problems.push('"path" must be a relative path to a .yaml file inside the repository (templates/<id>.yaml)');
		} else if (paths.has(path)) {
			problems.push(`another template already uses "${path}"`);
		}
		for (const [key, text] of [['author', author], ['icon', icon]] as const) {
			if (text !== undefined && typeof text !== 'string') {
				problems.push(`"${key}" must be text`);
			}
		}
		for (const [key, list] of [['tags', tags], ['nodeTypes', nodeTypes]] as const) {
			if (list !== undefined && !isStringList(list)) {
				problems.push(`"${key}" must be a list of text`);
			}
		}
		if (permissions !== undefined && !(isStringList(permissions) && permissions.every(permission => PERMISSIONS.includes(permission as WorkflowPermission)))) {
			problems.push(`"permissions" must be a list of ${PERMISSIONS.join(', ')}`);
		}
		if (problems.length) {
			errors.push(...problems.map(problem => `${where}: ${problem}`));
			return;
		}
		ids.add(id as string);
		paths.add(path as string);
		templates.push({
			id: id as string,
			name: name as string,
			description: description as string,
			path: path as string,
			...(author !== undefined ? { author: author as string } : {}),
			...(icon !== undefined ? { icon: icon as string } : {}),
			...(tags !== undefined ? { tags: tags as string[] } : {}),
			...(nodeTypes !== undefined ? { nodeTypes: nodeTypes as string[] } : {}),
			...(permissions !== undefined ? { permissions: permissions as WorkflowPermission[] } : {}),
		});
	});
	return { index: { version: typeof version === 'number' && version >= 1 ? version : WORKFLOW_TEMPLATE_INDEX_VERSION, templates }, errors };
}

//#endregion

//#region Sources

export interface IResolvedTemplateSource {
	readonly indexUrl?: string;
	readonly singleYamlUrl?: string;
	/** Base URL that index entry paths resolve against (ends with `/`). */
	readonly rawBase?: string;
	readonly error?: string;
}

const RAW_HOST = 'https://raw.githubusercontent.com';

function folderOf(url: URL): string {
	const base = new URL(url.href);
	base.search = '';
	base.pathname = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
	return base.href;
}

function fromFolder(base: string): IResolvedTemplateSource {
	const folder = base.endsWith('/') ? base : `${base}/`;
	return { indexUrl: `${folder}index.json`, rawBase: folder };
}

function fromFile(url: URL): IResolvedTemplateSource | undefined {
	const name = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
	if (/\.ya?ml$/i.test(name)) {
		return { singleYamlUrl: url.href, rawBase: folderOf(url) };
	}
	if (/\.json$/i.test(name)) {
		return { indexUrl: url.href, rawBase: folderOf(url) };
	}
	return undefined;
}

/**
 * Where to fetch a source from: a GitHub repo/tree URL becomes raw.githubusercontent.com URLs of
 * its index.json and file base; a raw index.json or .yaml URL is used as is.
 */
export function resolveTemplateSource(url: string): IResolvedTemplateSource {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return { error: 'Not a URL: give a GitHub repository URL, or an https URL of an index.json or a .yaml file' };
	}
	if (parsed.protocol !== 'https:') {
		return { error: 'Template sources must use https://' };
	}
	if (parsed.username || parsed.password) {
		return { error: 'A template source URL cannot hold a user name or password' };
	}
	parsed.hash = '';
	const host = parsed.hostname.toLowerCase();
	const parts = parsed.pathname.split('/').filter(Boolean);

	if (host === 'github.com' || host === 'www.github.com') {
		if (parts.length < 2) {
			return { error: 'A GitHub URL needs the owner and the repository: https://github.com/<owner>/<repo>' };
		}
		const [owner, repository, kind, ref, ...rest] = parts;
		const repo = repository.replace(/\.git$/i, '');
		if (kind === undefined) {
			return fromFolder(`${RAW_HOST}/${owner}/${repo}/HEAD/`);
		}
		if (kind === 'tree' && ref) {
			return fromFolder(`${RAW_HOST}/${[owner, repo, ref, ...rest].join('/')}/`);
		}
		if (kind === 'blob' && ref && rest.length) {
			return fromFile(new URL(`${RAW_HOST}/${[owner, repo, ref, ...rest].join('/')}`))
				?? { error: 'A GitHub file URL must point at an index.json or a .yaml template' };
		}
		return { error: 'Unsupported GitHub URL: use the repository, a /tree/<branch>/<folder> URL, or a /blob/<branch>/<file>.yaml URL' };
	}
	if (host === 'raw.githubusercontent.com') {
		if (parts.length < 3) {
			return { error: 'A raw.githubusercontent.com URL needs the owner, the repository and a branch' };
		}
		return fromFile(parsed) ?? fromFolder(`${parsed.origin}${parsed.pathname}`);
	}
	return fromFile(parsed) ?? { error: 'Give a GitHub repository URL, or a direct https URL of an index.json or a .yaml file' };
}

/** The URL of an index entry's file under a source's base; undefined when the path would leave it. */
export function resolveTemplateFileUrl(rawBase: string, path: string): string | undefined {
	if (!isSafeTemplatePath(path)) {
		return undefined;
	}
	try {
		const url = new URL(path.split('/').map(encodeURIComponent).join('/'), rawBase).href;
		return url.startsWith(rawBase) ? url : undefined;
	} catch {
		return undefined;
	}
}

//#endregion

//#region Index JSON Schema

/** The JSON Schema of a templates repository's index.json (`workflow-templates/schema/index.schema.json`). */
export const WORKFLOW_TEMPLATE_INDEX_JSON_SCHEMA: { readonly [key: string]: WorkflowValue } = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: 'https://raw.githubusercontent.com/LeulAria/volt/main/workflow-templates/schema/index.schema.json',
	title: 'Volt workflow template index',
	description: 'The templates a Volt templates repository offers. Each entry points at a workflow YAML file in the repository.',
	type: 'object',
	required: ['version', 'templates'],
	additionalProperties: false,
	properties: {
		$schema: { type: 'string' },
		version: { const: WORKFLOW_TEMPLATE_INDEX_VERSION },
		templates: {
			type: 'array',
			items: {
				type: 'object',
				required: ['id', 'name', 'description', 'path'],
				additionalProperties: false,
				properties: {
					id: { description: 'The template\'s id: also its workflow id and file name.', type: 'string', pattern: WORKFLOW_ID_PATTERN.source },
					name: { type: 'string', minLength: 1 },
					description: { description: 'One or two sentences for the gallery.', type: 'string', minLength: 1 },
					path: { description: 'The YAML file, relative to the index (templates/<id>.yaml).', type: 'string', pattern: INDEX_ENTRY_PATH.source },
					author: { type: 'string' },
					tags: { type: 'array', items: { type: 'string' } },
					icon: { description: 'A codicon id (git-pull-request, robot, tag).', type: 'string' },
					nodeTypes: { description: 'The node types the template uses.', type: 'array', items: { type: 'string' }, uniqueItems: true },
					permissions: { description: 'What the template needs to run for real.', type: 'array', items: { enum: PERMISSIONS }, uniqueItems: true },
				},
			},
		},
	},
};

//#endregion
