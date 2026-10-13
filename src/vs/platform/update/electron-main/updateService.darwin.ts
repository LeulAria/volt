/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as electron from 'electron';
import * as fs from 'fs';
import { homedir, tmpdir } from 'os';
import { promisify } from 'util';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { memoize } from '../../../base/common/decorators.js';
import { Event } from '../../../base/common/event.js';
import { hash } from '../../../base/common/hash.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService, IRelaunchHandler, IRelaunchOptions } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IRequestService } from '../../request/common/request.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { AvailableForDownload, IUpdate, State, StateType, UpdateType } from '../common/update.js';
import { IVoltUpdate, VOLT_CHANNEL_APP_NAMES, voltFeedUrl, VoltReleaseChannel } from '../common/voltUpdateFeed.js';
import { AbstractUpdateService, createUpdateURL, UpdateErrorClassification } from './abstractUpdateService.js';
import { downloadVoltUpdate } from './voltUpdateDownload.js';

export class DarwinUpdateService extends AbstractUpdateService implements IRelaunchHandler {

	private readonly disposables = new DisposableStore();

	/** Volt: the update Squirrel.Mac is downloading, from the static feed. */
	private pendingVoltUpdate: IVoltUpdate | undefined;

	/** Volt: Squirrel.Mac refuses builds without a Developer ID signature; offer the download instead. */
	private squirrelUnavailable = false;

	@memoize private get onRawError(): Event<string> { return Event.fromNodeEventEmitter(electron.autoUpdater, 'error', (_, message) => message); }
	@memoize private get onRawUpdateNotAvailable(): Event<void> { return Event.fromNodeEventEmitter<void>(electron.autoUpdater, 'update-not-available'); }
	@memoize private get onRawUpdateAvailable(): Event<void> { return Event.fromNodeEventEmitter(electron.autoUpdater, 'update-available'); }
	@memoize private get onRawUpdateDownloaded(): Event<IUpdate> { return Event.fromNodeEventEmitter(electron.autoUpdater, 'update-downloaded', (_, releaseNotes, version, timestamp) => ({ version, productVersion: version, timestamp })); }

	constructor(
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IConfigurationService configurationService: IConfigurationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IRequestService requestService: IRequestService,
		@ILogService logService: ILogService,
		@IProductService productService: IProductService
	) {
		super(lifecycleMainService, configurationService, environmentMainService, requestService, logService, productService);

		lifecycleMainService.setRelaunchHandler(this);
	}

	handleRelaunch(options?: IRelaunchOptions): boolean {
		if (options?.addArgs || options?.removeArgs) {
			return false; // we cannot apply an update and restart with different args
		}

		if (this.state.type !== StateType.Ready || (this.state.update as IVoltUpdate).voltChannel) {
			return false; // we only handle the relaunch when we have a pending update
		}

		this.logService.trace('update#handleRelaunch(): running raw#quitAndInstall()');
		this.doQuitAndInstall();

		return true;
	}

	protected override async initialize(): Promise<void> {
		await super.initialize();
		this.onRawError(this.onError, this, this.disposables);
		this.onRawUpdateAvailable(this.onUpdateAvailable, this, this.disposables);
		this.onRawUpdateDownloaded(this.onUpdateDownloaded, this, this.disposables);
		this.onRawUpdateNotAvailable(this.onUpdateNotAvailable, this, this.disposables);
	}

	private onError(err: string): void {
		this.telemetryService.publicLog2<{ messageHash: string }, UpdateErrorClassification>('update:error', { messageHash: String(hash(String(err))) });
		this.logService.error('UpdateService error:', err);

		// Volt: when Squirrel.Mac can't install (e.g. an ad-hoc signed build), still offer the download.
		const pending = this.pendingVoltUpdate;
		if (pending && (this.state.type === StateType.CheckingForUpdates || this.state.type === StateType.Downloading)) {
			this.pendingVoltUpdate = undefined;
			this.setState(State.AvailableForDownload(pending));
			return;
		}

		// only show message when explicitly checking for updates
		const message = (this.state.type === StateType.CheckingForUpdates && this.state.explicit) ? err : undefined;
		this.setState(State.Idle(UpdateType.Archive, message));
	}

