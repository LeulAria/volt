/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { net } from 'electron';
import { IVoltSkillsDirectoryService } from '../common/voltMarketplace.js';

const SEARCH_URL = 'https://skills.sh/api/search';
const REQUEST_TIMEOUT_MS = 15_000;
/** The site rate limits; a page of results asks for a handful of searches at once. */
const MAX_CONCURRENT = 3;

export class VoltSkillsDirectoryMainService implements IVoltSkillsDirectoryService {

	declare readonly _serviceBrand: undefined;

	private running = 0;
	private readonly waiting: (() => void)[] = [];

	async search(query: string, limit: number): Promise<readonly unknown[]> {
		const q = String(query ?? '').trim();
		if (q.length < 2) {
			return [];
		}
		const count = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 20));
		await this.acquire();
		try {
			const response = await net.fetch(`${SEARCH_URL}?q=${encodeURIComponent(q)}&limit=${count}`, {
				headers: { 'User-Agent': 'Volt', 'Accept': 'application/json' },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!response.ok) {
				throw new Error(`skills.sh answered ${response.status}`);
			}
			const body = await response.json() as { skills?: unknown };
			return Array.isArray(body.skills) ? body.skills : [];
		} finally {
			this.release();
		}
	}

	private acquire(): Promise<void> {
		if (this.running < MAX_CONCURRENT) {
			this.running++;
			return Promise.resolve();
		}
		return new Promise(resolve => this.waiting.push(resolve));
	}

	private release(): void {
		const next = this.waiting.shift();
		if (next) {
			next();
		} else {
			this.running--;
		}
	}
}
