# Volt workflow templates

This folder is Volt's official templates repository. Volt's **Workflows → Templates** gallery
reads it from GitHub, and any repository laid out the same way can be added as a source of its
own.

A **template** is a Volt workflow saved as a YAML file: a trigger, nodes (agents, shell checks,
git and GitHub steps, branches, loops, messages) and the edges between their ports. Installing a
template copies it into your workflows, where you can open it in the builder, change it,
simulate it and run it.

```
workflow-templates/
  index.json                 the list the gallery shows (one entry per template)
  templates/<id>.yaml        one workflow per file, named after its id
  schema/workflow.schema.json   JSON Schema of a workflow file (editor completion and checks)
  schema/index.schema.json      JSON Schema of index.json
```

## The format

A workflow file is YAML: block maps and lists, `[a, b]` and `{ a: 1 }` flow collections,
plain, `'single'` and `"double"` quoted text, and `|` / `>` blocks for long text. Anchors,
aliases, tags and several documents in one file are not supported. Values that start with
`{{`, `*`, `&`, `!`, `@` or `%` must be quoted (`'{{ inputs.task }}'`, `'*/5 * * * *'`).

```yaml
# The first comment line is a good place for a one-line summary.
version: 1                       # file format version (Volt migrates older ones)
id: implement-and-test           # slug: lower-case letters, digits, - and _; the file name
name: Implement and test
description: |                   # shown in the gallery and the builder
  An agent implements the task, then the tests run.
tags: [coding, tests]

trigger:                         # what starts a run
  type: manual                   # manual | schedule | event
  # type: schedule
  # cron: '0 9 * * 1-5'          # or everyMinutes: 15; timezone: Europe/Berlin
  # type: event
  # provider: github             # github, gitlab, slack, teams, sentry, linear, jira,
  # event: pr.opened             # atlassian, pagerduty, webhook
  # filters: ['payload.ref matches ^refs/tags/v']
  # samplePayload: { ... }       # used by simulations

inputs:                          # values a run starts with: {{ inputs.task }}
  - name: task
    type: string                 # string | number | boolean | json
    description: What to build
    required: true

variables:                       # starting run variables: {{ vars.testCommand }}
  testCommand: npm test

nodes:
  - id: start                    # every workflow has one start node
    type: start
    position: [0, 0]             # canvas position in pixels: [x, y]
  - id: work
    type: agent
    name: Implement              # display name (the type's label when absent)
    position: [280, 0]
    config:                      # the node type's settings
      prompt: |
        {{ inputs.task }}
      mode: Agent                # Agent | Plan | Ask (read-only)
      verdicts: [approve, changes]   # extra output ports the agent ends on
  - id: check
    type: shell
    position: [560, 0]
    config:
      command: '{{ vars.testCommand }}'
      timeout: 10m
    retry: 1                     # extra attempts (or { attempts, delayMs, maxDelayMs })
    onError: route               # fail | continue | route (down the failed port)
  - id: done
    type: end
    position: [840, 0]
    config:
      status: success            # success | failure
      output: '{{ nodes.work.summary }}'

edges:                           # from: <node>.<port>  to: <node>
  - { from: start.next, to: work }
  - { from: work.done, to: check }
  - { from: check.passed, to: done, label: tests pass }
```

Leaving the port out (`from: start`) uses the node's first output port. Ports a node does not
connect end the run there: a failure port fails the run, any other port finishes it.

**Templates.** Text settings can hold `{{ … }}` templates, resolved just before the node runs:
`{{ inputs.task }}`, `{{ vars.name }}`, `{{ trigger.payload.pull_request.title }}`,
`{{ nodes.check.stderr }}` (the output of a node that ran before), `{{ run.id }}`, and inside
loops `{{ item }}` and `{{ loop.iteration }}`. Conditions (`if`, `switch`, `loop`'s `while`,
`filter`) are expressions without braces: `nodes.check.exitCode == 0`,
`len(trim(nodes.log.stdout)) > 0`. They are evaluated by Volt's own small expression language;
nothing in a workflow file is ever run as JavaScript.

**Loops.** A run may only go back to an earlier node through a `loop` node, which counts the
passes (`max`) and leaves through `exhausted` when the limit is reached:

```yaml
  - id: retry
    type: loop
    config: { max: 3 }
edges:
  - { from: check.failed, to: retry }
  - { from: retry.repeat, to: fix }
  - { from: fix.done, to: check }
  - { from: retry.exhausted, to: gave_up }
```

