# Volt Automations & Workflows — plan and shared contracts

Built 2026-11-02 on branch `volt/04f3c302` (worktree `~/.volt/worktrees/-ey1qf4/volt-04f3c302`).

Automations gets a calendar (month / week / day / agenda) and minute-level, timezone-aware and
one-time schedules; its editor gets a composer-like instructions box and a Workflow picker. A new
**Workflows** feature adds a visual node builder, a shared execution engine with simulation and
step debugging, YAML as the canonical format, and community templates fetched from GitHub.

**Status (2026-11-02):** built and verified live in a dev instance (library, templates, builder,
simulation, real shell run, error routing, cancellation, automation editor, calendar). The calendar's
Day / Week / Month views are the ones approved in worktree `volt-2f134f95` (ported as is, chips
restyled without one-sided accents); the tables below describe how the work was split.

Inspiration: cezar.run workflows (node list, ports `done`/`failed`, loop node, YAML panel,
simulate), n8n (executions list, logs panel with input/output, node states), Postman Flows (blocks
panel, typed ports, run bar). Everything is built with Volt's own components and theme.

## Architecture

```
services/voltRuntime/common/workflows/      pure, no DOM (bun-testable)
  workflowTypes.ts        CONTRACT: definition, node type descriptor, runs, events, engine host, IWorkflowService
  workflowNodes.ts        registry lookups (getWorkflowNodeType, defaultNodeConfig, nodeOutputs, …)
  workflowNodeCatalog.ts  every node type (start, agent, if, loop, shell, http, git…, MCP, skills, data, outputs)
  workflowExpressions.ts  safe expressions + {{ }} templates (no eval)
  workflowGraph.ts        validateWorkflow, traversal, autoLayout
  workflowEngine.ts       startWorkflowRun (control nodes, executors, simulation, stepping, cancel)
  workflowYaml.ts         YAML subset parser/serializer with locations
  workflowSchema.ts       YAML ⇄ definition, migrations, canonical serialization, JSON Schema
  workflowTemplates.ts    built-in templates, template index format, GitHub source resolution
services/voltRuntime/common/automations/
  automationCalendar.ts   occurrence expansion for the calendar (dense schedules collapse)
  automationTime.ts       IANA timezone wall-clock helpers (Intl only)
contrib/voltAgent/common/workflows/
  workflowEditorModel.ts  CONTRACT: the builder's single source of truth (definition, undo/redo, selection, dirty)
contrib/voltAgent/browser/workflows/
  workflowService.ts      IWorkflowService: YAML files + revisions + runs, starts the engine
  workflowExecutors.ts    real task executors (agent via orchestrator, shell via IVoltStdioService, http via IRequestService, git, slack…)
  workflowAutomationBridge.ts  workflow triggers ⇄ linked automations; automations that run workflows
  workflows.contribution.ts    registerSingleton + commands
  canvas/                 WorkflowCanvas (camera from scratchBoard/scratchCamera.ts, DOM nodes, SVG edges, minimap)
  workflowBuilderPage.ts  the builder page (stage): top bar, block picker, canvas, inspector, YAML, run panel
  workflowBlockPicker.ts  "Add blocks" panel (WorkbenchList) + hierarchical voltMenu with submenus
  workflowInspector.ts    node config forms from field descriptors
  workflowYamlPanel.ts    Monaco YAML editor synced with the model
  workflowRunPanel.ts     executions: runs, steps, timeline, input/output, variables, logs, tokens
  workflowLibraryPage.ts  my workflows, templates, community sources, import/paste
  workflowTemplateService.ts  fetch/validate/install community templates
contrib/voltAgent/browser/automations/
  automationCalendarView.ts   month/week/day/agenda
  automationRoutes.ts     CONTRACT: routes (list views, workflows, workflow) + host.stage
```

Storage (user roaming data home): `voltWorkflows/<id>.yaml` (canonical), `voltWorkflows/.history/<id>/<rev>.yaml`
(last 50 revisions), `voltWorkflows/.runs/<id>.json` (last 50 runs, outputs truncated), trust store in profile storage.

## Key decisions

- **YAML is the source of truth.** The editor model holds an `IWorkflowDefinition`; saving writes canonical
  YAML (`serializeWorkflow`). The YAML panel parses on change (debounced) and `model.replace(...)`s when valid;
  invalid YAML shows markers and never clobbers the canvas.
- **One scheduler.** A workflow whose trigger is `schedule` or `event` is carried out by a linked automation
  (`templateId: 'workflow:<id>'`, `workflowId: <id>`). Automations with `workflowId` run the workflow instead
  of sending the prompt directly; the automation run tracks the workflow run.
