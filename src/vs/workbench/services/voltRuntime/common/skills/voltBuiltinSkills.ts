/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skills that ship with Volt. They appear in the composer's `/` menu next to the skills found on
 * disk; picking one sends its instructions with the prompt. A file on disk with the same name
 * (a project or personal skill) takes precedence over the built-in one.
 */
export interface IVoltBuiltinSkill {
	/** What follows the `/`. */
	readonly name: string;
	/** "Create Skill": the hover card title. */
	readonly title: string;
	/** One line for the menu row. */
	readonly summary: string;
	/** Full description for the hover card and the model. */
	readonly description: string;
	/** Instructions sent to the model when the skill is used. */
	readonly body: string;
	/** Reads like a way of working (explain, review) more than a task: offered as a sticky mode. */
	readonly mode?: boolean;
}

/** Built-in commands act in the app instead of sending instructions. */
export type VoltBuiltinCommandId = 'model' | 'customize' | 'new-chat' | 'usage';

export interface IVoltBuiltinCommand {
	readonly id: VoltBuiltinCommandId;
	readonly name: string;
	readonly title: string;
	readonly description: string;
}

const LOCATIONS = `Volt reads skills, rules, subagents and commands from these folders, in the project and in the home folder:

| Kind | Volt | Shared with other agents |
| --- | --- | --- |
| Skills | \`.volt/skills/<name>/SKILL.md\` | \`.agents/skills\`, \`.claude/skills\`, \`.cursor/skills\`, \`.codex/skills\` |
| Rules | \`.volt/rules/<name>.md\` | \`.cursor/rules/*.mdc\`, \`AGENTS.md\`, \`CLAUDE.md\` |
| Subagents | \`.volt/agents/<name>.md\` | \`.claude/agents\`, \`.cursor/agents\` |
| Commands | \`.volt/commands/<name>.md\` | \`.claude/commands\`, \`.cursor/commands\` |
| Hooks | \`.volt/hooks.json\` | \`.claude/settings.json\`, \`.cursor/hooks.json\` |

Project files (in the repository) are shared with the team through version control. Personal files go under \`~/\` and follow the user to every project.`;

