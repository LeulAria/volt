/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { promises as fs } from 'fs';
import { basename, join } from 'path';
import { Application, ActivityBarPosition, Logger } from '../../../../automation';
import { installAllHandlers } from '../../utils';

export function setup(logger: Logger) {
	describe('Preferences', () => {

		// Shared before/after handling
		installAllHandlers(logger);

		it('turns off editor line numbers and verifies the live change', async function () {
			const app = this.app as Application;

			await app.workbench.settingsEditor.openUserSettingsFile();
			await app.code.waitForElements('.line-numbers', false, elements => !!elements.length);

			await app.workbench.settingsEditor.addUserSetting('editor.lineNumbers', '"off"');
			await app.code.waitForElements('.line-numbers', false, elements => !elements || elements.length === 0);
		});

		it.skip('changes "workbench.action.toggleSidebarPosition" command key binding and verifies it', async function () {
			const app = this.app as Application;

			await app.workbench.activitybar.waitForActivityBar(ActivityBarPosition.LEFT);

			await app.workbench.keybindingsEditor.updateKeybinding('workbench.action.toggleSidebarPosition', 'View: Toggle Primary Side Bar Position', 'ctrl+u', 'Control+U');

			await app.code.dispatchKeybinding('ctrl+u', () => app.workbench.activitybar.waitForActivityBar(ActivityBarPosition.RIGHT));
		});
	});

	describe('Volt Settings', () => {
		installAllHandlers(logger);

		it('closes Settings with one Back after a split command and can reopen it', async function () {
			const app = this.app as Application;
			const page = app.code.driver.currentPage;
			const workbenchGrid = page.locator('.monaco-workbench > .monaco-grid-view');
			const overlays = page.locator('.monaco-workbench > .volt-settings-overlay');
			const back = () => overlays.getByRole('button', { name: 'Close settings' }).click();

			await app.workbench.quickaccess.runCommand('View: Agent Mode', { exactLabelMatch: true });
			await app.workbench.quickaccess.runCommand('Preferences: Volt Settings', { exactLabelMatch: true });
			await overlays.first().waitFor();
			await workbenchGrid.waitFor({ state: 'hidden' });

			await app.workbench.quickaccess.runCommand('View: Split Editor into Right Group', { exactLabelMatch: true });
			await back();
			await overlays.first().waitFor({ state: 'detached' });
			await workbenchGrid.waitFor({ state: 'visible' });

			await app.workbench.quickaccess.runCommand('Preferences: Volt Settings', { exactLabelMatch: true });
			await workbenchGrid.waitFor({ state: 'hidden' });
			await back();
			await overlays.first().waitFor({ state: 'detached' });
			await workbenchGrid.waitFor({ state: 'visible' });
		});

		it('opens a Skill directly from Agent Settings and returns to the list', async function () {
			const app = this.app as Application;
			const page = app.code.driver.currentPage;
			const skills = join(app.workspacePathOrFolder, '.agents', 'skills');
			await fs.mkdir(skills, { recursive: true });
			const folder = await fs.mkdtemp(join(skills, 'volt-settings-smoke-'));
			const name = basename(folder);
			const file = join(folder, 'SKILL.md');
			const content = `---\nname: ${name}\ndescription: Settings Skill fixture\n---\n\n# Settings Skill fixture\n`;
			try {
				await fs.writeFile(file, content);
				await app.workbench.quickaccess.runCommand('View: Agent Mode', { exactLabelMatch: true });
				await page.locator('.volt-agent-editor[data-session-id]:visible').waitFor();
				const tools = page.locator('.volt-agent-tools-area:visible');
				if (!await tools.isVisible()) {
					await app.workbench.quickaccess.runCommand('Toggle Right Panel', { exactLabelMatch: true });
				}
				await tools.waitFor();
				const mainGroups = page.locator('.monaco-workbench > .monaco-grid-view .part.editor .editor-group-container');
				const initialGroups = await mainGroups.count();
				await app.workbench.quickaccess.runCommand('Preferences: Volt Settings', { exactLabelMatch: true });
				const overlay = page.locator('.monaco-workbench > .volt-settings-overlay');
				await overlay.locator('.volt-settings-nav-label').filter({ hasText: 'Skills & Plugins' }).click();
				const search = overlay.locator('.volt-customize-search-input');
				const skillEditor = page.locator('.volt-skill-editor:visible');
				const installedSkill = overlay.locator('.volt-ares-row-name').filter({ hasText: name });
				await installedSkill.waitFor();
				await fs.unlink(file);
				await installedSkill.click();
				await page.locator('.notification-list-item-message').filter({ hasText: 'The editor could not load SKILL.md' }).waitFor();
				await fs.writeFile(file, content);

				await search.fill(name);
				const skill = overlay.locator('.volt-customize-row').filter({ hasText: name });
				await skill.click();
				await overlay.waitFor({ state: 'detached' });
				await skillEditor.waitFor();
				assert.strictEqual(await mainGroups.count(), initialGroups);
				await tools.locator('.volt-skill-editor:visible').waitFor();
				await skillEditor.getByRole('button', { name: 'Preview', exact: true }).click();
				const body = skillEditor.getByRole('textbox', { name: 'Content' });
				await body.fill('Unsaved edit in the Skill Editor');
				await skillEditor.getByRole('button', { name: 'Back to Skills' }).click();
				await skill.waitFor();
				assert.strictEqual(await search.inputValue(), name);
				await overlay.getByRole('button', { name: 'Close settings' }).click();
				await overlay.waitFor({ state: 'detached' });
				await body.waitFor();
				assert.strictEqual((await body.textContent())?.trim(), 'Unsaved edit in the Skill Editor');
				assert.strictEqual(await fs.readFile(file, 'utf8'), content);
				await app.workbench.quickaccess.runCommand('File: Save', { exactLabelMatch: true });
			} finally {
				await fs.rm(folder, { recursive: true, force: true });
			}
		});

		it('keeps the Settings tab and Skills list when opening a file in IDE Mode', async function () {
			const app = this.app as Application;
			const page = app.code.driver.currentPage;
			const skills = join(app.workspacePathOrFolder, '.agents', 'skills');
			await fs.mkdir(skills, { recursive: true });
			const folder = await fs.mkdtemp(join(skills, 'volt-settings-tab-smoke-'));
			const name = basename(folder);
			const file = join(folder, 'SKILL.md');
			const content = `---\nname: ${name}\ndescription: Settings tab fixture\n---\n\n# Settings tab fixture heading\n`;
			const command = (title: string) => app.workbench.quickaccess.runCommand(title, { exactLabelMatch: true });
			try {
				await fs.writeFile(file, content);
				await command('View: IDE Mode');
				await command('Preferences: Volt Settings');
				const workbench = page.locator('.monaco-workbench');
				const overlay = workbench.locator(':scope > .volt-settings-overlay');
				const grid = workbench.locator(':scope > .monaco-grid-view');
				const settings = page.locator('.volt-settings:visible');
				const tab = grid.getByRole('tab', { name: /Volt Settings/ });
				await tab.waitFor();
				assert.strictEqual(await overlay.count(), 0);
				await settings.locator('.volt-settings-nav-label').filter({ hasText: 'Skills & Plugins' }).click();
				const search = settings.locator('.volt-customize-search-input');
				await search.fill(name);
				const result = settings.locator('.volt-customize-row').filter({ hasText: name });
				await result.waitFor();

				await command('View: Agent Mode');
				await overlay.waitFor();
				await result.waitFor();
				assert.strictEqual(await search.inputValue(), name);
				await command('View: IDE Mode');
				await overlay.waitFor({ state: 'detached' });
				await result.waitFor();
				assert.strictEqual(await tab.count(), 1);

				await fs.unlink(file);
				await result.click();
				await page.locator('.notification-list-item-message').filter({ hasText: 'The editor could not load SKILL.md' }).waitFor();
				assert.strictEqual(await search.inputValue(), name);
				await fs.writeFile(file, content);
				await result.click();
				const skillEditor = page.locator('.volt-skill-editor:visible');
				await skillEditor.waitFor();
				assert.strictEqual(await skillEditor.getByRole('button', { name: 'Back to Skills' }).count(), 0);
				await tab.click();
				await result.waitFor();
				assert.strictEqual(await search.inputValue(), name);
				await command('View: Close Editor');
				await tab.waitFor({ state: 'detached' });
			} finally {
				await fs.rm(folder, { recursive: true, force: true });
			}
		});
	});

	describe('Settings editor', () => {

		// Shared before/after handling
		installAllHandlers(logger);

		it('shows a modified indicator on a modified setting', async function () {
			const app = this.app as Application;

			await app.workbench.settingsEditor.searchSettingsUI('@id:editor.tabSize');
			await app.code.waitForSetValue('.settings-editor .setting-item-contents .setting-item-control input', '6');
			await app.code.waitForElement('.settings-editor .setting-item-contents .setting-item-modified-indicator');
			await app.code.waitForSetValue('.settings-editor .setting-item-contents .setting-item-control input', '4');
		});

		// Skipping test due to it being flaky.
		it.skip('turns off editor line numbers and verifies the live change', async function () {
			const app = this.app as Application;

			await app.workbench.editors.newUntitledFile();
			await app.code.dispatchKeybinding('enter', async () => {
				await app.code.waitForElements('.line-numbers', false, elements => !!elements.length);
			});

			// Turn off line numbers
			await app.workbench.settingsEditor.searchSettingsUI('editor.lineNumbers');
			await app.code.waitAndClick('.settings-editor .monaco-list-rows .setting-item-control select', 2, 2);
			await app.code.waitAndClick('.context-view .option-text', 2, 2);

			await app.workbench.editors.selectTab('Untitled-1');
			await app.code.waitForElements('.line-numbers', false, elements => !elements || elements.length === 0);
		});

		// Skipping test due to it being flaky.
		it.skip('hides the toc when searching depending on the search behavior', async function () {
			const app = this.app as Application;

			// Hide ToC when searching
			await app.workbench.settingsEditor.searchSettingsUI('workbench.settings.settingsSearchTocBehavior');
			await app.code.waitAndClick('.settings-editor .monaco-list-rows .setting-item-control select', 2, 2);
			await app.code.waitAndClick('.context-view .monaco-list-row:nth-child(1) .option-text', 2, 2);
			await app.workbench.settingsEditor.searchSettingsUI('test');
			await app.code.waitForElements('.settings-editor .settings-toc-container', false, elements => elements.length === 1 && elements[0].attributes['style'].includes('width: 0px'));
			await app.code.waitForElements('.settings-editor .settings-body .monaco-sash', false, elements => elements.length === 1 && elements[0].className.includes('disabled'));

			// Show ToC when searching
			await app.workbench.settingsEditor.searchSettingsUI('workbench.settings.settingsSearchTocBehavior');
			await app.code.waitAndClick('.settings-editor .monaco-list-rows .setting-item-control select', 2, 2);
			await app.code.waitAndClick('.context-view .monaco-list-row:nth-child(2) .option-text', 2, 2);
			await app.workbench.settingsEditor.searchSettingsUI('test');
			await app.code.waitForElements('.settings-editor .settings-toc-container', false, elements => elements.length === 1 && !elements[0].attributes['style'].includes('width: 0px'));
			await app.code.waitForElements('.settings-editor .settings-body .monaco-sash', false, elements => elements.length === 1 && !elements[0].className.includes('disabled'));
		});
	});
}
