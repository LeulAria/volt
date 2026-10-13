/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { timeout } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { memoize } from '../../../base/common/decorators.js';
import { hash } from '../../../base/common/hash.js';
import * as path from '../../../base/common/path.js';
import * as pfs from '../../../base/node/pfs.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService, IRelaunchHandler, IRelaunchOptions } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { INativeHostMainService } from '../../native/electron-main/nativeHostMainService.js';
import { IProductService } from '../../product/common/productService.js';
import { IRequestService } from '../../request/common/request.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { AvailableForDownload, DisablementReason, IUpdate, State, StateType, UpdateType } from '../common/update.js';
import { AbstractUpdateService, createUpdateURL, UpdateErrorClassification } from './abstractUpdateService.js';
import { IVoltUpdate, VOLT_CHANNEL_APP_NAMES, VoltReleaseChannel } from '../common/voltUpdateFeed.js';
import { downloadVoltUpdate } from './voltUpdateDownload.js';

async function pollUntil(fn: () => boolean, millis = 1000): Promise<void> {
	while (!fn()) {
		await timeout(millis);
	}
}

interface IAvailableUpdate {
	packagePath: string;
	updateFilePath?: string;
}

let _updateType: UpdateType | undefined = undefined;
function getUpdateType(): UpdateType {
	if (typeof _updateType === 'undefined') {
		_updateType = fs.existsSync(path.join(path.dirname(process.execPath), 'unins000.exe'))
			? UpdateType.Setup
			: UpdateType.Archive;
	}

	return _updateType;
}

export class Win32UpdateService extends AbstractUpdateService implements IRelaunchHandler {

	private availableUpdate: IAvailableUpdate | undefined;

	@memoize
	get cachePath(): Promise<string> {
		const result = path.join(tmpdir(), `vscode-${this.productService.quality}-${this.productService.target}-${process.arch}`);
		return fs.promises.mkdir(result, { recursive: true }).then(() => result);
	}

	constructor(
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IConfigurationService configurationService: IConfigurationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IRequestService requestService: IRequestService,
		@ILogService logService: ILogService,
		@INativeHostMainService private readonly nativeHostMainService: INativeHostMainService,
		@IProductService productService: IProductService
	) {
		super(lifecycleMainService, configurationService, environmentMainService, requestService, logService, productService);

		lifecycleMainService.setRelaunchHandler(this);
	}

	handleRelaunch(options?: IRelaunchOptions): boolean {
		if (options?.addArgs || options?.removeArgs) {
			return false; // we cannot apply an update and restart with different args
		}

		if (this.state.type !== StateType.Ready || !this.availableUpdate) {
			return false; // we only handle the relaunch when we have a pending update
		}

		this.logService.trace('update#handleRelaunch(): running raw#quitAndInstall()');
		this.doQuitAndInstall();

		return true;
	}

	protected override async initialize(): Promise<void> {
		if (this.productService.target === 'user' && await this.nativeHostMainService.isAdmin(undefined)) {
			this.setState(State.Disabled(DisablementReason.RunningAsAdmin));
			this.logService.info('update#ctor - updates are disabled due to running as Admin in user setup');
			return;
		}

		await super.initialize();
	}

	protected buildUpdateFeedUrl(quality: string): string | undefined {
		let platform = `win32-${process.arch}`;

		if (getUpdateType() === UpdateType.Archive) {
			platform += '-archive';
		} else if (this.productService.target === 'user') {
			platform += '-user';
		}

		return createUpdateURL(platform, quality, this.productService);
	}