	protected buildUpdateFeedUrl(quality: string): string | undefined {
		let assetID: string;
		if (!this.productService.darwinUniversalAssetId) {
			assetID = process.arch === 'x64' ? 'darwin' : 'darwin-arm64';
		} else {
			assetID = this.productService.darwinUniversalAssetId;
		}
		const url = createUpdateURL(assetID, quality, this.productService);
		if (this.productService.voltRelease) {
			// Squirrel.Mac only gets a feed once the static feed says there is an update.
			try {
				electron.autoUpdater.setFeedURL({ url: this.squirrelFeedUrl(quality, assetID) });
				this.squirrelUnavailable = false;
			} catch (e) {
				this.logService.warn('update#darwin - Squirrel.Mac unavailable (unsigned build?); updates will be offered as downloads', e);
				this.squirrelUnavailable = true;
			}
			return url;
		}
		try {
			electron.autoUpdater.setFeedURL({ url });
		} catch (e) {
			// application is very likely not signed
			this.logService.error('Failed to set update feed URL', e);
			return undefined;
		}
		return url;
	}

	private squirrelFeedUrl(channel: string, assetID: string): string {
		return voltFeedUrl(this.productService.updateUrl || this.productService.voltRelease!.feedUrl, channel as VoltReleaseChannel, assetID, '.squirrel.json');
	}

	protected doCheckForUpdates(explicit: boolean): void {
		if (!this.url) {
			return;
		}

		this.setState(State.CheckingForUpdates(explicit));

		if (this.productService.voltRelease) {
			this.doCheckForVoltUpdates(this.url, explicit);
			return;
		}

		const url = explicit ? this.url : `${this.url}?bg=true`;
		electron.autoUpdater.setFeedURL({ url });
		electron.autoUpdater.checkForUpdates();
	}

	private async doCheckForVoltUpdates(url: string, explicit: boolean): Promise<void> {
		try {
			const context = await this.requestService.request({ url }, CancellationToken.None);
			const update = await this.parseUpdateResponse(context) as IVoltUpdate | null;
			if (this.state.type !== StateType.CheckingForUpdates) {
				return;
			}
			if (!update) {
				this.setState(State.Idle(UpdateType.Archive));
				return;
			}
			if (update.voltChannel || this.squirrelUnavailable) {
				this.setState(State.AvailableForDownload(update));
				return;
			}
			this.pendingVoltUpdate = update;
			electron.autoUpdater.setFeedURL({ url: this.squirrelFeedUrl(this.channel!, this.assetID) });
			electron.autoUpdater.checkForUpdates();
		} catch (err) {
			this.logService.error('update#darwin - checking the Volt feed failed', err);
			const message: string | undefined = explicit ? (err.message || String(err)) : undefined;
			this.setState(State.Idle(UpdateType.Archive, message));
		}
	}

	private get assetID(): string {
		return this.productService.darwinUniversalAssetId ?? (process.arch === 'x64' ? 'darwin' : 'darwin-arm64');
	}

	protected override async doDownloadUpdate(state: AvailableForDownload): Promise<void> {
		const update = state.update as IVoltUpdate;
		if (update.voltChannel && update.url?.endsWith('.zip')) {
			return this.installVoltChannel(update, update.voltChannel);
		}
		// Volt: Squirrel.Mac can't install this build; open the dmg (or the download page) in the browser.
		const url = update.downloadUrl ?? this.productService.voltRelease?.downloadPage ?? update.url;
		if (url) {
			await electron.shell.openExternal(url);
		}
		this.setState(State.Idle(UpdateType.Archive));
	}