**Node types.** Each type, its settings and its ports are listed in Volt's block picker and in
`schema/workflow.schema.json`. The most used ones:

| Type | Output ports | Settings |
|---|---|---|
| `start` | next | |
| `agent` | your verdicts, done, failed | prompt, model, mode, skill, mcpServers, verdicts, session |
| `classify` / `summarize` | your categories, other / done, failed | text, categories / instructions |
| `if` / `switch` | true, false / your cases, default | condition / value, cases |
| `loop` / `for_each` | repeat, exhausted / item, done | max, while / items |
| `fork` / `join` | branch1..branchN / next | branches / mode (all, any) |
| `approval` / `ask_user` | approved, rejected / answered, timeout | title, detail / question, options |
| `shell` / `package_script` | passed, failed | command, cwd, env, timeout / script |
| `http` / `webhook` | success, fail / sent, failed | method, url, headers, query, body / url, payload |
| `git_branch`, `git_commit`, `git_push`, `git_sync` | created / committed, nothing / pushed / synced, conflict (and failed) | name / message / base |
| `github_pr`, `github_wait_ci`, `github_pr_comment`, `github_update_pr`, `github_issue_comment` | opened / passed, timeout / done (and failed) | title, body, draft / labels, reviewers / issue, body |
| `slack_message`, `teams_message`, `notify`, `log`, `write_file` | sent / next / written (and failed) | webhookUrl, text / title, message / path, content |
| `end` | | status, output |

Secrets such as webhook URLs belong in `variables` with a placeholder value; never commit a real
one to a template.

## Publish a template here

1. Fork this repository.
2. Add your workflow as `workflow-templates/templates/<id>.yaml`. Its `id` must be the file name,
   and it needs `version: 1`, a `description` and a `position` for every node. Build it in Volt
   and copy the YAML from the builder's YAML panel, or write it by hand.
3. Add an entry to `workflow-templates/index.json`:

   ```json
   {
     "id": "my-template",
     "name": "My template",
     "description": "One or two sentences for the gallery.",
     "path": "templates/my-template.yaml",
     "author": "your-github-name",
     "tags": ["github", "review"],
     "icon": "git-pull-request",
     "nodeTypes": ["start", "agent", "github_pr_comment", "end"],
     "permissions": ["agent", "network", "git"]
   }
   ```

   `nodeTypes` lists the node types the template uses and `permissions` what they need to run
   (`agent`, `shell`, `network`, `git`, `filesystem`, `messaging`); the validator tells you the
   exact values when they are wrong.
4. Run the validator from the repository root (it needs [Bun](https://bun.sh)):

   ```sh
   bun build/volt/workflows/validateTemplates.ts
   ```

   It checks `index.json`, parses every template with Volt's own parser, and fails on any
   error (unknown node types, broken edges, unlisted files, ids that do not match file
   names), printing `file:line:column` for each. The pre-commit hook and the
   `Workflow Templates` GitHub Action run the same check.
5. Open a pull request.

## Use your own templates repository

Any public GitHub repository can be a template source. Lay it out like this folder (an
`index.json` next to the YAML files it lists) and add it in Volt: **Workflows → Templates →
Add source**, then paste one of:

- `https://github.com/<owner>/<repo>` (an `index.json` at the repository root),
- `https://github.com/<owner>/<repo>/tree/<branch>/<folder>` (an `index.json` in that folder),
- `https://github.com/<owner>/<repo>/blob/<branch>/<path>.yaml` (a single template),
- a `raw.githubusercontent.com` URL, or any `https://` URL of an `index.json` or a `.yaml` file.

Only `https://` sources are accepted. To check your repository with Volt's validator, point it
at your index: `bun build/volt/workflows/validateTemplates.ts path/to/index.json`.

For completion and checks while you edit, add this first line to a template (VS Code with the
YAML extension, or any editor using yaml-language-server):

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/LeulAria/volt/main/workflow-templates/schema/workflow.schema.json
```

## Safety

Templates are data, not programs, and Volt treats every template from outside Volt as
untrusted:

- Installing a template never runs it. It is saved as a workflow you can read, edit and
  simulate (simulations have no side effects).
- Before a community or imported workflow runs for real the first time, Volt shows what it
  will do (agents, shell commands, network requests, git pushes, messages) and asks you to
  trust it. Trust is tied to the exact content, so any change asks again.
- Shell commands only run in `shell` and `package_script` nodes, and only in trusted
  workflows. Read them before you trust a template, especially when they use values from an
  event payload; pass those through `env` (as the official templates do) rather than pasting
  `{{ … }}` into the command.
