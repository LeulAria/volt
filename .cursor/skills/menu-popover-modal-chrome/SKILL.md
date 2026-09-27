---
name: menu-popover-modal-chrome
description: >-
  Paint Volt menus, popovers, modals, flyouts, dropdowns, and hover cards with
  the editor background and the widget border. Use when adding or restyling
  those surfaces, or when the user mentions menu, popover, modal, flyout, or
  dropdown background or border.
---

# Menu, popover, and modal chrome

Menus, popovers, and modals use the editor fill and the widget stroke. Same rule for flyouts, dropdown panels, and hover cards that act as popovers.

```css
background: var(--vscode-editor-background, #1e1e1e);
border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.1));
```

Light themes:

```css
background: var(--vscode-editor-background, #ffffff);
border: 1px solid var(--vscode-widget-border, rgba(0, 0, 0, 0.1));
```

Do not fill these surfaces with `--vscode-menu-background` or `--vscode-editorWidget-background`. Do not stroke them with `--vscode-menu-border` or `--vscode-editorWidget-border`. Those tokens diverge from the editor and make the panel look like a different material.
