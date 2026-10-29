---
name: volt-lists
description: Rules for any list of rows in Volt UI (sidebars, the chat's side toolbar, hover cards, pickers, dialogs, trays, settings pages). Load before rendering more than one similar row. Every list is a VS Code list or tree widget (WorkbenchList / WorkbenchObjectTree / WorkbenchAsyncDataTree), never hand-built divs, and its rows run edge to edge with no margin, no padding around the list (top, bottom or sides) and no rounded corners, like "Previous agents".
---

# Volt lists: a VS Code list, rows edge to edge

The user has asked for this many times. Do not make them ask again.

## The rule

1. **Any list of rows uses VS Code's list or tree widget**, never `div`s with their own hover CSS.
   - Flat rows: `WorkbenchList` (`platform/list/browser/listService.ts`).
   - Folders/children: `WorkbenchObjectTree`, or `WorkbenchAsyncDataTree` when children load lazily.
   - Create it with `instantiationService.createInstance(...)`, and open rows through `list.onDidOpen`, not your own click listeners.
   - This gives keyboard navigation, focus, screen-reader labels, and the theme's hover and selection colors for free.
2. **Rows run edge to edge on every side: no margin, no padding around the list, no rounded corners.**
   - The hover/selection background spans the container's full width, square. Reference: "Previous agents" in the chat's side toolbar.
   - Put the side padding *inside* the row template (`padding: 0 12px`), never as a margin on the row or list.
   - Inside a padded container (a card, a panel), cancel the container's padding with a negative margin on the list host (`margin: 0 -12px`), so rows reach the edges and the icons still line up with the container's other content.
   - **No top or bottom padding either.** A list that starts a container sits on its top edge; one that ends it sits on its bottom edge; one under a hairline starts right under the hairline. The first and last row's highlight touches the container's edge (the container's `border-radius` with `overflow: hidden` clips the corners). A card that is only a list has `padding: 0 12px`, not `6px 12px`.
   - Set `.my-list .monaco-list-row { border-radius: 0; }` and do not add a margin, gap or radius to rows.
3. **Hairlines run the container's full width.** A divider between a card's details and its list goes through the side padding to both edges (`margin: 2px -12px` in a 12px-padded card), never inset.
4. **Use the theme's list colors.** Do not restyle hover, focus or selection with your own colors. Never paint a background on the list that differs from its container.

## Examples to copy

- `voltAgent/browser/chrome/agentLineageDock.ts` (`LineageGroup`): Previous agents, the reference look. CSS: `.volt-agent-lineage-list` / `.volt-agent-lineage-row` in `media/agentSubagents.css`.
- `voltAgent/browser/pullRequests/agentPullRequestList.ts` (`renderPullRequestList`): a list inside a hover card, used by the sidebar row card and the PR chip card. CSS: `.volt-pr-link-list` in `media/agentPullRequests.css`.
  - PR chip card (only the list): `.volt-pr-hover-card.list { padding: 0 12px; overflow: hidden; }`.
  - Sidebar row card (details, hairline, list): the tooltip wraps a `render` row in `.volt-agent-tooltip-card-block`; `media/agentTooltip.css` pulls it up under the full-width `.volt-agent-tooltip-card-sep` and down onto the card's bottom edge.
- `voltAgent/browser/pullRequests/agentCommitPlanTray.ts`: a tree with checkboxes (the commit review).

## Traps

- **List rows give the container no width.** Rows are absolutely placed, so a shrink-to-fit container (a hover card, a popup) collapses to its min-width. Give the container a set width when it holds a list (see `.volt-agent-tooltip.card.has-block`).
- **The list needs a height.** Set the host's height to `rows × rowHeight` and call `list.layout(height)` before `list.splice(...)`, or nothing renders.
- **A flex container's `gap` and padding come back as space above and below the list.** Cancel them on the list's wrapper with negative margins (`margin-top: -(gap + hairline margin)`, `margin-bottom: -(padding-bottom)` when last), not by removing the container's padding for its other rows.
- **Codicon size and color lose to `.monaco-workbench .codicon[class*='codicon-']`.** Style row icons with 4-class selectors (for example `.my-list .my-icon .codicon[class*='codicon-']`) and check the computed style.
- **Dispose the list with whatever shows it.** In a card that redraws on every hover, keep it in a `DisposableStore` cleared on redraw and on hide (the tooltip's `render` rows do this).
- **Transparent window:** no `backdrop-filter`, and an opaque or near-opaque surface behind scrolling lists (load `volt-transparent-window`).

## Checklist before finishing

- Every new run of similar rows is a `WorkbenchList` or Workbench tree: `grep -n "WorkbenchList\|WorkbenchObjectTree\|WorkbenchAsyncDataTree" <files you touched>`.
- No `border-radius` or `margin` on rows in your CSS: `grep -n "radius\|margin" <your css>` around the row selectors.
- In the running app, hover a row and check that its highlight touches both sides of the container, square, and hover the first and last rows to check there is no strip of padding above or below them.
- Any hairline next to the list reaches both edges of its container.
