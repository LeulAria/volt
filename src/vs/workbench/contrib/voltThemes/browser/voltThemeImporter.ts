/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { parse } from '../../../../base/common/json.js';
import { Schemas } from '../../../../base/common/network.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ExtensionType } from '../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { compareVersions, extensionFolderName, IVoltThemeImportCandidate, importableThemeSettings, ImportableThemeSetting, IMPORTABLE_THEME_SETTINGS, installedFolders, newestCandidates, parseThemeExtension, VoltThemeImportSource } from '../common/voltThemeImport.js';

interface ISourceEditor {
	readonly source: VoltThemeImportSource;
	readonly label: string;
	/** Its extensions directory, under the user's home. */
	readonly extensionsDir: string;
	/** Its application folder name, for the settings.json path. */
	readonly appFolder: string;
}

const EDITORS: readonly ISourceEditor[] = [
	{ source: 'vscode', label: 'VS Code', extensionsDir: '.vscode/extensions', appFolder: 'Code' },
	{ source: 'cursor', label: 'Cursor', extensionsDir: '.cursor/extensions', appFolder: 'Cursor' },
];

function editorLabel(source: VoltThemeImportSource): string {
	return EDITORS.find(e => e.source === source)?.label ?? source;
}

interface ICandidateItem extends IQuickPickItem {
	readonly candidate: IVoltThemeImportCandidate;
}

/**
 * Brings theme extensions over from VS Code and Cursor. Each picked extension folder is copied
 * into Volt's own extensions directory (the source is only read) and registered from there, so it
 * keeps working if the other editor updates or removes it, and needs no network. Then, if asked,
 * the other editor's theme settings come along too.
 */