	protected doCheckForUpdates(explicit: boolean): void {
		if (!this.url) {
			return;
		}

		const url = explicit ? this.url : `${this.url}?bg=true`;
		this.setState(State.CheckingForUpdates(explicit));

		this.requestService.request({ url }, CancellationToken.None)
			.then(context => this.parseUpdateResponse(context))
			.then(update => {
				const updateType = getUpdateType();

				if (!update || !update.url || !update.version || !update.productVersion) {
					this.setState(State.Idle(updateType));
					return Promise.resolve(null);
				}

				// Archive installs can't update themselves; another Volt channel is a separate app.
				if (updateType === UpdateType.Archive || (update as IVoltUpdate).voltChannel) {
					this.setState(State.AvailableForDownload(update));
					return Promise.resolve(null);
				}

				this.setState(this.productService.voltRelease ? State.DownloadingUpdate(update, 0) : State.Downloading);

				return this.cleanup(update.version).then(() => {
					return this.getUpdatePackagePath(update.version).then(updatePackagePath => {
						return pfs.Promises.exists(updatePackagePath).then(exists => {
							if (exists) {
								return Promise.resolve(updatePackagePath);
							}

							return downloadVoltUpdate(this.requestService, update.url!, updatePackagePath, {
								sha256hash: update.sha256hash,
								size: (update as IVoltUpdate).size,
								onProgress: this.productService.voltRelease ? progress => this.reportDownloadProgress(update, progress) : undefined,
							}).then(() => updatePackagePath);
						});
					}).then(packagePath => {
						this.availableUpdate = { packagePath };
						this.setState(State.Downloaded(update));

						const fastUpdatesEnabled = this.configurationService.getValue('update.enableWindowsBackgroundUpdates');
						if (fastUpdatesEnabled) {
							if (this.productService.target === 'user') {
								this.doApplyUpdate();
							}
						} else {
							this.setState(State.Ready(update));
						}
					});
				});
			})
			.then(undefined, err => {
				this.telemetryService.publicLog2<{ messageHash: string }, UpdateErrorClassification>('update:error', { messageHash: String(hash(String(err))) });
				this.logService.error(err);

				// only show message when explicitly checking for updates
				const message: string | undefined = explicit ? (err.message || err) : undefined;
				this.setState(State.Idle(getUpdateType(), message));
			});
	}

	/** Volt: download progress, so the update popover can show it. */
	private reportDownloadProgress(update: IUpdate, progress: number): void {
		if (this.state.type === StateType.Downloading) {
			this.setState(State.DownloadingUpdate(update, progress));
		}
	}

	protected override async doDownloadUpdate(state: AvailableForDownload): Promise<void> {
		const update = state.update as IVoltUpdate;
		// Volt: a user setup installs another channel's app next to this one, without admin rights.
		if (update.voltChannel && update.url && getUpdateType() === UpdateType.Setup && this.productService.target === 'user') {
			return this.installVoltChannel(update, update.voltChannel);
		}
		const url = update.voltChannel ? update.downloadUrl ?? update.url : update.url;
		if (url) {
			this.nativeHostMainService.openExternal(undefined, url);
		}
		this.setState(State.Idle(getUpdateType()));
	}

	/** Volt: downloads another channel's user setup and runs it quietly; it installs into its own folder. */
	private async installVoltChannel(update: IVoltUpdate, channel: VoltReleaseChannel): Promise<void> {
		this.setState(State.DownloadingUpdate(update, 0));
		try {
			const setup = path.join(await this.cachePath, `VoltSetup-${channel}-${update.version}.exe`);
			if (!await pfs.Promises.exists(setup)) {
				await downloadVoltUpdate(this.requestService, update.url!, setup, {
					sha256hash: update.sha256hash,
					size: update.size,
					onProgress: progress => this.reportDownloadProgress(update, progress),
				});
			}
			this.setState(State.Updating(update));
			const code = await new Promise<number | null>((resolve, reject) => {
				const child = spawn(setup, ['/verysilent', '/log', '/mergetasks=!runcode,!desktopicon,!quicklaunchicon'], { stdio: 'ignore' });
				child.once('error', reject);
				child.once('exit', resolve);
			});
			await fs.promises.rm(setup, { force: true });
			if (code !== 0 || !this.isVoltChannelInstalled(channel)) {
				throw new Error(`The ${VOLT_CHANNEL_APP_NAMES[channel]} installer exited with code ${code}`);
			}
			this.setState(State.Ready(update));
		} catch (err) {
			this.logService.error(`update#win32 - installing ${VOLT_CHANNEL_APP_NAMES[channel]} failed`, err);
			this.setState(State.Idle(getUpdateType(), err instanceof Error ? err.message : String(err)));
		}
	}

