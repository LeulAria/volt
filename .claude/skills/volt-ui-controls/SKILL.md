---
name: volt-ui-controls
description: Rules for any Volt UI that offers a choice or an action (settings pages, onboarding, dialogs, agent window, composer). Load before adding a dropdown, select, segmented control, or button. Never use native <select> or monaco SelectBox; use createVoltDropdown and createVoltButton.
---

# Volt UI controls: one dropdown, one button

## Dropdowns: never a native select

**Never** use a native `<select>`, monaco `SelectBox`, `getSelectBoxStyles`, or a segmented control for a choice in Volt UI.
They render as the OS popup (plain white-on-grey list, system font, no check marks) and look broken next to Volt.

Always use the Volt dropdown: the pill-and-menu control used by the composer's "Full access" picker.

```ts
import { createVoltDropdown } from '../ui/dropdown/voltDropdown.js'; // voltAgent/browser/ui/dropdown/voltDropdown.ts

createVoltDropdown(parent, contextViewService, {
	options: [
		{ id: 'inside', label: localize('x.inside', "Inside Volt"), description: localize('x.insideDesc', "Opens links in a Volt browser tab."), icon: Codicon.globe },
		{ id: 'external', label: localize('x.external', "Default Browser") },
	],
	value: current,
	ariaLabel: localize('x.aria', "Open links in"),
	onChange: id => save(id),
}, store);
```

- Pass the page's render `DisposableStore` as `store` so the menu closes when the page re-renders.
- Give options a `description` when the difference is not obvious, and an `icon` where one helps.
- This covers settings, onboarding, dialogs, and the agent window.

## Buttons

Use `createVoltButton(parent, 'primary' | 'secondary' | 'ghost' | 'danger')` from `voltAgent/browser/chrome/voltButton.ts`.
For plain `<button>`s, use `voltButtonClasses(kind)`. Never use `defaultButtonStyles`. Labels have no trailing "...".

## Checklist before finishing

- `grep -rn "SelectBox\|createElement('select')\|\$('select" <files you touched>` returns nothing.
- Every choice opens the Volt menu, with a check on the current value.