	/**
	 * Volt: installs another channel's app next to this one (each channel is its own app, with its
	 * own bundle id and settings, so Squirrel.Mac can't swap it in). Downloads the channel's zip,
	 * unpacks it with ditto beside the destination, and moves the app into place.
	 */
	private async installVoltChannel(update: IVoltUpdate, channel: VoltReleaseChannel): Promise<void> {
		const name = `${VOLT_CHANNEL_APP_NAMES[channel]}.app`;
		this.setState(State.DownloadingUpdate(update, 0));
		const staging = await fs.promises.mkdtemp(path.join(tmpdir(), `volt-${channel}-`));
		try {
			const zip = path.join(staging, 'update.zip');
			await downloadVoltUpdate(this.requestService, update.url!, zip, {
				sha256hash: update.sha256hash,
				size: update.size,
				onProgress: progress => {
					if (this.state.type === StateType.Downloading) {
						this.setState(State.DownloadingUpdate(update, progress));
					}
				},
			});
			this.setState(State.Updating(update));
			const folder = await this.writableAppFolder();
			const target = path.join(folder, name);
			// Unpacked next to the destination, so moving it in is a rename on one volume.
			const unpacked = await fs.promises.mkdtemp(path.join(folder, `.${name}-`));
			try {
				await promisify(execFile)('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
				const app = (await fs.promises.readdir(unpacked)).find(entry => entry.endsWith('.app'));
				if (!app) {
					throw new Error(`The ${VOLT_CHANNEL_APP_NAMES[channel]} download has no app in it`);
				}
				if (!fs.existsSync(target)) {
					await fs.promises.rename(path.join(unpacked, app), target);
				}
			} finally {
				await fs.promises.rm(unpacked, { recursive: true, force: true });
			}
			this.logService.info(`update#darwin - installed ${target}`);
			this.setState(State.Ready(update));
		} catch (err) {
			this.logService.error(`update#darwin - installing ${name} failed`, err);
			this.setState(State.Idle(UpdateType.Archive, err instanceof Error ? err.message : String(err)));
		} finally {
			await fs.promises.rm(staging, { recursive: true, force: true });
		}
	}

	/** Volt: where channel apps live: next to this app, then /Applications and ~/Applications. */
	private voltAppFolders(): string[] {
		const bundle = path.resolve(process.execPath, '..', '..', '..');
		return [...new Set([path.dirname(bundle), '/Applications', path.join(homedir(), 'Applications')])];
	}

	/** Volt: the first app folder this user can write to (a translocated or dmg-mounted app's isn't). */
	private async writableAppFolder(): Promise<string> {
		const folders = this.voltAppFolders();
		for (const folder of folders) {
			try {
				await fs.promises.access(folder, fs.constants.W_OK);
				return folder;
			} catch {
				// next
			}
		}
		const fallback = folders[folders.length - 1];
		await fs.promises.mkdir(fallback, { recursive: true });
		return fallback;
	}

	private voltChannelAppPath(channel: VoltReleaseChannel): string | undefined {
		const name = `${VOLT_CHANNEL_APP_NAMES[channel]}.app`;
		return this.voltAppFolders().map(folder => path.join(folder, name)).find(app => fs.existsSync(app));
	}

	protected override isVoltChannelInstalled(channel: VoltReleaseChannel): boolean {
		return !!this.voltChannelAppPath(channel);
	}

	protected override openVoltChannel(channel: VoltReleaseChannel): void {
		const app = this.voltChannelAppPath(channel);
		if (!app) {
			return;
		}
		void electron.shell.openPath(app).then(error => {
			if (error) {
				this.logService.error(`update#darwin - opening ${app} failed: ${error}`);
			}
		});
	}

	private onUpdateAvailable(): void {
		if (this.state.type !== StateType.CheckingForUpdates) {
			return;
		}

		this.setState(this.pendingVoltUpdate ? State.DownloadingUpdate(this.pendingVoltUpdate) : State.Downloading);
	}

	private onUpdateDownloaded(update: IUpdate): void {
		if (this.state.type !== StateType.Downloading) {
			return;
		}

		// Squirrel only knows the name it was given; keep the feed's commit and version.
		if (this.pendingVoltUpdate) {
			update = this.pendingVoltUpdate;
			this.pendingVoltUpdate = undefined;
		}

		this.setState(State.Downloaded(update));

		type UpdateDownloadedClassification = {
			owner: 'joaomoreno';
			newVersion: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The version number of the new VS Code that has been downloaded.' };
			comment: 'This is used to know how often VS Code has successfully downloaded the update.';
		};
		this.telemetryService.publicLog2<{ newVersion: String }, UpdateDownloadedClassification>('update:downloaded', { newVersion: update.version });

		this.setState(State.Ready(update));
	}

	private onUpdateNotAvailable(): void {
		if (this.state.type !== StateType.CheckingForUpdates) {
			return;
		}
		this.pendingVoltUpdate = undefined;

		this.setState(State.Idle(UpdateType.Archive));
	}

	protected override doQuitAndInstall(): void {
		this.logService.trace('update#quitAndInstall(): running raw#quitAndInstall()');
		electron.autoUpdater.quitAndInstall();
	}

	dispose(): void {
		this.disposables.dispose();
	}
}