export class VoltThemeImporter {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IProgressService private readonly progressService: IProgressService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@ILogService private readonly logService: ILogService,
	) { }

	private async readText(resource: URI): Promise<string | undefined> {
		try {
			return (await this.fileService.readFile(resource)).value.toString();
		} catch {
			return undefined;
		}
	}

	private async extensionsDir(editor: ISourceEditor): Promise<URI> {
		return joinPath(await this.pathService.userHome(), ...editor.extensionsDir.split('/'));
	}

	/** Theme extensions installed in VS Code or Cursor, newest copy of each. */
	async scan(): Promise<IVoltThemeImportCandidate[]> {
		const found: IVoltThemeImportCandidate[] = [];
		for (const editor of EDITORS) {
			const dir = await this.extensionsDir(editor);
			let children;
			try {
				children = (await this.fileService.resolve(dir)).children ?? [];
			} catch {
				continue;
			}
			const { installed, obsolete } = installedFolders(await this.readText(joinPath(dir, 'extensions.json')), await this.readText(joinPath(dir, '.obsolete')));
			await Promise.all(children.filter(c => c.isDirectory && !obsolete.has(c.name) && (!installed || installed.has(c.name))).map(async child => {
				const text = await this.readText(joinPath(child.resource, 'package.json'));
				if (!text) {
					return;
				}
				try {
					const candidate = parseThemeExtension(JSON.parse(text), child.name, editor.source);
					if (candidate) {
						found.push(candidate);
					}
				} catch {
					// Not a readable manifest: not an extension we can bring over.
				}
			}));
		}
		return newestCandidates(found);
	}

	async run(): Promise<void> {
		const candidates = await this.scan();
		const settings = await this.readEditorSettings();
		this.logService.info(`[volt themes] import: ${candidates.length} theme extension(s) found${settings ? `, theme settings in ${editorLabel(settings.source)}` : ''}`);
		if (!candidates.length && !settings) {
			this.notificationService.info(localize('voltThemes.import.none', "No theme extensions or theme settings were found in VS Code or Cursor."));
			return;
		}
		const installed = new Map((await this.extensionManagementService.getInstalled(ExtensionType.User)).map(e => [e.identifier.id.toLowerCase(), e.manifest.version]));
		const wanted = typeof settings?.values['workbench.colorTheme'] === 'string' ? settings.values['workbench.colorTheme'] : undefined;
		// Pre-pick the one extension that has the theme the other editor uses now (VS Code's copy first).
		const wantedId = wanted ? candidates.filter(c => c.themes.some(t => t.label === wanted)).sort((a, b) => a.source === b.source ? 0 : a.source === 'vscode' ? -1 : 1)[0]?.id : undefined;
		const items: ICandidateItem[] = candidates.map(candidate => {
			const have = installed.get(candidate.id);
			const current = have !== undefined && compareVersions(have, candidate.version) >= 0;
			return {
				candidate,
				label: candidate.displayName,
				description: current
					? localize('voltThemes.import.installed', "{0} · already in Volt", editorLabel(candidate.source))
					: `${editorLabel(candidate.source)} · v${candidate.version}`,
				detail: candidate.themes.map(t => t.label).join(', '),
				picked: !current && candidate.id === wantedId,
			};
		});

		let picked: readonly ICandidateItem[] = [];
		if (items.length) {
			const result = await this.quickInputService.pick(items, {
				canPickMany: true,
				title: localize('voltThemes.import.title', "Import Themes from VS Code and Cursor"),
				placeHolder: localize('voltThemes.import.placeholder', "Pick the theme extensions to copy into Volt"),
				matchOnDetail: true,
			});
			if (!result) {
				return;
			}
			picked = result;
		}

		if (picked.length) {
			const done = await this.install(picked.map(p => p.candidate));
			if (!done.length) {
				return;
			}
		}
		if (settings) {
			await this.offerSettings(settings);
		}
	}

	/** Copies and registers the extensions; returns the ones that made it. */
	private async install(candidates: readonly IVoltThemeImportCandidate[]): Promise<IVoltThemeImportCandidate[]> {
		// The profile names Volt's extensions folder under the user-data scheme; installs need the file path.
		const folder = dirname(this.userDataProfilesService.defaultProfile.extensionsResource);
		const target = folder.scheme === Schemas.vscodeUserData ? folder.with({ scheme: Schemas.file }) : folder;
		const done: IVoltThemeImportCandidate[] = [];
		const failed: string[] = [];
		await this.progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('voltThemes.import.progress', "Importing themes"),
		}, async progress => {
			for (const candidate of candidates) {
				progress.report({ message: candidate.displayName });
				try {
					const editor = EDITORS.find(e => e.source === candidate.source)!;
					const source = joinPath(await this.extensionsDir(editor), candidate.folderName);
					const copy = joinPath(target, extensionFolderName(candidate));
					if (!await this.fileService.exists(copy)) {
						await this.fileService.copy(source, copy, false);
					}
					await this.extensionManagementService.installFromLocation(copy);
					done.push(candidate);
				} catch (error) {
					this.logService.error(`[volt themes] import of ${candidate.id} failed`, error);
					failed.push(candidate.displayName);
				}
			}
		});
		if (failed.length) {
			this.notificationService.warn(localize('voltThemes.import.failed', "Could not import {0}. See the log for details.", failed.join(', ')));
		} else if (done.length) {
			this.notificationService.info(done.length === 1
				? localize('voltThemes.import.doneOne', "Imported {0}. Its themes are in the theme picker.", done[0].displayName)
				: localize('voltThemes.import.doneMany', "Imported {0} theme extensions. Their themes are in the theme picker.", done.length));
		}
		return done;
	}

	private settingsFile(home: URI, editor: ISourceEditor): URI {
		if (isMacintosh) {
			return joinPath(home, 'Library', 'Application Support', editor.appFolder, 'User', 'settings.json');
		}
		if (isWindows) {
			return joinPath(home, 'AppData', 'Roaming', editor.appFolder, 'User', 'settings.json');
		}
		return joinPath(home, '.config', editor.appFolder, 'User', 'settings.json');
	}

	/** Theme settings from VS Code's settings.json, else Cursor's. */
	private async readEditorSettings(): Promise<{ readonly source: VoltThemeImportSource; readonly values: Partial<Record<ImportableThemeSetting, unknown>> } | undefined> {
		const home = await this.pathService.userHome();
		for (const editor of EDITORS) {
			const text = await this.readText(this.settingsFile(home, editor));
			if (!text) {
				continue;
			}
			const values = importableThemeSettings(parse(text));
			if (Object.keys(values).length) {
				return { source: editor.source, values };
			}
		}
		return undefined;
	}

	/** Asks before anything is written; says which of Volt's own values would be replaced. */
	private async offerSettings(settings: { readonly source: VoltThemeImportSource; readonly values: Partial<Record<ImportableThemeSetting, unknown>> }): Promise<void> {
		const lines: string[] = [];
		const replaced: string[] = [];
		for (const key of IMPORTABLE_THEME_SETTINGS) {
			const value = settings.values[key];
			if (value === undefined) {
				continue;
			}
			const current = this.configurationService.inspect(key).userValue;
			if (current !== undefined && JSON.stringify(current) === JSON.stringify(value)) {
				continue;
			}
			lines.push(key === 'workbench.colorTheme'
				? localize('voltThemes.import.colorTheme', "Color theme: {0}", String(value))
				: localize('voltThemes.import.overrides', "{0} ({1} entries)", key, Object.keys(value as object).length));
			if (current !== undefined) {
				replaced.push(key);
			}
		}
		if (!lines.length) {
			return;
		}
		const { confirmed } = await this.dialogService.confirm({
			message: localize('voltThemes.import.settings', "Use your {0} theme settings in Volt?", editorLabel(settings.source)),
			detail: [
				...lines,
				...(replaced.length ? ['', localize('voltThemes.import.replaces', "This replaces what Volt has now for: {0}.", replaced.join(', '))] : []),
			].join('\n'),
			primaryButton: replaced.length ? localize('voltThemes.import.replace', "&&Replace") : localize('voltThemes.import.use', "&&Use Them"),
		});
		if (!confirmed) {
			return;
		}
		for (const key of IMPORTABLE_THEME_SETTINGS) {
			const value = settings.values[key];
			if (value === undefined || key === 'workbench.colorTheme') {
				continue;
			}
			await this.configurationService.updateValue(key, value, ConfigurationTarget.USER);
		}
		const theme = settings.values['workbench.colorTheme'];
		if (typeof theme === 'string') {
			await this.applyThemeWhenRegistered(theme);
		}
	}

	/** A just-imported theme registers a moment after its extension; wait for it before switching. */
	private async applyThemeWhenRegistered(settingsId: string): Promise<void> {
		for (let i = 0; i < 40; i++) {
			const theme = (await this.themeService.getColorThemes()).find(t => t.settingsId === settingsId);
			if (theme) {
				await this.themeService.setColorTheme(theme, 'auto');
				return;
			}
			await timeout(250);
		}
		this.notificationService.warn(localize('voltThemes.import.themeMissing', "The theme \"{0}\" is not installed in Volt. Import its extension to use it.", settingsId));
	}
}
