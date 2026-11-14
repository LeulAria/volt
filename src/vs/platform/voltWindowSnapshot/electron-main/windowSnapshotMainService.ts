/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltWindowSnapshotService } from '../common/windowSnapshotService.js';

/** A snapshot larger than this is not kept: it would slow the next start more than it helps. */
export const MAX_WINDOW_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export const IVoltWindowSnapshotMainService = createDecorator<IVoltWindowSnapshotMainService>('voltWindowSnapshotMainService');

export interface IVoltWindowSnapshotMainService extends IVoltWindowSnapshotService {
	/** The stored snapshot for a window (JSON), read when the window loads. */
	read(key: string): Promise<string | undefined>;
}

/**
 * Each window's last snapshot, one file per window under `<user data>/VoltWindowSnapshots`. The
 * window's configuration carries it, so the window's startup script paints it in the first frame.
 */
export class VoltWindowSnapshotMainService extends Disposable implements IVoltWindowSnapshotMainService {

	declare readonly _serviceBrand: undefined;

	private readonly dir: string;
	/** Writes in flight per file, so a read after a save sees the save. */
	private readonly writes = new Map<string, Promise<void>>();

	constructor(
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.dir = join(environmentMainService.userDataPath, 'VoltWindowSnapshots');
	}

	private file(key: string): string {
		return join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`);
	}

	async save(key: string, snapshot: string | undefined): Promise<void> {
		const file = this.file(key);
		const previous = this.writes.get(file) ?? Promise.resolve();
		const write = previous.then(async () => {
			if (snapshot === undefined || snapshot.length > MAX_WINDOW_SNAPSHOT_BYTES) {
				await fs.rm(file, { force: true });
				return;
			}
			await fs.mkdir(this.dir, { recursive: true });
			// Written next to the file and renamed over it: a start never reads half a snapshot.
			const temp = `${file}.${process.pid}.tmp`;
			await fs.writeFile(temp, snapshot, { mode: 0o600 });
			await fs.rename(temp, file);
		}).catch(err => this.logService.warn('[volt window snapshot] could not save the window snapshot', err));
		this.writes.set(file, write);
		await write;
		if (this.writes.get(file) === write) {
			this.writes.delete(file);
		}
	}

	async read(key: string): Promise<string | undefined> {
		const file = this.file(key);
		await this.writes.get(file);
		try {
			const data = await fs.readFile(file, 'utf8');
			return data.length <= MAX_WINDOW_SNAPSHOT_BYTES ? data : undefined;
		} catch {
			return undefined;
		}
	}
}
