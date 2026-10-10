/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindows } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { FileChangeFilter, IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { isDevReloadAsset, isDevReloadCss, isInitialCompileBurst, isDevReloadJs, requiresFullWindowReload, toOutRelativePath } from '../common/devReload.js';

const HOT_APPLY_DEBOUNCE_MS = 50;
const STARTUP_QUIET_MS = 1500;
const MODULE_EXPORT_CACHE = new Map<string, Record<string, unknown>>();

class VoltDevReloadContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltDevReload';

	private readonly _outDir: URI;
	private readonly _readyAt = Date.now() + STARTUP_QUIET_MS;
	private readonly _pending = new Set<string>();

	constructor(
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._outDir = URI.file(join(environmentService.appRoot, 'out'));
		if (environmentService.isBuilt) {
			return;
		}

		const apply = this._register(new RunOnceScheduler(() => {
			void this._applyPending();
		}, HOT_APPLY_DEBOUNCE_MS));

		const watcher = this.fileService.watch(this._outDir, {
			recursive: true,
			includes: ['**/*.js', '**/*.css'],
			excludes: ['**/*.map', '**/*.tsbuildinfo', '**/*.d.ts', '**/test/**'],
			filter: FileChangeFilter.ADDED | FileChangeFilter.UPDATED,
			correlationId: 0x564c54,
		});
		this._register(watcher);
		this._register(watcher.onDidChange(e => {
			if (Date.now() < this._readyAt) {
				return;
			}
			const changed = [...e.rawAdded, ...e.rawUpdated]
				.map(resource => toOutRelativePath(this._outDir.fsPath, resource.fsPath))
				.filter(isDevReloadAsset);
			if (changed.length === 0) {
				return;
			}
			if (isInitialCompileBurst(changed.length)) {
				this.logService.info(`[volt] ignoring compile burst (${changed.length} files)`);
				return;
			}
			for (const path of changed) {
				this._pending.add(path);
			}
			apply.schedule();
		}));
		this.logService.info('[volt] hot reload watching', this._outDir.fsPath);
	}

	private async _applyPending(): Promise<void> {
		const paths = [...this._pending];
		this._pending.clear();
		if (paths.length === 0) {
			return;
		}

		for (const relativePath of paths) {
			try {
				if (isDevReloadCss(relativePath)) {
					if (reloadStylesheet(relativePath)) {
						this.logService.info('[volt] css hot reload', relativePath);
						showDevBanner(`reloaded ${formatReloadPath(relativePath)}`, 'ok');
					}
					continue;
				}
				if (requiresFullWindowReload(relativePath)) {
					this.logService.info('[volt] kept window open; Cmd+R to apply', relativePath);
					showDevBanner(`saved ${formatReloadPath(relativePath)} - press Cmd+R if you need a full reload`, 'warn');
					continue;
				}
				if (isDevReloadJs(relativePath)) {
					const applied = await this._applyJs(relativePath);
					if (applied) {
						this.logService.info('[volt] js hot reload', relativePath);
						showDevBanner(`reloaded ${formatReloadPath(relativePath)}`, 'ok');
						continue;
					}
					showDevBanner(`could not live-apply ${formatReloadPath(relativePath)} - window stayed open`, 'warn');
				}
			} catch (error) {
				this.logService.error('[volt] hot reload error (window kept open)', relativePath, error);
				showDevBanner(`hot reload error in ${formatReloadPath(relativePath)}: ${error instanceof Error ? error.message : String(error)}`, 'error');
			}
		}
	}

	private async _applyJs(relativePath: string): Promise<boolean> {
		const resource = URI.joinPath(this._outDir, relativePath);
		const raw = (await this.fileService.readFile(resource)).value.toString();
		const fileRoot = (globalThis as unknown as { _VSCODE_FILE_ROOT?: string })._VSCODE_FILE_ROOT;
		if (!fileRoot) {
			return false;
		}

		const stableUrl = new URL(relativePath, fileRoot).href;
		let oldExports = MODULE_EXPORT_CACHE.get(relativePath);
		if (!oldExports) {
			try {
				oldExports = { ...(await import(/* webpackIgnore: true */ stableUrl) as Record<string, unknown>) };
			} catch {
				oldExports = {};
			}
			MODULE_EXPORT_CACHE.set(relativePath, oldExports);
		}

		const apply = (globalThis as unknown as {
			$hotReload_applyNewExports?(args: { oldExports: Record<string, unknown>; newSrc: string; config?: { mode?: 'patch-prototype' } }): ((newExports: Record<string, unknown>) => boolean) | undefined;
		}).$hotReload_applyNewExports?.({
			oldExports,
			newSrc: raw,
			config: { mode: 'patch-prototype' },
		});

		const imported = await import(/* webpackIgnore: true */ `${stableUrl}?hot=${Date.now()}`) as Record<string, unknown>;
		if (apply) {
			// The patcher writes the old classes back into what it is given; a module namespace is read-only.
			return apply({ ...imported });
		}
		return Object.keys(oldExports).length > 0;
	}
}

function reloadStylesheet(relativePath: string): boolean {
	let reloaded = false;
	for (const { window } of getWindows()) {
		const links = window.document.querySelectorAll<HTMLLinkElement>(`link[rel='stylesheet']`);
		for (const link of links) {
			const href = link.getAttribute('href') ?? link.href;
			if (!href || !href.replace(/\\/g, '/').includes(relativePath)) {
				continue;
			}
			const next = new URL(href, window.document.baseURI);
			next.searchParams.set('hot', String(Date.now()));
			link.href = next.href;
			reloaded = true;
		}
	}
	return reloaded;
}

function showDevBanner(message: string, kind: 'ok' | 'warn' | 'error'): void {
	const background = kind === 'error' ? '#8b1e1e' : kind === 'warn' ? '#8a6d1b' : '#1e6b3a';
	for (const { window } of getWindows()) {
		const doc = window.document;
		let banner = doc.getElementById('volt-dev-reload-banner');
		if (!banner) {
			banner = doc.createElement('div');
			banner.id = 'volt-dev-reload-banner';
			banner.setAttribute('role', 'status');
			banner.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;max-width:420px;padding:8px 12px;border-radius:8px;color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);pointer-events:none;';
			doc.body.appendChild(banner);
		}
		banner.style.background = background;
		banner.textContent = message;
		banner.style.display = 'block';
		window.setTimeout(() => {
			if (banner?.textContent === message) {
				banner.style.display = 'none';
			}
		}, kind === 'error' ? 12_000 : 4_000);
	}
}

function formatReloadPath(path: string): string {
	const parts = path.split('/');
	return parts.slice(-3).join('/');
}

registerWorkbenchContribution2(VoltDevReloadContribution.ID, VoltDevReloadContribution, WorkbenchPhase.AfterRestored);
