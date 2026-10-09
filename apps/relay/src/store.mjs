/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const STATE_VERSION = 1;
/** Events kept in memory for `?after=` catch-up; older cursors get a `resync`. */
const EVENT_BUFFER = 2000;

/**
 * The relay's state: one JSON file written atomically (temp file, fsync, rename) after every
 * change, plus side files for big things (delivery bodies, task logs, blobs). A change resolves
 * only once it is on disk, so a webhook answered 202 survives a crash or a container restart.
 */
export class Store {

	constructor(dir) {
		this.dir = path.resolve(dir);
		this.file = path.join(this.dir, 'state.json');
		this.state = undefined;
		this.events = [];
		this.listeners = new Set();
		this.saving = undefined;
		this.dirty = false;
	}

	load() {
		for (const sub of ['', 'blobs', 'deliveries', 'logs']) {
			fs.mkdirSync(path.join(this.dir, sub), { recursive: true });
		}
		let state;
		try {
			state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
		} catch (err) {
			if (err.code !== 'ENOENT') {
				const broken = `${this.file}.broken-${Date.now()}`;
				fs.copyFileSync(this.file, broken);
				console.error(`[relay] state.json was unreadable; kept a copy at ${broken} and started fresh.`);
			}
		}
		this.state = {
			version: STATE_VERSION,
			relayId: state?.relayId,
			seq: state?.seq ?? 0,
			devices: state?.devices ?? [],
			pairings: state?.pairings ?? [],
			hooks: state?.hooks ?? [],
			deliveries: state?.deliveries ?? [],
			machines: state?.machines ?? [],
			tasks: state?.tasks ?? [],
			blobs: state?.blobs ?? [],
		};
		return this.state;
	}

	/** Writes the state; concurrent calls coalesce into at most one more write. */
	save() {
		this.dirty = true;
		if (!this.saving) {
			this.saving = (async () => {
				while (this.dirty) {
					this.dirty = false;
					await this.writeNow();
				}
			})().finally(() => {
				this.saving = undefined;
			});
		}
		return this.saving;
	}

	async writeNow() {
		const tmp = `${this.file}.tmp`;
		const handle = await fsp.open(tmp, 'w', 0o600);
		try {
			await handle.writeFile(JSON.stringify(this.state));
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fsp.rename(tmp, this.file);
	}

	/** Durable write of a side file (same temp + fsync + rename dance). */
	async writeFile(relative, data) {
		const target = path.join(this.dir, relative);
		const tmp = `${target}.tmp`;
		const handle = await fsp.open(tmp, 'w', 0o600);
		try {
			await handle.writeFile(data);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fsp.rename(tmp, target);
	}

	path(relative) {
		return path.join(this.dir, relative);
	}

	async removeFile(relative) {
		await fsp.rm(path.join(this.dir, relative), { force: true });
	}

	//#region Events

	/** Records an event; listeners (SSE streams, long polls) get it right away. */
	emit(type, id, data) {
		const event = { seq: ++this.state.seq, at: Date.now(), type, id, data };
		this.events.push(event);
		if (this.events.length > EVENT_BUFFER) {
			this.events.splice(0, this.events.length - EVENT_BUFFER);
		}
		for (const listener of this.listeners) {
			listener(event);
		}
		return event;
	}

	/**
	 * Events after `after`, or `undefined` when the cursor is older than the buffer (or from a
	 * previous run of the relay): the client must re-read its lists.
	 */
	eventsAfter(after) {
		if (after >= this.state.seq) {
			return [];
		}
		const first = this.events[0];
		if (!first || first.seq > after + 1) {
			return undefined;
		}
		return this.events.filter(event => event.seq > after);
	}

	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	//#endregion
}
