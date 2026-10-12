/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { ReadableStreamEvents } from '../../../../base/common/stream.js';
import { URI } from '../../../../base/common/uri.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { DiskFileSystemProviderClient } from '../../../../platform/files/common/diskFileSystemProviderClient.js';
import {
	FileSystemProviderCapabilities, IFileAtomicReadOptions, IFileChange, IFileDeleteOptions, IFileOpenOptions, IFileOverwriteOptions, IFileReadStreamOptions,
	IFileService, IFileSystemProviderWithFileAtomicReadCapability, IFileSystemProviderWithFileCloneCapability, IFileSystemProviderWithFileFolderCopyCapability,
	IFileSystemProviderWithFileReadStreamCapability, IFileSystemProviderWithFileReadWriteCapability, IFileSystemProviderWithFileRealpathCapability,
	IFileSystemProviderWithOpenReadWriteCloseCapability, IFileWriteOptions, IStat, IWatchOptions, FileType
} from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRemoteAgentService } from '../common/remoteAgentService.js';
import { REMOTE_FILE_SYSTEM_CHANNEL_NAME } from '../common/remoteFileSystemProviderClient.js';

/**
 * Volt's workbench in a browser: the disk is the server's. Volt's agent UI and the agent server
 * name files with `file:` URIs, as on the desktop; this provider answers those from the remote
 * disk (the one `vscode-remote:` reaches), so they work unchanged in a browser tab.
 */
export class RemoteDiskFileSystemProvider extends Disposable implements
	IFileSystemProviderWithFileReadWriteCapability,
	IFileSystemProviderWithOpenReadWriteCloseCapability,
	IFileSystemProviderWithFileReadStreamCapability,
	IFileSystemProviderWithFileFolderCopyCapability,
	IFileSystemProviderWithFileAtomicReadCapability,
	IFileSystemProviderWithFileCloneCapability,
	IFileSystemProviderWithFileRealpathCapability {

	static register(remoteAgentService: IRemoteAgentService, fileService: IFileService, logService: ILogService): IDisposable {
		const connection = remoteAgentService.getConnection();
		if (!connection) {
			return Disposable.None;
		}
		const disposables = new DisposableStore();
		const ready = (async () => {
			try {
				const environment = await remoteAgentService.getRawEnvironment();
				if (!environment) {
					logService.error('[volt] the server\'s disk is not reachable: no remote environment.');
					return;
				}
				const inner = disposables.add(new DiskFileSystemProviderClient(connection.getChannel(REMOTE_FILE_SYSTEM_CHANNEL_NAME), { pathCaseSensitive: environment.os === OperatingSystem.Linux }));
				disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new RemoteDiskFileSystemProvider(inner, connection.remoteAuthority))));
			} catch (error) {
				logService.error('[volt] the server\'s disk is not reachable.', getErrorMessage(error));
			}
		})();
		disposables.add(fileService.onWillActivateFileSystemProvider(e => {
			if (e.scheme === Schemas.file) {
				e.join(ready);
			}
		}));
		return disposables;
	}

	readonly onDidChangeCapabilities: Event<void>;
	readonly onDidChangeFile: Event<readonly IFileChange[]>;
	readonly onDidWatchError: Event<string>;

	private constructor(private readonly inner: DiskFileSystemProviderClient, private readonly remoteAuthority: string) {
		super();
		this.onDidChangeCapabilities = inner.onDidChangeCapabilities;
		this.onDidWatchError = inner.onDidWatchError;
		this.onDidChangeFile = Event.map(inner.onDidChangeFile, changes => changes.map(change => ({ ...change, resource: this.toFile(change.resource) })), this._store);
	}

	get capabilities(): FileSystemProviderCapabilities {
		return this.inner.capabilities;
	}

	private toRemote(resource: URI): URI {
		return resource.with({ scheme: Schemas.vscodeRemote, authority: this.remoteAuthority });
	}

	private toFile(resource: URI): URI {
		return resource.scheme === Schemas.vscodeRemote ? resource.with({ scheme: Schemas.file, authority: '' }) : resource;
	}

	stat(resource: URI): Promise<IStat> { return this.inner.stat(this.toRemote(resource)); }
	realpath(resource: URI): Promise<string> { return this.inner.realpath(this.toRemote(resource)); }
	readdir(resource: URI): Promise<[string, FileType][]> { return this.inner.readdir(this.toRemote(resource)); }
	readFile(resource: URI, opts?: IFileAtomicReadOptions): Promise<Uint8Array> { return this.inner.readFile(this.toRemote(resource), opts); }
	readFileStream(resource: URI, opts: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> { return this.inner.readFileStream(this.toRemote(resource), opts, token); }
	writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> { return this.inner.writeFile(this.toRemote(resource), content, opts); }
	open(resource: URI, opts: IFileOpenOptions): Promise<number> { return this.inner.open(this.toRemote(resource), opts); }
	close(fd: number): Promise<void> { return this.inner.close(fd); }
	read(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> { return this.inner.read(fd, pos, data, offset, length); }
	write(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> { return this.inner.write(fd, pos, data, offset, length); }
	mkdir(resource: URI): Promise<void> { return this.inner.mkdir(this.toRemote(resource)); }
	delete(resource: URI, opts: IFileDeleteOptions): Promise<void> { return this.inner.delete(this.toRemote(resource), opts); }
	rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> { return this.inner.rename(this.toRemote(from), this.toRemote(to), opts); }
	copy(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> { return this.inner.copy(this.toRemote(from), this.toRemote(to), opts); }
	cloneFile(from: URI, to: URI): Promise<void> { return this.inner.cloneFile(this.toRemote(from), this.toRemote(to)); }
	watch(resource: URI, opts: IWatchOptions): IDisposable { return this.inner.watch(this.toRemote(resource), opts); }
}