export const VOLT_BUILTIN_SKILLS: readonly IVoltBuiltinSkill[] = [
	{
		name: 'automate',
		title: 'Automate',
		summary: 'Trigger an agent to run based on a trigger or schedule.',
		description: 'Trigger an agent to run based on a trigger or schedule. Use when the user wants work to happen on a timer, on a push or pull request, or after another event, without starting it by hand.',
		body: `# Automate

Set up work that runs without the user starting it: on a schedule, on a repository event, or after another job.

## 1. Pin down the automation

Find out, from the conversation when you can, and ask only for what is missing:

- **Trigger**: a schedule (every weekday at 9:00), a repository event (push, pull request opened, label added), or a file or system event.
- **Task**: what the agent does each time, written as the prompt it will receive.
- **Where it runs**: on this machine (Volt Schedules, cron or launchd) or in CI (GitHub Actions or the project's CI).
- **Output**: a pull request, a comment, a message, a file, or only a log.

## 2. Pick the mechanism

- **Volt Schedules** (this machine, the app open): the simplest choice for a recurring prompt in this project. Tell the user to open **Schedules** in the left menu and create one with the prompt you write, the project, and the time. Write the prompt out in full so it can be pasted.
- **GitHub Actions**: for repository events, or when it must run while the computer is off. Write \`.github/workflows/<name>.yml\` with the right \`on:\` block (\`schedule\` with a cron expression in UTC, \`push\`, \`pull_request\`, \`workflow_dispatch\`). Run the agent CLI the project already uses, and read secrets from \`secrets.*\`, never from the file.
- **cron or launchd**: a local script that must run even when Volt is closed. Write the script, make it executable, and give the exact \`crontab\` line or \`~/Library/LaunchAgents/*.plist\` file.

## 3. Build it

1. Write the prompt the automation sends. It must stand alone: the agent will not see this chat.
2. Create the files (workflow, script, plist) and show the trigger in plain words, with the time zone.
3. Make it safe to repeat: a second run on the same input must not open a duplicate pull request or post the same comment twice.
4. Explain how to run it once by hand (\`workflow_dispatch\`, running the script) so the user can try it now.

## 4. Finish

Summarize the trigger, what runs, where the output goes, and how to stop it.`,
	},
	{
		name: 'autopilot',
		title: 'Autopilot',
		summary: 'Keep a PR merge-ready by triaging comments, resolving clear conflicts, and fixing CI in a loop.',
		description: 'Keep a PR merge-ready by triaging comments, resolving clear conflicts, and fixing CI in a loop.',
		body: `# Autopilot

Keep the current branch's pull request ready to merge. Work in rounds until nothing actionable is left, then report.

## Each round

1. **Find the pull request** for the current branch (\`gh pr view --json number,url,state,mergeable,reviewDecision,statusCheckRollup\`). If there is none, say so and stop.
2. **Sync with the base branch.** Fetch, then merge or rebase the base branch the way the repository already does it. Resolve conflicts only when the right answer is clear from both sides; otherwise stop and describe the conflict.
3. **Fix failing checks.** Read the failing job's log (\`gh run view <id> --log-failed\`). Reproduce the failure locally when you can, fix the cause rather than the symptom, and run the narrowest test that proves the fix.
4. **Triage review comments** (\`gh pr view --comments\`, \`gh api repos/{owner}/{repo}/pulls/{n}/comments\`):
	- A clear, correct request: make the change.
	- A question: answer it in your report; do not post replies on the user's behalf unless asked.
	- A disagreement or a design choice: leave it for the user.
5. **Commit and push** each logical fix separately, with a message that says what changed and why. Never force-push over someone else's commits.

## Stop when

- every check passes and no actionable comment is left, or
- the same check fails twice for a reason you cannot fix, or
- a decision belongs to the user.

## Report

List what you fixed (with commits), what is still failing and why, and the comments that need the user.`,
	},
	{
		name: 'canvas',
		title: 'Canvas',
		summary: 'Create a document, diagram, or small website to express an idea.',
		description: 'Create a document, diagram, or small website to express an idea.',
		body: `# Canvas

Express an idea as something the user can look at: a one-page document, a diagram, a mockup, or a small interactive website.

## Choose the form

- **Diagram** (flow, architecture, sequence, state): a Mermaid block in the reply for something small; a standalone HTML page with inline SVG when it needs layout control or interaction.
- **Document** (a plan, a comparison, a report): a single HTML page with clear headings, or Markdown when the user will edit it.
- **Mockup or prototype**: a single HTML file with inline CSS and JavaScript, no build step and no external network requests except well-known CDNs when truly needed.

## Build it

1. Put the file in the project only if it belongs there; otherwise write it to a scratch location such as \`.volt/canvas/<name>.html\`.
2. Keep it self-contained so it opens straight from disk. Use system fonts, a restrained palette, and real content instead of lorem ipsum.
3. Support light and dark color schemes with \`prefers-color-scheme\`.
4. Open it for the user: Volt shows local HTML files in its browser panel (\`file://\` path) or in a preview tab.

## Finish

Say what the canvas shows and how to change it, in two or three sentences. Do not paste the whole file into the reply.`,
	},
	{
		name: 'code-review',
		title: 'Code Review',
		summary: 'Review code instead of editing it',
		description: 'Review code instead of editing it',
		mode: true,
		body: `# Code Review

Review; do not edit files. The user wants findings, not changes.

## Scope

Review what the user points at. With nothing named, review the uncommitted changes (\`git diff\` and \`git diff --cached\`), and if there are none, the current branch against its base (\`git diff <base>...HEAD\`).

## What to look for, in order

1. **Correctness**: logic errors, wrong conditions, off-by-one, unhandled null or error paths, race conditions, broken invariants.
2. **Security**: injection, missing authorization, secrets in code, unsafe deserialization, path traversal, data leaks in logs.
3. **Data and compatibility**: migrations, API or schema changes that break callers, lost data.
4. **Performance** that matters at real sizes: N+1 queries, quadratic loops over user data, work on the hot path.
5. **Tests**: behavior that changed without a test, tests that cannot fail.
6. **Maintainability**, only when it will cause a bug later: duplication that will drift, misleading names.

Skip style nits a formatter or linter would catch.

## How to report

- Verify each finding by reading the surrounding code; drop anything you cannot support.
- Most severe first. For each: \`path:line\`, what is wrong, a concrete failing scenario, and the fix in one or two sentences (a short snippet when it helps).
- End with a one-line verdict: ready to merge, merge after fixes, or needs rework.`,
	},
	{
		name: 'explain',
		title: 'Explain',
		summary: 'Explain without changing code',
		description: 'Explain without changing code',
		mode: true,
		body: `# Explain

Answer by explaining. Do not edit, create or delete files, and do not run commands that change anything.

- Read the code before you explain it; cite what you rely on as \`path:line\`.
- Start with the short answer in one or two sentences, then the detail.
- Follow the real path: entry point, the calls that matter, where data comes from and where it goes.
- Use a small diagram (Mermaid) when the flow spans several components.
- Say what you are unsure about and how to check it.
- If a change would help, describe it in words and leave the editing to the user.`,
	},
	{
		name: 'new-repo',
		title: 'New Repo',
		summary: 'Create a hosted repo for the current project and push it.',
		description: 'Create a hosted repo for the current project and push it. Use when a project has no git remote yet and the user asks to put it on GitHub, push it, or set up a hosted remote; installs and signs in to the GitHub CLI when needed.',
		body: `# New Repo

Create a hosted repository for the current project and push it.

1. **Check the project.** Run \`git status\`. If it is not a repository, \`git init\` and make sure a sensible \`.gitignore\` exists before the first commit (dependencies, build output, \`.env\` files, OS files). Check \`git remote -v\`: if a remote already exists, stop and ask whether to replace it.
2. **Never commit secrets.** Scan the files about to be added for keys, tokens and \`.env\` files; leave them out and tell the user.
3. **Make the first commit** if there is none: \`git add -A\` and a short message such as "Initial commit".
4. **Get the GitHub CLI ready.** \`gh --version\`; if missing, install it the platform's usual way (\`brew install gh\` on macOS) after asking. Then \`gh auth status\`; if signed out, run \`gh auth login\` in a terminal the user can see, because it is interactive.
5. **Create and push.** Ask for the name (default: the folder name), the owner (personal or an organization) and visibility (default: private). Then:
	\`gh repo create <owner>/<name> --private --source . --remote origin --push\`
6. **Report** the repository URL and the branch that was pushed.`,
	},
	{
		name: 'create-skill',
		title: 'Create Skill',
		summary: 'Create Volt Agent Skills.',
		description: 'Create Volt Agent Skills. Use when authoring a new skill or asking about SKILL.md structure.',
		body: `# Create Skill

A skill is a folder with a \`SKILL.md\` file that teaches the agent a specific task. Volt lists every skill by name and description, and loads the full file only when a task matches, so the description decides when the skill is used.

${LOCATIONS}

## 1. Gather requirements

From the conversation, or by asking only for what is missing:

- **Purpose**: the task the skill performs, and an example request that should trigger it.
- **Scope**: this project (\`.volt/skills/\` in the repository, or \`.agents/skills/\` to share with other agents) or personal (\`~/.volt/skills/\`).
- **Inputs and outputs**: what the agent starts from and what it must produce.
- **Resources**: scripts, templates or reference files the skill needs.

## 2. Write SKILL.md

\`\`\`markdown
---
name: my-skill
description: What it does and when to use it. Name the situations and phrases that should trigger it.
---

# My Skill

Short statement of the goal.

## Steps
1. ...
\`\`\`

- \`name\`: lowercase letters, digits and hyphens; the same as the folder name.
- \`description\`: one to three sentences, third person, specific. Include trigger words the user would say ("deploy", "release notes"). This is the only part the agent sees before loading the skill.
- Body: imperative steps, the decisions to make, concrete commands, and what done looks like. Keep it under about 500 lines; move long references to separate files in the folder and link them by relative path.
- Put helper scripts in \`scripts/\` and tell the agent when to run them. Prefer a script over long instructions for fiddly, repeatable work.

## 3. Check it

- Read the description alone and ask: would an agent pick this skill for the example request, and not for unrelated ones?
- Make sure every file the body mentions exists.
- Tell the user where the skill lives and how to use it: type \`/\` and its name in the composer, or just ask for the task.`,
	},
	{
		name: 'create-rule',
		title: 'Create Rule',
		summary: 'Create Volt rules for persistent AI guidance.',
		description: 'Create Volt rules for persistent AI guidance. Use when you want to create a rule, add coding standards, set up project conventions, configure file-specific patterns, create RULE.md files, or ask about .volt/rules/ or AGENTS.md.',
		body: `# Create Rule

Rules are standing instructions the agent follows without being asked each time: coding standards, project conventions, things to avoid.

${LOCATIONS}

## How a rule applies

Set in the rule's front matter:

| Mode | Front matter | When it is used |
| --- | --- | --- |
| Always Apply | \`alwaysApply: true\` | Every chat. Keep these short. |
| Apply Intelligently | \`description: ...\`, \`alwaysApply: false\` | When the agent decides the description matches the task. |
| Apply to Specific Files | \`globs: src/**/*.ts\` | When the agent reads or edits a matching file. |
| Apply Manually | no description, no globs | Only when the user mentions the rule with \`/\` or \`@\`. |

## Write the rule

\`\`\`markdown
---
description: Keep imports at the top of the file
globs:
alwaysApply: true
---

# No inline imports

Always place imports at the top of the module...
\`\`\`

1. Ask for anything missing: what the rule enforces, project or personal, and which mode.
2. One topic per rule, named after it in kebab case (\`no-inline-imports.md\`).
3. State the rule, the reason, and a short good and bad example. Be concrete enough that compliance can be checked.
4. Keep always-apply rules brief: they cost context in every chat. Prefer globs for language- or folder-specific rules.
5. A single short project-wide convention can also go in \`AGENTS.md\` at the repository root, which every agent reads.

Tell the user the file path and the mode you chose.`,
	},
	{
		name: 'create-hook',
		title: 'Create Hook',
		summary: 'Trigger an action to run when a certain event occurs.',
		description: 'Trigger an action to run when a certain event occurs. Use when you want to create a hook, write hooks.json, add hook scripts, or automate behavior around agent events.',
		body: `# Create Hook

Hooks run a command when an agent event happens: before a shell command, after a file edit, when the agent stops. They can audit, block, or follow up.

${LOCATIONS}

## 1. Gather requirements

- **Event**: before or after a tool or shell command, after a file edit, on prompt submit, when the session starts or stops.
- **Behavior**: log, block with a reason, rewrite, or run a follow-up (format, lint, notify).
- **Scope**: project (checked in) or personal.
- **Failure policy**: if the hook itself errors, should the action continue (fail open) or stop (fail closed)?

## 2. Pick the file for the agent in use

- **Volt and Cursor** (\`.volt/hooks.json\`, \`.cursor/hooks.json\`):

\`\`\`json
{
	"version": 1,
	"hooks": {
		"beforeShellExecution": [{ "command": ".volt/hooks/check-command.sh" }],
		"afterFileEdit": [{ "command": ".volt/hooks/format.sh" }]
	}
}
\`\`\`

- **Claude Code** (\`.claude/settings.json\` or \`~/.claude/settings.json\`):

\`\`\`json
{
	"hooks": {
		"PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "./.claude/hooks/check-command.sh" }] }]
	}
}
\`\`\`

## 3. Write the script

- Read the event JSON from stdin; write a JSON answer to stdout when the event expects one; exit 0 on success.
- To block, follow the format of the agent in use (for Claude Code, exit code 2 with the reason on stderr).
- Keep it fast (well under a second for before-events), quote every variable, and never print secrets.
- \`chmod +x\` the script and use a path relative to where hooks run (the project root for project hooks).

## 4. Check it

Run the script once by hand with a sample event on stdin and show the output. Tell the user which file you changed and how to turn the hook off.`,
	},
	{
		name: 'create-subagent',
		title: 'Create Subagent',
		summary: 'Create custom subagents for specialized AI tasks.',
		description: 'Create custom subagents for specialized AI tasks. Use when you want to create a new type of subagent, set up task-specific agents, configure code reviewers, debuggers, or domain-specific assistants with custom prompts.',
		body: `# Create Subagent

A subagent is a specialist the main agent can delegate to. It runs with its own instructions and context window and returns a report, which keeps the main chat focused.

${LOCATIONS}

## 1. Gather requirements

- **Job**: the one kind of task it handles (review, test triage, research, migration).
- **When to delegate**: the situations where the main agent should hand off. This becomes the description.
- **Tools**: read-only (investigates and reports) or allowed to edit.
- **Model**: inherit from the parent chat unless a faster or stronger model fits the job.
- **Scope**: project (\`.volt/agents/\`) or personal (\`~/.volt/agents/\`).

## 2. Write the file

\`\`\`markdown
---
name: security-reviewer
description: Reviews changes for security problems. Use after edits that touch authentication, input handling or secrets.
model: inherit
readonly: true
is_background: false
---

You are a security reviewer. ...
\`\`\`

- \`name\`: lowercase with hyphens; the file name without \`.md\`.
- \`description\`: when to delegate, specific enough that the main agent picks it at the right moments.
- \`model\`: \`inherit\` or a model id.
- \`readonly\`: \`true\` when it must not edit files.
- \`is_background\`: \`true\` to let it run while the main chat continues.
- Body: the role, the method step by step, the boundaries, and the exact shape of the report it returns.

For Claude Code, the same file in \`.claude/agents/\` works; it uses \`tools:\` to list allowed tools instead of \`readonly\`.

## 3. Finish

Tell the user the path, when the main agent will use it, and how to call it directly.`,
	},
];

export const VOLT_BUILTIN_COMMANDS: readonly IVoltBuiltinCommand[] = [
	{ id: 'model', name: 'model', title: 'Model', description: 'Switch the model for this chat' },
	{ id: 'customize', name: 'customize', title: 'Customize', description: 'Open Skills, Rules, MCPs and Plugins' },
	{ id: 'new-chat', name: 'new', title: 'New Chat', description: 'Start a new chat' },
	{ id: 'usage', name: 'usage', title: 'Usage', description: 'Show cost, tokens and limits' },
];

export function findBuiltinSkill(name: string): IVoltBuiltinSkill | undefined {
	const key = name.trim().toLowerCase();
	return VOLT_BUILTIN_SKILLS.find(skill => skill.name === key);
}

/** "create-skill" → "Create Skill": the card title for skills found on disk. */
export function skillTitle(name: string): string {
	return name
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map(word => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

/** The block sent with a prompt that used `/name`: the model follows it for this message. */
export function skillPromptBlock(name: string, body: string, folder?: string): string {
	const location = folder ? ` path="${folder}"` : '';
	return `<skill name="${name}"${location}>\nThe user invoked the /${name} skill for this message. Follow these instructions.\n\n${body.trim()}\n</skill>`;
}
