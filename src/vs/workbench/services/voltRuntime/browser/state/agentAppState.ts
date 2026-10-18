/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { stringHash } from '../../../../../base/common/hash.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { AppStateOp, applyStateOps, emptyAppState, IAppStateFile } from '../../common/harness/appState.js';

/**
 * The project app states on disk (`voltState/<project>.json`), one atomic file each. Updates to
 * one project go one at a time and re-read the file first, so another window's write is merged
 * into, never lost.
 */
export class AgentAppStateStore {

	private readonly chains = new Map<string, Promise<unknown>>();

	constructor(
		private readonly root: URI,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) { }

	read(project: string): Promise<IAppStateFile> {
		return this.serialize(project, () => this.load(project));
	}

	/** Applies `ops` together; refused when `expectRevision` is given and the state moved past it. */
	update(project: string, ops: readonly AppStateOp[], expectRevision?: number): Promise<{ readonly file: IAppStateFile } | { readonly error: string; readonly file: IAppStateFile }> {
		return this.serialize(project, async () => {
			const file = await this.load(project);
			if (expectRevision !== undefined && expectRevision !== file.revision) {
				return { error: `Not applied: the state is at revision ${file.revision}, not ${expectRevision}. Read it again, then update.`, file };
			}
			const applied = applyStateOps(file.doc, ops);
			if ('error' in applied) {
				return { error: `Not applied: ${applied.error}`, file };
			}
			const next: IAppStateFile = { version: 1, revision: file.revision + 1, updatedAt: Date.now(), doc: applied.doc };
			await this.fileService.writeFile(this.file(project), VSBuffer.fromString(JSON.stringify(next)), { atomic: { postfix: '.vsctmp' } });
			return { file: next };
		});
	}

	private async load(project: string): Promise<IAppStateFile> {
		try {
			const parsed = JSON.parse((await this.fileService.readFile(this.file(project))).value.toString()) as IAppStateFile;
			return parsed?.version === 1 && parsed.doc && typeof parsed.doc === 'object' && !Array.isArray(parsed.doc) ? parsed : emptyAppState();
		} catch (err) {
			if (!(err instanceof Error && /not ?found|ENOENT/i.test(err.message))) {
				this.logService.trace('[volt] app state could not be read; starting from empty', err);
			}
			return emptyAppState();
		}
	}

	private serialize<T>(project: string, work: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(project) ?? Promise.resolve();
		const next = previous.then(work, work);
		const tail = next.catch(() => undefined);
		this.chains.set(project, tail);
		void tail.then(() => {
			if (this.chains.get(project) === tail) {
				this.chains.delete(project);
			}
		});
		return next;
	}

	private file(project: string): URI {
		const name = project.split(/[\\/]/).filter(Boolean).pop()?.replace(/[^\w.-]/g, '_').slice(0, 40) || 'project';
		return joinPath(this.root, `${name}-${(stringHash(project, 0) >>> 0).toString(36)}.json`);
	}
}