- **Safe by construction.** Expressions are parsed by our own small parser; no `eval`/`Function`. Shell
  commands are only run by `shell`/`check` nodes, for real runs, in trusted workflows. Community / imported
  workflows are untrusted until the user reviews the permission list and trusts that content hash.
  Templates never run on install.
- **Simulation runs the real engine** with simulated executors (`IWorkflowNodeType.simulate`, pinned
  outputs, failure injection, paced so the canvas animates). Step mode pauses before each node.
- **DAG first, loops bounded.** Cycles are allowed only through a `loop` node (max iterations) and every run
  has a step budget (`settings.maxSteps`, hard cap 2000).

## Conventions (read before writing UI)

- Read `.claude/skills/volt-lists/SKILL.md`, `.claude/skills/volt-ui-controls/SKILL.md`,
  `.claude/skills/volt-transparent-window/SKILL.md`. Every list of rows is a `WorkbenchList`/tree, edge to edge.
  Choices use `createVoltDropdown` (`ui/dropdown/voltDropdown.ts`) or `showVoltMenu` (`ui/menu/voltMenu.ts`,
  supports search, sections, flyout submenus, checks, badges); buttons `createVoltButton` (`chrome/voltButton.ts`)
  or the Automations `button()` helpers. Never a native `<select>`, never `backdrop-filter`.
- Model choice: `AgentModelPicker` (`picker/agentModelPicker.ts`), as the automation editor already does.
- Theme colours only (`--vscode-*`, `color-mix`); node colours map to `--vscode-charts-*` /
  `--vscode-terminal-ansi*`. UI font is the system font; Geist Mono only for code.
- Tooltips: `setAgentTooltip`. Icons: codicons (`ThemeIcon.fromId(type.icon)`), Automations' own icon helpers.
- Localize user-visible strings with `localize('voltWorkflows.xxx', "…")` (`voltAutomations.xxx` in automations files).
- CSS class prefixes: `.volt-auto-*` (automations), `.volt-auto-cal-*` (calendar), `.volt-wf-*` (workflows).
  New CSS files: `media/agentAutomationCalendar.css`, `media/agentAutomationComposer.css`,
  `media/agentWorkflowCanvas.css`, `media/agentWorkflowBuilder.css`, `media/agentWorkflowLibrary.css`.
- Comments: short, plain, explain why; match the surrounding files (see `automations.ts`).
- Type check (scoped, filtered to our files): `/tmp/volt-auto-tc.sh`. Pure tests: `bun build/volt/bun/test.mjs <dir>`
  (only `test/common` suites). Lint a file: `node build/eslint <files>` is heavy; prefer `npx eslint <files>`.
- Do not run `git commit`, `git stash`, or touch files another workstream owns (see ownership below). If you
  need a change in someone else's file, keep it minimal and in a clearly separate region, and say so in your report.

## Ownership

| Workstream | Owns |
|---|---|
| A calendar & cron | automations.ts (schedule parts), automationCron.ts, automationTime.ts, automationCalendar.ts, automationCalendarView.ts, automationListView.ts, automationPickers.ts (schedule menus), automationScheduleRow.ts (extracted from the detail view), automationTemplates.ts, agentAutomationCalendar.css, tests |
| B automation editor | automationDetailView.ts (except the schedule row), automationComposer*.ts, agentAutomationComposer.css, detail-section rules of agentAutomations.css |
| C1 YAML & templates | workflowYaml.ts, workflowSchema.ts, workflowTemplates.ts, workflow-templates/**, build/volt/workflows/**, .github/workflows/workflow-templates.yml, pre-commit hook, tests |
| C2 engine | workflowNodeCatalog.ts, workflowExpressions.ts, workflowGraph.ts, workflowEngine.ts, tests |
| D service | workflowService.ts, workflowExecutors.ts, workflowAutomationBridge.ts, workflows.contribution.ts, the workflow hook in automationService.ts |
| E canvas | browser/workflows/canvas/**, agentWorkflowCanvas.css |
| F1 builder | workflowBuilderPage.ts, workflowBlockPicker.ts, workflowInspector.ts, workflowFieldEditors.ts, workflowYamlPanel.ts, agentWorkflowBuilder.css |
| F2 runs & library | workflowRunPanel.ts, workflowLibraryPage.ts, workflowTemplateService.ts, agentWorkflowLibrary.css |
| Orchestrator | workflowTypes.ts, workflowNodes.ts, workflowEditorModel.ts, automationRoutes.ts, automationsEditor.ts, this file |

Contract files are shared: if one must change, make the smallest additive change and report it.
