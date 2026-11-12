/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../../../base/common/event.js';
import type { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * The Claude accounts feature's contract: what the rest of Volt may use of it. Its section of
 * Providers & Models > Claude (the saved accounts, Add account, Switch, Forget, automatic
 * switching) is a module of the `volt.claude-accounts` built-in extension
 * (`browser/voltClaudeAccounts.module.ts`), loaded when that page first shows the section and
 * unloaded when the extension is disabled. The broker that writes Claude Code's login under
 * Claude's locks is core (`IVoltAccountsService`, main process) and follows the extension too.
 */

export const CLAUDE_ACCOUNTS_FEATURE_ID = 'claudeAccounts';

/** What Providers & Models lends the section to draw with (its rows, buttons and terminal). */
export interface IClaudeAccountsSectionHost {
	/** Cleared before each redraw. */
	renderStore(): DisposableStore;
	rerender(): void;
	/** Claude's page is the one on screen. */
	isShowing(): boolean;
	/** Shows the window under Settings, so the sign-in terminal can be used. */
	revealWorkbench(): void;
	sectionTitle(parent: HTMLElement, title: string, hint?: string): HTMLElement;
	link(parent: HTMLElement, label: string, icon: ThemeIcon, run: () => void): HTMLElement;
	button(parent: HTMLElement, label: string, kind: 'primary' | 'ghost', tooltip: string, run: () => void, icon?: ThemeIcon): HTMLElement;
	row(group: HTMLElement, title: string, desc?: string): HTMLElement;
	switch(parent: HTMLElement, on: boolean, label: string, onClick: () => void): HTMLElement;
	dropdown(parent: HTMLElement, ariaLabel: string, value: string, options: readonly { readonly id: string; readonly label: string }[], onChange: (value: string) => void): void;
	valueRow(group: HTMLElement, title: string, value: string | undefined): void;
	/** Writes `text` with its email addresses blurred until hovered. */
	privateText(parent: HTMLElement, text: string): void;
	/** Runs Claude's sign-in `command` in a terminal; the event fires when the terminal closes. */
	runInTerminal(command: string): Promise<Event<unknown>>;
	/** The login changed: ask Claude Code again who it is signed in as. */
	refreshProvider(): Promise<void>;
}

/** The accounts section of Providers & Models > Claude. */
export interface IClaudeAccountsSection extends IDisposable {
	render(parent: HTMLElement): void;
}

/** What the loaded module gives core (`IVoltFeatureModuleService.activate('claudeAccounts')`). */
export interface IVoltClaudeAccountsModule {
	/** Undefined where there is no accounts broker (the browser workbench). Disposed with the module if it unloads first. */
	createProvidersSection(instantiationService: IInstantiationService, host: IClaudeAccountsSectionHost): IClaudeAccountsSection | undefined;
}
