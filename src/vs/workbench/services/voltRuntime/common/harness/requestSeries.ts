/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Prompt-cache series (DeepSeek request header). A new series starts when the
 * tools or the stable system prefix change - rewriting those mid-run is what
 * blows a provider cache. Volatile runtime context (inbox, evidence) must not
 * be part of this fingerprint.
 */

export interface IRequestSeries {
	readonly id: number;
	readonly fingerprint: string;
}

export class RequestSeries {

	private current: IRequestSeries = { id: 1, fingerprint: '' };

	observe(fingerprint: string): IRequestSeries {
		if (!this.current.fingerprint) {
			this.current = { id: 1, fingerprint };
			return this.current;
		}
		if (this.current.fingerprint === fingerprint) {
			return this.current;
		}
		this.current = { id: this.current.id + 1, fingerprint };
		return this.current;
	}

	snapshot(): IRequestSeries {
		return this.current;
	}
}

export function seriesFingerprint(system: string, tools: readonly string[]): string {
	return `${system.length}:${tools.slice().sort().join(',')}`;
}