	/** Volt: a channel app's exe, in the user or the machine-wide install folder (build/win32/code.iss). */
	private voltChannelExe(channel: VoltReleaseChannel): string | undefined {
		const name = VOLT_CHANNEL_APP_NAMES[channel];
		const roots = [process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Programs'), process.env['ProgramFiles']];
		return roots.filter((root): root is string => !!root).map(root => path.join(root, name, `${name}.exe`)).find(exe => fs.existsSync(exe));
	}

	protected override isVoltChannelInstalled(channel: VoltReleaseChannel): boolean {
		return !!this.voltChannelExe(channel);
	}

	protected override openVoltChannel(channel: VoltReleaseChannel): void {
		const exe = this.voltChannelExe(channel);
		if (exe) {
			spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
		}
	}

	private async getUpdatePackagePath(version: string): Promise<string> {
		const cachePath = await this.cachePath;
		return path.join(cachePath, `CodeSetup-${this.productService.quality}-${version}.exe`);
	}

	private async cleanup(exceptVersion: string | null = null): Promise<void> {
		const filter = exceptVersion ? (one: string) => !(new RegExp(`${this.productService.quality}-${exceptVersion}\\.exe$`).test(one)) : () => true;

		const cachePath = await this.cachePath;
		const versions = await pfs.Promises.readdir(cachePath);

		const promises = versions.filter(filter).map(async one => {
			try {
				await fs.promises.unlink(path.join(cachePath, one));
			} catch (err) {
				// ignore
			}
		});

		await Promise.all(promises);
	}

	protected override async doApplyUpdate(): Promise<void> {
		if (this.state.type !== StateType.Downloaded) {
			return Promise.resolve(undefined);
		}

		if (!this.availableUpdate) {
			return Promise.resolve(undefined);
		}

		const update = this.state.update;
		this.setState(State.Updating(update));

		const cachePath = await this.cachePath;

		this.availableUpdate.updateFilePath = path.join(cachePath, `CodeSetup-${this.productService.quality}-${update.version}.flag`);

		await pfs.Promises.writeFile(this.availableUpdate.updateFilePath, 'flag');
		const child = spawn(this.availableUpdate.packagePath, ['/verysilent', '/log', `/update="${this.availableUpdate.updateFilePath}"`, '/nocloseapplications', '/mergetasks=runcode,!desktopicon,!quicklaunchicon'], {
			detached: true,
			stdio: ['ignore', 'ignore', 'ignore'],
			windowsVerbatimArguments: true
		});

		child.once('exit', () => {
			this.availableUpdate = undefined;
			this.setState(State.Idle(getUpdateType()));
		});

		const readyMutexName = `${this.productService.win32MutexName}-ready`;
		const mutex = await import('@vscode/windows-mutex');

		// poll for mutex-ready
		pollUntil(() => mutex.isActive(readyMutexName))
			.then(() => this.setState(State.Ready(update)));
	}

	protected override doQuitAndInstall(): void {
		if (this.state.type !== StateType.Ready || !this.availableUpdate) {
			return;
		}

		this.logService.trace('update#quitAndInstall(): running raw#quitAndInstall()');

		if (this.availableUpdate.updateFilePath) {
			fs.unlinkSync(this.availableUpdate.updateFilePath);
		} else {
			spawn(this.availableUpdate.packagePath, ['/silent', '/log', '/mergetasks=runcode,!desktopicon,!quicklaunchicon'], {
				detached: true,
				stdio: ['ignore', 'ignore', 'ignore']
			});
		}
	}

	protected override getUpdateType(): UpdateType {
		return getUpdateType();
	}

	override async _applySpecificUpdate(packagePath: string): Promise<void> {
		if (this.state.type !== StateType.Idle) {
			return;
		}

		const fastUpdatesEnabled = this.configurationService.getValue('update.enableWindowsBackgroundUpdates');
		const update: IUpdate = { version: 'unknown', productVersion: 'unknown' };

		this.setState(State.Downloading);
		this.availableUpdate = { packagePath };
		this.setState(State.Downloaded(update));

		if (fastUpdatesEnabled) {
			if (this.productService.target === 'user') {
				this.doApplyUpdate();
			}
		} else {
			this.setState(State.Ready(update));
		}
	}
}
